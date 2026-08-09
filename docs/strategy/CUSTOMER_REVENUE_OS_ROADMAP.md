# Customer & Revenue OS — roadmap alignment and competitor-informed audit

**Status: strategy. Nothing here is implemented, and nothing here renames
anything.** It answers four questions a roadmap has to be able to answer, records
what the market has made table stakes, and elevates the pillars that were real
but under-prioritized. The parallel GTM branch is untouched; this is the
engineering-side view.

---

## The story: what an agent does, and what a user gives

```text
GOAL
  → SEE       what exists
  → PLAN      what to build
  → BUILD     the right starting point, then build
  → CHECK     what is inconsistent, and what the rules say
  → PROVE     that it works

Refactor-only:
  → PRESERVE  freeze behaviour before changing it
```

| Stage | Rail | The question it answers | State |
|---|---|---|---|
| **SEE** | App Inspect (AX1) | what exists here? | implemented — `crm app inspect` |
| **PLAN** | Solution Plan (AX2) | what should we build? | implemented — `crm solution check` |
| **BUILD** | Package Scaffold (DX3) + the coding agent | a conforming starting point, then the work | implemented — `crm package scaffold` |
| **CHECK** | Project Doctor (DX1) + Package Conformance (DX4) | what is inconsistent; what do the rules say? | implemented — `crm project doctor`, `crm package test` |
| **PROVE** | Quality Gates, and later Project Verify (DX5) + Implementation Evidence (DX10) | does it actually work? | **partial** — gates written; DX5/DX10 not built |
| **PRESERVE** | LA0 Characterization | does the refactor change what it decides? | implemented — `npm run characterize:intelligence` |

**This is storytelling, not a manual sequence.** A user gives a goal. The rails
are internal: `solve-business-goal` chooses the minimum set for the job, and for
a pure refactor that set includes PRESERVE and may skip PLAN entirely. Nobody
should ever have to know that `app inspect` precedes `solution check`. A user
who has to sequence our implementation has been handed our architecture as their
workflow, which the DX North Star already refuses.

The one worked example is checked in:
`docs/evidence/lead-intelligence-extraction.md` — a real refactor, one rail per
step, with the command and the answer at each.

### The allowed positioning line

> Accordo gives coding agents a way to **see, plan, build, check and prove** —
> instead of just generating code.

Every clause maps to a command in the table above. The two clauses that are only
partly true today (**prove**) are marked partial there and must be marked
partial anywhere else they appear.

---

## Category: "CRM" is too narrow

Recorded as a finding, not as a rename. **No public tagline changes here.**

The architecture already spans lead intelligence, CPQ, signature and order,
contracts and subscriptions, delivery execution and economics, and service
operations. "CRM" describes the first of those and is read by most buyers as
*contact and pipeline management*. It undersells the object model and, worse,
sets the wrong expectation for what an agent can be asked to build.

Two framings to explore, both unresolved:

- **Agent-native Customer & Revenue Platform** — accurate about scope, quiet
  about the wedge.
- **Customer & Revenue Operating System for coding agents** — accurate about the
  wedge, and "operating system" is a claim that has to be earned by the
  extension and distribution pillars below, which do not exist yet.

**Keep "CRM" as the entry term.** It is what people search for and what makes
the project legible in five seconds, and an entry term does not have to be the
ceiling of the architecture. The broader framings are for the long-term story,
used alongside CRM rather than instead of it.

The honest position today: the second framing describes the *destination*, and
**"operating system" is a claim to be earned, not asserted**. It rests on an
extension surface that is still `ADMIN_EXTENSIONS_UNSUPPORTED`, a distribution
story that does not exist, and production foundations that are not built. Revisit
when the Extension Surface, Package Distribution and Production Spine pillars
have shipped something.

**The brand decision — Accordo / accordo.dev — is a human's and is unchanged.**

---

## What is implemented, partial, planned

Read this before positioning anything.

| Area | State |
|---|---|
| Customer data (company, contact, lead, task, approval) | **implemented** — generated modules, audit, trace |
| Acquisition / lead | **implemented** — enrichment, signals, versioned explainable scoring, routing (now a package) |
| Sales pipeline | **implemented** — stages, transitions, approval boundaries |
| CPQ | **implemented** — catalog, price books, quotes, versions, discount policy with human approval |
| Signature & order | **implemented** — provider contract, verified webhooks, signed-artifact evidence, immutable orders |
| Contracts & subscriptions | **implemented** — activation policy, contract versions, subscription lines, obligations |
| Delivery | **implemented** — projects, work packages, milestones, economics, change, acceptance evidence |
| Service | **implemented** — coverage, entitlements, cases, elapsed-time SLA evidence |
| Renewal / expansion | **M16a merged** — term evidence, renewal/non-renewal intent, governed commercial handoff. It records intent and hands off; it renews, cancels and signs nothing, and records no successor. **M16b — amendment execution — deferred** until Commercial and Signature are reachable through capabilities |
| Marketing | **planned** — MK0–MK7, documentation only |
| Analytics | **planned** — Analytics Studio |
| **Customer data operations** (import/export, dedupe, identity, timeline) | **planned** — see the pillar below; largely *absent*, not partial |
| **Interactions / communications** (email, calendar, calls, conversations) | **planned** — absent |
| **Package extension surface** (Admin/UI, HTTP routes) | **planned** — `ADMIN_EXTENSIONS_UNSUPPORTED`; no route contribution |
| **Package distribution & lifecycle** (install, versions, trust) | **planned** — absent |
| Production spine, Cloud | **planned** — no auth, tenancy, RBAC, PostgreSQL |

---

## Competitor-informed audit

**Method, and what this review is worth.** Retrieved **2026-08-08** via web
search. This is a **bounded review of published material, not an exhaustive
audit**: it read vendor documentation and changelogs reachable from search, not
every page, release note, private beta or roadmap. Several vendor documentation
hosts (`docs.attio.com`, `attio.com`) are blocked by this environment's network
egress proxy, so those rows are **search-summary sourced** rather than read
directly.

Because the review is bounded, this document does not say *nobody does X*. It
says **we did not find X in the material we reviewed**, which is a weaker and
truthful claim, and one a single counter-example corrects rather than
demolishes. Nothing here is a market-share, superiority or benchmark claim, and
none of it may become one.

| Source quality | Meaning |
|---|---|
| **direct** | the official page was fetched and read |
| **search summary** | the official page was described in search results but not fetched (egress-blocked) |

| Vendor | What the reviewed material describes | Source | Source quality |
| **Salesforce / Agentforce 360 / Data 360** | A metadata layer as the agent's context: fields, labels and automations carry metadata agents read. Agent definitions are **metadata that flows through DevOps Center, change sets or CI**; the 2026 Agentforce Builder adds `AiAuthoringBundle`, `agentScript`, `agentGraph`. Data 360 unifies sources behind a trusted metadata/semantics layer. | `developer.salesforce.com/blogs/2026/05/new-agentforce-metadata-and-development-lifecycle`; `salesforce.com/platform/metadata-data/` | search summary |
| **HubSpot Customer Platform / Data Hub** | A unified developer platform: **CLI + projects framework + UI extensions + APIs**, described as an *AI-ready framework* with Breeze Agent Tools. Projects are versioned (`2026.03`), built locally, deployed with `hs project upload`, developed with `hs project dev`, with sandboxes and GitHub integration. UI customization is in beta. | `developers.hubspot.com/developer-platform-basics`; `developers.hubspot.com/docs/platform/ui-customization-overview`; 2026 changelogs | search summary |
| **Twenty** | Open source, self-hostable. **Twenty 2.0 ships a native MCP server with every Cloud workspace**, connected by OAuth so an assistant can read and write CRM data. Community MCP servers add schema discovery and CRUD. | `twenty.com/product`; 2026 release coverage | search summary |
| **Attio** | An **App SDK**, a **REST API**, and an **MCP server** — including one serving their *documentation* so agents can search it autonomously. New apps are **pre-configured for Claude Code via a `.mcp.json`**; their engineering blog describes Claude Code plus their docs MCP producing code that "feels" like it was written at Attio. | `docs.attio.com/sdk/guides/ai`; `attio.com/platform/developers`; `attio.com/engineering/blog/building-better-software-with-ai` | search summary (egress-blocked) |

### The hypothesis, tested

> AI-friendly docs, MCP, app scaffolding and coding-agent guidance are becoming
> table stakes.

**Supported by the evidence reviewed, and held as a strategy hypothesis rather
than a law.** In the material reviewed, all four vendors ship at least two of
the four, and two of them (Attio, HubSpot) ship something close to all four.
That is enough to plan on: a roadmap whose differentiation is "we have an MCP
server and good docs for agents" is most likely describing parity rather than a
wedge. It is not enough to assert as a universal fact about the market, and the
hypothesis should be re-tested when the next round of vendor releases lands.

### Where the differentiation appears to be

**We did not find, in the material reviewed**, any of the four describing:

- **goal-first orchestration** — the user states an objective; the system picks
  the rails. The vendors above expose *tools* to an agent; the agent still
  supplies the method.
- **deterministic discovery and planning as commands** — `app inspect` and
  `solution check` return contract-versioned, canonically ordered, fingerprinted
  JSON, and a plan is *bound* to a composition so it can go stale. Metadata that
  an agent can read is not the same as a plan that can be refused.
- **architectural constraints that refuse** — fail-closed validation, a package
  contract, managed records with no public write path, an approval boundary that
  returns 403 to an agent actor.
- **machine-readable evidence** — audit, trace and fingerprints designed to be
  *counted* by a test, not read by a human.
- **characterization / behavioural equivalence** — LA0. A refactor proved not to
  change any externally observable decision. This one is genuinely unusual.
- **package conformance as a command** — `crm package test` answering whether an
  extension satisfies the contract, mechanically.
- **proof instead of agent self-report** — the whole point. An agent saying "done"
  is not evidence; a command that fails is.

**This looks like the wedge, and most of it is implemented.** What is *not*
implemented is the loop that turns it into a demonstrable advantage — see the
Agent Proof Loop pillar. Until that exists, "these things differentiate us" is a
reasoned position from a bounded review, not a measured result.

---

## The four questions this roadmap must answer

**1. Is the core direction correct?**
**Yes.** The bet — source-owned, coding-agent-native, deterministic contracts,
proof over self-report — is the thing competitors are *not* building, and the
market has independently validated the adjacent pieces (MCP, scaffolding,
agent-readable metadata) as necessary. Nothing in the audit argues for a
different foundation.

**2. Are we merely waiting for implementation?**
**No**, and this is the most important answer. Four pillars below are not "later
milestones of the current plan" — they were structurally absent or
under-prioritized, and two of them (Customer Data Foundation, Package Extension
Surface) are *hard dependencies* of things already on the roadmap. Marketing
attribution without a customer data foundation would be built on sand.

**3. Which pillars were missing versus merely under-prioritized?**

| Pillar | Verdict |
|---|---|
| Customer Data Foundation | **missing** — Data Governance existed as policy; the operations did not |
| Customer Interactions / Communications | **missing** — no email, calendar, call or conversation model at all |
| Package Extension Surface | **under-prioritized** — the gaps were *documented* (`ADMIN_EXTENSIONS_UNSUPPORTED`, no route contribution) but never a track |
| Package Distribution & Lifecycle | **missing** — "marketplace" appeared in prose with no install, version or trust story |
| Project Bootstrap / Installability | **missing** — and it is the first conversion blocker; found by the GTM track, not by architecture review |
| Agent Proof Loop | **under-prioritized** — DX5/DX6/DX9/DX10/AX3 existed as scattered items; none was framed as the moat |
| DX2 | **partly delivered, and mis-tracked** — the mirror state was fixed on main while the roadmap still described it as unstarted parallel work |

**4. What must be proven rather than claimed?**
Autonomous build quality. Every differentiator above is *architecturally* true
today and none of it is *measured*. Until the Agent Proof Loop exists — scenario
proof and implementation evidence, not a demo — the correct statement is a
positioning hypothesis, not a result. **No autonomous-build superiority claim
before that loop exists.**

**No fundamental architecture rewrite is required.** Every pillar below is
additive.

---

## Pillars: elevated and added

### Project Bootstrap / Installability — **new pillar, and the first conversion blocker**

**Found by the GTM/discovery track, not by architecture review**, which is why
it is worth stating plainly: retrieval now reaches the repository — the skills
install path works across harnesses, and the discovery surfaces exist — and a
user *still cannot get a running project in one command*. Distribution outran
installability.

Goal:

```text
one command  →  a runnable local project
             →  deterministic source ownership
             →  crm project doctor green
             →  a clear next workflow
```

**Package Scaffold is not Project Scaffold.** `crm package scaffold` creates a
conforming *domain inside an existing project*; it does nothing for somebody who
has no project yet. Those are different jobs and the roadmap previously had only
the first.

A future brand-facing entry point may be `create-accordo`. **Nothing is
implemented or renamed here** — the milestone is recorded, not started.

**Ordering rule:** distribution and marketplace work must not outrun this. A
package ecosystem that a new user cannot install into a project is an ecosystem
for people who already have one.

### Customer Data Foundation — **new pillar, hard dependency**

A CRM that cannot import, deduplicate or resolve identity is a demo. This is
absent today, and it **gates advanced attribution and closed-loop marketing
claims**: attribution over unresolved identities is arithmetic on noise.

Import/export · sync and connectors · identity resolution · dedupe and merge ·
unified customer profile · activity timeline · data quality and remediation ·
bulk operations · saved views and global search · consent and suppression
linkage · warehouse and storage boundaries.

**Dependency rule, stated narrowly on purpose.** The Data Foundation is a hard
prerequisite for the things that need a **resolved identity**, not for every
downstream feature:

| Needs the Data Foundation first | Does not |
|---|---|
| a unified customer profile | sending a campaign to a declared audience |
| dedupe-sensitive analytics and counts | a single-channel experiment on a known list |
| cross-channel attribution | recording an interaction against a known record |
| any closed-loop claim requiring identity resolution | landing pages, forms, content, journeys on explicit records |

So MK0–MK4 can proceed, and parts of MK5/MK6 can too. What must wait is the
*claim* that a result is attributed across channels or deduplicated — that is
arithmetic on unresolved identities until this pillar exists.

### Customer Interactions / Communications — **new pillar**

Email · calendar · conversations and messages · calls and meetings · forms and
inbound events · communication timeline · channel and provider evidence.

**The separation that matters:** the *interaction model and its evidence* is a
different thing from *real send and provider execution*. The model can ship,
be characterized and be useful while sending is still a provider contract
nobody has implemented. Building them as one thing is how a CRM accidentally
becomes a mail server.

**Runs in parallel with the Data Foundation**, not behind it. Interactions
feed the timeline, Marketing, Service and Sales context, and the two pillars
sharpen each other: the Foundation resolves *who*, Interactions record *what
happened*. Only the identity-dependent half of Interactions — stitching one
person's activity across channels — actually waits.

**Not promised:** contact-centre breadth. Not now, and not before the
interaction foundation exists.

### Package Extension Surface — **elevated**

The known gaps, already named in the code: **`ADMIN_EXTENSIONS_UNSUPPORTED`**
and **no package HTTP-route contribution**. `GENERIC_SCHEMA_CONTRIBUTION_IS_NESTED_ONLY`
joins them (a package publishes schema metadata only under `domains.<name>`).

Future platform milestone: Admin page and record-section contribution · a
generic server/API extension for when actions are insufficient · navigation and
layout contribution · schema and UI metadata contribution · trust, version and
security boundaries.

**Two rules, both learned the hard way.** Every generic seam requires **two real
consumers** before it is built — one imagined case is not evidence. And **UI
extension is a separate seam from HTTP route extension**: they have different
trust boundaries, and collapsing them produces a seam that is wrong for both.

The Lead Intelligence extraction is the evidence that the route seam is not
universally required: its actions and records are served by generic routes, so
it needed no route contribution at all. Commercial and Signature each own a
hand-written route and are the two real consumers that would justify the seam.

### Package Distribution & Lifecycle — **new pillar, gates "ecosystem"**

Before any marketplace or ecosystem claim: trusted-source install · version and
lock resolution · compatibility · an upgrade plan · permissions and trust ·
a provenance and signing decision · disable/remove versus uninstall ·
**preserving customer source ownership** · and only then, optionally, a registry.

Nothing here is implemented. "Marketplace" must not appear in positioning until
it is.

### DX2 — reconciliation, not a greenfield build

**Status corrected against the repository, because the assumption was wrong.**
This work was described as sitting on a parallel branch, unmerged and unreviewed
on main. It is **on main**: commits `6a8aa15` and `4d5b865` arrived through
PRs #36 and #37, and both are ancestors of `main`.

What that work delivered, measured on the current tree rather than reported:

- `.claude/skills/` and `.agents/skills/` each carry **12** skills, with **none**
  on one side only;
- `crm project doctor` reports `skills.mirror-coverage` and
  `skills.mirror-drift` **passing**, and the whole report `passed` — it was
  `warning` before;
- Claude, Codex and Gemini discovery/distribution surfaces exist, and the
  `npx skills add` path was verified.

**What DX2 still is.** The mirrors agree today because somebody made them agree.
The mechanism is missing, and these are the open questions:

| Question | State |
|---|---|
| Is there a **canonical semantic source** the mirrors derive from? | no — two hand-maintained copies |
| Is there a **deterministic sync/check** command? | no — Project Doctor detects and, by design, never writes |
| Is there **CI drift prevention**? | only in the sense that doctor would report it if run |
| Is there **adapter generation** per harness? | no |

So DX2 is **reconciliation**: inspect what landed, decide what becomes canonical,
and build the mechanism — not start from nothing. The Legacy Alignment Matrix
keeps the Skill-mirror row at `partial` for exactly this reason: *the state is
clean, the mechanism is not*, and a green `ls` is not an aligned capability.

### Agent Proof Loop — **elevated to a visible moat track**

DX2 Skill sync · DX5 Project Verify · DX6 Scenario Runner · DX9 Context Pack ·
DX10 Implementation Evidence · AX3 objective-driven benchmark.

```text
goal → plan → build → verify → scenario proof → implementation evidence
```

This is the track that converts an architectural argument into a measurement.
Until it closes, "agents build more reliably here" is a hypothesis with good
reasons behind it — which is exactly how it must be stated.

---

## Parallel tracks

Dependencies, not an arbitrary serial order. Work in parallel wherever the
dependencies permit.

**A — Agent-native moat**
```text
Lead Intelligence extraction → DX2 reconciliation → DX5 → DX6 → DX9 → DX10 → AX3
```
DX5 and DX6 are independent of each other. DX10 needs DX5's notion of
"verified". AX3 needs DX6 and DX10 to have anything to measure. **DX2 is
"reconciliation" rather than "build"** — see the note below; part of it already
landed by hand.

**B — Customer & Revenue OS**
```text
M16 Renewal/Expansion  (independent — explicit Contract/Subscription evidence)
Customer Data Foundation  ┐
Customer Interactions      ┘ in parallel; they sharpen each other
        → Analytics and Marketing, per the hard dependencies below
```
**M16 proceeds independently.** It rests on explicit Contract and Subscription
evidence, which shipped, and needs neither the Data Foundation nor Interactions.

**Customer Data Foundation and Interactions run in parallel.** The Foundation
resolves *who*; Interactions record *what happened*. Only the identity-dependent
half of each waits for the other.

**What genuinely gates what:** dedupe-sensitive analytics, unified profiles and
cross-channel attribution need the Data Foundation. Marketing MK0–MK4 and
single-channel, known-list work do not.

**C — Production & Ecosystem**
```text
Project Bootstrap / Installability   ← first: nothing downstream matters if
                                        a user cannot get a running project
        → Extension Surface + Integration Runtime + Jobs/Outbox
          (independent of each other, as dependencies allow)
        → Production Spine → Cloud → Package Distribution / Lifecycle
```
**Project Bootstrap comes first**, for the reason in its pillar: discovery
already reaches the repository and a user still cannot get to a running project
in one command. **Production Spine gates Cloud** — the existing invariant,
unchanged. Package Distribution needs the Extension Surface's trust boundaries
first.

Preserved from the existing roadmap and **not** renumbered: M16 Renewal/Expansion,
Analytics Studio, the Marketing MK track, Data Governance, Integration Runtime,
Jobs/Outbox, Production Spine, Cloud, Design-to-CRM, DX2/DX5/DX6/DX9/DX10/AX3.

---

## Strategic non-goals

Things not to chase, each with the reason:

| Non-goal | Why |
|---|---|
| Full Salesforce low-code parity | a different product for a different buyer; parity is a treadmill we would always be behind on |
| A visual builder for every rule | the deterministic, reviewable, source-owned rule *is* the product |
| A universal workflow DSL | ADR-020 already refused this — a format expressive enough to describe execution invites a runtime, and the first runtime that reads a plan is one edit from applying it |
| One MCP tool per capability | tool overload is a named agent failure mode; the tool surface is a curated contract |
| A full billing / accounting core | invoicing, payment, tax, revenue recognition are their own products |
| Contact-centre breadth before the interaction foundation | breadth before a model is how a CRM becomes a worse mail server |
| A marketplace before lifecycle and trust | distributing code without install, version and provenance is a liability, not an ecosystem |
| Distribution before installability | an ecosystem a new user cannot install into a project is an ecosystem for people who already have one |

**The wedge, in six words:** source-owned · coding-agent-native · goal-first ·
deterministic · package-extensible · evidence-driven.

---

## What may and may not be said

**Allowed, marked as a hypothesis:**

> Traditional customer platforms optimize for humans configuring a finished
> platform. Accordo is being designed so coding agents can safely construct and
> evolve the customer/revenue system itself, with source ownership and
> machine-checkable evidence.

This stays a **positioning hypothesis until validated with users and benchmarks**
— which is what the Agent Proof Loop is for.

**Not allowed, without separate proof:** functional parity with, or superiority
over, Salesforce, HubSpot, Twenty or Attio · market-share or adoption claims ·
"best framework for coding agents" · zero hallucinations · fully autonomous CRM
generation · benchmark superiority · production or Cloud readiness ·
marketplace availability.
