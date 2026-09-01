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
- `packages/app/src/create-app-async.js` composes **no** durable-job worker, no
  outbox worker and no backup operations. Those are application-composed
  objects. This slice keeps that property: the default factory gains no
  telemetry option, no exporter and no background process.

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
producer is given no sink — zero cost, no allocation per signal),
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
this slice — it composes no job worker, no outbox worker and no backup
operations, so there is nothing there to instrument, and adding a factory option
would be the hidden-lifecycle shape this slice exists to avoid. The application
constructs a sink, passes it to the runtime objects it already constructs
explicitly, and closes it in its own shutdown order.

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
  §Lifecycle: it composes none of the three producer families.
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
