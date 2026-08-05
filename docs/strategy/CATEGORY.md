# Category and positioning

## The category we should own

**The agent-native CRM framework**: the open-source framework that coding agents (Claude Code, Codex) use to *generate* bespoke CRM applications as code the customer owns.

Not "open-source CRM" (owned by Twenty: ~54.3k GitHub stars as of August 2026, "the open alternative to Salesforce, designed for AI" — [repo](https://github.com/twentyhq/twenty)). Not "AI CRM" (an app category where agents work *inside* a CRM — Relaticle, Comp AI, Twenty 2.0's agents). The category we can own is one structural level below both: **the substrate agents build CRMs from**. In the competitive research (`COMPETITOR_MAP.md`), no direct equivalent was found in the researched set as of August 4, 2026: every project examined is either a platform you configure, an agent bolted inside an app, or a CRUD template with no CRM semantics. (A crowded adjacent field is not an empty market — the claim is scoped to what was researched, and Twenty's trajectory is the standing caveat.)

The category claim in one line: *configured CRMs are where customization goes to be tolerated; generated CRMs are where it goes to be owned.*

## Exact product positioning

> **The open-source framework coding agents use to build custom CRMs.** Describe your commercial process to Claude Code or Codex; get a working CRM as reviewable code you own — deterministic workflows, human approvals, audit and trace built in.

Position against the two defaults a buyer actually weighs:

- **vs configuring a CRM platform** (Twenty, Frappe, Odoo): they customize by metadata inside their runtime; we generate code in your repo. Their agents operate the CRM; our agents *author* it. No platform underneath, no AGPL share-alike on your product, no enterprise-gated files.
- **vs building from scratch** (Next.js + Postgres + templates): starters give CRUD and UI; every team re-derives validation, pipeline semantics, approvals, audit. We ship those as framework primitives an agent composes — with governance the DIY path never gets around to.

## What the product is

- A TypeScript/Node framework of CRM modules (companies, contacts, opportunities, activities…), deterministic workflows with trace and compensation, policy-gated human approvals, actor identity, audit — plus declarative module manifests that generate migrations and infrastructure deterministically.
- An agent surface as first-class product: repository skills, project MCP, docs MCP, AGENTS.md/CLAUDE.md conventions, dry-run-by-default code generation.
- A create-CLI that scaffolds an owned application: the customer's repo, the customer's deploy target, the customer's license terms.
- Permissively licensed (MIT today; final license is an explicit Phase 1 human decision).

## What the product is not

- **Not a CRM product.** No hosted CRM to sign up for; the output of the framework is the customer's CRM.
- **Not an autonomous salesperson.** AI recommends and composes; commercial state changes remain deterministic and auditable (ARCHITECTURE.md core rule). Runtime AI features are optional additions, never the control plane.
- **Not a low-code/no-code platform.** Manifests generate infrastructure; business logic stays explicit, reviewable code (ADR-006).
- **Not a Salesforce/HubSpot feature-parity chase.** Breadth comes from generation and the module ecosystem, not from us shipping every vertical's features.

## Differentiation from Twenty

Twenty is the strongest player and is converging on adjacent messaging ("designed for AI", MIT Apps SDK, "build your Enterprise CRM with an AI-friendly SDK" — [Twenty 2.0 launch](https://www.producthunt.com/products/twenty-crm), [SDK](https://github.com/twentyhq/twenty/tree/main/packages/twenty-sdk)). The differentiation must therefore be structural, not rhetorical:

| Axis | Twenty | This framework |
|---|---|---|
| What the agent produces | Extension apps (entities, serverless logic functions, UI widgets) deployed **into Twenty's runtime** | A standalone application in the customer's repo |
| Who owns the running system | Twenty's platform (fixed schema engine, workflow runtime, React shell) | The customer — framework as dependency, like any npm library |
| License shape | AGPL core + `@license Enterprise` files (SSO, advanced RBAC gated) + MIT SDK ([LICENSE](https://github.com/twentyhq/twenty/blob/main/LICENSE)) | Permissive core, no enterprise-gated files |
| Process semantics | Their workflow engine, their permission model | Deterministic workflows + policy + human approval you define per project, testable at the boundary |
| Deep customization path | Fork a large Nx monorepo, carry AGPL + weekly release train | Regenerate/extend your own code |
| MCP | Native MCP confirmed for Cloud workspaces (self-host parity unverified) | MCP first-class in every generated project, local or deployed |

The honest counterpoint we keep in view: Twenty's marketing will *sound* like ours. The proof that separates us is the benchmark — agents building complete CRMs from briefs, transcripts published — and the ownership test any developer can apply in one question: *"if the vendor disappears tomorrow, what are you left with?"* With Twenty: an AGPL platform to operate. With us: your own application.

## Primary ICP

**Developers and dev-agencies building CRM-shaped internal tools and client systems with coding agents.** They know Claude Code/Codex, bill for outcomes, and today choose between configuring a platform (fast start, ceiling and lock-in) and building from scratch (freedom, re-derived plumbing). Evidence this persona exists and code-first is their revealed preference: Atomic CRM's fork-to-star ratio (~758 forks / 1.2k stars as of August 2026 — [repo](https://github.com/marmelab/atomic-crm)) shows developers fork CRM code to own it; incumbents' metadata-in-a-database customization is precisely what coding agents handle worst, while code-in-git is what they handle best.

Secondary (later): SaaS teams embedding CRM capabilities; technical founders/RevOps at product companies with bespoke processes.

## Primary JTBD

> **When my business runs on a commercial process that no packaged CRM models well, I want to describe that process to my coding agent and get a CRM that encodes it exactly — as code I own, with rules that are deterministic and auditable — so I stop bending my process to a tool or paying an integrator to bend the tool to me.**

(Refines PRODUCT.md's job statement with the ownership and determinism clauses that the competitive landscape makes decisive.)

## The one-sentence public promise

> **Describe your sales process to your coding agent; own the CRM it builds.**

Supporting variant for docs/README contexts: *"The open-source framework Claude Code and Codex use to turn a business brief into a working, auditable CRM you own."* Every public claim underneath this promise must trace to the benchmark (`CRM_BUILD_BENCHMARK.md`) — the promise is only as strong as the published Successful Agent Build Rate.
