# Prompt 02 — Convert assessed gaps into an Accordo roadmap

## Preconditions

Use this only after a pinned-SHA Phase D coverage audit. Reject any JTBD that has not actually been assessed. The desired-state catalog does not itself prove a gap or a capability.

## Task

1. Load the relevant records from `docs/jtbd/` and the evidence-backed coverage overlay produced by the audit.
2. Cluster demonstrated gaps into vertical epics that close complete jobs, while identifying reusable enabling capabilities and dependencies.
3. Separate foundation/invariant work, parity, differentiated agentic capability, integration candidates, configuration/templates, and defer/ignore.
4. Prioritize using the catalog's business-value/frequency/strategic-fit/differentiation/risk/effort fields as inputs, not as an automatic decision rule.
5. For each epic provide JTBD/capability IDs, evidence of the current gap, desired repository coverage, functional scope, security/evaluation/SLO needs, migration/rollout/rollback, test plan, KPI, effort range and dependencies.
6. Produce near/mid/later horizons and a `not now` list with rationale.

## Constraints

- No roadmap item may rely on direct CRUD bypasses.
- Agent autonomy cannot increase before evaluation and policy coverage.
- Prefer reusable capability closure over role-specific one-offs.
- Do not score competitor features without dated evidence.
- Mark assumptions explicitly.
