# Worked example — "track and optimize the Lead → Won funnel by acquisition channel"

**Status: a worked design, not a transcript of something that ran.** Parts of the solution below are buildable today; the analytics and campaign parts are not, and each row says which. Nothing here claims the end-to-end loop executes.

The prompt this traces:

> *"Track and optimize the full funnel from Lead creation to Won Deal, with particular focus on acquisition channel. Decide what to track, how to configure it, what to show in the CRM, how to analyze funnel drop-offs, and what optimization action to propose."*

Companion to `OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`. The lifecycle sections below follow its stages.

---

## GOAL — what the agent restates back

| | |
|---|---|
| **Outcome** | increase Won deals from the existing lead flow, by understanding where the funnel leaks and which acquisition channels convert |
| **Primary metric** | Lead → Won conversion rate, segmented by acquisition channel |
| **Secondary** | stage-to-stage conversion; time between stages; won value by channel |
| **Scope** | the existing pipeline; no change to commercial terms; no external sending in phase one |
| **Constraints** | no spend without approval; no personal data leaving the system |
| **Sensitive boundaries** | any send, any publish, any spend, any provider install |

If the user had not supplied a metric, the agent asks for one instead of choosing. "Optimize the funnel" without a number cannot be verified in the VERIFY stage.

---

## DISCOVER — what the agent finds installed today

| Surface | Status |
|---|---|
| Lead capture, qualification, conversion (M7) | **merged** |
| Lead Intelligence — enrichment, explainable scoring, deterministic routing (M9) | **merged** |
| Pipeline with stage transitions (M8) | **merged** |
| Commercial Operations — catalog, quotes, discounts, approvals (M10) | **merged** |
| Signature and immutable Order (M11) | **merged** |
| Contract activation and subscriptions (M12) | **merged** |
| Delivery handover (M13) | **merged** |
| Custom package authoring, `definePackage`, capabilities (M13) | **merged** |
| Module evolution (ADR-019) | **open PR** |
| Marketing packages — campaigns, audiences, journeys | **not implemented** (MK track, design only) |
| Analytics Studio — semantic metrics, safe query compilation | **not implemented** (M16, design only) |
| Attribution and identity/touchpoint model | **not implemented** (MK7, and it needs an identity model that does not exist) |
| Durable automation (scheduler, outbox) | **not implemented** |

## ASSESS — the capability gap, stated plainly

**Reusable as-is:** the Lead, Opportunity and pipeline records; the stage-transition action and its audit/trace; quote, order and contract evidence for the Won end of the funnel; the module factory for new records; the package contract for a new domain; versioned policies for any decision that must explain itself.

**Missing, and consequential:**

1. **acquisition fields on the Lead** — nothing today records channel, source, medium, campaign or landing page;
2. **a touchpoint record** — a Lead has no history of how it arrived;
3. **funnel definition and evaluation** — no primitive computes stage-to-stage conversion;
4. **attribution** — no model, and no identity graph to hang one on;
5. **a campaign proposal object** — MK1, not built;
6. **any sending capability** — MK2 onward, not built.

**Data-quality gaps the agent must surface before promising anything:** leads created before this change have no acquisition data and never will; a channel captured from a referrer is a guess unless a UTM is present; and consent state for any future outreach does not exist yet (`DATA_GOVERNANCE.md`).

## DESIGN — the decision, and the reasoning

**Reuse, do not duplicate.** The funnel's first stage is the existing Lead; its last is the existing Order/Won Opportunity. Nothing about the pipeline is rebuilt.

**One custom package, because no official one covers this:**

```text
packages/custom/acquisition-attribution/
```

offering capabilities that do not exist elsewhere:

```text
analytics.funnel@1                     define and evaluate a funnel
analytics.acquisition-touchpoints@1    record how a lead arrived
analytics.attribution@1                credit a Won deal to touchpoints
```

It would be created **only because** `crm package inspect` and `/api/schema` show nothing provides them. If a future official `packages/attribution` ships those capabilities, the custom package is replaced by declaring the official one — that is the point of the package contract.

**Evolution, not a new record.** Adding acquisition fields to the existing Lead is exactly what ADR-019 enables: bump the Lead manifest's `revision`, add optional fields, and the migration is appended. Before ADR-019 this required a second parallel record — a worse model chosen for a tooling reason.

### Tracking plan

Events, at minimum:

```text
Lead Created · Enriched · Qualified · Opportunity Created · Stage Changed
· Quote Submitted · Quote Approved · Order Signed · Opportunity Won
```

Acquisition fields and touchpoint attributes:

```text
channel · source · medium · campaign · content · landingPage · form
· referrer · providerReference · UTM values · consentReference
```

Every one is optional and nullable: a lead that arrived by phone has none of them, and the model must say "unknown" rather than guess.

### The funnel

```text
Lead Created → Qualified → Opportunity → Proposal/Quote → Won
```

### Attribution

**First-touch is the primary model**, because the goal is *acquisition channel* — the question is which channel brought the lead, not which touch closed it. Last-touch and a simple multi-touch model are offered as secondary views.

Stated wherever a number is shown: **no attribution model is causal truth.** Each is an assumption about credit; the assumptions and the model version travel with every result; and where a control group exists, lift outranks attribution.

### Admin experience (desired; the analytics views need Analytics Studio)

Funnel overview · conversion by channel · time between stages · **a data-quality panel** (how many leads lack acquisition data, and from when) · acquisition touchpoints on the Lead · attribution evidence with its model version · a funnel-drop explorer · the recommended action · a Campaign Proposal.

The data-quality panel is not decoration. A conversion rate computed over leads that mostly lack channel data is misleading, and the screen must say so.

### Tests and acceptance

Package conformance · funnel arithmetic against a deterministic fixture with a known-correct expected result · exact indexed reads past the paged bound · hostile input inert · audit and trace exactness · and a JTBD row moved only with linked evidence.

## PLAN → APPROVE → BUILD → VERIFY

The agent emits a SolutionPlan (§4 of the companion document) and a prose summary. The human approves nothing in phase one **because phase one sends nothing and spends nothing** — it adds fields, records touchpoints and computes a funnel. Approval enters at the moment a campaign would send.

## The optimization output

What the agent produces once a drop is identified — evidence-backed, and reviewable as one object:

| Section | Content |
|---|---|
| source drop insight | which stage, which segment, magnitude, baseline, and the query version that produced it |
| target audience | the rule, and the snapshot it would freeze |
| exclusions | suppression, consent, frequency cap — each counted and explained |
| control / holdout | so lift is measurable rather than asserted |
| campaign mode | one-shot, rolling, triggered or journey — and what each costs |
| channels and providers | only among installed and configured ones, with the rationale |
| timing · content · landing · CTA · tracking | the full proposal, not fragments |
| KPI and expected outcome | with a confidence statement |
| approvals required | named explicitly |

**No send and no spend without human approval.** That is not a policy this example can relax.

---

## Two-hat validation

### The Claude/Codex hat — can the agent answer these?

| Question | Answerable today? |
|---|---|
| What is the goal? | yes — restated and confirmed |
| What is the primary metric? | yes |
| What packages and capabilities exist? | yes — `package inspect` and `/api/schema`, assembled by hand until AX1 |
| What is missing? | yes, from the same surfaces plus the JTBD matrix |
| What data is reliable? | **partly** — the agent can count nulls, but there is no data-quality primitive |
| What provider is installed? | yes for signature and catalog; **no marketing provider contract exists** |
| What policy or model is appropriate? | yes for scoring/routing/discount; **no attribution model primitive** |
| What needs human approval? | yes — the boundary list is explicit |
| What tests prove success? | yes — Quality Gates and JTBD acceptance |

**Failure condition:** if the agent cannot answer one of these, it must say so in PRESENT rather than proceed. An unanswered "what data is reliable?" invalidates every number downstream.

### The CRM-user hat — can the user do these?

| Can the user… | Today |
|---|---|
| provide only the business objective? | yes |
| understand the proposed solution? | yes, if the agent writes the prose companion |
| review the assumptions? | yes |
| see what data is collected? | yes, once the fields exist |
| see the resulting Admin? | yes — generated Admin is real |
| understand the funnel? | **not yet** — no funnel view exists |
| see the identified drop? | **not yet** |
| review an optimization proposal? | **not yet** — MK1 |
| approve only sensitive actions? | yes, at the human-actor boundary; real roles need the Production Spine |
| understand the limitations? | yes, if the agent reports them — which the Skill requires |

**Failure condition:** the user should never have to open a manifest, write SQL, or learn what a capability is to get an answer. If they do, the experience failed regardless of what was built.

---

## What this example proves, and what it does not

**Proves:** the discovery, gap analysis, package-versus-kernel decision, data modelling and test design are all expressible today with merged capabilities, and module evolution removes the one structural blocker that would have forced a worse data model.

**Does not prove:** that the funnel is computed, the drop detected, the campaign proposed or anything sent. Those need MK1–MK2 and Analytics Studio. The benchmark (`CRM_BUILD_BENCHMARK.md`, **E2E-G1**) is therefore marked **planned**, with partial execution allowed today for the discovery, planning and build-what-exists stages.
