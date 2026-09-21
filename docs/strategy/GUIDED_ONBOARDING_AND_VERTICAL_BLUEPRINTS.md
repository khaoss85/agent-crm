# Guided Onboarding, Deployment Handoff, and Vertical Blueprints

Status: product and architecture planning only. This document does not claim implementation, Cloud availability, provider integrations, or JTBD coverage. Current implementation truth remains in `docs/PROJECT_STATUS.md`, Repository Truth, and the independent coverage overlay.

## Purpose

Accordo already has a goal-first engineering loop and the primitives needed to inspect, plan, build, check, and prove a customer/revenue application. The missing product layer is a guided first-run experience that turns a business description into:

- a reviewable functional blueprint;
- a deployment choice;
- a selected set of desired JTBDs;
- proposed modules, fields, workflows, role-agent packs, providers, views, and approval boundaries;
- a verified project;
- and, when Managed Cloud exists, a bounded deployment handoff containing the URLs and operational references the user and coding agent need.

The intended experience is:

> Tell the coding agent what the business is trying to achieve. Accordo audits what already exists, proposes the smallest coherent CRM and agent configuration, asks only for consequential choices, builds and verifies the project, and returns either a self-host runbook or a managed deployment receipt.

This extends the existing objective-driven and role-agent roadmaps. It does not add a second planner, a second application runtime, or a new family of duplicate JTBD records.

## What exists and what is missing

### Existing foundations

The guided experience should orchestrate existing rails rather than expose them as a checklist:

- Project Bootstrap creates a verifying source-owned project.
- `solve-business-goal` performs goal-first discovery, planning, building, checking, and proof.
- App Inspect reports the checked-in package, capability, action, policy, provider, and resource graph.
- Solution Plan and Solution Check provide a reviewable, source-bound plan.
- Package Scaffold and Package Test provide conforming extension points.
- Project Doctor and Project Verify expose project health and evidence.
- Scenario evidence keeps desired JTBDs separate from what is actually supported.
- The Agentic Workforce roadmap composes existing desired jobs into role-agent packs.
- The Accordo Cloud roadmap already separates the Cloud Control Plane from the deployed CRM Admin.

### Missing product experience

No current surface provides one end-to-end first configuration that:

- asks whether the user wants local, self-hosted, or managed deployment;
- decides whether Accordo should recommend the initial JTBD set, accept a user-selected set, or combine both;
- audits a website, repository, forms, spreadsheets, current CRM, and provider landscape as permitted inputs;
- proposes the initial modules, fields, workflows, views, role-agent packs, and integrations;
- asks whether users prefer the Web Admin, conversational operation through a coding agent/MCP, or a hybrid;
- returns a managed URL, invitation status, logs/traces references, and rollback/ejection instructions;
- and proves the selected acceptance scenarios after deployment.

That gap is the scope of this roadmap.

## Product principle: invisible orchestration

The user should not have to choose between `app inspect`, Solution Plan, Package Scaffold, Project Doctor, or Project Verify. Those are internal rails selected by the workflow.

The user should be asked only about product decisions that cannot be inferred safely:

- the business outcome and primary metric;
- deployment mode;
- data sources and data that must be excluded;
- recommendation versus explicit configuration preference;
- interaction and view preference;
- provider authorization;
- approval and autonomy boundaries;
- production deployment and irreversible operations.

A thin future onboarding Skill may orchestrate the existing rails, but it must first prove that extending `solve-business-goal` is insufficient. A new CLI command or MCP tool is not assumed. The default entry remains a natural-language goal such as:

> Set up Accordo for my winery. Capture inbound leads, build customer profiles, help my team prospect restaurants, and propose marketing campaigns. I want a simple Web view and conversational access for the owner.

## Guided lifecycle

```text
BRIEF
→ AUDIT
→ RECOMMEND
→ CHOOSE
→ BLUEPRINT
→ APPROVE
→ BUILD
→ VERIFY
→ DEPLOY
→ ADOPT
→ OBSERVE
```

### BRIEF

Capture the business, users, desired outcome, primary metric, markets, constraints, sensitive actions, and current systems in the user's own words.

### AUDIT

With explicit permission, inspect only the sources needed for the proposal:

- existing Accordo repository and App Inspect output;
- current application repository and schemas;
- public website and forms;
- current CRM/export/spreadsheets;
- commerce, subscription, support, email, calendar, advertising, and analytics providers;
- current deployment and authentication posture;
- desired JTBD catalogue, current coverage, and roadmap dependencies.

Unavailable evidence stays unavailable. The agent must not infer a provider, field, consent status, or data source merely because it is common in the industry.

### RECOMMEND

Propose a small coherent first release rather than every possible CRM feature. The proposal distinguishes:

- existing capabilities to configure;
- packages and providers to reuse;
- custom modules or packages to build;
- desired JTBDs selected for the first release;
- unsupported dependencies and future phases;
- fields and views inferred from the business description;
- approval and legal decisions that remain human-owned.

### CHOOSE

The user can choose one of three configuration modes:

| Mode | Meaning |
|---|---|
| Agent recommended | Accordo proposes the first JTBD and module set from the audit; the user approves the blueprint. |
| User specified | The user supplies exact jobs, modules, fields, and integrations; Accordo checks coherence and gaps. |
| Hybrid | Accordo preserves explicit user choices and recommends missing dependencies, evidence, and safer boundaries. |

The same three-mode pattern applies to views and interaction:

- simple owner view;
- detailed operator view;
- Web Admin;
- conversational coding-agent or authenticated future MCP operation;
- hybrid Web plus conversation.

### BLUEPRINT

Produce a deterministic data-only Project Blueprint and a human-readable companion. The exact contract and name remain future implementation decisions, but the candidate content is:

```text
business goal and primary metric
deployment choice
interaction and view preferences
selected desired JTBD IDs and current evidence status
modules, records, fields, relationships and lifecycle
role-agent packs
workflows, actions, policies and approval gates
source systems, provider bindings and secret references
data provenance, consent, retention and exclusion boundaries
Admin views and exception inboxes
acceptance scenarios and evidence plan
known limitations and deferred dependencies
rollback, export and ejection boundary
```

A blueprint does not authorize provider access, sending, spending, production deployment, destructive migration, or sensitive-data use. Those remain explicit approvals.

### APPROVE, BUILD, and VERIFY

The user approves the blueprint and consequential boundaries. The coding agent then uses the existing goal-first rails to write source, run conformance and project checks, execute scenarios, and produce evidence. A change in source or assumptions invalidates stale approval rather than silently reusing it.

### DEPLOY and ADOPT

For local or self-hosted mode, return a verified runbook and the exact operator steps. For future Managed Cloud, create the project and environment only after approval, then return a bounded deployment receipt. Adoption ends with user invitations, view selection, a guided first workflow, and explicit rollback/ejection instructions.

## Cloud architecture: what Accordo owns and what a provider owns

No infrastructure vendor is selected by this document. Provider selection is an implementation decision with its own evidence and ADR.

The intended split is:

```text
Public agent-crm repository
  application runtime, packages, policies, evidence, self-host contracts

Private accordo-platform repository
  Control Plane, accounts, organizations, projects, environments, deployments,
  provider bindings, invitations, operational access, managed lifecycle

Selected infrastructure provider
  compute, networking, PostgreSQL, object storage, domains/TLS, regional runtime,
  and provider-native log/metric primitives consumed through the private layer
```

"Our infrastructure" therefore means an Accordo-owned control plane and operating contract over one selected reference provider, not necessarily a self-operated Kubernetes estate. The first implementation should integrate one provider well. Multi-provider abstraction is justified only after a second real provider or a materially equivalent self-host consumer proves the repeated primitive.

### Cloud provider decision gate

Before Cloud C0 implementation selects a provider, compare candidates against one executable acceptance matrix:

- API-driven service and worker deployment;
- immutable deployment and rollback identity;
- dedicated PostgreSQL data plane per tenant;
- shared control-plane support;
- secrets references and rotation;
- build and runtime logs;
- metrics and traces export;
- custom domains and managed TLS;
- backup artifact access and restore into a scratch environment;
- region and data-residency options;
- bounded build/start/stop/delete operations;
- cost visibility and spend controls;
- GitHub integration and source-owned ejection.

The provider name must not leak into the public application contract. Source ownership and a verified self-host path are the primary portability guarantee.

## Managed Cloud C0-C3 for first pilots

### C0 — Account and project authority

```text
accounts and organizations
operator memberships and roles
projects and connected repositories
environments
deployment records
provider binding metadata
```

Control Plane identity is distinct from CRM application-user identity.

### C1 — Deployment lifecycle and endpoints

```text
build from an exact commit
preview and production deployment
migrations and startup gates
health and smoke result
custom/generated endpoint
rollback and deletion state
```

### C2 — Managed runtime dependencies

```text
dedicated PostgreSQL data plane
shared control plane
secret references
CRM application authentication and invitations
worker runtime
backup policy and verified restore path
```

### C3 — Operability and agent access

```text
build/runtime logs
workflow traces and audit references
health/readiness
job and outbox state
bounded operational commands
scoped coding-agent access
post-deploy smoke and evidence
```

Billing, autoscaling, SLA, marketplace, and advanced support may follow after the first pilots.

## Deployment receipt returned to the coding agent

A successful managed deployment should return one versioned, bounded receipt containing references rather than secrets:

```text
organizationId
projectId
environmentId
deploymentId
commitSha
deployment status
application URL
CRM Admin URL
API base URL
health URL
authenticated MCP endpoint, only if implemented
operator login/invitation status
CRM-user invitation status
logs reference or command
traces reference or command
audit reference or command
storage posture without locator
worker/job posture
backup posture and last verified receipt
smoke and acceptance results
rollback target/ejection runbook
known limitations and pending approvals
```

The agent must never receive plaintext production secrets merely to operate the deployment.

Recommended identity surfaces are conceptually distinct:

- human Control Plane login for infrastructure operators;
- scoped, revocable, short-lived project operation grants for coding agents;
- CRM invitations and application sessions for business users;
- provider secret values held write-only behind references.

Long-lived unrestricted admin keys are not the onboarding answer.

## Vertical blueprint library

Vertical blueprints are reference compositions, not hard-coded vertical editions and not coverage claims. They show a coding agent how to translate a business model into selected JTBDs, records, role packs, providers, views, and acceptance scenarios.

The first two deliberately different pilots are:

1. **Arvo PT/Gym** — integrate an existing complex SaaS while preserving a strict boundary around health and coaching data.
2. **Winery Growth and Customer Operations** — create a greenfield business CRM from a website, forms, commerce/events, outbound sales, and marketing goals.

Arvo tests integration and data-boundary discipline. The winery tests whether the first-run recommendation and onboarding are simple enough for a non-technical owner to approve.

## Winery Growth and Customer Operations blueprint

### Business outcome

Create one operational view of customers, prospects, purchases, events, sales work, and marketing activity, then compose governed agents that help grow direct and business sales without inventing consent, provider access, or autonomous authority.

### Input audit

With permission, inspect:

- website, forms, lead notifications, and analytics;
- advertising accounts and existing campaign taxonomy;
- commerce/order source such as Shopify or another system;
- customer and purchase exports;
- physical tasting/event registrations;
- restaurant, distributor, importer, hospitality, and retailer prospect lists;
- current email, calendar, telephony, enrichment, and support tools;
- consent, suppression, territory, language, and brand rules.

A provider named in the blueprint is a dependency, not a claim that Accordo already ships the integration.

### Proposed core records

The builder may recommend, subject to the audit:

```text
Company / Account
Contact / Consumer Profile
Lead
Opportunity
Purchase / Order Reference
Product / Wine Reference
Event / Attendance
Campaign / Source
Interaction
Task / Follow-up
Consent / Preference / Suppression Evidence
Support Case
```

Suggested business fields include:

```text
customer or prospect type
source and campaign provenance
territory and language
owner and next action
qualification and fit reason
last purchase date
purchase/order reference and quantity where authoritative
preferred wines or product interest where evidenced
event attendance and last participation date
restaurant/distributor/importer attributes
consent, lawful-basis review and opt-out state
last interaction and next follow-up
```

The agent proposes these fields; it does not create unsupported facts or copy sensitive data without approval.

### Candidate role-agent packs

```text
Inbound Lead Agent
  reconcile form/ad leads, preserve source, qualify and create the next task

CRM Data Steward Agent
  import, deduplicate, identify provenance, surface conflicts and request review

Restaurant and Distributor Prospecting Agent
  discover authorized candidates, enrich, score, draft outreach, enforce policy,
  classify replies and prepare meetings

Marketing Orchestration Agent
  propose audiences, content, campaigns and budget changes across approved providers;
  publishing, audience activation and spend remain human-approved

Customer Nurture and Reorder Agent
  identify due follow-up, purchase or event signals, prepare an approved next action

Service Triage Agent
  classify requests, draft responses, update the case and escalate within policy
```

### Reference journeys

#### W1 — Inbound acquisition to first sales action

```text
website/ad form
→ source and consent evidence
→ duplicate/reconciliation check
→ Lead + Contact/Company profile
→ qualification
→ owner/task
→ Opportunity when criteria are met
→ audit and trace
```

#### W2 — Restaurant/importer outbound to meeting

```text
approved ICP and territories
→ authorized discovery and provenance
→ candidate account/contact reconciliation
→ fit and eligibility
→ personalized draft
→ human-approved target/playbook
→ idempotent outbound sequence
→ reply classification and stop rules
→ calendar proposal/meeting
→ Opportunity handoff
```

#### W3 — Paid campaign proposal and governed activation

```text
business goal and budget envelope
→ audience and creative proposal
→ Google/Meta/other provider-specific plan
→ tracking and attribution assumptions
→ human approval for audience, publishing and spend
→ provider execution
→ result ingestion
→ recommendation, not silent optimization
```

#### W4 — Customer reorder or event nurture

```text
authoritative purchase/event signal
→ segment and next-action rule
→ scheduled review/follow-up
→ approved communication or human task
→ response/order/event result
→ evidence and next recommendation
```

### Views and interaction modes

The onboarding asks the owner to choose or accept a recommendation:

```text
Simple owner view
  leads, opportunities, next actions, campaign summary, customers to contact,
  meetings and exceptions

Detailed operator view
  pipelines, data quality, sources, sequences, provider state, campaign detail,
  jobs/outbox, audit, trace and approvals

Conversational mode
  ask the coding/operations agent for bounded status, recommendations and actions

Hybrid mode
  Web Admin for review and operations, conversation for goals and explanations
```

A future authenticated remote MCP may support conversational operations. Current production MCP limitations remain authoritative until that identity surface exists.

### Safety and approval boundaries

The winery blueprint begins at L2/L3:

- discovery, scoring, analysis, drafts, and recommendations may proceed within configured sources;
- target sets, playbooks, sending, publishing, live audiences, spend, provider installation, secrets, destructive changes, and uncertain consent require human approval;
- opt-out, suppression, missing provenance, conflicting identity, budget limit, provider refusal, reply, meeting, or maximum sequence stops the run;
- autonomous L4 operation is a later per-pack evidence claim, never a general default.

Legal basis, ePrivacy/GDPR interpretation, provider terms, and international outreach rules remain human/legal decisions. Accordo records the chosen policy and evidence; it does not decide the law.

## JTBD composition for the winery

The blueprint reuses existing desired jobs rather than creating duplicate vertical jobs:

- SDR and prospecting: `ACC-JTBD-SDR-001`, `003–012`, `018–020`;
- ABM/account development: `ACC-JTBD-ABM-005–012`;
- specialized content and campaign evolution: `ACC-JTBD-CONTENT-019`, `ACC-JTBD-CAMPAIGN-019`, `020`;
- customer-success portfolio, playbooks, communication limits, and specialized agents: `ACC-JTBD-CVM-001`, `004`, `005`, `015`, `018–020`;
- agent composition, monitoring, retry, evaluation, approval, and policy: `ACC-JTBD-AGENT-ENG-005–015`;
- customer data, provenance, interaction, marketing, and analytics jobs from their existing catalogue families and roadmap slices.

The exact 15–25 job acceptance pack is selected after the live winery audit. Selection does not change coverage. Each row moves only when its own executable scenario proves it.

## Roadmap slices

These are planning slices, not implementation or coverage claims.

### OB0 — Goal-first onboarding foundation

Reuse the implemented Project Bootstrap, `solve-business-goal`, App Inspect, Solution Plan, Package Scaffold/Test, Project Doctor/Verify, and scenario evidence. Document one natural-language entry and progressive product questions.

### OB1 — Guided audit and Project Blueprint

Prove the recommended, user-specified, and hybrid modes on two different businesses. Emit one reviewable deterministic blueprint with selected JTBDs, data boundaries, role packs, providers, views, approvals, scenarios, limitations, and deployment choice.

### OB2 — Local and self-host first run

From the approved blueprint, create a project, build the first slice, verify it, and return a local/self-host runbook. The user should not need to understand the internal rails.

### OB3 — Managed Cloud onboarding

Depends on Cloud C0-C3. Connect the repository, create the environment, authorize provider and secrets access, deploy, smoke-test, return the deployment receipt, invite operators and CRM users, and preserve a self-host ejection path.

### OB4 — Post-deploy acceptance and iteration

Drive the selected scenarios, show which desired JTBDs have evidence, teach the chosen Web/conversational workflow, record limitations, and propose the next blueprint version without applying it silently.

### VB0 — Reusable vertical blueprint shape

Prove that Arvo and the winery can use one blueprint structure without moving either business domain into core.

### VB1 — Arvo managed pilot

Existing SaaS integration, strict sensitive-data boundary, PT/Gym commercial and customer operations, 23-job candidate pack, and three evidence scenarios.

### VB2 — Winery inbound CRM

Website/forms, source attribution, customer profile, purchase/event references, pipeline, tasks, views, and a small verified acceptance pack.

### VB3 — Winery supervised prospecting

Compose AW1/AW2 with Customer Data Operations v2 and Interactions. Start with approved sources, sandbox or bounded sending, explicit consent/opt-out policy, and human-approved meeting handoff.

### VB4 — Winery marketing orchestration

Compose the Marketing runtime with provider adapters for campaign analysis and governed activation. No universal Google, Meta, Shopify, email, enrichment, calendar, or telephony integration is implied; each adapter must be implemented and proven.

## Dependency map

```text
Spine v2
→ Spine v3 jobs/outbox/scheduler
→ Spine v4 secrets/backups/observability

Customer Data Operations v2
+ Interactions
+ Marketing runtime
+ Package ecosystem
+ Agentic Workforce AW0-AW3

then

Managed Cloud C0-C3
+ OB1-OB4 guided onboarding
+ vertical blueprint and adapter
→ real pilot
```

Some product-domain work can proceed in parallel with Cloud after the public runtime foundations are complete.

## Acceptance metrics

Do not publish numbers before protocols exist. Candidate metrics are:

- time from business brief to approved blueprint;
- number of human clarifications required, excluding consequential approvals;
- percentage of proposed fields/jobs retained after user review;
- time to first locally verified CRM;
- time to first deployed CRM;
- deployment receipt completeness;
- first-run scenario success;
- unsupported-capability detection rate;
- self-host/ejection success;
- number of manual technical interventions per onboarding;
- JTBD rows earning executable evidence, reported as named rows rather than a vanity percentage.

## Truth boundaries

- No managed Cloud provider has been selected by this document.
- No current coding-agent subscription is assumed to provide unattended production inference.
- No provider integration is available merely because it appears in a blueprint.
- No role-agent pack is installed merely because its JTBDs were selected.
- No generated field is true until populated from an authoritative source or a user decision.
- No infrastructure milestone promotes business JTBD coverage by itself.
- Control Plane identity and CRM-user identity remain distinct.
- Web Admin and conversational access must share the same authorization and evidence boundaries.
- The project remains source-owned and ejectable.