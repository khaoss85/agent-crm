# Prompt 02 — Convert assessed gaps into an Accordo roadmap

## Inputs

- `data/jtbd.jsonl`
- `data/capabilities.json`
- `data/coverage_jtbd.assessed.jsonl`
- `data/coverage_capabilities.assessed.jsonl`
- target SHA and assessment report

## Task

1. Reject any roadmap item whose coverage is still `NOT_ASSESSED`.
2. Calculate roadmap score with `tools/score_roadmap.py`.
3. Cluster gaps into vertical epics that close complete JTBD flows.
4. Identify enabling capabilities and order dependencies.
5. Separate:
   - foundation/invariant;
   - parity;
   - differentiated agentic capability;
   - integration candidate;
   - configuration/template;
   - defer/ignore.
6. For each epic provide:
   - IDs;
   - personas/jobs;
   - evidence of current gap;
   - desired coverage;
   - data/service/workflow/agent/UI/integration scope;
   - security, evaluation and SLO;
   - migration/rollout/rollback;
   - test plan;
   - KPI and expected outcome;
   - effort range and dependency.
7. Produce horizons H1/H2/H3 and a “not now” list with rationale.

## Constraints

- No epic may rely on a CRUD bypass.
- Agent autonomy cannot increase before evaluation and policy coverage.
- Prefer reusable capability closure over a role-specific one-off.
- Do not score competitor features without dated evidence.
- Mark assumptions explicitly.
