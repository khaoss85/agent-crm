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
# Cure lane (backlog:55ca4e0cb76d): the workflow names a `cure` PR's gate
# `fast-main-red-cure`, which the CI server queue ranks 0
# (heavy-job-priority.json `*/main-red-*`). Anything missing or outside
# [A-Za-z0-9_-] falls back to `fast`: today's lane for every other PR.
heavy_name="${CI_FAST_HEAVY_NAME:-fast}"
case "$heavy_name" in
  ''|*[!A-Za-z0-9_-]*) heavy_name="fast" ;;
esac
echo "ci-fast-step: heavy-name=$heavy_name"
rc=0
if [ -n "${CI_FAST_GATE_CMD:-}" ]; then
  bash -c "$CI_FAST_GATE_CMD" || rc=$?
elif [ "$heavy_name" = "fast" ]; then
  # Today's lane, byte for byte (the step budget test certifies this line):
  # a PR without the `cure` label runs the exact gate it always ran.
  HEAVY_JOB_MAX_SEC=540 scripts/ci-heavy.sh fast -- bash scripts/ci-fast.sh || rc=$?
else
  # Cure lane: the same gate under the same cap, under the rank-0 heavy name.
  HEAVY_JOB_MAX_SEC=540 scripts/ci-heavy.sh "$heavy_name" -- bash scripts/ci-fast.sh || rc=$?
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
