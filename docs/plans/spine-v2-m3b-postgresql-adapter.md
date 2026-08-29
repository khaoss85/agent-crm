# Production Spine v2 M3B — PostgreSQL adapter behind Storage Contract v1

This ExecPlan follows `.agent/PLANS.md`. It is a living implementation record
for M3B only.

Worker A / M3A owns migration-intent SQL, `module.state.json` bytes and the
DECISIONS.md rationale for choosing `pg`. M3C / Lead owns full application
boot on PostgreSQL. M4 owns idempotency keys, leases and unknown-commit
recovery beyond adapter-level storage conformance.

## Goal and user-visible outcome

A PostgreSQL adapter implements Storage Contract v1 over a connection-affine
pooled client. The same contract tests run against SQLite and PostgreSQL.
`createAccordoApp()` stays synchronous and SQLite-only. The application does
not boot on PostgreSQL. Public claim C-17 stops saying “zero third-party
runtime dependencies” and states the pin: SQLite remains Node built-in;
PostgreSQL requires exactly `pg@8.23.0`; there is no ORM.

Limitation in the same breath: applications that select PostgreSQL carry this
driver. This is not shared-database tenancy and not production readiness.
<!-- truth: spine.postgresql.implemented=absent -->

## Current repository context

Baseline: `origin/main` `643ae82c02736d743ac46b53e62fbf9c7933b51f`.

- `packages/core/src/storage-contract.js` exports `STORAGE_CONTRACT = 1`,
  `renderSqliteStatement` (`?` placeholders) and `createSqliteStorage`.
- `packages/core/src/database.js` claims the transaction minter once at load
  and wraps `node:sqlite`.
- `packages/core/src/transaction-witness.js` mints an opaque witness per outer
  transaction. ADR-018 addendum 8 obliges a pooled adapter to bind that
  witness to the **acquired client handle**, never a pool facade.
- `createAccordoAppAsync()` refuses PostgreSQL with
  `STORAGE_ADAPTER_UNAVAILABLE`. That refusal stays.
- `package.json` has no `dependencies` field. `spine.postgresql.implemented`
  is `absent`, with `package.json#dependencies:none` as a second authority.
- C-17 currently claims zero third-party runtime dependencies.

## Approaches considered

### A. Translate SQLite SQL strings at the PostgreSQL boundary

Rejected by the parent plan. A SQL-text translator is an incomplete parser
pretending to be an adapter.

### B. Introduce an ORM or a general query builder

Rejected. The contract is a closed statement vocabulary. An ORM would be a
second query language and a larger supply-chain surface than `pg`.

### C. Adapter over `pg@8.23.0` rendering `$1..$n`, with a connection-affine client

Chosen. One pinned driver, static `import pg from 'pg'` (never `try/catch`),
the existing closed vocabulary, Pool + acquired client, SERIALIZABLE outer
writes, nested savepoints, result normalization, bounded error codes,
client-side deadlines distinct from server `lock_timeout` /
`statement_timeout`.

## Design and boundaries

### Driver pin

- Production dependency: `pg` **exactly `8.23.0`**. No `pg-native`. No
  floating range. First third-party runtime dependency.
- Import lives in `packages/core/src/postgresql-storage.js` only, so the
  SQLite boot path (`database.js` → `createSqliteStorage`) never evaluates
  `import 'pg'`. Generated SQLite projects still need no install.
- Server in CI: `postgres:16`.

### Statement rendering

`renderPostgresqlStatement` shares the closed vocabulary with SQLite and
emits `$1..$n` in the same parameter order. Unsupported statements still
throw `STORAGE_STATEMENT_UNSUPPORTED`. No arbitrary SQL escape hatch.

### Adapter owns

Pool, prepared binding, placeholder rendering, result normalization,
transaction client affinity, nested savepoints, rollback, close, error
normalization, connection / acquisition / query deadlines.

Tiny internal helper `createPostgresqlDatabase({ connection })`. Not a
public factory. Not `createAccordoAppAsync`.

### Safe values

JS safe integers persist through `BIGINT`. Driver strings convert only after
a canonical decimal and `Number.isSafeInteger`. Unsafe BIGINT refuses with
`STORAGE_INTEGER_UNSAFE` and does not round. Booleans / null / timestamps
match SQLite observable shapes (`true`/`false` → `1`/`0`). Parameter order
is exact. Largest already-accepted monetary value in this repo is
`Number.MAX_SAFE_INTEGER` cents.

### Connection-affine transactions

- Outer business-write transactions: `BEGIN ISOLATION LEVEL SERIALIZABLE`
  plus transaction-local `lock_timeout` and `statement_timeout`.
- The callback receives a **distinct** storage handle bound to the acquired
  client. The M2 witness is minted on that handle, never the Pool facade.
- Same client accepted; a handle bound to a different pooled client refused
  (`STORAGE_CLIENT_AFFINITY`); a closed transaction refused
  (`STORAGE_TRANSACTION_CLOSED`); nested savepoints roll back correctly;
  the client returns to the pool only after commit/rollback cleanup.
- Nested outer transactions on the same async context remain
  `NESTED_TRANSACTION`.
- Autocommit writes (no active affine client) acquire a client, run one
  SERIALIZABLE transaction, and release.

### Deadlines and black-hole

Client-side connection / acquisition / query deadlines are separate from
server timeouts. On expiry the pending client is **destroyed, not returned**.
A subsequent acquisition must succeed. Stable codes:
`STORAGE_TIMEOUT`, `STORAGE_UNAVAILABLE`. Connection loss during `COMMIT`
maps to `COMMIT_OUTCOME_UNKNOWN` and is not retried as a rollback. Full
unknown-commit recovery is M4.

### Conflict

Unique violations and serialization/deadlock map to bounded conflict codes
(`CONFLICT` / `STORAGE_SERIALIZATION_FAILURE`). The adapter does not
auto-retry: a complete effect plan is not a storage-statement property, and
this PR has no provider calls. State-changing helpers the storage tests
exercise run at SERIALIZABLE; full action/workflow `FOR UPDATE` is M3C/M4.

### Conformance suite

The same storage-contract cases run against both adapters.
`tests/spine-v2-m3b-postgresql-adapter.test.js` covers affinity, SERIALIZABLE,
timeouts, integer safety, credential sentinels, savepoints, pool recovery.

CI (`process.env.CI === 'true'`) or `ACCORDO_TEST_POSTGRES=1`: PostgreSQL
must run; inability to connect fails with `ACCORDO_PG_TEST_REQUIRED`, never
skip. Locally, if no server is reachable, the live suite may skip with an
explicit message. Rendering tests always run.

Default URL: `postgres://postgres@127.0.0.1:5432/accordo_test`,
overridable by `ACCORDO_PG_TEST_URL`. Isolated schema per case; clean
teardown. Credentials, host and URL never appear in results or errors.
Sentinels in tests: `pg-user` / `s3cret-unavailable` (never `s3cret-value`).

### Public claims and truth

- C-17 and every surface that currently says “zero third-party runtime
  dependencies” are updated. SQLite remains Node built-in; PostgreSQL
  requires `pg@8.23.0`; no ORM. Limitation in the same breath.
- `spine.postgresql.implemented` stays **`absent`**: the application still
  does not boot on PostgreSQL. The second authority stops being
  “no production dependencies” (that would contradict the pin) and becomes
  “the public factory still refuses PostgreSQL” plus “production
  dependencies are empty or exactly `pg`”.
- `SPINE_NOT_MODELED` names PostgreSQL **application composition** and
  shared-database row-level tenancy, so the adapter existing does not
  silently falsify the declaration.
- Do not type a test count. Do not run `measure-suite.js --apply`.

### Out of scope

- Rewriting `module.state.json` or core SQLite migration SQL bytes
- Dual bundled package graphs
- Booting `createAccordoApp` / `createAccordoAppAsync` on PostgreSQL
- Wrapping `createAccordoApp()` in a Promise
- M4 idempotency keys, leases, unknown-commit recovery beyond mapping
- ORM, raw SQL hatch, SQLite-to-PG translator
- `try/catch` around `import 'pg'`
- Floating `pg` version, `pg-native`
- Touching PR #134
- Claiming shared-database tenancy or production ready
- `using`; tests use `workspaceFor(t)` / `t.after`

## Milestones

### M3B-1 — ExecPlan and driver pin

Write this plan. `npm install pg@8.23.0 --save-exact`. Record the pin in
DECISIONS.md as an ADR-001 addendum (implementation pin; M3A owns the
protocol-vs-driver rationale).

### M3B-2 — Renderers and adapter

Shared closed vocabulary; `renderPostgresqlStatement`;
`createPostgresqlStorage` / `createPostgresqlDatabase`; shared transaction
minter module so SQLite and PostgreSQL do not double-claim.

### M3B-3 — Conformance and adapter tests

Same contract cases on both adapters. Affinity, SERIALIZABLE, deadlines,
integer safety, credential scans, savepoints, destroyed-client recovery.

### M3B-4 — CI, claims, truth, matrix

GitHub Actions `postgres:16` service on the verify job. C-17 and citing
surfaces. repo-truth second authority. Legacy alignment matrix row for this
horizontal seam. TASKS.md / PROJECT_STATUS.md.

### M3B-5 — Verify and commit

`npm run verify` (live PG in CI; local skip only when not required).
`npm run repo:truth` if facts moved. Commit. Push the branch. Do not open a
PR.

## Validation

- `node --test tests/spine-v2-m1-storage-contract.test.js tests/spine-v2-m3b-postgresql-adapter.test.js`
- `npm run verify`
- `npm run repo:truth -- --check` after regenerating `docs/repository-truth.json`
- `npm run gtm:check` / `npm run site:check` stay green
- CI verify job starts `postgres:16` and sets `CI=true`

Expected: SQLite contract tests unchanged; PostgreSQL renderer always green;
live PostgreSQL suite green in CI; C-17 no longer claims zero runtime
dependencies; `spine.postgresql.implemented=absent` still holds.

## Progress log

- [x] Read storage contract, witness, claims, truth, CI, C-17 surfaces.
- [x] Write this ExecPlan.
- [x] Pin `pg@8.23.0` and lockfile.
- [x] Shared renderer + PostgreSQL adapter + affine transactions.
- [x] Same contract tests on both adapters + M3B adapter tests.
- [x] CI service, C-17, truth, matrix, status.
- [x] Local syntax check, gtm:check, repo:truth --check, and the new/adjacent tests. Live PostgreSQL skipped locally (no daemon); CI is the authority. Full `npm test` is long-running on this machine because of pre-existing shell-oracle/characterization files.

## Decision log

- **Live PG skip policy.** Campaign: a skipped PostgreSQL suite is failure
  on the official verify path. GitHub Actions sets `CI=true`. Local macOS
  without a daemon may skip; CI must not.
- **`import 'pg'` is adapter-local.** A re-export from
  `storage-contract.js` would load `pg` on every SQLite boot and break
  create-accordo's no-install SQLite path.
- **Witness on the affine handle, not the pool.** ADR-018 addendum 8. A
  pool-level mint would make concurrent transactions share one identity.
- **No adapter-level serialization retry.** A storage statement is not a
  replay-safe effect plan.
- **Fact stays `absent`.** Adapter ≠ application composition.

## Outcome and follow-up

Shipped on this branch:

- `pg@8.23.0` is the first production runtime dependency. SQLite still uses
  `node:sqlite` and does not load `pg`.
- `renderPostgresqlStatement` shares the closed vocabulary and emits `$1..$n`.
- `createPostgresqlStorage` / `createPostgresqlDatabase` own the pool, affine
  SERIALIZABLE transactions, nested savepoints, BIGINT safe-integer
  normalization, deadlines and credential-free errors.
- The same async storage-contract cases run against both adapters.
- `createAccordoApp()` / `createAccordoAppAsync()` still refuse PostgreSQL
  composition. `spine.postgresql.implemented` remains `absent`.
- C-17 names the pin and the limitation. GitHub Actions verify starts
  `postgres:16`.

Follow-up: M3C boots the application on PostgreSQL. M4 owns idempotency,
leases and unknown-commit recovery. Dual bundled package graphs remain later
work. Do not claim production ready or shared-database tenancy.
