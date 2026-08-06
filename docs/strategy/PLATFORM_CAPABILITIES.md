# Platform capabilities

One bounded vocabulary shared by every kind of module: **handwritten core
modules**, **generated modules**, **domain packages** (ADR-018) and **future
plugins**. A capability names a guarantee — what the service boundary is, how it
appears over HTTP/SDK/Admin, what it writes to audit and events, and how it
behaves inside a transaction.

This is deliberately **not** a DSL. It is a closed list that grows only when a
second consumer proves a need, and every entry states honestly whether it exists
today.

## How to read the table

- **Implemented** — the guarantee is enforced in code and covered by tests.
- **Partial** — some consumers have it, others do not; the asymmetry is named
  below.
- **Future** — designed here, not built. No milestone may claim it.

## The capabilities

### 1. Readable resource — *implemented (M1–M5)*

- **Service boundary:** a generated service with `get` / `list` / `listWhere` / `countWhere`; `listWhere`/`countWhere` are exact and indexed, `list` is page-bounded.
- **Exposure:** `GET /api/modules/:module/records[/:id]`, SDK `module(name).list/get`, Admin collection + detail.
- **Audit/events:** none (reads).
- **Transactions:** none.
- **Limitations:** the paged `list` bound (500 API / 200 Admin) is a display bound and must never be a correctness path.

### 2. Mutable resource — *implemented (M1–M5)*

- **Service boundary:** `create` / `update` with manifest-derived validation, actor context and unique/reference checks.
- **Exposure:** `POST` / `PATCH` on the records surface; Admin form.
- **Audit/events:** one audit entry per mutation; a domain event where the module declares one.
- **Transactions:** each mutation is atomic (savepoint inside an outer transaction when nested).
- **Limitations:** no soft delete and no general delete anywhere in the framework.

### 3. Read-only evidence — *implemented (M9–M11)*

- **Service boundary:** every field `writable: "managed"`, so the generated module exposes capabilities `['get','list']` and **no** public `create`/`update` exists at all; records are written only through the trusted in-process `createManaged`/`applyManaged` path.
- **Exposure:** read routes only; `POST`/`PATCH` are 404 even with an empty body.
- **Audit/events:** every managed write is audited with its actor.
- **Transactions:** always inside the caller's transaction.
- **Evidence:** score runs and contributions (M9); products, offers, components, tiers, quotes, versions, totals (M10); envelopes, signers, events, artifacts, orders (M11).

### 4. Managed fields — *implemented (M6–M11)*

- **Service boundary:** individual fields marked `writable: "managed"` on an otherwise mutable module; public CRUD cannot set them, actions can.
- **Exposure:** rendered read-only in the Admin; rejected in public payloads.
- **Limitations:** the mechanism is per-field and manifest-declared; there is no per-role variant (that needs RBAC).

### 5. Record action — *implemented (M6, ADR-011/012)*

- **Service boundary:** a code-first definition `{module, name, actionContract, input, fromStates, execute}` run by the action runtime: one transaction, buffered events dispatched after commit, a trace run with spans.
- **Exposure:** `POST /api/modules/:module/records/:id/actions/:action`; SDK `module(name).action(...)`; generic Admin controls with declared inputs.
- **Audit/events:** whatever `execute` writes, plus a trace run in every case — including failures.
- **Transactions:** atomic; a failure rolls back all business writes and still records an honest failed trace.
- **Partial:** eligibility differs — see the asymmetries below.

### 6. Prepare phase — *implemented (M9, ADR-015)*

- **Service boundary:** an optional read-only phase before the transaction, with a read-only module view and a deep-frozen JSON-safe result.
- **Use:** a bounded external read (enrichment) that must not hold the write lock.

### 7. Staged resource (pipeline) — *partial (M8, ADR-014)*

- **Service boundary:** a code-first pipeline definition plus a server-authoritative `move-stage` action; stage keys are persistent identifiers; terminal stages lock.
- **Limitation, stated plainly:** only **explicitly action-eligible core modules** can carry pipeline state today, because the pipeline columns live in a core migration. A generated module cannot be staged; manifest-declared pipeline state is future work.

### 8. Approval subject — *partial (M0, M10)*

- **Service boundary:** a human decision recorded atomically with the state change; only `actor.type === 'user'` may decide; one decision per subject.
- **Limitation:** there are **two** implementations. The core `Approval` module is renewal/opportunity-shaped (its table requires an opportunity FK); M10 quotes therefore use a **separate** `quote-approval` record. They share a discipline, not a primitive. Generalizing the approval domain is future work, and no document may describe it as unified.

### 9. Assignment subject — *implemented for leads (M9)*

- **Service boundary:** deterministic routing over declared targets with capacity from active workload, immutable assignment history.
- **Limitation:** routing targets are a code-first registry, not CRM users — there is no user table, so "assignment" means a declared target key.

### 10. Provider-backed operation — *implemented (M9–M11)*

- **Service boundary:** a versioned, fingerprinted provider definition in a Map-backed per-app registry, validated fail-closed at startup, with its declared config inside the fingerprint and persisted in `definition_versions`.
- **Kinds today:** enrichment provider, catalog provider, discount policy, scoring model, routing policy, signature provider.
- **Limitation:** every shipped provider is a deterministic **offline fixture**. The shared runtime real providers need — scheduling, retries, backoff, dead-letter, secret management, health — does not exist (`INTEGRATION_RUNTIME.md`).

### 11. External operation — *implemented (M11, ADR-017)*

- **Service boundary:** `intent` (transaction A) → `external` (no transaction, bounded timeout, late settlement abandoned) → `finalize` (transaction B) → `compensate` (its own transaction, only on failure). The external phase gets no database, no modules and no managed writes.
- **Audit/events:** events buffered per transaction and dispatched after that transaction commits; one trace run whose spans distinguish the phases.
- **Explicitly not claimed:** atomicity between the local database and a remote service.

### 12. Immutable artifact — *implemented (M10–M11)*

- **Service boundary:** a snapshot row that is never updated after creation; identity is a deterministic DB-unique source key; later movement in the source data cannot rewrite it.
- **Evidence:** Quote Versions and their components/totals; signed artifacts; Orders and their lines/components/tiers/totals.

### 13. Document / signature subject — *implemented for quotes (M11)*

- **Service boundary:** a canonical JSON document package built from immutable snapshots plus a party snapshot, hashed over the exact bytes sent, with a monotonic envelope state machine, byte-exact webhook verification and explicit reconciliation.
- **Limitation:** no PDF, no legally qualified signature, no identity assurance, provider-reported artifact hash, one envelope per subject forever.

### 14. Schedulable job — *future*

Nothing schedules anything today. No timers, no recurring work, no delayed actions, no workers. Design: `JOBS_AND_OUTBOX.md`.

### 15. Durable event delivery — *future*

The event buffer is in-process (AsyncLocalStorage) and dies with the process. A post-commit subscriber failure is deliberately not a business failure — which is exactly why durable delivery is needed. Design: `JOBS_AND_OUTBOX.md`.

### 16. Tenant-owned resource — *future*

No tenant column, no tenant boundary, no isolation test. Every capability above is single-tenant. Gate: the Production Spine.

### 17. Permission-protected action — *future*

Actions distinguish **actor type** (`user` / `agent` / `system`), never actor identity or role. `requiredApprovalKey` and similar fields are labels. Real permissions need auth, tenancy and RBAC.

### 18. Governed personal data — *future*

No PII classification, consent record, retention rule, export or erasure path exists. Design: `DATA_GOVERNANCE.md`.

## Known asymmetries, stated honestly

These are real inconsistencies in the current tree. None of them is "already unified", and no document may imply otherwise.

| Asymmetry | Reality today |
|---|---|
| Action eligibility | Generated modules are action-eligible by construction; **core** modules only when a checked-in action registers against an explicitly allow-listed name (`opportunity`). Core CRUD is never served by the generic records surface. |
| Approval | Two implementations (core `Approval`, `quote-approval`) with a shared discipline and no shared primitive. |
| Core adapters | Actions reach core Company/Contact/Opportunity only through declared adapters (ADR-013) — a deliberate narrow bridge, not a general capability. |
| References | Generated → generated references are validated by the resolver (ADR-010); generated → **core** references are not a manifest feature, and generated modules store core ids as plain strings. |
| Pipelines | Core-module only (see capability 7). |
| Registries | Six provider/policy kinds share the fingerprint mechanism but each has its own registry class and its own `generated/index.js`. A single capability contract for "provider kind" does not exist yet. |
| Money | One convention (safe integers, 1/100 units, two decimals) applied consistently in M10–M11 — but it is **not** ISO-4217 exponent support, and it is not enforced by a shared type. |

## How a new capability is added

1. A second consumer needs it (one consumer is a domain concern — ADR-018).
2. It is written here first: boundary, exposure, audit/events, transactions, limitations.
3. It ships with contract tests that a plugin could run against its own module.
4. `PROJECT_STATUS.md` and the JTBD matrix are updated only with what the merged code proves.
