---
name: debug-crm-run
description: Diagnose a failed or unexpected Accordo workflow using run traces, audit events and module state. Use when a workflow, API operation, provider call or approval transition behaves incorrectly. Do not use for building something new — a stated objective is solve-business-goal, one lifecycle step is create-crm-workflow, a single custom object is create-crm-module — or for a pre-merge review (adversarial-review).
requires:
  tier: any-project
  command: "crm app inspect"
  projectSurface: []
  repositorySurface: []
  degradesTo: "nothing — this skill already reaches the project only through commands, the trace API and MCP tools"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

A composition problem explains a whole class of failed runs, so rule it out before reading a single trace. Note also that the report is **source-only**: it never opens the database, so it can tell you an action exists and never why one run of it failed.

1. Run `npm run doctor`.
2. Read the workflow run with the MCP `crm_get_trace` tool or `GET /api/traces/:id`.
3. Identify the first failed or semantically incorrect step; do not treat downstream symptoms as the root cause.
4. Compare audit events with the expected module state.
5. Reproduce in an isolated test before editing production logic.
6. Fix the smallest responsible service, workflow step or provider adapter.
7. Add a regression test and run `npm run verify`.
8. Record a decision only when the fix changes architecture or policy.
