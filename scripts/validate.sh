#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Arms:
#
#   shop     the plain two-level empty-path group. One request, no concurrency.
#   arms     the four-arm ablation at 128 MiB: both dimensions, then each one
#            alone, TRIALS repetitions each, with peak memory and the response.
#   diff     the same four arms at a heap where they all survive, so the
#            differential is readable instead of fatal.
#   counts   what recognition actually builds, per arm and per empty-path depth,
#            from a build instrumented only at createSnapshot().
#   ablation stock against the shared-query-map edit, same bytes, same output.
#   guard    the same shape behind an async canMatch guard, swept over the
#            guard's per-check delay.
#   matrix   both shapes, both request-line sizes, four heaps, through Nginx.
#
# Every trial gets a brand new worker, and the worker's own command line is
# checked before anything is measured. A reused container at the wrong heap
# looks exactly like a result, which is how measurements get quietly wrong.
ARM="${1:-shop}"
TRIALS="${TRIALS:-5}"

OOM='JavaScript heap out of memory|Reached heap limit|FatalProcessOutOfMemory'

fail() { echo "[FAIL] $*" >&2; exit 1; }

app_running() {
  docker compose ps app --status running --format '{{.Service}}' 2>/dev/null | grep -qx app
}

healthy_count() {
  docker compose ps "$1" --format json 2>/dev/null | grep -c '"Health":"healthy"' || true
}

app_cid() { docker compose ps -a -q app 2>/dev/null; }

# The cgroup's own peak counter is monotonic, so the last read before a worker
# dies is its peak up to that moment. An instantaneous sample would miss the
# peak of a request that lasts under a second. v2 calls it memory.peak, v1
# memory.max_usage_in_bytes; both reset with the container, and every trial gets
# a fresh one.
#
# One long-lived exec running the loop inside the container, not one exec per
# sample: exec costs a few hundred ms to set up, which on a request that is
# fatal in under a second leaves the final surge unsampled. At 20 Hz the cost is
# a sleeping shell and the last line before the worker dies is close to its peak.
# A fatal arm is still a floor, not a peak — the container takes the cgroup with
# it — which is why the differential is read off the arm where nothing dies.
PEAK_PID=""
PEAK_FILE=""
PEAK_READ='while :; do cat /sys/fs/cgroup/memory.peak 2>/dev/null || cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes 2>/dev/null; sleep 0.05; done'
peak_start() {
  PEAK_FILE="$(mktemp)"
  docker exec "$(app_cid)" sh -c "$PEAK_READ" >>"$PEAK_FILE" 2>/dev/null &
  PEAK_PID=$!
}
peak_stop() {
  if [[ -n "$PEAK_PID" ]]; then
    kill "$PEAK_PID" 2>/dev/null || true
    wait "$PEAK_PID" 2>/dev/null || true
  fi
  PEAK_PID=""
  awk '/^[0-9]+$/ { if ($1 > m) m = $1 } END { if (m > 0) printf "%.2f\n", m / 1048576; else print "n/a" }' "$PEAK_FILE"
  rm -f "$PEAK_FILE"
}

# SERVICES is "app", or "app nginx" when the client goes through the proxy.
start_fresh_worker() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  # Let the daemon release the old container before recreating it.
  sleep 2
  docker compose up -d --force-recreate ${SERVICES:-app} >/dev/null 2>&1 || true

  local waited=0
  while [[ $waited -lt 60 ]]; do
    local ready=1
    for service in ${SERVICES:-app}; do
      [[ "$(healthy_count "$service")" == "1" ]] || ready=0
    done
    [[ $ready == 1 ]] && break
    sleep 1
    waited=$((waited + 1))
  done
  [[ $waited -lt 60 ]] || return 1

  # The heap is the whole measurement; refuse to trust a worker that did not get
  # the one we asked for.
  local cmd
  cmd="$(docker inspect -f '{{json .Config.Cmd}}' "$(app_cid)" 2>/dev/null || true)"
  grep -q "max-old-space-size=${HEAP_MB}" <<<"$cmd" || return 2
}

# Runs one client against a fresh worker and sets TRIAL_*. Deliberately not
# called in a subshell: the caller needs every field, not just the verdict.
TRIAL_VERDICT=""
TRIAL_PEAK=""
TRIAL_MS=""
TRIAL_STATUS=""
TRIAL_SHA=""
trial() {
  local mode="$1" concurrency="$2" log="$3" boot results
  TRIAL_VERDICT=""
  TRIAL_PEAK="n/a"
  TRIAL_MS="n/a"
  TRIAL_STATUS="n/a"
  TRIAL_SHA="n/a"

  set +e
  start_fresh_worker
  boot=$?
  set -e
  case $boot in
  1) TRIAL_VERDICT=boot-timeout; return ;;
  2) TRIAL_VERDICT=wrong-heap; return ;;
  esac

  peak_start
  # --no-deps: the worker is already up, and letting Compose re-resolve the
  # dependency here races with the container it is about to replace.
  CONCURRENCY="$concurrency" docker compose --profile test run --rm --no-deps "$mode" \
    >"$log" 2>&1 || true
  TRIAL_PEAK="$(peak_stop)"

  docker compose logs app >>"$log" 2>&1 || true
  # OOMKilled tells a V8 heap-limit failure from the kernel reaping the
  # container. It has to be false for this to be the bug and not the cgroup.
  docker inspect -f '{{json .State}}' "$(app_cid)" >>"$log" 2>&1 || true

  results="$(grep -o '"results":\[.*\]' "$log" | head -1 || true)"
  TRIAL_MS="$(grep -o '"ms":[0-9]*' <<<"$results" | head -1 | cut -d: -f2 || true)"
  TRIAL_STATUS="$(grep -o '"status":[0-9]*' <<<"$results" | head -1 | cut -d: -f2 || true)"
  # With FOLLOW the last hash in the line is the rendered page; without it, the
  # redirect's own empty body.
  TRIAL_SHA="$(grep -o '"sha256":"[0-9a-f]*"' <<<"$results" | tail -1 | cut -d'"' -f4 || true)"
  : "${TRIAL_MS:=n/a}" "${TRIAL_STATUS:=n/a}" "${TRIAL_SHA:=n/a}"
  [[ -n "$TRIAL_MS" ]] || TRIAL_MS="n/a"
  [[ -n "$TRIAL_STATUS" ]] || TRIAL_STATUS="n/a"
  [[ -n "$TRIAL_SHA" ]] || TRIAL_SHA="n/a"

  if grep -Fq '"OOMKilled":true' "$log"; then
    TRIAL_VERDICT=kernel-oom
  elif grep -Eq "$OOM" "$log" && ! app_running; then
    TRIAL_VERDICT=fatal
  else
    TRIAL_VERDICT=healthy
  fi
}

median() {
  tr ' ' '\n' <<<"$1" | grep -E '^[0-9]+(\.[0-9]+)?$' | sort -n |
    awk '{ v[NR] = $1 } END { if (NR) print v[int((NR + 1) / 2)]; else print "n/a" }'
}

# Repeats one arm TRIALS times. Sets REPEAT_* to the tally and the medians.
REPEAT_FATAL=0
REPEAT_MS=""
REPEAT_PEAK=""
REPEAT_STATUS=""
REPEAT_SHA=""
repeat() {
  local mode="$1" concurrency="$2" tag="$3" i
  REPEAT_FATAL=0
  REPEAT_MS=""
  REPEAT_PEAK=""
  REPEAT_STATUS="n/a"
  REPEAT_SHA="n/a"
  for ((i = 1; i <= TRIALS; i++)); do
    trial "$mode" "$concurrency" "evidence/${tag}-t${i}.log"
    case "$TRIAL_VERDICT" in
    fatal) REPEAT_FATAL=$((REPEAT_FATAL + 1)) ;;
    healthy) ;;
    *) fail "${tag} trial ${i}: ${TRIAL_VERDICT}." ;;
    esac
    REPEAT_MS="$REPEAT_MS $TRIAL_MS"
    REPEAT_PEAK="$REPEAT_PEAK $TRIAL_PEAK"
    if [[ "$TRIAL_STATUS" != "n/a" ]]; then REPEAT_STATUS="$TRIAL_STATUS"; fi
    if [[ "$TRIAL_SHA" != "n/a" ]]; then REPEAT_SHA="$TRIAL_SHA"; fi
  done
  REPEAT_MS="$(median "$REPEAT_MS")"
  REPEAT_PEAK="$(median "$REPEAT_PEAK")"
}

# Echoes the lowest concurrency that loses the worker.
#
# The ceiling is probed first: a worker that survives PROBE concurrent requests
# has no answer below it either, and the linear ramp would be wasted. Only when
# the ceiling does kill it is the exact count worth hunting.
first_oom() {
  local tag="$1" max="$2" probe="${PROBE:-16}" count

  trial candidate "$probe" "evidence/${tag}-x${probe}.log"
  case "$TRIAL_VERDICT" in
  healthy) echo "survives $probe"; return ;;
  fatal) ;;
  *) fail "${tag} x${probe}: ${TRIAL_VERDICT}." ;;
  esac

  for ((count = 1; count <= max; count++)); do
    trial candidate "$count" "evidence/${tag}-x${count}.log"
    case "$TRIAL_VERDICT" in
    fatal) echo "$count"; return ;;
    healthy) ;;
    *) fail "${tag} x${count}: ${TRIAL_VERDICT}." ;;
    esac
  done
  echo "between $max and $probe"
}

# Rebuilds the app with one of patch-router.mjs's proof-only edits.
build_app() {
  ROUTER_PATCH="$1" docker compose build app >/dev/null 2>&1 ||
    fail "build with ROUTER_PATCH=$1 failed."
}

# The URL the client would send, without sending it.
path_bytes() {
  docker compose --profile test run --rm --no-deps --entrypoint node "$1" \
    -e 'import("./workloads.mjs").then(({buildTarget})=>console.log(Buffer.byteLength(buildTarget({shape:process.env.SHAPE,mode:process.env.MODE,outletCount:+process.env.OUTLETS,queryNames:+process.env.QUERY_NAMES}))))' \
    2>/dev/null | tr -d '\r' | tail -1
}

mkdir -p evidence
docker compose build app candidate control nginx >/dev/null

case "$ARM" in
shop)
  # 480 outlets x 1,377 distinct query names in 7,873 bytes. The control is
  # byte-identical with two distinct names.
  export HEAP_MB=128 SHAPE=shop OUTLETS=480 QUERY_NAMES=1377 CANMATCH_MS=0
  export SERVICES=app TARGET_URL=http://app:4000
  echo "== shop | heap ${HEAP_MB} MiB | 480 outlets | 1 request =="

  trial control 1 evidence/shop-control.log
  [[ "$TRIAL_VERDICT" == healthy ]] || fail "Control was $TRIAL_VERDICT."
  echo "[PASS] control: worker survived."

  trial candidate 1 evidence/shop-candidate.log
  [[ "$TRIAL_VERDICT" == fatal ]] || fail "Candidate was $TRIAL_VERDICT."
  echo "[PASS] candidate: V8 heap limit reached, worker gone, OOMKilled=false."
  ;;

arms | diff)
  # Both dimensions, then each one alone carrying its whole count. "arms" runs at
  # the heap where the candidate is fatal; "diff" at one where nothing is, so the
  # cost reads as time and memory rather than as a crash.
  if [[ "$ARM" == arms ]]; then
    export HEAP_MB="${HEAP_MB:-128}"
  else
    export HEAP_MB="${HEAP_MB:-256}"
  fi
  export SHAPE=shop CANMATCH_MS=0 SERVICES=app TARGET_URL=http://app:4000 FOLLOW=1
  echo "== ${ARM} | heap ${HEAP_MB} MiB | 1 request | ${TRIALS} fresh workers per arm =="
  printf '%-24s %-8s %-7s %-7s %-14s %-10s %s\n' \
    arm outlets names bytes outcome "median ms" "median peak MiB"

  for spec in \
    "candidate:480:1377:candidate" \
    "control:480:1377:control, equal bytes" \
    "candidate:0:1377:query width only" \
    "candidate:480:0:outlet fan-out only"; do
    IFS=: read -r mode outlets names label <<<"$spec"
    export OUTLETS="$outlets" QUERY_NAMES="$names" MODE="$mode"
    bytes="$(path_bytes "$mode")"
    repeat "$mode" 1 "${ARM}-${mode}-o${outlets}-q${names}"
    printf '%-24s %-8s %-7s %-7s %-14s %-10s %s\n' \
      "$label" "$outlets" "$names" "$bytes" \
      "${REPEAT_FATAL}/${TRIALS} fatal" "$REPEAT_MS" "$REPEAT_PEAK"
    echo "    status ${REPEAT_STATUS}, body sha256 ${REPEAT_SHA}"
  done
  ;;

counts)
  # One build, instrumented only at createSnapshot(), reporting the two totals
  # per request. Depth is the application's, so shop1 is the same URL against one
  # empty-path level instead of two.
  build_app count
  export HEAP_MB="${HEAP_MB:-1024}" CANMATCH_MS=0 SERVICES=app TARGET_URL=http://app:4000
  echo "== counts | heap ${HEAP_MB} MiB | ROUTER_PATCH=count | 1 request =="
  printf '%-26s %-7s %-8s %-7s %-11s %s\n' arm shape outlets names snapshots "keys copied"

  for spec in \
    "candidate:shop:480:1377:two levels" \
    "control:shop:480:1377:two levels, control" \
    "candidate:shop1:480:1377:one level" \
    "candidate:shop:0:1377:query width only" \
    "candidate:shop:480:0:outlet fan-out only"; do
    IFS=: read -r mode shape outlets names label <<<"$spec"
    export SHAPE="$shape" OUTLETS="$outlets" QUERY_NAMES="$names"
    log="evidence/counts-${shape}-${mode}-o${outlets}-q${names}.log"
    trial "$mode" 1 "$log"
    line="$(grep -o '{"snapshots":[0-9]*,"queryKeysCopied":[0-9]*}' "$log" | tail -1 || true)"
    printf '%-26s %-7s %-8s %-7s %-11s %s\n' "$label" "$shape" "$outlets" "$names" \
      "$(grep -o '"snapshots":[0-9]*' <<<"$line" | cut -d: -f2)" \
      "$(grep -o '"queryKeysCopied":[0-9]*' <<<"$line" | cut -d: -f2)"
  done
  build_app none
  ;;

ablation)
  # The causal edit: create and freeze the query map once per recognition attempt
  # and share it. Same bytes, same outlets, same names, same output.
  export HEAP_MB="${HEAP_MB:-128}" SHAPE=shop OUTLETS=480 QUERY_NAMES=1377 CANMATCH_MS=0
  export SERVICES=app TARGET_URL=http://app:4000 FOLLOW=1 MODE=candidate
  echo "== ablation | heap ${HEAP_MB} MiB | 1 request | ${TRIALS} fresh workers per build =="
  printf '%-22s %-14s %-10s %s\n' build outcome "median ms" "median peak MiB"

  for patch in none share-query; do
    build_app "$patch"
    repeat candidate 1 "ablation-${patch}"
    if [[ "$patch" == none ]]; then label="stock"; else label="query-sharing"; fi
    printf '%-22s %-14s %-10s %s\n' \
      "$label" "${REPEAT_FATAL}/${TRIALS} fatal" "$REPEAT_MS" "$REPEAT_PEAK"
    echo "    status ${REPEAT_STATUS}, body sha256 ${REPEAT_SHA}"
  done
  build_app none
  ;;

guard)
  # Fewer outlets here, so one request is not already fatal and concurrency is
  # the variable. The guard runs once per URL outlet, so its per-check delay
  # multiplies by this count.
  export HEAP_MB=128 SHAPE=guard OUTLETS=120 QUERY_NAMES=1377
  export SERVICES=app TARGET_URL=http://app:4000
  MAX="${MAX_CONCURRENCY:-6}"
  echo "== guard | heap ${HEAP_MB} MiB | ${OUTLETS} outlets =="
  printf '%-10s %-18s %s\n' "canMatch" "requests to OOM" "control at that count"

  for ms in 0 100 250 500; do
    export CANMATCH_MS="$ms"
    first="$(first_oom "guard-${ms}ms" "$MAX")"
    # Anything other than a bare count means no kill was found, so there is no
    # concurrency to run the control at.
    if [[ ! "$first" =~ ^[0-9]+$ ]]; then
      printf '%-10s %-18s %s\n' "${ms} ms" "$first" "-"
      continue
    fi
    trial control "$first" "evidence/guard-${ms}ms-control.log"
    [[ "$TRIAL_VERDICT" == healthy ]] || fail "Control was $TRIAL_VERDICT at ${ms} ms, x${first}."
    printf '%-10s %-18s %s\n' "${ms} ms" "$first" "${first}/${first} survived"
  done
  ;;

matrix)
  # Through Nginx, whose non-default settings are the 16k request line an AWS
  # Elastic Load Balancer forwards, and a response-header buffer big enough for
  # the redirect the app answers with. Both sizes are chosen to pass with Node's
  # own default header budget, proxy headers included.
  export SERVICES="app nginx" TARGET_URL=http://nginx:8080
  MAX="${MAX_CONCURRENCY:-6}"
  echo "== matrix | through Nginx | 16k request line =="
  printf '%-6s %-7s %-9s %s\n' "size" "heap" "canMatch" "requests to OOM"

  for size in 8k 16k; do
    case "$size" in
    8k) export OUTLETS=480 QUERY_NAMES=1377 ;;
    16k) export OUTLETS=1020 QUERY_NAMES=2726 ;;
    esac

    for heap in 128 256 512 1024; do
      export HEAP_MB="$heap"
      for guard in off on; do
        case "$guard" in
        off) export SHAPE=shop CANMATCH_MS=0 ;;
        on) export SHAPE=guard CANMATCH_MS=0 ;;
        esac
        first="$(first_oom "matrix-${size}-${heap}-${guard}" "$MAX")"
        printf '%-6s %-7s %-9s %s\n' "$size" "${heap}M" "$guard" "$first"
      done
    done
  done
  ;;

*)
  echo "Usage: $0 [shop|arms|diff|counts|ablation|guard|matrix]" >&2
  exit 2
  ;;
esac

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
