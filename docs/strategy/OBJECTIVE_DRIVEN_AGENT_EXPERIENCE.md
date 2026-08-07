# The objective-driven agent experience

**Status: North Star and design. The end-to-end experience is not implemented.** Parts of it work today — package and capability discovery, custom package authoring, deterministic policies, Admin generation, Quality Gates — and parts do not exist at all: there is no application-level capability inspector, no machine-readable Solution Plan runtime, no Marketing runtime, no Analytics Studio and no attribution model. This document says which is which, row by row, and never claims the whole loop runs.

It is a **cross-cutting** track (AX0–AX5), not another pillar and not a monolithic runtime. It describes how a user reaches every other pillar.

---

## 1. The promise

> The user supplies a **business goal** and its constraints. Claude Code or Codex performs solution discovery, identifies available and missing capabilities, selects or creates packages and providers, proposes a reviewable plan, builds the CRM, validates it, and returns an operational Admin experience plus measured insights.

The canonical prompt this track is designed against:

> *"Track and optimize the complete Lead → Won funnel, with particular focus on acquisition channel. Decide what to track, how to model it, what to show in the CRM, how to analyze funnel drop-offs, and what optimization campaign to propose."*

### What the user should never have to specify

Manifests · database schema · the package graph · the event model · provider contracts · dashboard implementation · attribution architecture.

Those are the agent's job. The user's job is the goal, the constraints, and the approvals.

### What the agent must always expose

Assumptions · the chosen model and policy, with versions · missing data · missing providers · limitations · approval boundaries · evidence and tests.

An agent that silently invents a data model, quietly assumes a provider exists, or reports success without evidence has failed this experience even if the code compiles.

---

## 2. Why this is not "just prompting"

Every other framework's answer to a business goal is a chat transcript and a pile of files. This repository already has the parts that make the answer *checkable*:

- a **package contract** (ADR-018 addenda 3–4) so new domains attach without patching the kernel;
- **versioned, fingerprinted policies** (ADR-015) so a decision explains itself years later;
- **module evolution** (ADR-019) so a record can gain a lifecycle after it ships;
- **Quality Gates** and a **JTBD matrix** so "done" has a definition the agent did not choose;
- **audit, events and trace** so what happened is recoverable.

The objective-driven experience is what happens when an agent is pointed at those parts with a business goal instead of a technical specification.

---

## 3. The Goal-to-Solution lifecycle

```text
GOAL → DISCOVER → ASSESS → DESIGN → PLAN → APPROVE → BUILD → VERIFY → PRESENT → OBSERVE → RECOMMEND → ITERATE
```

### GOAL

Capture, in the user's words, then restate: the desired business outcome, the **primary metric**, the scope, the constraints, and the sensitive-action boundaries. A goal without a primary metric cannot be verified later, so the agent asks for one rather than inventing it.

### DISCOVER

The agent reads, in this order: `AGENTS.md` · `docs/PROJECT_STATUS.md` · the package contract and `docs/PACKAGE_AUTHORING.md` · `crm package inspect` output for each installed package · `GET /api/schema` · the installed package and capability graph · installed providers · the current Admin and its extensions · existing data, events and metrics · `docs/QUALITY_GATES.md` and the JTBD matrix.

Reading the JTBD matrix is not optional: it is the repository's own honest statement of what is supported, and it is what stops an agent promising a capability the code does not have.

### ASSESS

Produce a **capability coverage map**: what is reused, what is missing, where data quality is thin, which providers are absent, which dependencies are hard, what needs human approval, and what could go wrong.

### DESIGN

Choose and *explain*: official packages, custom packages, provider adapters, the data model, events and touchpoints, policies, metrics, Admin views, tests, and fallback behaviour when a provider or a dataset is missing.

### The decision hierarchy — try each rung before the next

This is the rule that stops an objective-driven build from producing a
duplicate package for every goal, or a kernel patch for every gap:

```text
1. configure an existing package        a policy version, a config value, a view
2. extend through a declared seam       an action, a policy, a record on a package that owns the domain
3. add or configure a provider          when the gap is an integration, not a model
4. create a custom package              when no installed package owns the domain
5. propose a kernel capability          ONLY with generic, multi-domain evidence — and as an ADR discussion, never inside a solution
```

Rung 5 is not a step an agent takes; it is a proposal an agent writes. A kernel
change made to fit one goal is the failure this hierarchy exists to prevent.
Rung 4 is justified only when rungs 1–3 genuinely cannot carry the domain — and
the agent must say which it tried.

### PLAN

Emit a machine-readable **SolutionPlan** (§4) and a human-readable companion. Code comes after the plan, not before.

### APPROVE

The human approves **only** the sensitive boundaries: provider access, external package install, production deployment, sending/publishing/spending, consent-sensitive audience use, and irreversible or destructive actions. Everything else proceeds.

### BUILD

Claude or Codex writes **checked-in source the customer owns** — manifests, package definitions, policies, actions, Admin views, tests. Not rows in a vendor database, not an opaque runtime.

### VERIFY

Quality Gates · `crm package validate` · unit, integration and E2E tests · a clean-clone run · the browser smoke where available · JTBD acceptance for every row the solution claims to move.

### PRESENT

Show what was built, how it works, the assumptions, the limitations, the Admin URL and views, and the approvals still outstanding.

### OBSERVE · RECOMMEND · ITERATE

The post-build loop, and it is not optional — a solution that is never observed
is a guess that was never checked:

```text
observe    what the built system actually recorded
diagnose   where it underperforms, for which segment, by how much
recommend  what to change, with the evidence behind it
propose    the next version, as a reviewable change
```

**No silent operational change.** A recommendation is a proposal; applying it is
a new plan, a new approval where the boundary requires one, and a new version.

### Evidence-first output

Every answer an agent gives about a goal separates these, explicitly and in this
order, so a reader can see *why* a recommendation was made:

| Layer | Meaning |
|---|---|
| **Observed facts** | what the data actually says, with the query and its version |
| **Derived metrics** | what was computed from those facts, and how |
| **Assumptions** | what was taken as true without evidence |
| **Inferences** | what was concluded from facts plus assumptions |
| **Recommendations** | what to do, traceable to the rows above |
| **Unavailable evidence** | what could not be checked, and why |

Two standing rules inside that structure: **no attribution model is causal
truth** — each is an assumption about credit, and its version travels with every
result; and where a valid control group exists, **lift outranks attribution**,
so the agent reports it as the better answer rather than the more flattering
one.

---

## 4. The SolutionPlan contract (design only)

Design, not implementation. Nothing in this repository emits or consumes a SolutionPlan today, and **this PR does not build a universal AI planner runtime**.

```json
{
  "planVersion": 1,
  "goal": {},
  "primaryMetric": {},
  "assumptions": [],
  "installedPackages": [],
  "reusedCapabilities": [],
  "missingCapabilities": [],
  "packagesToCreate": [],
  "providersToConfigure": [],
  "dataModel": [],
  "eventsAndTracking": [],
  "policies": [],
  "adminExperience": [],
  "analytics": [],
  "tests": [],
  "approvalGates": [],
  "knownLimitations": [],
  "executionOrder": []
}
```

Rules a future implementation must honour:

1. a **stable version**, so a plan written today is readable later;
2. **deterministic ordering** — the same inputs produce byte-identical output;
3. **no executable functions**, ever: a plan is data that gets reviewed;
4. **package and capability versions**, not bare names;
5. a **plan fingerprint**, so a plan can be quoted in an approval;
6. a **human-readable companion** — the reviewable artifact is prose, not JSON;
7. **no stale-plan authorization**: an approval covers the plan that was read, and a plan is recomputed when the source changes.

---

## 5. Capability discovery — what exists and what does not

**Available today:**

```bash
npm run crm -- package inspect <path>     # per-package: identity, resources,
                                          # actions, policies, requires/provides,
                                          # function-free metadata
```

```text
GET /api/schema                            # modules, actions, pipelines,
                                           # intelligence, commercial, signature
                                           # and every registered package's block
```

Plus the checked-in composition file (`packages/domains/generated/index.js`), each package's README, `docs/PROJECT_STATUS.md` and the JTBD matrix.

**Implemented (AX1) — start here:**

```bash
npm run crm -- app inspect --json
```

One deterministic document: the installed package graph with its versions, the resolved capability graph including the edges that do **not** resolve, records with their revisions, actions with their declared transition metadata, policies and provider definitions, and an explicit machine-readable list of everything the report cannot know. Guide: `docs/APPLICATION_INSPECTION.md`.

**A correction to what this document previously said.** AX1 was described here as also carrying "the current Quality-Gate and JTBD status". It does not, and deliberately: both live in Markdown maintained by people, and parsing prose into structured claims produces *structured* output with *unstructured* reliability — which an agent then trusts. `evidence` carries the paths and the status `not_aggregated`. Machine-readable evidence is future work (AX3), named rather than quietly missing.

AX1 also does not open the configured database, so nothing it reports is a claim about a running system.

**What the agent reaches these surfaces through.** Today: a shell command, an
exit code and JSON — nothing else (`docs/AGENT_HARNESS_COMPATIBILITY.md`). The
MCP server that ships (`docs/MCP.md`) predates AX1 and AX2 and exposes a sample
domain rather than these contracts, so an agent asking *"what is this
application"* gets a better answer from `app inspect` than from any of its
tools. Mirroring the stable contracts as MCP reads is **DX13, not built**; the
exposure policy that would govern it — tiers, bounded output, and the list of
things that may never become a tool at all — is written first in
`docs/architecture/AGENT_TOOL_SURFACE.md`.

**And what the agent will find missing.** Three domains still live in
`packages/core/src/` rather than behind the package seam, so an agent can cite
their actions and record revisions but there is no package or capability to
cite. `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` records that per domain, so
the gap is a stated limitation rather than something an agent discovers by
finding nothing.

---

## 6. Human approval boundaries

The agent may **analyze, propose, generate, prepare, test, preview and recommend** without asking.

A human must approve: publishing to production · sending any external communication · activating a journey · changing a live audience · using sensitive data · launching ads · creating or increasing spend · installing an external package · installing or configuring a provider · changing secrets · auto-applying an experiment winner · **sending for signature** · **activating a commercial contract** · **starting delivery or recording acceptance** · **a destructive migration** · **a consent or legal change** · any other irreversible or destructive action.

Real approval **roles** require the Production Spine (auth, tenancy, RBAC). Until it exists, actor headers are not authentication and every boundary here is a local-development boundary. No document in this repository may present it as more.

---

## 7. The AX track

Cross-cutting; it does not renumber or delay the Delivery/Service milestones or the Marketing MK track.

```text
AX0  Goal-to-Solution strategy + Skill              implemented
AX1  Application capability inspection              implemented — crm app inspect
AX2  Machine-readable Solution Plan
AX3  Objective-driven local build benchmark
AX4  Objective-driven deploy / observe / fix through Cloud
AX5  Closed-loop optimization with Marketing + Analytics
```

| Milestone | Depends on |
|---|---|
| AX0 | nothing — a disciplined workflow usable today |
| AX1 | application-level package and capability inspection (`app inspect`) |
| AX2 | a versioned plan contract, and AX1 for its inputs |
| AX3 | package authoring (merged) and a benchmark runner |
| AX4 | the Production Spine and Agent CRM Cloud |
| AX5 | Marketing, Analytics Studio, Data Governance and Durable Automation |

**AX1 is implemented; AX2–AX5 are not.** AX0 ships a strategy and a Skill, AX1 ships the discovery surface that Skill now starts from. Both are useful today precisely because they report missing capabilities honestly rather than pretend.

---

## 8. Related

`NORTH_STAR_EXPERIENCE.md` · `AGENT_DISCOVERY.md` · `MASTER_PLAN.md` · `EXECUTION_ROADMAP.md` · `MARKETING_GROWTH_OPERATIONS.md` · `ANALYTICS_STUDIO.md` · `AGENT_CRM_CLOUD.md` · `../PACKAGE_AUTHORING.md` · `../benchmarks/CRM_JTBD_MATRIX.md` · the Skill at `.claude/skills/solve-business-goal/SKILL.md` (mirrored in `.agents/skills/`) · the worked example in `OBJECTIVE_DRIVEN_FUNNEL_EXAMPLE.md`.
