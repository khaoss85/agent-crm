# Accordo JTBD desired-state catalog

Catalog version `2026-08-20.1`: **30 personas · 600 JTBD · 225 capabilities · 10 end-to-end scenarios**.

This directory is a desired-state requirements corpus, not a claim that Accordo currently supports these jobs. Phase D must assess the repository at a pinned SHA using the four JTBD statuses defined by `docs/QUALITY_GATES.md`.

## Canonical raw files

- `catalog/jtbd.jsonl` — 4,611,152 bytes / 600 complete records.
- `MASTER.md` — 370,072 bytes.
- `catalog/personas.json` — 30 personas.
- `catalog/capabilities.json` — 225 atomic capabilities.
- `catalog/e2e_scenarios.json` — 10 cross-functional scenarios.

No decompression/materialization step is required.

## The three layers

The catalogue is one of three, and they are deliberately separate files in separate
vocabularies — `PORTFOLIO_ALIGNMENT.md` says why, and `scripts/jtbd-gate.js` enforces it.

| Layer | Where | Answers |
|---|---|---|
| desired | `catalog/` — frozen | what somebody wants a CRM to do |
| coverage | `coverage/coverage.overlay.jsonl` | what this repository proves, in the four statuses of `docs/QUALITY_GATES.md` §3 |
| ownership | `roadmap/roadmap.overlay.jsonl` | which pillar owns it and which milestone claims it |

## Phase D

1. Run `python docs/jtbd/tools/verify_catalog.py`.
2. Pin and record the target repository SHA.
3. Read root `AGENTS.md`, `docs/QUALITY_GATES.md`, this directory's `AGENTS.md`, and `coverage/STATUS_CROSSWALK.md`.
4. Use `query_catalog.py` to select the relevant JTBD slice.
5. Bind every positive status to executable repository evidence and state the residual limitation, in `coverage/assessments.json`.
6. Only after coverage is assessed, derive the roadmap from demonstrated gaps.

## Two things `MASTER.md` says that are not true here

`MASTER.md` is byte-frozen and hash-verified, so it is preserved exactly as the corpus was
published and **is not edited to match this repository**. Two of its instructions do not apply:

- it names `data/jtbd.jsonl`; the file is `catalog/jtbd.jsonl`.
- it names `tools/validate_catalog.py`, `tools/init_coverage.py` and `tools/score_roadmap.py`;
  none of the three exists. The checks are `tools/verify_catalog.py` and
  `node scripts/jtbd-gate.js`, and no scoring tool ships — the weights are commercial
  (`PUBLIC_PRIVATE.md`).

Every other document in this directory names the real paths.
