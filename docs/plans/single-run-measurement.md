# Measure one execution, with all its evidence

## Goal and user-visible outcome

Produce the public measurement and its per-file contributions from one real
`npm run verify`. A complete green run is required; missing evidence, input
movement or a failed check records nothing. This closes a concrete remaining
cost and correctness gap under Accordo P1 `79405f9df589`.

## Current repository context

At base `ec1d55f`, `scripts/measure-suite.js` runs verify, then executes every
test file again sequentially to construct a map. The map is supposed to describe
the original run, yet actually comes from different executions. Node's test
stream already emits a summary for each file and a final summary; the human
reporter drops the per-file summaries. `planRefresh` additionally filters its
diff to `tests/`, so changed source can inherit unexecuted green contributions.

Canonical intake `4875cf06052ec389` deduplicated onto `79405f9df589`. Its
evidence records the proposed learning: keep evidence from the original proof,
and enumerate the inputs that invalidate any reused result. This is a candidate
lesson, not a promoted execution rule or a completed remediation.

## Milestones

1. Add a separate reporter channel and require exact file coverage, reconciled
   counters and final root success. Keep the existing verify authority.
2. Refuse publishing after a dirty tree or changed HEAD. Refuse incremental
   refresh across inputs outside tests, except a ledger-only measurement update.
3. Prove the contract on constructed reports and disposable real npm projects;
   integrate the change before the final clean-clone verification and measurement.

## Validation

`node --test tests/measurement-report.test.js tests/measure-refresh.test.js`
checks malformed and incomplete summaries, skipped/todo semantics, exact
contributions, single execution, failed suites, dirty trees, moved commits and
refresh refusals. The real fixture writes a marker per execution outside the
tracked input set, so an accidental second run fails an assertion.

The final integrator runs `npm run verify`, measurement, smoke, the starter and
`npm run repo:truth -- --check --require-current` on the combined candidate.
Neither a passing targeted fixture nor a commit constitutes release evidence.

## Decision log

- Keep `npm run verify`, adding only reporter arguments forwarded to its final
  npm test command. A changed script that cannot supply the channel refuses.
- Use runner counters, not names, symbols or guessed nesting semantics. Every
  reported count must reconcile with the root from that same run.
- Refresh is deliberately conservative: even documentation can be a test input.
  The only exception outside tests is `site/claims.json` with all fields outside
  `measuredAgainst` unchanged. No dependency graph or safe edit is guessed.
- Do not change the ledger, freshness ratio, verifier or gate to accommodate the
  implementation. No full project suite is started in parallel with the parent's
  baseline; the integrator owns that execution.

## Progress log

- Read the existing intake and authoritative pack; reused its identity through
  the canonical intake command, retaining evidence and pending outcome.
- Implemented the reporter and summary parser; the disposable actual runner
  confirms each file executes once with nested, skipped and todo tests.
- Tightened refresh input checks and publication guards. The targeted measurement
  and refresh suites pass, including the unchanged dependent test that fails
  after its source changes; syntax and diff checks also pass. Full integration
  verification remains with the integrator.

## Outcome and follow-up

Pending integration, full verification and independent receipt. The existing
`backlog-79405f9df589-landing-2` owner decision and mutation-seat authority must
be reconciled by the integrator before publication/confirm-fix. This plan does
not close that decision or assert a published remediation.
