# Production Spine v2 — PostgreSQL per-tenant storage

## Goal and user-visible outcome

Add a production PostgreSQL data-plane adapter without changing Accordo's
current tenancy model: one running application instance is bound to one tenant
and one isolated data plane. A project can select SQLite for local and existing
deployments or PostgreSQL for a production deployment, while module services,
actions, workflows, audit and trace retain the same externally observable
behaviour.

This plan deliberately does **not** implement shared-database row tenancy,
Cloud C0, authentication, durable jobs, secrets, backups or observability.
PostgreSQL is not permission to claim general production readiness. The
framework still authenticates nobody; a deployment adapter still supplies the
verified identity described by ADR-038.

## Current repository context

The plan starts from merged closeout main `9c8565f`. The current measurement
ledger describes ancestor `5a9b7fb`; its measured result and test-tree identity
remain owned exclusively by `site/claims.json` and are not repeated here.

The current storage boundary has two distinct layers:

- `packages/core/src/tenant-storage.js` binds one tenant to one SQLite data-plane
  path and one separate control-plane path. The application receives no
  `databasePathFor` method, so a second tenant is unreachable through its
  binding.
- `packages/app/src/create-app.js` consumes that binding and creates a data-plane
  and control-plane database through `packages/core/src/database.js`.
- `packages/core/src/database.js` is not yet a portable adapter contract. Its
  public JSDoc shape wraps `node:sqlite`, exposes `raw: DatabaseSync`, and module
  services issue synchronous SQLite statements through `database.raw.prepare()`.
  More than fifty package/application/test files depend on that shape. Calling
  it an existing swappable adapter would overstate what the code proves.
- Data-plane and control-plane migrations are already separated, and generated
  module/package migrations join the data plane at composition time. That
  separation is reusable; their SQLite SQL text is not automatically portable.
- ADR-038 says row-level PostgreSQL tenancy belongs to Spine v2, while the
  ratified mission chooses the narrower current deployment model: PostgreSQL
  **per tenant**, one tenant per instance, with shared-database tenancy deferred
  unless economics justify it. Implementation must amend ADR-038 and the
  execution roadmap explicitly rather than leaving those two authorities in
  conflict.

Before implementation, re-read `PRODUCT.md`, `ARCHITECTURE.md`, `DECISIONS.md`,
`docs/strategy/MASTER_PLAN.md`, `docs/PROJECT_STATUS.md`, ADR-038,
`docs/QUALITY_GATES.md`, `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, and
the files above. Run the smallest relevant source/composition checks; do not
infer runtime database health from `app inspect`, which is source-only.

## Approaches considered

### A. Translate SQL strings at the PostgreSQL boundary

Keep every service synchronous and rewrite SQLite syntax/placeholders in an
adapter. Rejected. PostgreSQL drivers are asynchronous, transaction affinity
matters, and a SQL-text translator would make correctness depend on an
incomplete parser. It would appear cheap only by hiding the largest risks.

### B. Make the entire application asynchronous in one change

Replace `DatabaseSync`, convert every service and every caller to promises, and
land PostgreSQL simultaneously. Rejected as a single causal changeset. It mixes
a framework-wide control-flow refactor, query portability, migration
portability and a new production dependency; a failure could not be localized
or rolled back safely.

### C. Characterize, extract a narrow async storage contract, migrate two real
consumers, then add PostgreSQL

Chosen. First freeze externally observable SQLite behaviour. Introduce the
smallest contract that two unlike consumers actually need (one core module and
one generated/package module), prove it over SQLite, then migrate the remaining
consumers in bounded groups. Only after the application no longer exposes
SQLite driver semantics does the PostgreSQL implementation join the same
conformance suite. This applies the two-consumer rule before declaring a
generic seam and keeps each milestone runnable.

The contract is not a query builder and not an ORM. Its candidate operations are
bounded prepared execution/query methods, transaction scoping, migration
application and close. Exact names and result shapes are decided only after the
first two consumers demonstrate them; raw driver handles never cross it.

## Milestones

### M0 — Freeze the branch point and the observable contract

1. Run a clean Node 22.16.0 baseline: `npm run verify`, `npm run smoke`,
   `npm run repo:truth -- --check`, `npm run gtm:check`, and `npm run site:check`.
2. Add characterization that drives the public API/SDK and named workflows over
   SQLite for CRUD, managed-action refusal, audit/event/trace exactness,
   transaction rollback, restart persistence, migration adoption and two-
   connection contention.
3. Record normalized receipts that contain domain objects and stable error
   codes, never driver messages, paths, timing or database-specific metadata.

Exit: the existing SQLite application remains byte-compatible at its public
surfaces and the characterization fails when a storage-visible invariant moves.

### M1 — Extract the storage contract with two consumers

1. Define a versioned internal storage contract in `packages/core` because it is
   a reusable runtime capability consumed by every domain, not domain-specific
   behaviour. State the ADR-018 justification in the PR and ADR.
2. Implement that contract over SQLite without changing schema or behaviour.
3. Migrate two materially different consumers first: the handwritten Company
   module and one generated/package-owned resource with migrations, exact reads,
   audit and an action. Do not declare the seam generic until both pass.
4. Remove direct `raw` access from those consumers and add a guard that prevents
   it from returning.

Exit: both consumers pass the same contract and characterization tests while
all untouched consumers continue on the compatibility path.

### M2 — Complete the SQLite-side extraction

1. Move remaining core modules, generated services, package services, audit,
   trace, workflows and migration bookkeeping in reviewable groups.
2. Convert public service/application control flow to async only where the
   contract requires it; preserve route and SDK response shapes.
3. Delete the compatibility path only after a repository guard proves no
   business consumer reaches `DatabaseSync`, `.raw.prepare()` or `.raw.exec()`.
4. Keep the provisioning-side tenant resolver separate from the application
   binding; the application handle still cannot name a second tenant.

Exit: SQLite passes the full suite through the portable contract, and the raw
SQLite driver is private to the SQLite adapter.

### M3 — Add PostgreSQL migrations and adapter

1. Add one production PostgreSQL driver only after recording in `DECISIONS.md`
   why it removes more complexity than a home-grown wire protocol. Pin and audit
   it; never wrap an import in `try/catch`.
2. Represent migration intent in an authoritative form that renders explicit
   SQLite and PostgreSQL SQL. Do not translate arbitrary SQL at runtime.
3. Preserve append-only name/checksum semantics. An applied migration whose
   authoritative intent changes must fail closed on both adapters.
4. Implement prepared parameter binding, result normalization, nested
   savepoints, transaction connection affinity, rollback, conflict mapping and
   deterministic close over PostgreSQL.
5. Bind a PostgreSQL data plane by opaque connection configuration, not by a
   filesystem path. Never return a credential, URL, host or database name in
   schema metadata, audit, trace or an error.

Exit: a PostgreSQL instance can boot, migrate and run the two-consumer slice;
SQLite remains green.

### M4 — PostgreSQL conformance and tenant isolation proof

1. Run the same storage conformance suite against SQLite and PostgreSQL.
2. Run the full technical suite against both adapters, not two hand-selected
   smoke paths.
3. Prove two tenant bindings use distinct PostgreSQL databases/data planes. A
   subject from tenant B receives the existing 404-before-403 cross-tenant
   refusal and cannot read tenant A's domain, audit or trace rows.
4. Prove an application binding still has no operation that can select another
   tenant. No `organization_id` filter is introduced and no shared database is
   claimed.
5. Test migration restart, concurrent migration startup, transaction rollback,
   two-connection races, exact reads beyond page bounds, hostile input and
   normalized constraint/conflict errors on PostgreSQL.

Exit: PostgreSQL per-tenant storage is executable evidence rather than a
configuration claim, and SQLite/PostgreSQL differences cannot escape the
adapter contract.

### M5 — Truth, documentation and adversarial review

1. Amend ADR-038 and `docs/strategy/EXECUTION_ROADMAP.md`: Spine v2 is
   PostgreSQL per-tenant storage; shared-database row tenancy is deferred to a
   separately justified economic/scale decision.
2. Update `PRODUCT.md`, `ARCHITECTURE.md`, `TASKS.md`, `docs/PROJECT_STATUS.md`,
   application inspection limitations, bootstrap/starter copy and the
   Repository Truth authorities in the same PR. Regenerate
   `docs/repository-truth.json`.
3. Add the horizontal storage-contract row to
   `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`, recording every existing
   domain as `aligned | partial | deferred | not_applicable | needs_extraction`
   with one-line reasons. Do not refactor a domain opportunistically to make a
   cell green.
4. Keep JTBD coverage conservative until a merged end-to-end scenario proves a
   named job. PostgreSQL conformance alone promotes no row.
5. Use the `adversarial-review` skill. Fix every technical P1/P2/P3 with a
   regression, rerun from a clean clone against both adapters, and request a
   fresh exact-head review.

Exit: exact-head GitHub CI and the relevant deployment check are green, truth
and public limitations agree, and no review thread remains technically open.

## Success evidence

The implementation PR is complete only with machine-readable receipts for:

- one contract suite, unchanged, passing against SQLite and PostgreSQL;
- full application verification against both adapters;
- deterministic migration/checksum equivalence and restart;
- rollback after each significant write and correct savepoint nesting;
- two-connection conflict behavior with no raw driver error;
- one-tenant-per-instance isolation across domain, audit and trace reads;
- no credential or storage locator in public schema, errors, audit or trace;
- the SQLite characterization unchanged from M0;
- repository truth, GTM, site, smoke and clean-clone quality gates green.

The implementation PR must document how PostgreSQL was supplied to CI (service
container, pinned version, readiness probe and database lifecycle). A skipped
PostgreSQL suite is a failure, not a green result.

## Rollback

Until M3, rollback is a normal code revert because SQLite remains authoritative
and no PostgreSQL data is promised. From M3 onward migrations are forward-only:
rollback means deploy the last compatible application while retaining the
database, never edit or delete an applied migration. Before any production
cutover, rehearse export/restore into a fresh per-tenant database and record the
receipt. There is no automatic SQLite↔PostgreSQL live-data migration in this
milestone; such a migration needs its own plan, idempotency contract and rollback
evidence.

## Validation

During implementation, run the smallest gate that answers the current question;
the final clean-clone pass includes:

```bash
npm run verify
npm run smoke
npm run repo:truth -- --check
npm run gtm:check
npm run site:check
npm run crm -- project verify --json
```

Add the adapter-conformance and PostgreSQL project-verification commands to
`package.json` only if they clear the DX Simplicity Gate. Prefer internal test
scripts invoked by existing `verify`/`project verify` authorities over a new
agent-facing rail.

## Progress log

- 2026-08-23: governance closeout verified on live GitHub. PR #111 merged as
  `51b276b`; Vercel provenance restoration merged in PR #112 as `8ca790a`;
  post-governance truth merged in PR #113 as `240ffd4`.
- 2026-08-23: exact-main CI exposed a temporary-git fixture race. PR #114
  disabled fixture-local automatic Git maintenance and merged as `5a9b7fb`;
  production provenance behavior was unchanged.
- 2026-08-23: final measurement PR #115 merged as `9c8565f`, measuring source
  `5a9b7fb`; exact-head GitHub CI, Vercel and Codex review were green.
- 2026-08-23: inspected ADR-038, the tenant binding, database composition,
  migration planes, raw SQLite consumers, quality gates and legacy-alignment
  rule. Plan written; implementation has not started.

## Decision log

- **Tenancy stays one tenant per instance/data plane.** The mission's ratified
  target narrows the older roadmap sentence that bundled PostgreSQL with
  shared-database row tenancy. The implementation ADR must reconcile it.
- **No fake adapter seam.** `AccordoDatabase` currently exposes `DatabaseSync`;
  the plan calls it SQLite infrastructure, not a portable contract.
- **Async portability is extracted before PostgreSQL.** This avoids a SQL
  translator and prevents one unreviewable all-repository conversion.
- **Two consumers before generalization.** One handwritten module and one
  generated/package consumer must shape the contract.
- **No data-migration promise.** Adapter conformance and moving an existing
  tenant's live data are separate correctness problems.

## Outcome and follow-up

The closeout baseline is ready for Spine v2 planning, and this branch contains
the executable work package. Implementation is intentionally not started.
Spine v3 jobs/outbox/scheduler; Spine v4 secrets/backups/observability; Truth
Contract v2 generated `productionPosture`; `commercial-quotes@1` deprecation;
real browser automation; DX6 observation of ADR-032 operations; remote package
install/update/uninstall/registry; Customer Data Operations v2; Interactions;
Billing; Marketing/Analytics; DX9; DX13; and a real Codex/Gemini comparative
benchmark remain separate follow-ups.

Private Cloud and the public-to-private repository migration remain blocked on
human creation/access for `accordo-platform`. This plan creates no private
repository and starts no Cloud C0 work. Vercel account/project scope remains a
separate operational follow-up even though the builds themselves are green.
