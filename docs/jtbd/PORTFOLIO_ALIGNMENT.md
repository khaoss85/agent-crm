# The JTBD Portfolio Alignment Gate

`node scripts/jtbd-gate.js` · `--write` · `--reverify` · `--json`

> **Three questions, three files, three vocabularies. They are never merged, and the gate's
> whole job is to keep them from being read as one.**

| Question | Layer | File | Vocabulary |
|---|---|---|---|
| What does somebody *want* a CRM to do? | desired | `catalog/jtbd.jsonl` — frozen, never written by the gate | the catalogue's own `NOT_ASSESSED … PRODUCTION_READY` |
| What does *this repository* prove? | coverage | `coverage/coverage.overlay.jsonl` | the four in `docs/QUALITY_GATES.md` §3 |
| Who *owns* it and where is it planned? | ownership | `roadmap/roadmap.overlay.jsonl` | `implemented \| in progress \| planned \| deferred \| unassigned \| out of scope` |

## Why the vocabularies stay apart

Because each answers a question the other two cannot, and every collapse between them is a
failure this repository has a record of.

- **Desired is not supported.** The catalogue holds six hundred jobs and says nothing about
  any of them being possible here. Every record ships `NOT_ASSESSED`. A reader who counts the
  rows and reports "six hundred jobs" has published a capability claim nobody made — which is
  precisely why the desired layer has a status enum of its own that the repository never uses.
- **Supported is not owned.** A job can be proven and belong to no milestone (nothing more is
  planned for it), or be owned by a milestone and proven nowhere. Reading a milestone as
  evidence is how a roadmap becomes a claim.
- **Owned is not prioritized.** Priority, business value, differentiation and competitive
  rationale live in the catalogue's own `roadmap` and `competitive_benchmark` blocks and are
  **commercial** under `docs/editions/REPOSITORY_BOUNDARY.md` §3. No overlay written here
  reads them, `query_catalog.py` refuses to print them, and `scripts/jtbd-gate.js` fails with
  `JTBD_PRIVATE_FIELD_PUBLISHED` if one appears in an overlay row.

## The rule that makes the coverage layer worth anything

**No automatic promotion.** `docs/jtbd/coverage/assessments.json` is the only place a positive
status can be born; every catalogue id absent from it gets `not supported`. There is no rule
anywhere in `scripts/jtbd-gate.js` that reads the repository and concludes that a job is
supported, because that conclusion belongs to a person reading merged tests
(`docs/QUALITY_GATES.md` §3, ADR-039 `JTBD_ROWS_NOT_ENCODED`).

An entry in `assessments.json` must survive six refusals:

| Refusal | Code |
|---|---|
| a positive status with no evidence | `JTBD_EVIDENCE_MISSING` |
| a positive status with no named residual limitation | `JTBD_EVIDENCE_LIMITATION_ABSENT` |
| evidence that is only source or only documentation | `JTBD_EVIDENCE_NOT_EXECUTABLE` |
| a cited Repository Truth fact that does not exist | `JTBD_FACT_UNKNOWN` |
| `validated end to end` citing no `spine.*` fact | `JTBD_SPINE_EVIDENCE_ABSENT` |
| evidence that has changed since the row was verified | `JTBD_EVIDENCE_MOVED` |

The last one is the stale-`verifiedAtSha` rule, and it is exact rather than approximate. A
commit id is a label: it cannot say whether the evidence still supports the claim, and a
shallow clone cannot even resolve it. So each assessment records the **content digest of every
file it read** at `verifiedAtSha`. When one of those files moves, the row is describing a tree
that no longer exists and the gate fails until a person re-verifies it and runs
`node scripts/jtbd-gate.js --reverify`. That is deliberate friction, and it applies only to
rows making a claim — a `not supported` row cites nothing and can never fail this way.

`JTBD_SPINE_EVIDENCE_ABSENT` fires on no row today, because no row reaches `validated end to
end`. It is written now rather than the first time one does: every canonical record's
non-functional requirements name tenant isolation, least privilege and an immutable audit
trail, and this framework ships no identity verifier
(`spine.authentication.framework_verifier=absent`). A row at the top status has to say where it
stands on that, by fact id.

## `assessed: false` and why the default is not a finding

Every coverage row carries `assessed`. `not supported` is the *publication* default
(`docs/QUALITY_GATES.md` §1.6); it is not the outcome of an assessment. The overlay says so in
a field rather than in a footnote, so that "how many jobs were assessed" and "how many jobs
are unsupported" cannot be answered with the same number.

## The counting rule, stated so nobody has to guess

**Raw JTBD count is not a progress metric.** Neither the six hundred desired jobs, nor the
number of rows an overlay holds, nor the number of matrix rows, measures anything about the
framework. The catalogue's size is a property of the corpus somebody wrote; the overlay's size
is a property of the join. The only numbers here that mean anything are the ones with evidence
behind them, and there are very few of those on purpose.

## Related

`AGENTS.md` in this directory (the evidence discipline) · `coverage/STATUS_CROSSWALK.md` (the
two status vocabularies) · `coverage/MATRIX_CROSSWALK.md` (which desired job each coverage row
is about) · `roadmap/OWNERSHIP.md` (who owns what, and what nobody owns) ·
`PUBLIC_PRIVATE.md` (what stays public) · `docs/plans/jtbd-portfolio-alignment-gate.md`.
