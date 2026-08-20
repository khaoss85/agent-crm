# Accordo JTBD functional coverage catalog

This directory is the source of truth for product-functional coverage analysis of Accordo as an agent-native CRM / Customer Data Platform.

## Purpose

Use this catalog to answer four questions:

1. Which real jobs must Accordo support for each business and technical persona?
2. Which jobs are fully, partially or not supported by the current repository?
3. Which missing capabilities should enter the roadmap first?
4. How does Accordo's coverage and agentic model compare with CRM/CDP competitors?

The catalog is intentionally written for both humans and coding agents. Do not promote a JTBD to `FUNCTIONAL` or `PRODUCTION_READY` from prose or source inspection alone: attach repository evidence and respect the evidence rules in `AGENTS.md`, `docs/QUALITY_GATES.md`, and the application rails.

## Files

- `MASTER.md` — human-readable master specification covering personas, JTBDs, use cases, agentic design and evaluation model.
- `catalog/jtbd.compact.jsonl` — machine-readable index of all 600 JTBDs. It contains the stable IDs and the fields needed for repository audits and roadmap prioritization.
- `prompts/01_repo_coverage_audit.md` — instructions for assessing repository coverage.
- `prompts/02_gap_to_roadmap.md` — instructions for converting verified gaps into a roadmap.
- `prompts/03_jtbd_to_spec.md` — instructions for turning one JTBD into an implementation specification.
- `quality_report.md` — catalog validation summary.

The original rich JSONL contains more verbose scenario, acceptance, governance and testing detail than the compact Git copy. The authoritative semantic specification remains `MASTER.md`; the compact JSONL is the fast machine index. If a field is absent from the compact record, resolve it from `MASTER.md` rather than inventing it.

## Recommended agent workflow

For a broad audit:

1. Read this file and `AGENTS.md`.
2. Read `MASTER.md` selectively by persona/JTBD ID; do not load the whole document if only one area is being audited.
3. Read `catalog/jtbd.compact.jsonl` to select the relevant JTBD IDs.
4. Run the smallest Accordo rail that answers the evidence question (`app inspect`, `project doctor`, `project verify`, `scenario run`, `solution verify`).
5. Record status as `ABSENT`, `CONCEPT_ONLY`, `PARTIAL`, `FUNCTIONAL`, or `PRODUCTION_READY` only when the evidence supports it.
6. State known limitations in the same output as the capability claim.
7. Use `prompts/02_gap_to_roadmap.md` only after the coverage pass.

## Coverage vocabulary

- `NOT_ASSESSED` — no repository assessment has been performed against a pinned commit.
- `ABSENT` — no meaningful implementation evidence exists.
- `CONCEPT_ONLY` — represented in docs/schema/design but no usable workflow is proven.
- `PARTIAL` — meaningful implementation exists but the JTBD acceptance boundary is incomplete.
- `FUNCTIONAL` — the complete JTBD flow is implemented and evidenced at the required level.
- `PRODUCTION_READY` — functional plus production-grade security, governance, observability, reliability and operational evidence.
- `DEPRECATED` — implementation exists but should not be treated as current capability.

## Scope

Catalog version: 600 JTBDs across 30 personas, 20 jobs per persona, spanning adoption, operation, optimization, maintenance, governance and platform evolution.

This directory is roadmap input, not a claim ledger. Current product truth remains governed by the repository's existing evidence and status documents.
