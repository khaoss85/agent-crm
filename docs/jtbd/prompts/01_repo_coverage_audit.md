# Prompt 01 — Audit repository coverage against Accordo JTBD

You are auditing an agentic CRM repository against a desired-state catalog.

## Inputs

- Repository: `<OWNER/REPO>`
- Branch: `<BRANCH>`
- Target SHA: `<TARGET_SHA>`
- Catalog root: this package
- Scope: `<ALL | persona IDs | JTBD IDs | capability IDs>`

## Required preparation

1. Read `docs/jtbd/AGENTS.md`, `docs/QUALITY_GATES.md` §3 and
   `docs/jtbd/coverage/STATUS_CROSSWALK.md`.
2. Run `python docs/jtbd/tools/verify_catalog.py`.
3. Record runtime/test constraints.
4. Select the slice — never open six hundred records:
   ```bash
   python docs/jtbd/tools/query_catalog.py --persona PER-... --fields
   ```

## Task

For every in-scope JTBD:

1. Read the complete JSONL record.
2. Trace each core capability through:
   data model → domain service → API/command → workflow → agent → UI → integration → permission/policy → observability → tests/docs.
3. Execute relevant tests. Create a minimal reproduction when tests are absent.
4. Fill every coverage dimension with score 0–4, evidence and exact gaps.
5. Assign status using the weakest critical dimension; do not average away a security or failure gap.
   Publish it in the four-value vocabulary of `docs/QUALITY_GATES.md` §3, not in the
   catalogue's portable enum — `docs/jtbd/coverage/STATUS_CROSSWALK.md` is the bridge, and it
   reads one way only.
6. Keep status at most `PARTIAL` when:
   - no end-to-end test exists;
   - a state change can bypass domain rules;
   - the role has no usable surface;
   - agent behavior lacks evaluation or policy boundary;
   - failure, retry or audit is absent.
7. Write each positive conclusion into `docs/jtbd/coverage/assessments.json` — evidence with
   `kind`, `path` and `claim`, the residual limitations, the Repository Truth fact ids and a
   `verifiedAtSha` — then:
   ```bash
   node scripts/jtbd-gate.js --reverify   # stamp the digest of every file the row reads
   node scripts/jtbd-gate.js --write      # regenerate the overlays
   node scripts/jtbd-gate.js              # the gate must pass
   ```
   `assessments.json` is the only place a positive status can be born. A catalogue id absent
   from it is `not supported`, and nothing promotes a row automatically.

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
