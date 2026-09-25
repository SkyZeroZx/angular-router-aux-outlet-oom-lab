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
#   fuzz     splits one request-line budget between the two dimensions
#   guard    the same shape behind an async canMatch guard, swept over the
#            guard's per-check delay.
#   fixcheck the candidate fix end to end: no OOM, no amplifier, same output
#   aux      matrix-parameter width against a layout with a named modal outlet
#   gdepth   the guarded column by empty-path depth, through Nginx
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

  # And the build is the other half of the measurement. There was a guard for the
  # heap and none for this, which is how three runs of the same stock bundle came
  # back looking like stock, patched and PR-patched: anything that rebuilds the
  # image between the build and the trial silently wins. Assert the patch inside
  # the process that produces the number.
  assert_router_patch || return 3
}

# Greps the running worker's own copy of the bundle for a marker only the
# requested ROUTER_PATCH can have put there.
assert_router_patch() {
  local want="${ROUTER_PATCH:-none}" marker found
  case "$want" in
  none) marker='' ;;
  count) marker='globalThis.__s' ;;
  share-query) marker='this.__shared' ;;
  fix | fix-count | fix-probe | fix-pr) marker='frozenQueryParamsSource' ;;
  *) marker='' ;;
  esac
  found="$(docker exec "$(app_cid)" sh -c \
    'grep -c "frozenQueryParamsSource\|this.__shared\|globalThis.__s" node_modules/@angular/router/fesm2022/_router-chunk.mjs || true' \
    2>/dev/null | tr -d '\r')"
  : "${found:=0}"
  if [[ -z "$marker" ]]; then
    [[ "$found" == 0 ]] || return 1
    return 0
  fi
  docker exec "$(app_cid)" sh -c \
    "grep -q '$marker' node_modules/@angular/router/fesm2022/_router-chunk.mjs" 2>/dev/null
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
  3) TRIAL_VERDICT=wrong-build; return ;;
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
    -e 'import("./workloads.mjs").then(({buildTarget})=>console.log(Buffer.byteLength(buildTarget({shape:process.env.SHAPE,mode:process.env.MODE,outletCount:+process.env.OUTLETS,queryNames:+process.env.QUERY_NAMES,matrixNames:+(process.env.MATRIX_NAMES||0)}))))' \
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

fuzz)
  # Splits a fixed request-line budget between the two dimensions and asks which
  # split peaks highest. The work is snapshots x per-snapshot map size: snapshots
  # are linear in the outlet count, but the map size is a staircase in the name
  # count, because V8 sizes the dictionary to the next power of two at or above
  # twice the name count. So the efficient name counts are the SMALLEST on each
  # step - anything above that pays URL bytes for capacity it already had.
  #
  # PAIRS is "outlets:names outlets:names ...", all at the same budget.
  export HEAP_MB="${HEAP_MB:-256}" SHAPE="${SHAPE:-shop}" CANMATCH_MS=0
  export SERVICES=app TARGET_URL=http://app:4000
  PAIRS="${PAIRS:-480:1377 612:1025 611:1026 546:1200 680:900 512:1024}"
  # Empty-path depth of the shape, for the derived snapshot count. Recognition
  # builds 2(D+1) + 2*D*O, so a count hardcoded for one shape is wrong for the
  # others the moment the arm is pointed at them.
  case "$SHAPE" in
  shop1) DEPTH=1 ;;
  shop3) DEPTH=3 ;;
  shop4) DEPTH=4 ;;
  *) DEPTH=2 ;;
  esac
  echo "== fuzz | heap ${HEAP_MB} MiB | ${SHAPE} (D=${DEPTH}) | 1 request | ${TRIALS} fresh workers per pair =="
  printf '%-9s %-7s %-7s %-11s %-14s %-10s %s\n' \
    outlets names bytes "snapshots*" outcome "median ms" "median peak MiB"

  for pair in $PAIRS; do
    export OUTLETS="${pair%%:*}" QUERY_NAMES="${pair##*:}" MODE=candidate
    bytes="$(path_bytes candidate)"
    repeat candidate 1 "fuzz-${HEAP_MB}-${SHAPE}-o${OUTLETS}-q${QUERY_NAMES}"
    printf '%-9s %-7s %-7s %-11s %-14s %-10s %s\n' \
      "$OUTLETS" "$QUERY_NAMES" "$bytes" "$((2 * (DEPTH + 1) + 2 * DEPTH * OUTLETS))" \
      "${REPEAT_FATAL}/${TRIALS} fatal" "$REPEAT_MS" "$REPEAT_PEAK"
  done
  echo "* derived as 2(D+1) + 2*D*O, not measured here; ROUTER_PATCH=count measures it."
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

fixcheck)
  # The candidate fix, end to end. Four things have to hold at once: the payload
  # that is fatal on stock survives, the payload that kills a 512 MiB worker on
  # stock survives, the async canMatch amplifier is gone, and the rendered page is
  # byte-identical to stock. The last one is what separates a fix from a change in
  # behaviour, so it is checked on every arm rather than asserted once.
  export SHAPE=shop CANMATCH_MS=0 SERVICES=app TARGET_URL=http://app:4000 FOLLOW=1
  echo "== fixcheck | ROUTER_PATCH=fix | ${TRIALS} fresh workers per arm =="
  printf '%-34s %-14s %-10s %-10s %s\n' arm outcome "median ms" "peak MiB" "body sha256"

  build_app fix

  # 1. The headline payload at the heap where stock is 5/5 fatal.
  export HEAP_MB=128 OUTLETS=480 QUERY_NAMES=1377 MODE=candidate
  unset NO_SEP
  repeat candidate 1 "fixcheck-8k-128"
  printf '%-34s %-14s %-10s %-10s %s\n' "8k candidate, 128 MiB" \
    "${REPEAT_FATAL}/${TRIALS} fatal" "$REPEAT_MS" "$REPEAT_PEAK" "${REPEAT_SHA:0:16}"

  # 2. The optimised payload at the heap it kills on stock.
  export HEAP_MB=512 OUTLETS=1356 QUERY_NAMES=2732 NO_SEP=1
  repeat candidate 1 "fixcheck-16k-512"
  printf '%-34s %-14s %-10s %-10s %s\n' "16k optimised, 512 MiB" \
    "${REPEAT_FATAL}/${TRIALS} fatal" "$REPEAT_MS" "$REPEAT_PEAK" "${REPEAT_SHA:0:16}"
  unset NO_SEP

  # 3. The async canMatch amplifier, at the concurrency that kills on stock. The
  #    guarded route still builds a pre-match snapshot - it has a guard - but the
  #    snapshot now shares one frozen map instead of copying it, so there should be
  #    nothing left to retain across the await.
  export HEAP_MB=128 SHAPE=guard OUTLETS=120 QUERY_NAMES=1377
  repeat candidate 4 "fixcheck-guard-x4"
  printf '%-34s %-14s %-10s %-10s %s\n' "guard x4, 128 MiB" \
    "${REPEAT_FATAL}/${TRIALS} fatal" "$REPEAT_MS" "$REPEAT_PEAK" "${REPEAT_SHA:0:16}"

  # 4. What the fix removed, counted on the fixed build.
  build_app fix-count
  export HEAP_MB=1024 SHAPE=shop OUTLETS=480 QUERY_NAMES=1377
  trial candidate 1 evidence/fixcheck-counts.log
  line="$(grep -o '{"snapshots":[0-9]*,"queryKeysCopied":[0-9]*}' evidence/fixcheck-counts.log | tail -1 || true)"
  echo "counts on the fixed build: ${line:-none}  (stock: 1926 / 2652102)"

  build_app none
  ;;

aux)
  # The width carried by matrix parameters on the first segment instead of by the
  # query string, against a pathless layout holding a default page and an empty
  # named modal route. Two empty-path children at the inner level, so recognition
  # builds six snapshots per URL outlet rather than four: 8 + 6*O.
  #
  # The interesting control is not the equal-byte one. It is the cliff: repeating
  # the last matrix name keeps every byte and every parsed entry while leaving the
  # map one own property short, which isolates the V8 dictionary capacity step
  # from the byte count.
  export SHAPE=aux SERVICES=app TARGET_URL=http://app:4000 FOLLOW=1 NO_SEP=1
  export QUERY_NAMES=0 CANMATCH_MS=0 HEAP_MB="${HEAP_MB:-256}"
  echo "== aux | heap ${HEAP_MB} MiB | 1 request | ${TRIALS} fresh workers per arm =="
  printf '%-28s %-8s %-8s %-7s %-11s %-14s %-10s %s\n' \
    arm outlets matrix bytes snapshots outcome "median ms" "median peak MiB"

  for spec in \
    "candidate:670:1366:0:candidate" \
    "candidate:670:1366:1:cliff control, 1365 distinct" \
    "control:670:1366:0:equal bytes, 2 distinct" \
    "candidate:0:1366:0:matrix width only" \
    "candidate:670:0:0:outlet fan-out only"; do
    IFS=: read -r mode outlets matrix cliff label <<<"$spec"
    export OUTLETS="$outlets" MATRIX_NAMES="$matrix" MODE="$mode"
    if [[ "$cliff" == 1 ]]; then export MATRIX_CLIFF=1; else unset MATRIX_CLIFF; fi
    bytes="$(path_bytes "$mode")"
    repeat "$mode" 1 "aux-${HEAP_MB}-o${outlets}-m${matrix}-c${cliff}"
    printf '%-28s %-8s %-8s %-7s %-11s %-14s %-10s %s\n' \
      "$label" "$outlets" "$matrix" "$bytes" "$((8 + 6 * outlets))" \
      "${REPEAT_FATAL}/${TRIALS} fatal" "$REPEAT_MS" "$REPEAT_PEAK"
    echo "    status ${REPEAT_STATUS}, body sha256 ${REPEAT_SHA}"
  done
  unset MATRIX_CLIFF
  ;;

auxmatrix)
  # The matrix-parameter shape on the same axes as the query one: both request
  # line sizes, four heaps, with and without the async canMatch, through Nginx.
  export SERVICES="app nginx" TARGET_URL=http://nginx:8080 CANMATCH_MS=0
  export QUERY_NAMES=0 NO_SEP=1 MODE=candidate
  MAX="${MAX_CONCURRENCY:-6}"
  echo "== auxmatrix | through Nginx =="
  printf '%-6s %-7s %-9s %s
' size heap canMatch "requests to OOM"

  for size in 8k 16k; do
    case "$size" in
    8k) export OUTLETS=670 MATRIX_NAMES=1366 ;;
    16k) export OUTLETS=1356 MATRIX_NAMES=2732 ;;
    esac
    for heap in 128 256 512 1024; do
      export HEAP_MB="$heap"
      for guard in off on; do
        case "$guard" in
        off) export SHAPE=aux ;;
        on) export SHAPE=auxguard ;;
        esac
        printf '%-6s %-7s %-9s %s
' "$size" "${heap}M" "$guard"           "$(first_oom "auxmatrix-${size}-${heap}-${guard}" "$MAX")"
      done
    done
  done
  ;;

gdepth)
  # The guarded column by empty-path depth, through Nginx so it is comparable
  # cell for cell with the matrix arm. The matrix already covers depth 2; this
  # adds 3 and 4, which is the half of the table depth otherwise never reaches.
  # The guard stays on the outer level in every shape, so depth is the only thing
  # that varies. Payloads are the published ones, separator included, for the
  # same reason.
  export SERVICES="app nginx" TARGET_URL=http://nginx:8080 CANMATCH_MS=0
  MAX="${MAX_CONCURRENCY:-6}"
  echo "== gdepth | through Nginx | guarded column by depth =="
  printf '%-6s %-8s %-7s %s\n' size shape heap "requests to OOM"

  for size in 8k 16k; do
    case "$size" in
    8k) export OUTLETS=480 QUERY_NAMES=1377 ;;
    16k) export OUTLETS=1020 QUERY_NAMES=2726 ;;
    esac
    for shape in ${GUARD_SHAPES:-guard3 guard4}; do
      export SHAPE="$shape"
      for heap in ${HEAPS:-256 512 1024}; do
        export HEAP_MB="$heap"
        first="$(first_oom "gdepth-${size}-${shape}-${heap}" "$MAX")"
        printf '%-6s %-8s %-7s %s\n' "$size" "$shape" "${heap}M" "$first"
      done
    done
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
  echo "Usage: $0 [shop|arms|aux|auxmatrix|diff|counts|ablation|fuzz|fixcheck|guard|gdepth|matrix]" >&2
  exit 2
  ;;
esac

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
