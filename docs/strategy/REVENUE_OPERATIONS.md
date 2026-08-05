# Revenue Operations — Lead Intelligence, Routing and Commercial Operations (CPQ)

**Status: product strategy and roadmap only. Nothing in this document is implemented.** No enrichment provider, scoring model, routing policy, product catalog, quote, discount policy, signature integration or order primitive exists in the repository today. This document defines the two revenue-side workstreams — **Lead Intelligence & Routing** and **Commercial Operations / CPQ** — so the roadmap can sequence them honestly (`EXECUTION_ROADMAP.md`, milestones M9–M11) and so coding agents build them by composing declared primitives instead of inventing incompatible schemas per project.

The delivery model for every domain here is the framework's standard pattern:

```text
native deterministic primitives
+ provider contracts
+ code-first policies/actions
+ Agent Skills
+ starter
+ JTBD evidence
+ reproducible E2E benchmark
```

Non-negotiables inherited from `AGENTS.md` and `ARCHITECTURE.md`: all mutations pass through module services or workflows with validation, actor identity, audit and trace; policies are deterministic and explainable — AI may recommend, never silently decide; **Git history alone is not runtime policy versioning** (a policy run must record which published version produced it, in the database, reproducibly); external provider actions that send, sign, charge or expose data require explicit human approval.

---

## 1. Lead Intelligence & Routing

### 1.1 User journey

```text
Landing page
→ Lead
→ enrichment (external data, snapshot + provenance)
→ behavioral + firmographic signals
→ explainable score (versioned model)
→ versioned routing policy
→ sales/team assignment (capacity, territory, language, skill)
→ manual manager reassignment (permission + reason, history kept)
```

### 1.2 External data enrichment

Enrichment connects external sources to a Lead (and later Company/Contact): company/person enrichment services, marketing automation, website behavior, product analytics, billing, ERP and custom APIs. Each source is an **EnrichmentProvider** behind a provider contract — never business logic calling external HTTP directly.

Every enrichment run produces an **EnrichmentSnapshot** with full provenance:

- raw source references (what the provider returned, as returned);
- normalized fields (what the framework mapped them to);
- confidence per field where the source supplies it;
- provider identity and version;
- retrieval timestamp and expiry;
- actor and trace of the run.

Snapshots are immutable append-only records: re-enrichment adds a snapshot, never rewrites one. A Lead's current enriched view is derived deterministically from its snapshots; which snapshot wins per field is explicit policy, not provider magic.

### 1.3 Signals

**BehavioralSignal** records (page visits, product events, email engagement) and firmographic attributes (from snapshots) are the raw inputs to scoring. Signals are plain timestamped records ingested through services — auditable, queryable, and never overwritten by later signals.

### 1.4 Explainable lead scoring

Scoring is a deterministic, versioned, explainable computation — never a runtime model call:

- **ScoringModel** — named definition, code-first (checked-in source, validated at startup like pipelines, ADR-014 pattern);
- **ScoringModelVersion** — an immutable published version; publication is an explicit act by an authorized actor;
- **ScoringRule** — the typed rules a version is made of (signal thresholds, firmographic bands, weights);
- **ScoreRun** — one execution: which model, which version, which inputs, when, by whom, with trace;
- **ScoreContribution** — per-rule contribution so every score decomposes into "this rule matched, contributing N points".

A score without its contributions is not explainable and must not exist. Reproducing a historical score means replaying the recorded version against the recorded inputs and getting the same number.

### 1.5 Routing policies

Routing turns a scored Lead into an assignment:

- **RoutingPolicy / RoutingPolicyVersion / RoutingRule** — same versioned code-first shape as scoring;
- **RoutingRun** — records policy identity, version, inputs, rule matches, result, actor, timestamp, trace;
- **Assignment** — the resulting ownership record;
- **AssignmentOverride** — a manager's manual reassignment, with permission check, required reason, and full history (overrides never delete the automatic decision they replace);
- **SalesCapacity / SalesAvailability** — declared capacity and availability records that capacity-weighted strategies read;
- **Territory** and skill/language mappings — reference data routing rules consult.

Native routing strategies (deterministic, composable, all explainable through RoutingRun): fixed owner; round robin; territory; language/country; score band; product/vertical; capacity weighted; workload weighted; skill based; account ownership; partner ownership; fallback queue. A policy composes strategies; it never invents new side channels.

### 1.6 Publication and rollback

Publication makes a version the effective one from an explicit timestamp. **Rollback publishes a new version whose definition is copied from an earlier one — it never rewrites or deletes history.** Every run permanently references the version that produced it, so historical decisions stay reproducible after any number of rollbacks. This is the repository-wide policy-versioning rule: the Git log shows how source evolved, but runtime versioning lives in the database records the runs reference.

### 1.7 Permissions

- Sales may accept/take assignments allowed to them.
- Sales Managers may reassign within their scope, with a reason.
- RevOps may publish scoring/routing policy versions.
- Admin overrides follow RBAC.

The **service boundary** enforces all of this — never the UI. Honest limit: real multi-user authorization cannot be validated before the Production Spine (authentication, tenancy, RBAC — `EXECUTION_ROADMAP.md` Phase 6). Until then these permissions are enforced against declared actor identity on a local-development surface, and the JTBD matrix must not claim them validated.

---

## 2. Commercial Operations / CPQ

### 2.1 User journey

```text
Opportunity
→ catalog / price book
→ Quote (versioned, lines from price book entries)
→ discount policy evaluation
→ commercial approval (human, deterministic policy)
→ document generation
→ e-signature (provider, verified events)
→ immutable signed artifact
→ Order (immutable commercial snapshot) + Order Lines
```

### 2.2 Product and pricing primitives

- **Product / ProductVersion** — what is sold, with immutable versions so a Quote references the exact definition it was priced against;
- **PriceBook / PriceBookEntry** — named price lists (per currency, segment, country) whose entries bind a ProductVersion to a price in integer minor units (the framework's money contract, ADR-013/014);
- **Bundle** and **PricingRule** — composed offerings and deterministic price computation rules.

### 2.3 Catalog providers and source of truth

Catalogs may live inside the CRM or in an external system: internal custom catalog; Stripe Products/Prices; Zuora or an external CPQ; ERP; custom provider. Each is a **catalog provider** behind one contract. Two rules make this safe:

1. **Explicit source-of-truth policy per project** — either the CRM catalog is authoritative and providers export, or the external system is authoritative and the CRM holds synchronized read models. Never both, never implicit.
2. **Immutable commercial snapshots** — a Quote line and an Order line copy the price, product version and terms they were agreed at. A later catalog sync must never change what a customer already saw or signed.

### 2.4 Quotes

**Quote / QuoteVersion / QuoteLine**: a Quote is versioned like a policy — sending a revised offer creates a new QuoteVersion; the sent/accepted version is immutable. Lines reference PriceBookEntry + ProductVersion and carry computed amounts as integer minor units, per currency, never summed across currencies.

### 2.5 Discount policies and commercial approvals

**DiscountPolicy / DiscountPolicyVersion** are code-first deterministic policies (same versioned shape as scoring/routing) that may consider: discount percentage; ARR/value; gross margin; contract duration; payment terms; product; country; partner; price book; customer segment. A **DiscountRequest** records what was asked, which policy version evaluated it, and what approval it requires.

Approval reuses the framework's proven primitive (ADR-003): a deterministic policy creates a human-only approval decision; an agent actor attempting the decision is rejected. **No generic PATCH may bypass discount approval** — discount and approval state are managed fields writable only through the in-process managed path (ADR-011), exactly like lifecycle and pipeline state today.

### 2.6 Signature and immutable artifacts

**SignatureEnvelope / Signer / SignedArtifact** with a signature provider contract covering DocuSign, Adobe Sign, Dropbox Sign and custom providers. Provider events (webhooks) must be **verified** before they mutate anything; a verified completion event creates or updates the immutable **SignedArtifact**. Sending an envelope is an external action that requires human approval (it exposes commercial data and creates legal effect).

### 2.7 Orders

**Order / OrderLine** are created from a signed Quote version and preserve the full signed commercial snapshot — products, versions, prices, terms, artifact reference — even when the live catalog changes later. The Order is the handover boundary to Delivery (`DELIVERY_SERVICE.md`).

---

## 3. What is native, what is a provider, what is a policy

| Concept | Classification | Why |
|---|---|---|
| EnrichmentSnapshot, BehavioralSignal | **Native primitive** | Provenance and signal history are framework guarantees every project needs identically |
| ScoreRun, ScoreContribution, RoutingRun, Assignment, AssignmentOverride | **Native primitive** | Explainability and reproducibility are structural, not per-project choices |
| SalesCapacity, SalesAvailability, Territory | **Native primitive** | Reference data with one obvious deterministic shape |
| Product, ProductVersion, PriceBook, PriceBookEntry, Bundle | **Native primitive** | Immutable commercial identity must be uniform for snapshots to work |
| Quote, QuoteVersion, QuoteLine, DiscountRequest, Order, OrderLine, SignatureEnvelope, Signer, SignedArtifact, Document | **Native primitive** | The transactional record and its immutability rules are the framework's job |
| Policy/PolicyVersion/PolicyRun envelope (shared) | **Native primitive** (bounded) | One reusable versioned-policy model for scoring, routing, discount — generalized only after two real consumers prove the shape (handover §5 rule; same discipline as ADR-014's "premature before a second consumer") |
| EnrichmentProvider (Clearbit-style, marketing, analytics, billing, ERP, custom) | **Provider contract** | External systems vary; the contract isolates them (ARCHITECTURE.md providers rule) |
| Catalog provider (internal, Stripe, Zuora/CPQ, ERP, custom) | **Provider contract** | Same — plus the explicit source-of-truth policy |
| Signature provider (DocuSign, Adobe Sign, Dropbox Sign, custom) | **Provider contract** | External legal-effect systems, verified events required |
| ScoringModel/Rules, RoutingPolicy/Rules, DiscountPolicy, pricing rules | **Code-first policy** | Business-specific logic the agent writes from the brief as reviewable source, validated fail-closed at startup, published as versions at runtime |
| Routing strategies (round robin, territory, capacity …) | **Code-first policy building blocks** shipped by the framework | Deterministic, reusable, composed — never a low-code rule engine |

**Deliberately not built:** a universal low-code rule engine, fuzzy AI-decided routing or scoring at runtime, provider-side hidden writes, or any claim that these permissions are enforceable for real external users before the Production Spine.

---

## 4. Dependencies and human approvals

- **Production Spine (Phase 6)** gates: real multi-user permission validation (manager reassignment scopes, RevOps publish rights), any remote exposure of these surfaces, and customer/partner-facing views.
- **Human approval always required for:** connecting a paid external provider account; any provider action that sends (envelopes, emails), signs, charges (Stripe/Zuora writes) or exposes data externally; publishing a policy version to production once real users exist; the commercial approval decisions themselves (they are human-only by design).
- **Agents execute:** primitives, provider contracts, policies-from-brief, tests, starters, benchmark evidence — through the same public services and ExecPlans as every prior milestone.

JTBD tracking for these workstreams: `docs/benchmarks/CRM_JTBD_MATRIX.md` (Lead Intelligence and Commercial Operations sections — everything starts **not supported**). Benchmark scenario: Revenue Operations E2E in `CRM_BUILD_BENCHMARK.md` (planned, not implemented).
