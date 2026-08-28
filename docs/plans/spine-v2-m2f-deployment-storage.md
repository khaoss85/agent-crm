# Production Spine v2 M2F — deployment-storage loader

This ExecPlan follows `.agent/PLANS.md`. It owns one causal M2F slice:

- **M2-17** one shared versioned deployment-storage configuration loader
- **M2-21** the DX Simplicity Gate for that surface
- **parser-side M2-18** TLS fields on the closed envelope, and the settings a
  parser can refuse without talking to a TLS endpoint
- **M2-20** config-file no-follow ownership and mode discipline

It does **not** own: live PostgreSQL (M3), TLS against real endpoints (M2-19 /
G15), identityVerifier ESM resolution (M2-22), CLI/serve/MCP production
wiring, `db:migrate` PostgreSQL classification (M2-11 / M2-32), production MCP
static-context (M2-16), or replacing every public surface's storage locators
(the remainder of M2-08).

## Goal and user-visible outcome

One function turns operator input into a closed storage selection, or refuses
with a stable code, before any database connection exists. Factory, CLI and MCP
will later call this function rather than inventing flags; this PR ships the
loader, its tests and the docs, not those call sites.

An operator-visible outcome in this slice is therefore narrow: a versioned
parser exists, SQLite `--db` remains a compatibility input to that parser, a
PostgreSQL document is refused with one adapter code, and a trusted-file
failure is refused with one pre-parse code. No executable grows a new flag.
No credential, path or file byte appears in a diagnostic.

## Current repository context

Surveyed at `cafd15c` (merged PR #141). Counted rather than recalled.

| Surface | What it does today |
|---|---|
| `packages/app/src/create-app.js` | `createAccordoApp({ dbPath })` opens SQLite. Spine composition refuses an explicit `dbPath` beside a tenant binding (`SPINE_DATA_PLANE_PATH_NOT_CONFIGURABLE`). |
| `packages/cli/src/commands.js:83` | `flags.db` is resolved to a filesystem path and passed through. Help text documents `--db` on serve/seed/demo/doctor/`db:migrate`/workflow/trace/mcp. |
| `packages/mcp/src/stdio.js` | `startMcpStdio({ dbPath })` constructs the app with that path. |
| PostgreSQL driver | absent. `package.json` has no production dependency. <!-- truth: spine.postgresql.implemented=absent --> |
| Deployment-storage module | does not exist. Zero `loadDeploymentStorage` / `DEPLOYMENT_STORAGE_` hits in `packages/`. |

`--db` is SQLite filesystem-path syntax, not an adapter selector. A
PostgreSQL-shaped value in `--db` is the unsupported legacy hazard M0 already
characterized; this slice must not turn it into PostgreSQL support.

## Approaches compared

QUALITY_GATES §1.1 requires three, and a reason the winner wins.

**A — Independent flags per executable.** `--adapter`, `--pg-url`, MCP env,
factory options, invented separately. Rejected: this is the failure M2-17
names. Three parsers will disagree on precedence, and one of them will print a
credential.

**B — One shared versioned loader over a closed JSON envelope (chosen).** The
ratified contract: a permission-restricted document with `{contract, adapter,
connection, controlPlane, spine, identityVerifier}`, extra keys refuse, `--db`
stays SQLite-only and is mutually exclusive with the document. TLS is a parser
field. File open is no-follow / owner-only. PostgreSQL selection refuses
before a connection. Factory/CLI/MCP are later consumers of the same function.

**C — Environment-only 12-factor URLs** (`DATABASE_URL`). Rejected: a URL
carries credentials, cannot encode a spine binding, and cannot prove
ownership/mode/no-follow against a string. `--db` cannot safely carry that
structure either, which is the DX-gate reason the existing primitive is
insufficient.

B wins because it is the ratified contract, it is the only option that keeps
one parser for every future executable, and it can be proved without a
PostgreSQL driver.

## The DX Simplicity Gate (M2-21)

Answered here so the PR body can cite the plan rather than invent a second copy.

- **Failure prevented:** three executables invent different adapter/tenant
  selection and accidentally boot PostgreSQL unbound, or print a credential.
- **Existing primitive insufficient:** `--db` is a public SQLite path. It cannot
  carry a structured spine binding, a control-plane connection, TLS, or a
  verifier reference without becoming a secret-bearing flag.
- **Overlap bound:** one loader selects deployment storage. `--db` is retained
  only as SQLite compatibility and is a refusal when combined with the
  document. No `--adapter`, no `--pg-url`, no MCP-specific env dialect.
- **Deferred unless every session needs it:** the loader is an internal
  function in this PR. No new agent-facing command, rail, skill or kernel
  export. Call sites wait until a later M2F PR can consume it without expanding
  this failure boundary.
- **Portable evidence:** a versioned closed-schema parser
  (`DEPLOYMENT_STORAGE_CONTRACT = 1`) plus a test matrix of identical
  selection, precedence and stable refusal codes, with sentinel credentials
  absent from diagnostics.
- **Simpler goal flow:** an operator will eventually supply one configuration
  path to any executable. This PR does not add that flag; it makes the later
  flag safe to add. Adding the flag here would grow perceived surface before
  the consumers exist.
- **Horizontal capability:** recorded in
  `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`. Domains do not select
  adapters; every domain row is `not_applicable`.
- **Not on the domain-package kernel.** `packages/core/index.js` stays
  unchanged. Domain packages do not load deployment storage. CLI/factory/MCP
  already import `packages/core/src/*` for runtime internals.

Intended later flag/env names, recorded so a follow-up does not reinvent them:
explicit path argument `configPath` (CLI `--deployment-storage` when wired),
environment `ACCORDO_DEPLOYMENT_STORAGE`. Explicit path wins over the env var.
There is no precedence between the document and `--db`: that pair is a refusal.

## Closed envelope

Exact top-level keys, all required in a document, extra keys refuse:

```text
{ contract, adapter, connection, controlPlane, spine, identityVerifier }
```

| Field | Parse rule in this slice |
|---|---|
| `contract` | integer `1` (`DEPLOYMENT_STORAGE_CONTRACT`). Any other value is `DEPLOYMENT_STORAGE_CONTRACT_UNSUPPORTED`. |
| `adapter` | exact `sqlite` or `postgresql`. Anything else is `DEPLOYMENT_STORAGE_ENVELOPE_INVALID`. |
| `connection` | adapter-owned closed object. Never copied onto `describeDeploymentStorage()`. |
| `controlPlane` | same closed-object rule as `connection`. |
| `spine` | closed `{ mode, tenant }`. `mode` is `local-development` \| `production`. `tenant` is a plain object with own `id`. This parser does not call `resolveTenantBinding` and does not open tenant files. |
| `identityVerifier` | opaque relative path string. Not imported, not realpath'd, not executed (M2-22). Absolute, empty, non-string, NUL, or inline code/object refuse as envelope-invalid. |

SQLite `connection` / `controlPlane` closed keys: `{ path }` (non-empty string).
TLS keys on a SQLite object are extra keys, not TLS refusals.

PostgreSQL `connection` / `controlPlane` closed keys:
`{ host, port, database, user, password, sslmode, tls }`.
Required: `host`, `database`, `user`, `password`, `tls`. `port` if present is
an integer `1..65535`. `sslmode` if present must be exactly `verify-full`;
`disable`, `allow` and `prefer` refuse as TLS. `require` and `verify-ca` are
verification-disabled relative to the production rule and also refuse.

PostgreSQL `tls` closed keys: `{ enabled, verify, caFile, servername, rejectUnauthorized }`.
Production requires `enabled === true`, `verify === "full"`, and `caFile` a
non-empty string naming a deployment trust source (a path, not embedded PEM).
`servername` if present is a non-empty string. `rejectUnauthorized === false`
is verification-disabled. Missing `tls`, `enabled !== true`, or missing/`none`
verify is missing production TLS / plaintext / verification-disabled.

No permissive production TLS default. A loopback-only exception is test-harness
state and cannot appear in a deployment document.

## Refusal matrix

Every code is stable. Messages and `details` contain neither a filesystem path,
nor file bytes, nor credentials, nor the offending configured value.

| Input | Code | When |
|---|---|---|
| symlink; not a regular file; ownership mismatch; any group/other mode bit (`0640`/`0644`); missing/unreadable; `O_NOFOLLOW` unavailable; process uid unprovable; post-open ino/dev/uid/mode/size change; file larger than 16 KiB | `DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED` | **before parse** |
| extra/missing envelope keys; prototype / `__proto__` / `constructor` / `prototype`; not JSON; unknown adapter; malformed field; inline verifier code | `DEPLOYMENT_STORAGE_ENVELOPE_INVALID` | after a trusted read |
| `contract !== 1` | `DEPLOYMENT_STORAGE_CONTRACT_UNSUPPORTED` | after a trusted read |
| plaintext; `sslmode=disable\|allow\|prefer`; verification-disabled; missing production TLS | `DEPLOYMENT_STORAGE_TLS_REFUSED` | parser, no socket |
| `adapter: "postgresql"` after a valid TLS parse | `DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED` | **before any connection** |
| config path (explicit or env) together with `dbPath` | `DEPLOYMENT_STORAGE_DB_CONFLICT` | before open/stat |
| neither document nor `dbPath` | `DEPLOYMENT_STORAGE_SOURCE_REQUIRED` | before open/stat |

PostgreSQL is refused even when TLS is valid. M3 owns the driver. A hang-on-
connect host in a fixture must still return the adapter code synchronously.

`--db` alone selects SQLite without reading a document. `:memory:` is a valid
SQLite compatibility path and opens no config file.

## Bounded descriptor (partial M2-08)

`describeDeploymentStorage(selection)` returns a frozen `{ adapter, available }`
with those two keys only.

- SQLite selection: `{ adapter: "sqlite", available: true }`
- A postgresql *shape* (for later surfaces): `{ adapter: "postgresql", available: false }`

Replacing `app.database`, `app.tenantBinding`, `app.doctor()`, serve, CLI JSON
and `/api/schema` locators is **not this PR**. That remainder of M2-08 needs
those surfaces as consumers and would expand this failure boundary. Follow-up
PR, named in Outcome.

## Explicitly out of scope

- No `pg` / `postgres` dependency, import, or socket.
- No identityVerifier `import()`, realpath, deadline or hanging-module fixture
  (M2-22).
- No `--deployment-storage` CLI flag, help-text flag, MCP option or
  `createAccordoApp` option. A structural test proves `create-app.js`,
  `commands.js` and `mcp/src/stdio.js` do not import the loader.
- No change to the characterised synchronous SQLite factory.
- No measurement, no `site/claims.json` edit, no PROJECT_STATUS "latest merged
  milestone" rewrite (integrator-owned at merge).

## ADR-018 justification

This is a reusable runtime capability: every executable will select storage the
same way. It is not domain-specific business behaviour. It lives in
`packages/core/src/deployment-storage.js` and is **not** added to
`packages/core/index.js`, because a domain package has no reason to import it.

## Milestones

Each leaves the repository runnable (`npm test -- tests/spine-v2-m2f-deployment-storage.test.js` green by the end of M2; full `npm run verify` at the end).

1. **ExecPlan (this file) and failing tests.** The test file is the contract.
   Against `cafd15c` it must fail to import `deployment-storage.js`.
2. **Loader + closed envelope + SQLite `--db` compatibility + dual-source
   refusal.** No file discipline or TLS yet beyond "postgresql throws".
3. **No-follow open/stat (M2-20) and TLS parser refusals (M2-18).** One
   pre-parse code; parser-only TLS; PostgreSQL still refused before connect.
4. **Descriptor helper, structural no-wiring guard, docs, ADR amendment,
   alignment matrix, TASKS.**
5. **`npm run verify`.** No measurement.

## Validation

```text
node --test tests/spine-v2-m2f-deployment-storage.test.js
npm run verify
npm run repo:truth -- --check
```

Expected: the new tests pass; `createAccordoApp({ dbPath: ':memory:' })` still
boots; no PostgreSQL dependency; `repo:truth --check` stays green because this
PR cites no new bound-surface claim and adds no authority source.

## Progress log

- [x] Survey `cafd15c` createAccordoApp / CLI / MCP `--db` path and confirm no loader exists.
- [x] Write this ExecPlan before code.
- [x] Failing tests for the refusal matrix, file discipline, TLS parser, descriptor, no-wiring, no-driver.
- [x] Implement `packages/core/src/deployment-storage.js`.
- [x] Docs: ADR-038 Amendment 5, alignment matrix, TASKS.
- [x] `npm run check`, slice tests, `npm run smoke`, and `npm run repo:truth -- --check`. Full `npm test` on this macOS host reproduces two failures that already exist on the merged M2F tree (`/var/folders` vs `/private/var/folders` in the M0 `--db` characterization; shell-classifier `guardedWrites` oracle). Neither file is in this slice.

## Decision log

1. **Loader, not call sites.** Wiring CLI/serve/MCP in the same PR would make
   a parser defect a production boot defect. The plan's "used by factory, CLI
   and MCP" is the consumer contract; this slice publishes the callee.
2. **One pre-parse code, not one per filesystem failure.** The ratified text
   says one stable pre-parse code. Splitting missing/symlink/mode/owner teaches
   callers to branch on the thing we are hiding (the path).
3. **TLS refuse before adapter refuse.** A valid-TLS PostgreSQL document still
   throws `DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED`. A bad-TLS document
   throws `DEPLOYMENT_STORAGE_TLS_REFUSED` so M2-18 cannot go green uncounted
   behind the adapter refusal.
4. **`identityVerifier` is an opaque relative path.** Parsing it is required to
   close the envelope. Resolving/importing it is M2-22.
5. **Partial M2-08.** The descriptor helper is a small additive surface. Public
   locator replacement is a follow-up.
6. **Optional `expectedUid` on the loader** is a test seam for ownership
   mismatch on a machine that cannot `chown`. Production callers omit it and
   the process uid is used. Documented so it is not mistaken for a deployment
   override.

## Outcome and follow-up

Shipped: one versioned loader, closed envelope, SQLite `--db` compatibility,
dual-source refusal, no-follow file discipline, TLS parser refusals,
PostgreSQL-before-connect refusal, `{ adapter, available }` helper.

Follow-up PRs, not this one:

- Wire `configPath` / `ACCORDO_DEPLOYMENT_STORAGE` into CLI/serve/MCP and
  refuse inline credential argv (remainder of M2-17 consumers; M2-11, M2-32).
- identityVerifier ESM resolution, deadline, hanging fixture (M2-22).
- Replace locators on every public surface with the descriptor (remainder of
  M2-08).
- Live PostgreSQL adapter and real TLS endpoints (M3 / M2-19).
