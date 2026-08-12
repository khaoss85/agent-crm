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
9. **Domain-package work requires the `build-custom-domain-package` skill** (`.claude/skills/build-custom-domain-package/SKILL.md`, mirrored at `.agents/skills/build-custom-domain-package/SKILL.md`) and `docs/PACKAGE_AUTHORING.md`. A package imports only `packages/core/index.js`, reaches another package only through a declared capability, and is registered by one static import in `packages/domains/generated/index.js`. A single custom object is a module, not a package.
10. Follow `docs/QUALITY_GATES.md` for every feature PR, and **use the `adversarial-review` skill for any milestone review or pre-merge review task** (`.claude/skills/adversarial-review/SKILL.md`, mirrored at `.agents/skills/adversarial-review/SKILL.md`). A milestone that skipped the review is unreviewed, not finished.
11. Respect the core budget rule (ADR-018): **new domain-specific business behavior does not go into `packages/core`** unless it is first proven to be a reusable runtime capability. A PR that adds a domain concept to core must say which runtime capability it is and why a domain package cannot own it.
12. Read `docs/PROJECT_STATUS.md` for what is true in the repository today — merged milestone, the commit the public numbers were measured at, open PRs, production blockers — and update it in the same PR as a milestone merge. Do not put volatile status in `MASTER_PLAN.md`. **It carries no test count**: a count is measured into `site/claims.json` `measuredAgainst` by `node scripts/measure-suite.js --apply` and cited from there (ADR-027). Typing one into any document under `docs/` fails `npm run gtm:check`.
13. To learn what an application actually has, run `npm run crm -- app inspect --json` rather than assembling it from source and prose (`docs/APPLICATION_INSPECTION.md`). Read `valid`, then `problems[]`, then `limitations[]` — every limitation is a hard boundary on what you may claim. It reads checked-in source only: it opens no database, contacts no provider, and reports no runtime or authorization state.
14. **Compatibility Backfill Rule.** When you add or change a *horizontal* capability — one every domain could use, such as the package seam, a declared capability contract, module evolution, an evidence discipline or an agent-facing surface — record every existing domain's status against it in `docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` in the same PR, using `aligned | partial | deferred | not_applicable | needs_extraction` with a one-line reason. Declaring the gap is required; closing it in the same PR is not. Do **not** refactor a legacy domain to close a row: extraction is sequenced work (`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md`), not something a feature PR does on the way past.
15. A Solution Plan is a **checked file with a contract**, not prose with headings (`docs/SOLUTION_PLAN.md`). Write it, record the `app inspect` report it was written against, and run `npm run crm -- solution check <plan.json>` before writing code and again before the review — a plan bound to a composition that has since moved reports `PLAN_STALE`. A plan never carries a command: nothing in this framework executes one, and the validator refuses it.
16. **Parallel coding agents (§16 below).** Each agent works in its own sibling worktree **outside** the repository, owns exactly one branch, and one final integrator reconciles the shared truth.

## Parallel coding agents

Several agents may work on one milestone at once. Three rules, because breaking
any of them has already cost this repository a wave of published numbers:

1. **One worktree per agent, outside the repository.** `git worktree add
   ../<repo>-worktrees/<name>` — a sibling directory, never a path inside the
   checkout, so no agent's build output, temporary database or generated site
   lands in another agent's tree.
2. **One branch owner per worktree.** The agent that owns a branch is the only
   one that commits to it. An agent that needs another agent's change waits for
   the merge or rebases onto it; it does not reach into a worktree it does not own.
3. **One final integrator reconciles shared truth.** Every wave ends with a
   single pass over the files every branch touches — `docs/PROJECT_STATUS.md`,
   `site/claims.json`, the JTBD matrix, the roadmaps — because a merge that
   resolves a conflict in a *measured record* silently discards a measurement.
   That is not hypothetical: a branch re-measured `site/claims.json`, the merge
   kept main's older block, and the ledger ran a whole wave behind the suite with
   every gate green. `npm run gtm:check` now fails on that particular drift
   (`scripts/measurement.js`), and the integrator pass is what catches the rest.

Sequenced in `docs/QUALITY_GATES.md` §1.11.

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

## The DX Simplicity Gate

Before adding a new **agent-facing** command, tool, contract or namespace,
answer these in the PR. Canonical rule and full rationale:
`docs/strategy/CODING_AGENT_DX_NORTH_STAR.md`.

> **Goal-first outside, rigorous inside.** New internal complexity is justified
> only if it reduces perceived user or agent complexity, or measurably improves
> reliability or evidence.

- name the concrete agent **failure mode** it prevents — the failure, not the capability;
- prove existing primitives are insufficient, having tried to extend one;
- minimise semantic overlap: two commands answering nearly the same question is worse than one that answers it completely;
- keep it deferred or on-demand unless every session needs it;
- preserve portability — behaviour belongs in the CLI, a JSON contract, the Package Contract, canonical Skill semantics or the Quality Gates, never in harness-specific logic;
- ship machine-readable evidence of its value: an exit code, a contract-versioned document, a fingerprint, a measured number;
- if the capability is horizontal, update the Compatibility Backfill Rule and the Legacy Alignment Matrix in the same PR;
- show the end-user goal flow gets **simpler**, not more manual. "The agent now has one more thing to run" fails the first bullet.

## Code review rules

- Flag any API/MCP handler that executes SQL directly.
- Flag any mutation without actor context and audit event.
- Flag AI-generated business decisions that are not encoded as explicit policy or approval.
- Flag money represented as floating-point currency amounts.
- Flag domain-specific business behavior added to `packages/core` without the ADR-018 justification.
- Flag a JTBD row promoted without linked evidence, or a document claiming a capability the tests do not prove.
- Flag a new agent-facing command, tool or contract that does not clear the DX Simplicity Gate above.
