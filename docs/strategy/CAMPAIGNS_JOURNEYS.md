# Campaigns, Proposals and Journeys

**Status: product strategy only. Nothing in this document is implemented.** No campaign, proposal, audience, suppression, journey, enrolment, content asset, landing page, tracking plan or channel provider exists in the repository today. This document defines the objects and their boundaries so MK1–MK4 can be built without re-deciding them (`MARKETING_GROWTH_OPERATIONS.md`).

---

## 1. The Campaign Proposal is the primary object

Most marketing tools ask a user to assemble a campaign from a dozen screens: an audience here, a template there, a UTM convention in someone's head, a launch button at the end. The user never sees the whole thing at once, so nobody can review it — they can only approve the last step.

The **CampaignProposal** inverts that. It is one CRM object an agent creates and a human reads: complete, coherent, and reviewable before anything exists in a provider.

### What a proposal carries

| Section | Fields |
|---|---|
| **Why** | observed funnel insight; evidence and source metrics; objective; hypothesis; primary KPI; secondary KPIs |
| **Who** | target audience definition; exclusions; suppression and consent requirements; control or holdout design |
| **What kind** | campaign mode (`one-shot`, `rolling`, `triggered`, `journey`); proposed date, time and window; frequency cap |
| **Where** | channel mix; installed provider choice **and the rationale for it** |
| **What is said** | content plan; creative plan; landing page; form; CTA; thank-you page |
| **How it is measured** | tracking plan — UTM scheme, conversion events, touchpoint definitions; experiment design |
| **What it costs** | optional paid-media acceleration; proposed budget |
| **What could go wrong** | expected outcome and confidence; risks; the human approvals required |

A proposal that cannot state its audience, its exclusions, its measurement and its risks is not ready for a human, and the framework should say so rather than render a half-filled form.

### The rules that keep it honest

1. **The user sees a proposal, not configuration.** One object, one screen, prose where prose is clearer than a field.
2. **Nothing in it exists in a provider yet.** A proposal is a proposal; approval is what creates anything external.
3. **It is versioned.** Editing a reviewed proposal produces a new version. What the approver saw is what is stored.
4. **Provider choice is explained.** "Resend, because this is transactional-shaped, under 5k recipients, and the sandbox is configured" — not a silent default.
5. **The agent may not widen it after approval.** Approval covers the proposal that was read; a changed audience is a new approval.

## 2. Campaigns, versions and runs

```text
CampaignProposal   what the agent proposes, and what a human reads
→ Campaign         the approved, named thing that persists across versions
→ CampaignVersion  an immutable snapshot: audience rule, content versions, tracking plan, policy fingerprints
→ CampaignRun      one execution of one version, with its own evidence
→ CampaignResult   what happened, attributable to that run
```

A **CampaignVersion** is immutable for the same reason a QuoteVersion and an OrderVersion are: it is what somebody agreed to. Changing a live campaign publishes a new version; the old one still explains the runs it produced.

## 3. Audiences

| Object | Meaning |
|---|---|
| `AudienceDefinition` | the **rule** — a versioned, declared, deterministic selection over CRM data |
| `AudienceSnapshot` | the **membership** frozen at a moment, with its count and its definition fingerprint |
| `SuppressionSet` | who must never receive this, regardless of the rule |

Rules the runtime must enforce:

- an audience definition is **deterministic and declared** — the same rule over the same data yields the same membership, and the rule is fingerprinted like every other versioned definition (ADR-015);
- a one-shot campaign sends to a **snapshot**, not to a live query. "Who was in the audience?" must be answerable years later without re-running anything;
- suppression is applied **last** and is never overridable by a campaign;
- a rolling campaign re-evaluates the rule on a schedule and must record **each** enrolment decision, not just the final membership.

## 4. Consent, preferences and governance

Before **any** enrolment or send, in this order:

1. legal / consent basis for this contact and this purpose;
2. communication preferences;
3. channel permission (email ≠ SMS ≠ WhatsApp);
4. suppression sets;
5. frequency cap across all campaigns, not just this one;
6. tenant / customer boundary — once the Production Spine exists.

A failed check is a **recorded, explained exclusion**, never a silent drop: "3,410 selected, 190 excluded — 120 no consent for this purpose, 55 frequency cap, 15 suppressed" is the minimum a reviewer needs.

The framework must also model:

- **unsubscribe** — inbound, honoured immediately, across every campaign;
- **bounce and invalid destination** — hard versus soft, and what each does to future sends;
- **opt-out** distinct from unsubscribe where the law distinguishes them;
- **provider data sharing** — what leaves the building, to whom, under which agreement;
- **retention** of audience snapshots and touchpoints;
- **export and deletion** interaction: a deletion request must reach marketing evidence too;
- **immutable legal and evidence exceptions** — what deletion may *not* remove, and why.

Details and the primitives these compose from: `DATA_GOVERNANCE.md`.

**This is not a compliance claim.** Nothing here asserts GDPR, CAN-SPAM or any other regime is satisfied. These are the hooks a compliant configuration needs; the configuration and the legal judgement are the customer's.

## 5. Channels and provider contracts

A provider is an **optional adapter**, exactly like the signature and catalog providers (`INTEGRATION_RUNTIME.md`, ADR-013, ADR-017). None is a mandatory dependency, and naming one here commits the project to nothing.

| Channel | Example adapters a customer might install |
|---|---|
| Email | Resend, MailUp, Amazon SES, a custom provider |
| SMS | a provider-neutral SMS adapter |
| WhatsApp | official or provider-mediated |
| Ads | Google Ads, Meta Ads, LinkedIn Ads, a custom provider |
| Analytics and insight | GA4, Google Search Console, PostHog, product analytics, a warehouse/semantic layer, a custom provider |
| Content publishing | landing-page, static-site or CMS deployment |

### What provider metadata must declare

```text
channel                      email | sms | whatsapp | ads | analytics | publishing
transactional / bulk         which it is allowed to carry
region                       where it sends from and stores
rate and batch constraints   per second, per day, per batch
template capability          server-side templates? variables? what escaping?
tracking and webhook support opens, clicks, bounces, conversions — and how they are verified
unsubscribe / consent        does it hold its own list, and who wins
sandbox capability           can it be exercised without reaching a real recipient
installed / configured       state, not aspiration
health metadata              safe, bounded, no credentials
```

Rules:

- Claude selects only among **installed and configured** providers. An uninstalled provider is not a recommendation, it is a request for a human to install one.
- Provider selection is **versioned and explainable** — stored with the run, with the rationale.
- **No provider install, send or spend without the appropriate human approval.**
- A provider's health metadata is bounded and function-free, like every other schema block.

## 6. Content, creative, landing and tracking

The agent should be able to generate: email content, SMS and WhatsApp copy, images and creative references, a landing page, a form, a CTA, a thank-you page, design tokens and branding, responsive and accessibility behaviour, a preview, UTM parameters, conversion events, analytics tags, and attribution touchpoint definitions.

Two non-negotiables:

1. **Assets and source stay in the customer's repository.** Generated content is checked-in source they own, review and can revert — not rows in a vendor's database. This is the same commitment as everywhere else in the framework.
2. **Design ownership is code-owned.** Branding and tokens live with the code. Nothing here claims visual or Figma ingestion is implemented — that is `DESIGN_TO_CRM.md`, and it is a separate, unimplemented track. Where MK3 touches design, it composes what that document defines.

A **TrackingPlan** is a first-class versioned object, not a convention: it names the UTM scheme, the conversion events, and the touchpoint definitions, so that what a campaign measured is knowable after the fact and consistent across channels.

## 7. Journeys

A journey is a stateful, multi-step, multi-channel orchestration:

```text
JourneyDefinition   the shape: steps, waits, conditions, exit criteria, goals
→ JourneyVersion    immutable; enrolments are pinned to the version they entered
→ Enrollment        one contact's stateful position in one version
→ StepExecution     one attempt at one step, with its provider evidence
```

What it requires, and why MK4 cannot be pulled forward:

- a **scheduler** — nothing in the framework fires on a date today, deliberately;
- **durable waits** that survive a restart;
- **retry and backoff** with a bounded, explained failure;
- **exit criteria** evaluated on every tick, not just at the end;
- **stateful enrolment** with exactly-once step semantics;
- **version pinning** — publishing a new version must not mutate active enrolments.

All of that is Durable Automation (`JOBS_AND_OUTBOX.md`). Building journeys on the current in-process, post-commit event buffer (ADR-012) would produce something that looks right in a demo and drops steps in production. It waits.

## 8. Related

`MARKETING_GROWTH_OPERATIONS.md` · `EXPERIMENTATION_ATTRIBUTION.md` · `DATA_GOVERNANCE.md` · `JOBS_AND_OUTBOX.md` · `INTEGRATION_RUNTIME.md` · `DESIGN_TO_CRM.md` · `docs/PACKAGE_AUTHORING.md`
