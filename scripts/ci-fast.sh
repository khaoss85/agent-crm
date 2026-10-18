#!/usr/bin/env bash
# The PR gate's six phases under ONE machine lock.
#
# The accordo-ci runner shares a 16 GB Mac with other factories under a
# single heavy-job machine lock. Six separately locked steps, each capped
# at five minutes, can hold that lock ~30 minutes in total per PR push and
# queue Arvo's pushes and releases behind them. So the whole gate runs
# here, sequentially, behind a single acquisition with HEAVY_JOB_MAX_SEC=540
# (nine minutes, set at the calling step in .github/workflows/ci.yml): a PR
# holds the shared lock less than ten minutes in total, enforced by the
# wrapper killing the run past the budget — not six per-step budgets
# summing past it. Measured on CI run 39124350674: ~290 s of lock for all
# six phases, about half the budget. A phase that cannot fit the shared
# budget does not get a longer budget — it gets split, or moved to `main`.
#
# One lock also means one wait: the gate queues behind another factory's
# hold once, instead of once per phase.
#
# Usage (from the repository root, inside the `fast` CI job):
#
#   BASE_REF='<pr base branch>' bash scripts/ci-fast.sh
#
# `BASE_REF` names the PR base branch whose tracking ref the truth
# agreement check diffs against (`origin/$BASE_REF`, fetched by the step
# before); the touched-tests selection diffs against FETCH_HEAD, left by
# the same fetch. Each phase keeps its `::group::` log section, prints its
# own elapsed time, and the script prints the total on success — that line
# is the live evidence for the ten-minute bound. The first failing phase
# stops the gate with a `::error::` annotation, the way a red Actions step
# used to stop the job: later phases never run after a failure.
set -euo pipefail

: "${BASE_REF:?ci-fast.sh needs BASE_REF (the PR base branch short name)}"

# The total the calling step enforces through the wrapper; echoed with the
# final timing line so the bound stays readable in the log.
budget=${HEAVY_JOB_MAX_SEC:-540}

started=$SECONDS

run_phase() {
  local name="$1"
  shift
  echo "::group::$name"
  local at=$SECONDS
  if "$@"; then
    echo "ci-fast: phase '$name' passed in $((SECONDS - at))s"
    echo '::endgroup::'
  else
    local code=$?
    echo "ci-fast: phase '$name' FAILED after $((SECONDS - at))s"
    echo '::endgroup::'
    echo "::error::ci-fast: phase '$name' failed"
    return "$code"
  fi
}

run_phase 'npm run check' npm run check
run_phase 'tests of the touched files' node scripts/ci-touched-tests.js --base FETCH_HEAD
run_phase 'smoke demo' npm run smoke
run_phase 'published quote approval recipe' bash -c 'node --no-warnings examples/recipes/quote-approval/run.mjs "$RUNNER_TEMP/quote-approval-crm" && npm --prefix "$RUNNER_TEMP/quote-approval-crm" run verify'
run_phase 'public claims and packaging agree' npm run gtm:check
run_phase 'truth document agrees with its authorities' npm run repo:truth -- --check --drift-advisory --base "origin/$BASE_REF"

echo "ci-fast: all 6 phases passed in $((SECONDS - started))s of the ${budget}s total lock budget"
