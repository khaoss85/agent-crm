# Jobs and durable outbox

**Status: design only. Nothing here is implemented.**

The framework has no notion of *later*. Every mutation is caused by a request
in flight; when the process ends, so does everything it was going to do. That is
a deliberate simplification for eleven milestones — and it is the single
capability whose absence blocks the most obvious CRM jobs.

## Why it is now on the critical path

| JTBD | What it needs |
|---|---|
| Renewal 90 days before term end | a scheduled trigger against a future date |
| SLA escalation | a timer started by an event and cancelled by another |
| Unattended lead follow-up | a delayed action with an idempotent identity |
| Reminders / next actions | recurring evaluation, not a request |
| Provider catalog sync | a recurring job with a cursor |
| Signature reconciliation | a retry loop for envelopes the webhook never resolved |
| Support escalation | a timer plus a durable notification |

Every one of them is currently "not supported", and every one becomes reachable
once this track exists.

## What exists today, stated precisely

`packages/core/src/event-bus.js` buffers domain events inside an
AsyncLocalStorage scope and dispatches them **after** the transaction commits
(ADR-012). A subscriber failure is recorded as a failed trace span and logged,
and the business operation still succeeds — the right policy, because the
caller must not retry an action that already committed.

**This is not durability.** The buffer lives in one process's memory: if the
process dies between the commit and the dispatch, the event is gone with no
record that it was owed. `reconcileSignature` exists precisely because there is
no durable delivery to rely on.

## The target primitives

### Job

`{jobKey, kind, payload, runAt, attempt, maxAttempts, status, leaseOwner, leaseUntil, lastError, createdAt, completedAt}`.

- **Identity is deterministic** — `jobKey` derived from the record and purpose (`renewal-check:<subscriptionId>:<termEnd>`), DB-unique, so the same job is never queued twice.
- **Kinds:** one-shot at a time, delayed by an interval, recurring on a schedule, and workflow timers that a later event can cancel.
- **Handlers are code-first and versioned**, like every other definition, with declared config inside the fingerprint.

### Lease and locking

A worker claims a job with a bounded lease (`leaseOwner`, `leaseUntil`) inside one transaction; an expired lease is reclaimable. Two workers must never run one job concurrently, and a crashed worker must not block a job forever.

### Retry, backoff, dead letter

Bounded attempts with exponential backoff and jitter; a permanent failure moves to a dead-letter state with its normalized error — never the raw payload or a secret — for explicit human or agent retry. No silent infinite retry.

### Durable outbox

Domain events are written to an outbox table **inside the business transaction** (so they commit exactly with the state they describe), then delivered by a post-commit worker with at-least-once semantics, an acknowledgement per subscriber, and an ordering guarantee stated per stream. Subscribers must be idempotent — the framework will say so in the contract rather than pretend exactly-once.

### Replay

An outbox row can be re-delivered explicitly, which is how a subscriber that was broken for a day catches up. Replay must not re-run business logic that already committed — the subscriber contract makes that the subscriber's obligation, and the framework provides the delivery identity to make it possible.

### Observability

Queue depth, oldest pending `runAt`, per-kind failure rates, dead-letter inventory, lease expiries, delivery lag per subscriber. Aggregate only.

### Tenant isolation (future)

Per-tenant queues or fair scheduling, so one tenant's backlog cannot starve another. Gated on tenancy.

## Non-goals

- No distributed broker (Redis, SQS, Kafka) in the default stack: the first implementation is a database-backed queue on the same deterministic storage boundary.
- No cron expression language in the CRM data model; schedules are code-first definitions like every other policy.
- No "eventually consistent" business rule: a job is how *deferred* work happens, never how *correctness* happens.

## Dependencies

- PostgreSQL is not required for a first version, but a SQLite-only queue will be single-node; that limit must be stated wherever it is shipped.
- Tenancy gates fair scheduling.
- The Integration Runtime consumes this track; it must not build a private scheduler.

## Marketing MK4 is hard-blocked on this document

One-shot campaigns can ship before a scheduler exists. **Rolling, triggered and journey campaigns cannot** — they need durable waits that survive a restart, exactly-once step semantics, retry with backoff, a durable event inbox with an explicit replay policy, and enrolment state pinned to a journey version. Built on the current in-process, post-commit event buffer (ADR-012) they would demo correctly and drop steps in production.

That makes this track a blocker for more Marketing JTBDs than any single marketing milestone. See `CAMPAIGNS_JOURNEYS.md` §7 and `EXECUTION_ROADMAP.md` (MK4).
