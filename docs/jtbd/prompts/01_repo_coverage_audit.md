# Prompt 01 — Audit repository coverage against Accordo JTBD

You are auditing an agentic CRM repository against a desired-state catalog.

## Inputs

- Repository: `<OWNER/REPO>`
- Branch: `<BRANCH>`
- Target SHA: `<TARGET_SHA>`
- Catalog root: this package
- Scope: `<ALL | persona IDs | JTBD IDs | capability IDs>`

## Required preparation

1. Read `AGENTS.md`.
2. Run `python tools/verify_catalog.py`.
3. Record runtime/test constraints.
4. Initialize:
   ```bash
   # NOT_IMPLEMENTED: tools/init_coverage.py does not exist in this repository.
   # Initialise the overlay by hand, or from the coverage overlay if one is present.
   # Every row starts at `not supported`; nothing is pre-assessed.
   ```

## Task

For every in-scope JTBD:

1. Read the complete JSONL record.
2. Trace each core capability through:
   data model → domain service → API/command → workflow → agent → UI → integration → permission/policy → observability → tests/docs.
3. Execute relevant tests. Create a minimal reproduction when tests are absent.
4. Fill every coverage dimension with score 0–4, evidence and exact gaps.
5. Assign status using the weakest critical dimension; do not average away a security or failure gap.
6. Keep status at most `PARTIAL` when:
   - no end-to-end test exists;
   - a state change can bypass domain rules;
   - the role has no usable surface;
   - agent behavior lacks evaluation or policy boundary;
   - failure, retry or audit is absent.
7. Produce:
   - `data/coverage_jtbd.assessed.jsonl`
   - `data/coverage_capabilities.assessed.jsonl`
   - `reports/coverage_summary.md`
   - `reports/critical_gaps.csv`
   - `reports/evidence_index.csv`

## Evidence rules

Each evidence item must contain:

```json
{
  "kind": "DATA_MODEL|CODE|API|WORKFLOW|AGENT|UI|TEST|DOC|OBSERVABILITY|SECURITY",
  "path": "relative/path",
  "symbol_or_line": "symbol or Lx-Ly",
  "claim": "one precise fact",
  "test_result": "command and result, or null"
}
```

No raw assertion such as “covered” is accepted.

## Summary structure

1. SHA and constraints.
2. Coverage distribution.
3. P0/high-risk gaps.
4. Cross-cutting foundation gaps.
5. Partial features that look complete in the UI but fail acceptance.
6. Unused/dead capabilities.
7. Quick wins.
8. Recommended epics with dependencies.
9. Uncertainty and tests not run.

Do not implement code during the audit unless explicitly asked. Do not change the desired-state catalog to make current coverage appear higher.
