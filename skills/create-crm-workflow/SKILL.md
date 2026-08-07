---
name: create-crm-workflow
description: Implement a deterministic cross-module CRM process with policy, trace, audit and optional human approval. Use for stage transitions, follow-ups, onboarding, renewals and approval rules.
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/workflows/src/engine.js"]
  repositorySurface: ["docs/ACTIONS.md"]
  degradesTo: "the actions, policies and records reported by `crm app inspect --json`, plus the workflow engine and the existing workflows in the project's own source"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

`actions[]` tells you which lifecycle steps already exist and their declared `fromStates`, which is usually the answer to step 0 below.

0. First decide which tool fits. A lifecycle step on **one record** (qualify,
   close, approve) is a **record action** — see the create-crm-module skill, and
   `docs/ACTIONS.md` as background where the project carries it; the action
   runtime already gives you one atomic transaction, events released only after
   commit, and a trace. Use a workflow for a multi-record or multi-step process,
   or when a human approval gate is involved.
1. Read the workflow engine and an existing workflow in this project's own
   source (`packages/workflows/src/engine.js` here). The engine is the contract;
   copy an existing workflow's shape rather than inventing one.
2. Express the business process as small named steps.
3. Keep policy deterministic and explicit; an LLM may recommend but must not silently decide protected state.
4. Use module services for all state changes.
5. Add compensation for external reversible side effects.
6. Emit domain events only after the authoritative state change succeeds.
7. Test the policy boundary, failure path and final trace.
8. Run `npm run verify` and document any new architectural rule.
