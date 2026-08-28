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
- **The first draft applied M2B's identity rule to every caller-supplied
  string. That contract no longer exists, and this bullet is deliberately not a
  description of it.** `assertIdentityText` was a single rule — non-empty,
  bounded, no control characters — over the generated ids, `runId`,
  `workflowName`, each span `name` and `startedAt`, with `error`, `input` and
  `output` exempt. It is **deleted**. Every one of those checks on a caller's
  value turned out to be an invented refusal that the best-effort trace write
  swallowed, destroying the evidence it was meant to protect; the regression
  tests now prove those values must be **accepted**. What replaced it is the
  three-category rule below, and that is the contract to read. This bullet is
  kept as history rather than removed, because the sequence — one rule, then a
  ceiling narrowed, then the class closed — is the reasoning a future reader
  needs in order not to restore the validation the tests refuse.
- **What this store is entitled to refuse, in three categories — and the
  reasoning that closes the class.** This is the third revision of this
  decision, and the revisions are the interesting part: the ceiling was written
  as universal, narrowed to minted ids after review, then narrowed again after
  the integrator asked the question that generalised it. The rule now: the store
  refuses **(1) what it owns** — a minted id gets non-empty, no control
  characters and a length ceiling, because the store produces it *and* quotes it
  verbatim into the duplicate-id refusal; **(2) what the driver would refuse
  anyway**, established by probing the real schema rather than assuming — a
  status outside the schema's own `CHECK` set, and a value a `STRICT` `TEXT`
  column genuinely cannot take; **(3) a shape whose acceptance
  would silently corrupt** — a **missing** named field, or a named field
  arriving through a polluted prototype. An **extra** field is refused only on
  the shapes the store owns, never on what arrives through `writeTrace`. Everything else a caller supplies is stored as given.
  **The asymmetry with M2B is the load-bearing argument.** M2B applies an
  identical character-class and length rule to `definition_versions`, and that
  is right *there* because it sits on the **startup** path, where a refusal is
  loud and stops the boot. This store sits on an evidence path where the caller
  swallows the refusal — so an invented refusal is not a safety feature, it is
  an evidence-destruction primitive.
- **The length ceiling was wrong for caller-supplied identity, and review caught
  it.** `MAX_IDENTITY` (200) bounded every identity string, justified in the
  source as "far above anything real — a workflow name is `module.action`". That
  was an unverified assumption. A record action's workflow name is exactly
  `${module}.${action}`, and `packages/core/src/action-registry.js:7` validates
  each part against an anchored lower-case pattern that bounds its length **not
  at all**; the module-manifest validator uses the same shape. Two individually
  valid declarations therefore exceeded the ceiling — and because `writeTrace` is
  best-effort, the refusal was swallowed and the action **reported success with
  no run row and no span row at all**. Reproduced with a 150-character module and
  a 150-character action: 301 characters, `VALIDATION_ERROR`, zero rows. It is
  this PR's regression, not an inherited one: the pre-M2C `writeTrace` at
  `c284867` contains no length check of any kind.
  **That pass kept one rule and narrowed one ceiling** — and this sentence
  describes *that pass*, not the head. It moved the ceiling to
  `MAX_GENERATED_ID`, applied only to ids the store mints, where it is earned
  twice: the store owns those values *and* quotes them verbatim into the
  duplicate-id refusal. The original justification — "an unbounded identity is an
  unbounded error message" — turned out to be true of nothing else, because the
  store never interpolates caller identity into a message, only its length.
  It also **kept non-empty and control-character checks on every identity
  string**, which the very next pass removed. **Do not read that as the
  contract**: the regression tests accept an empty and a control-bearing
  workflow name, span name, `startedAt` and caller `runId`, and the
  three-category rule below is what the head enforces.
  The reviewer's alternative, enforcing a combined bound at action registration,
  was rejected: that is a **new** startup refusal for packages that are valid
  today, which is a compatibility break in a milestone that promises none, and it
  is outside this slice.
- **The sweep the integrator asked for found seven more of the same defect, and
  they are fixed together.** The question — *is this ceiling protecting something
  the store actually does, or something I assumed it does?* — applied to every
  remaining rule. Probed rather than reasoned; each of these was refused, and
  each refusal destroyed the whole trace: a span name with a control character
  or an empty span name (both reachable through `ctx.step(name, …)` and through
  a workflow step name, **neither of which is validated anywhere**), a workflow
  name with a control character or empty, an empty or control-bearing
  `startedAt`, and an empty caller-supplied `runId`. All seven are now stored as
  given. `assertIdentityText` is gone, because a validator that no longer
  asserts identity text should not keep the name — the same rule this milestone
  applied to its own guard. What replaced it: `assertStorableText` (type only,
  category 2) for caller values, `assertGeneratedId` (the full rule, category 1)
  for minted ids.
- **"The driver would refuse it anyway" is a claim that has to be probed, and
  mine was wrong about numbers.** Category 2 read `typeof value === 'string'`,
  justified as matching what SQLite accepts. A probe against the real schema
  says otherwise: a `STRICT` `TEXT` column **losslessly coerces** a number and
  a bigint and stores the text form, while a boolean, object, array,
  `undefined` and `null` genuinely fail to bind or violate `NOT NULL`. So the
  string requirement was a *new* refusal on values that previously persisted —
  the same shape as the length ceiling, found one round later, in the very check
  written to replace it. The accepted set is now the driver's: string, number,
  bigint. **The value is passed through unchanged**, which matters for bytes: the
  driver renders a JS number as a double, so `42` stores as `"42.0"`, and
  converting in the store would have stored `"42"` and silently changed the rows
  this milestone promises to preserve. A test pins `"42.0"`.
- **The closed-shape rule was the last invented refusal, and my own
  justification for it was wrong.** I argued that refusing an unnamed key on
  `recordRun` stopped a caller passing `spans:` instead of `steps:` from
  writing a run with no spans and being told it succeeded. Probed rather than
  re-argued: that caller is refused by the **required-field** check —
  `requires own field "steps"` — which was doing the work all along. The
  unnamed-key refusal therefore only ever caught the *harmless* case: every
  named field correctly present, plus an extra one. And its cost on a published
  surface was the whole trace of a **successful** operation, silently, because
  someone added a key to an object. Measured against this store's own three
  categories it failed all three — not owned by the store, never seen by the
  driver, and corrupting nothing, because an unread field changes no row.
  **The rule was borrowed from `definition-version-store`, where it is
  correct**, and the difference is worth naming because it is not "unexpected
  versus expected": there, an unnamed key on the *entry* shape means a caller
  believes it is persisting something the store will silently drop. Here
  nothing is persisted either way. The discriminator is whether a rejected
  shape could otherwise have been **silently persisted**.
  Split accordingly: `ownedShape` keeps the closed check for the store's own
  lifecycle arguments, which nothing outside core and the workflow engine
  constructs; `suppliedShape` reads the named fields and ignores the rest for
  `recordRun` and each step. Both keep the plain-object test, the required-field
  test and `Object.hasOwn` reads. A test pins that an extra field writes the
  trace unchanged **through `writeTrace`**, and that the `spans:` typo is still
  refused.
- **`MAX_SPANS` is the one place this milestone deliberately sacrifices
  evidence to avoid a crash — and the sacrifice is silent, because the caller
  swallows the refusal.** It is kept, and it is not pure preservation: the
  statement it replaced *streamed* its inserts, so an infinite generator meant
  unbounded row growth forever, while this store collects the batch first, which
  is what makes an out-of-memory crash possible and the cap necessary. It
  converts two pathologies into one refusal, and unlike everything the sweep
  removed, the alternative here is a crash rather than a stored row.
  **The bound is 10,000 spans in one run, not 10,000 `ctx.step(…)` calls, and
  an earlier draft of this bullet said it was.** Review caught the off-by-one and
  it was real, measured through `runRecordAction`: **9,999 `ctx.step` calls
  survive; 10,000 lose the entire trace while the action still returns `ok: true`.**
  The enforced number was never wrong — `collected.length >= MAX_SPANS` before
  the push accepts exactly 10,000 spans — so nothing executable changed. What was
  wrong was the claim, stated in a unit the store does not control.
- **No fixed reservation could have fixed it, which is why the units moved
  instead.** The obvious repair is to reserve the span the runtime prepends.
  That works for exactly one caller: `action-runtime.js` adds **one** span, and
  **two** when the event dispatch also fails; `external-operation.js` adds up to
  **five** across intent, external, finalize, compensate and events;
  `catalog-sync.js` adds up to **three**. A constant chosen for any one of them
  is quietly wrong for the rest — the same finding reproduced in a form harder to
  see. So the store states its bound in spans, the only unit it controls, and the
  caller's budget is documented as derived and per-caller. The boundary is pinned
  by a test through `runRecordAction` rather than through the store, because
  going through the store is what hid it; the test fails if the cap moves by one
  in **either** direction.
- **Exempting `error` from the bounds is not the same as accepting anything, and
  the first pass conflated the two.** `error` was the one stored field with no
  check at all — not even a type. A boolean, object or array fails to bind, and
  because the trace write is best-effort that driver refusal is swallowed and
  logged *in the driver's words*: exactly the leak this store exists to stop,
  hiding behind a deliberate exemption. `assertOptionalMessage` now checks every
  `error` the store stores against the same accepted set as `assertStorableText`
  — deliberately with **no length bound and no character class**, so the newline
  that made the exemption necessary still costs nothing and the sentence a person
  reads on a failure is never truncated. Found by walking the store's own surface
  rather than by review, which is the point of walking it.
  **A number is not in the refused set**, and an earlier draft of this bullet
  said it was — the same stale claim as the source comment beside it, and the
  third instance rather than the two review named. `STRICT` `TEXT` *coerces* a
  number: `99` stores as `"99.0"`, and a test pins it.
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
- **The engine builds its store once, in its constructor, into a genuinely
  private field.** `packages/app/src/create-app.js:249` is the only construction
  site and `this.database` is never reassigned, so a per-call store would buy
  nothing. It is `#runs` rather than `this.runs` on purpose: `app.workflows` is
  an object every in-process caller holds, and composing an application should
  not put a persistence object on it as a side effect of a refactor. One delta
  follows and is deliberate — the constructor now refuses a handle without the
  seam, where the refusal used to wait until the first `run()`. Failing at
  composition time is what fail-closed means here, and the only construction
  site always passes a real handle. `writeTrace` builds one per call, matching
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
limitation M2B recorded for `definition_versions`, raised again by review against
AGENTS.md's *"Flag any mutation without actor context and audit event"*, and
resolved the same way, for reasons verified rather than asserted.

**The two consumers are not equally exposed, and an earlier draft of this section
blurred them.** They deserve separate sentences:

- **The action-runtime path already records the actor**, inside the run's own
  `input_json` (`safeActor(actor)` in `action-runtime.js`), together with the
  authorization decision that permitted the run. That is what makes a trace row
  evidence *about* an actor rather than an unattributed mutation.
- **The workflow-engine path records no actor at all.** `WorkflowEngine.run()`
  accepts `context.actor` and passes it to every step, but has never persisted
  it: `workflow_runs` has no actor column, and at `c284867` the engine's own
  insert wrote `(id, workflow_name, status, input_json, output_json, error,
  started_at, finished_at)` and nothing else. So a workflow run's stored evidence
  cannot say who initiated it, and could not before M2C either.

Three facts bound the gap:

1. **It is not an M2C regression.** Verified against `c284867`: the engine passed
   `context.actor` to steps only (lines 88 and 131) and persisted it nowhere, and
   `writeTrace` behaved exactly as it does now. M2C preserves both byte for byte,
   which the three characterization harnesses independently confirm.
2. **Publishing nothing creates no new mutation capability.** The store is
   internal and unexported, and `packages/app/src/create-app.js` already hands
   every package the full `database` handle. The store is strictly narrower than
   what was already reachable.
3. **Closing it is milestone work, not a refactor's tail.** Attributing a
   workflow run needs a schema migration for a column that does not exist, a new
   startup-to-runtime decision about who the actor is when a run opens before its
   first step, and an audit-event policy for evidence rows. Each of those changes
   what the engine stores, which invalidates the byte-identical proof this
   milestone rests on — the same reasoning under which M2B recorded rather than
   implemented it.

Recorded here as inherited work, so the next milestone meets it as a decision
rather than rediscovering it as a surprise.

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
- **2026-08-27:** Walked the store's own surface after the first push rather
  than waiting for review, and it returned two real gaps. `error` was the one
  stored field with no check at all — the bounds exemption had been conflated
  with accepting anything — and the engine's store was `this.runs` on an object
  every in-process caller holds, now `#runs`. Both fixed with regressions.
- **2026-08-27:** CI `verify` and `public-claims` both passed at `c086ce2`,
  which retires the local full-tree run: that one had been confounded by the
  mutation harness editing source underneath it, and its ten failures were all
  in benchmark-fixture suites this PR does not touch.
- **2026-08-27:** Review at the exact head returned four inline findings, and
  the plain "no major issues" comment beside them made it easy to read as zero —
  the inverse of the trap in this repository's own review guidance. Checked the
  count rather than the comment. One P2 was already closed at that head by the
  `error` type check found in the self-sweep; one P2 was real and mine, and is
  fixed below; the two P1s were one finding stated twice.
- **2026-08-27:** A third review at `2c41ce0` — arriving *after* one that
  returned zero findings — caught the closed-shape check as the last invented
  refusal. Probing my own justification for it showed the justification was
  false: the `spans:`-for-`steps:` typo I cited is caught by the required-field
  rule, so the unnamed-key refusal only ever caught the harmless case while
  costing a successful operation its entire trace. Split into `ownedShape` and
  `suppliedShape`. Two lessons recorded rather than only applied: a rule correct
  in one store can be wrong in another with the opposite failure mode, and a
  clean review read is not the end of a pass.
- **2026-08-27:** Review at `821625d` returned two P2s, both stale prose that
  outlived the code it described — a plan bullet still stating the universal
  identity rule as the contract, and `assertOptionalMessage`'s own header still
  claiming a number reaches a driver refusal three lines above the code that
  coerces it. Rather than fix the two named sites, grepped the *concept* across
  both files and found a **third** the review had not named: the plan's mirror of
  that same numeric claim. All three fixed; the re-sweep is clean. The lesson is
  recorded above rather than only applied, because M2E-1 redefines a concept
  across thirteen declarations and will need the same sweep.
- **2026-08-27:** A fresh review at `00dc27d` — a review object rather than a
  comment — returned one P2, and it was the same defect one layer up: a bound
  whose stated justification did not match what the code does. `MAX_SPANS` was
  documented in `ctx.step` calls, a unit the store does not control, and was off
  by one against every caller by a different amount. Reproduced through
  `runRecordAction`, corrected in units rather than by reservation, and pinned by
  a boundary test that catches a one-off either way. Nothing executable in the
  store changed: the diff is comment-only.
- **2026-08-27:** Two more findings at the exact head, both real. The plan
  still carried the retired identity-rule bullet *above* its own correction, so
  a reader met a contract the head deletes — rewritten as history rather than
  removed, because the sequence is what stops the next agent restoring it. And
  category 2's "the driver would refuse anything but a string" was itself an
  unprobed assumption: `STRICT` `TEXT` coerces numbers and bigints. Probed,
  corrected, and pinned including the `"42.0"` byte the driver actually writes.
- **2026-08-27:** The integrator asked the generalising question — is each
  remaining bound protecting something the store *does*, or something I
  *assumed* it does — and named `startedAt` and span `name` as the neighbours to
  check first. Both were instances, and so were five more. Fixed as one
  principle rather than seven patches, and the class is closed: every refusal
  that remains sits in category 1, 2 or 3 above.
- **2026-08-27:** A fifth finding at the exact head, and the most serious one:
  the 200-character identity ceiling refused workflow names the framework's own
  validators accept, and the best-effort trace write swallowed the refusal, so an
  action succeeded with its whole trace missing. Reproduced first, fixed by
  narrowing the ceiling to minted ids, regression written before the fix and
  watched failing. The old "one rule, one bound" test asserted the behaviour that
  was wrong, so it was rewritten rather than deleted: it now pins the rule that
  survived and pins that long caller identity is *accepted*, with the rows to
  prove it.
- **2026-08-27:** Fixed the `Open PRs` row in `docs/PROJECT_STATUS.md`, which
  said `Measured at` names `e1ff9a0` while the row two lines above it and
  `site/claims.json` `measuredAgainst` both name `27cc663`. I had copied M2B's
  phrasing without re-checking it after the post-M2B measurement landed, leaving
  the canonical status snapshot contradicting itself about measurement
  provenance. The `e1ff9a0` on the milestone row is a different thing and stays:
  it is M2A's review-closeout commit, not a measurement.
- **2026-08-27:** Sharpened the actor/audit limitation after review raised it as
  a P1 twice. The finding is not an M2C regression — verified at `c284867` that
  the engine passed `context.actor` to steps and persisted it nowhere — but the
  earlier wording blurred the two consumers, claiming the actor is recorded in
  `input_json` when that is true of the action-runtime path and not of the
  engine's. The two now get separate sentences.
- **2026-08-27:** Added `packages/core/src/definition-version-store.js` to the
  three behaviour-bearing lists on the integrator's instruction, having first
  argued for deferring it. The instruction was right: the argument for adding
  M2C's store is identical for M2B's, and that gap is merged and live rather
  than hypothetical. Written up under *The receipts* as a defect found in M2B's
  evidence.
- **2026-08-27:** Baselined the workflow, action-runtime, pipeline, admin, API,
  MCP, scenario, package end-to-end and characterization suites at `c284867`.
  One pre-existing darwin-only failure in `tests/spine-v2-m0-characterization.test.js`
  (`/private/var` vs `/var` tmpdir realpath) was recorded and left alone: it is
  unrelated to this milestone and does not reproduce on CI's Linux runner. It is
  the same failure M2B recorded.

## A note on how the stale sentences got there

Worth recording, because the same trap is waiting in M2E-1. Validation was
removed here over **four passes** — the universal rule, then the ceiling, then
the whole caller-supplied class, then the numeric coercion — and the sentences
justifying each state were spread across a source file and this plan. Every pass
fixed the prose it was *looking at*, which is the prose adjacent to the code it
changed. The leftovers were the sentences a pass did not happen to be reading:
a bullet further down this file, and a function header three lines above the
code that refuted it.

Review found them by reading **forward from the concept** rather than backward
from the diff. That is the sweep to run deliberately whenever something is
deleted or redefined: `grep` the concept across every file that could describe
it, and check each hit against the head rather than against the change. Doing it
after this pair found no third instance, which is how the class was closed
rather than the instances patched.

**This applies directly to M2E-1**, where Option 4 redefines `capabilityContract`
across thirteen declarations in nine files, plus a homonym in `site/capabilities.json`
that means something else entirely. The concept sweep there is not optional.

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

**Both extraction stores were added to all three behaviour-bearing lists, and
that is a fix rather than an addition.** Those lists exist so that a change to a
file which decides a domain's behaviour stales the baseline. Moving behaviour
*out* of a hashed file and into an unhashed one leaves each baseline strictly
*less* sensitive than it was, and **nothing announces it** — the receipt goes on
passing while covering less. That is worse than a receipt that fails.

`packages/core/src/execution-run-store.js` is the instance this PR would
otherwise have caused: all three lists hash `packages/core/src/action-runtime.js`,
and `writeTrace`'s body moved out of it.

**`packages/core/src/definition-version-store.js` is the same defect, already
merged.** M2B moved the persist-or-verify loop out of three hashed registry
files into a store no list hashes, so until this PR a change to the ADR-015
drift refusal — the rule that decides whether an application starts — moved no
baseline hash at all. This was first written up here as follow-on work on the
grounds that retrofitting another milestone's omission enlarges a bounded slice.
That was the wrong call and the integrator was right to refuse it: the argument
for adding one store is *identical* for the other, the gap is live rather than
hypothetical, and shipping the fix for one instance while leaving its known twin
merged is exactly the shape this repository refuses elsewhere. Both are in all
three lists now, and the cost was one path per list inside a regeneration this
PR was already doing.

Recorded as a defect M2C found in M2B's merged evidence, not as M2C scope.

**The guard was watched failing, 26 times.** Every one of the thirteen spellings
was written into `packages/workflows/src/engine.js` and then into
`packages/core/src/action-runtime.js`, the guard was run, and it failed on all
26; each file was restored and the guard passes on the restored tree. A guard
nobody has watched fail is not a guard, and a guard watched failing in one file
says nothing about the other.

**The suite refuses the regressions it claims to.** Sixteen mutations were
written into the store, the engine and the trace writer, and every one was
caught: neutralising the identity rule, the `error` type check, the status
check, the closed-shape check and the own-field check; making `recordRun`
re-read the clock per span, or a recorded span borrow its own start; writing an
encoded `null` where an open run holds SQL `NULL`; validating `getRun`'s lookup
key; dropping the `listRuns` clamp, the span cap or the id self-collision check;
making `writeTrace` swallow its own failure; and, in the engine, dropping the
state a failed run records, the `workflowRunId` detail, or the reverse order of
compensation.

**A note on running that harness, because it bit once.** Each mutation restores
its file in a `finally`, which does not run when the harness itself is killed —
a two-minute command timeout left `if (collected.length >= MAX_SPANS)` reading
`if (false)` in the working tree. Caught by reading `git diff` against `HEAD`
rather than by trusting the harness, restored, and re-run to completion. A
source-mutating harness needs its tree checked afterwards, not assumed.

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
- **Closed here rather than deferred:** `packages/core/src/definition-version-store.js`
  was in none of the three characterization behaviour-bearing lists, so M2B's
  merged evidence silently covered less than it had. It is in all three now,
  beside `execution-run-store.js`. See *The receipts*.
- **Run and span persistence still carries no actor context and no audit
  event**, exactly as it did before M2C. Recorded above under *Known limitation,
  carried forward deliberately*.
