# Reconcile GTM with the software a new user receives

## Goal and user-visible outcome

Current documentation, public answers, site and installation instructions agree
with released framework capabilities and distinguish the registry snapshot from
the current source. Known false negative claims fail maintenance checks. A
new scaffolder candidate includes current source and verifiable provenance.

## Context

The 7 September audit compared framework main `5d13c4b`, live site provenance,
the actual `create-accordo@0.1.0` tarball, GitHub distribution receipts and the
two private pilot repositories. The site already served main, but FAQ,
comparisons, ledger limitations and operating plans still denied PostgreSQL,
authorization, durable jobs, governed customer import and lifecycle amendment.
The registry snapshot predates these releases. Repository Truth and GTM checks
passed because citations are opt-in and prose is not generated from facts.

## Approaches and decision

1. Edit visible pages only: fastest, but leaves stale source and machine-facing
   answers which regenerate the defect. Rejected.
2. Build a general natural-language truth engine: cannot reliably prove arbitrary
   prose, adds a new maintenance system and delays the concrete correction.
   Rejected.
3. Reconcile canonical content, extend the existing bound surfaces and retired
   claim regression mechanism, prove the packed installation and reuse the clean CI
   verification as the measurement path. Chosen: reuse executable authorities, explicitly retain
   the residual need for editorial review, and publish no unmeasured capability.

## Milestones and ownership

1. Public-content agent: ledger, answers, comparisons, capability/concept/glossary,
   README and current JTBD wording. Never alter the historical measurement.
2. Operating-docs agent: GTM plan, founder queue, distribution and strategy.
3. Distribution agent: current-source bootstrap candidate, provenance, tarball
   verification and staged workflow.
4. Integrator: current product/status, gates, generated retrieval, measurement,
   install page, private README reconciliation, one independent final review,
   PR/CI and public-site verification. Each coding agent owns a sibling worktree
   and branch. The integration pass reconciles all shared truth.

## Validation

- Clean baseline `npm ci`, `npm run verify`, `npm run smoke`; record existing
  environment failures separately from changes. CI at the branch point is green.
- Focused mutation tests restore recorded false claims with correct citations
  intact and require refusal. Do not claim arbitrary prose is verified.
- `npm run gtm:check`, `npm run repo:truth -- --check`, doctor, full verify,
  smoke and packed installation from an empty directory.
- Generate measurement through `scripts/measure-suite.js` on a clean, green
  environment. Never type counts or move the recorded SHA by hand.
- Independent review of the integrated commit, followed by delta validation for
  corrections. Confirm site version equals merged main and inspect human and
  machine answers after publication. npm state changes only after registry proof.

## Progress

- 2026-09-07: audit reproduced; separate worktrees and owners established;
  baseline suite running on unchanged detached checkout, exact-head CI green.
- 2026-09-07: private platform advanced during work; its newly merged ledger
  records M1 validation. README corrections cite the dated record without
  inventing a fresh runtime check or a public Cloud release.

- 2026-09-07: integrated all three agents; corrected generated retrieval and
  inspector limitations at their source, expanded regression checks, and proved
  the packed starter in an empty project. Private repository suites passed;
  framework verification and independent final review are in progress.

- 2026-09-07: independent review found stale installer/plugin metadata and a
  registry quickstart missing the required apply flag. Corrected descriptions,
  skill mirrors and the discovery boundary gate; added targeted regressions.

## Boundaries and decisions

No business runtime expansion, fabricated benchmark, outreach, spend, public
launch campaign or automatic customer-data selection is part of this repair.
GTM adoption experiments remain assigned next work; documentation cannot create
external user evidence. npm approval may require the owner's existing 2FA path;
prepare and verify the exact artifact before presenting that final action.

## Outcome and follow-up

In progress. Record final commits, verification, site and npm receipts here.
