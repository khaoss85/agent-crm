# Production Spine v2 M2F — CLI/serve/MCP entry wiring

This ExecPlan follows `.agent/PLANS.md`. It owns one causal M2F slice:

- **remainder of M2-17** wire the shared loader into CLI, serve and MCP
- **M2-11** `db:migrate` refuses PostgreSQL; SQLite compatibility is unchanged
- **M2-32** CLI PostgreSQL classification contract, refusal rows and SQLite coverage
- **M2-16** production MCP stdio stays static-context-only and source-only

It does **not** own: live PostgreSQL (M3), TLS against real endpoints (M2-19 /
G15), live discover/attest (M2-13), `GET /health` readiness (M2-34), replacing
every public locator on `app.doctor()` / `/api/schema` (the remainder of
M2-08), or turning a deployment document into a full ADR-038 spine binding
(`storageRoot` / control-plane files).

Branched from `origin/main` `de12e3d` (PR #145). Does not touch PR #134.

## Goal and user-visible outcome

Every application executable selects storage through
`prepareDeploymentPreconnect`. No executable invents `--adapter`, `--pg-url`
or a second envelope parser.

- Explicit `--deployment-storage` (and env `ACCORDO_DEPLOYMENT_STORAGE`) is the
  document path. `--db` stays SQLite-only. Supplying both refuses
  `DEPLOYMENT_STORAGE_DB_CONFLICT` before a connection.
- A PostgreSQL document refuses `DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED`
  before a connection, a listener, or composition.
- When the document names an `identityVerifier`, that contract passes before
  any database handle or listener exists.
- M2-owned public output for a document-selected run is
  `{ adapter, available }` only. SQLite `--db` path disclosure stays where M0
  already ratified it (`Database: …`, `doctor.database`, `db:migrate.database`).
- Production MCP (`ACCORDO_MODE=production`) does not load the document,
  compose the application, connect or migrate. Data-bearing tools, traces,
  doctor, prompts that can reveal runtime data, and scaffolding refuse
  `MCP_PRODUCTION_SURFACE_UNAVAILABLE`. Local `--db` MCP is unchanged.

## Current repository context

Surveyed at `de12e3d` (origin/main, includes #144 and #145).

| Surface | What it does today |
|---|---|
| `prepareDeploymentPreconnect` | Loads the closed document and resolves the verifier. Unwired. |
| `packages/cli/src/commands.js` | Local `APP_COMMANDS` Set. `flags.db` → `createAccordoApp({ dbPath })`. Serve prints `Database: ${app.database.path}`. |
| `packages/mcp/src/stdio.js` | `createAccordoApp({ dbPath })` then JSON-RPC. Direct bin uses `CRM_DB_PATH` / `./data/accordo.sqlite`. |
| `createAccordoApp` | Still a function-shaped `spine.identityVerifier`. Does not import the loader. |
| PostgreSQL driver | absent. <!-- truth: spine.postgresql.implemented=absent --> |

## Approaches compared

QUALITY_GATES §1.1 requires three, and a reason the winner wins.

**A — Each executable grows its own flags.** `--adapter`, `--pg-url`, MCP-only
env. Rejected: this is the failure M2-17 names.

**B — Shared `prepareDeploymentPreconnect` at every application entry (chosen).**
CLI maps `--deployment-storage` / `--db` onto the loader options. MCP stdio
uses the same function and the documented env path. Production MCP is a
classification of that entry, not a second parser: `ACCORDO_MODE=production`
skips the loader and serves static checked source. PostgreSQL classification
is an exported map over canonical `APP_COMMANDS`; at M2 the loader refusal
fires first.

**C — Compose a full spine binding from the document in this PR.** Rejected:
the envelope `spine.tenant` is `{ id }` only. `resolveTenantBinding` still
requires `storageRoot`. Inventing a root from `connection.path` would be a
second answer to "where does this tenant's data live" and expands M2-08 /
ADR-038 into this wiring slice. SQLite documents therefore select
`connection.path` as the historical combined `--db` path after the verifier
passes; spine composition stays the existing factory option.

B wins because it is the recorded follow-up of #144/#145, it keeps one parser,
and it can be proved without a PostgreSQL driver.

## The DX Simplicity Gate (entry surface)

- **Failure prevented:** serve, CLI and MCP invent different adapter selection
  and one of them prints a credential or listens before the verifier passes.
- **Existing primitive insufficient:** `--db` is a public SQLite path. The
  loader exists and is unwired; wiring is what makes the recorded flag safe.
- **Overlap bound:** one flag `--deployment-storage`, one env
  `ACCORDO_DEPLOYMENT_STORAGE`, `--db` SQLite-only, mutually exclusive with
  the document. No `--adapter`, no `--pg-url`.
- **Deferred unless every session needs it:** not a new rail or skill. The
  flag was named in the loader plan and withheld until consumers existed.
- **Portable evidence:** exported `APP_COMMANDS` plus a child-process matrix
  of identical selection, precedence and stable refusal codes.
- **Simpler goal flow:** one configuration path to any application executable.
- **Horizontal capability:** domains still do not select adapters; every
  domain row stays `not_applicable`.
- **Not on the domain-package kernel.** `packages/core/index.js` unchanged.

## Entry-point matrix

Canonical authority: `APP_COMMANDS` exported from `packages/cli/src/commands.js`.

| Command | Classification | M2 behaviour |
|---|---|---|
| `serve` | `READ_ONLY_SUPPORTED` on PostgreSQL once an adapter exists | Loader refuses PostgreSQL first. SQLite `--db` and SQLite documents listen only after preconnect. Document-selected stdout uses `{ adapter, available }`, not a path. |
| `db:migrate` | `STABLE_REFUSAL_ON_POSTGRESQL` (`CLI_VERIFIED_OPERATOR_REQUIRED` when an adapter could run) | PostgreSQL document refuses at the loader. SQLite `--db` unchanged. Document-selected JSON omits `database` and carries `storage`. |
| `seed` | `STABLE_REFUSAL_ON_POSTGRESQL` | Same loader refusal. SQLite `--db` unchanged. |
| `demo` | `STABLE_REFUSAL_ON_POSTGRESQL` | Same. |
| `doctor` | `STABLE_REFUSAL_ON_POSTGRESQL` | Same. Source-only `project doctor` is `NOT_APPLICATION_BOUND`. |
| `workflow:list` | `STABLE_REFUSAL_ON_POSTGRESQL` | Same. |
| `trace:list` | `STABLE_REFUSAL_ON_POSTGRESQL` | Same. |
| MCP stdio | production: static-context-only; local `--db`: compose | `ACCORDO_MODE=production` does not load the document. Local default / `--db` still composes. |
| non-application commands | `NOT_APPLICATION_BOUND` | Do not call the loader. `--deployment-storage` on `help` / `app inspect` / `project doctor` is ignored. |

Child-process coverage enumerates live `APP_COMMANDS` and fails if an
unclassified command appears. It runs every application command on SQLite
`--db` (M0 already freezes seed/demo/serve; this slice re-runs the cheap
commands and serve readiness). It runs every declared PostgreSQL document
refusal. It does not talk to a live PostgreSQL service.

## Bounded descriptor (M2-owned surfaces)

`describeDeploymentStorage(selection)` remains `{ adapter, available }`.

On a document- or env-selected run, CLI JSON and serve stdout publish that
object and do not publish `connection.path`, host, user, password, TLS, the
verifier path, or the config path. `--db` keeps the ratified SQLite v1 path
fields.

`createAccordoApp().doctor().database` is unchanged. Replacing it is the
remainder of M2-08.

## Production MCP

When `ACCORDO_MODE=production`:

- do not call `prepareDeploymentPreconnect` / `loadDeploymentStorage`
- do not call `createAccordoApp`
- allowlisted resources: checked source `crm://project/architecture` and
  `crm://project/jtbd`
- `tools/list` and `prompts/list` are empty
- every `tools/call`, `prompts/get`, and non-allowlisted `resources/read`
  returns `MCP_PRODUCTION_SURFACE_UNAVAILABLE`

A FIFO at `ACCORDO_DEPLOYMENT_STORAGE` must not hang production MCP, because
the loader is not entered.

## Explicitly out of scope

- No `pg` / `postgres` dependency, import, or socket.
- No `GET /health` change (M2-34).
- No public `createAccordoApp` option for the document.
- No measurement, no `site/claims.json`, no PROJECT_STATUS rewrite.
- No live PostgreSQL. No business-raw rewrite in this slice: inventory only.

## ADR-018 justification

Wiring is a reusable runtime capability: every application executable must
select storage the same way. It is not domain-specific business behaviour.
The loader and resolver stay off `packages/core/index.js`.

## Milestones

1. **ExecPlan (this file) and failing tests** for the entry matrix, descriptor,
   production MCP, no invented flags, credential-free diagnostics, FIFO still
   refuses.
2. **Export `APP_COMMANDS` and the PostgreSQL classification map.** Wire CLI
   application commands and `accordo mcp` through `prepareDeploymentPreconnect`.
3. **Serve listen-after-preconnect. Production MCP static surface.**
4. **Docs: ADR-038 Amendment 7, alignment matrix, TASKS, raw-driver inventory.**
5. **Slice tests, `npm run check`, `npm run smoke`, `npm run repo:truth -- --check`.**
   No measurement.

## Validation

```text
node --test tests/spine-v2-m2f-deployment-storage.test.js tests/spine-v2-m2f-verifier-preconnect.test.js tests/spine-v2-m2f-entry-wiring.test.js
npm run verify
npm run repo:truth -- --check
```

Expected: new tests pass; FIFO tests still pass; `accordo doctor --db` still
prints a SQLite path; a PostgreSQL document never creates a listener or a
SQLite file; production MCP with a FIFO config env still answers initialize.

## Progress log

- [x] Survey `de12e3d` APP_COMMANDS, MCP stdio, loader and verifier pre-connect.
- [x] Write this ExecPlan before code.
- [x] Failing tests for the entry matrix.
- [x] Wire CLI/serve/MCP.
- [x] Docs: ADR-038 Amendment 7, alignment matrix, TASKS, raw inventory.
- [x] Slice tests (50/50), `npm run check`, `npm run smoke`, `npm run repo:truth -- --check`. FIFO tests still pass. No measurement. The host still reproduces the pre-existing M0 `/var/folders` vs `/private/var/folders` path assertion; that file is not in this slice.

## Decision log

1. **`--deployment-storage` is the ratified flag name.** Named in the loader
   plan and withheld until consumers existed.
2. **Production MCP skips the loader** when `ACCORDO_MODE=production`, so a
   FIFO or a credential document cannot hang or leak through that entry.
3. **SQLite documents use `connection.path` as the historical combined db
   path** after preconnect. They do not invent a `storageRoot`.
4. **PostgreSQL classification is exported now; the loader refusal fires
   first.** `CLI_VERIFIED_OPERATOR_REQUIRED` is the M3-facing row, not a
   second parser.
5. **Factory stays unwired.** `createAccordoApp` does not import the loader.
6. **Raw-driver inventory is in this PR; the rewrite is not.** Production
   `database.raw` remains in `core-adapters.js` (adapter-internal) and
   `DatabaseSync` remains in `database.js`. Tests still reach `.raw`; that is
   not a business consumer.

## Outcome and follow-up

Shipped: one flag, one env, one loader at every application entry; PostgreSQL
documents refuse before connect; production MCP is static and credential-free;
M2-owned output is `{ adapter, available }`.

Follow-up, not this PR:

- Remainder of M2-08: replace `app.doctor().database` and `/api/schema` locators.
- M2-34 health/readiness.
- Live PostgreSQL adapter, TLS endpoints, discover/attest, and executing
  `CLI_VERIFIED_OPERATOR_REQUIRED` after the loader can return postgresql (M3).
- Move `core-adapters.js` normalized reads off `database.raw` if a later
  slice owns that rewrite.
