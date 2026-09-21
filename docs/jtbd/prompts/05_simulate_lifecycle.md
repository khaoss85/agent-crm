# Prompt 05 — Simulate adoption, operation, maintenance and evolution

Select a persona, a set of JTBD IDs or an end-to-end scenario from `data/e2e_scenarios.json`.

## Simulation modes

1. `ADOPT`: configure tenant, schema, identity, permissions, integrations, baseline and training.
2. `RUN`: execute normal events and daily work.
3. `OPTIMIZE`: introduce a measurable performance gap and evaluate alternatives.
4. `MAINTAIN`: inject stale data, duplicate identity, partial integration failure or workflow regression.
5. `GOVERN`: inject consent, permission, financial or contractual exception.
6. `EVOLVE`: ask the builder agent to propose a capability change in sandbox and pass evaluation/gates.

## Required outputs

- synthetic fixture manifest;
- exact events in chronological order;
- expected state transitions;
- expected agent/tool traces;
- approval points;
- acceptance criteria tested;
- injected failures and expected recovery;
- KPI before/after;
- coverage gaps revealed;
- test cases that can be automated.

Never use real PII. Make all synthetic identifiers obvious. Keep the production environment read-only unless an explicit test tenant is supplied.
