#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

# Three arms:
#
#   shop     the plain two-level empty-path group. One request, no concurrency.
#   guard    the same shape behind an async canMatch guard, swept over the
#            guard's per-check delay.
#   matrix   both shapes, both request-line sizes, four heaps, through Nginx.
#
# Every trial gets a brand new worker, and the worker's own command line is
# checked before anything is measured. A reused container at the wrong heap
# looks exactly like a result, which is how measurements get quietly wrong.
ARM="${1:-shop}"

OOM='JavaScript heap out of memory|Reached heap limit|FatalProcessOutOfMemory'

fail() { echo "[FAIL] $*" >&2; exit 1; }

app_running() {
  docker compose ps app --status running --format '{{.Service}}' 2>/dev/null | grep -qx app
}

healthy_count() {
  docker compose ps "$1" --format json 2>/dev/null | grep -c '"Health":"healthy"' || true
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
  cmd="$(docker inspect -f '{{json .Config.Cmd}}' "$(docker compose ps -a -q app)" 2>/dev/null || true)"
  grep -q "max-old-space-size=${HEAP_MB}" <<<"$cmd" || return 2
}

# Runs one client against a fresh worker. Echoes fatal, healthy or kernel-oom.
trial() {
  local mode="$1" concurrency="$2" log="$3" boot

  set +e
  start_fresh_worker
  boot=$?
  set -e
  case $boot in
  1) echo boot-timeout; return ;;
  2) echo wrong-heap; return ;;
  esac

  # --no-deps: the worker is already up, and letting Compose re-resolve the
  # dependency here races with the container it is about to replace.
  CONCURRENCY="$concurrency" docker compose --profile test run --rm --no-deps "$mode" \
    >"$log" 2>&1 || true
  docker compose logs app >>"$log" 2>&1 || true

  # OOMKilled tells a V8 heap-limit failure from the kernel reaping the
  # container. It has to be false for this to be the bug and not the cgroup.
  docker inspect -f '{{json .State}}' "$(docker compose ps -a -q app)" \
    >>"$log" 2>&1 || true

  if grep -Fq '"OOMKilled":true' "$log"; then
    echo kernel-oom
  elif grep -Eq "$OOM" "$log" && ! app_running; then
    echo fatal
  else
    echo healthy
  fi
}

# Echoes the lowest concurrency that loses the worker.
#
# The ceiling is probed first: a worker that survives PROBE concurrent requests
# has no answer below it either, and the linear ramp would be wasted. Only when
# the ceiling does kill it is the exact count worth hunting.
first_oom() {
  local tag="$1" max="$2" probe="${PROBE:-16}" count verdict

  verdict="$(trial candidate "$probe" "evidence/${tag}-x${probe}.log")"
  case "$verdict" in
  healthy) echo "survives $probe"; return ;;
  fatal) ;;
  *) fail "${tag} x${probe}: ${verdict}." ;;
  esac

  for ((count = 1; count <= max; count++)); do
    verdict="$(trial candidate "$count" "evidence/${tag}-x${count}.log")"
    case "$verdict" in
    fatal) echo "$count"; return ;;
    healthy) ;;
    *) fail "${tag} x${count}: ${verdict}." ;;
    esac
  done
  echo "between $max and $probe"
}

# Bisects the smallest outlet count that still loses the worker, at a fixed
# request-line budget so the query widens as the outlets shrink. Echoes the
# count, or "" when even the ceiling survives.
fewest_outlets() {
  local tag="$1" low=40 high="$2" verdict best=""
  export OUTLETS="$high"
  verdict="$(trial candidate 1 "evidence/${tag}-o${high}.log")"
  [[ "$verdict" == fatal ]] || { echo ""; return; }
  best="$high"
  while ((high - low > 8)); do
    local mid=$(((low + high) / 2))
    export OUTLETS="$mid"
    verdict="$(trial candidate 1 "evidence/${tag}-o${mid}.log")"
    case "$verdict" in
    fatal) high="$mid"; best="$mid" ;;
    healthy) low="$mid" ;;
    *) fail "${tag} o${mid}: ${verdict}." ;;
    esac
  done
  echo "$best"
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

  verdict="$(trial control 1 evidence/shop-control.log)"
  [[ "$verdict" == healthy ]] || fail "Control was $verdict."
  echo "[PASS] control: worker survived."

  verdict="$(trial candidate 1 evidence/shop-candidate.log)"
  [[ "$verdict" == fatal ]] || fail "Candidate was $verdict."
  echo "[PASS] candidate: V8 heap limit reached, worker gone, OOMKilled=false."
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
    verdict="$(trial control "$first" "evidence/guard-${ms}ms-control.log")"
    [[ "$verdict" == healthy ]] || fail "Control was $verdict at ${ms} ms, x${first}."
    printf '%-10s %-18s %s\n' "${ms} ms" "$first" "${first}/${first} survived"
  done
  ;;

matrix)
  # Through Nginx, whose only non-default setting is the 16k request line an AWS
  # Elastic Load Balancer forwards. Both sizes are chosen to pass with Node's
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

sharpen)
  # Does encoding the query names as spaced integers, so they land in a V8
  # elements store instead of a NameDictionary, buy the attacker anything on the
  # real payload? Compared at an equal request line, which is the constraint that
  # matters. Both arms of the lab, alpha against numeric.
  export SERVICES=app TARGET_URL=http://app:4000 HEAP_MB=128 PATH_BYTES=7873
  echo "== sharpen | heap ${HEAP_MB} MiB | request line $((PATH_BYTES + 15)) B =="
  printf '%-9s %-8s %s
' "names" "stride" "fewest outlets that kill"
  for names in alpha numeric; do
    export NAMES="$names" SHAPE=shop CANMATCH_MS=0
    fewest="$(fewest_outlets "sharpen-shop-${names}" 480)"
    printf '%-9s %-8s %s
' "$names" "$([[ $names == numeric ]] && echo "${STRIDE:-17}" || echo -)" "${fewest:-survives 480}"
  done

  echo
  export SHAPE=guard OUTLETS=120 PATH_BYTES=4993
  MAX="${MAX_CONCURRENCY:-6}"
  echo "== sharpen | guard | ${OUTLETS} outlets | request line $((PATH_BYTES + 15)) B =="
  printf '%-9s %-8s %s
' "names" "stride" "requests to OOM"
  for names in alpha numeric; do
    export NAMES="$names"
    first="$(first_oom "sharpen-guard-${names}" "$MAX")"
    printf '%-9s %-8s %s
' "$names" "$([[ $names == numeric ]] && echo "${STRIDE:-17}" || echo -)" "$first"
  done
  ;;

*)
  echo "Usage: $0 [shop|guard|matrix|sharpen]" >&2
  exit 2
  ;;
esac

docker compose down -v --remove-orphans >/dev/null 2>&1 || true
