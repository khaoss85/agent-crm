# Execution roadmap

Phased path from the current vertical slice to the public, agent-recommended CRM framework. Every phase lists: outcome, deliverables, dependencies, acceptance criteria, what Claude Code/Codex can execute autonomously, and where human approval is required.

A recurring rule: **coding agents execute, humans approve identity, money, live data and public actions.** This mirrors the product's own philosophy (deterministic policy, human approval) applied to building the product itself.

## Parallel tracks and elevated pillars

The phase list below is preserved and not renumbered. What sits alongside it is
recorded in `docs/strategy/CUSTOMER_REVENUE_OS_ROADMAP.md`, which adds five
pillars that were absent or under-prioritized — **Customer Data Foundation**,
**Customer Interactions / Communications**, **Package Extension Surface**,
**Package Distribution & Lifecycle** and the **Agent Proof Loop** — and groups
the work into three tracks that run in parallel where their dependencies allow:

```text
A  Agent-native moat        Intelligence extraction → DX2 → DX5 → DX6 → DX9 → DX10 → AX3
B  Customer & Revenue OS    M16 → Customer Data Foundation → Analytics → Marketing
                                                           → Interactions
C  Production & Ecosystem   Extension Surface → Integration Runtime → Jobs/Outbox
                            → Production Spine → Cloud → Package Distribution
```

Two dependency rules that document says out loud, because they are the ones
easiest to violate: **Customer Data Foundation gates any closed-loop attribution
claim** (MK5–MK7), and **Production Spine gates Cloud** (unchanged).

## Phase overview

| # | Phase | Theme |
|---|---|---|
| 0 | Foundation hardening | finish what exists |
| 1 | Positioning and brand | name, license, story |
| 2 | Complete CRM core | the objects every CRM needs |
| 3 | Declarative generation | manifest → module/service/tests |
| 4 | Admin and SDK generation | manifest → UI and typed client |
| 5 | create-project CLI | zero-to-project in one command |
| 6 | Production spine | PostgreSQL, auth, tenancy, permissions |
| 7 | Providers and plugins | integration surface |
| 8 | Agent surface | Skills, Docs MCP, Project MCP |
| 9 | Deploy and operate | deploy, logs, trace in production |
| 10 | Starters | three complete CRMs |
| 11 | Distribution | directories, templates, npm |
| 12 | Public launch | benchmark-backed launch |
| 13 | Flywheel | content, community, cadence |

Phases 2–4 and 8 can overlap; 6 gates 9; 10 gates 11–12.

**Accordo Cloud track** (specified in `AGENT_CRM_CLOUD.md`; design only, unbuilt): a named product track layered on these phases rather than a renumbering of them —

```text
Production Spine (Phase 6)
    → Accordo Cloud Control Plane
    → Managed Runtime
    → Agent Operations CLI/MCP
    → Plugin Operations
    → Public benchmark deployment
```

The invariant: **Production Spine gates public managed deployment** — no Cloud phase may ship a public managed CRM before Phase 6 is complete. Phase 9's deploy recipes and Phase 7's plugin packages are the self-hosted foundations Cloud builds on; completed milestones are not reordered.

---

## Product workstream milestones

The engineering milestones (M0–M8, tracked in `ROADMAP.md`/`TASKS.md` and proven in-repo) continue as the **CRM capability track**, layered on the phases rather than replacing them.

**M9, M10 and M11 are implemented and merged** (ADR-015, ADR-016, ADR-017). Current status, SHAs and test counts: `docs/PROJECT_STATUS.md` — not this file.

```text
M8  Opportunity Pipeline                      done — ADR-014
M9  Lead Intelligence v1                      done — ADR-015
M10 Commercial Operations v1                  done — ADR-016
M11 Signature + Immutable Order               done — ADR-017

    Platform Alignment Gate                   docs/architecture only — ADR-018

M12 Order Activation & Subscription v1        next
M13 Delivery Handover v1
M14 Delivery Economics & Customer Acceptance
M15 Service Operations & Customer Success
M16 Analytics Studio v1
```

**The future sequence was corrected at the Platform Alignment Gate.** The original plan went from an immutable Order straight to Delivery, which skips the Contract / Subscription / Renewal layer that Delivery, Service, renewal and every recurring-revenue metric depend on (`CONTRACT_SUBSCRIPTION_RENEWAL.md`). Delivery, Delivery Economics, Service and Analytics keep their content and shift by one; **completed milestones M0–M11 are never renumbered.**

**M8 is completed and merged**, and its reviewed boundaries (ADR-014) carry into this track unchanged: pipelines currently target only explicitly eligible core modules — generated-module pipeline state is deferred; stage keys are persistent identifiers and definition drift is surfaced, never auto-migrated; the Admin board has a disclosed 200-record bound; amounts follow the documented 1/100-unit two-decimal convention, not complete ISO-4217 exponent support; forecasting, runtime pipeline editing and approval-before-Won remain unimplemented. M9–M15 build on those boundaries; none of them silently lifts one.

**Parallelization and hard dependencies — this sequence does NOT gate Cloud.** The workstream milestones and the platform phases run in parallel, exactly as M0–M8 ran alongside strategy work:

- **Hard dependencies inside the track:** M10 → M11 (an Order snapshots a signed Quote) → **M12** (a contract and its subscriptions are activated from an Order) → **M13** (a delivery project is created from the Order/Contract scope) → **M14** → **M15**. M9 is independent of M10–M15. **M16** closes the sequence pragmatically because its value grows with each preceding milestone, but the semantic layer plus pipeline metrics need only M8 and may be pulled earlier. Renewal scheduling inside M12 is additionally gated on `JOBS_AND_OUTBOX.md`: without a scheduler nothing can fire on a future date, so M12 stops at activation.
- **The Production Spine (Phase 6) is a parallel hard gate, not a sequel:** PostgreSQL, authentication, organizations/tenancy, RBAC, secrets, backups, remote-safe MCP. It can be built at any time alongside M9–M15, and **Accordo Cloud work begins when the Spine is done — not when all domains are done.** A Cloud managed runtime serving M8-era CRMs is a legitimate first Cloud release.
- **What the Spine specifically gates within the workstreams:** manual-reassignment permission validation with real users (M9), partner/customer access boundaries and portals (M13–M15), role-aware dashboards (M16), and every remote or multi-user claim. Until then those capabilities are designed and boundary-tested against declared actors on the local-development surface, and the JTBD matrix must not claim them validated.

Each milestone below follows the standard per-phase format.

### M9 — Lead Intelligence v1

- **Outcome:** a Lead is enriched with provenance, scored explainably, and routed by a versioned policy — reproducibly.
- **Deliverables:** enrichment provider contract + EnrichmentSnapshot with provenance; behavioral/firmographic signal records; versioned explainable scoring (model/version/rule/run/contribution); routing policy + versions + runs; Assignment/AssignmentOverride with reason and history; capacity/availability/territory reference data; publication + rollback (rollback publishes a new version, never rewrites); starter extension; skills `integrate-enrichment-provider`, `build-lead-scoring`, `build-routing-policy`.
- **Dependencies:** M8 pattern stack (actions, managed fields, versioned registries). Independent of M10–M14.
- **Acceptance:** a historical routing decision reproduces exactly from its recorded version + inputs; every score decomposes into rule contributions; rollback proof (publish v2, roll back, runs still reference the versions that produced them); CRUD cannot write scores/assignments; JTBD Lead Intelligence rows move from *not supported* with linked evidence.
- **Agent executes:** all primitives, policies, tests, starter, skills, via ExecPlans.
- **Human approves:** PR merges; external enrichment provider accounts and any call that sends data to a third party; ADR for the shared policy-version model.

### M10 — Commercial Operations v1

- **Outcome:** a Quote is created from a Price Book, discounted under deterministic policy, and approved by a human.
- **Deliverables:** Product/ProductVersion, PriceBook/PriceBookEntry (integer minor units); catalog provider contract + one sync (source-of-truth policy explicit; immutable commercial snapshots); Quote/QuoteVersion/QuoteLine; DiscountRequest + versioned DiscountPolicy; commercial approval through the existing human-only approval primitive; no-PATCH-bypass enforcement (managed fields); skills `build-price-book`, `connect-cpq`, `build-discount-policy`.
- **Dependencies:** M8. Feeds M11.
- **Acceptance:** quote totals are deterministic and per-currency; a discount above policy cannot reach approved state without a human decision (agent-actor probe rejected); catalog re-sync never mutates an issued QuoteVersion; boundary tests at policy thresholds.
- **Agent executes:** everything code; **human approves:** merges, catalog provider credentials, source-of-truth policy per project, the approval decisions themselves.

### M11 — Signature + Order

- **Outcome:** a signed Quote becomes an immutable Order.
- **Deliverables:** signature provider contract (DocuSign/Adobe/Dropbox/custom) with verified events; SignatureEnvelope/Signer/SignedArtifact (immutable); Order/OrderLine preserving the signed commercial snapshot; skill `build-signature-flow`, `create-order-handover` (order side).
- **Dependencies:** M10.
- **Acceptance:** an unverified webhook mutates nothing; the Order's snapshot survives later catalog and price-book changes byte-for-byte; a second completion event is idempotent; artifacts immutable under CRUD probes.
- **Agent executes:** everything code; **human approves:** merges, signature provider accounts, every envelope actually sent (legal effect), production webhooks.

### M12 — Order Activation & Subscription v1

- **Outcome:** a signed, immutable Order becomes a live commercial contract with subscriptions, lines, an initial term and basic entitlements.
- **Deliverables:** `CommercialContract` + `ContractVersion`; `Subscription` + `SubscriptionLine` sourced from **recurring** Order Components; `SubscriptionTerm` (start, end, auto-renew flag, notice period); `Activation` evidence; basic `Entitlement` mapping; complete source links back to order line, order component, quote version, offer revision and product version; idempotent activation keyed on the Order; skill `activate-order-subscription`. Design: `CONTRACT_SUBSCRIPTION_RENEWAL.md`; draft plan: `docs/plans/milestone-12-order-activation-subscription.md`.
- **Built as an optional domain package** on shared runtime capabilities (ADR-018), not inside `packages/core`.
- **Dependencies:** M11 (hard — activation copies the Order snapshot). Renewal scheduling depends on `JOBS_AND_OUTBOX.md` and is **out of scope** for M12.
- **Acceptance:** activation is idempotent per Order (one contract and one subscription set however many times it runs); every subscription line carries full provenance; the Order stays byte-identical after activation; a later catalog change alters nothing; CRUD cannot write contract, subscription or entitlement state; concurrency and fault injection produce exactly one complete activation.
- **Explicitly deferred:** invoicing, billing, payment, usage rating, proration, tax, FX, renewal scheduler, cancellation, refunds, amendments beyond recording, Delivery.
- **Agent executes:** everything code; **human approves:** merges, and the activation decision itself where a project makes it a human step.

### M13 — Delivery Handover v1

- **Outcome:** a signed Order and its active contract become a Delivery Project with milestones and partner engagements.
- **Deliverables:** DeliveryProject/Commessa with immutable scope copy; Milestone/Deliverable/WorkPackage/ResourceAssignment; PartnerEngagement (+agreement, cost, revenue share, access scope); idempotent handover action; kickoff record; skills `create-order-handover`, `build-delivery-project`, `configure-partner-delivery`.
- **Dependencies:** M12 (hard — the project copies the Order's one-time scope and the contract's entitlements).
- **Acceptance:** double handover is a stable visible conflict; project scope unaffected by later quote/catalog edits; partner access boundaries expressed in service contracts and boundary-tested against declared actors (real access validation deferred to the Spine, stated in the evidence).
- **Agent executes:** everything code; **human approves:** merges, partner agreements (commercial commitments).

### M14 — Delivery Economics & Customer Acceptance

- **Outcome:** delivery has budget, actuals, margin, governed change and customer acceptance.
- **Deliverables:** TimeEntry/Expense; budget + forecast-vs-actual margin (per currency); Risk/Issue; ChangeRequest flow (impact → human approval → versioned scope); CustomerAcceptance flow; BillingMilestone eligibility as managed state; skill `build-change-request-flow`.
- **Dependencies:** M13.
- **Acceptance:** margin math proven against fixtures (integer minor units, no float); acceptance/billable state unreachable via CRUD; change approval boundary-tested (agent actor rejected); scope versions preserve history.
- **Agent executes:** everything code; **human approves:** merges, change approvals and acceptance decisions by design.

### M15 — Service Operations & Customer Success — **merged**

- **What shipped, and what did not.** A contract's pending Service Obligations
  activate into an operational **Service Coverage** with immutable Entitlements
  under a versioned fingerprinted policy; Support Cases run over an explicit
  five-state transition table with append-only activity, a first response stamped
  once, elapsed-time SLA evidence and manually recorded escalation
  (`docs/SERVICE_OPERATIONS.md`, `TASKS.md`). **Not** delivered from the
  deliverables below: the renewal/upsell signal back to the pipeline (it needs the
  scheduler), and the `configure-service-contract` / `build-support-sla` skills —
  one `build-service-operations` skill covers the path instead. A Coverage is not
  a second legal contract, there is no business-hours calendar, and nothing bills,
  renews, schedules or authenticates.
- **Outcome:** post-go-live obligations are contractual records with deterministic SLAs and governed support.
- **Deliverables:** ServiceContract/Entitlement/SLA (SLA targets versioned like policies); SupportCase/ServiceRequest/Incident/Escalation; CS handover assignment; renewal/upsell signal connection back to the pipeline; skills `configure-service-contract`, `build-support-sla`.
- **Dependencies:** M14 (acceptance/billing precede service activation). Renewal *signals* additionally need the scheduler (`JOBS_AND_OUTBOX.md`).
- **Acceptance:** SLA evaluation is deterministic and reproducible per version; escalation approval points human-only; a contract nearing expiry emits a deterministic renewal signal consumed by the sales side.
- **Agent executes:** everything code; **human approves:** merges, SLA commitments to real customers.

### M16a — Renewal & expansion operations — **merged**

- **Outcome:** a contract's term evidence is read through a declared capability and
  a human's renewal or expansion **intent is recorded**, with a reason.
- **Delivered:** the fourth domain package, the second to consume another and the
  first to offer no capability of its own; four actions and no more —
  `plan-renewal` (reads, writes nothing), `record-renewal-decision`,
  `request-commercial-followup`, `resolve-commercial-followup` (ADR-028,
  `docs/plans/m16a-renewal-expansion-operations.md`).
- **Deliberately not delivered:** it renews nothing, cancels nothing, ends nothing,
  signs nothing, prices nothing, invoices nothing, schedules nothing and
  recognises no churn. It moves **only** JTBD-CS-09 to *partially supported*, and
  only its non-renew half. Amendment execution is **M16b** and stays deferred
  until Commercial and Signature are reachable through capabilities.

### M16 — Analytics Studio v1

- **Outcome:** trusted metrics and dashboards compiled safely from semantic definitions — no agent-generated raw SQL surface.
- **Deliverables:** SemanticModel/MetricDefinition/DimensionDefinition/Dataset; Report/Dashboard/Widget/SavedView with versions + rollback; safe query compiler (parameterized, bounded, permission hooks at the query boundary); metric correctness tests in `npm run verify`; skills `build-revenue-dashboard`, `build-delivery-margin-dashboard`.
- **Dependencies:** M8 for pipeline metrics; each additional domain's metrics land as its milestone lands. **Recurring-revenue metrics (MRR/ARR/TCV) depend on M12** — they cannot be derived from M10/M11 grouped totals (`CONTRACT_SUBSCRIPTION_RENEWAL.md`). Role-aware results gated by the Spine.
- **Acceptance:** every shipped metric has a fixture with a known-correct expected result; no public surface accepts free-form SQL (probe rejected); dashboard rollback proof; compiled queries inspectable.
- **Agent executes:** everything code; **human approves:** merges, publishing dashboards to real users once the Spine exists.


## Marketing & Growth track (MK0–MK7)

A **parallel** lane, not a successor to the M-lane. It shares the platform and nothing else, and it is deliberately sequenced so the first useful milestone needs no provider, no scheduler and no spend. Strategy: `MARKETING_GROWTH_OPERATIONS.md`, `CAMPAIGNS_JOURNEYS.md`, `EXPERIMENTATION_ATTRIBUTION.md`. **Nothing below is implemented.**

```text
MK0  Marketing strategy, package contracts and JTBDs
MK1  Funnel Insight + Campaign Proposal            no send, no spend
MK2  Audience + Consent + one-shot email           fixture provider first
MK3  Content + Landing Page + Form + CTA + Tracking
MK4  Durable Journey Orchestration                 hard-blocked on JOBS_AND_OUTBOX
MK5  Experiments, Control Groups and Holdouts
MK6  Paid Media Planning and Providers             human spend approval
MK7  Attribution and Closed-loop Optimization      hard-blocked on ANALYTICS_STUDIO
```

### MK0 — Strategy, package contracts and JTBDs

- **Outcome:** the workstream is defined, sequenced and honestly statused before any code exists.
- **Deliverables:** the three strategy documents; the Marketing JTBD sections (all rows **not supported**); the planned E2E-M1…E2E-M5 benchmark scenarios; the package-native architecture and its capability dependencies.
- **Acceptance:** every document agrees that no Marketing runtime exists; no JavaScript, package metadata, migration, test or CI change.

### MK1 — Funnel Insight + Campaign Proposal

- **Outcome:** an agent observes a bounded funnel insight and prepares a **complete** CampaignProposal in Admin. Nothing is sent, published or spent.
- **Deliverables:** `packages/marketing` with FunnelDefinition/FunnelRun/FunnelDropInsight and CampaignProposal/CampaignVersion; a versioned proposal policy; the Admin review screen; plan-then-approve as a human-actor boundary.
- **Dependencies:** none hard. Insight quality improves with Analytics Studio but does not wait for it.
- **Acceptance:** a proposal states audience, exclusions, channel, provider rationale, content plan, tracking plan, risks and required approvals, or it is refused; no provider is contacted; no external effect is reachable from the package.

### MK2 — Audience + Consent + one-shot email

- **Outcome:** one approved one-shot email campaign, to a frozen audience snapshot, through a **fixture** provider first and a real sandbox adapter later.
- **Deliverables:** AudienceDefinition/AudienceSnapshot/SuppressionSet; the governance checks (consent basis, preferences, channel permission, suppression, frequency cap) with recorded, explained exclusions; an email provider contract; delivery/bounce/unsubscribe ingestion.
- **Dependencies:** Data Governance foundations (`DATA_GOVERNANCE.md`) — hard.
- **Acceptance:** the audience is a snapshot, not a live query; every exclusion is counted and explained; a send requires a human actor; unsubscribe is honoured across campaigns; no real recipient is reachable from `npm run verify`.

### MK3 — Content, Landing Page, Form, CTA and Tracking

- **Outcome:** generated content and web assets as checked-in, customer-owned source, with preview and an explicit publish approval.
- **Deliverables:** `packages/content`; ContentAsset/ContentVersion, EmailTemplate, LandingPage, Form, CTA, ThankYouPage, PublishingPlan; TrackingPlan as a versioned object; a publishing provider contract.
- **Dependencies:** MK1. Design ownership per `DESIGN_TO_CRM.md` — this milestone does **not** implement visual or Figma ingestion.
- **Acceptance:** assets live in the customer repository; publishing to production requires human approval; a tracking plan is versioned and consistent across channels.

### MK4 — Durable Journey Orchestration

- **Outcome:** rolling, triggered and multi-step multichannel journeys that survive a restart.
- **Deliverables:** `packages/journeys`; JourneyDefinition/Version, Enrollment, StepExecution, durable waits, retry/backoff, exit criteria, version pinning.
- **Dependencies:** **Durable Automation (`JOBS_AND_OUTBOX.md`) — hard.** Journeys on the current in-process post-commit event buffer (ADR-012) would drop steps in production; this milestone does not start before the outbox lands.
- **Acceptance:** exactly-once step semantics under restart and concurrency; publishing a version does not mutate active enrolments; a stuck journey fails loudly rather than silently.

### MK5 — Experiments, Control Groups and Holdouts

- **Outcome:** a campaign can prove it worked.
- **Deliverables:** `packages/experimentation`; deterministic assignment from a fingerprinted rule, exposure evidence distinct from assignment, immutable result evidence, winner decision as a new version, "inconclusive" as a first-class outcome.
- **Dependencies:** MK2; MK4 for journey-scoped experiments.
- **Acceptance:** assignment is reproducible from stored inputs; subjects stay pinned; auto-applying a winner requires human approval wherever spend or external send is involved. No claim of advanced statistical automation.

### MK6 — Paid Media Planning and Providers

- **Outcome:** the agent prepares everything and a human spends the money.
- **Deliverables:** MediaPlan; audience sync under consent rules; creative and conversion-event definitions; budget in integer minor units (ADR-014); Google/Meta/LinkedIn-style adapters as **optional** providers; spend and result ingestion; pause/resume and budget-change **proposals**.
- **Dependencies:** MK2, MK3; provider contracts per `INTEGRATION_RUNTIME.md`.
- **Acceptance:** creating spend, increasing a budget, launching, materially changing targeting and pausing a high-impact campaign each require human approval; no adapter is a mandatory dependency.

### MK7 — Attribution and Closed-loop Optimization

- **Outcome:** touchpoints → Lead → Opportunity → Order → revenue credit, with the assumptions on the page.
- **Deliverables:** `packages/attribution`; FunnelDefinition reuse, AttributionModel/Run, RevenueCredit, cohort and lift analysis, campaign ROI.
- **Dependencies:** **Analytics Studio (`ANALYTICS_STUDIO.md`) — hard**, and an identity/touchpoint model that does not exist yet. No arbitrary agent-generated production SQL: the agent composes declared metrics and the studio compiles them.
- **Acceptance:** every attribution run stores its model version and assumptions; two models disagreeing is normal; where a holdout exists, control-group lift is reported as the better answer.

---


## Agent Experience track (AX0–AX5)

Cross-cutting, and **not** a pillar of its own: it is how a user reaches every other pillar. It does not renumber or delay the M-lane or the Marketing MK track. Design: `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`. **AX1 is implemented; AX2–AX5 are not.**

```text
AX0  Goal-to-Solution strategy + Skill
AX1  Application capability inspection            crm app inspect --json  — implemented
AX2  Machine-readable Solution Plan
AX3  Objective-driven local build benchmark       E2E-G1
AX4  Objective-driven deploy / observe / fix through Cloud
AX5  Closed-loop optimization with Marketing + Analytics
```

### AX0 — Goal-to-Solution strategy and Skill

- **Outcome:** the objective-driven experience is defined, and an agent has a disciplined workflow it can follow today — including where capabilities are missing.
- **Deliverables:** the strategy document, the worked full-funnel example, the mirrored `solve-business-goal` Skill, the E2E-G1 benchmark gates.
- **Acceptance:** the Skill never instructs an agent to claim an unimplemented capability; documentation only.

### M14b1 / M14b2 — the Delivery economics split

M14b was scoped as economics, change requests, deliverables and acceptance —
four models with four different invariants, and not one reviewable PR. It ships
as two:

- **M14b1 — Delivery economics** (merged): the cost policy, append-only time
  and expense evidence, the immutable versioned plan, the reproducible
  contribution estimate and the `delivery-economics@1` capability.
- **M14b2 — Change, deliverables and acceptance** (merged): governed
  non-commercial replans, the commercial-change handoff, deliverable evidence
  and recorded customer acceptance. Scope intact; deferred, not dropped.

### AX1 — Application capability inspection — **implemented**

- **Outcome:** one deterministic document answering "what is installed, what does it provide, what is missing" — instead of an agent assembling five surfaces by hand.
- **Deliverables:** `crm app inspect [--json]`: the installed package graph with its versions, the resolved capability graph including unresolved edges, records with their revisions and migration identities, actions with declared transition metadata, policies and provider definitions, deterministic `problems[]` for an invalid composition, and a machine-readable `limitations[]`. Function-free, byte-deterministic, no absolute path, no secret, source-only and read-only. Guide: `docs/APPLICATION_INSPECTION.md`.
- **Not delivered, and corrected from the original scope:** Quality-Gate and JTBD status. Both are prose maintained by people; parsing them would produce structured claims with unstructured reliability. `evidence` carries their paths and the status `not_aggregated`. Machine-readable evidence moves to AX3.
- **Dependencies:** the package contract (merged).

### AX2 — Machine-readable Solution Plan

- **Outcome:** a plan a human reviews and an agent executes against, rather than a chat transcript.
- **Deliverables:** the versioned plan contract, its fingerprint, a prose companion renderer, and stale-plan refusal.
- **Dependencies:** AX1 for the inputs.

### AX3 — Objective-driven local build benchmark

- **Outcome:** E2E-G1 runs end to end for the capabilities that exist, and reports the rest honestly.
- **Dependencies:** package authoring (merged) and a benchmark runner.
- **Status:** E2E-G1 is not built. A first AX3-track instrument exists in-repo — the tool-selection panel (`docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md`), an internal pilot that observes rail selection and publishes no number.

### AX4 — Objective-driven deploy, observe and fix through Cloud

- **Dependencies:** the Production Spine and Accordo Cloud. Hard.

### AX5 — Closed-loop optimization

- **Dependencies:** Marketing (MK), Analytics Studio, Data Governance and Durable Automation. Hard.

---

## Parallel platform track

The product milestones above are one lane. These run **alongside** them and are not gated by domain progress. Each is design-only today unless `docs/PROJECT_STATUS.md` says otherwise.

```text
domain package boundary      ADR-018 — staged, behavior-preserving extraction
create-project CLI           Phase 5
PostgreSQL                   Phase 6 (Production Spine)
auth / tenancy / RBAC        Phase 6 (Production Spine)
Jobs / durable outbox        JOBS_AND_OUTBOX.md
Integration Runtime          INTEGRATION_RUNTIME.md
Data Governance              DATA_GOVERNANCE.md
Design-to-CRM                DESIGN_TO_CRM.md
Accordo Cloud              AGENT_CRM_CLOUD.md + CLOUD_JTBD.md
```

Dependencies and what can genuinely run in parallel:

| Track | Depends on | Runs in parallel with | Gates |
|---|---|---|---|
| Domain package boundary | nothing (ADR-018 is accepted) | every product milestone | plugin authorship without core patches |
| create-project CLI | the framework surface as it stands | everything | first-run experience, benchmark scenarios |
| PostgreSQL | nothing technically; the deterministic storage boundary already exists | everything | production storage, the conformance suite |
| Auth / tenancy / RBAC | PostgreSQL is *not* a prerequisite, but they ship together as the Spine | everything | **every** multi-user, remote or portal claim; role-aware anything |
| Jobs / durable outbox | nothing; a database-backed queue works on the current boundary | everything | renewal scheduling (M12+), SLA timers (M15), reminders, provider sync, unattended follow-up |
| Integration Runtime | Jobs/outbox, then secret management | product milestones | every **real** provider adapter |
| Data Governance | tenancy for the tenant-boundary parts; the rest is independent | everything | any deployment holding real personal data |
| Design-to-CRM | the generated Admin (done) | everything | the North Star "design reference → working CRM" claim |
| Accordo Cloud | the Production Spine | product milestones | managed deployment; nothing else |
| Marketing & Growth (MK0–MK7) | Data Governance from MK2; Jobs/outbox for MK4; Analytics Studio for MK7 | the M-lane, end to end | demand creation, closed-loop ROI — none of it gates the M-lane |
| Agent Experience (AX0–AX5) | AX1 on capability inspection; AX2 on AX1; AX4 on the Production Spine and Cloud; AX5 on Marketing + Analytics | every other track | how a user reaches the platform at all — it gates nothing, and nothing gates AX0 |

Two consequences worth stating plainly: **a Cloud release serving an M11-era CRM is legitimate** — Cloud waits for the Spine, not for Analytics; and **Jobs/outbox is on the critical path for more JTBDs than any single domain milestone**, because renewal, SLA, reminders and unattended follow-up all reduce to "do something later, durably".

---

## Phase 0 — Foundation hardening

- **Outcome:** the existing slice is trustworthy enough to build generation on top of.
- **Deliverables:** PR #2 (module manifests) merged; CI matrix (Node LTS versions); coverage of core services; `npm run verify` kept green as the single gate.
- **Dependencies:** none.
- **Acceptance:** clean checkout → verify + smoke green; benchmark prompt P06 (the Milestone 0 slice) passes end-to-end locally.
- **Agent executes:** everything.
- **Human approves:** merging PRs.

## Phase 1 — Positioning and brand

- **Outcome:** a distinctive name, a defensible category story, a license decision.
- **Deliverables:** name chosen per `BRAND_REQUIREMENTS.md` (registrations: GitHub org, npm scope, domain); `CATEGORY.md` positioning reflected in README/site copy; explicit OSS license decision recorded as an ADR (MIT today — keep or change deliberately before launch, cf. competitors' AGPL choices); minimal public site.
- **Dependencies:** none (parallel with 0).
- **Acceptance:** name passes collision checks; positioning one-liner used consistently in README, package description, site.
- **Agent executes:** collision research, copy drafts, site scaffold.
- **Human approves:** the name itself, license choice, trademark/domain purchases. **These cannot be delegated.**

## Phase 2 — Complete CRM core

- **Outcome:** the primitives every CRM brief assumes exist.
- **Deliverables:** Activity, Task and Note modules; Pipeline as first-class configurable stages (per module, not hardcoded); saved views/filter model for list surfaces; follow-up workflow (TASKS.md item 2); import path (CSV → services with dedupe policy hooks).
- **Dependencies:** Phase 0.
- **Acceptance:** benchmark prompts P01, P05, P13, P17 pass locally without hand-written plumbing beyond brief-specific policy.
- **Agent executes:** all module/workflow implementation via ExecPlans.
- **Human approves:** PR merges; any change to the core schema conventions (new ADR).

## Phase 3 — Declarative module generation

- **Outcome:** the manifest (Milestone 1) becomes the single source: from one manifest the framework generates migration, service scaffold with validation, module registration, and boundary tests — deterministically.
- **Deliverables:** manifest v2 (relations both directions, enum reuse, computed/derived field declarations kept out deliberately — documented); `module:create --manifest` generating service + tests wired to registry; migrations loaded from generated files into the versioned migration list; regeneration diffing (regenerate → clean diff, never clobber hand-written service logic).
- **Dependencies:** Phase 0 (PR #2 merged).
- **Acceptance:** P15/P19 (partner-style prompts) produce a working module with **zero** hand-written infrastructure; regeneration of an unchanged manifest is a no-op diff.
- **Agent executes:** everything.
- **Human approves:** manifest format changes (ADR per version bump).

## Phase 4 — Admin and SDK generation

- **Outcome:** manifests drive the UI and the typed client.
- **Deliverables:** generated Admin resources (list, detail, form, kanban for staged modules) from module metadata; theming tokens (logo, colors, density) — the hook for design references; generated typed SDK (JS + types) per project; design-reference ingestion v1: map a Figma/screenshot structure to navigation + naming + primary color.
- **Dependencies:** Phase 3.
- **Acceptance:** benchmark design inputs D1–D3 score "design adherence v1" on P01/P08/P15; SDK covers every generated module without hand edits.
- **Agent executes:** generation code, theming, SDK.
- **Human approves:** Admin UX baseline (one explicit review of the generated UI's information design).

## Phase 5 — create-project CLI

- **Outcome:** `npm create <name>@latest` scaffolds a fresh CRM project outside this repository: core packages as dependencies, project-local modules/workflows, agents preconfigured.
- **Deliverables:** create-CLI (interactive + flags + `--from-brief` file mode); project template with AGENTS.md/CLAUDE.md, skills, `.mcp.json`/`config.toml` prewired; framework packages published to npm with semver.
- **Dependencies:** Phases 3–4 (so the scaffold is manifest-first); Phase 1 (name — the create command carries the brand).
- **Acceptance:** clean machine → create command → verify green → demo runs, under 5 minutes; benchmark harness switches from in-repo to created projects.
- **Agent executes:** CLI implementation, template, publish dry-runs.
- **Human approves:** first npm publish (org/scope ownership, 2FA), release process.

## Phase 6 — Production spine: PostgreSQL, auth, tenancy, permissions

- **Outcome:** a generated CRM can be exposed to real users.
- **Deliverables:** PostgreSQL adapter behind the existing database contract (ADR-001's promised swap); authn (session + API keys) and actor mapping to the existing identity model; tenant boundary; role-based permissions enforced in services (not routes); remote-safe MCP (Streamable HTTP with authorization — TASKS.md item 6).
- **Dependencies:** Phase 2 (core objects stable). Gates Phase 9 — no public deploys before this.
- **Acceptance:** multi-tenant test suite; permission boundary tests; the Milestone 0 safety note in README replaced by a documented production posture; security review pass on the auth/tenancy PRs.
- **Agent executes:** implementation and tests.
- **Human approves:** security model ADR; any default that widens exposure; the review sign-off itself.

## Phase 7 — Provider and plugin system

- **Outcome:** integrations are packages, not patches.
- **Deliverables:** provider contracts for email, calendar, payments-lite (references), enrichment; two real adapters shipped (one email — e.g. SMTP/API-based, one calendar); plugin manifest + discovery (install a module/provider package and it registers); compensation-aware side-effect conventions documented.
- **Dependencies:** Phases 3, 5.
- **Acceptance:** P05/P09/P12 pass using real providers in a sandbox; a third-party can build a provider from docs alone (validated by building one in a clean repo following only the docs).
- **Agent executes:** contracts, adapters, docs.
- **Human approves:** external service accounts/credentials; any adapter that sends real messages.

## Phase 8 — Agent surface: Skills, Docs MCP, Project MCP

- **Outcome:** an agent lands in a project (or considers the framework) and knows exactly what to do.
- **Deliverables:** **Skills**: build-module, build-workflow, build-integration, debug-run, upgrade-framework — maintained, versioned, mirrored for Claude Code and Codex-compatible layouts. **Docs MCP**: a public remote MCP serving framework documentation, manifest schema and recipes (the "docs server" agents can query before/while building). **Project MCP**: the in-project server (exists) extended with manifest tools (validate/generate — dry-run by default per ADR-004) and benchmark smoke tools. llms.txt + agent-readable doc structure on the site.
- **Dependencies:** Phase 5 (skills target created projects).
- **Acceptance:** benchmark run where the agent uses skills+MCP shows measurably fewer interventions than a run with docs alone (tracked in the harness); Docs MCP answers the top 20 how-to questions correctly (scripted eval).
- **Agent executes:** all of it.
- **Human approves:** publishing the remote Docs MCP endpoint (infrastructure, cost).

## Phase 9 — Deploy, logs and trace

- **Outcome:** the agent can take a project live and observe it.
- **Deliverables:** deploy recipes + CLI commands for Vercel and Docker/VPS; environment/secret handling conventions (never in repo); production log access and trace/audit querying via CLI + MCP against deployed instances; scripted post-deploy smoke check (the benchmark's G5/G6 as a product feature).
- **Dependencies:** Phase 6. This phase's self-hosted deploy recipes are also the foundation of the **Accordo Cloud** managed runtime (`AGENT_CRM_CLOUD.md`); Cloud's Control Plane/managed-runtime work slots after Phase 6 alongside this phase.
- **Acceptance:** benchmark deployment gates pass on both targets; docs let an agent deploy without human keystrokes beyond credentials/approval.
- **Agent executes:** recipes, automation, smoke tooling.
- **Human approves:** every real deploy in benchmarks/demos; hosting spend.

## Phase 10 — Three complete starter CRMs

- **Outcome:** proof, templates and SEO in one asset.
- **Deliverables:** three starters built **with** the framework by agents, reviewed by humans: (1) B2B sales + approval flows; (2) agency/services with proposals→projects; (3) partner/channel with tiers and revenue share. Each: repo, live demo, tutorial ("build this from a brief"), benchmark transcript showing it was agent-built.
- **Dependencies:** Phases 4, 5, 9 (6 for live demos).
- **Acceptance:** each starter deploys from README in one command; each has a written + recorded agent-build walkthrough.
- **Agent executes:** the builds themselves (that's the point), tutorials.
- **Human approves:** final review of each starter as reference-quality code.

## Phase 11 — Distribution

- **Outcome:** present in every channel where agents and developers look (see `AGENT_DISCOVERY.md` for mechanics).
- **Deliverables:** npm packages with rich descriptions/keywords; GitHub topics, social preview, README optimized for both humans and model consumption; Claude Code plugin (skills + MCP bundled) in a public marketplace repo; MCP server listed in the MCP Registry and submitted to Anthropic/OpenAI directories where submission is open; Vercel template submissions for the three starters; llms.txt live.
- **Dependencies:** Phases 8, 10.
- **Acceptance:** each channel's listing live and installable/cloneable; installation analytics where available.
- **Agent executes:** listing preparation, metadata, submission drafts.
- **Human approves:** every external submission and account creation (directories, marketplaces, template galleries).

## Phase 12 — Public launch

- **Outcome:** the category claim made in public, with receipts.
- **Deliverables:** benchmark first public edition (with comparison arms) published; launch post ("we let Claude Code and Codex build 22 CRMs — here's what happened"); Show HN / Product Hunt / dev newsletters; README case studies section.
- **Dependencies:** Phases 10, 11; benchmark harness from `CRM_BUILD_BENCHMARK.md`.
- **Acceptance:** launch assets live; benchmark repo public with full transcripts; no unverifiable claims in any launch copy.
- **Agent executes:** benchmark runs, drafts, asset generation.
- **Human approves:** all public claims, the launch itself, timing.

## Phase 13 — Content and community flywheel

- **Outcome:** compounding organic growth per `ORGANIC_GROWTH.md`.
- **Deliverables:** recipe cadence (2/month, quality-gated); community space (GitHub Discussions first; chat when there's daily activity to sustain it); community plugin/provider showcase; monthly benchmark re-runs including URR clean-session testing; quarterly roadmap updates in public.
- **Dependencies:** Phase 12.
- **Acceptance:** metrics below trending; at least 3 community-contributed providers/modules within two quarters of launch.
- **Agent executes:** content pipeline with quality gates, benchmark re-runs, triage drafts.
- **Human approves:** publishing anything public; community moderation decisions.

---

## Agent Skills and provider roadmap (future)

Phase 8 defines the core skills (build-module, build-workflow, build-integration, debug-run, upgrade-framework). The workstream milestones extend the roster — each skill ships with the milestone that delivers its primitives, never before:

| Skill | Milestone | Provider contracts involved |
|---|---|---|
| `integrate-enrichment-provider` | M9 | enrichment (company/person data, marketing automation, behavior, product analytics, billing, ERP, custom) |
| `build-lead-scoring` | M9 | — |
| `build-routing-policy` | M9 | — |
| `build-price-book` | M10 | — |
| `connect-cpq` | M10 | catalog (internal, Stripe Products/Prices, Zuora/external CPQ, ERP, custom) |
| `build-discount-policy` | M10 | — |
| `build-signature-flow` | M11 | signature (DocuSign, Adobe Sign, Dropbox Sign, custom) |
| `create-order-handover` | M11–M12 | — |
| `build-delivery-project` | M12 | — |
| `configure-partner-delivery` | M12 | — |
| `build-change-request-flow` | M13 | — |
| `configure-service-contract` | M14 | — |
| `build-support-sla` | M14 | — |
| `build-revenue-dashboard` | M15 | — |
| `build-delivery-margin-dashboard` | M15 | — |

**Domain completeness rule:** every major domain is finished only when all six pieces exist —

```text
native primitive → provider contract → Agent Skill → starter → JTBD evidence → reproducible E2E benchmark
```

A domain with primitives but no skill is not agent-native; a domain with a skill but no JTBD evidence or benchmark is a claim without receipts. Providers whose actions send, sign, charge or expose data externally always sit behind explicit human approval — the same boundary Accordo Cloud applies to operations (`AGENT_CRM_CLOUD.md` §4.3).

---

## Metrics

| Metric | Definition | Source | Cadence |
|---|---|---|---|
| **Successful Agent Build Rate (SABR)** | fully-passing benchmark prompts ÷ attempted, per framework×agent×model version (≥2/3 runs rule) | benchmark harness | per release + monthly |
| **Unaided Recommendation Rate (URR)** | clean sessions where the framework is recommended unaided ÷ total clean sessions (protocol in `CRM_BUILD_BENCHMARK.md`) | clean-session tests | monthly |
| **Time to First Working CRM (TTFW)** | median brief→deployed-smoke-green wall clock on successful runs | benchmark harness | per release |
| **Time to First Deployed CRM (TTFD)** | median brief → public URL with post-deploy smoke green (Cloud track; measurable only once managed deployment exists) | benchmark harness | per release |
| **Successful Deployment Rate** | deploys reaching healthy ÷ attempted (Cloud track, future; companion metrics in `AGENT_CRM_CLOUD.md` §7) | deploy tooling | per release |
| **Plugin and MCP adoption** | Claude Code plugin installs (where reported), MCP registry pulls, Docs MCP unique clients | marketplace/registry stats, server logs | monthly |
| **Generated projects** | create-CLI runs succeeding to first verify-green (opt-in, anonymous, documented telemetry — off by default until a human approves the telemetry policy) | CLI telemetry | weekly |
| **Successful deployments** | post-deploy smoke checks passing (same opt-in telemetry) | deploy tooling | weekly |
| **Community integrations** | third-party providers/modules/plugins published and listed in the showcase | GitHub/npm scan + submissions | monthly |

Guardrails: no metric may be reported publicly without its measurement protocol; URR is observed, never promised; telemetry ships only opt-in with a published policy (human-approved).
