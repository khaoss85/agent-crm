# Production Spine v2 M3A — PostgreSQL migration intent

This ExecPlan follows `.agent/PLANS.md`. It is a living implementation record
for M3A only. Live `pg` adapter, pool, CI service, M3B driver import, M4
idempotency/leases, wrapping `createAccordoApp()` in a Promise, runtime SQL
translation, released SQLite migration byte edits, PR #134, measurement and
JTBD promotion remain outside this plan.
<!-- truth: spine.postgresql.implemented=absent -->

## Goal and user-visible outcome

Give the framework an authoritative, dialect-explicit migration intent that
can render SQLite SQL byte-identical to the released core migrations and
PostgreSQL SQL without translating SQLite strings at runtime; a deterministic
63-byte physical-name map; an additive `module.state.json` version that
preserves v1 SQLite history and checks in a PostgreSQL bootstrap; explicit
pre-state adoption that runtime refuses until it is checked in; and a
versioned `schema_migrations` checksum ledger that backfills only pinned
identities.

This PR does not add the `pg` npm dependency, does not open PostgreSQL, and
does not claim the application runs on PostgreSQL.

## Current repository context

Baseline: `origin/main` `643ae82c02736d743ac46b53e62fbf9c7933b51f` (M2-complete
measurement). Runtime storage remains SQLite-only.

- `packages/core/src/database.js` owns `DATA_PLANE_MIGRATIONS` /
  `CONTROL_PLANE_MIGRATIONS` as SQLite SQL strings and creates
  `schema_migrations(version, name, applied_at)` outside that list. Module
  migrations already store a SHA-256 checksum; core ledger rows do not.
- `CORE_MIGRATIONS_FOR_CHARACTERIZATION` plus
  `tests/fixtures/spine-v2-m0-sqlite-schema.json` pin released v1–v5 identity
  and physical schema. v6/v7 SQL is already released and must stay
  byte-identical; this plan pins their checksums too.
- `packages/core/src/module-evolution.js` writes `stateVersion: 1`
  `{name, checksum, sql}` history. `readModuleState` auto-adopts a pre-state
  generated module in memory for factory authoring. Package modules in this
  repository are pre-state.
- PostgreSQL-shaped options already refuse with
  `STORAGE_ADAPTER_UNAVAILABLE`. No live adapter exists.
  <!-- truth: spine.postgresql.implemented=absent -->

## Approaches considered

### A. Translate existing SQLite SQL strings at the PostgreSQL boundary

Rejected. The Spine v2 plan already forbids a runtime SQL translator.
Whitespace-identical SQLite history would still not produce portable types
(`INTEGER` vs `BIGINT`, `TEXT` timestamps, boolean `0/1`, `STRICT`,
SQLite `RAISE` triggers).

### B. Replace `DATA_PLANE_MIGRATIONS[].sql` with a renderer and hope the bytes match

Rejected as the cut that edits released source. M0 pins those strings. A
renderer may *prove* it can reproduce them; the released literals stay in
`database.js` as the SQLite migrator’s input.

### C. Parallel intent objects that render both dialects; SQLite render is the proof

Chosen. A new dialect-intent module describes the same schema. Its SQLite
renderer must hash to the pinned checksums. PostgreSQL SQL is authored from
the same structure (BIGINT, BOOLEAN, TIMESTAMPTZ, schema `accordo`, quoted
physical names). The existing SQL strings are not parsed.

## Design and boundaries

### Dialect intent

- Intent lives under `packages/core/src/` (`physical-name.js`,
  `dialect-sql.js`, `core-schema-intent.js`, `schema-migrations-ledger.js`).
- SQLite render of core intent === existing `DATA_PLANE` / `CONTROL_PLANE`
  sql bytes (and therefore the M0/M2F checksums).
- PostgreSQL render is explicit. Persisted integers and cents fields are
  `BIGINT`. Booleans are `BOOLEAN`. Timestamp columns are `TIMESTAMPTZ`.
  Tables live in schema `accordo`. Identifiers are quoted physical names.
- No live PostgreSQL execution in this PR.

### Physical names

PostgreSQL `NAMEDATALEN-1 = 63` bytes. Safe `[a-z][a-z0-9_]*` names of at
most 63 bytes stay unchanged. Otherwise: bounded safe prefix +
collision-resistant SHA-256 digest. The complete namespace is validated
before DDL. The server is never asked to truncate. Mapping is recorded on
the intent/state.

### Additive module state

- Reads accept `stateVersion` 1 and 2. Writes emit 2.
- v1 `{name, checksum, sql}` SQLite history is preserved byte-for-byte.
- v2 adds `postgres.bootstrap` generated from the normalized current
  manifest (empty PostgreSQL data plane only) with its own checksum and
  provenance pointing at the v1 state fingerprint. Later dialect-specific
  evolutions append under `postgres.evolutions`.
- Runtime composition targeting PostgreSQL refuses
  `LEGACY_MODULE_STATE_REQUIRED` when a generated module has no checked-in
  state. It does not synthesize or write state at deployment time.
- Factory `module create --apply` remains the authoring write. No new CLI
  command in this PR (DX Simplicity Gate below).

### Pre-state registry adoption

A generated module with manifest + `src/migration.js` and no
`module.state.json` is a supported legacy input. Adoption reconstructs
revision-1 SQLite history with the existing verify-don’t-guess rule, then
checks in v2 state plus PostgreSQL bootstrap. Proven with a fixture, not by
adopting every bundled package in this PR.

### Core checksum ledger

Version **8**, plane `ledger`, is appended to every migration plane
(`combined`, `data`, `control`) so dedicated files and combined files all
gain `checksum`. SQL: `ALTER TABLE schema_migrations ADD COLUMN checksum TEXT`.
Backfill writes **pinned** checksums only when each applied `(version, name)`
is a known released identity and the observed business schema matches the
schema those identities produce (M0 fixture for an exact v1–v5 combined
prefix). Unknown tuple, missing object or divergent schema fail closed.
New migrations record `hash(sql)` normally. Existing M0-identity SQLite
files still boot.

v8 is not a data-plane business migration: `CORE_MIGRATIONS_FOR_CHARACTERIZATION`
labels it `plane: 'ledger'` so probes that `exec` only `plane === 'data'`
SQL (repository truth Company probe) do not run `ALTER TABLE schema_migrations`
against a database that has no ledger table.

## DX Simplicity Gate

No new agent-facing command is added.

- **Failure prevented by not adding `module:adopt`:** a second authoring
  verb that does what `module create --apply` already does for an unchanged
  revision-1 pre-state module (write the checked-in state file).
- **Existing primitive:** `readModuleState` adoption + `renderModuleState` +
  `module create --apply`. Extended to emit v2 with a PostgreSQL bootstrap.
  A public `adoptLegacyModuleState` / `requireAdoptedModuleStateForPostgres`
  pair is the runtime/authoring API; it is not a CLI rail.
- **Overlap bound:** `module create` stays create/evolve; PostgreSQL startup
  (M3B) will call the refusal. Adding `module:adopt` would be a second way
  to write the same state file.
- **Simpler goal flow:** an author still runs one apply; PostgreSQL boot
  fails closed until that apply is checked in.

## Milestones

### 1. ExecPlan

1. [x] Write this complete plan before source changes.

### 2. Dialect intent and physical names

1. [x] `physical-name.js` — 63-byte map, namespace validation, recorded
   mapping. Prove long, multibyte and collision candidates.
2. [x] `dialect-sql.js` — SQLite and PostgreSQL renderers from statement
   intent. No SQL-string parser.
3. [x] `core-schema-intent.js` — intent for released core migrations v1–v7
   plus v8 ledger ALTER. Prove SQLite render hashes match pinned checksums
   and the existing `database.js` sql bytes. Prove PostgreSQL render uses
   BIGINT for `value_cents` / integer columns.

### 3. Additive module state and pre-state adoption

1. [x] Extend `module-evolution.js`: read v1 and v2; write v2 with
   `postgres.bootstrap` + `postgres.evolutions`; preserve sqlite history.
2. [x] `requireAdoptedModuleStateForPostgres` → `LEGACY_MODULE_STATE_REQUIRED`.
3. [x] Fixture: pre-state generated module → adopted v2 state + bootstrap.
   Original SQLite bytes/checksum preserved; observed SQLite schema matches;
   bootstrap equals current manifest schema; adoption is deterministic.
4. [x] Refuse non-empty PG target, unreproducible bootstrap, runtime
   synthesis, missing adopted state.

### 4. Checksum ledger

1. [x] Version 8 ledger migration on every plane. Do not edit v1–v7 sql.
2. [x] Backfill pinned checksums; refuse drift/unknown/missing.
3. [x] Fresh and M0-identity SQLite databases still boot.
4. [x] Update pinned version lists that name the complete core order
   (`MIGRATION_VERSIONS`, lead-conversion upgrade assertion).

### 5. Docs and proofs

1. [x] DECISIONS.md — driver pin (`pg` exactly 8.23.0, PostgreSQL 16, no
   `pg-native`, not installed in this PR) and ledger/intent decisions.
2. [x] TASKS.md checked item. LEGACY_ALIGNMENT_MATRIX horizontal row.
   MODULE_EVOLUTION.md stateVersion 2. No test counts. No production-ready
   claim.
3. [x] `tests/spine-v2-m3a-*.test.js`. No live PostgreSQL. No credential or
   path in diagnostics.

## Validation

- Node 22.16 (`.nvmrc`).
- `node --test tests/spine-v2-m3a-*.test.js tests/spine-v2-m0-characterization.test.js tests/module-evolution-factory.test.js tests/lead-conversion-e2e.test.js tests/spine-v2-m2f-cross-plane-audit.test.js`
- `npm run verify` before completion (no `scripts/measure-suite.js --apply`).
- Expected: SQLite v1–v7 checksums unchanged; v8 present; M0 fixture still
  matches; PG intent contains `BIGINT` for cents; physical-name proofs;
  adoption and ledger proofs; PostgreSQL remains unimplemented.
  <!-- truth: spine.postgresql.implemented=absent -->

## Progress log

- Plan written against `643ae82c02736d743ac46b53e62fbf9c7933b51f`.
- Intent, physical names, additive state, pre-state adoption and v8 ledger
  implemented in this working tree. SQLite v1–v7 bytes unchanged.
- Ledger upgrade compares observed schema to core intent rather than opening
  a second `DatabaseSync` during startup (M2F close-hook characterization).

## Decision log

- **Driver pin (agreed with M3B, not installed here):** production driver
  `pg` (node-postgres) **exactly 8.23.0** (save-exact). No `pg-native`.
  Supported server major: **PostgreSQL 16**. A home-grown wire protocol
  would duplicate TLS, auth, prepared statements, COPY, error fields and
  cancellation; `pg` is the audited client. Pin exact, never float latest,
  never `try/catch` the import. SQLite remains Node built-in.
- **Released SQLite SQL stays in `database.js`.** Intent is parallel proof
  and the PostgreSQL authority, not a rewrite of the SQLite migrator input.
- **Ledger v8 is plane `ledger`**, included in every `MIGRATION_PLANES` list
  once, so combined files do not `ALTER` twice.
- **No `module:adopt` CLI.** Existing apply is the authoring write.
- **v6/v7 checksums are pinned from released bytes** in addition to M0
  v1–v5, otherwise current SQLite files would fail closed as unknown tuples.

## Outcome and follow-up

M3A lands the intent, physical-name map, additive module state, pre-state
adoption machinery and the checksum ledger. SQLite continues to boot. The
application does not run on PostgreSQL.
<!-- truth: spine.postgresql.implemented=absent -->

### Honest gaps left for later slices

- Live PostgreSQL adapter, pool, TLS connect, CI service (M3B).
- Dual bundled v1/v2 package graphs.
- Checking in `module.state.json` for every bundled package module
  (matrix: `deferred` — explicit adoption, not this PR’s silent rewrite).
- M4 leases/idempotency; Spine v3 jobs; production-ready claim.
