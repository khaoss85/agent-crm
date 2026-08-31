# Spine v3B — transactional outbox and effect dispatch

This ExecPlan is a living document. Progress, decisions, validation receipts, and review corrections are updated while implementation changes.

## Goal and bounded outcome

Close the PostgreSQL process-death gap between a committed `write_outcomes` row and post-commit effect dispatch. The existing `event_intents_json` remains the only effect-intent authority. V3A durable jobs provide effect ownership, retry, execution-start, poison, and restart evidence; V3B adds no second intent table or generic event platform.

Two closed effect families are implemented:

1. Promote the existing internal event intents after commit.
2. Continue a persisted external-operation receipt into its local finalize phase without calling or reconciling the provider again.

This slice adds no application worker autostart, CLI/MCP surface, security-audit migration, Cloud service, domain timer, JTBD promotion, or production-readiness claim.

## Repository context and authoritative seams

- Exact base: `7cf90f2a9b80b04afdb4ca798c85b363f728b50a` on `claude/spine-v3b-transactional-outbox`.
- `packages/core/src/write-outcome-runtime.js` owns the PostgreSQL transaction that atomically persists domain writes, audit evidence, `write_outcomes.event_intents_json`, and trace intent.
- `packages/core/src/write-outcome-store.js` owns lookup and the existing `events_promoted` terminal evidence. It remains the authoritative source; no parallel event payload is copied into a job.
- `packages/core/src/external-operation.js` owns external-operation v2 intent/call/receipt/finalize sequencing and already guarantees that a replayed call outcome never authorizes another provider call.
- `packages/core/src/durable-jobs.js` and its dialect adapters own V3A claim, execution-start, retry, and lifecycle semantics.
- `packages/core/src/event-bus.js` is still the internal subscriber transport. Its buffered queue is transient; V3B promotes from the committed write outcome, not from memory after restart.

## Chosen design

Each committed source outcome gets at most one deterministic V3A job per applicable closed effect family. The job payload contains only contract version, source run id, source phase, and a canonical source fingerprint. It contains no raw idempotency key, event name/payload, domain/provider response, actor, credential, locator, or secret reference.

Enqueue happens inside the same PostgreSQL connection-affine transaction and uses the live transaction witness already required by V3A. Rollback therefore leaves neither outcome nor job. The actor is obtained only through one named `trustedSystemActor` reason; there is no fallback.

Internal event promotion runs through the exact durable-job claim. To preserve current synchronous PostgreSQL subscriber behavior, the successful write path explicitly executes that exact committed job once after commit. A concurrent/restart worker can win the claim instead, but the same effect job cannot be invoked concurrently. `events_promoted` changes only after every stored intent was dispatched; the old mark-before-dispatch loss gap is removed.

Delivery is honestly at least once. A subscriber failure after earlier intents dispatched leaves a retryable job and may repeat those earlier intents. A process death after execution start leaves V3A reconciliation-required evidence and is never automatically replayed. Successful dispatch has one terminal job plus `events_promoted` evidence. Poison remains visible as a terminal job with a bounded code; nothing is silently deleted.

External receipt continuation is a separate named handler. It reads intent/receipt/finalize outcomes by tenant namespace plus run/phase, verifies the source fingerprint, and succeeds immediately when finalize already exists. Otherwise it calls only a registered local finalize continuation. Provider `call` and `reconcile` handles are not accepted by this runtime. After the callback, a committed finalize outcome is required before the job can succeed.

SQLite retains its existing immediate buffered-event compatibility because M4 write outcomes are PostgreSQL-only. V3B does not claim durable SQLite outbox semantics or multi-node SQLite dispatch.

## Milestones

### 1. Exact-source effect identity and atomic enqueue

Add closed effect identity/fingerprint helpers, outcome lookup by run/phase, deterministic job ids/roots, and transaction-affine enqueue from `runIdempotentWrite`. Prove rollback, payload exclusion, idempotent enqueue, and PostgreSQL migration compatibility.

### 2. Internal event promotion

Add the internal-event handler and exact-job one-shot execution. Replace `events_promoted`-before-dispatch with mark-after-success. Prove commit/death/restart, two-worker exclusion, retry/poison visibility, partial at-least-once behavior, and no silent deletion.

### 3. External receipt finalize continuation

Enqueue the receipt continuation atomically, add a closed named local-finalize registry, and prove restart runs finalize only, provider call/reconcile counts remain unchanged, replay is idempotent, missing/poison continuations remain visible, and begun-unknown work is reconciliation evidence.

### 4. Decisions and validation

Amend ADR-041 with the V3B outbox decision and update the legacy alignment matrix without final public status/JTBD promotion. Run focused SQLite/PG16 suites, affected M4A and V3A suites, check, Repository Truth, smoke, and diff check on Node 22.16.0.

## Validation

    node --test tests/spine-v3b-transactional-outbox-sqlite.test.js
    ACCORDO_PG_TEST_URL=postgres://postgres@127.0.0.1:5432/accordo_test node --test tests/spine-v3b-transactional-outbox-postgresql.test.js
    node --test tests/spine-v3a-durable-jobs-sqlite.test.js tests/spine-v3a-durable-jobs-postgresql.test.js tests/spine-v2-m4a-idempotency-recovery.test.js
    npm run check
    npm run repo:truth -- --check
    npm run smoke
    git diff --check

Hosted exact-head PostgreSQL 16 evidence is mandatory when the local service is unavailable.

## Progress log

- 2026-08-31: Created the branch from exact reviewed V3A head and traced write-outcome insertion/promotion, event buffering, affine storage, and external-operation receipt/finalize paths.
- 2026-08-31: Chose `write_outcomes` as the sole effect-intent authority and V3A jobs as delivery ownership/evidence. Rejected a second outbox table and rejected marking `events_promoted` before dispatch.

## Decision log

- Source fingerprint is evidence for one exact committed outcome identity; it is not a payload digest copied into the job.
- Event transport is at least once. No exactly-once external or internal delivery claim is made.
- The external continuation registry accepts local finalize functions only. Provider handles are structurally absent.
- Security audit stays on its existing authoritative database path.
- Final public truth/status, operator surfaces, measurement, and timer consumers remain for their later campaign slices.

## Outcome and follow-up

Pending implementation and exact-head review.
