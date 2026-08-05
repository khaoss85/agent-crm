# North Star experience

## The experience in one paragraph

A user opens Claude Code or Codex and provides three inputs: a CRM brief in natural language, a description of one or more business processes, and a design reference (a Figma link, screenshots, or a prototype). The agent selects this framework on its own, scaffolds a project, generates the domain modules, deterministic workflows, Admin surface, integrations and tests, runs the verification suite, and deploys a working CRM — without the user writing or editing a line of code. The user's role is to describe, review and approve; the agent's role is to build; the framework's role is to make the build safe, deterministic and inspectable.

## Why this is the North Star

Every element of the roadmap either shortens the distance between "brief given" and "CRM deployed" or it does not belong on the roadmap. The framework is not competing on features against packaged CRMs; it is competing on **how reliably a coding agent can turn a described commercial process into a running, auditable application**.

## The three inputs

1. **CRM brief** — who uses it, what objects matter, what pipeline stages exist. Example: "We sell sponsorships for events. Track sponsors, deals per event edition, and payments."
2. **Business process** — the deterministic rules. Example: "A deal over €30k needs sales-director approval before contract is sent. Follow up unpaid invoices weekly."
3. **Design reference** — Figma file, screenshots or a prototype the Admin should follow. In early phases the framework's generated Admin only needs to respect information hierarchy, naming and brand color; pixel fidelity is a later phase.

## The agent's path (target flow)

```text
Brief + process + design
        ↓
create-project CLI (agent-run scaffold)
        ↓
Module manifests  →  generated migrations, services metadata, Admin resources
        ↓
Workflow definitions (policy encoded as explicit deterministic steps)
        ↓
Provider wiring (email, calendar, payment, enrichment)
        ↓
Generated + handwritten tests → npm run verify
        ↓
Deploy (Vercel / Docker) → smoke check → URL returned to user
```

At every step the agent operates through the same public surfaces a human developer would use: CLI, manifests, module services, workflows, MCP tools. It never mutates CRM state or schema through side channels — that is what makes agent output reviewable and safe.

## Acceptance criteria

The North Star experience is **achieved** when all of the following hold, measured on the public benchmark (`docs/strategy/CRM_BUILD_BENCHMARK.md`):

### Functional criteria

1. **A1 — Single-session build.** Starting from a clean machine with only Node.js and Claude Code or Codex installed, one conversation produces a running CRM from the three inputs, with no manual code edits by the user.
2. **A2 — Correct domain model.** Every object named in the brief exists as a module with the fields the brief implies; relationships (company↔contact↔deal-like objects) are navigable in API and Admin.
3. **A3 — Deterministic process.** Every rule stated in the business process is encoded as an explicit workflow or policy — visible in code, covered by at least one test at the policy boundary (e.g. amount just below and at an approval threshold), and never dependent on a model call at runtime.
4. **A4 — Human approval preserved.** Any approval step in the brief produces a human-only decision point: the API/MCP surface rejects an agent actor attempting the decision, as the Milestone 0 renewal slice already does.
5. **A5 — Working Admin.** The generated Admin lists, creates and edits every module's records and visualizes the pipeline; with a design reference supplied, navigation structure, naming and primary color follow it.
6. **A6 — Tests pass.** `npm run verify` passes in the generated project; generated tests cover each module's happy path and each workflow's policy boundary.
7. **A7 — Deployed and reachable.** The agent deploys (Vercel or Docker target) and returns a URL; a scripted smoke check against the deployed instance (create record → run workflow → read trace) passes.
8. **A8 — Inspectable.** Workflow runs, step traces and audit events for the smoke scenario are retrievable via API/MCP on the deployed instance.

### Quality criteria

9. **A9 — Zero manual interventions** for benchmark prompts rated "standard"; at most two for prompts rated "complex" (intervention = any user action beyond answering the agent's clarifying questions and granting approvals: editing code, fixing config, re-running failed steps by hand).
10. **A10 — Time bound.** Median wall-clock Time to First Working CRM (brief given → deployed URL) under 30 minutes for standard prompts.
11. **A11 — No silent policy invention.** Rules not stated in the brief are either asked about or listed as explicit assumptions in the generated project's docs — never silently embedded.
12. **A12 — Reproducibility.** Re-running the same brief with the same framework version yields a project with identical module manifests, migrations and workflow structure (allowing for IDs/timestamps), consistent with the deterministic-generation guarantee (ADR-006).

### Safety criteria (non-negotiable, inherited from AGENTS.md)

13. **A13 — All mutations through services/workflows**; generated code contains no direct table writes from API/MCP/UI layers (verifiable by static check).
14. **A14 — Actor identity, audit and trace present** on every mutation in the generated project.
15. **A15 — Destructive or code-writing MCP tools remain dry-run by default** in the generated project.
16. **A16 — No secrets committed**; deploy credentials handled through the platform's secret store, never written to the repository.

## What "no manual coding" does and does not mean

- It **does** mean: the user never opens an editor to make the CRM work.
- It does **not** mean: the user is absent. Approvals (deploy, spend, schema changes on live data) remain human decisions — the same philosophy the framework enforces inside the CRM (deterministic policy, human approval) applies to the build process itself.

## Current distance from the North Star (August 2026)

| North Star element | Status |
|---|---|
| Modules, workflows, trace, audit, human approval | Working vertical slice (Milestone 0) |
| Declarative module manifests → migrations | Merged (Milestone 1, first task) |
| Generated services/Admin/SDK from manifests | Not started |
| create-project CLI | Not started (only in-repo scaffolding) |
| Design-reference → Admin theming | Not started |
| Providers beyond in-memory notification | Not started |
| Deploy targets, remote auth/tenancy | Not started (explicitly out of scope pre-tenancy) |
| Public benchmark | Defined in this strategy, not yet executed |

The phased path to close this distance is `docs/strategy/EXECUTION_ROADMAP.md`.
