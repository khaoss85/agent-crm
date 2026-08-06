# Marketing & Growth Operations

**Status: product strategy and roadmap only. Nothing in this document is implemented.** No campaign, audience, journey, experiment, content asset, landing page, tracking plan, provider adapter, attribution model or funnel primitive exists in the repository today. No package under `packages/marketing`, `packages/journeys`, `packages/experimentation`, `packages/content` or `packages/attribution` exists. This document defines the workstream so the roadmap can sequence it (`EXECUTION_ROADMAP.md`, track MK0–MK7) and so coding agents build it by composing declared primitives rather than inventing them.

**Framing:** the sales-side workstreams take a lead that already exists and move it to revenue. This one asks where the lead came from, whether more can be found, and whether the money spent finding it was worth spending. A CRM framework that only records demand is a ledger; one that can *create* demand — under human approval, with the evidence to prove what worked — is the other half of the category claim in `CATEGORY.md`.

It runs **in parallel** with Delivery and Service (`DELIVERY_SERVICE.md`), not after them. They share nothing but the platform.

Delivery model per domain, as everywhere in this repository: native deterministic primitives + provider contracts + code-first policies/actions + Agent Skills + starter + JTBD evidence + reproducible E2E benchmark.

---

## 1. The promise

```text
observe funnel performance
→ diagnose a drop
→ propose a complete campaign
→ generate audience, content, landing, tracking and journey definitions
→ present everything in CRM Admin
→ request human approval
→ execute later through installed providers
→ measure results
→ propose the next version
```

Three parties, and the split between them is the whole design:

| Party | Owns |
|---|---|
| **The framework** | reliable package primitives and provider contracts: what a campaign *is*, what a provider must promise, what evidence a run must leave |
| **The coding agent** (Claude Code, Codex) | the checked-in, customer-owned implementation and assets — package definitions, policies, content, landing pages, tracking plans |
| **The user** | review, modification and approval, in the CRM, before anything leaves the building |

The framework never ships a campaign. The agent never sends one. The user never has to read a config file to know what was proposed.

## 2. Why this is package-native

Marketing is the strongest test the package contract will get. It is large, it is optional, most CRM installations will want a different shape of it, and a great many customers already own a marketing stack they will not replace. A pillar that can only be adopted whole is a pillar most people decline.

So it is built as packages under the Custom Package Contract v1 (`docs/PACKAGE_AUTHORING.md`, ADR-018 addenda 3 and 4), with the same rules as `packages/contracts` and `packages/delivery`: declared resources, declared capability dependencies, versioned fingerprinted policies, function-free schema metadata, static composition, and removal that leaves data alone.

### Provisional official packages

These are **future package identities**, not approved npm names and not a published namespace. Distribution is out of scope (`docs/PACKAGE_AUTHORING.md`, "What is deliberately not here yet").

| Package | Owns |
|---|---|
| `packages/marketing` | Campaign, CampaignProposal, CampaignVersion, CampaignRun, AudienceDefinition, AudienceSnapshot, SuppressionSet, TrackingPlan, Touchpoint, CampaignResult |
| `packages/journeys` | JourneyDefinition, JourneyVersion, Enrollment, JourneyStep, StepExecution, Wait, Condition, ExitCriterion, Goal |
| `packages/experimentation` | Experiment, Variant, ControlGroup, Holdout, DeterministicAssignment, ExperimentMetric, WinnerDecision |
| `packages/content` | ContentAsset, ContentVersion, EmailTemplate, MessageTemplate, CreativeAsset, LandingPage, Form, CTA, ThankYouPage, PublishingPlan |
| `packages/attribution` | FunnelDefinition, FunnelRun, FunnelDropInsight, AttributionModel, AttributionRun, RevenueCredit, cohort and conversion result definitions |

### What a customer may do instead

- use the official packages as they are;
- **replace** one official package with their own — keep `marketing`, write their own `journeys`;
- collapse the lot into a **single custom Growth package** for their business;
- write **custom providers** for channels nobody upstream has adapted;
- extend any package with their own resources, actions and policies.

All of it through the same public contract, with no kernel patch. That is the point of Custom Package Authoring v1, and Marketing is the load-bearing proof of it.

Cross-package reach is by **declared capability only** — a marketing package that needs consent state declares a governance capability; one that needs funnel metrics declares an analytics capability; one that needs to enrol over time declares a durable-automation capability. None of them reaches another package's tables.

## 3. What must never be bypassed

No package — official or custom — may bypass:

- **human approval** for anything that sends, publishes, launches or spends;
- **consent, preference and suppression checks** before enrolment or delivery;
- **audit, event and trace** evidence for every run;
- **provider boundaries** — a package talks to a provider through the declared adapter contract, never a raw credential of someone else's.

Trusted checked-in source is not a sandbox (ADR-018 addendum 4). These are contract obligations enforced by review and by the runtime's own primitives, not by isolation.

## 4. The agentic optimization loop

```text
OBSERVE    Analytics detects a funnel drop, a segment underperforming, an opportunity
DIAGNOSE   The agent explains which segment, at which step, and the likely causes
PROPOSE    The agent creates a CampaignProposal — complete, in the CRM
REVIEW     The user reads and edits the whole proposal, not fragments of config
APPROVE    A human approves audience, content, channel, timing and budget
BUILD      The agent creates checked-in assets and package definitions
EXECUTE    Installed providers send, publish or launch
MEASURE    Events, results and attribution flow back
LEARN      The agent proposes the next version, a winner, or a budget change
```

Every proposal, run and version must preserve, or it is not evidence:

- model, policy and provider **versions** with their fingerprints;
- the **audience snapshot** as frozen at approval;
- **content versions** actually delivered;
- the **tracking plan** in force;
- the **approval** — who, when, what they saw;
- **execution evidence** from the provider;
- **result evidence**;
- **trace and audit**;
- **rollback and version semantics** — a change is a new version, never an edit.

## 5. Campaign modes, and what each one costs

The four modes look similar in a UI and are radically different in what the runtime must guarantee. Conflating them is the most likely way this workstream ships something dishonest.

| Mode | Audience | Hard runtime dependency |
|---|---|---|
| **One-shot** | frozen at approval/execution | none beyond the current runtime |
| **Rolling** | re-evaluated over time | Durable Automation: exact enrolment identity, frequency cap, consent recheck, idempotency |
| **Triggered** | event-driven entry | durable event inbox/outbox, a stable trigger contract, an explicit replay policy |
| **Journey** | stateful, multi-step, multi-channel | scheduler, durable waits, retry/backoff, exit criteria, stateful enrolment, version pinning |

Stated plainly, because it decides the roadmap order:

- **one-shot can precede the durable scheduler** — that is why MK2 is reachable early;
- **rolling, triggered and journey cannot be production-complete on the current in-process event buffer** (ADR-012, post-commit dispatch, best-effort trace). They need `JOBS_AND_OUTBOX.md` first;
- **none of this exists in the current package or runtime code.**

## 6. Human approval boundaries

The agent may **analyze, propose, generate, prepare, test, preview and recommend** — provider, timing, content, budget — without asking.

A human must approve before:

- publishing a landing page to production;
- sending any external communication;
- activating a journey;
- changing a live audience;
- using sensitive data;
- launching Ads;
- creating or increasing spend;
- installing or configuring a provider;
- changing secrets;
- automatically applying an experiment winner;
- a production rollback with material impact.

Production **roles** for these approvals require Auth, Tenancy and RBAC — the Production Spine. Until it exists, actor headers are not authentication and every approval boundary here is a local-development boundary (`PLATFORM_CAPABILITIES.md`).

## 7. Roadmap track

Parallel to the Delivery/Service track. See `EXECUTION_ROADMAP.md`.

```text
MK0  Marketing strategy, package contracts and JTBDs      ← this documentation PR
MK1  Funnel Insight + Campaign Proposal                   no send, no spend
MK2  Audience + Consent + one-shot email                  fixture provider first
MK3  Content + Landing Page + Form + CTA + Tracking        checked-in source, publish approval
MK4  Durable Journey Orchestration                        requires JOBS_AND_OUTBOX
MK5  Experiments, Control Groups and Holdouts             deterministic assignment
MK6  Paid Media Planning and Providers                    human spend approval
MK7  Attribution and Closed-loop Optimization             requires ANALYTICS_STUDIO
```

| Milestone | Blocked by |
|---|---|
| MK1 | nothing — it proposes, it does not send |
| MK2 | Data Governance foundations (`DATA_GOVERNANCE.md`) |
| MK3 | MK1; design ownership per `DESIGN_TO_CRM.md` |
| MK4 | Durable Automation (`JOBS_AND_OUTBOX.md`) — hard |
| MK5 | MK2; MK4 for journey-scoped experiments |
| MK6 | MK2, MK3; provider contracts in `INTEGRATION_RUNTIME.md` |
| MK7 | Analytics Studio (`ANALYTICS_STUDIO.md`) and an identity/touchpoint model — hard |

**No Marketing package is implemented by this PR**, and no milestone above is started.

## 8. Related

`CAMPAIGNS_JOURNEYS.md` (the objects and the modes) · `EXPERIMENTATION_ATTRIBUTION.md` (experiments, funnels, attribution, paid media) · `DATA_GOVERNANCE.md` (consent) · `JOBS_AND_OUTBOX.md` (durable automation) · `ANALYTICS_STUDIO.md` (semantic metrics) · `DESIGN_TO_CRM.md` (creative and design ownership) · `INTEGRATION_RUNTIME.md` (provider contracts) · `docs/PACKAGE_AUTHORING.md` (how any of this attaches) · `docs/benchmarks/CRM_JTBD_MATRIX.md` (what is actually supported).

## Where this meets the objective-driven experience

The agentic loop in §4 is the Marketing-specific instance of the general Goal-to-Solution lifecycle in `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`. A user who says "optimize our funnel" is asking for both: the analysis and modelling on the CRM side, and the Campaign Proposal on this side.

That makes MK1 (Funnel Insight + Campaign Proposal) the first milestone where the objective-driven experience produces something a marketer would recognise — and it is why AX5 (closed-loop optimization) depends on this track rather than the other way round. **Campaign economics are not delivery economics**: the two never share a number, a record or a vocabulary.
