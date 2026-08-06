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

The design rule that matters: **prefer an existing package; create a custom package when none fits; never patch the kernel.** A kernel change is a missing generic runtime capability and belongs in an ADR discussion, not in a solution.

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

Use **evidence, not intuition**. A recommendation without a linked measurement is an opinion, and the agent should say so.

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

**Planned, and not implemented — do not call it:**

```bash
npm run crm -- app inspect --json          # PLANNED (AX1)
```

Its intended output: the installed package graph with versions, the resolved capability graph, missing or unsatisfiable dependencies, configured providers and their status, the schema contracts, and the current Quality-Gate and JTBD status — one deterministic document an agent reads instead of assembling five sources by hand.

Until AX1 exists, an agent assembles that picture from the surfaces above. That is slower and more error-prone, which is precisely the argument for AX1.

---

## 6. Human approval boundaries

The agent may **analyze, propose, generate, prepare, test, preview and recommend** without asking.

A human must approve: publishing to production · sending any external communication · activating a journey · changing a live audience · using sensitive data · launching ads · creating or increasing spend · installing or configuring a provider · changing secrets · auto-applying an experiment winner · any irreversible or destructive action.

Real approval **roles** require the Production Spine (auth, tenancy, RBAC). Until it exists, actor headers are not authentication and every boundary here is a local-development boundary. No document in this repository may present it as more.

---

## 7. The AX track

Cross-cutting; it does not renumber or delay the Delivery/Service milestones or the Marketing MK track.

```text
AX0  Goal-to-Solution strategy + Skill              ← this PR
AX1  Application capability inspection
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

**Nothing in AX1–AX5 is implemented.** AX0 ships a strategy and a Skill; the Skill is useful today precisely because it tells the agent to report missing capabilities honestly rather than pretend.

---

## 8. Related

`NORTH_STAR_EXPERIENCE.md` · `AGENT_DISCOVERY.md` · `MASTER_PLAN.md` · `EXECUTION_ROADMAP.md` · `MARKETING_GROWTH_OPERATIONS.md` · `ANALYTICS_STUDIO.md` · `AGENT_CRM_CLOUD.md` · `../PACKAGE_AUTHORING.md` · `../benchmarks/CRM_JTBD_MATRIX.md` · the Skill at `.claude/skills/solve-business-goal/SKILL.md` (mirrored in `.agents/skills/`) · the worked example in `OBJECTIVE_DRIVEN_FUNNEL_EXAMPLE.md`.
