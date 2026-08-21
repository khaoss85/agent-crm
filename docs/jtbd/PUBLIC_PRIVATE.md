# What in `docs/jtbd/` stays public

Machine-readable form: `PUBLIC_PRIVATE.json`, checked by `scripts/jtbd-gate.js`
(`JTBD_ARTEFACT_UNCLASSIFIED`).

`docs/editions/REPOSITORY_BOUNDARY.md` classified 97 paths before this directory existed, so
`docs/jtbd/` appears in none of its five buckets. This file adds it, in that document's own
vocabulary — `KEEP_PUBLIC`, `MOVE_PRIVATE`, `PUBLIC_REDACTED_REPLACEMENT`,
`SPLIT_PUBLIC_PRIVATE`, `HISTORICAL_ALREADY_PUBLIC` — and under its §3 rule:

> Move a document private because it is **commercial** — pricing, positioning, competitive
> research, launch mechanics, sales enablement. Never move a document private because it is
> **unflattering**.

**Nothing is executed here.** No file moves, no history is rewritten and no public link is
broken. This PR marks; a migration task moves.

## The classification, in one table

| | |
|---|---|
| `KEEP_PUBLIC` | `README.md` · `AGENTS.md` · `manifest.json` · `quality_report.md` · `PORTFOLIO_ALIGNMENT.md` · `PUBLIC_PRIVATE.md` · `PUBLIC_PRIVATE.json` · `catalog/personas.json` · `catalog/capabilities.json` · `catalog/e2e_scenarios.json` · all of `coverage/` · all of `roadmap/` · `schemas/*` · `tools/*` · `prompts/01`, `prompts/03`, `prompts/05` |
| `SPLIT_PUBLIC_PRIVATE` | `catalog/jtbd.jsonl` · `MASTER.md` · `prompts/02_gap_to_roadmap.md` |
| `MOVE_PRIVATE` | `prompts/04_competitor_benchmark.md` |
| `PUBLIC_REDACTED_REPLACEMENT` | — |
| `HISTORICAL_ALREADY_PUBLIC` | — |

Two of those are the only decisions worth arguing about.

## Why the catalogue is split and not simply public

Each record holds the desired job — statement, use case, acceptance criteria, capabilities,
non-functional requirements, test obligations — beside a `roadmap` block
(`priority`, `business_value_1_5`, `strategic_fit_1_5`, `differentiation_1_5`,
`audit_priority_score_0_100`) and a `competitive_benchmark` block carrying an
`accordo_differentiation_hypothesis`. The first half is a requirements corpus. The second is
**positioning and competitive research**, named by §3 as the commercial case.

The split cannot be executed by editing the file: `catalog/jtbd.jsonl` is byte-frozen and
hash-verified by `tools/verify_catalog.py`, and rewriting it would break the one property that
makes the corpus citable. So `PUBLIC_PRIVATE.json` records `splitExecuted: false` and names
what the public half is instead:

- **the generated public subset** — the two overlays, which already carry the desired job's
  identity and none of its scoring, plus a projection of the record fields listed above. The
  migration writes that subset **before** anything moves, on the same rule §4 applies to every
  other replacement: no public file may link to a private path a reader cannot open.
- **the private half** — the `roadmap` and `competitive_benchmark` blocks, which no artefact
  in this PR reads. `scripts/jtbd-gate.js` fails with `JTBD_PRIVATE_FIELD_PUBLISHED` if one
  reaches an overlay row, and `tools/query_catalog.py` strips both blocks from every record it
  prints, on every flag, including `--json`.

## Why the assessments file stays public, and stays public *because* it is unflattering

`coverage/assessments.json` is mostly limitations. It says that Accordo routes no approval to
a named owner, generates no quote document, validates no real signature vendor, learns no
scoring model, and cannot configure a layout. §3's second sentence is the whole reason that
file is in the public bucket: the limitations are what make anything else this repository
asserts worth reading.

## What is generated, and what that buys

`coverage/coverage.overlay.jsonl` and `roadmap/roadmap.overlay.jsonl` are marked
`generated: true`. A generated artefact does not have to be *copied* across a repository
boundary — it is rebuilt from its inputs on whichever side holds them. That is what makes the
public subset of a split corpus a build step rather than a maintenance burden.

## Residual, stated rather than hidden

The brief this work was written against cites `docs/editions/PRIVATE_REPOSITORY_MIGRATION.md`
§3.6 as already classifying `docs/jtbd/` as `SPLIT_PUBLIC_PRIVATE`. **That file does not exist
in this checkout.** The classification above reaches the same answer for the whole directory
and is derived here from `REPOSITORY_BOUNDARY.md` §3 directly; if the migration document lands
later and disagrees on any single artefact, it is canonical and this file follows it.
