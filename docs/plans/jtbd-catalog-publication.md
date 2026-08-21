# ExecPlan — publish the 600-record JTBD desired-state catalog

## Goal and user-visible outcome

Make the previously referenced JTBD corpus real and auditable in the repository so coding agents can execute Phase D without inventing records, while correcting the live documentation-truth defect where `docs/jtbd/README.md` named files that were not committed.

## Current repository context

At the branch point, `docs/jtbd/` contains only `README.md`; the README describes a master document, catalog and prompts that are absent. Root `AGENTS.md` requires evidence-first claims and `docs/QUALITY_GATES.md` defines the repository JTBD vocabulary.

## Approaches considered

1. **Commit the 4.6 MB JSONL directly through the contents API.** Best discoverability, but the active connector cannot reliably carry that single UTF-8 payload.
2. **Split the catalog into persona files.** Plain Git data, but changes the canonical artifact, adds merge/order complexity and makes checksum equivalence harder to reason about.
3. **Commit lossless XZ sources plus deterministic materialization and verification.** Chosen. It preserves the exact original bytes, keeps the repository payload small, is standard-library-readable in Python and makes integrity mechanically checkable.

## Milestones

- [x] Validate original package: 30 personas, 225 capabilities, 600 JTBD, 20 per persona, zero unknown capability references.
- [x] Add checked compressed sources and manifest with raw/compressed byte lengths and SHA-256.
- [x] Add deterministic materializer, direct-query tool and verifier.
- [x] Add repository-vocabulary crosswalk and truthful README/AGENTS guidance.
- [ ] Run repository CI/quality gates on PR; do not self-merge.

## Validation

Catalog-specific:

```bash
python docs/jtbd/tools/verify_catalog.py
python docs/jtbd/tools/query_catalog.py --id ACC-JTBD-CRO-001 --json
python docs/jtbd/tools/materialize_catalog.py
sha256sum docs/jtbd/catalog/jtbd.jsonl docs/jtbd/MASTER.md
```

Expected catalog result includes `VALIDATION_OK`; the materialized hashes must match `manifest.json`.

Repository gate before merge: CI plus the repository-required verification appropriate to this documentation/data-only PR. Any external preview integration that this credential cannot inspect remains explicitly unresolved, never called green.

## Progress log

- 2026-08-21: source package recovered from conversation artifacts and validated locally.
- 2026-08-21: chose lossless compressed transport after direct 4.6 MB publication proved unsuitable for the connector.
- 2026-08-21: reconciled portable catalog coverage vocabulary with Accordo's four-value truth contract instead of silently replacing either.

## Decision log

- Preserve original catalog bytes; do not regenerate or summarize records during publication.
- Keep production-readiness as a separate dimension; do not map it to a stronger repository JTBD status.
- Do not merge the PR from the implementing agent; root quality gates require a human merge.

## Outcome and follow-up

After merge, Phase D can run against the exact 600-record corpus. A future repository-truth rule may check that documentation-referenced local files or materialization sources exist, but that gate belongs to the truth-contract work already in progress rather than this corpus-publication PR.
