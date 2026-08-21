# Prompt 03 — Turn one JTBD into a product and technical specification

Input JTBD ID: `<ACC-JTBD-...>`  
Target repository/SHA: `<...>`

1. Load the exact record: `python docs/jtbd/tools/query_catalog.py --id <ACC-JTBD-...> --json`.
2. Load linked core/supporting capabilities from `docs/jtbd/catalog/capabilities.json`.
3. Read current coverage, evidence and owner from the same query's `coverage` and `owner`
   blocks — they are the overlays, not the catalogue's own status field.
4. Produce a vertical specification with:
   - problem and outcome;
   - actors, access scope and threat model;
   - trigger, preconditions, state machine and exception paths;
   - domain entities/fields/relations;
   - commands, queries, events and API contracts;
   - managed fields/actions and invariant;
   - workflow, transaction, idempotency, retry, compensation and outbox;
   - agent contract, tools, context, memory, evidence, eval and autonomy;
   - role UX and accessibility;
   - integrations and data contracts;
   - metrics, logs, traces, alerts and SLO;
   - migration, backfill and feature flag;
   - tests mapped one-to-one to acceptance criteria;
   - rollout, canary and rollback;
   - non-goals.
5. Link every proposed code change to a capability ID and acceptance criterion.
6. End with a file-by-file implementation plan, not code, unless implementation was requested.

A feature is not complete when only the model or UI exists; close the entire path.
