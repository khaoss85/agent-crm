# LA0 — Legacy Characterization Harness (ExecPlan)

## The question the harness exists to answer

> **After Lead Intelligence moves out of the kernel, does it still decide the
> same things?**

Not "do the tests still pass" — they will, because they move with the code. Not
"does it conform" — `crm package test` answers that and says plainly, under
`DOMAIN_CORRECTNESS_NOT_PROVEN`, that it executes no action and evaluates no
policy. The acceptance criterion for an extraction has been the same since
ADR-018: **behaviour preservation, proved from the outside.** Nothing in this
repository could prove it, so nothing could honestly start.

LA0 is that proof, and it is built **before** the extraction, against the
current code. A characterization harness written after the move characterizes
the move.

**LA0 moves nothing.** No code is extracted, no helper is relocated, no ambient
field is replaced, no registry seam is added. It only writes down what is true.

## Three shapes compared

### Option A — whole-repository snapshots

Rejected. Serialize the database, the HTTP responses and the file tree, diff
them after. It is easy to build and useless to review: every diff is thousands
of lines in which a changed score and a changed row id look identical, and the
first false alarm teaches everyone to regenerate rather than read. It also
freezes everything — including the ids, the ordering and the bugs — so the first
legitimate refactor is blocked by a snapshot nobody can interpret.

### Option B — a generic extraction DSL

Rejected for v1. The tempting version is a declarative language for describing
"characterize this domain", reusable for Commercial and Signature later.

The rule this repository already applies: a new generic seam is added when **two
real consumers need the same domain-neutral bounded behaviour**. There is one.
Designing a DSL from a single domain produces a DSL shaped exactly like that
domain, and the second user then discovers it cannot express what they need.
Build the second characterization by hand, and let the shared shape be
*discovered* rather than invented — `characterization-contract.mjs` is
deliberately domain-neutral and small, so that when a second domain arrives the
reusable part is already separated from the Intelligence-specific part.

### Option C — a domain suite plus a stable evidence manifest (chosen)

```text
tests/characterization/
  characterization-contract.mjs      classification, canonical JSON, compare   (domain-neutral)
  intelligence-harness.mjs           the project + THE WIRING SEAM             (the one file extraction edits)
  intelligence-cases.mjs             the cases, each classified                (domain-specific)
  run-intelligence-characterization.mjs   runs everything, assembles a baseline
  intelligence-baseline.json         the frozen evidence
  intelligence-characterization.test.js   compares, and proves it can fail
scripts/characterize-intelligence.mjs     regenerates, explicitly
```

Every case is driven through the **public** surface — the SDK over a real HTTP
server, `/api/schema`, storage read back through the module API — because the
question is "does a consumer see the same thing", and an in-process call cannot
answer it.

## The one thing that must not happen: freezing bugs

A naive characterization suite records everything it observes as a contract, and
the extraction then has to preserve the bugs. Every observation carries a
**classification**, and only two of the four are compared:

| Classification | Meaning | Asserted? |
|---|---|---|
| `contractual` | documented, public behaviour | **yes** |
| `compatibility_required` | undocumented, but a real consumer depends on it today | **yes** |
| `incidental` | visible by accident — row ordering nobody specified, an id shape | recorded, never asserted |
| `defect_candidate` | looks wrong or unsafe | reproduced, documented, **never frozen** |

`incidental` is what stops the suite becoming a cement mixer: freezing a list
order nobody specified would forbid the index change the extraction may need.
`defect_candidate` is what stops it carrying a problem through the move and out
the other side — each one is a recommendation for a **separate pre-extraction
fix**, and changing one does not fail the suite.

### The two defect candidates found

Both on `record-signal`'s `value`, measured against this repository's own
conventions rather than an outside opinion:

- **unbounded text.** A 5,000-character value is accepted and stored. Every
  other text surface here is bounded — `MAX_TEXT` is 2,000 for a Solution Plan,
  `MAX_REASON` is 300 in `partner-scorecard` — and the field declares no length
  at all. Any caller can write it.
- **control characters stored verbatim.** `partner-scorecard`, the teaching
  example this repository points authors at, refuses them with `CONTROL_RE`.
  `record-signal` has no such check.

Everything else the hostile-input sweep found is correct and is frozen as
contract: values are stored byte-identical, which is right — escaping is a
rendering concern — and the SQL-shaped value passing proves the queries are
parameterized.

## The wiring seam

`intelligence-harness.mjs` is the only file that knows where Lead Intelligence
currently lives. It writes today's attachment — four actions built by
`intelligence-actions.js` into the project's action registry, and four
definition kinds in the fixed `packages/intelligence/generated/index.js` slot.
After the extraction, `wireIntelligence` writes one composition import instead.
**That is the whole diff.** Every case, every assertion and the baseline stay
byte-identical; if they have to change, the extraction changed behaviour.

The baseline records which `attachment` produced it, so a comparison across the
move can never silently be a comparison of two different applications.

## Baseline freshness

The baseline is tied to **content digests of the behaviour-bearing source** —
`intelligence-actions.js`, `intelligence-registry.js`, the starter's
definitions and the seven module manifests — not to a git SHA, which moves for a
typo in a README. An intentional pre-extraction behaviour change stales the
baseline and forces a deliberate regeneration, which is the review moment the
whole mechanism exists to create.

**Generation and verification are separate commands, and `verify` never
regenerates.** A harness that refreshed its own baseline during verification
would turn every behaviour change into a silent update — the one thing it must
never do. `npm run verify` compares; `npm run characterize:intelligence`
overwrites, and the resulting diff is what a reviewer reads.

## What is frozen

| Area | Frozen |
|---|---|
| architecture | the published definition kinds and their fingerprints, the lead actions advertised, the managed fields, and each action's full public contract — route, declared inputs, `fromStates` |
| enrichment | provider identity, version and fingerprint, the normalized snapshot, provenance, reuse of a non-expired snapshot, refusal of an unknown provider |
| signals | ingestion, the deterministic `sourceKey` format, duplicate refusal and its status, stored shape, refusal on an unknown lead |
| scoring | the total, the model identity **and version and declared-definition fingerprint**, every rule's matched/contribution, the persisted run, input-fingerprint stability, re-run as a new run, v2 alongside v1, refusal of an unknown version |
| routing | the decision, the run record, and the **target-set evidence** — every evaluated target with its eligibility and reason |
| assignment | the record created from routing and its links back to the lead |
| lifecycle | each of the four actions against a disqualified lead |
| audit/events/trace | the action vocabulary and **exact counts by action**; trace ordering is incidental |
| storage/restart | the same run, fingerprints and re-scored total after a process restart from the same database |
| scale | 60 leads through the whole pipeline, each with its total, fingerprint, matched rules, target and fallback reason |
| helpers | `computeDefinitionFingerprint` over 13 shapes plus its canonicality properties, and `withTimeout`'s three outcomes |

**779 individual values** are asserted, not a summary count — the ">500 exact
reads" requirement is met by asserting each value, because a count that matches
proves nothing about the values behind it.

### A score is not a number

The single most important assertion in the suite: a model returning the **same
number under a different fingerprint is a different decision**, and LA0 fails
it. A suite that compared totals would call that extraction a success.

## Mutation sensitivity

A characterization suite that cannot fail is decoration. Twelve mutations are
run against the comparator and each must be caught: a score keeping its number
while its fingerprint changes; a provider fingerprint; the routing target set; a
routing decision; a missing assignment; a missing audit event; a relaxed
lifecycle gate; scale correctness for one lead out of sixty; schema and action
metadata (route, inputs, `fromStates`); a neutral helper's behaviour; a case
that silently stops running; and an observation quietly reclassified from
`contractual` to `incidental` — which is how somebody would make a failing
extraction pass.

Two of those mutations found real bugs **in the harness itself** while it was
being built: `hostile-input` was reading a field the action result does not
return, so it measured nothing; and `architecture.action-inputs` read
`action.inputs` where the published field is `action.input`, capturing `[]` for
all four actions and asserting nothing at all.

## Determinism

No wall clock, no randomness, no network — every provider is a checked-in
deterministic fixture. Generated identifiers are normalized wherever they
appear, **including inside strings**: a `sourceKey` like
`signal:<leadId>:demo-requested:<observedAt>` embeds one, and that format is
itself contractual, so the format is frozen and the id inside it is replaced.
Getting that wrong made three records differ between two runs of identical code.

Run-input fingerprints (`leadFingerprint`, `signalsFingerprint`) are contractual
by **presence and stability**, not by value: they digest inputs that include the
lead's generated id, so they differ between throwaway projects by design. The
property that matters — identical inputs produce identical input fingerprints —
is asserted separately.

## Cost

| | |
|---|---|
| baseline generation | ~4 s |
| LA0 suite in `verify` | ~4 s |
| `npm run verify` total | ~164 s |

**2.5% of the suite.** Cheap enough to keep in the global run rather than behind
an extraction-only CI job — and it must stay in the global run, because its
value is catching an *unintended* behaviour change, which is exactly the kind
nobody remembers to run a special job for. No evidence was weakened for speed.

## What LA0 does not cover

`DETERMINISTIC_FIXTURES_ONLY` · `INCIDENTAL_NOT_ASSERTED` · `DEFECTS_NOT_FROZEN`
· `NOT_A_PERFORMANCE_BASELINE` · `CONCURRENCY_ONLY_WHERE_OBSERVABLE` ·
`ADMIN_SURFACE_NOT_MODELLED` · `SINGLE_ATTACHMENT_SHAPE`

Lead Intelligence contributes **no Admin section** today, so there is no Admin
behaviour to freeze — marked N/A honestly rather than inventing a UI to
characterize.

## Related

`docs/architecture/EXTRACTION_PREPARATION.md` (the gate and the decisions) ·
`docs/architecture/LEGACY_ALIGNMENT_MATRIX.md` · `DECISIONS.md` (ADR-015,
ADR-018) · `docs/plans/dx4-package-conformance-kit.md`
