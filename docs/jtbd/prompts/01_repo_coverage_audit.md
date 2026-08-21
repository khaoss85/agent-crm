# Prompt 01 — Audit repository coverage against Accordo JTBD

You are auditing the current Accordo repository against `docs/jtbd/`, a desired-state catalog. Do not implement features during this audit unless explicitly asked.

## Required preparation

1. Read root `AGENTS.md`, `docs/QUALITY_GATES.md`, `docs/jtbd/AGENTS.md`, and `docs/jtbd/coverage/STATUS_CROSSWALK.md`.
2. Run `python docs/jtbd/tools/verify_catalog.py`.
3. Pin and record repository, branch, target SHA, assessor, runtime constraints and tests that cannot be run.
4. Select the smallest relevant catalog slice with `docs/jtbd/tools/query_catalog.py`. Materialize only if an ordinary JSONL path is useful.

## Task

For every in-scope JTBD:

1. Read the exact catalog record and linked capabilities.
2. Use the smallest Accordo rail that answers each claim. Source/prose may locate evidence but never promote status by themselves.
3. Trace the usable job boundary across data model, domain service/action, public surface, workflow, agent/tool policy, UI where relevant, integration, authorization, observability and merged tests.
4. Record exact positive evidence and exact residual limitation.
5. Assign only the repository vocabulary: `not supported`, `partially supported`, `technically supported`, `validated end to end`.
6. Do not average away a security, transaction, failure-handling, policy or end-to-end evidence gap.
7. For autonomous jobs, separately verify tool scope, actor/tenant authorization, approval/policy, managed mutation boundary, idempotency/retry/compensation, audit/trace, evaluation and rollback.

## Evidence item

Use an evidence record at least as precise as:

```json
{
  "kind": "DATA_MODEL|CODE|API|WORKFLOW|AGENT|UI|TEST|DOC|OBSERVABILITY|SECURITY",
  "path": "relative/path",
  "symbol_or_line": "symbol or Lx-Ly",
  "claim": "one precise fact",
  "test_result": "command and result, or null"
}
```

## Deliverable

Produce a coverage overlay keyed by JTBD ID and target SHA, plus a summary of high-risk gaps, cross-cutting foundations, partial flows, quick wins, uncertainty and tests not run. If persisting this in the repository, follow the repo's planning/quality-gate rules and choose the output path in the active plan; do not invent a pre-existing assessment file.
