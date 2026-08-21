# Prompt 03 — Turn one JTBD into a product and technical specification

Input JTBD ID: `<ACC-JTBD-...>`  
Target repository/SHA: `<...>`

1. Load the exact record with `python docs/jtbd/tools/query_catalog.py --id <ID> --json`.
2. Load linked capabilities from the catalog and read the pinned-SHA coverage evidence.
3. Read the current application composition through the appropriate Accordo rail; do not infer it from the desired state.
4. Produce a vertical specification with problem/outcome, actors/access/threat model, trigger/preconditions/state machine/exceptions, entities, commands/queries/events/contracts, managed fields/actions/invariants, transaction/idempotency/retry/compensation/outbox, agent contract/tools/context/evidence/eval/autonomy, role UX, integrations, observability/SLO, migration/flag, tests mapped to acceptance criteria, rollout/rollback and non-goals.
5. Link every proposed change to JTBD/capability IDs and acceptance criteria.
6. End with a file-by-file implementation plan, not code, unless implementation was requested.

A model, prompt or UI alone never closes the job.
