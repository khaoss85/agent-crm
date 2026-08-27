# Production Spine v2 M2A — generated and Work legacy extraction

This ExecPlan is a living document. It follows `.agent/PLANS.md` and is bounded
to Approval, Contact, Opportunity, and `migrateLegacyTasks(...)`. PostgreSQL,
M2B, control-plane extraction, shared-database tenancy, and new public surfaces
are explicitly out of scope.

## Purpose

Move the four named compatibility consumers behind Storage Contract v1 without
changing their synchronous reads, Promise mutations, validation, audit/events,
savepoints, persistence, or legacy adoption behavior. No new storage statement
shape is needed: join-derived display fields are resolved through existing
module services, and the legacy table is read with the existing closed
`select` vocabulary.

## Progress

- [x] Inventory raw SQLite reachability before mutation.
- [x] Migrate Approval, Contact, and Opportunity reads/writes.
- [x] Migrate Work legacy-table discovery and row reads.
- [x] Add a structural no-raw-driver guard for the declared slice.
- [x] Run M0/M1, Repository Truth, and full verification gates.
- [x] Complete exact-head CI and Vercel gates.
- [x] Address Codex review by keeping Work partial and correcting stale raw-read prose.

## Current repository context

Storage Contract v1 is implemented by `packages/core/src/storage-contract.js`
and rendered by the SQLite adapter in `packages/core/src/database.js`. The
canonical generator already emits `storageContract: 1` services. Before M2A,
three older checked-in generated services used `database.raw`, while Work's
retained forward migration read a legacy `tasks` table through the raw driver.
They now use closed Storage Contract v1 statements and service-owned relation
reads; the separate Work transaction-context check remains raw. The
Repository Truth storage authority in `scripts/repo-truth.js` executes the Work
migration reads, and the alignment matrix distinguishes this bounded extraction
from Work's remaining transaction-context residue.

## Milestones

1. **Inventory and characterize.** Classify raw-driver reachability and run the
   existing generated-service and Work migration tests without changing source.
   The repository remains runnable and establishes the compatibility baseline.
2. **Extract checked-in generated residues.** Move Approval, Contact, and
   Opportunity to existing closed statements and service-owned relation reads;
   add a structural guard. Targeted suites remain green after this milestone.
3. **Extract the Work legacy migration.** Move table discovery and bounded row
   reads to closed `select` statements while preserving dry-run, atomicity,
   identity, and idempotency. Work remains runnable and its migration suite is
   green.
4. **Reconcile truth and verify.** Regenerate Repository Truth, keep Work partial
   for the separate transaction-context residue, and run all local and external
   gates before regular merge.

## Raw-driver inventory

| Classification | Path / consumer | Reason and disposition | Evidence owner |
|---|---|---|---|
| `M2A_CURRENT_SLICE` | `packages/modules/approval/src/approval-service.js` — Approval | Compatibility CRUD used raw prepared statements; migrate to `database.storage.sync`, resolving display joins through Opportunity. | workflow/API tests plus structural guard |
| `M2A_CURRENT_SLICE` | `packages/modules/contact/src/contact-service.js` — Contact | Compatibility CRUD used raw prepared statements; migrate to closed insert/select statements. | lead-conversion tests plus structural guard |
| `M2A_CURRENT_SLICE` | `packages/modules/opportunity/src/opportunity-service.js` — Opportunity | Compatibility CRUD and managed savepoint used the raw driver; migrate to closed statements and storage savepoint, resolving display joins through Company/Contact. | pipeline and conversion tests plus structural guard |
| `M2A_CURRENT_SLICE` | `packages/work/src/legacy-tasks.js` — Work forward migration | Legacy table discovery and bounded row reads used raw SQLite; migrate both reads to structured select statements without deleting the migration. | `tests/work-legacy-task-migration.test.js` |
| `ADAPTER_INTERNAL_ALLOWED` | `packages/core/src/database.js`, `packages/core/src/core-adapters.js`, `packages/core/src/spine-store.js` | SQLite adapter/compatibility internals own `DatabaseSync`, PRAGMAs, rendering, and raw-driver closure. | M0/M1 storage suites |
| `LATER_M2_CORE` | `packages/core/src/action-runtime.js`, `packages/core/src/package-registry.js` | Core runtime persistence outside this bounded compatibility family. | action/package registry suites |
| `LATER_M2_PACKAGE` | `packages/commercial/src/registry.js`, `packages/signature/src/registry.js`, `packages/intelligence/src/registry.js` | Package definition-version registries are separate package extraction work. | package characterization suites |
| `LATER_M2_PACKAGE` | `packages/workflows/src/engine.js` | Workflow-run persistence is a separate runtime with joins and trace semantics. | workflow tests |
| `LATER_M2_PACKAGE` | `packages/work/src/follow-up.js#requireCallerTransaction` | Work's capability checks the raw driver's `isTransaction` flag to prevent a half-written task/activity pair; the legacy migration is extracted in M2A, but this separate transaction-context seam keeps Work `partial`. | Work capability fault/concurrency suites |
| `MIGRATION_SOURCE_ALLOWED` | `packages/core/src/module-evolution.js` | References the adapter-owned foreign-key migration check in explanatory source; it does not open the driver. | module-evolution tests |
| `CHARACTERIZATION_ONLY` | M0/M1 fixtures and temporary-project harnesses under `tests/characterization/` | Direct SQLite setup is preserved test evidence, not production reachability. | characterization suites |
| `TEST_ONLY` | remaining occurrences under `tests/` | Fault injection, physical-schema assertions, and adapter tests intentionally exercise SQLite directly. | owning test files |

## Decisions

- Reuse Storage Contract v1 unchanged. Adding joins or arbitrary expressions
  would enlarge the vocabulary for convenience when existing public module
  services already provide the two real relations.
- Keep the Work table identifier runtime-selected but canonical and pass it as
  a structured statement table. The SQLite adapter remains the sole SQL
  renderer; Work receives no raw-query escape hatch.
- Keep `spine.storage.work_legacy_raw` as the stable fact id and move its value
  to `absent`; the authority executes both structured migration reads before
  publishing that absence.

## Validation

Run these commands under Node 22.16.0:

```bash
node --test tests/work-legacy-task-migration.test.js \
  tests/lead-conversion-e2e.test.js \
  tests/opportunity-pipeline-e2e.test.js
node --test tests/spine-v2-m0-characterization.test.js \
  tests/spine-v2-m1-storage-contract.test.js
npm run repo:truth
npm run repo:truth -- --check
npm run smoke
npm run gtm:check
npm run site:check
git diff --check
npm run verify
```

Expected behavior is zero test failures, an unchanged M0/M1 contract, a current
generated truth document, and no raw-driver token in the declared
generated/legacy slice. Exact-head GitHub CI and Vercel must pass, and a fresh
Codex review must have no unresolved P1/P2/P3 before merge.

## Progress log

- **2026-08-27:** Inventoried the bounded slice and later-M2 consumers before
  mutation.
- **2026-08-27:** Migrated Approval, Contact, Opportunity, and the Work legacy
  migration using Storage Contract v1 without adding statement vocabulary.
- **2026-08-27:** Targeted, characterization, Repository Truth, full CI, and
  Vercel gates passed at M2A head `26ba59d`; Codex identified stale explanatory
  prose and this plan's incomplete structure for closeout.
- **2026-08-27:** Corrected the prose and completed the required living-plan
  structure without widening M2A.

## Outcome and follow-up

The declared Approval, Contact, Opportunity, and Work legacy-migration paths no
longer reach the raw SQLite driver. Public behavior and Storage Contract v1 are
unchanged. Work deliberately remains `partial`: `follow-up.js` still checks the
raw driver's transaction state, which requires a bounded transaction-context
seam in later M2 package work. Core runtime stores, package registries, and the
workflow engine remain explicitly outside M2A; PostgreSQL and M2B did not start.
