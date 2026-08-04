---
name: debug-crm-run
description: Diagnose a failed or unexpected Agent CRM workflow using run traces, audit events and module state. Use when a workflow, API operation, provider call or approval transition behaves incorrectly.
---

1. Run `npm run doctor`.
2. Read the workflow run with the MCP `crm_get_trace` tool or `GET /api/traces/:id`.
3. Identify the first failed or semantically incorrect step; do not treat downstream symptoms as the root cause.
4. Compare audit events with the expected module state.
5. Reproduce in an isolated test before editing production logic.
6. Fix the smallest responsible service, workflow step or provider adapter.
7. Add a regression test and run `npm run verify`.
8. Record a decision only when the fix changes architecture or policy.
