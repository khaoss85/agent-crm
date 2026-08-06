# Integration runtime

**Status: design only. Nothing in the "missing" half of this document exists.**

Six provider kinds already ship (enrichment, catalog, discount policy, scoring
model, routing policy, signature) and every one of them is a deterministic
**offline fixture**. That was the right call — it proved the contracts without
credentials — but it also means the framework has never faced a real remote
service. This document names what a real one needs, so the first true adapter
does not invent it privately.

## What is already proven

| Primitive | Where | Guarantee |
|---|---|---|
| Prepare phase | ADR-015 | a bounded read-only external call **before** the write transaction, with a deep-frozen JSON-safe result |
| External operation | ADR-017 | `intent` → `external` (no transaction, bounded timeout, late settlement abandoned) → `finalize` → `compensate`, with no atomicity claimed between local and remote |
| Provider registry | ADR-015/016/017 | versioned, fingerprinted, Map-backed, fail-closed at startup; declared config inside the fingerprint; drift stops the boot |
| Result normalization | ADR-016/017 | every provider result validated into a bounded contract (`PROVIDER_INVALID`) before it can touch local state |
| Event inbox + verification | ADR-017 | raw-byte webhook verification before any mutation; DB-unique event identity plus a payload fingerprint; quarantine for unknown subjects |
| Explicit reconciliation | ADR-017 | provider queried outside every transaction, applied inside one, monotonic and duplicate-free |
| In-process event buffer | ADR-012 | events dispatched only after the transaction commits; a subscriber failure is not a business failure |

That is a real foundation: it is the *call* and the *callback* done correctly,
once, per operation.

## What is missing

None of the following exists. No document, milestone or PR may claim otherwise.

- **Scheduler** — nothing runs later, on an interval, or after a delay.
- **Durable queue and workers** — nothing survives the process.
- **Durable outbox** — post-commit delivery is best-effort and in-memory.
- **Retries and backoff** — a failed provider call is a failed operation; the caller retries by hand.
- **Dead-letter / failure inventory** — a permanently failing operation is a row with an error code, not a queue anyone works.
- **Secret management** — no store, no reference indirection, no rotation. The only key in the repository is a declared test-only fixture value.
- **Provider health** — no circuit breaker, no availability signal, no degradation policy.
- **Remote-safe workers** — no isolation, no per-tenant fairness, no concurrency control.

`JOBS_AND_OUTBOX.md` owns the scheduler, queue and outbox half.

## The target contract

### Provider definition

Extends today's shape rather than replacing it: `{name, version, label, config, capabilities[], handlers}`, still code-first, still fingerprinted, still registered through a checked-in `generated/index.js`.

### Connection and configuration identity

A **connection** is the per-installation binding of a provider to an account: `{provider, providerVersion, connectionKey, config, secretRef, status, createdBy}`. Multiple connections of one provider must coexist (two mailboxes, two catalogs). The connection — never the provider definition — carries environment-specific data.

### Secret reference, never plaintext

A connection stores a **reference** (`secretRef`), resolved at call time by a secret provider. A plaintext credential never enters the database, the schema endpoint, an audit row, a trace span, an error message or a log line. Rotation replaces the referenced value without touching CRM data; a connection records `secretRotatedAt`, never the secret.

### Sync cursor and checkpoint

Incremental sync needs a durable, per-connection cursor (`{connectionKey, resource, cursor, updatedAt}`), advanced only after the batch it covers has committed, so a crash re-reads rather than skips.

### Idempotency

Every outbound operation carries a deterministic key derived from the local record it belongs to (the M11 pattern: `env:quote-version:<id>`). The remote result must be verified to *be* the object the key claims — matching identity fields, not just answering the lookup.

### Rate limits and backoff

Per-connection budgets, honoring `Retry-After` where a provider sends it; exponential backoff with jitter and a bounded attempt count; a provider under its limit must not starve other connections.

### Dead letter

After the bounded attempts, the operation lands in a failure inventory with its phase, normalized error and payload fingerprint — never the raw payload or the secret — and a human or an explicit action retries it. Silent infinite retry is forbidden.

### Webhook inbox

Generalizes M11's signature inbox: raw body preserved and bounded, provider selected canonically from the path, verification before any mutation, DB-unique event identity plus payload fingerprint, quarantine for unknown subjects, explicit `effect` per row, and a stable error that echoes nothing.

### Reconciliation

Every provider-backed subject must answer: *what does the provider think is true, and how do I converge on it without duplicating evidence?* M11's `reconcileSignature` is the reference shape.

### Schema mapping and conflict policy

A declared field mapping between the remote shape and CRM records, plus a per-resource conflict policy — provider-wins, local-wins or refuse — chosen explicitly per connection. Refuse is the safe default for commercial data.

### Provider contract-test kit

A published test suite a third-party adapter runs against its own implementation: normalization, timeout, late settlement, idempotency, replay, out-of-order events, verification failure, reconciliation. A provider that passes it is compatible; one that does not is not shipped.

### Optional sandbox tests

Real-credential tests against provider sandboxes run **only** where credentials are explicitly provided, never in the default suite, never in a fork's CI, and never with a credential in the repository.

### Observability

Per-connection: call counts, latency, error codes by class, retry and dead-letter counts, cursor lag, webhook verification failures. Aggregate, never payload.

### Human approval for consequential actions

Sending, signing, charging or exposing data externally requires `actor.type === 'user'` (the M11 boundary) until real RBAC exists — and the limitation is stated wherever it is enforced.

## Sequencing

1. `JOBS_AND_OUTBOX.md` — nothing durable is possible without it.
2. Secret management — no real credential may be handled before it.
3. Connections, cursors, rate limits, dead letter.
4. The contract-test kit, then the first real adapter.
5. Health and observability.

Auth and tenancy (the Production Spine) gate any multi-tenant use of all of it.

## Marketing channel and analytics providers

The Marketing track (`MARKETING_GROWTH_OPERATIONS.md`) adds provider *contracts*, not provider dependencies: email, SMS, WhatsApp, ads, analytics/insight and content publishing. Named examples (Resend, MailUp, SES, Google/Meta/LinkedIn Ads, GA4, Search Console, PostHog) are **optional adapters a customer may install**, and naming one commits the project to nothing.

Provider metadata must declare channel, transactional/bulk capability, region, rate and batch constraints, template capability, tracking/webhook support, unsubscribe and consent support, sandbox capability, installed/configured status and bounded health metadata. An agent selects only among **installed and configured** providers, the selection is versioned and explainable, and no install, send or spend happens without human approval. See `CAMPAIGNS_JOURNEYS.md` §5. **No marketing provider is implemented.**
