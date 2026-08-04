# Milestone 0 — agent-native CRM vertical slice

## Goal and user-visible outcome

Create a runnable proof of concept in which a coding agent can understand, extend and operate CRM infrastructure through repository instructions, skills, MCP and CLI. Demonstrate one complete commercial rule: a renewal worth at least €50,000 cannot move to Proposal without an explicit human approval.

## Repository context

The implementation is deliberately standard-library-first. CRM state lives behind module services under `packages/modules/`; cross-module behavior lives in named workflows under `packages/workflows/`; `apps/server/` and `apps/admin/` expose the same application; `packages/mcp/` and `packages/cli/` expose controlled development and runtime operations to Codex or Claude Code.

## Milestones

- [x] Define product, architecture, JTBD and repository guidance.
- [x] Implement SQLite schema, Company, Contact, Opportunity and Approval modules.
- [x] Implement traced stage-change and human-decision workflows.
- [x] Add REST API, Admin UI, SDK and in-memory notification provider.
- [x] Add CLI commands, dry-run module scaffolding and diagnostics.
- [x] Add MCP tools, resources and prompts over stdio.
- [x] Add Codex and Claude project configuration and repository skills.
- [x] Cover policy boundary, API, MCP and safety behavior with automated tests.

## Validation

Run:

```bash
npm run verify
npm run smoke
```

Expected behavior:

- all syntax checks and tests pass;
- the €20,000 renewal moves directly to Proposal;
- the €80,000 renewal moves to Approval Pending;
- only a human actor can decide the pending approval;
- traces and audit events are persisted.

## Progress log

- Implemented the first complete vertical slice.
- Added read/write MCP annotations and explicit human-interaction metadata.
- Made compound commercial mutations transactional.
- Verified the stdio MCP handshake emits JSON-RPC only on stdout.
- Final validation: 9 tests passing and smoke scenario passing.

## Decision log

- SQLite and Node built-ins are sufficient for milestone 0 and keep the repository immediately executable.
- AI coding agents may compose and invoke behavior, but commercial state changes remain deterministic.
- MCP code generation is dry-run by default.
- The local HTTP server is a development surface, not a remotely exposed production API; tenancy, authentication and authorization precede remote write access.

## Outcome and follow-up

Milestone 0 is complete. The first follow-up is a declarative module manifest that can generate migrations and metadata, proving that a coding agent can add a CRM primitive with less handwritten plumbing.
