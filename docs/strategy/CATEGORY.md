# Category and positioning

Durable positioning for Accordo. Read [MASTER_PLAN.md](MASTER_PLAN.md) first.
Current implementation, installed-release and deployment claims are resolved
through [PROJECT_STATUS.md](../PROJECT_STATUS.md),
[repository-truth.json](../repository-truth.json),
[the claims ledger](../../site/claims.json) and the applicable release receipt.
This document defines the proposition; it does not certify a release.

## The category we should build

**The open-source custom CRM framework for coding agents.**

Accordo's framework is the foundation a coding agent uses to author a commercial
application around a business process. **Accordo Cloud** is the optional managed
product track for operating the resulting supported systems. Keep both in the
story without confusing a framework checkout, an installed package and a hosted
customer experience.

The broad product idea is **business-shaped customer and revenue software**:
software that reflects how a company wins, serves and grows customers, rather
than forcing every process into the same generic sales pipeline.

This is a positioning choice, not a claim that Accordo invented an empty
category. The dated [competitor map](COMPETITOR_MAP.md) and the
[September agentic CRM research](AGENTIC_CRM_RESEARCH_2026_09.md) show why
“agent-native”, “built with Claude”, custom objects, memory, permissions and
approvals are not sufficient uniqueness claims. Compare specific behavior and
ownership boundaries, not a caricature of competitors as chatbots or rigid
platforms.

## The public promise and the larger vision

**Primary headline — preserve:**

> **Build the customer and revenue system your business actually runs.**

**Framework descriptor:**

> The open-source custom CRM framework for coding agents.

**Framework explanation:**

> Describe your commercial process to your coding agent. Build a custom CRM as
> reviewable application code, with explicit workflows, commercial rules and
> human approval boundaries.

**Ownership line:**

> Describe your sales process to your coding agent; own the CRM it builds.

Ownership describes the source-vendoring path documented in the README and
ADR-023: the customer maintains application source and reviews upstream changes.
It does not mean automatic upgrades, zero maintenance, or that every managed
workspace exports a complete independent application. Advertise only the
ownership and exit path actually demonstrated for the chosen product route.

**Managed-product vision — label it as a vision until the advertised journey is
proven in that product:**

> A CRM built around your business, where agents prepare the work and explicit
> rules govern what happens next.

This extends the proposition; it does not replace the framework category or
announce general Cloud availability. Public Cloud specification:
[AGENT_CRM_CLOUD.md](AGENT_CRM_CLOUD.md). Private implementation and acceptance
retain their separate authorities and must not be copied into public marketing
as availability claims.

## Three agentic capabilities, never conflated

| Capability | Customer question | What the proposition must demonstrate |
|---|---|---|
| **Agent-built** | Can the system fit the way my business works? | An agent authors and changes an application with reviewable source and tests. Field generation alone does not prove a complete bespoke workflow. |
| **Agent-operated** | Does useful work happen without my reconstructing every step? | Context, triggers and authorized integrations produce substantive work and a verified result. Development performed by Claude is not a running sales agent. |
| **Rule-governed** | Can I understand and control the consequences? | The intended action is bound to explicit rules, the appropriate authority and evidence. An approval-looking button does not prove authenticated human approval. |

The product ambition combines all three. A release may demonstrate only a
bounded part. Never infer operational autonomy from code-generation capability,
or broad safety from the existence of an audit table.

## The integrated value proposition

These are **durable product-design commitments and target benefits**, not a
present-tense inventory. They absorb useful competitive lessons without
rebranding another vendor's UVP as an Accordo invention. The evidence required
for publication is specified in [GO_TO_MARKET.md](GO_TO_MARKET.md).

### 1. Fit the business, not just its fields

Start from a commercial objective and its constraints. Build the smallest
coherent system of records, relationships, actions, policies and views that
serves it; make later changes reviewable. The target is business behavior, not
just a tailored schema.

Existing authorities: [OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md](OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md),
[NORTH_STAR_EXPERIENCE.md](NORTH_STAR_EXPERIENCE.md),
[DESIGN_TO_CRM.md](DESIGN_TO_CRM.md).

### 2. Put customer context behind the next action

Help the user understand the customer, the commitment and why an action matters
without reconstructing a history across tools. Every asserted fact should have
an authorized source, appropriate freshness and a visible treatment of missing
or conflicting information. Memory is useful because it changes the work, not
because the product claims to remember everything.

Existing authorities: [DATA_GOVERNANCE.md](DATA_GOVERNANCE.md),
[INTEGRATION_RUNTIME.md](INTEGRATION_RUNTIME.md).

### 3. Turn a described job into prepared work

A user describes an outcome and boundaries, not every API call. Agents should
research, prepare and recommend; permitted routine actions may execute inside
explicit authority. Actions requiring a human must wait. The target is useful
work awaiting a decision, not another to-do list or an endlessly open chat.

Existing authorities: [OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md](OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md),
[JOBS_AND_OUTBOX.md](JOBS_AND_OUTBOX.md),
[AGENT_CRM_CLOUD.md](AGENT_CRM_CLOUD.md).

### 4. Make control part of the experience

The target interaction is:

```text
signal → agent prepares → policy evaluates → human decides when required
       → authorized execution → outcome reconciled and recorded with evidence
```

A decision should expose business context, the prepared artifact, the applicable
rule, the consequence and one clear next action. Human review must be meaningful,
not ceremonial; the user can refuse or edit rather than being nudged to approve
everything. A recorded approval is not proof that an external action completed.

The supporting differentiator remains **“Your agent can write the CRM. It can't
approve the discount.”** Use it with the bounded approval demonstration and its
identity limitations, not as the category definition or a claim that an agent
with source or administrator access is sandboxed by the framework.

Existing authorities: [REVENUE_OPERATIONS.md](REVENUE_OPERATIONS.md),
[AGENT_CRM_CLOUD.md](AGENT_CRM_CLOUD.md),
[QUALITY_GATES.md](../QUALITY_GATES.md).

### 5. Carry the commercial process beyond the next email

The target lifecycle connects prospecting and pipeline to offers, approvals,
agreements, delivery, service and renewal through optional domains. Completing
a customer job matters more than presenting a large module inventory. Do not
bundle all domains into one availability claim or relabel a recorded intention
as a completed contract, delivery or payment.

Existing authorities: [REVENUE_OPERATIONS.md](REVENUE_OPERATIONS.md),
[CONTRACT_SUBSCRIPTION_RENEWAL.md](CONTRACT_SUBSCRIPTION_RENEWAL.md),
[DELIVERY_SERVICE.md](DELIVERY_SERVICE.md),
[MARKETING_GROWTH_OPERATIONS.md](MARKETING_GROWTH_OPERATIONS.md).

### 6. Make adoption useful and ownership real

Start from one valuable business process, bring the necessary context across,
and make the first result understandable. Migration needs reconciliation and
exceptions; ownership needs usable source, data and a proven exit boundary.
Optional managed operations should remove infrastructure work without silently
changing what the customer can customize or keep.

Existing authorities: [AGENT_CRM_CLOUD.md](AGENT_CRM_CLOUD.md),
[DATA_GOVERNANCE.md](DATA_GOVERNANCE.md),
[CRM_BUILD_BENCHMARK.md](CRM_BUILD_BENCHMARK.md).

## Framework freedom and managed customization

The framework and the managed workspace answer different customization
questions. Source authoring may change application behavior; a shared managed
runtime must accept only the customization its own reviewed contracts support.
Never promise that a Cloud user can run arbitrary code merely because the
framework is open source.

Every managed offer must explain what a workspace can configure, what needs a
reviewed extension or release, and what requires a separately approved dedicated
placement. A requirement outside the supported boundary is refused or explicitly
scoped; it is not silently translated into a paid installation. This is an
acceptance rule, not a claim that a particular placement or export path is live.

## Who we serve and how we enter

**Primary framework ICP:** developers and agencies building CRM-shaped internal
tools or client systems with coding agents. They need business-specific behavior
without re-deriving foundational workflow and approval semantics each time.

**Managed-product ICP hypothesis:** technical founders, product/revenue leaders
and RevOps teams whose customer process crosses sales and operations, and whose
exceptions matter enough to justify a tailored system. Validate this hypothesis
through completed customer jobs, not enthusiasm for AI.

**Secondary:** SaaS teams embedding CRM capabilities in their own products.

The initial public proof remains a bounded B2B quote/approval journey. A larger
vision is not permission to launch every domain, replace the existing execution
sequence or pursue feature parity with every incumbent.

### Primary job to be done

> When my commercial process does not fit a packaged CRM, I want to describe the
> outcome and the rules to a coding agent, get a reviewable system built around
> them, and progressively delegate useful work without losing control of the
> decisions or the application.

### The alternatives a buyer actually weighs

| Alternative | Why it can be the right choice | What Accordo must prove to win |
|---|---|---|
| An agentic CRM application | Faster access to packaged integrations, memory and sales work | A business-specific process whose fit and outcomes justify building or tailoring a system |
| A customizable CRM/business platform | An established operating surface and extensibility | The relevant behavior and ownership are clearer or more suitable, not merely that our syntax differs |
| Building from scratch | Complete design freedom and familiar tools | Reusing CRM foundations reduces rework while preserving the customer's design and maintenance choices |

Competitor capabilities and limitations require dated primary evidence. There
is no blanket claim that platforms cannot be extended, that their agents cannot
build software, or that the Accordo approach is categorically safer or cheaper.

## Message discipline

Lead with the business outcome, explain the mechanism, then show proof and the
boundary. Do not lead every conversation with governance, MCP, a module count or
infrastructure. Do not promise universal autonomy, complete customer memory,
instant setup, zero administration, effortless migration, automatic upgrades,
revenue lift or a market-wide “only”.

The six benefits above form one coherent proposition, not six new product lines.
Publication-ready framework wording, explicitly labeled vision copy, bilingual
variants and proof gates live in [GO_TO_MARKET.md](GO_TO_MARKET.md).
