# Master plan

The canonical entry point to the strategy. Read this first; follow the links for depth. For implementation work, `ARCHITECTURE.md` and `DECISIONS.md` remain the technical authorities.

## 1. Vision (one sentence)

> **Describe your sales process to your coding agent; own the CRM it builds.**

The open-source, agent-native CRM framework: Claude Code and Codex use it to generate bespoke CRM applications — deterministic workflows, human approvals, audit and trace built in — as code the customer owns.

## 2. Current status (August 2026)

- Milestone 0 (vertical slice) complete: Company/Contact/Opportunity/Approval modules, renewal-approval workflow, API, Admin, CLI, MCP, trace, audit, 9 tests.
- Milestone 1 first task merged (PR #2): declarative module manifests with validation and deterministic SQLite migration generation; 23 tests green.
- Working title `agent-crm`; **no public name chosen**. Repository license is currently **MIT**; final pre-launch license confirmation is a pending human decision.
- Strategy defined in the nine documents indexed below; benchmark designed but not yet executed.

## 3. Medusa-to-CRM mapping (short form)

| Medusa (commerce) | This framework (CRM) |
|---|---|
| Commerce modules | CRM domain modules |
| Workflows SDK (durable, compensating) | Deterministic workflows + approval policy |
| Providers/plugins (npm) | Email/calendar/enrichment providers |
| create-medusa-app | create-project CLI (Phase 5) |
| Recipes docs | CI-tested recipes |
| Agent skills repo + docs MCP + llms.txt | Same trio, free from day one |
| Cloud (monetization, core stays MIT) | Possible later operations layer — undecided |

Full analysis and what *not* to copy: `MEDUSA_PLAYBOOK.md`.

## 4. North Star experience

Brief + business process + design reference → the agent scaffolds, generates modules/workflows/Admin/tests, verifies and deploys a working CRM with no manual coding; humans describe, review and approve. 16 acceptance criteria (functional, quality, safety) in `NORTH_STAR_EXPERIENCE.md`.

## 5. Product principles

1. CRM state is deterministic; AI composes and recommends, never silently decides (ARCHITECTURE.md core rule).
2. All mutations pass through module services/workflows with validation, actor identity, audit, trace.
3. Human approval is deterministic policy; agents cannot impersonate the human decision.
4. Code generation is dry-run by default; writes are explicit; output is byte-stable for the same input.
5. Generated code is readable, owned by the customer, and free of hidden conventions.
6. The framework is what agents use to *author* a CRM — distinct from platforms (Twenty and similar) that agents can *extend* but that keep running the application themselves.

## 6. Roadmap phases (summary)

0 Foundation → 1 Brand/license → 2 CRM core (Activity/Task/pipelines) → 3 Manifest-driven generation → 4 Admin+SDK generation → 5 create-CLI → 6 Production spine (Postgres/auth/tenancy) → 7 Providers/plugins → 8 Agent surface (Skills, Docs MCP, Project MCP) → 9 Deploy/observe → 10 Three starters → 11 Distribution → 12 Public launch → 13 Flywheel. Per-phase outcomes, dependencies, acceptance criteria and human-approval points: `EXECUTION_ROADMAP.md`.

## 7. Discovery model (three layers, never conflated)

- **Global recommendation** — a model suggesting us unprompted. Earned via prevalence and task-time retrieval; **cannot be guaranteed by any mechanism**; measured monthly as Unaided Recommendation Rate.
- **Marketplace/plugin discovery** — Claude Code plugins/skills, Codex plugins, MCP Registry, Anthropic connectors directory, OpenAI plugin directory, Vercel templates, npm, GitHub. We control submissions; platforms control acceptance.
- **Execution after selection** — skills, MCP, CLI, docs inside a project. Fully ours; where the product wins.

Channel-by-channel plan: `AGENT_DISCOVERY.md`.

## 8. Organic-growth flywheel

Ship capability → prove it (benchmark/starter) → document as CI-tested recipe → publish where developers and agents look → measure → feed gaps to roadmap. Hard quality gates (runs-or-dies fixtures, transcript-grounded narratives, human editor of record, published failure counts) prevent low-value AI content. Details: `ORGANIC_GROWTH.md`.

## 9. Core metrics

| Metric | One-line definition |
|---|---|
| Successful Agent Build Rate (SABR) | benchmark prompts fully passing ÷ attempted, per framework×agent×model version |
| Unaided Recommendation Rate (URR) | clean sessions recommending us unaided ÷ total (protocol public; observed, never promised) |
| Time to First Working CRM (TTFW) | median brief → deployed-smoke-green wall clock |
| Plugin/MCP adoption | installs, registry pulls, Docs MCP clients |
| Generated projects / successful deployments | opt-in telemetry (policy pending human approval) |
| Community integrations | third-party providers/modules published |

Definitions and measurement protocols: `EXECUTION_ROADMAP.md` (metrics) and `CRM_BUILD_BENCHMARK.md` (protocols).

## 10. Pending human decisions

1. **Public name** — candidates only, none chosen (`BRAND_REQUIREMENTS.md`); registrar + trademark verification required.
2. **Final license confirmation** before public launch (MIT is the current repository license; keep-or-change is an explicit ADR-gated decision).
3. **Telemetry policy** (opt-in metrics) before any collection ships.
4. **All external submissions** (marketplaces, directories, template galleries) and account creations.
5. **All public launch claims and timing**; every published number must trace to the benchmark protocol.

## 11. Reading order

1. `MASTER_PLAN.md` — this file.
2. `CATEGORY.md` — category, positioning, ICP, JTBD, promise.
3. `NORTH_STAR_EXPERIENCE.md` — the target experience and its acceptance criteria.
4. `COMPETITOR_MAP.md` — Twenty, Frappe, Relaticle, Comp AI, legacy, templates, DIY; the gap and its caveats.
5. `MEDUSA_PLAYBOOK.md` — the adoption playbook and its limits.
6. `EXECUTION_ROADMAP.md` — phases, acceptance criteria, metrics.
7. `CRM_BUILD_BENCHMARK.md` — the proof instrument.
8. `AGENT_DISCOVERY.md` — distribution channels and sequencing.
9. `ORGANIC_GROWTH.md` — content/community engine and quality gates.
10. `BRAND_REQUIREMENTS.md` — naming criteria and candidate shortlist.

Agents: read this file before product, positioning, roadmap or public-distribution decisions. For code, follow `AGENTS.md`, `ARCHITECTURE.md` and `DECISIONS.md`.
