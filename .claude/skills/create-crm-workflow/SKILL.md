---
name: create-crm-workflow
description: Implement a deterministic cross-module CRM process with policy, trace, audit and optional human approval. Use for stage transitions, follow-ups, onboarding, renewals and approval rules.
---

1. Read `packages/workflows/src/engine.js` and an existing workflow.
2. Express the business process as small named steps.
3. Keep policy deterministic and explicit; an LLM may recommend but must not silently decide protected state.
4. Use module services for all state changes.
5. Add compensation for external reversible side effects.
6. Emit domain events only after the authoritative state change succeeds.
7. Test the policy boundary, failure path and final trace.
8. Run `npm run verify` and document any new architectural rule.
