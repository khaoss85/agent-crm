# Production Spine v2 — final M2 public posture, health, raw boundary

This ExecPlan follows `.agent/PLANS.md`. It is the living implementation record
for the last M2-owned blockers that still sit on merged `main` after M2A–M2F
and M2E-1/2/3. It does not start PostgreSQL/M3, does not migrate bundled
packages onto dual v1/v2 graphs, and does not change default `accordo serve`.

Branched from `origin/main` `53682119963a93fcaac2358cee17321dc6fe64f9`
(PR #149). Open PR #134 is unrelated strategy work and is not touched.

## Goal and user-visible outcome

Close M2 so SQLite is usable through the portable contract, public operational
surfaces expose only bounded storage posture, production `GET /health` does not
read tenant data, and the raw SQLite driver is private to the adapter.

Target stop after this PR merges and an exact GitHub-hosted measurement of
that `main` lands: `M2_COMPLETE_MEASURED_READY_FOR_M3`.

Public shape for portable/document-selected storage remains the already
ratified frozen descriptor:

```js
{ adapter: 'sqlite' | 'postgresql', available: boolean }
```

`describeDeploymentStorage()` in `packages/core/src/deployment-storage.js` is
the named contract. Do not invent a second shape.

## Live requirement reconciliation

Repository truth overrides older PR bodies. Sources read at `5368211`:

- `docs/plans/production-spine-v2-postgresql.md` (ratified M2 section, fingerprint `8874e940d985f32f`)
- `docs/plans/spine-v2-m2-requirements.json` / `spine-v2-m2-requirement-map.md`
- `TASKS.md`, `docs/PROJECT_STATUS.md`, `DECISIONS.md`
- `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`
- merged M2E-3 plan `docs/plans/spine-v2-m2e3-public-async-factory.md`
- live source: `apps/server/src/http-server.js`, `packages/core/src/core-adapters.js`,
  `packages/app/src/create-app.js`, `packages/app/src/portable-app.js`,
  `packages/cli/src/commands.js`, `packages/mcp/src/tools.js`

### Classification

| Item | Class | Reason |
|---|---|---|
| **M2-05** repository guard / raw-driver exit | **M2_BLOCKER** | Ratified M2 item 3: delete the compatibility path only after a guard proves no business consumer reaches `DatabaseSync`, `.raw.prepare()` or `.raw.exec()`. M2-23 additionally requires the raw driver private to the SQLite adapter. The M2-owned work is the guard plus migrating remaining business reach; deleting the v1 compatibility factory itself is later deprecation. `packages/core/src/core-adapters.js` is **not** adapter-internal by name: it is lead-conversion application logic still calling `database.raw`. That is a `BUSINESS_CONSUMER_BLOCKER`. The portable path already uses Storage Contract v1 (`createPortableCoreAdapters`). `packages/core/src/database.js` owning `DatabaseSync` is `SQLITE_ADAPTER_INTERNAL` only if no public/package consumer obtains the handle. |
| **M2-08** bounded `{adapter, available}` on every public/portable surface | **M2_BLOCKER** | M2F entry wiring bounded document-selected CLI/serve/migrate output. Remainder still live: production `GET /health` returns `app.doctor()` (path + tenant counts), local MCP `crm_doctor` returns `app.doctor()`, `/api/schema` has no storage projection, public error details and portable HTTP `/health` still need a nested-graph leak walk. Compatibility SQLite `--db` path disclosure stays on the characterized v1 surfaces (`Database: …`, `doctor.database`, `db:migrate.database`). |
| **M2-23** M2 exit criteria | **M2_BLOCKER** | Ratified exit: SQLite through the portable contract; raw driver private to the adapter; both the legacy synchronous suite and the new async suite pass **their respective** characterization suites. The M2-complete proof is a representative public `createAccordoAppAsync()` child-process scenario (Company/Contact/Opportunity, one uniform v2 action or operation, audit/trace where the selected path supports it, close, restart from the same file, read again, close exactly once) plus preserved v1 sync factory, v1 custom package on v1, v1 fail-closed on portable, PostgreSQL refuse before connect. It is not “run every bundled-package test on v2”. |
| **Dual bundled v1/v2 package graphs** | **LATER_COMPATIBILITY_WORK** | The ratified M2 paragraph names dual definitions during compatibility, but the ratified M2-23 exit and the merged M2E-3 living plan (approach C, ADR-018 addendum 10) already closed the portable SQLite factory over an explicit empty contract-2 kernel graph without migrating bundled packages. Full dual graphs are required before default `accordo serve` can move to the async factory and before those packages can compose on PostgreSQL (v1 refused with `PACKAGE_ASYNC_CONTRACT_REQUIRED`). They are **not** required to prove M2-23. Owner: later compatibility slice (pre-default-serve migration / pre-M3 package composition). Not M3’s adapter PR. Stale TASKS/LEGACY_ALIGNMENT_MATRIX sentences that still say “M2E-3 owns dual bundled graphs” are corrected in this PR. They are not marked completed. |
| **Default `accordo serve`** | **LATER_COMPATIBILITY_WORK** | M2-09 migrates serve onto the async factory **when PostgreSQL is selected**, retaining the characterized synchronous SQLite path. PostgreSQL is absent. Default SQLite serve staying v1 is the ratified compatibility path. Moving default serve to async is blocked on dual bundled graphs. |
| **M2-34** health/readiness vs tenant state | **M2_BLOCKER** (adapter-independent portion only) | Production `GET /health` still calls `app.doctor()`, which reads Company/Contact/Opportunity/Approval/workflow/audit counts and returns `database` path. Lease-driven readiness is M2-35 / M4 and is **not** implemented here. M2 health is process/startup completed, owned runtime initialized, storage adapter posture available, listener/runtime state. Admin counts leave unauthenticated `/health` for an authenticated `records.read` metrics read using existing `kind: 'count'` storage vocabulary. No new permission. No public metrics platform. |
| **M2-35** lease-driven readiness | **M4** (already mapped) | Unexpired writer lease does not exist. |
| **PostgreSQL adapter, live TLS, control-plane bootstrap, CLI-on-PostgreSQL** | **M3_PREREQUISITE** | No driver. This PR refuses PostgreSQL before connect and does not add one. |

Do not create another semantic roadmap parser. The requirement map stays
planning/ownership only.

## Current repository context

| Surface | What it does today at `5368211` |
|---|---|
| `GET /health` | `apps/server/src/http-server.js` returns `app.doctor()`. v1 doctor includes `database: database.path` and tenant `counts`. Portable HTTP doctor is already `{ok, storage, packageContract, …}` without counts, but the shared router still calls `app.doctor()`. |
| Admin dashboard | `apps/admin/public/app.js` `refresh()` `Promise.all`s `/health` and renders `health.counts`. |
| Document-selected CLI | `publicDoctor` / serve JSON already `{adapter, available}`. `--db` still prints the path. |
| `createAccordoAppAsync()` | Frozen facade plus `{adapter:'sqlite', available:true}`. Kernel CRM over explicit empty contract-2. |
| `createCoreAdapters` | `database.raw.prepare` for company-name and contact-email lookup. Only production consumer of `createCoreAdapters` is `packages/app/src/create-app.js`. Portable path has a Storage Contract copy. |
| `packages/core/src/database.js` | Owns `DatabaseSync` and exposes `raw` on the v1 handle. |
| Production MCP | `ACCORDO_MODE=production` is static source-only; `crm_doctor` is refused. Local MCP still returns `app.doctor()`. |
| `/api/schema` | No `database` field today; no bounded `storage` projection either. |
| Storage contract | Already has `kind: 'count'` → `COUNT(*) AS "n"`. No new statement vocabulary. |
| Measurement ledger | Stale: `site/claims.json` `measuredAgainst.sha` = `27cc663`, tests 1685 / 140 files. Do not type counts. Measurement is a **later** PR on exact post-merge main. |

## Design and boundaries

### M2-08 — bounded posture

Audit every public/in-process surface listed below. For portable/document-selected
operation, no public object or output may expose: filesystem path, PostgreSQL URL,
host, port, database name, user, password, TLS material, identity-verifier module
path, raw driver error, database/storage handle.

Surfaces:

1. `createAccordoAppAsync()` facade (already bounded; keep the leak walk).
2. Document-selected CLI doctor / serve / migrate (already bounded; keep).
3. Serve startup output (document-selected JSON descriptor; `--db` path retained).
4. Production `GET /health` (must not return `doctor.database` or counts).
5. `app.doctor()` on the portable HTTP adapter (already uses `storage`).
6. `GET /api/schema` — add `storage: {adapter, available}` for portable and for
   v1 HTTP; never a path. v1 CLI `doctor.database` is unchanged.
7. Public error details (PostgreSQL / malformed storage) — closed `adapter` token,
   never caller locators or credentials. Nested `JSON.stringify` of the whole error.
8. MCP: production static context remains credential-free. Local `--db` `crm_doctor`
   may keep the v1 `database` path. Document-selected local MCP doctor, if it
   composes an app, must project `storage` not path.
9. Project/runtime inspection that opens an app: source-only `app inspect` must
   stay source-only (no database). If a runtime inspect path opens an app, bound it.

Preserve the ratified v1 `--db` disclosure. Do not remove it to make the portable
path look cleaner.

Tests use obvious sentinels (`/tmp/LEAK-SENTINEL-accordo.sqlite`,
`postgresql://m2-user:s3cret-unavailable@localhost:5432/accordo`) and inspect
**complete nested object graphs and output strings**, not only top-level keys.

### M2-34 — health does not read tenant state

Replace `router.add('GET', '/health', async () => app.doctor())` with a bounded
operational health function that does **not** call `app.doctor()`, tenant
services, CRM modules, or business tables.

M2 contract (adapter-independent):

```js
{
  ok: true,
  ready: true,
  storage: { adapter: 'sqlite', available: true },
}
```

Derive `ready` from: application already composed (the listener exists), owned
runtime initialized, storage posture available. Do **not** invent lease-driven
transitions. Do **not** run `SELECT 1` against tenant tables. A connectivity
probe that walks business tables is a regression.

Shared `createHttpServer` serves both v1 and portable HTTP, so one health
implementation covers both. Portable `app.storage` is already `{adapter, available}`.
v1 has no `storage` field today — health must **not** read `app.database.path`.
Either:

- publish a frozen `app.storage` / `app.health()` on both factories, or
- derive `{adapter:'sqlite', available:true}` in the HTTP layer from “the app
  started” without reading locators.

Prefer a small `app.health()` on both factories so the router never inspects
`database`.

Admin metrics:

- New `GET /api/admin/metrics` gated with existing `records.read` via `gate()`.
- When no spine is composed, `gate()` is already a no-op (same as `/api/companies`).
- Counts use Storage Contract `kind: 'count'` (already in the vocabulary), never
  `list({limit:500}).length`.
- Counts (companies, contacts, opportunities, pending approvals, workflow runs,
  audit events) **must not** appear on unauthenticated `/health`.
- Admin `refresh()` loads metrics separately from opportunities/approvals/traces.
  Missing permission → bounded unavailable metrics state; the rest of the dashboard
  still renders. No fallback to doctor/health counts.
- In-process `app.doctor().counts` and `scripts/smoke.js` may keep using doctor
  for local smoke; HTTP `/health` may not.

Do not add a permission. Do not create a public metrics platform.

### M2-05 — raw-driver boundary

Re-inventory production code for:

```
DatabaseSync
database.raw
database?.raw
.raw.prepare(
.raw.exec(
destructured raw aliases
computed raw access where statically detectable
```

Classify every remaining occurrence:

| Class | Meaning |
|---|---|
| `SQLITE_ADAPTER_INTERNAL` | `packages/core/src/database.js` owning the driver |
| `CONTROL_PLANE_ADAPTER_INTERNAL` | only if a control-plane adapter truly owns it |
| `AUTHORITY_PROBE` | not expected in production |
| `CHARACTERIZATION_OR_TEST` | tests, journeys, upgrade fixtures |
| `PROSE_ONLY` | comments/docs |
| `BUSINESS_CONSUMER_BLOCKER` | must migrate before M2 closes |

`core-adapters.js` is a blocker: migrate `findCompaniesByNormalizedName` and
`findContactByEmail` onto `database.storage.sync` exactly as
`createPortableCoreAdapters` already does. Keep the exported
`createCoreAdapters({ database, services, pipelines })` signature so
`tests/core-adapters.test.js` stays valid. Do not hide raw by renaming it.

After migration, add **one** final repository guard scoped to production
business/package/application code (packages + apps, excluding
`packages/core/src/database.js`, tests, examples/journeys, docs, scripts that
are characterization). It must recognise every supported spelling from the
M2C/M2D scan, plus optional chaining, destructuring and aliases already known
to fool earlier greps.

For every supported spelling: plant it into a protected file, run the guard,
observe failure, restore the file.

State blind spots honestly. A token scan is not semantic unreachability.
Pin undetected escapes (`d['r'+'aw']`, `Reflect.get`, computed keys) as
non-claims.

### M2-23 — portable SQLite exit proof

One representative **clean child-process** scenario using the public export
`createAccordoAppAsync()` (not a direct `startPortableSqliteApp` import):

1. Open SQLite through the portable async path.
2. Create and read Company, Contact and Opportunity.
3. Execute one action or operation through a uniform v2 selected graph
   (inline probe package, same pattern as `tests/spine-v2-m2e2-portable-http.test.js`
   `v2HttpSelected`, passed as `selected`).
4. Record and read audit (and trace if the selected path writes one).
5. Close.
6. Restart from the **same file**.
7. Read the persisted records again.
8. Close exactly once (shared close promise).

Also preserve, in the same file or adjacent tests already present:

- `createAccordoApp()` remains synchronous/non-thenable.
- Legacy v1 custom package (partner-scorecard) still works on v1.
- v1 package fails closed on the portable v2 path (`PACKAGE_ASYNC_CONTRACT_REQUIRED`).
- PostgreSQL-shaped options still refuse before connection, no credential in diagnostics.

Do not migrate bundled packages.

### Truth and status (this PR)

Update `docs/PROJECT_STATUS.md` in this implementation PR:

- latest merged M2 implementation (this slice, after merge it is the latest)
- actual public async factory status (`createAccordoAppAsync` exists)
- actual M2E/M2F boundaries
- remaining PostgreSQL absence
- dual bundled graph disposition (later compatibility, not completed)
- current measurement remains stale until the measurement PR
- open PR #134 remains unrelated

Regenerate Repository Truth through `npm run repo:truth`. Do not type test
counts into PROJECT_STATUS. No JTBD coverage promotion. No “production ready”.

Explicitly retain: PostgreSQL absent, M4 reliability absent, Spine v3 jobs
absent, Spine v4 secrets/backups/observability absent, Cloud absent.

Correct stale TASKS lines 13–15 that still say “M2E-3 owns dual bundled graphs”.
Correct LEGACY_ALIGNMENT_MATRIX M2E-2C rows that still assign dual definitions
to M2E-3. Name the later compatibility slice. Do not call it done.

Add a checked TASKS entry for this final M2 posture/health/raw-boundary slice.

ADR: short addendum on the existing Spine v2 / ADR-018 series recording health
independence from tenant data, bounded public storage posture, and the dual-graph
disposition.

## Approaches considered

**A — Documentation-only closeout.** Rejected. M2-08 and M2-34 are still
executable and owned. The campaign forbids a docs-only closeout.

**B — Migrate every bundled package to dual v1/v2 graphs in this PR.** Rejected
as not required for M2-23 (see classification). It would also move default
serve, which M2-09 keeps on the characterized SQLite path until PostgreSQL
selection exists.

**C — One causal PR for M2-08, M2-34, M2-05 and M2-23 (chosen).** They converge
on one boundary: public operational surfaces expose bounded posture, health
does not inspect tenant data, raw SQLite stays adapter-private, and the
portable factory is the SQLite exit proof.

## DX Simplicity Gate

- **Failure prevented:** an operator or agent treats `GET /health` or `/api/schema`
  as a locator/credential surface, or treats `core-adapters.js` as “adapter
  internal” because of its path, or calls M2 complete while dual bundled graphs
  are silently deferred without a named owner.
- **Existing primitive insufficient:** `app.doctor()` mixes liveness, locators
  and tenant counts. `describeDeploymentStorage()` already exists and must be
  reused, not forked.
- **Overlap bound:** v1 `--db` path disclosure stays; portable/document-selected
  never gains it. Health is not Admin metrics. Metrics are not a platform.
- **Portable evidence:** nested leak walks, call/query counters, plant-and-restore
  guard, child-process restart.
- **Simpler goal flow:** one unauthenticated `/health`, one authenticated
  metrics read, one portable factory, one raw-driver guard.

## Milestones

### 1. Plan and classification (this file)

- [x] Record M2_BLOCKER / M3_PREREQUISITE / LATER_COMPATIBILITY_WORK with reasons.

### 2. Public posture + health (Worker A)

- [x] Bounded `GET /health` independent of `doctor` / tenant services / business tables.
- [x] Authenticated `GET /api/admin/metrics` via `records.read` and `kind: 'count'`.
- [x] Admin dashboard: metrics unavailable without authorization; rest still renders;
      authorized behaviour preserved.
- [x] `/api/schema` storage projection; nested leak walks on doctor/serve/facade/schema/errors/MCP.
- [x] Tests in `tests/spine-v2-m2-final-posture.test.js` (or split health file if clearer).

### 3. Raw-driver guard + portable exit proof (Worker B)

- [x] Migrate `createCoreAdapters` off `database.raw`.
- [x] Inventory remaining production spellings; classify; document in this plan.
- [x] Final production business/package/application guard with plant-and-restore.
- [x] Child-process `createAccordoAppAsync()` restart scenario.
- [x] Tests in `tests/spine-v2-m2-final-raw-boundary.test.js` and
      `tests/spine-v2-m2-final-portable-exit.test.js`.

### 4. Status, TASKS, matrix, ADR, Repository Truth (Lead, same PR)

- [x] PROJECT_STATUS, TASKS, LEGACY_ALIGNMENT_MATRIX, DECISIONS addendum.
- [x] `npm run repo:truth` (generated; never hand-typed counts).

## Validation

Use Node **22.16.0** (`.nvmrc`). Do not use `using` / explicit resource
management; use `workspaceFor(t)` / `t.after`.

```text
node --test tests/spine-v2-m2f-entry-wiring.test.js
node --test tests/spine-v2-m2f-deployment-storage.test.js
node --test tests/spine-v2-m2f-verifier-preconnect.test.js
node --test tests/spine-v2-m2e3-public-async-factory.test.js
node --test tests/spine-v2-m2e2-portable-http.test.js
node --test tests/spine-v2-m2-final-posture.test.js
node --test tests/spine-v2-m2-final-raw-boundary.test.js
node --test tests/spine-v2-m2-final-portable-exit.test.js
node --test tests/core-adapters.test.js
npm run check
npm run surface:check
npm run repo:truth
npm run repo:truth -- --check
npm run gtm:check
npm run site:check
npm run smoke
git diff --check
npm run verify
```

Do not copy measurement numbers from the failed local macOS run
(`/var` vs `/private/var`, shell-classifier flake). Do not change production
code to silence a platform-specific test issue. Test-only harness fixes are
allowed only when the old test is demonstrably platform-fragile and the
assertion is not weakened.

## Out of scope

- PostgreSQL adapter, live TLS, control-plane bootstrap (M3)
- Lease/generation/resource-identity readiness (M4)
- Dual bundled package graphs
- Default `accordo serve` migration to the async factory
- Deleting the v1 compatibility factory
- PR #134
- Measurement / `site/claims.json` numbers
- JTBD promotions
- “Production ready”

## Raw-driver remaining locations

Worker B inventory after migrating `createCoreAdapters` onto
`database.storage.sync`. Classes are exactly the M2-05 set. The production
guard walks `packages/` + `apps/` JavaScript, strips comments, and allowlists
only `packages/core/src/database.js`. A token scan is not semantic
unreachability.

### Production (`packages/`, `apps/`)

| Location | Class | Reason |
|---|---|---|
| `packages/core/src/database.js` | `SQLITE_ADAPTER_INTERNAL` | Owns `import { DatabaseSync }`, `new DatabaseSync`, the `raw` closure, PRAGMAs and the v1 compatibility handle. The only production-source allowlist entry. Control-plane files use this same factory (`plane: 'control'`); there is no separate control-plane driver. |
| `packages/core/src/storage-contract.js` `createSqliteStorage(raw, …)` | `SQLITE_ADAPTER_INTERNAL` | Receives the driver handle from `database.js` and calls `raw.prepare` / `raw.exec` inside the SQLite adapter. The M2C/M2D token set does not match a parameter named `raw` (no `database.raw`, no `.raw.prepare(`). Adapter-internal, not a business consumer. |
| `packages/core/src/core-adapters.js` | *(none)* | Migrated. `findCompaniesByNormalizedName` / `findContactByEmail` use `database.storage.sync.many` / `maybeOne`. Zero raw spellings. Signature remains `createCoreAdapters({ database, services, pipelines })`. |
| `packages/app/src/create-app.js` | *(none)* | Calls `createCoreAdapters({ database, services, pipelines })`. No `database.raw` spelling. v1 still returns `app.database` (compatibility surface, characterized v1). |
| `packages/app/src/portable-app.js` | *(none)* | `createPortableCoreAdapters` already used `storage.sync`. Comment updated so it no longer names the old raw reach. |
| `packages/core/index.js` | `PROSE_ONLY` | Historical M2D comment that `database.raw` used to carry `isTransaction`. Comment-stripped scan does not fail. |
| `apps/**` | *(none)* | No `DatabaseSync`, `database.raw`, `.raw.prepare(`, `.raw.exec(`, or destructured-raw assignment. |
| `api/mcp.js` | *(none)* | Outside the guard's `packages/`+`apps/` walk; no driver spelling. |

No remaining `BUSINESS_CONSUMER_BLOCKER`. No `CONTROL_PLANE_ADAPTER_INTERNAL` file distinct from `database.js`.

v1 `createAccordoApp().database.raw` remains the compatibility handle on the
synchronous factory. That is characterized v1, not a new leak, and is not
removed. The guard is about production business/package/application *source*
not reaching the driver. Public `createAccordoAppAsync()` still exposes no
`database` / `raw` field.

### Scripts

| Location | Class | Reason |
|---|---|---|
| `scripts/repo-truth.js` | `AUTHORITY_PROBE` | Opens `new DatabaseSync(':memory:')` to probe Company storage-contract rendering for repository truth. Maintenance script, not production runtime. Outside the guard. |

### Characterization / tests / journeys (not production)

| Location | Class | Reason |
|---|---|---|
| `tests/**` (many files, including v1 e2e, M2C/M2D guards, upgrade fixtures) | `CHARACTERIZATION_OR_TEST` | Tests may read `app.database.raw` on the v1 handle. Not migrated. |
| `examples/journeys/customer-identity-governance/journey.mjs` | `CHARACTERIZATION_OR_TEST` | `new DatabaseSync(dbPath, { readOnly: true })` for a journey assertion. |
| `examples/journeys/tenant-isolation-and-authorization/journey.mjs` | `CHARACTERIZATION_OR_TEST` | `tenantA.database.raw.prepare(...)` to prove the tenant cannot see control tables. |

### Guard scope, allowlist, blind spots

- Scope: `packages/` and `apps/` production `.js`, excluding `node_modules`,
  `tests/`, dot-directories. Comments stripped before matching.
- Allowlist: `packages/core/src/database.js` only.
- Plant-and-restore: every M2C/M2D spelling is written into
  `packages/core/src/core-adapters.js`, the walk is watched failing, the file
  is restored.
- Blind spots (pinned tests, not claims): `d['r'+'aw']`, `handle[key]` with
  `key = "raw"`, `Reflect.get(database, "ra"+"w")`. Local adapter parameter
  `raw.prepare` in `storage-contract.js` is also outside the token set.

## Progress log

- **2026-08-29:** Live baseline `5368211`. Open PR only #134 (untouched).
  Stale measurement `27cc663` / 1685 / 140. Classified M2-05, M2-08, M2-23,
  M2-34 as M2_BLOCKER; dual bundled graphs and default serve as
  LATER_COMPATIBILITY_WORK; lease health as M4; PostgreSQL as M3.
- **2026-08-29 (Worker B):** M2-05 migrated `createCoreAdapters` onto
  `database.storage.sync`. Remaining production driver ownership is
  `packages/core/src/database.js` (plus adapter-internal `createSqliteStorage`).
  Guard: `tests/spine-v2-m2-final-raw-boundary.test.js`. M2-23 portable SQLite
  exit: `tests/spine-v2-m2-final-portable-exit.test.js` (public
  `createAccordoAppAsync`, real file, restart, close-once). No PostgreSQL / M3,
  no dual bundled graphs, no default-serve change.
- **2026-08-29 (adversarial review):** `GET /health` still ran shared
  `requestIdentity`. In local-development spine mode with Admin `x-actor-type:
  user` headers that read memberships, inserted a membership, and wrote
  `audit_events` / audit intents. Existing query-counter tests were false-green:
  no spine, system actor, data-plane `raw.prepare` only (`storage.sync` is
  frozen). HTTP now skips identity on `GET /health`.
  `LEGACY_ALIGNMENT_MATRIX` still claimed `core-adapters.js` prepared against
  `database.raw`; corrected, with a Compatibility Backfill section for this
  slice. The partner-scorecard v1 test now registers the package on a v1
  `PackageRegistry` rather than booting a vanilla app.

## Decision log

- **One causal PR.** Posture, health, raw privacy and the portable exit proof
  are one public-boundary milestone.
- **Dual graphs are later compatibility work, named, not completed.** M2-23
  does not require migrating every bundled package. M2E-3 already deferred
  them; stale “M2E-3 owns dual graphs” sentences are documentation defects.
- **Reuse `describeDeploymentStorage` and `kind: 'count'`.** No second
  descriptor shape and no new SQL vocabulary.
- **Health is not doctor.** Doctor remains a CLI/in-process diagnostic,
  including v1 path disclosure on `--db`.
- **Metrics reuse `records.read`.** No new permission, no public platform.
- **Token scan is a token scan.** Blind spots are tests, not comments.

## Outcome and follow-up

M2 public operational surfaces expose `{adapter, available}` only.
`GET /health` is process/runtime/storage-posture liveness, not doctor and not
tenant metrics. `createCoreAdapters` no longer reaches `database.raw`. A
representative public `createAccordoAppAsync()` child process proves portable
SQLite persist/restart. Dual bundled graphs remain later compatibility work.

Follow-up, not this PR:

- Exact GitHub-hosted measurement of post-merge main
  (`claude/post-m2-complete-exact-measurement`)
- Dual bundled v1/v2 package graphs (later compatibility)
- Default `accordo serve` on the async factory (after dual graphs)
- M3 PostgreSQL adapter + conformance
