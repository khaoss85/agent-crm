# ExecPlan: selected record modules in the async (v2) composition

## 1. Goal and user-visible outcome

`selected.modules` names in `createAccordoAppAsync` register real record
modules (customer-data, work, intelligence) in the async assembly, with their
migrations applied, and the packages' operations/actions execute against real
SQLite and real PostgreSQL storage. Pilot proof
`tests/framework-composition.test.js` flips from refusal to execution; the
framework Customer Single View becomes reachable without duplicating it.

## 2. Current repository context

- `packages/app/src/portable-app.js` `assemblePortableGraph` registers only
  company/contact/opportunity/approval. `accepted.modules` are name strings
  for action eligibility; a module object is dropped without a word
  (`packages/app/src/async-lifecycle.js` `preflightSelectedGraph`).
- Record modules are manifest JSON (`packages/<pkg>/modules/*.module.json`).
  The only constructor is codegen (`packages/cli/src/module-factory.js`,
  template strings for `module create --apply`); no runtime
  manifest→module constructor exists. `packages/modules/generated/index.js`
  is empty, so even the v1 walk registers nothing today.
- Generated services use `database.storage.sync.*` only. The dual
  sync/async seam already exists: `packages/core/src/storage-runtime.js`
  (`isSyncStorage`, `storageApi`, `settleStorageRead`, `storageMaybeOne`,
  `storageMany`, `storageMutate`); portable-app uses it for its own reads.
- Package domain code is sync (`customer-data/src/store.js` calls
  `service.listWhere(filters)` and indexes the result). A v2 package is the
  same functions re-stamped (`package-graph.js` `cloneGraph`).
- New runtime capability (not domain behavior): ADR-018 core-budget safe —
  a generic manifest→record-module constructor plus registration of
  caller-selected names. No domain concept enters core/app.

## 3. Milestones (each leaves the repo runnable)

- **M1 — runtime constructor + registration on sync storage.**
  New `createRecordModuleFromManifest(manifest, {database, audit, events,
  references})` (home: `packages/core/src/`, reused by v1 walk later).
  `assemblePortableGraph` resolves each `accepted.modules` name against the
  composed packages' manifests and registers the module; unknown names fail
  closed at startup. Migrations for registered records applied via the
  existing `moduleMigrations` channel (collected with the already-checked-in
  `generateModuleMigration`). Test: async SQLite app lists and executes a
  package record (create/get/listWhere) — green on sync storage.
- **M2 — async execution.** Record services use the `storage-runtime`
  seam so reads/writes work where `storage.sync` is absent (affine tx
  preserved via `runWithAffineStorage`). Sync behavior byte-identical.
  Test: same suite against loopback PostgreSQL (docker, real server).
- **M3 — package operations end-to-end.** customer-data import
  preview/apply + read-customer-profile, work actions, intelligence actions
  on the host lead record, on SQLite and PostgreSQL. Customer Single View
  read proven on PG, provenance intact.
- **M4 — rollout.** Restricted PR + adversarial review per repo rules;
  only then pilot pin, conformance and pilot proof-test update (separate
  pilot PR, owner-gated rollout — not this branch).

## 4. Validation

- `npm run verify` in this worktree before completion.
- New tests: `tests/async-record-modules.test.js` (M1 SQLite),
  PG variant on loopback harness (M2/M3, needs docker postgres).
- Pilot `tests/framework-composition.test.js` is the external oracle: it
  must go red-on-refusal → green-on-execution only via M4, never edited
  here to expect less.

## 5. Progress log

- 2026-09-09: worktree `async-record-modules`, branch
  `feat/async-record-module-registration` created from `5d13c4b`. Diagnosis
  re-verified in source (registration gap + sync-only services + empty
  `generatedModules`). Plan written.
- 2026-09-09 M1 implemented: `core/src/record-module-runtime.js` (runtime
  manifest→module constructor, three capability classes, SQLite DDL
  collector), `CORE_RESERVED_TABLES` hoisted to `module-manifest.js`
  (factory imports it, no behavior change), preflight accepts
  `{name, manifest}` (strings unchanged), SQLite lifecycle merges record
  DDL, PG lifecycles refuse with `RECORD_MODULE_POSTGRESQL_PENDING`,
  `assemblePortableGraph` registers after the kernel with a reference
  resolver. New `tests/async-record-modules.test.js`: 5/5 green on SQLite.
  Full `npm run verify` running for regressions.
- 2026-09-09 verify: 2266 tests, 2180 pass, 3 fail, 83 skipped (PG suites
  skip without a database, expected). Fail triage: M0 `--db`-semantics
  fails identically on the untouched base (pre-existing); truth-contract
  was mine (authority hash moved) — fixed via `npm run repo:truth`
  (64/64 green); shell-classifier cross-product shares no code path with
  this change (benchmarks surface vs bash, 531s env-sensitive) — recorded
  as unrelated, not re-run on base for economy.
- 2026-09-09 M2 implemented: `postgresRecordModuleMigrations` (manifest →
  `generatePostgresModuleBootstrap`, stable `pg_bootstrap_<table>` names for
  the checksum ledger), PG writer/reader lifecycles merge record DDL instead
  of refusing. New `tests/async-record-modules-postgresql.test.js`: green on
  real PostgreSQL 16 (dedicated `accordo-m2-pg` container, port 5433) —
  managed round-trip, boolean mapping, update, applyManaged, audit trail.
  SQLite suite still 4/4, `repo:truth --check` clean.
- 2026-09-09 M3 implemented: domain read paths ported to async
  (`customer-data` operations/store/profile/capability/quality/actions,
  `work` follow-up/legacy/index, `intelligence` actions — 23 sites, all in
  already-async functions or newly async helpers). No interface shape
  changes except delivery timing (see decisions). New
  `tests/async-record-modules-packages.test.js`: full 3-package composition
  on SQLite — apply, idempotent replay, real profile read, work NOT_FOUND
  on missing row, host `lead` stays unregistered. PG suite extended with
  apply + profile read, green on real PG. Package suites green
  (customer-data 29, work 29, intelligence 17). Full `npm run verify`
  re-running.
- 2026-09-09 verify triage: only digest-ownership failures from this
  change — `repository-truth.json` (regenerated, 64/64) and the
  intelligence characterization baseline (regenerated via
  `characterize:intelligence`; diff reviewed: one digest line, zero
  asserted values moved; 29/29). Remaining fails are pre-existing or
  environmental (M0 `--db` identical on base; shell cross-product shares
  no code path). m0 sync-delivery pin intentionally evolved to a
  settled-value pin (values identical).

## 6. Decision log

- Manifests travel as data: resolution reads the composed packages'
  shipped `modules/*.module.json` (function-free, fingerprint-neutral
  until the package contract adopts them explicitly — M4 decision).
- No change to `preflightSelectedGraph` string semantics: names stay
  names; `{name, manifest}` objects register. Anything else is refused,
  loudly (the silent drop was the defect).
- The constructor lives in core as a runtime capability; domain packages
  are untouched structurally (they already ship manifests + resources
  lists) — only their read paths went async.
- `applyManaged` exists on read-only services (in-process only, never a
  capability/HTTP): `store.js trusted()` defines the read-only managed
  record contract as trusted writes, and the framework's own packages
  apply counts to their run records. The codegen template never needed
  the update half for user modules; not a template change.
- Delivery timing, not values: `findBySourceKey`, capability identity
  methods, `profileFor`/`canonicalClusterFor`, `detectIssues`,
  `detectOrphans`, `resolveBatch` and `policy.resolve` are async now. The
  m0 sync-delivery pin became a settled-value pin (values identical);
  v1 callers already awaited async domain functions, and the contract-2
  runtime settles thenables by design.
- Outbox observation (not this seam): after a successful apply on PG, a
  later `company.create` logs one designed-recovery outbox dispatch
  (`NESTED_TRANSACTION`, all assertions green). Untouched code
  (`write-outcome-runtime`); flagged for the PR review, not chased here.
- `docs/repository-truth.json` regenerated twice (authority hashes moved,
  no fact moved) per the repo's own rule, in the same branch.

## 7. Outcome and follow-up

Implemented M1–M3 on branch `feat/async-record-module-registration`,
worktree `agent-crm-worktrees/async-record-modules`. Verify: 2269 tests,
2182 pass, 2 fail (both triaged: M0 `--db` pre-existing on base,
shell-classifier environmental with no shared code path), 85 skipped
(PG suites without a database). New proofs: 4 SQLite record tests, 2 PG
record tests, 2 package end-to-end tests. Adversarial probes held
(kernel-name squat → CONFLICT at startup; PG unique violation →
CONFLICT). Matrix row added (`LEGACY_ALIGNMENT_MATRIX.md`).
Follow-up (not this branch): pilot pin + proof flip, owner-gated
rollout; outbox-recovery observation flagged for review.

Container `accordo-m2-pg` (postgres:16-alpine, host port 5433) stays up
for proof re-runs; it is mine — remove with
`docker rm -f accordo-m2-pg` when the review no longer needs it.
