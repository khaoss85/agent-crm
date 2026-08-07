# Master plan

The canonical entry point to the strategy. Read this first; follow the links for depth. For implementation work, `ARCHITECTURE.md` and `DECISIONS.md` remain the technical authorities.

## 1. Vision (one sentence)

> **Describe your sales process to your coding agent; own the CRM it builds.**

The open-source, agent-native CRM framework: Claude Code and Codex use it to generate bespoke CRM applications — deterministic workflows, human approvals, audit and trace built in — as code the customer owns.

## 2. Current status

**Volatile status lives in `docs/PROJECT_STATUS.md`** — merged milestone, main SHA, test count, open PRs, next task and production blockers. It is updated in every milestone merge PR; this file deliberately no longer carries numbers that go stale.

Stable facts: milestones **M0–M11 are merged and proven in-repo** — the vertical from lead capture through enrichment, scoring, routing, qualification, conversion, pipeline, composite quoting, discount approval, verified signature evidence and an immutable Order (ADR-001…ADR-017). Working title `accordo`; **no public name chosen**. The repository license is currently **MIT**; final pre-launch confirmation is a pending human decision. The benchmark is designed and **not yet executed**.

A **Platform Alignment Gate** (`PLATFORM_ALIGNMENT_GATE.md`, ADR-018) was taken after M11 and before further domain code: it draws the core-versus-domain boundary, defines the capability model, corrects the post-Order roadmap and adds the missing platform tracks. It changed no runtime code.

## 3. Medusa-to-CRM mapping (short form)

| Medusa (commerce) | This framework (CRM) |
|---|---|
| Commerce modules | CRM domain modules |
| Workflows SDK (durable, compensating) | Deterministic workflows + approval policy |
| Providers/plugins (npm) | Email/calendar/enrichment providers |
| create-medusa-app | create-project CLI (Phase 5) |
| Recipes docs | CI-tested recipes |
| Agent skills repo + docs MCP + llms.txt | Same trio, free from day one |
| Cloud (monetization, core stays MIT) | **Accordo Cloud** — optional managed operating layer; explicit product track in `AGENT_CRM_CLOUD.md` (design only, unbuilt) |

Full analysis and what *not* to copy: `MEDUSA_PLAYBOOK.md`.

## 4. North Star experience

Brief + business process + design reference → the agent scaffolds, generates modules/workflows/Admin/tests, verifies and deploys a working CRM with no manual coding; humans describe, review and approve. 16 acceptance criteria (functional, quality, safety) in `NORTH_STAR_EXPERIENCE.md`.

## 5. Product principles

1. CRM state is deterministic; AI composes and recommends, never silently decides (ARCHITECTURE.md core rule).
2. All mutations pass through module services/workflows with validation, actor identity, audit, trace.
3. Human approval is deterministic policy; agents cannot impersonate the human decision.
4. Code generation is dry-run by default; writes are explicit; output is byte-stable for the same input.
5. Generated code is readable, owned by the customer, and free of hidden conventions.
6. The framework is what agents use to *author* a CRM — distinct from platforms (Twenty and similar) that agents can *extend* but that keep running the application themselves.

## 6. Roadmap phases (summary)

0 Foundation → 1 Brand/license → 2 CRM core (Activity/Task/pipelines) → 3 Manifest-driven generation → 4 Admin+SDK generation → 5 create-CLI → 6 Production spine (Postgres/auth/tenancy) → 7 Providers/plugins → 8 Agent surface (Skills, Docs MCP, Project MCP) → 9 Deploy/observe → 10 Three starters → 11 Distribution → 12 Public launch → 13 Flywheel. Per-phase outcomes, dependencies, acceptance criteria and human-approval points: `EXECUTION_ROADMAP.md`.

**Accordo Cloud** is the named product track for the optional managed operating layer — Control Plane, managed runtime, agent operations CLI/MCP, plugin operations, public benchmark deployment — gated by the Production Spine (Phase 6) and specified in `AGENT_CRM_CLOUD.md` (design only; nothing implemented). The open-source framework and the self-hosting path remain first-class forever; Cloud is optional and must never create lock-in.

### Product workstreams (design only, unbuilt)

Five named workstreams extend the CRM capability track beyond the Opportunity pipeline, covering the complete commercial lifecycle — and, with Marketing, what happens before a lead exists at all:

```text
Marketing & Growth         (funnel insight, campaign proposal, journeys, experiments,
                            paid media, attribution — MK0–MK7, design only)
→ Lead Intelligence        (enrichment, explainable scoring, versioned routing — M9, done)
→ Sales                    (pipeline — M8, done)
→ Commercial Operations    (catalog, composite quotes, discounts, approvals — M10, done)
→ Signature and Order      (verified evidence, immutable Order — M11, done)
→ Contract / Subscription  (activation, terms, entitlements, renewal — M12, next)
→ Delivery                 (handover, commesse, partners, economics, acceptance — M13/M14)
→ Service                  (contracts, entitlements, SLA, support — M15)
→ Customer Success
→ Renewal and Upsell       (feeds back into Lead Intelligence and Sales)
```

- **Lead Intelligence & Routing** and **Commercial Operations / CPQ** — `REVENUE_OPERATIONS.md` (M9–M11, **merged**).
- **Contract, Subscription and Renewal** — `CONTRACT_SUBSCRIPTION_RENEWAL.md` (M12; the layer between an immutable Order and everything recurring — added at the alignment gate because Delivery cannot be built on an Order alone).
- **Delivery & Service Operations** — `DELIVERY_SERVICE.md` (M13–M15; the CRM equivalent of ecommerce fulfillment).
- **Analytics Studio** — `ANALYTICS_STUDIO.md` (M16; safe semantic metrics, no agent-generated raw SQL).
- **Marketing & Growth Operations** — `MARKETING_GROWTH_OPERATIONS.md`, `CAMPAIGNS_JOURNEYS.md`, `EXPERIMENTATION_ATTRIBUTION.md` (MK0–MK7; a **parallel** package-native track, not a successor to Delivery. It proposes before it sends: MK1 needs no provider at all, MK4 is hard-blocked on durable automation and MK7 on Analytics Studio).

Every workstream follows the same delivery model — native deterministic primitives + provider contracts + code-first versioned policies + Agent Skills + starter + JTBD evidence + reproducible E2E benchmark. **M9–M11 are merged; M12 onward is not implemented.**

### The experience that reaches all of them

The pillars are *what* the framework can do. The **objective-driven agent experience** is *how a user gets there*: they supply a business objective and its constraints, and the agent discovers installed packages and capabilities, analyses the gap, chooses or creates packages, proposes a reviewable plan, builds checked-in source, verifies it, and asks only for sensitive approvals. It is cross-cutting — the AX0–AX5 track in `EXECUTION_ROADMAP.md` — not a thirteenth pillar. AX0 is a strategy and a Skill; **AX1–AX5 are not implemented**. See `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`.

### The twelve pillars

The complete vision, deliberately **modular**: these are optional domain packages and parallel tracks (ADR-018, and the public package contract in addenda 3–4), not one monolith that must ship whole before anything is useful. A project can take the framework and Lead Intelligence and nothing else; a Cloud release can serve an M11-era CRM.

| # | Pillar | Status | Where |
|---|---|---|---|
| 1 | Agent-native development framework | merged (M1–M6) | `ARCHITECTURE.md` |
| 2 | Deterministic CRM runtime | merged (M0–M8) | `ARCHITECTURE.md`, `DECISIONS.md` |
| 3 | Revenue lifecycle | merged (M9–M11) | `REVENUE_OPERATIONS.md` |
| 4 | Contract / subscription / renewal | design only | `CONTRACT_SUBSCRIPTION_RENEWAL.md` |
| 5 | Delivery & service | design only | `DELIVERY_SERVICE.md` |
| 6 | Analytics Studio | design only | `ANALYTICS_STUDIO.md` |
| 7 | Data governance | design only | `DATA_GOVERNANCE.md` |
| 8 | Design-to-CRM | design only (Admin exists; the design pipeline does not) | `DESIGN_TO_CRM.md` |
| 9 | Integration & jobs platform | design only | `INTEGRATION_RUNTIME.md`, `JOBS_AND_OUTBOX.md` |
| 10 | Accordo Cloud | design only | `AGENT_CRM_CLOUD.md`, `CLOUD_JTBD.md` |
| 11 | JTBD and benchmark evidence | matrix live; benchmark not executed | `../benchmarks/CRM_JTBD_MATRIX.md`, `CRM_BUILD_BENCHMARK.md` |
| 12 | Marketing & Growth Operations | design only | `MARKETING_GROWTH_OPERATIONS.md` | Sequencing, parallelization and the Production Spine gate: `EXECUTION_ROADMAP.md` (workstream milestones M9–M15). The workstreams do not gate Accordo Cloud: Cloud work begins when the Production Spine is done, not when all domains are done.

## 7. Discovery model (three layers, never conflated)

- **Global recommendation** — a model suggesting us unprompted. Earned via prevalence and task-time retrieval; **cannot be guaranteed by any mechanism**; measured monthly as Unaided Recommendation Rate.
- **Marketplace/plugin discovery** — Claude Code plugins/skills, Codex plugins, MCP Registry, Anthropic connectors directory, OpenAI plugin directory, Vercel templates, npm, GitHub. We control submissions; platforms control acceptance.
- **Execution after selection** — skills, MCP, CLI, docs inside a project. Fully ours; where the product wins.

Channel-by-channel plan: `AGENT_DISCOVERY.md`.

## 8. Organic-growth flywheel

Ship capability → prove it (benchmark/starter) → document as CI-tested recipe → publish where developers and agents look → measure → feed gaps to roadmap. Hard quality gates (runs-or-dies fixtures, transcript-grounded narratives, human editor of record, published failure counts) prevent low-value AI content. Details: `ORGANIC_GROWTH.md`.

## 9. Core metrics

| Metric | One-line definition |
|---|---|
| Successful Agent Build Rate (SABR) | benchmark prompts fully passing ÷ attempted, per framework×agent×model version |
| Unaided Recommendation Rate (URR) | clean sessions recommending us unaided ÷ total (protocol public; observed, never promised) |
| Time to First Working CRM (TTFW) | median brief → deployed-smoke-green wall clock |
| Plugin/MCP adoption | installs, registry pulls, Docs MCP clients |
| Generated projects / successful deployments | opt-in telemetry (policy pending human approval) |
| Community integrations | third-party providers/modules published |

Definitions and measurement protocols: `EXECUTION_ROADMAP.md` (metrics) and `CRM_BUILD_BENCHMARK.md` (protocols).

## 10. Pending human decisions

1. **Public name** — candidates only, none chosen (`BRAND_REQUIREMENTS.md`); registrar + trademark verification required.
2. **Final license confirmation** before public launch (MIT is the current repository license; keep-or-change is an explicit ADR-gated decision).
3. **Telemetry policy** (opt-in metrics) before any collection ships.
4. **All external submissions** (marketplaces, directories, template galleries) and account creations.
5. **All public launch claims and timing**; every published number must trace to the benchmark protocol.

## 11. Reading order

1. `MASTER_PLAN.md` — this file.
1b. `../PROJECT_STATUS.md` — what is true in the repository **today**.
1c. `PLATFORM_ALIGNMENT_GATE.md` — the post-M11 architecture and roadmap checkpoint, and the index of the tracks it created (`PLATFORM_CAPABILITIES.md`, `CONTRACT_SUBSCRIPTION_RENEWAL.md`, `INTEGRATION_RUNTIME.md`, `JOBS_AND_OUTBOX.md`, `DATA_GOVERNANCE.md`, `DESIGN_TO_CRM.md`, `CLOUD_JTBD.md`, `../QUALITY_GATES.md`).
2. `CATEGORY.md` — category, positioning, ICP, JTBD, promise.
   (Product track deep-dives, all design only: `AGENT_CRM_CLOUD.md` — the managed operating layer; `REVENUE_OPERATIONS.md` — lead intelligence, routing and CPQ; `DELIVERY_SERVICE.md` — post-sale delivery and service; `ANALYTICS_STUDIO.md` — safe semantic analytics.)
3. `NORTH_STAR_EXPERIENCE.md` — the target experience and its acceptance criteria.
4. `COMPETITOR_MAP.md` — Twenty, Frappe, Relaticle, Comp AI, legacy, templates, DIY; the gap and its caveats.
5. `MEDUSA_PLAYBOOK.md` — the adoption playbook and its limits.
6. `EXECUTION_ROADMAP.md` — phases, acceptance criteria, metrics.
7. `CRM_BUILD_BENCHMARK.md` — the proof instrument.
8. `AGENT_DISCOVERY.md` — distribution channels and sequencing.
9. `ORGANIC_GROWTH.md` — content/community engine and quality gates.
10. `BRAND_REQUIREMENTS.md` — naming criteria and candidate shortlist.

Agents: read this file before product, positioning, roadmap or public-distribution decisions. For code, follow `AGENTS.md`, `ARCHITECTURE.md` and `DECISIONS.md`.
