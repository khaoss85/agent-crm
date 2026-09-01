# Spine v4C — bounded observability export contract

## Goal and user-visible outcome

Accordo gains one closed, versioned contract for handing **bounded operational
evidence** to an observability system the deployment already runs. Three
materially different runtime families report through it — durable jobs and the
transactional outbox, PostgreSQL writer-lease readiness, and backup/verify/
restore — and every emission is validated against a **closed signal vocabulary**
before an exporter ever sees it.

This slice adds **no observability backend**. It stores nothing, aggregates
nothing, queries nothing and ships no dashboard, no log store, no APM, no
retention and no OTLP/OpenTelemetry support. It adds no production dependency.
It is not a second audit system: the security audit stays the database
authority, and telemetry can never rewrite business truth or stand in for an
audit write.

## Current repository context

- `packages/core/src/durable-jobs.js` owns the closed V3A job state machine
  (`DURABLE_JOB_STATES`), the ratified failure-code set and the explicit worker
  whose construction starts no timers. Every state transition already commits
  inside `inTransaction` next to an `AuditLog` write.
- `packages/core/src/transactional-outbox.js` owns the two closed V3B effect
  handlers (`TRANSACTIONAL_OUTBOX_EFFECTS`) and the one-shot
  `dispatchTransactionalOutboxJob`, which creates no persistent worker.
- `packages/core/src/postgresql-bootstrap.js` owns `describeWriterHealth`, the
  writer lease and the `writerGuard` that refuses writes when the lease is not
  held. Readiness is a **pull**: `health()` is asked, nothing is pushed.
- `packages/core/src/backup-restore.js` owns the V4B create/verify/restore
  operations and the closed restore outcome vocabulary.
- `packages/core/src/write-outcome-runtime.js#boundedFailureCode` is this
  repository's established rule for what may be written about a failure: a
  charset-validated, length-capped **code**, a structured transient flag, and
  the error class name when no code survives — never `error.message`, because a
  PostgreSQL constraint violation carries tenant ids and fingerprints in its
  text. That rule is the direct model for §Redaction below.
- `packages/app/src/create-app-async.js` composes no durable-job worker and no
  backup operations, but it **does** reach `bootstrapPostgresqlApplication`
  through `packages/app/src/async-lifecycle.js#startPostgresqlLifecycle` — so
  it composes the readiness producer. This slice still gives it no telemetry
  option, for a different reason than "nothing to instrument": who constructs a
  sink and who owns its shutdown order relative to the data plane is a
  lifecycle decision, and v4C leaves it to the composition that will own it.

## Approaches considered

1. **A generic event bus with a redaction filter.** Rejected. A denylist over
   arbitrary payloads is a leak waiting for the first producer that adds a
   field, and this repository has already recorded that a bounded-looking error
   string carried tenant ids. A filter also cannot fail closed: it silently
   ships whatever it failed to recognise.
2. **OpenTelemetry / OTLP as the contract.** Rejected for v1. It is a large
   dependency tree against AGENTS.md rule 6 (a production dependency must
   remove more complexity than it adds), it brings its own global provider,
   context propagation and shutdown lifecycle — exactly the hidden background
   process this slice refuses — and the repository has zero production
   dependencies beyond the pinned `pg` adapter, a fact `scripts/repo-truth.js`
   asserts. **No OTLP or OpenTelemetry support is claimed anywhere.** The
   contract is kept adapter-shaped (`emitLog` / `emitMetric` / `emitRun` /
   `flush` / `close`, flat string-keyed attributes, bounded scalars) so a later
   OTLP adapter can be written outside the kernel without a contract change.
3. **A closed signal vocabulary with per-attribute value validators, an
   injected exporter and an application-owned lifecycle.** Chosen. A signal not
   in the frozen registry is refused; an attribute key not declared for that
   signal is refused; a value that fails its declared kind is refused. Refusals
   are counted, never emitted. Leak safety is then a property of the *shape* of
   what may be said, not of a filter over what a caller happened to pass.

## The contract

`packages/core/src/observability-export.js`, `TELEMETRY_EXPORT_CONTRACT = 1`.

**Exporter** (`defineTelemetryExporter`), closed shape:

| Operation | Required | Meaning |
|---|---|---|
| `name` | yes | bounded NAME identifier |
| `contract` | yes | must equal 1 |
| `emitLog(record)` | yes | a discrete bounded state observation |
| `emitMetric(record)` | yes | a bounded numeric measurement with a unit |
| `emitRun(record)` | yes | a completed bounded unit of work with an outcome |
| `flush()` | no | best-effort delivery of what is in flight |
| `close()` | no | release exporter resources |

Three emit operations, each with a real producer and no overlap:

- `emitRun` — durable-job execution, outbox dispatch, backup operation. These
  are units of work: they have an outcome and a duration.
- `emitLog` — job claim, worker error, PostgreSQL readiness. These are discrete
  observations: no unit of work, no duration.
- `emitMetric` — writer-lease remaining milliseconds, and the sink's own
  `dropped` / `rejected` / `exporter_failed` counters. A backpressure counter
  that only `status()` can see is invisible to the system that needs it; a
  counter is not run-shaped and would be a lie as either of the other two.

`emitSpanOrRun` is named `emitRun` because this repository already has run
vocabulary (`execution-run-store.js`) and implements no span context
propagation. Calling it a span would claim tracing that does not exist.

**Sink** (`createTelemetrySink({ exporter, maxInFlight?, flushTimeoutMs?,
closeTimeoutMs? })`) is the only thing producers touch. It validates, bounds,
isolates failure and owns the deadlines. It returns
`{ contract, emitLog, emitMetric, emitRun, flush, close, status }`, frozen.

**Built-in exporters**: `createNoopTelemetryExporter()` (the default when a
producer is given no sink — nothing is emitted, and no record is built per
signal; see the L7 note below on why that is not the same as allocating nothing),
`createJsonStderrTelemetryExporter()` (one JSON line per record on **stderr**,
per the repository's "stdout is reserved for JSON-RPC" convention) and
`createCaptureTelemetryExporter()` (a bounded in-memory ring for tests).

### The closed signal registry

| Signal | Kind | Attributes |
|---|---|---|
| `accordo.durable_job.claimed` | log | `kind`, `handler`, `attempt` |
| `accordo.durable_job.worker_error` | log | `errorCode` |
| `accordo.durable_job.execution` | run | `kind`, `handler`, `state`, `attempt`, `durationMs`, `errorCode?` |
| `accordo.transactional_outbox.dispatch` | run | `effect`, `outcome`, `attempt`, `durationMs`, `errorCode?` |
| `accordo.postgresql.readiness` | log | `adapter`, `ready`, `reason?` |
| `accordo.postgresql.writer_lease_remaining_ms` | metric (`ms`) | `adapter`, `ready` |
| `accordo.backup.operation` | run | `operation`, `outcome`, `durationMs`, `errorCode?` |
| `accordo.telemetry.dropped` | metric (`count`) | — |
| `accordo.telemetry.rejected` | metric (`count`) | — |
| `accordo.telemetry.exporter_failed` | metric (`count`) | — |

## Redaction — the heart of the slice

Attributes are a **flat** map. Nested objects and arrays are refused outright,
so there is no recursive structure for a payload to hide in. Each declared
attribute has one of four value kinds, and nothing else is representable:

| Kind | Rule | Why it cannot leak |
|---|---|---|
| `enum` | member of a kernel-enumerated frozen set (`DURABLE_JOB_STATES`, `TRANSACTIONAL_OUTBOX_EFFECTS`, backup outcomes, adapters, operations) | the set is closed in source; no caller value can enter it |
| `code` | `/^[A-Z][A-Z0-9_]*$/`, ≤ 64 chars | the `boundedFailureCode` charset. A URL, a path, an email, a UUID, a password or a tenant slug cannot match it — lowercase, `.`, `/`, `:`, `-`, `@` and `=` are all rejected |
| `name` | `/^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/`, ≤ 64 chars | the existing `boundedName` identifier rule, used only for **code-authored** registration identifiers (job kind, handler name, adapter) |
| `number` / `boolean` | finite safe integer within ±2^40, or a boolean | carries no text |

**Never exported, deliberately, and each proved by a sentinel in the leak scan:**

- database URL, host, port, user, password, and any connection locator;
- secret values and secret references;
- provider credential material and native-tool arguments or environment;
- raw HTTP bodies and any domain payload (`job.payload` never reaches a signal);
- `error.message` — only `boundedFailureCode`-shaped codes;
- filesystem paths, including backup bundle paths;
- **tenant ids, tenant fingerprints, resource/migration/repository fingerprints
  and binding uuids**;
- **`idempotencyRoot`, `outcomeReference`, `workerId` and the job `id`.**

The last two bullets are the deliberate, load-bearing exclusions and are worth
stating plainly, because they cost the contract something real:

- Tenant identity is leak material in this repository by precedent — the
  `boundedFailureCode` comment says so in as many words — and a fingerprint is
  a stable pseudonymous identifier, not an anonymisation.
- `idempotencyRoot` and `outcomeReference` are caller-chosen bounded text. A
  length cap does not stop a domain from putting a customer email in one.
- `workerId` is deployment-chosen and, in `write-outcome-runtime.js`, is
  literally constructed as `write-outcome-<runId>`.
- The job `id` is a durable key into tenant-scoped rows. The audit log already
  correlates it, behind authorization; telemetry has none.

**The stated consequence:** v1 telemetry is *aggregate-shaped*, not per-record
traceable. An operator can see that outbox dispatch is failing with
`JOB_HANDLER_TEMPORARY_UNAVAILABLE` on kind `outbox`, and cannot see which
tenant or which job. A control plane that needs correlation must ask for it in
a later, deliberately authorized contract version. That is a limitation of
this slice, recorded as one.

## Failure and backpressure, stated exactly

- **Non-security telemetry is best effort.** `emit*` returns a boolean and
  never throws. No producer awaits it. An exporter that throws or rejects
  increments `failed`; the business path is untouched.
- **Bounded in-flight set, not a batching buffer.** The sink dispatches
  immediately and tracks any returned promise in a set capped at `maxInFlight`
  (default 256). At capacity the signal is dropped and `dropped` increments.
  There is no queue to grow, no timer to schedule and no batch to lose.
- **Drop count observable** two ways: `sink.status()` in process, and the
  `accordo.telemetry.dropped` / `rejected` / `exporter_failed` cumulative
  counters emitted once per `flush()`/`close()` when non-zero. Counters are
  emitted only from `flush`, never from `emit`, so they cannot recurse.
- **Exporter failure never claims a business rollback.** A telemetry failure
  produces a counter and nothing else — no error, no audit row, no state change.
- **`flush()` and `close()` each have a deadline**, implemented with the same
  `Promise.race` + `clearTimeout`-in-`finally` shape as
  `durable-jobs.js#drain`, so a hung exporter cannot hang application shutdown
  and no timer is leaked. They return
  `{ flushed|closed: boolean, code?: 'TELEMETRY_FLUSH_TIMEOUT'|'TELEMETRY_CLOSE_TIMEOUT', ... }`.
- **`close()` is idempotent and memoized**: the exporter's `close` is called at
  most once; a second call returns the first result without touching it. After
  close, `emit*` is a no-op that counts a drop.

## Lifecycle is explicit and application-owned

Constructing a sink starts nothing: no timer, no socket, no interval, no
process. `packages/app/src/create-app-async.js` gains **no** telemetry option in
this slice. The reason is *not* that it composes nothing instrumentable — it
reaches `bootstrapPostgresqlApplication` and therefore composes the readiness
producer. The reason is that ownership of a sink's construction and shutdown
order is a lifecycle decision this slice deliberately does not make. The
application constructs a sink, passes it to the runtime objects it constructs
explicitly, and closes it in its own shutdown order.

**Measured consequence.** `startPostgresqlLifecycle` forwards a closed option
list that does not include `telemetry`, so `accordo.postgresql.readiness` and
`accordo.postgresql.writer_lease_remaining_ms` are **unreachable from every
supported composition** — not merely un-wired. Only a direct call to
`bootstrapPostgresqlApplication` emits them, which is exactly what the hosted
test does. They are implemented and proven, and no application can turn them on
until that option list grows.

## Milestones

1. `observability-export.js`: contract, closed registry, value kinds, sink with
   bounded in-flight/deadlines/idempotent close, three built-in exporters,
   `telemetryVocabulary()` for the truth probe, and the thin producer report
   adapters (each wrapped so a malformed producer call is refused, not thrown).
2. Wiring, one optional `telemetry` key added to three existing closed option
   lists: `createDurableJobWorker`, `registerTransactionalOutboxHandlers` /
   `createTransactionalOutboxWorker` / `dispatchTransactionalOutboxJob`,
   `bootstrapPostgresqlApplication` and `createBackupOperations`. **No emission
   happens inside an `inTransaction` block or beside an audit write** — job
   signals are reported from the worker after the store call has settled, and
   readiness from a one-boolean edge detector.
3. Evidence: deterministic tests for the eight required items, plus the
   sentinel leak scan and one mutation run per guard.
4. Repository Truth fact + new scoping limitation code, Legacy Alignment Matrix
   section with a row per domain, ADR in `DECISIONS.md`, `index.js` export.

### On the readiness edge detector and "no parallel state"

`bootstrapPostgresqlApplication` keeps **one boolean** — the readiness last
reported — so a `writerGuard` refusal storm emits one transition instead of one
signal per refused write. That is de-duplication, not a second source of truth:
the writer lease row remains the only authority, the boolean is derived from
`describeWriterHealth` on every read, and deleting it changes signal volume and
nothing else. No table, no column and no file is added by this slice.

## Validation

Node 22.16.0 via `fnm exec --using=22.16.0`. One test file at a time.

- `node --test tests/spine-v4c-observability-export.test.js`
- `node --test tests/spine-v4c-observability-export-postgresql.test.js`
  (`ACCORDO_TEST_POSTGRES=1`, port 5546)
- `node --test tests/spine-v3a-durable-jobs-sqlite.test.js`
- `node --test tests/spine-v3b-transactional-outbox-sqlite.test.js`
- `node --test tests/spine-v4b-backup-restore.test.js`
- `node --test tests/characterization/signature-characterization.test.js`
- `node --test tests/actor-fails-closed.test.js`
- `npm run check`
- `npm run repo:truth -- --check`

## Progress log

- 2026-09-01: worktree clean at `2c8bc33`; branch
  `claude/spine-v4c-observability-export` checked out. Read the V4B and V3B
  ExecPlans, `durable-jobs.js`, `transactional-outbox.js`,
  `write-outcome-runtime.js#boundedFailureCode`, `postgresql-bootstrap.js`
  readiness/lease, `backup-restore.js` options, `create-app-async.js`, the
  `scripts/repo-truth.js` probe and fact halves, and the V4B matrix section.
  Selected approach 3. Confirmed the default async factory composes none of the
  three producer families, so it needs no telemetry option.

## Decision log

- OTLP/OpenTelemetry is **not** implemented and **not** claimed. The contract
  is kept adapter-compatible so a later OTLP exporter is a package outside the
  kernel, not a contract change.
- Fail-closed validation: an unknown signal, an undeclared attribute key or a
  value failing its kind refuses the **whole record** rather than dropping the
  offending key. Silently stripping a key hides a producer bug; a counted
  rejection surfaces it.
- Attributes are flat. There is no nested value kind, so there is no recursive
  path a payload can take.
- No identifier of any record — tenant, job, run, worker or outcome — is
  exportable in v1. Stated as a limitation, not as a capability.
- The sink's own counters are emitted only from `flush`/`close`, cumulative, so
  telemetry about telemetry cannot recurse and needs no delta state.
- The `adapter` enum admits `sqlite` although no SQLite producer exists. Enum
  membership is representability, not a claim: the readiness signal is emitted
  only from the PostgreSQL bootstrap, and naming the other adapter the storage
  contract has keeps a future SQLite readiness signal from needing a contract
  version to say `sqlite`.

## Progress — 2026-09-01 implementation and evidence

Implemented as planned, with three decisions the code forced that the plan had
not settled:

1. **`defineTelemetryExporter` refuses any field outside the five contract
   operations.** The capture exporter therefore returns its inspection API
   *beside* the exporter (`{exporter, records, signals, overflowed}`) rather
   than on it. Strictness costs an integrator a thin adapter and buys a
   checkable property: an exporter is exactly this and nothing else.
2. **Outbox dispatch reports `outcome: succeeded|failed`, not a job `state`.**
   A dispatch handler knows only whether its own attempt settled; whether the
   job is retryable is the worker's decision, already carried by
   `accordo.durable_job.execution`. Reusing the job state enum there would have
   put a classification into telemetry that no authority made.
3. **The transactional-outbox tests moved to the hosted file.** Write outcomes
   are PostgreSQL-only by contract, so there is no committed effect to dispatch
   on SQLite and the dispatch signal cannot be proved there.

### Guard coverage, by mutation

Every guard was removed or weakened one at a time and the suite re-run; each
turned red, and each was restored. A guard with no failing mutation is not
covered, and this is how V4B found a security fence that was deletable with
eighteen tests still green.

| Mutation | Result |
|---|---|
| unknown-signal check | RED (2) |
| undeclared-attribute-key check | RED (1) |
| required-attribute check | RED (1) |
| attribute value-kind validation | RED (1) |
| `code` charset | RED (1) |
| `name` charset | RED (2) |
| number bound | RED (1) |
| envelope closed-key check | RED (1) |
| signal-kind channel check | RED (1) |
| bounded in-flight drop | RED (1) |
| post-close drop | RED (1) |
| exporter sync-throw isolation | RED (1) |
| exporter async-rejection isolation | RED (1) |
| flush/close deadline race | RED (6) |
| close memoization | RED (1) |
| deadline `clearTimeout` | RED (1) |
| readiness edge detector | RED (1) |
| `telemetryErrorCode` charset | RED (1) |
| exporter closed-field check | RED (1) |
| job claimed reporting | RED (5) |
| job execution reporting | RED (5) |
| outbox dispatch instrumentation | RED (2, hosted) |
| backup operation instrumentation | RED (2) |

Two of those were green on the first pass and are worth recording, because both
were real gaps rather than tooling noise:

- **`telemetryErrorCode`'s charset had no test.** Nothing distinguished
  returning `null` from returning the raw `error.code`, because the sink's own
  `code` kind would refuse the record either way. The behavioural difference is
  what matters and is now pinned: with the charset, a junk code is *omitted*
  and the run still reports; without it, the whole record is refused and the
  operational signal is lost along with the leak.
- **The outbox instrumentation mutation ran against the wrong file** until the
  dispatch tests were pointed at the hosted suite.

One mutation result was also mis-read at first: removing the flush/close
deadline race printed `# fail 0` because an aborted run prints its summary
after its `not ok` lines. It fails six subtests. The detection now counts
`not ok` lines rather than trusting that summary.

### Deliberately not done

- **The default PostgreSQL write path is not instrumented.**
  `write-outcome-runtime.js` calls `dispatchTransactionalOutboxJob` for
  post-commit recovery without a sink, because its options come from
  `runIdempotentWrite`'s closed spec, which has no telemetry key. Threading one
  through the hot write path is a wider change than this slice needs and would
  put a telemetry parameter on every kernel write. An application that composes
  its own outbox worker gets the signals; the inline recovery dispatch does not.
- **`createAccordoAppAsync` gains no telemetry option**, for the reason in
  §Lifecycle — which is *not* "it composes nothing instrumentable". It reaches
  `bootstrapPostgresqlApplication` and therefore composes the readiness
  producer. Ownership of a sink's construction and shutdown order is the
  lifecycle decision this slice declines to make.
- **No exporter for any real backend.** No OTLP, no vendor SDK, no HTTP
  exporter. `json-stderr` is the self-host default and the rest is the
  deployment's business.
- **No CLI, MCP tool, operator surface, dashboard, alert or retention policy**,
  and no agent-facing command or namespace at all.

### Verification run, exactly

Node 22.16.0 via `fnm`, one file at a time, PostgreSQL 16 on port 5546.

| Command | Result |
|---|---|
| `node --test tests/spine-v4c-observability-export.test.js` | 17 pass, 0 fail |
| `node --test tests/spine-v4c-observability-export-postgresql.test.js` | 3 pass, 0 fail |
| `node --test tests/spine-v3a-durable-jobs-sqlite.test.js` | 27 pass, 0 fail |
| `node --test tests/spine-v3a-durable-jobs-postgresql.test.js` | 2 pass, 0 fail |
| `node --test tests/spine-v3b-transactional-outbox-sqlite.test.js` | 9 pass, 0 fail |
| `node --test tests/spine-v3b-transactional-outbox-postgresql.test.js` | 10 pass, 0 fail |
| `node --test tests/spine-v4a-secrets-provider.test.js` | 13 pass, 0 fail |
| `node --test tests/spine-v4b-backup-restore.test.js` | 20 pass, 0 fail |
| `node --test tests/spine-v2-m4b-leases-tenant-authority.test.js` | 12 pass, 0 fail |
| `node --test tests/spine-v2-m3c-postgresql-application.test.js` | 11 pass, 0 fail |
| `node --test tests/characterization/signature-characterization.test.js` | 23 pass, 0 fail — the baseline did not move |
| `node --test tests/actor-fails-closed.test.js` | 8 pass, 0 fail — no system authority is claimed |
| `npm run check` | 470 files, passed |
| `npm run gtm:check` | passed |
| `npm run repo:truth -- --check` | 51 facts, 108 citations, every bound claim agrees |

`tests/spine-v4b-backup-restore-postgresql.test.js` reports 1 pass / 3 fail on
this host and did so before this branch existed: `psql`, `pg_dump` and
`pg_restore` are not installed here, so the suite refuses with
`BACKUP_TOOL_UNAVAILABLE` and `spawn psql ENOENT`. That is an environment gap,
not a regression, and CI provisions the client tools.

`npm run verify` was **not** run despite AGENTS.md rule 7: it executes the
whole suite in one process and this host has 16 GB, where the campaign rule is
one test file at a time. `npm run check` plus the file-by-file runs above stand
in for it, and the gap is stated rather than hidden.

## Progress — 2026-09-01 post-red-team: the sink/exporter seam

Integration review asked whether `telemetry` should be validated at the
producer seams, describing it as an ambiguous contract rather than a defect and
leaving the decision open. Probed rather than reasoned about, it was a defect,
and a worse one than the question implied.

`createDurableJobWorker({ ..., telemetry: <a raw exporter> })` constructed
without complaint, and running one job **terminated the process** with an
unhandled rejection. The mechanism: `report()` called `exporter.emitLog(input)`
directly, so the returned promise reached a caller that never awaits it. Two
guarantees this slice makes were false in that configuration —

- *"non-security telemetry is best effort"*: a telemetry backend going down
  took the application with it, which is the exact inverse;
- *"the allowlist validates every emission"*: the exporter received the raw
  `{signal, attributes}` envelope, which `validateSignal` had never seen.

Every containment in this design lives in the sink. An exporter is the thing
the sink wraps, and handing one to a producer silently removes the allowlist,
the bounded in-flight set, rejection capture, both deadlines and the post-close
drop, all at once.

Fixed at the boundary rather than defended at the call site:

- `isTelemetrySink()` discriminates by shape — a sink carries `status` and
  always carries `flush`/`close`; an exporter carries `name` and may carry
  neither.
- `requireTelemetrySink(value, refuse)` refuses anything else at
  **construction**, in each caller's own refusal register: `ValidationError` in
  durable-jobs and the outbox, `refuse('POSTGRESQL_TELEMETRY_INVALID', …)` in
  bootstrap, `refuse('BACKUP_TELEMETRY_INVALID', …)` in backup-restore. A
  misconfigured wiring now fails where it was written, not under load. When the
  value looks like an exporter the message says so, because that is the mistake
  a composer will actually make.
- `report()` swallows any thenable settlement and returns `false`. A valid sink
  emits synchronously, so this changes nothing today; it makes "an emission
  never throws into a producer" a property of that function rather than a
  promise about its callers.

Five further mutations, all RED: the `isTelemetrySink` discriminator, the
`requireTelemetrySink` refusal, the `report` thenable swallow, and the
durable-jobs and backup seams. **28 guards, 28 covered.**

Re-verified after the fix: V4C 20 pass · V4C hosted 3 pass · V3A SQLite 27 ·
V3B SQLite 9 · V3B hosted 10 · V4A 13 · V4B deterministic 20 · M4B hosted 12 ·
characterization 23 (baseline unmoved) · `npm run check` 470 files ·
`npm run repo:truth -- --check` clean. The truth document needed a regenerate
whose diff is **only** `sourceSha`, with the fingerprint unchanged — no fact
moved, which is exactly the case the campaign rule allows regenerating.

## Progress — 2026-09-01 broad review, both reviewers

Two independent reviews. The leak finding is the one that matters: it
falsified a written guarantee, and it was found by executing, not by reading.

### F1 — the value validated was not the value exported (HIGH, fixed)

`validateSignal` read each attribute twice — once for `attributeAllowed`, once
for `exported[key]`. An accessor returns a different value each time, and the
reviewer demonstrated all three consequences: arbitrary free text carrying a
tenant id and forged JSON reaching the stderr line with `emitLog` returning
`true`; a nested object landing inside a record this contract calls flat, when
no attribute kind accepts an object at all; and an exception escaping
`sink.emitLog` itself, because the second read sat outside every `try` — the
producers were covered by `report()`, the public sink was not.

The envelope and its attributes are now copied into data-only snapshots
(`dataSnapshot`) before any check runs, on the pattern
`durable-jobs.js#closedJobInput` already establishes: every own property must be
an enumerable data property, read exactly once, there. Every later check reads a
local, so the value validated *is* the value exported, by construction.

**Which half is the security fix, stated precisely, because the mutation runs
made the distinction visible.** Reading once is what prevents the leak: with a
single read and no accessor refusal, a two-faced getter's first value is both
validated and exported, which is correct if strange. Refusing accessors is the
stricter fail-closed policy layered on top, justified because no legitimate
producer passes one. Consequently the accessor refusal is **not independently
mutation-observable** — remove it alone and `descriptor.value` is `undefined`,
which the allowlist rejects anyway; remove the snapshot and the single-read
property goes with it, which *is* observable. Both snapshots are covered
(mutations G24, G25 red); the accessor check is a redundant layer and is
recorded as one rather than dressed up as covered.

No test had touched accessors: `grep defineProperty` over the test file
returned nothing, and the leak helper used `inspect(..., {getters: false})`, so
it could not have seen one. There is now a test that smuggles free text, a
nested object, an array and a locator through a two-faced getter, one that
throws from a getter, and one that does it on the envelope rather than the
attributes.

### F2 — `kind` and `handler` are caller-chosen (MEDIUM, declared)

The registry typed both as a bounded identifier, and the module doc generalised
"no attribute kind can carry free text" to the whole fence. Neither was true of
these two: `enqueue` bounds them with `boundedName` and checks no membership
against the handler registry, and the claim signal is reported before any
handler is resolved — so `kind: 'f47ac10b-…'` and `handler: 'someone.surname'`
pass and are exported verbatim.

Declared rather than pattern-matched. Refusing uuid-shaped or address-shaped
values would be a denylist, which is the thing this design exists to refuse;
closing it properly means checking registry membership at the seam, which is a
v2 contract change. The kind is renamed `CALLER_NAME_KIND` so the boundary is
legible where the registry is read, the module doc no longer promises more than
the fence delivers, ADR-043 states it, and a test pins the current behaviour so
a future narrowing has to change a test deliberately.

### M1 / M2 — a false reason, repeated four times

ADR-043, this plan twice, and the `3316781` commit message all said the default
async factory "composes none of the three producer families, so there is nothing
to instrument". False: `createAccordoAppAsync` → `startPostgresqlLifecycle` →
`bootstrapPostgresqlApplication`, which is the readiness producer — and this
plan's own matrix row for Core CRM says `partial` *because* PostgreSQL readiness
is on that path. The conclusion survives, the reasoning does not, and a false
reason is worse than a false fact because it would justify never wiring that
seam. Corrected here and in the ADR; the `3316781` commit message is history and
carries the superseded wording.

M2 is the consequence: `startPostgresqlLifecycle` forwards a closed option list
without `telemetry`, so the two PostgreSQL signals are **unreachable**, not
merely un-wired. Recorded in the ADR, this plan and TASKS.

### The LOW findings, and what was done with each

| # | Finding | Disposition |
|---|---|---|
| L1 | a wedged exporter poisons the sink permanently — no eviction, so drops never end | **declared** in the code and ADR-043; eviction needs a timer per emission, which is the timer-free property the sink rests on |
| L5 | outbox `dispatch: succeeded` is emitted before `store.succeed` commits | **declared** at the wrapper: it reports the handler attempt; `durable_job.execution` is the committed authority |
| L4 | the release path reported an execution, with a real duration, for a job that never ran | **fixed** — a released job reports no execution |
| L2 | `flush()` after `close()` claimed `flushed: true` beside a non-zero `inFlight` | **fixed** — it reports the truth, with `TELEMETRY_SINK_CLOSED` |
| L3 | an emission during the drain could enter the in-flight set behind its snapshot | **fixed** — the sink stops accepting when the drain starts |
| L6 | bootstrap validated telemetry after pools, attestation and lease | **fixed** — validated first, like the other three seams |
| L8 | `openTelemetry: false` had no equivalent for the identifier exclusion | **fixed** — `exportsRecordIdentifiers: false` |
| L9 | the registry JSDoc was attached to `TELEMETRY_RUN_STATES` | **fixed** |
| L7 | cosmetic | not acted on — the finding as relayed carries no detail to act on; ask the reviewer |

### Mutation verification of the new guards

| Mutation | Result |
|---|---|
| envelope snapshot removed | RED |
| attributes snapshot removed | RED |
| closed-sink flush honesty (L2) | RED |
| drain stops accepting (L3) | RED |
| `exportsRecordIdentifiers` marker (L8) | RED |
| released job reports no execution (L4) | RED |
| bootstrap validates telemetry early (L6) | RED |
| accessor refusal removed alone | **GREEN — redundant layer, see F1 above** |

Twenty-eight guards from the first two commits remain covered; seven of the
eight new mutations are red, and the eighth is recorded as a redundant layer
rather than claimed.

## Progress — 2026-09-01 close-out: L7, and a fourth case for the method note

**L7, chosen wording over code.** `postgresql-bootstrap.js` constructs the
readiness observer — one closure, one frozen object — on every boot regardless
of whether telemetry was supplied, so "with no sink composed, nothing is
allocated" was very slightly overstated. Every emit path is a no-op exactly as
claimed; only the allocation happens anyway. Making it lazy would add a branch
to a startup path to save one object per process, so the sentence is corrected
rather than the code: the guarantee is that nothing is **emitted**, which is the
half anything depends on. Recorded because the difference between "no cost" and
"no emission" is precisely the kind of small over-claim this repository's
gates cannot see.

### The method note, now with four cases

Reading gave green on something execution broke, four times in this campaign,
and it is worth writing down where it will be read again:

1. **V4B's restore fence** was deletable with all eighteen tests passing. An
   independent reviewer found it — someone who had not written it.
2. **The V4C sink accepted a raw exporter** and ended the process with an
   unhandled rejection on the first job. Integration review formulated it; a
   probe proved it. Reading the same code had left it standing.
3. **The V4C allowlist validated one value and exported another.** A reviewer
   executed a two-faced getter and got free text, a nested object into a record
   the contract calls flat, and an exception out of the public sink. Three
   consequences, none visible by inspection.
4. **V4B's hosted lane could never have restored anything**, because
   `pg_restore --schema` filters the objects inside a schema and never emits the
   schema itself. Found by the integration Lead by rebuilding dump, render and
   apply inside a real container — invisible to any amount of reading, and
   hidden behind a provider boundary in every failure message.

The shape they share is that each one *looked* correct, and the gates agreed.
Three of the four were found by someone who had not written the code, and the
fourth by replaying the real flow instead of the described one. Neither is a
substitute for tests; both are what tests are checked against.

## Progress — 2026-09-01 delta review: a bypass, and a claim of mine that was wrong

Two material findings, and the second corrects the record rather than the code.

### M1 — `__proto__` walked through the TOCTOU fix (fixed)

`snapshot[key] = descriptor.value` does not create an own property when `key`
is `__proto__`: it reaches `Object.prototype`'s accessor and replaces the
snapshot's prototype. An envelope whose only own key was `__proto__` therefore
produced a snapshot with **no own keys at all** — the closed-key check had
nothing to refuse — and `signal`, `attributes` and `value` were then read
through getters the caller had supplied on the injected prototype. Reproduced
here before fixing, both halves:

```
own keys of the envelope: [ '__proto__' ]
emitLog(envelope whose only own key is __proto__) -> true
captured: [{"signal":"accordo.durable_job.claimed", ...}]
!!! EXCEPTION ESCAPED THE PUBLIC SINK: ESCAPED-FROM-PUBLIC-SINK
```

So one of the three damages `5cc4778` claims to have closed was open again by
another route. Fixed by giving each snapshot a **null prototype**, which is a
property of the object rather than a list of special keys to remember, plus
`Object.defineProperty` for the exported attribute map and a `try` around
`validateSignal` inside `emit`. Three tests pin it: the `__proto__`-only
envelope, a getter reaching `emit` through it, and `__proto__` as an ordinary
undeclared attribute key. Both fixes are mutation-red.

Note for a future reader: the test previously named *"a prototype-polluting
emission"* used `Object.create({...})`, which `plainObject` already refused. It
covered the variant that does not work and missed the one that does.

### M2 — the eighth mutation is observable, and my stated reason was wrong

The previous entry recorded the accessor refusal as "not independently
mutation-observable", reasoning that removing it leaves `descriptor.value ===
undefined`, which every attribute kind rejects. That reasoning was sound for
every case I considered and **I did not consider the one that matters**: the
three zero-attribute metric signals. There, an accessor on `attributes` itself
collapses to `undefined`, `?? {}` turns it into a valid empty set, `required` is
empty so nothing can be missing, and the record is accepted. Original against
mutated, run here:

```
ORIGINAL accessor-attributes envelope -> false []
MUTATED  accessor-attributes envelope -> true  [{"signal":"accordo.telemetry.dropped","value":4,"attributes":{}}]
```

The mutation is now red, against a test that exercises all three signals.

**The formulation that replaces the old one, and it is the durable part:
"not covered by a test we wrote" is not "not observable".** The first is a fact
about our tests; the second is a claim about the code, and it is much stronger
than the evidence a green mutation supplies. `5cc4778`'s message carries the
superseded claim and is left as history.

There is a second-order lesson worth recording beside it. Before the review I
had verified my own claim, found it confirmed, and deliberately withheld that
verification from the reviewer to avoid anchoring her. That was the right call
and this is the proof: had she received my map, she would have been checking
it — and my map did not contain the zero-attribute signals.

### The two guards that stayed green, stated on the corrected terms

Neither is claimed as "not observable". Each is what was actually tested:

- **`Object.defineProperty` on the exported attribute map.** No current input
  reaches it: attribute keys are filtered by `Object.hasOwn(declared.attributes,
  key)` first, and no declared signal names `__proto__`. It guards a future
  registry-authoring mistake, not a caller.
- **The `try` around `validateSignal`.** Empirically nothing escapes without it
  once the null-prototype fix is in place — four hostile Proxy shapes
  (`ownKeys`, `getOwnPropertyDescriptor`, an accessor descriptor, and a `get`
  trap) and the `__proto__` getter were all run against the module with the
  `try` removed, and every one returned `false` rather than throwing. It guards
  a future regression, and it is why the public-surface guarantee is now a
  property of the function rather than an argument about its callers.

## Progress — 2026-09-01 delta review, second batch: three claims, no code defects

M2, M3 and M4 share one shape and it is worth naming: each is a **statement of
having done something that was not done**. None is a code defect.

- **M2** — a mutation declared unobservable, on reasoning that held for every
  case considered and missed the one that mattered.
- **M3** — a false reason declared "corrected here and in the ADR" while it
  survived in the plan's own *Decision log* eleven lines away, and in
  `TASKS.md` — a **fifth** site the enumeration of four never contained.
- **M4** — the identifier exclusion declared "machine-readable" in a commit
  that never touched `scripts/repo-truth.js`. The published limitation still
  read *"v1 exports no tenant, record or run identifier"* with no
  qualification, contradicting `CALLER_NAME_KIND` in the same slice.

M4 is the one that mattered most, and the reviewer's distinction is the reason:
for a **human** reader the exception was declared in every place they would
look — module doc, the kind's own JSDoc, TASKS, ADR, a dedicated test. For the
**consumer reading the generated fact** it was not declared anywhere, and that
is the only *contractual* surface of the two.

A fourth surface carried the same absolute and was not in the finding:
`telemetryVocabulary().exportsRecordIdentifiers` was the boolean `false`,
introduced by the very commit that claimed machine-readability. Its comment
qualified it; its value did not, and a machine reads the value. Fixing only
what was reported would have repeated M4 one field to the left. It is now
`'kernel-filled-attributes-only'` with `callerNamedAttributes: ['handler',
'kind']` beside it — a shape that cannot be read as an absolute — and a test
derives that list from the registry, so adding a third caller-named attribute
without updating it turns red. The truth probe rests on the qualified shape,
so the published fact cannot regress to the unqualified one.

L1 is the same failure in miniature: the JSDoc listing the deliberately
excluded attributes was attached to `TELEMETRY_RUN_STATES`, and `5cc4778`
added the pointer to `CALLER_NAME_KIND` — the exception — onto the symbol
nobody opens. Re-homed onto `TELEMETRY_SIGNALS`.

**What this batch says about the register.** Three of five findings were the
record over-stating the work, and none would have been caught by any gate: a
commit message is prose, and the only reader who checks it is a person reading
the diff beside it. That is the argument for why this repository reviews the
message as closely as the change.

## Progress — 2026-09-01 the sentinel that was too convincing

GitGuardian failed on `f299da1` with one finding, and it was the leak-scan
sentinel: `postgresql://operator:hunter2@db.internal.invalid:5432/accordo`.

The useful part is not "a fake password was used". `hunter2` appears five times
in this repository and has never tripped anything — including
`postgres://u:hunter2@h/db` in `tests/project-verify.test.js` and a comment in
`packages/cli/src/project-verify-command.js` calling it *"the commonest secret
in a connection string"*. **A secret scanner judges the shape of a string, not
whether the value is real**, and the existing occurrences are stripped to the
bone — one-character user, one-character host, no port, no database name —
while this one had a plausible user, an FQDN, a port and a real database name.
It was flagged because it was better built.

Which is an ironic compliment to the test: the sentinel worked *because* it was
realistic, and that is exactly why it was picked up.

Aligned to the form the repository already carries and that already passes, with
the reason written beside it so a later author does not "improve" it back. **No
assertion weakens.** Nothing here depends on the sentinel being plausible: the
leak scan needs it to be *unique*, and the two refusal tests need it to fail the
NAME and CODE charsets, which a minimal connection string does just as
completely — verified rather than assumed.

The one remaining URI-shaped sentinel is `vault://accordo/prod/postgres#current`,
which carries no `user:pass@` and so is not credential-shaped by the
discriminator above. Recorded as the first place to look if a second finding
appears, since GitGuardian cannot be run here.

Worth noting for the campaign record: this is the first GitGuardian failure of
the campaign, and V4A/V4B's `v4b-postgresql-password-sentinel`-style tokens have
never tripped it. Form, not vocabulary.
