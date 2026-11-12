#!/usr/bin/env bash
# The one retry of a "busy" touched-tests phase (backlog:3d560518f3e2).
#
# scripts/ci-touched-tests.js writes a busy candidate when its run timed out
# while the machine was full (load1 above 1.5 x CPUs at the start or at the
# bound) and no file had failed; scripts/ci-fast.sh promotes it to the record
# CI_TOUCHED_BUSY_FILE only after counting the gate's failures, when the
# touched lane is the only one (scripts/ci-fast-busy-confirm.sh). The fast
# step (scripts/ci-fast-step.sh) then calls this script once:
#
#   1. wait, outside any lock, until load1 is back under the same threshold,
#      at most CI_BUSY_WAIT_SEC (default 600 s), logging the load;
#   2. run the touched tests and gtm:check again under a fresh heavy-job
#      acquisition with the same limits as the gate (420 s run bound,
#      540 s lock), and WITHOUT CI_TOUCHED_BUSY_FILE: a second timeout is red,
#      busy or not. Its exit code is the step's.
#
# No marker, or an unreadable one: exit 2 (nothing to retry; the gate's red
# stands). Test seams: CI_LOADAVG_FILE, CI_CPU_COUNT, CI_BUSY_POLL_SEC and
# CI_BUSY_RETRY_CMD (the command run in place of the heavy-job retry).
set -euo pipefail

busy_file="${CI_TOUCHED_BUSY_FILE:-}"
if [ -z "$busy_file" ] || [ ! -s "$busy_file" ]; then
  echo "::error::ci-fast-busy-retry: no busy record (${busy_file:-CI_TOUCHED_BUSY_FILE unset}): nothing to retry, the gate's red stands"
  exit 2
fi
record=$(tr -d '\n' < "$busy_file")
rm -f "$busy_file"
threshold=$(node -e 'const r = JSON.parse(process.argv[1]); if (!(r.threshold > 0)) process.exit(1); console.log(r.threshold)' "$record") || {
  echo "::error::ci-fast-busy-retry: unreadable busy record: $record"
  exit 2
}

loadavg_file="${CI_LOADAVG_FILE:-/proc/loadavg}"
wait_cap="${CI_BUSY_WAIT_SEC:-600}"
poll="${CI_BUSY_POLL_SEC:-15}"
load1() { cut -d' ' -f1 "$loadavg_file" 2>/dev/null || echo 0; }
over() { awk -v l="$1" -v t="$threshold" 'BEGIN { exit !(l > t) }'; }

echo "ci-fast-busy-retry: busy record $record; waiting up to ${wait_cap}s for load1 <= ${threshold}"
waited=0
load=$(load1)
while over "$load" && [ "$waited" -lt "$wait_cap" ]; do
  echo "ci-fast-busy-retry: load1 ${load} > ${threshold} after ${waited}s, waiting"
  sleep "$poll"
  waited=$((waited + poll))
  load=$(load1)
done
if over "$load"; then
  echo "ci-fast-busy-retry: load1 ${load} still > ${threshold} after ${waited}s (cap ${wait_cap}s): retrying anyway, once"
else
  echo "ci-fast-busy-retry: load1 ${load} <= ${threshold} after ${waited}s: retrying the touched tests once"
fi

unset CI_TOUCHED_BUSY_FILE
if [ -n "${CI_BUSY_RETRY_CMD:-}" ]; then
  code=0
  bash -c "$CI_BUSY_RETRY_CMD" || code=$?
else
  : "${BASE_REF:?ci-fast-busy-retry.sh needs BASE_REF (the PR base branch short name)}"
  code=0
  HEAVY_JOB_MAX_SEC="${HEAVY_JOB_MAX_SEC:-540}" scripts/ci-heavy.sh fast-retry -- \
    bash -c 'node scripts/ci-touched-tests.js --base "origin/$BASE_REF" && npm run gtm:check' || code=$?
fi
if [ "$code" = 0 ]; then
  echo "ci-fast-busy-retry: the retry passed: the gate is green"
else
  echo "::error::ci-fast-busy-retry: the retry failed (exit ${code}): the gate is red"
fi
exit "$code"
