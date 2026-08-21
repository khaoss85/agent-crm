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

## Phase D

1. Run `python docs/jtbd/tools/verify_catalog.py`.
2. Pin and record the target repository SHA.
3. Read root `AGENTS.md`, `docs/QUALITY_GATES.md`, this directory's `AGENTS.md`, and `coverage/STATUS_CROSSWALK.md`.
4. Use `query_catalog.py` to select the relevant JTBD slice.
5. Bind every positive status to executable repository evidence and state the residual limitation.
6. Only after coverage is assessed, derive the roadmap from demonstrated gaps.
