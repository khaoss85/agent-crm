#!/usr/bin/env bash
# The PR gate's eight phases under ONE machine lock.
#
# The accordo-ci runner shares a 16 GB Mac with other factories under a
# single heavy-job machine lock. Eight separately locked steps, each capped
# at five minutes, can hold that lock ~30 minutes in total per PR push and
# queue Arvo's pushes and releases behind them. So the whole gate runs
# here, sequentially, behind a single acquisition with HEAVY_JOB_MAX_SEC=540
# (nine minutes, set at the calling step in .github/workflows/ci.yml): a PR
# holds the shared lock less than ten minutes in total, enforced by the
# wrapper killing the run past the budget — not eight per-step budgets
# summing past it. Measured on CI run 39124350674: ~290 s of lock for the
# seven phases then present, about half the budget. A phase that cannot fit the shared
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
# The composition drift detector. The checked-in verifier fixture pins the
# composition its scenario composes; any change to the composed application
# moves it, and the fixture's exit-0 test is the only test that notices —
# but it runs only when selected. This phase runs that one test on every PR
# (~10 s: the real AX1 inspection plus one real scenario run), so a PR that
# changes the composition and leaves the fixture behind fails here, on the
# PR, instead of on main the next night. The fix is repeatable:
# `npm run repin:verifier-fixture`.
run_phase 'verifier fixture still reaches exit 0' node --no-warnings --test --test-name-pattern="the checked-in verifier fixture reaches exit 0" tests/solution-verify.test.js
# The checked-in example plans pin the composition they were written against
# (`plan.application.inspectionFingerprint`, plus the paired evidence pins
# and cited artifact hashes); any change to the composed application — a new
# package, a new action, a record that gained a field, a moved admin file —
# stales them, and the four currency tests below are the only tests that
# notice, but they run only when selected (a work action and an app-surface
# export hid behind ~95-test fan-ins in the warned fallback and reddened
# main on schedule: backlog:ea9b4bba). This phase runs those four tests on
# every PR (~15 s: two composed-project inspections), so a PR that changes
# the composition and leaves a pin behind fails here, on the PR, instead of
# on main at the next scheduled measure. The fix is a repin: record the live
# fingerprint (`crm solution check <plan> --json`), recompute the plan
# fingerprint, and update the paired evidence pins.
run_phase 'checked-in plan pins still bind' bash -c 'node --no-warnings --test --test-name-pattern="the shipped example is current against this repository, and check says so" tests/solution-plan.test.js && node --no-warnings --test --test-name-pattern="the shipped Service solution plan validates, and checks against a composed project" tests/service-operations-integration.test.js && node --no-warnings --test --test-name-pattern="the shipped M14b2 solution plan validates, and checks against a composed project" tests/delivery-change-acceptance-integration.test.js && node --no-warnings --test --test-name-pattern="every source artifact the checked-in documents cite is present with exactly that hash" tests/solution-verify.test.js'

echo "ci-fast: all 8 phases passed in $((SECONDS - started))s of the ${budget}s total lock budget"
