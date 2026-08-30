# Product

## One sentence

Accordo is a framework that lets a user describe a commercial process to Codex or Claude Code and have the agent safely build, run, inspect and improve a CRM application.

## Primary job

> When I need a CRM process that is specific to my business, I want to describe the outcome in natural language, so the coding agent can implement and operate it without rebuilding CRM foundations each time.

## Target users

1. Product and revenue leaders who know the process but do not want to specify every technical detail.
2. Developers using Codex or Claude Code to deliver CRM customizations quickly.
3. SaaS teams embedding CRM capabilities into their own product.

## Product boundary

Accordo is not an autonomous salesperson and is not a full Salesforce replacement in milestone 0.

The framework **authenticates nobody** — a deployment adapter verifies the request — and it
**owns tenancy and authorization completely**, with one tenant per application instance enforced
by the storage binding rather than by a filter (ADR-038). Persistence for the composed
application is SQLite or dedicated-database PostgreSQL. Shared-database row-level
tenancy, durable jobs, billing and any marketing runtime do not exist.
Each of those sentences is bound to a generated fact (ADR-039) and re-checked by
`npm run repo:truth -- --check`.

<!-- truth: spine.authentication.framework_verifier=absent -->
<!-- truth: spine.authorization.enforced=enforced -->
<!-- truth: spine.tenant.isolation.mode=one_tenant_per_instance -->
<!-- truth: spine.postgresql.implemented=implemented -->
<!-- truth: spine.durable_jobs.implemented=absent -->
<!-- truth: billing.implemented=absent -->
<!-- truth: marketing_runtime.implemented=absent -->

It provides:

- reusable CRM primitives;
- deterministic actions and workflows;
- extension points for providers and modules;
- agent-readable project context;
- CLI/MCP operations;
- trace, audit and human approval.

## Success criterion for milestone 0

A coding agent can understand the repository and safely implement a new CRM module or workflow while preserving tests, trace and audit.

## Strategy

The category, positioning, ICP, JTBD and public promise are defined in `docs/strategy/MASTER_PLAN.md` (canonical entry point) and `docs/strategy/CATEGORY.md`.
