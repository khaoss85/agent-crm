# Production Spine v2 M2C — the execution-run store

This ExecPlan is a living document. It follows `.agent/PLANS.md` and is bounded
to the two real production consumers that persist workflow-run and trace-span
lifecycle evidence into `workflow_runs` and `trace_spans`. PostgreSQL, the Work
transaction-context seam, the adapter internals, shared-database tenancy, and
new public or agent-facing surfaces are explicitly out of scope.

## Purpose

Remove the duplicated raw SQLite persistence of run and span lifecycle evidence.
`packages/workflows/src/engine.js` prepared nine raw statements against the two
tables; `packages/core/src/action-runtime.js#writeTrace` prepared two more for
the same rows. One internal core primitive now owns that family behind Storage
Contract v1, so both consumers keep their exact public shapes while no longer
reaching the raw driver.

No public, agent-facing, MCP, REST or CLI surface changes. `WorkflowEngine.run()`,
`listRuns()` and `getRun()` keep their signatures, their synchronous read shapes
and their exception shapes; `writeTrace(database, run)` keeps its signature and
stays the one published run-trace surface; no statement vocabulary is added to
`packages/core/src/storage-contract.js`.

## Progress

- [x] Baseline the workflow, action, pipeline, admin and characterization suites.
- [x] Add the internal execution-run store on Storage Contract v1.
- [x] Migrate the workflow engine and the action runtime's trace writer.
- [x] Prove exact behaviour preservation per consumer.
- [x] Add a structural no-raw-driver guard for the declared M2C slice.
- [x] Reconcile truth, the M2A and M2B inventories, and the alignment matrix.
- [ ] Complete exact-head CI and Vercel gates.

## Current repository context

Storage Contract v1 is implemented by `packages/core/src/storage-contract.js`
and rendered for SQLite by `packages/core/src/database.js`. M2A moved Approval,
Contact, Opportunity and Work's legacy-task reader behind it; M2B moved the four
definition-version registries. Before M2C, the two run/trace consumers still
prepared raw statements:

- `packages/workflows/src/engine.js` — 9 sites: the run insert, the span insert,
  the span completion and failure updates, the run completion and failure
  updates, the `listRuns` select, and the two selects `getRun` joins by hand.
- `packages/core/src/action-runtime.js` — 2 sites inside `writeTrace`: the
  finalized run insert and the per-step span insert.

Both write the same family. `workflow_runs` and `trace_spans` are core migration
v1 (`packages/core/src/database.js`), with `CHECK` constraints on both status
columns, `trace_spans.run_id` a cascading foreign key, and `trace_spans_run_id`
an index.

`writeTrace` is already exported from `packages/core/index.js` and is called
from three places: `action-runtime.js` itself, `packages/core/src/external-operation.js`
and `packages/commercial/src/catalog-sync.js`. All three call it inside a
`try`/`catch` that logs and swallows — the best-effort trace rule (ADR-012/016):
a trace write failure must never mask the action's real outcome.

## Milestones

1. **Baseline.** Run the workflow, action-runtime, pipeline, admin, package
   end-to-end and characterization suites without changing source, so behaviour
   preservation is measured against a recorded starting point.
2. **Add the store.** One internal core primitive on Storage Contract v1, with
   fail-closed validation and injectable id/clock sources. The repository remains
   runnable and the store's own suite is green.
3. **Migrate the two consumers.** Replace each raw statement with a store call,
   keeping the engine's and the action runtime's suites green as they move.
4. **Prove and guard.** Result and exception shapes, step ordering, compensation,
   best-effort trace semantics, stable `workflowRunId` details, restart
   persistence against real SQLite, plus a structural guard scoped to exactly the
   two migrated files.
5. **Reconcile truth.** Regenerate Repository Truth, correct the M2A and M2B
   inventory rows that named these two files as later M2 work, and update the
   alignment matrix.

## Raw-driver inventory

Re-derived at this head with M2B's widened pattern, not copied from earlier prose:

```bash
grep -rnE "database\s*\??\.\s*raw|\??\.\s*raw\s*\??\.\s*(prepare|exec)\s*\(|DatabaseSync" \
  packages/ scripts/ apps/ --include='*.js'
```

| Classification | Path / consumer | Occurrences | Reason and disposition | Evidence owner |
|---|---|---|---|---|
| `M2C_CURRENT_SLICE` | `packages/workflows/src/engine.js` — workflow run and span lifecycle | 9 → **0** | Run/span insert, update and read statements, moved to the shared store. | `tests/workflow.test.js`, `tests/opportunity-pipeline-e2e.test.js`, M2C guard |
| `M2C_CURRENT_SLICE` | `packages/core/src/action-runtime.js` — `writeTrace` | 2 → **0** | Finalized run and span inserts, moved to the shared store; `writeTrace` keeps its signature and stays the published surface. | `tests/action-runtime-semantics.test.js`, M2C guard |
| `LATER_M2_PACKAGE` | `packages/work/src/follow-up.js#requireCallerTransaction` | 1, written `tasks?.database?.raw` | Work's capability reads the driver's `isTransaction` flag to prove the caller's transaction. **Work remains `partial`**, and its residue is reachable only through optional chaining. Untouched by M2C. | Work capability fault/concurrency suites |
| `ADAPTER_INTERNAL_ALLOWED` | `packages/core/src/database.js` | 3 | The SQLite adapter owns `DatabaseSync`, the PRAGMAs, rendering, and the raw-driver closure. | M0/M1 storage suites |
| `ADAPTER_INTERNAL_ALLOWED` | `packages/core/src/core-adapters.js` | 2 | Core adapter/compatibility internals. | M0/M1 storage suites |
| `ADAPTER_INTERNAL_ALLOWED` | `packages/core/src/spine-store.js` | 1 | Control-plane store internals (`database.raw ?? database`). | Spine suites |
| `AUTHORITY_PROBE_ALLOWED` | `scripts/repo-truth.js` | 5 | The Repository Truth storage authority opens isolated in-memory databases to execute its own probes. It is a repository-maintenance script, not application runtime. | `npm run repo:truth -- --check` |
| `PROSE_NOT_A_CONSUMER` | `packages/create-accordo/src/project-bootstrap.js` (3), `packages/create-accordo/src/project-files.js` (1), `packages/cli/src/app-inspect.js` (1) | — | The token `node:sqlite` appears inside declared limitations and reported metadata strings. No driver is opened, and none of these matches the raw-driver pattern above. | bootstrap and inspect suites |
| `CHARACTERIZATION_ONLY` | fixtures and temporary-project harnesses under `tests/characterization/` | — | Direct SQLite setup is preserved test evidence, not production reachability. | characterization suites |
| `TEST_ONLY` | remaining occurrences under `tests/` | — | Fault injection, physical-schema assertions and adapter tests intentionally exercise SQLite directly. | owning test files |

After M2C the pattern above returns **nothing** under `packages/workflows`, and
nothing in `packages/core/src/action-runtime.js`. The only application-runtime
raw residue left in `packages/` is Work's optional-chained transaction-context
check. **PostgreSQL remains absent: the only adapter is SQLite.**

## Decisions

- **Internal to core, deliberately not a new public export.** M2B had to publish
  its store because three of its four consumers were domain packages, and §10 of
  `docs/PACKAGE_AUTHORING.md` forbids a package deep-importing `packages/core/src/…`.
  M2C's two consumers are `packages/core` itself and `packages/workflows`, which
  is kernel composition rather than a domain package: `engine.js` already
  deep-imports `../../core/src/errors.js` and `../../core/src/time.js`, and the
  deep-import gate (`packages/cli/src/package-commands.js:119`) runs only against
  a domain package directory under `package validate`. So no public export is
  required — and one would be actively wrong. **`writeTrace` is already the
  published run-trace surface.** A public `createExecutionRunStore` would be a
  second published way to write the same two tables, which is exactly the
  semantic overlap the DX Simplicity Gate refuses. `packages/core/index.js` is
  untouched, and `docs/PACKAGE_AUTHORING.md` §10 needs no change because the
  public surface does not move.
- **One store, not a workflow engine.** `createExecutionRunStore(database, {clock, newId})`
  returns a frozen object whose methods are exactly the lifecycle the two
  consumers perform. No table parameter, no predicate builder, no raw escape
  hatch, no event store, no tracing-backend abstraction. It knows two tables and
  the shapes those two tables hold.
- **No new statement vocabulary.** The nine engine sites and the two trace sites
  are covered by the existing M1 `insert`, `update` and `select` kinds with `eq`
  predicates, `orderBy` and `limit`. `packages/core/src/storage-contract.js` is
  untouched.
- **No transactions, because there were none.** All eleven sites are bare
  statements today. `writeTrace` writes the run row and then each span row
  outside any transaction, so a span failure leaves the run row behind — that is
  current behaviour, and wrapping the store in `storage.transaction` would change
  it *and* risk `NESTED_TRANSACTION` at a call site that is already inside one.
  The store throws; the best-effort `try`/`catch` stays where it is, at the three
  `writeTrace` call sites.
- **Two write surfaces, because the stored bytes differ.** The engine's
  `startRun` writes SQL `NULL` into `output_json`, `error` and `finished_at`, and
  a fresh clock reading per lifecycle event. `recordRun` — the `writeTrace` path
  — mints **one** `finishedAt` and reuses it for the run row and every span row,
  gives every span the caller's `run.startedAt`, writes SQL `NULL` into a span's
  `input_json`, and writes the **string** `"null"` into a failed run's
  `output_json` because `safeJson(null)` did. Collapsing the two into one generic
  writer would have changed rows a test can read directly.
- **The store owns the JSON encoding and the row mapping.** `stringify`/`parse`
  in the engine and `safeJson` in the action runtime were the same function
  written twice, and `mapRunRow`/`mapSpanRow` are the decode half of that same
  encode. One encoder and one mapper now live beside the statements they belong
  to, which is what makes "the same JSON in the same column" a property of the
  code rather than of two files agreeing. The repository convention is the same
  one: *return domain objects, not raw SQLite rows with encoded JSON* (AGENTS.md).
- **`parent_span_id` is not a parameter.** Both consumers always wrote `NULL`.
  Adding a parameter no caller uses would be inventing the tracing hierarchy this
  store is explicitly not.
- **Injectable clock and id, defaulting to today's behaviour.** `resolveClock`
  from `packages/core/src/time.js` is the existing convention and it refuses a
  non-canonical instant; `resolveIdSource` mirrors `packages/core/src/definition-version-store.js`,
  validating what the generator *returns* on every call, with the same deliberate
  split — a non-function is construction-time misuse and raises `TypeError`
  exactly as `resolveClock` does, while a bad value is on its way to a write and
  raises `ValidationError` so it carries the framework's stable code.
- **One shared identity-text rule, with recorded exemptions.** `assertIdentityText`
  is a single rule with call sites for every stored *identity* string: the
  generated run and span ids, the caller-supplied `runId`, `workflowName`, each
  span `name` and `startedAt`. M2B's comment explains why this is one rule and
  not per-field copies. Two fields are deliberately **exempt**, and the exemption
  is the interesting part: `error` carries a normalized exception message, which
  legitimately contains newlines, so M2B's control-character class would refuse
  real failure paths and — through the best-effort catch — silently lose the
  trace of the failure it was describing. `input` and `output` go through the
  shared JSON encoder, and `JSON.stringify` already escapes every control
  character. Bounding either would be a new refusal on evidence the framework
  itself produces.
- **The read path validates nothing and refuses nothing.** `getRun` is
  HTTP-reachable (`GET /api/traces/:id`). Today a control-character id reaches
  the parameterized lookup, matches no row, and becomes `NotFoundError` — a 404.
  An identity refusal there would make it a `ValidationError` — a 400, an
  observable API change on a public route. Lookup keys are parameters, not
  interpolated SQL, so they are passed through: the store returns `null` and the
  engine constructs the same `NotFoundError` it always did.
- **`listRuns` keeps its clamp byte-identical**, including `Math.min(Math.max(filters.limit ?? 100, 1), 500)`.
  One new refusal follows from the seam rather than from a decision: Storage
  Contract v1 refuses a non-integer `limit`, where SQLite previously coerced one.
  It is unreachable from HTTP — `parseLimit` in `apps/server/src/http-server.js`
  already returns `undefined` for anything that is not an integer — and reachable
  only by an in-process caller passing a fraction. Recorded here as a delta
  rather than discovered as a surprise.
- **Statuses are validated against the schema's own `CHECK` sets.** The store
  refuses a run status outside `running|completed|failed` and a span status
  outside `running|completed|failed|compensated` — the same values SQLite would
  refuse, moved earlier. The one delta this creates is *when*: for `recordRun`,
  a malformed step status is now refused before the run row is written, where it
  used to be refused after. Both outcomes are a logged, swallowed trace failure;
  refusing before beats leaving an orphaned run row with no spans behind it.
- **Batch bounds mirror M2B's, for the same reason.** `recordRun`'s `steps` must
  be iterable and is capped at `MAX_SPANS`, so an accidental runaway generator is
  a framework refusal rather than an out-of-memory crash. No real action run
  produces more than a handful of steps.
- **Span ids are checked for self-collision inside one `recordRun`, and no
  further.** M2B could do better — it read the table for an existing id under
  `BEGIN IMMEDIATE`, where the write lock makes read-then-write atomic. This
  store opens no transaction, so a read here would guarantee nothing and would
  add a query per span to a write path that has none. Within one `recordRun` the
  minted ids are checked against each other, which is free; beyond that a
  colliding id meets the `PRIMARY KEY`, exactly as it does today. The asymmetry
  with M2B is deliberate and commented in the source.
- **The engine builds its store once, in its constructor.** `packages/app/src/create-app.js:249`
  is the only construction site and `this.database` is never reassigned, so a
  per-call store would buy nothing. `writeTrace` builds one per call, matching
  M2B's per-call registry pattern: it is a function, not an object with a
  lifetime, and construction is a clock resolution and a property read.
- **No new Repository Truth fact and no new authority probe.** No fact is read
  from the store, and `AUTHORITY_SOURCES` is defined as the exact files the facts
  are read from — so adding the new file there would make `sourceSha` answer a
  question it does not answer. `packages/core/src/action-runtime.js` is already
  an authority source, so its `sourceSha` moves; `packages/core/index.js` does
  not, because nothing is exported.

## Known limitation, carried forward deliberately

**Run and span persistence has no actor context and no audit event** — the same
limitation M2B recorded for `definition_versions`, and the same three bounding
facts apply. Neither consumer took an actor or emitted an audit event for these
writes before M2C: the engine writes the run row before any step executes, and
`writeTrace` writes evidence *about* an actor rather than a mutation *by* one.
The trace row already records the actor inside `input_json` (`safeActor(actor)`
in `action-runtime.js`), which is what makes it evidence rather than an
unattributed mutation. M2C preserves that exactly. Nothing here is published, so
no new mutation capability is created.

## Validation

Run these commands under Node 22.16.0:

```bash
node --test tests/spine-v2-m2c-execution-run-store.test.js
node --test tests/workflow.test.js tests/action-runtime-semantics.test.js \
  tests/action-contract.test.js tests/opportunity-pipeline-e2e.test.js \
  tests/pipeline-contract.test.js tests/admin-pipeline.test.js
node --test tests/api.test.js tests/mcp.test.js tests/scenario-run.test.js
node --test tests/commercial-e2e.test.js tests/signature-order-e2e.test.js \
  tests/lead-conversion-e2e.test.js tests/contracts-activation-e2e.test.js \
  tests/delivery-handover-e2e.test.js tests/service-operations-evidence.test.js \
  tests/custom-package-e2e.test.js
node --test tests/characterization/*.test.js tests/falsify.test.js
node scripts/falsify.js
npm run repo:truth
npm run repo:truth -- --check
npm run gtm:check
npm run site:check
npm run smoke
git diff --check
npm run verify
```

## Progress log

- **2026-08-27:** Created this plan before touching source, and recorded the
  bounded slice, the two consumers and the decisions taken before the first line
  moved.
- **2026-08-27:** Added `packages/core/src/execution-run-store.js` and migrated
  both consumers. The engine lost `randomUUID`, `nowIso`, its JSON encoder, its
  decoder and both row mappers, going from 234 lines to 147, and `writeTrace`
  became a single line under its JSDoc. The targeted suites stayed green without
  being edited.
- **2026-08-27:** Added `tests/spine-v2-m2c-execution-run-store.test.js`: the
  structural guard, the store's own fail-closed and injection proofs, the two
  consumers' behaviour-preservation proofs, and a real best-effort proof driven
  through `runRecordAction` with a trace write made to fail. See *The receipts*
  above for what was watched failing.
- **2026-08-27:** Reconciled the M2A and M2B inventory rows, the alignment
  matrix and the task ledger, and regenerated Repository Truth.
- **2026-08-27:** Baselined the workflow, action-runtime, pipeline, admin, API,
  MCP, scenario, package end-to-end and characterization suites at `c284867`.
  One pre-existing darwin-only failure in `tests/spine-v2-m0-characterization.test.js`
  (`/private/var` vs `/var` tmpdir realpath) was recorded and left alone: it is
  unrelated to this milestone and does not reproduce on CI's Linux runner. It is
  the same failure M2B recorded.

## The receipts

**The characterization diff is the proof.** `commercial`, `intelligence` and
`signature` each freeze a hash of every behaviour-bearing source file, and all
three hash `packages/core/src/action-runtime.js`. The **entire** diff across the
three baselines is **six source-hash lines and nothing else**: three for
`action-runtime.js` moving, three for `execution-run-store.js` arriving. No
observation, asserted value or classification changed. Three independent
harnesses replayed each domain's externally observable behaviour and found it
byte-identical, which is the strongest available evidence that this refactor is
boundary-preserving. No characterization receipt was weakened to make anything
pass.

**`execution-run-store.js` was added to all three behaviour-bearing lists, and
that is a fix rather than an addition.** Those lists exist so a change to a file
that decides a domain's behaviour stales the baseline. Moving behaviour *out* of
a hashed file and into an unhashed one would have left each baseline strictly
*less* sensitive than it was — a regression this PR would have caused. Recorded
as follow-on work, deliberately not in this PR: `packages/core/src/definition-version-store.js`
has exactly the same standing after M2B and is in none of the three lists.
Retrofitting another milestone's omission would enlarge a bounded slice; naming
it is what stops the next one.

**The guard was watched failing, 26 times.** Every one of the thirteen spellings
was written into `packages/workflows/src/engine.js` and then into
`packages/core/src/action-runtime.js`, the guard was run, and it failed on all
26; each file was restored and the guard passes on the restored tree. A guard
nobody has watched fail is not a guard, and a guard watched failing in one file
says nothing about the other.

**The suite refuses the regressions it claims to.** Fifteen mutations were
written into the store, the engine and the trace writer, and every one was
caught: neutralising the identity rule (3 tests), the status check (3), the
closed-shape check (2), the own-field check (1); making `recordRun` re-read the
clock per span (1) or a recorded span borrow its own start (1); writing an
encoded `null` where an open run holds SQL `NULL` (1); validating `getRun`'s
lookup key (2); dropping the `listRuns` clamp (2), the span cap (1) or the id
self-collision check (1); making `writeTrace` swallow its own failure (2);
and, in the engine, dropping the state a failed run records (1), the
`workflowRunId` detail (1) or the reverse order of compensation (1).

**No falsification mutation had to move.** `scripts/falsify.js` aims at
`decide-opportunity-approval.js`, `request-opportunity-stage-change.js`,
`signature/src/registry.js`, `definition-version-store.js`, `module-factory.js`
and `delivery/src/economics.js` — none at a line M2C deletes or moves.
`node scripts/falsify.js` reports 5 caught, 0 survived, 0 stale, unchanged.

**Repository Truth moved by exactly one line.** `npm run repo:truth` regenerated
`docs/repository-truth.json` with only `sourceSha` changing — 48 facts from 11
authorities, fingerprint `22417d9991b7d5a7`. `--check` reports **48 facts, 104
citations across 21 bound surfaces**, and every bound claim still agrees with the
code. No fact moved and no conclusion changed, because no fact is read from
either migrated file's persistence.

## Decision log

- **The brief's premise about `engine.js` was stale, and checking it changed the
  design.** It described `engine.js` as importing from `../../core/index.js`;
  the file imports `../../core/src/errors.js` and `../../core/src/time.js`. That
  is what makes an internal, unexported store the right answer rather than a
  second public one.

## Outcome and follow-up

The two declared consumers no longer reach the raw SQLite driver, and the row
family they shared exists once. Public behaviour is unchanged:
`WorkflowEngine.run()` keeps its result and exception shapes, `listRuns()` and
`getRun()` stay synchronous with the same mapped shapes and the same
`NotFoundError`, `writeTrace(database, run)` keeps its published signature and
still throws so its callers' best-effort catch still has something to catch,
Storage Contract v1 is untouched, and no export was added.

With M2C the kernel's own raw residue is down to one application-runtime
consumer: `packages/work/src/follow-up.js#requireCallerTransaction`, which reads
the driver's transaction flag through optional chaining, so Work stays
`partial`. The adapter internals in `packages/core/src/database.js`,
`core-adapters.js` and `spine-store.js` own the driver by design, and
`scripts/repo-truth.js` opens isolated in-memory databases as a
repository-maintenance script rather than as runtime. PostgreSQL remains absent.

Explicitly still open, and deliberately so:

- **Work's transaction-context seam.** The last one, and it is a *read* of the
  driver's state rather than persistence, so it needs a different answer than
  a store — probably a contract-level way to ask "am I inside the caller's
  transaction?". Sequenced, not forgotten.
- **M2A's guard still carries the un-hardened pattern.** M2B named this as
  follow-on and it is still true: `tests/work-legacy-task-migration.test.js`
  scans for `database.raw` only, and Work's own residue is spelled
  `tasks?.database?.raw`, which that scan walks straight past. M2B and M2C both
  use the widened set.
- **`packages/core/src/definition-version-store.js` is in none of the three
  characterization behaviour-bearing lists.** M2C added `execution-run-store.js`
  to all three because *this* PR moved behaviour into it; M2B's store has
  exactly the same standing and the same gap. Retrofitting it here would enlarge
  a bounded slice, so it is named rather than done.
- **Run and span persistence still carries no actor context and no audit
  event**, exactly as it did before M2C. Recorded above under *Known limitation,
  carried forward deliberately*.
