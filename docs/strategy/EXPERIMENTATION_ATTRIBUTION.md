# Experimentation, Paid Media and Attribution

**Status: product strategy only. Nothing in this document is implemented.** No experiment, variant, control group, holdout, assignment, media plan, funnel definition, attribution model, touchpoint or revenue credit exists in the repository today. This document defines MK5–MK7 so they can be built without re-deciding the hard parts (`MARKETING_GROWTH_OPERATIONS.md`).

---

## 1. Experimentation

An experiment is how a proposal stops being an opinion.

| Object | Meaning |
|---|---|
| `Experiment` | the question, its metrics, its duration and its decision rule |
| `Variant` | one treatment, pinned to a content and campaign version |
| `ControlGroup` | who gets the current behaviour |
| `Holdout` | who gets **nothing**, so the campaign's own lift is measurable |
| `DeterministicAssignment` | the reproducible mapping of subject → variant |
| `ExperimentMetric` | primary and guardrail metrics, defined semantically |
| `WinnerDecision` | the call, its evidence, and who made it |

### What the runtime must guarantee

1. **Subjects stay pinned.** Once assigned, a contact remains in its variant for the life of the experiment. Reassignment silently destroys the result.
2. **Publishing does not mutate active enrolments.** A new version applies to new entrants; those already in flight finish under the version they entered.
3. **Assignment is reproducible.** Deterministic from a declared, fingerprinted rule and a stable subject key — never `Math.random()`, never a clock. Given the inputs, the same assignment is recomputable years later.
4. **Exposure evidence is immutable.** *Assigned* and *actually exposed* are different facts and both are recorded; analysing on assignment when delivery failed is how a result becomes a lie.
5. **Result evidence is immutable.** A finished experiment's numbers are a snapshot, not a live query that drifts as data changes.
6. **A winner is applied as a new version.** Never an edit to the running one.
7. **Auto-applying a winner requires human approval** wherever business risk exists — spend, external send, a live journey.
8. **"Inconclusive" is a first-class outcome.** A framework that can only declare winners will declare them wrongly.

**Not claimed, deliberately:** sequential testing, Bayesian decision automation, automatic sample-size or power calculation, multi-armed bandits, or automatic significance thresholds. Advanced statistical automation is out of scope for MK5; what is in scope is that the *evidence* is good enough for a statistician to trust and for the framework never to overstate it.

## 2. Paid media

Paid media is where an agent can spend a customer's money, so it is where the approval boundary matters most.

| Object | Meaning |
|---|---|
| `MediaPlan` | the proposal: objective, channels, audiences, creative, budget, duration |
| audience sync | pushing an audience snapshot to a provider, under consent rules |
| creative and copy | versioned content assets, as elsewhere |
| conversion event | the tracked outcome the platform optimizes toward |
| budget | proposed, approved and actual, in integer minor units |
| bid strategy metadata | declared, never invented by the agent |
| platform references | campaign / ad-group / ad ids, as external references |
| spend and result ingestion | what the platform reports back, as evidence |
| pause / resume proposal | a proposal, not an action |
| budget-change proposal | a proposal, not an action |
| closed-loop revenue evidence | ad → touchpoint → Lead → Opportunity → Order |

### Human approval is mandatory for

- creating spend;
- increasing a budget;
- launching a campaign;
- changing targeting materially;
- pausing a high-impact campaign.

The agent may **prepare all of it** — plan, audiences, creative, tracking, budget — and show it in Admin. It may not launch it. Money is the clearest case in the framework for the human-actor boundary the runtime already enforces for signature, activation and handover.

Amounts use the money contract everywhere: integer minor units, explicit currency, never floats (ADR-014).

## 3. Funnels and drop diagnosis

```text
FunnelDefinition   the steps, declared and versioned
→ FunnelRun        one evaluation over a period and a population
→ FunnelDropInsight  where it leaks, for which segment, with the evidence
→ CampaignProposal   the agent's answer to the leak
```

A `FunnelDropInsight` is the input to the whole loop in `MARKETING_GROWTH_OPERATIONS.md`. To be worth acting on it must carry the segment, the step, the magnitude, the comparison baseline, and the query version that produced it — so a reviewer can disagree with it on the evidence rather than on instinct.

## 4. Attribution

| Model | What it credits |
|---|---|
| first-touch | the touchpoint that started it |
| last-touch | the touchpoint before conversion |
| multi-touch | a declared distribution across the path |

Plus: Campaign → Lead → Opportunity → Order/Revenue association, campaign ROI, cohort analysis, control-group lift, and content/channel/provider comparison.

### The rules that keep attribution honest

1. **No model is "truth".** Every model is an assumption about credit. The assumptions and the version are stored with every `AttributionRun`, and two models disagreeing is normal, not a bug.
2. **Runs are versioned and immutable.** Re-running a model with new data produces a new run; the old one still explains the decisions taken on it.
3. **Analytics uses semantic metrics and safe query compilation** from `ANALYTICS_STUDIO.md`. **No arbitrary agent-generated production SQL** — the agent composes declared metrics and dimensions, and the studio compiles them. This is a hard boundary, not a preference.
4. **Control-group lift outranks attribution.** Where a holdout exists, it is the better answer, and the framework should say so rather than quietly preferring the model that flatters the campaign.
5. **Identity is the hard part.** Multi-touch attribution needs a touchpoint and identity model that does not exist today. MK7 is blocked on it, and no amount of modelling substitutes for it.

## 5. Dependencies, stated as blockers

| Capability | Needed by | Where it is defined |
|---|---|---|
| Durable Automation (scheduler, outbox, inbox, retry) | MK4 journeys; rolling and triggered modes | `JOBS_AND_OUTBOX.md` |
| Analytics Studio (semantic metrics, safe compilation) | MK7 attribution; MK1 funnel insight quality | `ANALYTICS_STUDIO.md` |
| Identity and touchpoint model | MK7 multi-touch attribution | not yet defined — MK7 must define it or fail honestly |
| Data Governance (consent, preferences, suppression, retention) | MK2 onward | `DATA_GOVERNANCE.md` |
| Production Spine (auth, tenancy, RBAC) | any real multi-user approval role | `PLATFORM_CAPABILITIES.md` |

## 6. Related

`MARKETING_GROWTH_OPERATIONS.md` · `CAMPAIGNS_JOURNEYS.md` · `ANALYTICS_STUDIO.md` · `JOBS_AND_OUTBOX.md` · `DATA_GOVERNANCE.md` · `REVENUE_OPERATIONS.md` · `docs/benchmarks/CRM_JTBD_MATRIX.md`
