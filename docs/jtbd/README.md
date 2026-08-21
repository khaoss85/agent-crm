# Accordo JTBD desired-state catalog

Catalog version `2026-08-21.1`: **30 personas · 600 JTBD · 225 capabilities · 10 end-to-end scenarios**.

This directory is a desired-state requirements corpus, not a claim that Accordo currently supports these jobs. Phase D must assess the repository at a pinned SHA using the four JTBD statuses defined by `docs/QUALITY_GATES.md`.

## Canonical raw files

- `catalog/jtbd.jsonl` — 4,611,152 bytes / 600 complete records.
- `MASTER.md` — 370,072 bytes.
- `catalog/personas.json` — 30 personas.
- `catalog/capabilities.json` — 225 atomic capabilities.
- `catalog/e2e_scenarios.json` — 10 cross-functional scenarios.

No decompression/materialization step is required.

## The three layers

The desired catalogue, coverage overlay, and roadmap ownership overlay are separate contracts:

| Layer | Where | Answers |
|---|---|---|
| desired | `catalog/` | what somebody wants a CRM to do |
| coverage | `coverage/coverage.overlay.jsonl` | what executable evidence proves |
| ownership | `roadmap/roadmap.overlay.jsonl` | which pillar and milestone own the gap |

`scripts/jtbd-gate.js` enforces that coverage can only originate in evidence-backed assessments; roadmap assignment cannot promote coverage.

## Tools, and what does not exist

Present and working: `tools/verify_catalog.py` (validates the corpus against
`manifest.json`) and `tools/query_catalog.py` (streams the corpus and selects a
slice; `--json` emits a single JSON array on stdout and the match count on
stderr, so the output parses).

**`MASTER.md` names four things that do not exist in this repository** —
`tools/validate_catalog.py`, `tools/init_coverage.py`, `tools/score_roadmap.py`
and the path `data/jtbd.jsonl` (the real path is `catalog/jtbd.jsonl`). Six
references in total, at lines 60, 68, 84–86 and 1021.

They are **NOT_IMPLEMENTED**, not missing by accident. `MASTER.md` is frozen by
the SHA-256 in `manifest.json` and cannot be edited without moving the
catalogue's checksum, so the correction is recorded here instead of silently
diverging the corpus. Treat those four names as historical: do not run them, and
do not add a tool merely because a document mentions it.

The prompts under `prompts/` have been corrected to the real paths and mark the
absent tools inline.

## Phase D

1. Run `python docs/jtbd/tools/verify_catalog.py`.
2. Pin and record the target repository SHA.
3. Read root `AGENTS.md`, `docs/QUALITY_GATES.md`, this directory's `AGENTS.md`, and `coverage/STATUS_CROSSWALK.md`.
4. Use `query_catalog.py` to select the relevant JTBD slice.
5. Bind every positive status to executable repository evidence and state the residual limitation in `coverage/assessments.json`.
6. Only after coverage is assessed, derive the roadmap from demonstrated gaps.
