#!/usr/bin/env bash
# The fast PR gate step (backlog:3d560518f3e2): the gate under its heavy-job
# lock, then — only when the gate itself confirmed a busy touched-tests
# timeout as its single failure (scripts/ci-fast-busy-confirm.sh wrote
# CI_TOUCHED_BUSY_FILE) — the one retry (scripts/ci-fast-busy-retry.sh).
# Any stale record is removed before the gate starts, and a gate that ended
# any other way (killed by the 540 s wrapper, several failures) leaves no
# record, so its exit code stands.
# Test seams: CI_FAST_GATE_CMD and CI_FAST_RETRY_CMD replace the two commands.
set -uo pipefail
record="${CI_TOUCHED_BUSY_FILE:-}"
[ -z "$record" ] || rm -f "$record" "$record.candidate"
rc=0
if [ -n "${CI_FAST_GATE_CMD:-}" ]; then
  bash -c "$CI_FAST_GATE_CMD" || rc=$?
else
  HEAVY_JOB_MAX_SEC=540 scripts/ci-heavy.sh fast -- bash scripts/ci-fast.sh || rc=$?
fi
if [ "$rc" != 0 ] && [ -n "$record" ] && [ -s "$record" ]; then
  if [ -n "${CI_FAST_RETRY_CMD:-}" ]; then
    bash -c "$CI_FAST_RETRY_CMD"
  else
    bash scripts/ci-fast-busy-retry.sh
  fi
  exit $?
fi
[ -z "$record" ] || rm -f "$record.candidate"
exit "$rc"
