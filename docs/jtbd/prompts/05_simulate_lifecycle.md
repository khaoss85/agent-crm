# Prompt 05 — Simulate adoption, operation, maintenance and evolution

Select a persona/JTBD slice with `docs/jtbd/tools/query_catalog.py` or an end-to-end scenario from the materialized `docs/jtbd/catalog/e2e_scenarios.json`.

## Simulation modes

- `ADOPT`: tenant/schema/identity/permissions/integrations/baseline/training.
- `RUN`: normal events and daily work.
- `OPTIMIZE`: measurable performance gap and alternative evaluation.
- `MAINTAIN`: stale data, duplicate identity, partial integration failure or workflow regression.
- `GOVERN`: consent, permission, financial or contractual exception.
- `EVOLVE`: builder agent proposes a capability change in sandbox and passes evaluation/gates.

## Required outputs

Synthetic fixture manifest; chronological events; expected state transitions; expected agent/tool traces; approval points; acceptance criteria exercised; injected failures and recovery; KPI before/after; coverage gaps revealed; automatable test cases.

Never use real PII. Production remains read-only unless an explicit test tenant and write authorization are supplied.
