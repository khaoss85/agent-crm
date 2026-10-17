#!/usr/bin/env bash
# Runs one heavy CI step under the machine lock of the self-hosted runner.
#
# The accordo-ci runner shares a 16 GB Mac with other factories, and the Mac's rule is
# one heavy job at a time, held by heavy-job.sh. A suite started beside another factory's
# 8 GB typecheck is exactly the swap/OOM the lock exists to prevent, so the steps that run
# the suite take the same lock as every local heavy step. Where the lock script is absent
# (a hosted runner, a contributor's machine) the step runs as it always did.
#
#   scripts/ci-heavy.sh <name> -- <command...>
set -euo pipefail
name="$1"; shift
[ "${1:-}" = "--" ] && shift
lock="${ACCORDO_HEAVY_JOB:-$HOME/dev/_work/minimal-core-main/tools/minimal/heavy-job.sh}"
if [ -f "$lock" ]; then
  exec env HEAVY_JOB_WAIT_SEC="${HEAVY_JOB_WAIT_SEC:-5400}" HEAVY_JOB_MAX_SEC="${HEAVY_JOB_MAX_SEC:-3600}" \
    bash "$lock" accordo "ci-$name" -- "$@"
fi
exec "$@"
