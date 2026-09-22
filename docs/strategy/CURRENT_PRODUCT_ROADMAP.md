# Current Product Roadmap — AS-IS → TO-DO

**Reconciled:** 2026-09-22  
**Purpose:** compact current-state projection over the canonical sources, not a new execution ledger.

Authority remains:
- `docs/PROJECT_STATUS.md` for merged/current implementation facts;
- `TASKS.md` for executable product backlog ordering;
- `docs/strategy/EXECUTION_ROADMAP.md` for milestone intent/dependencies;
- GitHub merge state for whether a PR actually landed.

This document exists to prevent stale roadmap prose from making already-merged capability look unbuilt.

## AS-IS

### 1. CRM / Revenue lifecycle — strong implemented base

Merged capability covers:

`Lead → enrichment/scoring/routing → qualification → conversion → Opportunity → catalog/quote → signature → immutable Order → Contract/Subscription → Delivery handover → Delivery execution/economics/change/acceptance → Service → renewal/amendment evidence`.

The remaining product gap is no longer “build a CRM core”; it is the cross-domain operating layer around customer data, analytics, communications, automation and managed production.

### 2. Production Spine — self-host foundation largely implemented

Merged:
- dedicated-database PostgreSQL composition;
- startup attestation, tenant binding and writer leases;
- write-outcome/idempotency transport;
- durable jobs + transactional outbox + bounded timers;
- secret-provider contract;
- backup/verify/restore;
- observability export;
- explicit production-operations composition;
- read-only PostgreSQL composition.

Still outside the completed self-host foundation:
- deployment-provided authentication verifier;
- managed worker service;
- managed secret/backup custody;
- production observability backend;
- remote-safe mutation/MCP;
- shared-database row tenancy unless economics justify it.

### 3. Customer Data

**Foundation v1:** merged.

**Operations v2:** partial:
- merged #195/#196: bounded bulk actions/export + deterministic resume/replay by record;
- merged #197: bounded/windowed identity-conflict detector;
- remaining: global search, saved views, physical consolidation/merge, retention/erasure and complete operator UX/JTBD proof.

### 4. Analytics Studio M16

**Partial / first slice merged (#187):**
- semantic model over pipeline data;
- declared `pipeline_value_by_stage`;
- bounded safe report compiler;
- known-correct fixture tests.

Remaining:
- additional domain metrics, including recurring-revenue semantics where supported;
- persisted/versioned reports;
- dashboards/widgets/saved views;
- role-aware query results;
- broader Analytics JTBD proof.

### 5. Marketing & Growth

**MK1 merged (#194):**
`funnel observation → drop insight → CampaignProposal → human approval`.

Explicitly absent from MK1: send, publish, spend, audience execution, provider lookup, scheduling and attribution.

Remaining sequence:
`MK2 audience/consent + one-shot email → MK3 content/landing/tracking → MK4 durable journeys → MK5 experiments → MK6 paid media → MK7 attribution/closed-loop optimization`.

### 6. Agent-native DX

Already implemented: AX1, AX2, DX1, DX3, DX4, DX5, DX6 and DX10.

Still meaningful gaps:
- DX9 Context Pack;
- DX13 full Project MCP parity as defined by its policy;
- machine-discovered rather than merely declared JTBD/quality-gate coverage;
- clean comparative benchmark once the intended harnesses are available.

## TO-DO — macro capability sequence

This is dependency ordering, not a promise that each item is one PR.

| Order | Capability | Current state | What closes it / why next |
|---:|---|---|---|
| 1 | Reliability / PostgreSQL hardening | in progress | Close concrete P1s such as PR #201 before building more behavior on the same storage path. |
| 2 | Customer Data Operations v2 | partial | Finish search, saved views, physical merge/consolidation, retention/erasure and operator proof. Gives later analytics/marketing a trustworthy operational customer layer. |
| 3 | Analytics Studio core | partial | Move from one pipeline metric/compiler slice to versioned reports, dashboards and cross-domain metrics. |
| 4 | Interactions / Communications foundation | open | Create the governed customer interaction model and provider seams used by email/message workflows. |
| 5 | Marketing MK2 — audience + consent + one-shot email | open | Requires data-governance/interaction foundations; proves one bounded external communication loop. |
| 6 | Marketing MK3 — content + landing + tracking | open | Gives campaigns owned assets and deterministic tracking plans. |
| 7 | Marketing MK4 — durable journeys | open, platform dependency met | Jobs/outbox/timers now exist; remaining hard dependency is the Marketing/customer-governance layer above. |
| 8 | Marketing MK5 — experiments / holdouts | open | Adds measurable causal evidence rather than optimization from before/after movement alone. |
| 9 | Analytics expansion + attribution-ready semantics | open/partial | Cross-domain and recurring-revenue metrics, role-aware reads and campaign/touchpoint measurement. |
| 10 | Marketing MK6 — paid media | open | Human-governed spend and provider adapters; depends on audience/content/provider seams. |
| 11 | Marketing MK7 — attribution + closed loop | open | Requires Analytics plus trustworthy identity/touchpoint evidence; closes campaign → revenue measurement. |
| 12 | Billing / invoicing / payments / revenue recognition | open | Commercial contracts exist, but the product deliberately does not invoice, collect, tax, rate usage or recognize revenue. |
| 13 | Production-managed layer / Cloud | partial outside this repo | Managed workers, custody, auth/operator composition, production observability and remote-safe mutation. Shared-db tenancy stays optional/deferred. |
| 14 | Agent proof/autonomy closure | partial | DX9/DX13 + stronger machine-readable evidence, then prove the Factory→Accordo loop can select, execute, verify and continue without manual prompt routing. |

## What not to do

- Do not reopen CRM primitives already merged just because an older roadmap paragraph still says “next”.
- Do not treat a broad unchecked umbrella item as proof that all of its sub-capabilities are absent.
- Do not turn shared-database tenancy into a blocker unless the deployment/economics actually require it.
- Do not claim Marketing execution from MK1: it prepares and approves; it does not send.
- Do not claim Analytics Studio complete from the first metric/compiler slice.
- Do not equate merged code, technical PASS or a live process with measured business benefit.
