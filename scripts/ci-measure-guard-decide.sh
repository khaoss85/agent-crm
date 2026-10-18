#!/usr/bin/env bash
# Fail-closed mapping from ci-measure-guard.js stdout to the scheduled-measure
# step output (backlog:911355123044).
#
# Only the literal string "false" skips the measurement. Anything else —
# "true", empty output, unexpected text, a crash marker — measures. The
# direction is deliberate: a skipped measurement the tree needed would leave
# stale claims behind with only a warning (the push-time public-claims job
# signals age, it does not gate), while a redundant measurement costs at most
# one run inside its window.
#
#   ci-measure-guard-decide.sh <guard-stdout>
set -euo pipefail
if [ "${1:-}" = "false" ]; then
  echo "measure_needed=false" >> "$GITHUB_OUTPUT"
else
  echo "measure_needed=true" >> "$GITHUB_OUTPUT"
fi
