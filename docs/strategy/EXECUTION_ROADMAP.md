# Execution roadmap

Phased path from the current vertical slice to the public, agent-recommended CRM framework. Every phase lists: outcome, deliverables, dependencies, acceptance criteria, what Claude Code/Codex can execute autonomously, and where human approval is required.

A recurring rule: **coding agents execute, humans approve identity, money, live data and public actions.** This mirrors the product's own philosophy (deterministic policy, human approval) applied to building the product itself.

## Phase overview

| # | Phase | Theme |
|---|---|---|
| 0 | Foundation hardening | finish what exists |
| 1 | Positioning and brand | name, license, story |
| 2 | Complete CRM core | the objects every CRM needs |
| 3 | Declarative generation | manifest → module/service/tests |
| 4 | Admin and SDK generation | manifest → UI and typed client |
| 5 | create-project CLI | zero-to-project in one command |
| 6 | Production spine | PostgreSQL, auth, tenancy, permissions |
| 7 | Providers and plugins | integration surface |
| 8 | Agent surface | Skills, Docs MCP, Project MCP |
| 9 | Deploy and operate | deploy, logs, trace in production |
| 10 | Starters | three complete CRMs |
| 11 | Distribution | directories, templates, npm |
| 12 | Public launch | benchmark-backed launch |
| 13 | Flywheel | content, community, cadence |

Phases 2–4 and 8 can overlap; 6 gates 9; 10 gates 11–12.

**Agent CRM Cloud track** (specified in `AGENT_CRM_CLOUD.md`; design only, unbuilt): a named product track layered on these phases rather than a renumbering of them —

```text
Production Spine (Phase 6)
    → Agent CRM Cloud Control Plane
    → Managed Runtime
    → Agent Operations CLI/MCP
    → Plugin Operations
    → Public benchmark deployment
```

The invariant: **Production Spine gates public managed deployment** — no Cloud phase may ship a public managed CRM before Phase 6 is complete. Phase 9's deploy recipes and Phase 7's plugin packages are the self-hosted foundations Cloud builds on; completed milestones are not reordered.

---

## Phase 0 — Foundation hardening

- **Outcome:** the existing slice is trustworthy enough to build generation on top of.
- **Deliverables:** PR #2 (module manifests) merged; CI matrix (Node LTS versions); coverage of core services; `npm run verify` kept green as the single gate.
- **Dependencies:** none.
- **Acceptance:** clean checkout → verify + smoke green; benchmark prompt P06 (the Milestone 0 slice) passes end-to-end locally.
- **Agent executes:** everything.
- **Human approves:** merging PRs.

## Phase 1 — Positioning and brand

- **Outcome:** a distinctive name, a defensible category story, a license decision.
- **Deliverables:** name chosen per `BRAND_REQUIREMENTS.md` (registrations: GitHub org, npm scope, domain); `CATEGORY.md` positioning reflected in README/site copy; explicit OSS license decision recorded as an ADR (MIT today — keep or change deliberately before launch, cf. competitors' AGPL choices); minimal public site.
- **Dependencies:** none (parallel with 0).
- **Acceptance:** name passes collision checks; positioning one-liner used consistently in README, package description, site.
- **Agent executes:** collision research, copy drafts, site scaffold.
- **Human approves:** the name itself, license choice, trademark/domain purchases. **These cannot be delegated.**

## Phase 2 — Complete CRM core

- **Outcome:** the primitives every CRM brief assumes exist.
- **Deliverables:** Activity, Task and Note modules; Pipeline as first-class configurable stages (per module, not hardcoded); saved views/filter model for list surfaces; follow-up workflow (TASKS.md item 2); import path (CSV → services with dedupe policy hooks).
- **Dependencies:** Phase 0.
- **Acceptance:** benchmark prompts P01, P05, P13, P17 pass locally without hand-written plumbing beyond brief-specific policy.
- **Agent executes:** all module/workflow implementation via ExecPlans.
- **Human approves:** PR merges; any change to the core schema conventions (new ADR).

## Phase 3 — Declarative module generation

- **Outcome:** the manifest (Milestone 1) becomes the single source: from one manifest the framework generates migration, service scaffold with validation, module registration, and boundary tests — deterministically.
- **Deliverables:** manifest v2 (relations both directions, enum reuse, computed/derived field declarations kept out deliberately — documented); `module:create --manifest` generating service + tests wired to registry; migrations loaded from generated files into the versioned migration list; regeneration diffing (regenerate → clean diff, never clobber hand-written service logic).
- **Dependencies:** Phase 0 (PR #2 merged).
- **Acceptance:** P15/P19 (partner-style prompts) produce a working module with **zero** hand-written infrastructure; regeneration of an unchanged manifest is a no-op diff.
- **Agent executes:** everything.
- **Human approves:** manifest format changes (ADR per version bump).

## Phase 4 — Admin and SDK generation

- **Outcome:** manifests drive the UI and the typed client.
- **Deliverables:** generated Admin resources (list, detail, form, kanban for staged modules) from module metadata; theming tokens (logo, colors, density) — the hook for design references; generated typed SDK (JS + types) per project; design-reference ingestion v1: map a Figma/screenshot structure to navigation + naming + primary color.
- **Dependencies:** Phase 3.
- **Acceptance:** benchmark design inputs D1–D3 score "design adherence v1" on P01/P08/P15; SDK covers every generated module without hand edits.
- **Agent executes:** generation code, theming, SDK.
- **Human approves:** Admin UX baseline (one explicit review of the generated UI's information design).

## Phase 5 — create-project CLI

- **Outcome:** `npm create <name>@latest` scaffolds a fresh CRM project outside this repository: core packages as dependencies, project-local modules/workflows, agents preconfigured.
- **Deliverables:** create-CLI (interactive + flags + `--from-brief` file mode); project template with AGENTS.md/CLAUDE.md, skills, `.mcp.json`/`config.toml` prewired; framework packages published to npm with semver.
- **Dependencies:** Phases 3–4 (so the scaffold is manifest-first); Phase 1 (name — the create command carries the brand).
- **Acceptance:** clean machine → create command → verify green → demo runs, under 5 minutes; benchmark harness switches from in-repo to created projects.
- **Agent executes:** CLI implementation, template, publish dry-runs.
- **Human approves:** first npm publish (org/scope ownership, 2FA), release process.

## Phase 6 — Production spine: PostgreSQL, auth, tenancy, permissions

- **Outcome:** a generated CRM can be exposed to real users.
- **Deliverables:** PostgreSQL adapter behind the existing database contract (ADR-001's promised swap); authn (session + API keys) and actor mapping to the existing identity model; tenant boundary; role-based permissions enforced in services (not routes); remote-safe MCP (Streamable HTTP with authorization — TASKS.md item 6).
- **Dependencies:** Phase 2 (core objects stable). Gates Phase 9 — no public deploys before this.
- **Acceptance:** multi-tenant test suite; permission boundary tests; the Milestone 0 safety note in README replaced by a documented production posture; security review pass on the auth/tenancy PRs.
- **Agent executes:** implementation and tests.
- **Human approves:** security model ADR; any default that widens exposure; the review sign-off itself.

## Phase 7 — Provider and plugin system

- **Outcome:** integrations are packages, not patches.
- **Deliverables:** provider contracts for email, calendar, payments-lite (references), enrichment; two real adapters shipped (one email — e.g. SMTP/API-based, one calendar); plugin manifest + discovery (install a module/provider package and it registers); compensation-aware side-effect conventions documented.
- **Dependencies:** Phases 3, 5.
- **Acceptance:** P05/P09/P12 pass using real providers in a sandbox; a third-party can build a provider from docs alone (validated by building one in a clean repo following only the docs).
- **Agent executes:** contracts, adapters, docs.
- **Human approves:** external service accounts/credentials; any adapter that sends real messages.

## Phase 8 — Agent surface: Skills, Docs MCP, Project MCP

- **Outcome:** an agent lands in a project (or considers the framework) and knows exactly what to do.
- **Deliverables:** **Skills**: build-module, build-workflow, build-integration, debug-run, upgrade-framework — maintained, versioned, mirrored for Claude Code and Codex-compatible layouts. **Docs MCP**: a public remote MCP serving framework documentation, manifest schema and recipes (the "docs server" agents can query before/while building). **Project MCP**: the in-project server (exists) extended with manifest tools (validate/generate — dry-run by default per ADR-004) and benchmark smoke tools. llms.txt + agent-readable doc structure on the site.
- **Dependencies:** Phase 5 (skills target created projects).
- **Acceptance:** benchmark run where the agent uses skills+MCP shows measurably fewer interventions than a run with docs alone (tracked in the harness); Docs MCP answers the top 20 how-to questions correctly (scripted eval).
- **Agent executes:** all of it.
- **Human approves:** publishing the remote Docs MCP endpoint (infrastructure, cost).

## Phase 9 — Deploy, logs and trace

- **Outcome:** the agent can take a project live and observe it.
- **Deliverables:** deploy recipes + CLI commands for Vercel and Docker/VPS; environment/secret handling conventions (never in repo); production log access and trace/audit querying via CLI + MCP against deployed instances; scripted post-deploy smoke check (the benchmark's G5/G6 as a product feature).
- **Dependencies:** Phase 6. This phase's self-hosted deploy recipes are also the foundation of the **Agent CRM Cloud** managed runtime (`AGENT_CRM_CLOUD.md`); Cloud's Control Plane/managed-runtime work slots after Phase 6 alongside this phase.
- **Acceptance:** benchmark deployment gates pass on both targets; docs let an agent deploy without human keystrokes beyond credentials/approval.
- **Agent executes:** recipes, automation, smoke tooling.
- **Human approves:** every real deploy in benchmarks/demos; hosting spend.

## Phase 10 — Three complete starter CRMs

- **Outcome:** proof, templates and SEO in one asset.
- **Deliverables:** three starters built **with** the framework by agents, reviewed by humans: (1) B2B sales + approval flows; (2) agency/services with proposals→projects; (3) partner/channel with tiers and revenue share. Each: repo, live demo, tutorial ("build this from a brief"), benchmark transcript showing it was agent-built.
- **Dependencies:** Phases 4, 5, 9 (6 for live demos).
- **Acceptance:** each starter deploys from README in one command; each has a written + recorded agent-build walkthrough.
- **Agent executes:** the builds themselves (that's the point), tutorials.
- **Human approves:** final review of each starter as reference-quality code.

## Phase 11 — Distribution

- **Outcome:** present in every channel where agents and developers look (see `AGENT_DISCOVERY.md` for mechanics).
- **Deliverables:** npm packages with rich descriptions/keywords; GitHub topics, social preview, README optimized for both humans and model consumption; Claude Code plugin (skills + MCP bundled) in a public marketplace repo; MCP server listed in the MCP Registry and submitted to Anthropic/OpenAI directories where submission is open; Vercel template submissions for the three starters; llms.txt live.
- **Dependencies:** Phases 8, 10.
- **Acceptance:** each channel's listing live and installable/cloneable; installation analytics where available.
- **Agent executes:** listing preparation, metadata, submission drafts.
- **Human approves:** every external submission and account creation (directories, marketplaces, template galleries).

## Phase 12 — Public launch

- **Outcome:** the category claim made in public, with receipts.
- **Deliverables:** benchmark first public edition (with comparison arms) published; launch post ("we let Claude Code and Codex build 22 CRMs — here's what happened"); Show HN / Product Hunt / dev newsletters; README case studies section.
- **Dependencies:** Phases 10, 11; benchmark harness from `CRM_BUILD_BENCHMARK.md`.
- **Acceptance:** launch assets live; benchmark repo public with full transcripts; no unverifiable claims in any launch copy.
- **Agent executes:** benchmark runs, drafts, asset generation.
- **Human approves:** all public claims, the launch itself, timing.

## Phase 13 — Content and community flywheel

- **Outcome:** compounding organic growth per `ORGANIC_GROWTH.md`.
- **Deliverables:** recipe cadence (2/month, quality-gated); community space (GitHub Discussions first; chat when there's daily activity to sustain it); community plugin/provider showcase; monthly benchmark re-runs including URR clean-session testing; quarterly roadmap updates in public.
- **Dependencies:** Phase 12.
- **Acceptance:** metrics below trending; at least 3 community-contributed providers/modules within two quarters of launch.
- **Agent executes:** content pipeline with quality gates, benchmark re-runs, triage drafts.
- **Human approves:** publishing anything public; community moderation decisions.

---

## Metrics

| Metric | Definition | Source | Cadence |
|---|---|---|---|
| **Successful Agent Build Rate (SABR)** | fully-passing benchmark prompts ÷ attempted, per framework×agent×model version (≥2/3 runs rule) | benchmark harness | per release + monthly |
| **Unaided Recommendation Rate (URR)** | clean sessions where the framework is recommended unaided ÷ total clean sessions (protocol in `CRM_BUILD_BENCHMARK.md`) | clean-session tests | monthly |
| **Time to First Working CRM (TTFW)** | median brief→deployed-smoke-green wall clock on successful runs | benchmark harness | per release |
| **Time to First Deployed CRM (TTFD)** | median brief → public URL with post-deploy smoke green (Cloud track; measurable only once managed deployment exists) | benchmark harness | per release |
| **Successful Deployment Rate** | deploys reaching healthy ÷ attempted (Cloud track, future; companion metrics in `AGENT_CRM_CLOUD.md` §7) | deploy tooling | per release |
| **Plugin and MCP adoption** | Claude Code plugin installs (where reported), MCP registry pulls, Docs MCP unique clients | marketplace/registry stats, server logs | monthly |
| **Generated projects** | create-CLI runs succeeding to first verify-green (opt-in, anonymous, documented telemetry — off by default until a human approves the telemetry policy) | CLI telemetry | weekly |
| **Successful deployments** | post-deploy smoke checks passing (same opt-in telemetry) | deploy tooling | weekly |
| **Community integrations** | third-party providers/modules/plugins published and listed in the showcase | GitHub/npm scan + submissions | monthly |

Guardrails: no metric may be reported publicly without its measurement protocol; URR is observed, never promised; telemetry ships only opt-in with a published policy (human-approved).
