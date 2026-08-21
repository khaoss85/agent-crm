# Status crosswalk — the portable enum and this repository's four

`docs/jtbd/AGENTS.md` and `docs/jtbd/README.md` both send a Phase D reader here before an
audit. This is that document.

The catalogue is a **portable** desired-state corpus. It carries a status enum of its own, and
`schemas/coverage.schema.json` accepts it. That enum is **not** this repository's publication
vocabulary, and mixing the two is the first way a Phase D audit goes wrong.

## The two vocabularies

| Catalogue enum (`schemas/coverage.schema.json`) | This repository publishes | Why |
|---|---|---|
| `NOT_ASSESSED` | `not supported` | The publication default. Absence of an assessment is not evidence of support; it is also not a finding — the overlay records `assessed: false` beside the status so the two cannot be confused. |
| `ABSENT` | `not supported` | Same value, less information: `ABSENT` claims someone looked. |
| `CONCEPT_ONLY` | `not supported` | A design document is not a primitive. `docs/QUALITY_GATES.md` §2 "Documentation truthfulness". |
| `PARTIAL` | `partially supported` | Only when a real slice is proven **and** the missing part is named. |
| `FUNCTIONAL` | `technically supported` **at most** | "The primitives exist, the job is not proven end to end." A `FUNCTIONAL` row with an end-to-end test is `validated end to end`; without one it can never exceed `technically supported`. |
| `PRODUCTION_READY` | *no automatic mapping* | Production readiness in this repository is gated on `docs/QUALITY_GATES.md` §4, none of which is met. A `PRODUCTION_READY` assessment imported from elsewhere is re-derived here from evidence or it is `not supported`. |
| `DEPRECATED` | *not used* | The overlay has no retired state; a retired job leaves the crosswalk as `superseded`. |

**The mapping is one-way.** It reads a foreign assessment into this repository's vocabulary
and never writes back. Nothing in `scripts/jtbd-gate.js` reads the catalogue's `coverage`
block at all — the desired layer is opened for its ids and its capabilities and for nothing
else.

## Why four and not seven

The four in `docs/QUALITY_GATES.md` §3 exist because each one names a different burden of
proof, and the burden is always on the higher value:

- **not supported** — the default for anything new.
- **partially supported** — a real slice works; the missing part is named *in the same row*.
- **technically supported** — the primitives exist; nothing has driven the whole job.
- **validated end to end** — a merged test drives the whole job, and the row lists what.

A seven-value enum invites averaging, and averaging is what lets a security or failure gap
disappear behind eight healthy dimensions. `docs/jtbd/AGENTS.md` states the rule directly: a
missing end-to-end proof cannot be averaged away by many partial primitives.

## What a Phase D auditor does with this

1. Run `python docs/jtbd/tools/verify_catalog.py` — the corpus is intact.
2. Read `docs/jtbd/AGENTS.md`, `docs/QUALITY_GATES.md` §3 and this file.
3. Select a slice with `docs/jtbd/tools/query_catalog.py`; never open six hundred records.
4. For each candidate, translate any inherited status through the table above, then **throw
   the translation away** and re-derive the status from repository evidence. The table exists
   to stop a foreign value being copied, not to supply one.
5. Write the conclusion into `coverage/assessments.json` with evidence, limitations, fact ids
   and a `verifiedAtSha`, and run `node scripts/jtbd-gate.js --reverify && --write`.

Step 4 is the whole point. A status arriving from another repository, another product or an
earlier audit is a claim about somewhere else.
