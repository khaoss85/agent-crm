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
# The shared queue of every factory on the CI server is the Orchestro core's heavy-job.sh,
# with its policy (slots, load threshold, steps that never share) in
# ~/.config/environment.d/60-heavy-job.conf. A systemd system service such as the runner
# does not read that file, and the runner's ACCORDO_HEAVY_JOB named a server-local lock
# that only queued CI against CI: a fast run took 6 cores beside the lanes' heavy steps
# and skewed the scaler's load (server, 07/11). So the installed core lock wins, with the
# policy read here; a value already in the environment (HEAVY_JOB_MAX_SEC of a step) stays.
core="${ACCORDO_CORE_HEAVY_JOB:-$HOME/dev/_work/minimal-core-versions/current/tools/minimal/heavy-job.sh}"
if [ -f "$core" ]; then
  conf="${ACCORDO_HEAVY_JOB_CONF:-$HOME/.config/environment.d/60-heavy-job.conf}"
  if [ -f "$conf" ]; then
    # Not sourced: environment.d values are raw (a regex with parentheses is not shell).
    while IFS='=' read -r key value; do
      case "$key" in
        HEAVY_JOB_*) [ -n "${!key+x}" ] || export "$key=$value" ;;
      esac
    done < "$conf"
  fi
  lock="$core"
else
  lock="${ACCORDO_HEAVY_JOB:-$HOME/dev/_work/minimal-core-main/tools/minimal/heavy-job.sh}"
fi
if [ -f "$lock" ]; then
  exec env HEAVY_JOB_WAIT_SEC="${HEAVY_JOB_WAIT_SEC:-5400}" HEAVY_JOB_MAX_SEC="${HEAVY_JOB_MAX_SEC:-3600}" \
    bash "$lock" accordo "ci-$name" -- "$@"
fi
exec "$@"
