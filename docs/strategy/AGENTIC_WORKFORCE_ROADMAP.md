# Agentic Workforce Roadmap

Status: product and architecture planning only. This document does not claim implementation or JTBD coverage.

## Purpose

Accordo should let a coding agent compose governed operational agents for a specific business, without turning the core into a generic agent framework or forcing every project onto one model vendor, sales-engagement suite, or token-billed API.

The product outcome is not a magic “autonomous employee” button. It is a reusable way to build **role-agent packs** whose data, actions, policies, approval boundaries, evidence, retries, and limitations are explicit.

A small winery is the reference example:

> Configure an ideal customer profile for importers, distributors, hospitality groups, retailers, and other eligible buyers; discover and enrich candidate organizations and contacts from authorized sources; rank them by fit and intent; prepare personalized outreach; send only within approved policy; classify replies; stop on opt-out; and book a qualified meeting while preserving provenance and evidence.

The same composition model should support marketing, customer success, and service roles.

## This is already represented in the desired JTBD portfolio

The desired catalogue already contains the underlying user jobs. A new catalogue family is not required merely to restate them as one product story.

### Prospecting and SDR cluster

- `ACC-JTBD-SDR-001` — configure territory, ICP, and work queues.
- `ACC-JTBD-SDR-003` — define qualification, sequences, and SLA.
- `ACC-JTBD-SDR-004` — define contact and opt-out policy.
- `ACC-JTBD-SDR-005` — build and enrich target lists.
- `ACC-JTBD-SDR-006` — prioritize prospects using fit and intent.
- `ACC-JTBD-SDR-007` — personalize multichannel outreach.
- `ACC-JTBD-SDR-008` — execute sequences and daily tasks.
- `ACC-JTBD-SDR-010` — classify replies and intent.
- `ACC-JTBD-SDR-011` — book meetings and manage no-shows.
- `ACC-JTBD-SDR-012` — qualify and hand opportunities to an AE.
- `ACC-JTBD-SDR-013` through `016` — improve meeting performance, timing, eligibility, and handoff quality.
- `ACC-JTBD-SDR-018` — govern consent, frequency caps, and AI claims.
- `ACC-JTBD-SDR-019` — evolve sequences through controlled tests.
- `ACC-JTBD-SDR-020` — improve SDR agents from measured outcomes.

### Agent composition and evolution cluster

- `ACC-JTBD-SALES-MGR-020` — experiment with new agentic team workflows.
- `ACC-JTBD-AE-019` — build new personal plays through agents.
- `ACC-JTBD-CRM-PO-020` — evolve the platform through agents and capability packs.
- `ACC-JTBD-AGENT-ENG-005` through `015` — retrieval and memory, planning, managed actions, approvals, policy, specialized-agent orchestration, monitoring, retries, evaluation, and hallucination/authorization controls.

### Marketing and ABM cluster

- `ACC-JTBD-ABM-005` — select and prioritize target accounts.
- `ACC-JTBD-ABM-006` — map buying committees and relationships.
- `ACC-JTBD-ABM-007` — create account plans and value hypotheses.
- `ACC-JTBD-ABM-008` — orchestrate advertising, content, and seller touches.
- `ACC-JTBD-ABM-009` — produce intent alerts and next-best actions.
- `ACC-JTBD-ABM-010` — coordinate meetings and follow-ups.
- `ACC-JTBD-ABM-011` and `012` — monitor progression and measure sourced/influenced pipeline.
- `ACC-JTBD-CONTENT-019` — create specialized content agents.
- `ACC-JTBD-CAMPAIGN-019` and `020` — controlled optimization and reusable campaign blueprints.

### Customer success and service cluster

- `ACC-JTBD-CVM-001` — configure portfolio, segments, and coverage.
- `ACC-JTBD-CVM-004` — configure health scores, playbooks, and agent limits.
- `ACC-JTBD-CVM-005` — prioritize portfolio and tasks.
- `ACC-JTBD-CVM-015` — optimize touchpoint frequency and quality.
- `ACC-JTBD-CVM-018` — govern autonomous communications and actions.
- `ACC-JTBD-CVM-019` — evolve customer playbooks through a learning loop.
- `ACC-JTBD-CVM-020` — create specialized agents for customer segments.

These references are a **composition view over desired jobs**. They do not change the catalogue, roadmap assignments, or coverage overlay.

## Product model: builder agent versus runtime role agent

Accordo should keep two responsibilities separate.

### Builder agent

Claude Code, Codex, or another coding agent works in the repository and customizes:

- package manifests and resources;
- managed actions and workflows;
- policies and approval boundaries;
- skills, prompts, and checked source context;
- integration adapters and MCP bindings;
- evaluation scenarios and evidence contracts;
- Admin surfaces required by the role.

The builder changes source through the existing goal-first loop:

```text
GOAL → SEE → PLAN → BUILD → CHECK → PROVE
```

### Runtime role agent

The deployed operational agent performs the configured business work. It may research, recommend, prepare, or execute only through bounded Accordo capabilities and approved external tools. It does not receive arbitrary database or host authority.

The runtime role agent must expose:

- verified identity and tenant scope;
- the exact playbook and agent version;
- input sources and freshness;
- policy and approval decision;
- tool calls and external-operation outcomes;
- cost and latency observations where available;
- immutable audit/trace evidence;
- retry, stop, compensation, and escalation state.

A coding-agent session is not automatically a supported unattended production runtime. Provider terms, authentication, durability, and deployment authority must be proven for the selected runtime rather than inferred from a desktop or subscription session.

## Native-first, provider-neutral execution

Accordo should not invent another universal agent SDK when existing coding agents and tool protocols can perform the work.

The default strategy is:

1. **CLI/JSON remains canonical.** Repository inspection, planning, checks, and proof stay deterministic and model-neutral.
2. **MCP is a bounded tool bridge, not the product core.** Expose only useful capability/action surfaces; do not turn every method into a tool.
3. **Reuse native coding-agent tool execution where supported.** Claude Code, Codex, and future agents can compose source, invoke CLI commands, and use permitted MCP servers.
4. **Keep model execution pluggable.** The open-source runtime must not require one model provider or one token-billed API.
5. **Do not promise subscription reuse for unattended production.** A provider-native subscription may be useful for interactive building or supervised operation only where its product terms and technical surface allow it. Production role agents need an explicit deployable runtime contract.
6. **External systems remain explicit dependencies.** Contact discovery, email delivery, calendars, telephony, enrichment, and social channels require legitimate providers, credentials, permissions, and jurisdiction-appropriate use. Accordo governs and records their use; it does not fabricate access to them.

This creates a “bring the permitted runtime and tools” model instead of a mandatory Accordo model bill.

## Role-agent pack

A role-agent pack is an optional, repository-owned composition. It is not one new core runtime and it is not one MCP tool.

A pack may contain:

```text
role pack
├── domain packages and generated resources
├── managed actions and workflows
├── policy and approval definitions
├── skills/prompts/source context
├── provider and MCP bindings
├── Admin configuration and exception inbox
├── eval scenarios and adversarial fixtures
└── evidence and limitation declarations
```

Candidate packs:

- `prospecting-agent-pack`
- `marketing-orchestration-agent-pack`
- `customer-success-agent-pack`
- `service-triage-agent-pack`

The names are provisional. Two independently implemented packs must demonstrate a repeated primitive before it moves into core.

## Reference flow: winery prospecting agent pack

### Configuration

The owner describes:

- offered wines and commercial constraints;
- target organization types;
- countries, languages, and excluded territories;
- minimum order, logistics, certification, and channel requirements;
- ideal buyer roles;
- contact policy, lawful basis, suppression rules, and frequency limits;
- brand voice and claims that may or may not be made;
- qualification rules and meeting criteria;
- approval and autonomy level.

The builder agent turns that goal into checked source, configuration, fixtures, and a rollout plan.

### Operational flow

```text
Authorized sources
→ candidate companies and contacts with provenance
→ deduplication and eligibility checks
→ Account / Contact / Lead creation or reconciliation
→ fit and intent scoring with explanation
→ personalized draft
→ consent, suppression, claim, and frequency policy
→ human approval or pre-authorized bounded execution
→ email/tool execution with idempotency
→ reply and intent classification
→ stop, follow-up, or escalation
→ calendar proposal and meeting creation
→ qualification and Opportunity handoff
→ KPI and evidence review
```

### Required stop rules

The pack must stop or escalate on:

- opt-out, suppression, or uncertain lawful basis;
- missing provenance or stale contact data;
- conflicting ownership;
- confidence below the configured threshold;
- repeated delivery failure or provider refusal;
- reply received, meeting booked, or maximum sequence reached;
- attempted claim outside approved source material;
- budget, rate, or jurisdiction limit reached.

### Initial autonomy

- **L2:** discover, score, recommend, and draft; a human sends or schedules.
- **L3:** execute a bounded run after explicit human approval of target set, content/playbook, and limits.
- **L4:** future policy-delegated operation only after production identity, jobs/outbox, secrets, observability, consent controls, kill switches, and evidence have passed executable acceptance.

The first shipped pack should begin at L2/L3. “Fully autonomous outbound” is not the starting claim.

## Shared dependency roadmap

Role-agent packs become useful only when the following reusable layers exist.

| Dependency | Why it matters |
|---|---|
| Spine v2 through M4 | Production PostgreSQL, transaction behavior, idempotency, isolation, and failure proof. |
| Spine v3 — jobs/outbox/scheduler | Delayed sequences, retries, inbox processing, scheduled follow-ups, no-show handling, and durable external delivery. |
| Spine v4 — secrets/backups/observability | Provider credentials, recovery, operational diagnostics, costs, and kill switches. |
| Customer Data Operations v2 | Search, import, deduplication, bulk review, provenance, and scalable identity-conflict handling. |
| Interactions | Email, calendar, call/message events, replies, and a bounded customer/contact timeline. |
| Marketing runtime | Audiences, consent/preferences, frequency caps, content/brand policy, campaign state, and deliverability evidence. |
| Package ecosystem | Install, configure, update, evaluate, and remove optional role-agent packs. |
| Managed Cloud C0–C3 | Project/environment/deployment records, managed runtime, PostgreSQL/secrets/backups, health/logs/trace. |

## Proposed roadmap slices

The slices below are planning groups, not coverage claims.

### AW0 — Role-pack composition contract

Prove two packs can be composed from existing package/action/workflow/policy primitives without creating a second application runtime.

Deliverables:

- a bounded role-pack manifest or composition description only if existing package metadata is insufficient;
- dependency and limitation report;
- install/configure/remove plan;
- role-pack inspection output;
- no model-provider requirement in the core contract.

### AW1 — Supervised prospecting pack

First vertical slice using fixture or explicitly authorized sources and sandbox delivery.

Coverage target cluster:

```text
SDR-001, 003–008, 010–012, 018
```

Acceptance requires one end-to-end scenario from ICP configuration to a human-approved meeting request, with no real mass outreach claim.

### AW2 — Durable outreach and reply loop

Depends on Spine v3 and Interactions.

Adds:

- scheduled steps;
- outbox and external-operation reconciliation;
- reply ingestion and intent classification;
- stop rules, opt-out, no-show, and handoff;
- delivery, reply, and meeting receipts.

### AW3 — Marketing and customer-service packs

Prove the composition is role-neutral by delivering at least one marketing and one customer/service flow through the same bounded primitives.

Examples:

- ABM target selection → coordinated seller/content touch → progression evidence;
- customer risk signal → recommended play → approved outreach/task → measured result;
- service request classification → response draft → human approval → case update and escalation.

### AW4 — Policy-delegated operations

Only after M4, Spine v3/v4, provider identity, consent, budget controls, observability, and rollback/kill-switch evidence are complete.

No general L4 claim. Each pack proves its own policy envelope and failure modes.

## Arvo pilot connection

The first real managed pilot should use a narrow Arvo commercial/customer-operations pack rather than migrating Arvo’s coaching engine.

Candidate scenario:

```text
PT/Gym lead or trial
→ organization/contact reconciliation
→ qualification and personalized follow-up
→ meeting/demo booking
→ subscription/renewal task
→ customer interaction and support follow-up
→ evidence-backed human approvals
```

This tests Accordo’s agent composition, PostgreSQL/Cloud posture, jobs, interactions, Admin, and a selected JTBD acceptance pack against a real product.

## Coverage and truth rules

- This roadmap does not alter any desired JTBD record.
- A role-agent pack may group many desired jobs, but the group is not a coverage score.
- Building a connector, prompt, or agent does not promote neighboring JTBDs.
- Only executable evidence attached to the exact job may move its coverage row.
- Roadmap assignment, pack installation, model output, and provider success are separate facts.
- Competitive differentiation remains a hypothesis until benchmarked against current products and documented evidence.

## Decision summary

Accordo’s differentiator should not be “we ship a generic autonomous agent.” It should be:

> A coding agent can assemble a business-specific operational agent from deterministic customer/revenue primitives, bounded tools, explicit policy, and executable evidence — while the project retains its source, provider choice, and operational limits.
