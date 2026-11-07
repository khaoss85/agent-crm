#!/usr/bin/env bash
# Runs one heavy CI step under the machine lock of the self-hosted runner.
#
# A self-hosted runner shares its machine with other factories (the lanes, Arvo's stages),
# and the machine's rule is a shared queue of heavy steps, held by the Orchestro core's
# heavy-job.sh. A suite started beside another factory's typecheck is the overload the
# queue exists to prevent, so the steps that run the suite take the same queue as every
# local heavy step. Where no lock script is installed (a hosted runner, a contributor's
# machine) the step runs as it always did.
#
# Which lock, first match wins:
#   1. ACCORDO_CORE_HEAVY_JOB, default the installed core
#      ~/dev/_work/minimal-core-versions/current/tools/minimal/heavy-job.sh;
#   2. ACCORDO_HEAVY_JOB, default ~/dev/_work/minimal-core-main/tools/minimal/heavy-job.sh.
# The core wins over ACCORDO_HEAVY_JOB on purpose: on the CI server (07/11) the runner's
# ACCORDO_HEAVY_JOB named a server-local lock that only queued CI against CI, so a fast
# run took 6 cores beside the lanes' heavy steps and skewed the scaler's load. To force
# another lock, set ACCORDO_CORE_HEAVY_JOB to it.
#
# With the core lock, its policy (slots, load threshold, steps that never share) is read
# from ~/.config/environment.d/60-heavy-job.conf (ACCORDO_HEAVY_JOB_CONF), which a systemd
# system service such as the runner does not read. A value already in the environment
# (HEAVY_JOB_MAX_SEC of a step) stays.
#
#   scripts/ci-heavy.sh <name> -- <command...>
set -euo pipefail
name="$1"; shift
[ "${1:-}" = "--" ] && shift
core="${ACCORDO_CORE_HEAVY_JOB:-$HOME/dev/_work/minimal-core-versions/current/tools/minimal/heavy-job.sh}"
if [ -f "$core" ]; then
  conf="${ACCORDO_HEAVY_JOB_CONF:-$HOME/.config/environment.d/60-heavy-job.conf}"
  if [ -f "$conf" ]; then
    # Not sourced: environment.d values are raw (a regex with parentheses is not shell).
    # The last line counts without a trailing newline; a malformed key is skipped, never fatal.
    while IFS='=' read -r key value || [ -n "$key" ]; do
      [[ "$key" =~ ^HEAVY_JOB_[A-Z0-9_]+$ ]] || continue
      [ -n "${!key+x}" ] || export "$key=$value"
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
