# Spine v3A — durable jobs and scheduler contract

This ExecPlan is a living document. Progress, decisions, and outcomes are updated while the implementation changes.

## Goal and user-visible outcome

Add one bounded, tenant-bound durable work primitive that can enqueue work now or at a canonical UTC instant, claim it safely, retry only closed retryable failures, recover expired claims after restart, cancel or reschedule pending work, and execute only named registered handlers. The primitive supports SQLite local compatibility and dedicated-database PostgreSQL. It does not add cron, a Cloud queue, arbitrary executable payloads, provider replay, timer consumers, outbox dispatch, or an automatically started application worker.

The future integration slice can compose this private runtime into explicit operator/application lifecycle surfaces. This slice proves the storage and lifecycle contract without changing the current public application facade or promoting any JTBD.

## Current repository context

Baseline: `4261fa8dc1058c1360d9fd0492f1e3b0a4d86572` on `claude/spine-v3a-durable-jobs-scheduler`.

- `packages/core/src/database.js` owns SQLite core migrations and its single-connection transaction boundary.
- `packages/core/src/core-schema-intent.js` is the PostgreSQL/SQLite migration intent authority; `packages/core/src/postgresql-bootstrap.js` renders it for the dedicated data plane.
- `packages/core/src/storage-contract.js` and `packages/core/src/postgresql-storage.js` keep raw drivers private and provide connection-affine transactions.
- `packages/core/src/time.js` is the canonical UTC clock authority.
- `packages/app/src/create-app-async.js` explicitly composes SQLite or dedicated-database PostgreSQL and must not gain hidden worker startup in this slice.
- ADR-038 keeps one tenant per application instance. Job tenant identity is therefore a required value checked on every claim transition, not row-level shared-database tenancy.

## Approaches considered

1. Extend the generic Storage Contract statement DSL with comparisons, row locks, returning rows, and delete/claim operations. Rejected: it materially widens the horizontal SQL vocabulary for one consumer and makes `SKIP LOCKED` look portable when SQLite has different guarantees.
2. Build jobs as a module migration with a standalone PostgreSQL pool and a second SQLite connection. Rejected: it duplicates application storage ownership, can escape writer-lease authority, and makes atomic composition with later domain/outbox transactions impossible.
3. Add one core data-plane migration and a private dialect-specific durable-job storage capability attached inside the existing opaque storage handles, then put validation, state transitions, handler registration, retry policy, and worker lifecycle in one dialect-neutral runtime. Chosen: raw SQL remains inside adapters; PostgreSQL claims on the transaction-affine client with `FOR UPDATE SKIP LOCKED`; SQLite claims under the existing single-writer transaction; later V3B/V3C consumers can share the caller-owned transaction.

The third approach pays for the adapter seam with two concrete dialects and prevents the demonstrated concurrency/data-integrity failures: concurrent claim, stale claim completion, and wrong tenant/worker completion.

## Contract and invariants

- Contract version `1`, closed job states, closed retry classes, and closed input shapes.
- Required persisted identity: job id, tenant id, kind, handler name/version, canonical payload fingerprint and bounded JSON, schedule instant, state, attempt/max attempts, claim owner/generation/expiry, idempotency root/outcome reference, timestamps, and bounded last error code.
- Persisted schedule intent distinguishes an omitted immediate request from an explicit scheduled request. Idempotent retries of an immediate request join despite clock drift; immediate and explicitly scheduled work never collapse into one identity.
- Payload is JSON-safe data only. Handler identity comes from a named registry; no source, function, command, secret, or provider credential is persisted.
- PostgreSQL due claims select one eligible row in a transaction with `FOR UPDATE SKIP LOCKED`; SQLite serializes claim mutation through the current single-writer transaction. Multi-node SQLite support is not claimed.
- Caller-transaction enqueue requires the callback-scoped handle plus the existing live ownership witness. Root handles and handles retained after commit or rollback refuse before writing.
- Completion/release requires the same tenant, worker, generation, and unexpired claim. Immediately before invoking a handler, the worker atomically persists execution start on that claim generation. A pre-handler release preserves its generation fence but returns the execution attempt; an expired unstarted claim is recoverable without consuming another attempt, while an expired started claim becomes terminal reconciliation evidence and is never invoked by another worker.
- Retry is opt-in through a closed retryable error code, bounded by `maxAttempts`, and scheduled using an injected deterministic backoff. A throwing or invalid backoff collapses to terminal `JOB_BACKOFF_INVALID` without retaining caller-controlled detail. Validation, authorization, policy, unknown, and provider failures are terminal by default; no external provider operation is replayed implicitly.
- Worker lifecycle is explicit: `start`, bounded `poll`, `drain`, `stop`, and `close`. Stop prevents new claims; current work either finishes inside the drain deadline or a claim not yet handed to its handler is explicitly released for recovery. Timer poll failures remain visible as one bounded code until a successful poll. No constructor or app factory starts a timer.
- Every mutation requires an explicit verified actor and records one bounded, payload-free `durable_job.*` audit event on the same SQLite/PostgreSQL transaction handle. Claim, execution-start, success, failure, and release require a system actor; worker construction requires that same explicit system-operation actor and never invents one.

## Milestones

### 1. Schema and dialect storage

Add the versioned job table and indexes to data/combined SQLite migration plans and the shared dialect intent. Attach a private job-storage capability to SQLite and PostgreSQL storage handles. Leave control-plane schemas unchanged. Prove migration identity, restart persistence, exact due boundary, PostgreSQL `SKIP LOCKED`, and claim fencing.

### 2. Runtime contract, registry, retry, and lifecycle

Add closed validation and canonical fingerprinting, a named handler registry, job store operations, and the explicit worker. Prove cancel/reschedule, restart, retry/terminal classification, duplicate-worker behavior, bounded stop/release, and absence of live timers after close.

### 3. Compatibility, decisions, and validation

Record the runtime decision in `DECISIONS.md` and every current domain/package status in `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`. Keep final public truth/status, integration surfaces, and measurement reserved for the integration/measurement PRs. Run focused SQLite and PostgreSQL suites, checks, Repository Truth, smoke, and broad verification.

## Validation

Use Node `22.16.0` through `fnm`.

Baseline before runtime edits:

    npm install
    npm run verify
    npm run smoke

Focused final evidence:

    node --test tests/spine-v3a-durable-jobs-sqlite.test.js
    ACCORDO_PG_TEST_URL=postgres://postgres@127.0.0.1:5432/accordo_test node --test tests/spine-v3a-durable-jobs-postgresql.test.js
    npm run check
    npm run repo:truth -- --check
    npm run smoke
    npm run verify
    git diff --check

Expected: all commands exit zero; PostgreSQL tests are not skipped when the service is available; no test leaves timers, sockets, or database handles open.

## Progress log

- 2026-08-31: Verified the dedicated worktree, branch, and exact baseline `4261fa8dc1058c1360d9fd0492f1e3b0a4d86572`. Read repository workflow/truth/quality authorities and inspected M3/M4 storage, migration, tenant-binding, and lifecycle seams.
- 2026-08-31: Selected the existing-storage private capability approach after comparing the three alternatives above.
- 2026-08-31: Added data-plane migration v9 and private SQLite/PostgreSQL job operations. PostgreSQL claim uses the transaction-affine client and `FOR UPDATE SKIP LOCKED`; SQLite uses the existing `BEGIN IMMEDIATE` boundary.
- 2026-08-31: Added the closed store, handler registry, retry/backoff policy, external-operation-v2 recovery fence, and explicit worker lifecycle. A red-team lease-expiry finding resulted in the recovered-external-effect regression: the second generation becomes reconciliation-required without invoking the handler/provider twice.
- 2026-08-31: Focused evidence is green: V3A SQLite plus affected M2F/M3A/lead-conversion suites (the combined run completed with no failures; the live PostgreSQL case skipped only because PostgreSQL 16 is unavailable locally). `npm run check`, `npm run smoke`, Repository Truth, GTM/site/distribution, surface check, and `git diff --check` pass on Node 22.16.0. A post-implementation full `npm run verify` advanced through syntax and broad suites without an observed product failure, then was stopped as a duplicate before the repository's known slow/non-deterministic shell-classifier path; exact-head CI must supply the terminal broad receipt.
- 2026-08-31: The clean-baseline verify was stopped after the repository's known local shell-classifier cross-product test ran for several minutes and failed while the rest of the observed baseline remained green; exact-head GitHub CI on Node 22.16.0 was already green. Final validation is run again after implementation rather than treating the interrupted baseline as feature evidence.
- 2026-08-31: PR review found that omitted schedules lost their semantic intent under clock drift and that the private job mutation seam had no actor/audit evidence. The existing `AuditLog.record(event, handle)` accepts both callback-scoped SQLite and affine PostgreSQL handles, so the correction can remain atomic without another ledger or schema.
- 2026-08-31: Exact-head review found that lease expiry alone could not distinguish a process that died before handler invocation from one whose handler was still running. Added one persisted execution-start fence: recovery reclaims only unstarted claims, while started expiry is terminal reconciliation evidence. The same review found payload getters/proxies could execute during canonicalization; payload inspection now uses own data descriptors and collapses every hostile failure to one credential-free error.
- 2026-08-31: Early adversarial probes closed the same accessor boundary around the top-level enqueue/handler/actor envelopes, restricted execution lifecycle mutations to system actors, pinned execution-start/audit rollback, and made hostile backoff behavior a bounded terminal failure rather than a leaked, stranded claim.
- 2026-08-31: Final Node 22.16.0 evidence is green for the focused SQLite/PG file pair, affected M3A migration/M2F audit/lead-conversion suites, syntax check, smoke, Repository Truth, GTM/site/distribution/surface checks, and diff check. The live PostgreSQL case remains the one local skip because PostgreSQL 16 is not reachable; exact-head hosted CI remains responsible for that executable receipt.

## Decision log

- Jobs live on the tenant data plane. The required tenant column is defense in depth and transition authority, not shared-database tenancy.
- The application facade and worker autostart remain unchanged. V3A supplies private composable machinery; the public/operator surface belongs to the integration PR and must clear the DX Simplicity Gate there.
- `failed_retryable` is durable evidence between attempts; `failed_terminal` is terminal. A retry claim moves retryable work back to `claimed` only when its explicit next schedule is due.
- Lease generation is a monotonically increasing safe integer. Completion is compare-and-set on tenant, worker, generation, state, and expiry.
- If execution began and its lease expires, the first post-expiry claim transaction marks it `failed_terminal` with bounded reconciliation evidence. If execution never began, recovery retains the same attempt regardless of claim/drain cycles.
- A recovered `external-operation-v2` job carries the same idempotency root as its external operation identity and becomes reconciliation-required before handler invocation. At-least-once internal work still requires its consumer to use the supplied idempotency root; V3A does not claim exactly-once effects.
- Schedule intent describes the current caller-visible scheduling decision: enqueue stores `immediate` or `scheduled`, explicit reschedule moves it to `scheduled`, while internal retry backoff preserves the original caller intent.
- Job audit data contains only closed transition evidence (`state`, claim generation, and bounded error code where applicable). It never copies payload, idempotency roots, outcome references, tenant locators, or handler inputs.
- Execution start is conservative evidence, not an exactly-once claim. A crash after the start CAS and before JavaScript invocation remains reconciliation-required because the durable record cannot prove which side of that boundary ran.

## Outcome and follow-up

Implemented as private composable Spine v3A machinery with no application-facade or worker-autostart change. V3B will consume this primitive for transactional outbox effect dispatch; V3C will add the first domain timer consumers. PostgreSQL executable evidence remains a required exact-head CI run because no local PostgreSQL 16 service was available. Final public truth/status, timer consumers, outbox semantics, operator surfaces, and measurement remain outside this branch.
