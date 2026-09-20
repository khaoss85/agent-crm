# MK1 recovery: funnel observations and human-reviewed proposals

## Goal and user-visible outcome
An agent records supplied funnel counts, reads a derived loss, prepares a complete campaign proposal, and a human reviews and approves an immutable version in Admin. No sending, publishing, spending, provider lookup, audience execution or scheduling is part of MK1.

## Context
Recovered commit f4cdff2 from factory/marketing-funnels-admin into an independent sibling worktree. Backlog 160de6844f5b requires five marketing resources, a versioned policy, Admin review and a human actor boundary. The recovered code had package declarations and mock-based tests but no public creation journey, no installer or runnable composition, and no ExecPlan. Default generatedDomains is deliberately empty and stays empty.

## Decisions and alternatives
1. Keep mock-only primitives: rejected because no agent can create the objects it must review.
2. Add domain endpoints or kernel behavior: rejected because existing module CRUD and record actions cover this journey.
3. Use a publicly authored funnel definition plus package actions for immutable observations, derived insights and managed proposals: chosen. Definition edits affect only future observations; each run stores its steps and counts. Proposal edits use an action limited to draft/refused; approval is terminal. No new CLI or MCP namespace.
The package remains opt-in through a documented static composition and generated manifests. No provider capability or external effect is introduced.

## Milestones
- Reproduce lifecycle, policy and input defects in the recovered implementation.
- Add the public creation journey and real HTTP/SDK evidence in a throwaway project.
- Document composition, precise limits and review findings; coordinate full verification with the integrator to avoid competing suites.

## Validation
Targeted: node --test tests/marketing-*.test.js tests/admin-marketing.test.js.
Conformance: npm run crm -- package test packages/marketing --json.
Health: npm run crm -- project doctor --json; npm run check.
Final: clean-clone npm install, npm run verify, npm run smoke and starter, coordinated by the integrator. Browser smoke and CI are separate evidence and are not inferred from unit tests.

## Progress
- Recovered and merged origin/main ec1d55f4; original worktree untouched.
- app inspect reports valid, zero packages in the default composition. Its limitations include no runtime/database/authorization attestation and no package Admin extension seam.
- Review: no public entry path; propose can regress an approved proposal; approve rechecks against default vocabulary rather than the reviewed policy; malformed JSON strings count as complete. Fixes and regression evidence in progress.

## Outcome and follow-up
Implementation and adversarial review in progress. No merge, runtime deployment or roadmap closure claimed. Marketing proposal generation uses supplied content; it neither queries Analytics Studio nor validates consent, audience membership, provider installation, send-time suitability or business effectiveness. A human actor is an asserted identity in development mode; production must supply the existing verified identity/membership configuration.


## Adversarial findings and durable learning candidates

- **High: no executable entry path.** The recovered tests invoked action handlers
  with storage doubles. In a real app every resource was get/list, no action
  created the observations or proposal, and Admin could only read existing rows.
  Fixed with an authored definition and observe/prepare/revise record actions;
  the HTTP/SDK test creates every input through public routes. Empty default
  composition was intentional, not a defect; the missing opt-in recipe is fixed.
- **High: the managed proposal manifest could not accept a draft.** The real
  HTTP journey rejected missing review/decision fields before those decisions
  could exist, and rejected blank optional content before it could be recorded
  as refused. Optionality and blank-to-null normalization now preserve the
  complete-or-refused contract. Storage doubles did not reproduce validation.
- **High: approved could regress to proposed.** A regression test demonstrated
  another propose succeeded on approved evidence. Approved is now terminal;
  revision is limited to draft/refused and a later campaign needs a new proposal.
- **High: approval ignored the reviewed vocabulary.** The original helper
  rechecked against default channels, so a stored proposal outside a narrowed
  policy could be approved. Approval now rechecks the configured policy inside
  its transaction, as well as identity and fingerprint.
- **Medium: malformed JSON passed completeness.** Unparseable JSON text,
  scalars and structurally empty content were accepted. Regression tests now
  require bounded structured sections with meaningful content. This checks
  presence, not business correctness.
- **Medium: storage failure became absence.** The read capability swallowed
  every storage error, and asynchronous storage became an empty object rather
  than evidence. Only NOT_FOUND becomes null; asynchronous results are settled
  before projection. Full PostgreSQL behavior is not established by this test.
- **Medium: repository facts omitted the new package.** Reference composition
  used a fixed package list and would have kept publishing marketing absent.
  The new package is now in that reference, with current claims explicitly
  restricted to proposal evidence. The namespace fact does not prove sending.

Learning candidate: a managed-record feature needs a public-journey test over
real module generation, storage, HTTP and SDK before its mocked handler tests
can be treated as delivery evidence. Conformance deliberately does not execute
a domain action. A list of passing primitives cannot establish a usable entry
path, validation compatibility, transaction rollback or identity enforcement.
Register this in the Factory intake with the recovered commit and failing HTTP
errors; this plan is evidence, not a claim that Factory learning is promoted.

## Review categories and current evidence

Public bypass, terminal-state algebra, immutable source snapshots, attach/detach,
rollback after every multi-record write, and two-connection approval contention
are exercised by `tests/marketing-e2e.test.js`. Rollback assertions count business
audits/events exactly and retain one failed action trace. Repeated proposal
preparation and approval are refused; observation intentionally records a new
sample on each successful invocation. Approval uses a primary-key record and
creates its single terminal version, not a bounded list count. The read-only
version capability uses an indexed exact query. Hostile content stays text in
the fake-DOM Admin tests; the runtime input tests reject extra managed fields.
Provider timeout, late provider settlement and remote reconciliation are not
applicable: the package has no external-operation/provider path. No horizontal
core contract changed, so no legacy alignment backfill is introduced.

Targeted package/action/Admin and real HTTP tests pass. Package conformance,
source doctor, solution-plan check and GTM checks pass. The first broader truth
run found a missed README absent citation; it was corrected, and the specific
check is rerun before commit. The full source suite is intentionally deferred
to the integrator's serial clean-clone run. Real-browser smoke, CI and merge
remain separate gates; no milestone or JTBD status has been promoted here.

The machine-readable `mk1-marketing.plan.json` records the source composition
baseline and was checked during recovery. The interrupted original work had no
plan; this recovery cannot retroactively claim it was planned before coding.
