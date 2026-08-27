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
- [ ] Run M0/M1, Repository Truth, and full verification gates.
- [ ] Complete exact-head CI, Vercel, and Codex review.

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

Run targeted Work, conversion, pipeline, API, and workflow suites; M0 and M1
storage/characterization suites; `npm run repo:truth -- --check`; then
`npm run verify`, smoke, GTM/site checks, and exact-head external gates.
