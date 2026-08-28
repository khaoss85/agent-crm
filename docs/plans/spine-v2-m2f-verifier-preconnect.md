# Production Spine v2 M2F — FIFO/TOCTOU loader + verifier pre-connect

This ExecPlan follows `.agent/PLANS.md`. It owns one causal M2F slice:

- **M2-20 remainder** the deployment-storage loader must not hang on a FIFO,
  follow a symlink, or parse bytes from a different inode than the one it
  opened
- **M2-22** identityVerifier ESM resolution, closed factory/operations
  contract, bounded deadline, credential-free failure, no listener and no
  database handle before the contract passes

It does **not** own: CLI/serve/MCP production wiring, live PostgreSQL resource
attestation (M2-13 / M3), TLS against real endpoints (M2-19 / G15),
`db:migrate` PostgreSQL classification (M2-11 / M2-32), production MCP
static-context (M2-16), or replacing every public surface's storage locators
(the remainder of M2-08).

## Goal and user-visible outcome

Two internal functions, still unwired, close the pre-connect boundary:

1. The deployment-storage loader opens a config document with
   `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` (refusing when a flag is unavailable),
   `fstat`s **that** fd, requires a regular owner-only file, reads bounded
   bytes from the same descriptor, and refuses if inode/dev/uid/mode/size
   change. A FIFO cannot hang the process.
2. `identityVerifier` is no longer only an opaque relative path. A sibling
   resolver imports a repository-contained ESM provider **before any database
   connection and before any listener**, under one documented deadline, and
   requires a closed factory plus the v2 operation names. Discover/attest
   names exist and refuse "not in M2" without connecting.

No executable grows a new flag. No credential, path or file byte appears in a
diagnostic.

## Current repository context

Surveyed at `bf5bd6e` (origin/main, includes #141, #142, #144, #143).

| Surface | What it does today |
|---|---|
| `packages/core/src/deployment-storage.js` | Parses the closed envelope. Opens with `O_RDONLY\|O_NOFOLLOW` **without** `O_NONBLOCK`. `openSync` on a FIFO blocks until a writer appears. |
| `tests/spine-v2-m2f-deployment-storage.test.js` | Covers symlink, directory, mode, owner, oversized. Does not cover FIFO, character/socket devices, or replace-between-stat-and-read. |
| `identityVerifier` | Opaque relative path. The parser test asserts `deployment-storage.js` contains no `import(`. |
| Factory / CLI / MCP | Do not import the loader. `createAccordoApp({ spine.identityVerifier })` still takes a **function**, not an ESM path. |
| PostgreSQL driver | absent. <!-- truth: spine.postgresql.implemented=absent --> |

## Approaches compared

QUALITY_GATES §1.1 requires three, and a reason the winner wins.

**A — Make `loadDeploymentStorage` async and import the verifier inside it.**
Rejected: the parser is a synchronous closed-envelope function with a
published refusal matrix. Mixing dynamic `import()`, a deadline and hanging
fixtures into it would make every `--db` compatibility call async, and a
FIFO hang would still live on the same stack as JSON parsing.

**B — Sibling pre-connect resolver + shared same-fd open helper (chosen).**
Keep `loadDeploymentStorage` the sync parser. Extract one internal
`trusted-file` helper that both the config loader and the verifier resolver
use for no-follow / nonblock / same-fd / owner-only / regular-file. A new
`packages/core/src/identity-verifier.js` resolves the repository-relative
ESM reference, checks the closed factory and operations, wraps discover/attest
as "not in M2", and bounds the whole pipeline with one timeout. Factory,
CLI and MCP still do not import either module.

**C — Defer resolution until serve/CLI wiring.** Rejected: M2-22 is
adapter-independent and must be proved before a listener exists. Wiring first
would turn a hanging top-level `await` into a production boot hang.

B wins because it closes the FIFO/TOCTOU hole on the existing loader, lands
the M2-22 contract without expanding the public surface, and keeps
discover/attest as closed names that cannot open a database.

## The DX Simplicity Gate (M2-22)

Answered here so the PR body can cite the plan rather than invent a second copy.

- **Failure prevented:** a production boot imports a hanging or hostile
  verifier, opens a listener or database first, or pastes a path/credential
  from a verifier failure. Independently: a FIFO or swapped special file at
  the config path hangs the parser.
- **Existing primitive insufficient:** the opaque relative path is not
  imported, has no deadline, and cannot prove factory shape. The spine's
  in-process `identityVerifier` **function** is a different seam
  (`createAccordoApp({ spine })`) and is not an ESM provider reference.
- **Overlap bound:** one resolver, one factory name, one operation set.
  No new CLI flag, rail, skill or kernel export.
- **Deferred unless every session needs it:** the resolver is internal.
  Call sites wait for the next M2F PR. Discover/attest refuse "not in M2"
  rather than growing a live attestation API.
- **Portable evidence:** versioned contract (`IDENTITY_VERIFIER_CONTRACT = 2`)
  plus a fixture matrix (valid, missing export, wrong version, missing
  method, throw, hang factory, hang top-level await, symlink, traversal)
  with sentinel credentials absent from diagnostics, and child-process
  proofs that a hang exits nonzero inside the bound.
- **Simpler goal flow:** an operator will eventually point every executable
  at one document whose verifier either loads or refuses with one code.
  This PR does not add that flag.
- **Horizontal capability:** recorded in
  `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`. Domains do not resolve
  verifiers; every domain row is `not_applicable`.
- **Not on the domain-package kernel.** `packages/core/index.js` stays
  unchanged.

## Closed verifier contract

The envelope field remains a relative path string (absolute, empty, NUL,
inline object already refuse as `DEPLOYMENT_STORAGE_ENVELOPE_INVALID`).

Resolution (`resolveIdentityVerifier`) then:

1. Requires an absolute `projectRoot` and a repository-relative path with no
   NUL, no absolute form, no `..` escape after `path.resolve`.
2. `realpath` of the candidate must stay inside `realpath` of `projectRoot`
   (directory-symlink escape).
3. Opens with the same trusted-file discipline as the config loader
   (regular file, owner-only, no-follow, nonblock, same-fd identity).
4. Dynamic-imports that path under the deadline.
5. Requires a **closed module namespace** whose own names are exactly:
   `identityVerifierContract`, `identityVerifierTrust`,
   `createIdentityVerifier`.
6. `identityVerifierContract` must be the integer `2`.
7. `identityVerifierTrust` must be `local-development` or `production` and
   must equal the envelope `spine.mode` (local mode refuses a production
   verifier rather than silently changing trust; production refuses a local
   one).
8. `createIdentityVerifier` is a function. It receives only a frozen
   `{ mode, signal }` — never a connection, password, path or CLI argument.
9. The factory return is a closed object whose own names are exactly
   `{verifyRequest, discoverControlResource, attestControlStartup,
   discoverDataResource, attestDataStartup}`, each a function.
10. The resolver **wraps** the four discover/attest names so that invoking
    them throws `IDENTITY_VERIFIER_OPERATION_UNSUPPORTED` without calling
    through to the provider (M3 owns live attestation).
11. Re-`fstat` the still-open fd and re-open the path; inode/dev/uid/mode/size
    must match or the import is discarded.

`prepareDeploymentPreconnect` is `loadDeploymentStorage` then, when the
selection carries a verifier path, `resolveIdentityVerifier`. It never calls
`createDatabase`, `listen`, or a PostgreSQL driver. PostgreSQL documents still
refuse at parse (`DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED`) before
resolution.

### Bounded deadline

The entire pipeline — realpath, trusted open, dynamic import, factory call —
runs under `IDENTITY_VERIFIER_INIT_TIMEOUT_MS` (2s default; tests pass a
shorter `timeoutMs`). The timer is always cleared. Late settlement is
observed and abandoned. The stable code is `IDENTITY_VERIFIER_TIMEOUT`.

A hanging factory and a module whose top-level `await` never settles are
separate fixtures. Hang proofs run in a **child process** that `process.exit`s
after the timeout so a pending `import()` cannot keep the event loop alive.

### Refusal matrix

Every code is stable. Messages and `details` contain neither a filesystem
path, nor file bytes, nor credentials, nor the offending configured value.

| Input | Code | When |
|---|---|---|
| FIFO, symlink, directory, socket/device, ownership/mode mismatch, escape, oversized, post-open identity change, missing `O_NONBLOCK`/`O_NOFOLLOW` | `DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED` or `IDENTITY_VERIFIER_UNTRUSTED` | before parse / before import |
| missing export, extra export, missing method, extra method, default-export v1 function, trust/mode mismatch | `IDENTITY_VERIFIER_INVALID` | after import, before or after factory |
| `identityVerifierContract !== 2` | `IDENTITY_VERIFIER_CONTRACT_UNSUPPORTED` | after import, before factory |
| throwing import or factory | `IDENTITY_VERIFIER_INIT_FAILED` | wrapped; cause and thrown message discarded |
| hang (factory or top-level await) | `IDENTITY_VERIFIER_TIMEOUT` | deadline |
| discover/attest invoked | `IDENTITY_VERIFIER_OPERATION_UNSUPPORTED` | no connect |

## Explicitly out of scope

- No `--deployment-storage` CLI flag, MCP option or `createAccordoApp` option.
  A structural test proves `create-app.js`, `commands.js` and `mcp/src/stdio.js`
  import neither the loader nor the resolver.
- No live PostgreSQL, no `pg` dependency, no `net.connect` / `tls.connect`.
- Discover/attest do not talk to a resource. M3 owns M2-13.
- No measurement, no `site/claims.json` edit, no PROJECT_STATUS rewrite.

## ADR-018 justification

This is a reusable runtime capability: every future executable will resolve
the same verifier the same way before it connects. It is not domain-specific
business behaviour. It lives in `packages/core/src/identity-verifier.js` and
is **not** added to `packages/core/index.js`.

## Milestones

Each leaves the repository runnable.

1. **ExecPlan (this file) and failing tests.** FIFO hang, non-regular files,
   replace-between-stat-and-read, verifier fixture matrix, child-process hangs,
   no-wiring, no-driver.
2. **Trusted-file helper + loader `O_NONBLOCK` + same-fd re-stat.** Regular
   trusted documents still load.
3. **Verifier resolver, closed contract, wrappers, deadline, child-process
   hang proofs.**
4. **Docs: ADR-038 Amendment 6, alignment matrix, TASKS, this progress log.**
5. **`npm run verify` slice + check + smoke.** No measurement.

## Validation

```text
node --test tests/spine-v2-m2f-deployment-storage.test.js tests/spine-v2-m2f-verifier-preconnect.test.js
npm run verify
npm run repo:truth -- --check
```

Expected: the new tests pass; `createAccordoApp({ dbPath: ':memory:' })` still
boots; no PostgreSQL dependency; `repo:truth --check` stays green.

## Progress log

- [x] Survey `bf5bd6e` loader flags, M2-22 map text and identityVerifier ESM section.
- [x] Write this ExecPlan before code.
- [x] Failing tests for FIFO/TOCTOU and the verifier pre-connect matrix.
- [x] Implement trusted-file helper, loader flags, verifier resolver.
- [x] Docs: ADR-038 Amendment 6, alignment matrix, TASKS.
- [x] Slice tests, `npm run check`, `npm run smoke`, `npm run repo:truth -- --check`. Full `npm test` on this host cancelled later files after `agent-tool-selection-prompts.test.js` ran ~439s; the M2F slice files pass in isolation. No measurement.

## Decision log

1. **Parser stays sync.** Dynamic import and a deadline do not belong in
   `loadDeploymentStorage`. M2-22 is a sibling module. The parser still
   stores an opaque relative path.
2. **Shared trusted-file helper.** FIFO/TOCTOU is one discipline. Duplicating
   it onto the verifier path is how one of them grows a hang.
3. **Default `fs` namespace, not destructured bindings.** Open/fstat/read must
   go through one namespace so a path-based helper cannot sneak in, and so a
   test can prove replace-between-stat-and-read against the same functions.
4. **Discover/attest are wrapped, not called.** A fixture that connected
   inside those methods still cannot connect through the object this resolver
   returns. M3 may unwrap.
5. **Hang proofs are child processes.** A top-level `await` that never
   settles keeps the event loop alive in-process; the child `process.exit`s
   after the timeout.
6. **No wiring.** The next PR consumes `prepareDeploymentPreconnect`. This one
   must not make a resolver defect a production boot defect.
7. **`expectedUid` remains a test seam** on both the config loader and the
   verifier file, same as Amendment 5.

## Outcome and follow-up

Shipped: FIFO/TOCTOU-safe config open; identityVerifier pre-connect resolver
with closed factory/operations, deadline, credential-free failures, and
discover/attest names that refuse without connecting.

Follow-up PRs, not this one:

- Wire `configPath` / `ACCORDO_DEPLOYMENT_STORAGE` and the resolver into
  CLI/serve/MCP (remainder of M2-17 consumers; M2-11, M2-32).
- Replace locators on every public surface with the descriptor (remainder of
  M2-08).
- Live PostgreSQL adapter, real TLS endpoints, and live discover/attest
  (M3 / M2-13 / M2-19).
