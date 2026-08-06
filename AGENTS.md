# Repository guidance

## Product intent

This repository is an agent-native CRM framework. Preserve the separation between deterministic CRM state and AI-assisted development/orchestration.

## Required workflow

1. Read `PRODUCT.md`, `ARCHITECTURE.md`, `DECISIONS.md` and the relevant module files before changing code. Before product, positioning, roadmap or public-distribution decisions, read `docs/strategy/MASTER_PLAN.md` first; for implementation details, `ARCHITECTURE.md` and `DECISIONS.md` remain authoritative.
2. For a multi-file feature or significant refactor, create and maintain an ExecPlan under `docs/plans/` following `.agent/PLANS.md`.
3. Use public module services and named workflows. Never mutate CRM tables from API, MCP or UI code.
4. Any write operation must retain validation, audit and trace.
5. Keep MCP write tools narrow; destructive or code-generating tools must default to dry-run or require an explicit apply flag.
6. Do not add a production dependency unless it removes more complexity than it adds; record the reason in `DECISIONS.md`.
7. Run `npm run verify` before considering work complete.
8. Update `TASKS.md` and relevant docs when behavior changes.
9. Follow `docs/QUALITY_GATES.md` for every feature PR, and **use the `adversarial-review` skill for any milestone review or pre-merge review task** (`.claude/skills/adversarial-review/SKILL.md`, mirrored at `.agents/skills/adversarial-review/SKILL.md`). A milestone that skipped the review is unreviewed, not finished.
10. Respect the core budget rule (ADR-018): **new domain-specific business behavior does not go into `packages/core`** unless it is first proven to be a reusable runtime capability. A PR that adds a domain concept to core must say which runtime capability it is and why a domain package cannot own it.
11. Read `docs/PROJECT_STATUS.md` for what is true in the repository today — merged milestone, main SHA, test count, open PRs, production blockers — and update it in the same PR as a milestone merge. Do not put volatile status in `MASTER_PLAN.md`.

## Coding conventions

- Node.js ESM and standard-library-first JavaScript.
- Use `// @ts-check` and JSDoc for public APIs.
- Prefer small explicit functions over hidden metaprogramming.
- Return domain objects, not raw SQLite rows with encoded JSON.
- Use cents for monetary values and ISO 4217 currency codes.
- Use ISO-8601 UTC timestamps.
- Log MCP diagnostics only to stderr; stdout is reserved for JSON-RPC.

## Definition of done

- behavior works end-to-end;
- tests cover happy path and policy boundary;
- trace and audit are visible;
- no direct table mutation outside module services;
- documentation is sufficient for another coding agent to continue;
- every claim in the docs, the ADR, the PR body and the JTBD matrix traces to a merged test — a capability and its limitation are stated in the same breath.

## Code review rules

- Flag any API/MCP handler that executes SQL directly.
- Flag any mutation without actor context and audit event.
- Flag AI-generated business decisions that are not encoded as explicit policy or approval.
- Flag money represented as floating-point currency amounts.
- Flag domain-specific business behavior added to `packages/core` without the ADR-018 justification.
- Flag a JTBD row promoted without linked evidence, or a document claiming a capability the tests do not prove.
