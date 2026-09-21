# Semantic quality findings — desired-state JTBD catalogue

Audit of the **semantic quality of the catalogue records themselves**: how the
600 desired-state jobs are worded, distinguished and made testable.

This is not a coverage overlay. Nothing here assigns `not supported |
partially supported | technically supported | validated end to end` to
anything, and nothing here is a roadmap. Per `docs/jtbd/AGENTS.md`, catalogue
record, repository evidence, coverage overlay and roadmap are four different
things, and this document is confined to the first.

| | |
|---|---|
| Catalogue | `docs/jtbd/catalog/jtbd.jsonl`, 600 records |
| Catalogue SHA-256 | `c771e3c6b113903d5dc6e35dad6e793e345106e256aea586fedd062b3a611c28` |
| Detector | `docs/jtbd/tools/audit_semantic_quality.py` |
| Machine overlay | `docs/jtbd/quality/findings.json` — 715 findings |
| Catalogue records changed | **none.** `docs/jtbd/catalog/*` is frozen desired state |

Every record disposition below is a **proposal**. A human decides. The detector
is read-only and rewrites nothing.

## Reproducing this

```console
python docs/jtbd/tools/audit_semantic_quality.py            # summary table
python docs/jtbd/tools/audit_semantic_quality.py --stats    # corpus statistics
python docs/jtbd/tools/audit_semantic_quality.py --sweep    # threshold sensitivity
python docs/jtbd/tools/audit_semantic_quality.py --json     # regenerate findings.json
```

The script streams the 4.6 MB corpus line by line and never materialises it.
Output is deterministically ordered, so re-running it produces a byte-identical
`findings.json`.

## Proved and suspected

Two words are used strictly throughout.

- **Proved** — the finding follows from a mechanical property of the corpus that
  the script recomputes: a string equality, a set operation, a parse. Disagreeing
  with it means disagreeing with arithmetic.
- **Suspected** — the detector matched a lexicon or a similarity threshold. The
  candidate is real; whether it is a *defect* is a judgement call that needs a
  human read. Precision for these is reported below, measured, not asserted.

## Measured counts

Every number is from the script.

| findingType | count | proved | suspected |
|---|---:|---:|---:|
| CONTRADICTORY_JOB | 280 | 280 | 0 |
| TAUTOLOGICAL_OUTCOME | 261 | 261 | 0 |
| MISSING_DEPENDENCY | 89 | 89 | 0 |
| COMPOUND_JOB | 23 | 23 | 0 |
| UNREFERENCED_CAPABILITY | 20 | 20 | 0 |
| SOLUTION_PHRASING | 15 | 0 | 15 |
| NEAR_DUPLICATE_JOB | 10 | 0 | 10 |
| GRANULAR_UI_TASK | 6 | 0 | 6 |
| UNOWNED_PREREQUISITE | 4 | 4 | 0 |
| CONFLICTING_TERMS | 3 | 3 | 0 |
| CROSS_ROLE_DUPLICATE | 2 | 2 | 0 |
| ROLE_TRIGGER_INCOHERENCE | 2 | 2 | 0 |
| **TOTAL** | **715** | **684** | **31** |

Raw totals are **not** a quality score. 280 CONTRADICTORY_JOB rows are one
authoring rule applied 280 times, not 280 independent defects; the 715 findings
concentrate into roughly a dozen decisions.

Corpus statistics behind the findings (`--stats`):

```text
records 600 · roles 30 · role groups 9
distinct job_name (folded)            598
distinct job_statement.when             6
distinct use_case.trigger              19
distinct use_case.primary_flow blocks  10
distinct agentic_design.pattern        10
capabilities 225 · referenced 205 · core to >=1 job 116 · supporting-only 89 · unreferenced 20
human_approval_required=true 258 · target_autonomy=L3 471
```

## How much was actually read

The corpus was **not** semantically reviewed record by record. 600 records were
streamed by the detector; a sample was opened and read.

| findingType | candidates | read in full | confirmed | rejected |
|---|---:|---:|---:|---:|
| CROSS_ROLE_DUPLICATE | 2 | 2 pairs (4 records) | 1 | 1 (reclassified) |
| NEAR_DUPLICATE_JOB | 10 | 10 pairs (19 records) | 3 (+1 partial) | 6 |
| SOLUTION_PHRASING | 15 | 6 | 4 | 2 |
| COMPOUND_JOB | 23 | 4 | 4 | 0 |
| TAUTOLOGICAL_OUTCOME | 261 | 6 | 6 | 0 |
| CONTRADICTORY_JOB | 280 | 3 | 3 | 0 |
| GRANULAR_UI_TASK | 6 | 0 | — | — |
| UNOWNED_PREREQUISITE | 4 | verified by set arithmetic, not by reading | 4 | 0 |
| UNREFERENCED_CAPABILITY | 20 | verified by set arithmetic, not by reading | 20 | 0 |
| MISSING_DEPENDENCY | 89 | verified by set arithmetic, not by reading | 89 | 0 |

**36 distinct records were opened and read, out of 600.** The proved findings do
not depend on that reading — they are string equality and set arithmetic over the
whole corpus, recomputed by the script on every run — but the *suspected* ones do,
and their precision is only as good as the sample above. This audit did **not**
semantically review 600 records and does not claim to. GRANULAR_UI_TASK was not
confirmed at all; treat all 6 as unscreened.

## Detector method and thresholds

**Normalisation.** Lowercase, Unicode NFKD accent-stripping, punctuation removal,
whitespace collapse, then removal of Italian function words and tokens of two
characters or fewer. The corpus is Italian (`metadata.language: "it"`), so
`gestire i rinnovi` and `gestire rinnovi` must be one job, not two.

**Near-duplicate similarity: token-set Jaccard over normalised `job_name`.**
Chosen over embeddings or edit distance for three reasons: it is recomputable by
hand from the evidence string (which quotes both names and the shared token set),
it is stable under word reordering — which matters, because the strongest hit in
this corpus is a pure reordering — and it needs no model, so the finding set does
not drift when a model does. An LLM was used only to *confirm* candidates by
reading records; no LLM produced a candidate.

**Threshold: 0.60.** From `--sweep` over all 179,700 pairs (8,268 with non-zero
similarity):

| threshold | pairs at or above |
|---:|---:|
| 0.90 | 1 |
| 0.70 | 1 |
| 0.667 | 1 |
| **0.60** | **10** |
| 0.50 | 34 |
| 0.40 | 74 |

Job names here run 3–6 content tokens, so 0.60 is the point at which two names
share the verb *and* the object — 3 of 5 tokens, or 2 of 3. Below it the counts
inflate on generic verbs (`configurare`, `gestire`) that carry no shared meaning;
0.50 more than triples the candidate set and, on the pairs read, adds noise
rather than signal. 0.60 is a **recall/precision trade made deliberately toward
precision**: it is a floor for review, not a claim that the corpus contains
exactly 10 near-duplicates. Measured precision at 0.60 was 3/10 strict, 4/10
including one partial — so the threshold is honest but not tight, and a reviewer
should expect to reject about half.

**Compound jobs** are parsed, not guessed: the name is split on coordinating
markers (`e`, `ed`, `poi`, `nonché`, `oppure`, `,`, `/`, `;`) and Italian
infinitives are counted by suffix (`-are/-ere/-ire`). Two or more infinitives is
**proved** compound — two verbs are two jobs. Three or more coordinated objects
with one verb is a candidate only, and is not counted as proved.

**Lexicon detectors** (SOLUTION_PHRASING, GRANULAR_UI_TASK) are word-boundary
matches against curated term lists in the script. They are deliberately
over-inclusive and are all marked suspected.

## The highest-value findings

### 1. 280 records contradict their own autonomy definition — *proved*

Every record embeds an `autonomy_scale` defining **L3** as
`"agisce dopo approvazione"` — acts after approval. 471 records set
`target_autonomy: "L3"`. **280 of them set `human_approval_required: false`**,
while still carrying the acceptance criterion:

> `"Nessuna azione supera il livello L3; le azioni ad alto impatto richiedono approvazione esplicita e sono sempre revocabili o compensabili."`

Example — `ACC-JTBD-CRO-006`, Chief Revenue Officer, *Produrre forecast di
bookings, ARR e ricavi*: `target_autonomy: "L3"`, `human_approval_required:
false`, and the criterion above present verbatim.

The record asserts three things that cannot all hold. This is the most
consequential finding in the audit, because `docs/QUALITY_GATES.md` §2 makes the
policy/approval boundary a standing review category and `CLAUDE.md` makes
"AI may recommend but cannot silently override approval rules" non-negotiable.
A desired-state row that says *acts after approval* and *no approval required*
in the same breath cannot be used to test that boundary — and 280 rows say it.

**Recommended disposition:** `SET_APPROVAL_TRUE_OR_DOWNGRADE_AUTONOMY`. Each of
the 280 is either L3-with-approval or L2-without; the catalogue must pick.

### 2. Every job's context is a template, not a trigger — *proved*

- `job_statement.when` has **6 distinct values across 600 records** — exactly one
  per `platform_lifecycle`. All 240 RUN records share
  `"si verifica un evento operativo e devo portare a termine il lavoro con contesto completo"`.
- `use_case.primary_flow` has **10 distinct blocks across 600 records** — exactly
  one per `agentic_design.pattern`, with block frequencies matching pattern
  frequencies exactly (EXECUTE 157, CONFIGURE 120, OPTIMIZE 96, …).
- `use_case.trigger` has **19 distinct values**.

Both fields are pure functions of a classification field. That has a hard
consequence for the whole catalogue: **no record's situational context
distinguishes the role that holds it**, so near-duplicate and cross-role
duplication cannot be resolved by "different trigger, different job" — the
triggers are identical by construction. It also means `primary_flow` is not
testable evidence about any individual job; it describes the pattern.

**Recommended disposition:** `AUTHOR_ROLE_SPECIFIC_TRIGGERS` /
`AUTHOR_JOB_SPECIFIC_FLOWS`. Until then, treat `when`, `trigger` and
`primary_flow` as classification metadata rather than job content.

### 3. 261 records state an outcome that restates the want — *proved*

The `so_that` clause contains the `want` clause verbatim. `ACC-JTBD-CRO-001`:

> want: `"definire il modello revenue unificato"`
> so_that: `"ottenere un risultato ripetibile per «definire il modello revenue unificato» con dati affidabili, responsabilità chiare e impatto misurabile"`

"So that I get a repeatable result for «do the thing»" is not an outcome. It
cannot fail independently of the action, so it cannot be tested, and any
acceptance criterion derived from it is circular. 261 of 600 rows — 43.5% — have
no falsifiable benefit statement.

**Recommended disposition:** `REWRITE_SO_THAT_AS_INDEPENDENT_OUTCOME`. The
remaining 339 rows show the correct shape and can serve as the model — e.g.
`ACC-JTBD-INTEGRATION-DEV-006`: `"scambiare dati e azioni senza perdita,
duplicazione o rottura dei contratti"`.

### 4. Four prerequisites every job assumes and no job owns — *proved*

| Capability | Assumed by | Owned as core by |
|---|---|---|
| `GOV-001` "SSO e MFA" | all **600** records, precondition `"Utente autenticato con ruolo e record scope validi."` | **0 jobs — referenced by no job at all** |
| `DEV-018` "Versioned migration" | all **600** records, precondition `"Definizioni, policy e owner del processo sono versionati."` | **0 jobs — referenced by no job at all** |
| `AIA-019` "Human approval e exception inbox" | **473** records list tool `"Approval inbox"`; 258 set `human_approval_required: true` | **0 jobs — supporting only** |
| `AUT-003` "Azione multi-step" | **473** records list tool `"Workflow/action engine"` | **0 jobs — supporting only** |

The catalogue cannot be built in the order it states. Every job stands on
authentication, versioned policy, an approval inbox and a workflow engine, and no
job in the catalogue is accountable for delivering any of them. `AIA-019` is the
sharpest case: approval is the governance boundary the repository treats as
non-negotiable, 258 rows require it, and nobody owns building the inbox.

**Recommended disposition:** `ADD_AN_OWNING_JOB_FOR_THE_PREREQUISITE`.

### 5. Two jobs identical in everything but the role label — *proved, 1 of 2*

`ACC-JTBD-CS-DIR-009` (Direttore Customer Success) and `ACC-JTBD-CVM-012`
(Customer Value Manager / CSM), both *"Identificare expansion e advocacy"*, are
byte-identical in **`trigger`, `when`, `so_that`, `primary_flow`, `outputs`,
`acceptance_criteria` and `kpis`**. They differ only in `data.entities`, two of
six core capability ids, and `metadata.access_scope`. Same acceptance criteria
and same KPIs means one test satisfies both rows, so as desired state they are
one job.

The second pair, `ACC-JTBD-AE-006` / `ACC-JTBD-ABM-006` (*"Mappare buying
committee e relazioni"*), was **read and rejected as a duplicate**: KPIs are
fully disjoint (Win rate / Bookings / Sales cycle vs Engaged target accounts /
ABM pipeline / Buying committee coverage) and core capabilities share only
`AUT-001`. It is a **naming collision** — two genuinely different jobs given one
name — and its disposition is to rename, not to merge.

**Recommended disposition:** `MERGE_OR_DIFFERENTIATE_WITH_ROLE_SPECIFIC_TRIGGER`
for the first; rename for the second.

### 6. Near-duplicates: 10 candidates, 3 confirmed — *suspected, then read*

All ten pairs were read. Confirmed:

- `ACC-JTBD-MKT-DIR-014` *"Valutare attribuzione e incrementality"* vs
  `ACC-JTBD-PERF-MKT-014` *"Valutare incrementality e attribuzione"* —
  **Jaccard 1.00, a pure word reordering.** Same pattern (INVESTIGATE), same
  autonomy (L2), same `so_that`, same `trigger`. Nothing distinguishes them but
  the persona label.
- `ACC-JTBD-CRO-020` vs `ACC-JTBD-REVOPS-020` — *"Prioritizzare roadmap e
  differenziazione di Accordo"* vs *"Prioritizzare roadmap Accordo per impatto"*.
  Same pattern, autonomy, `so_that` and `trigger`; KPI overlap **0 of 10**. Same
  job measured two ways.
- `ACC-JTBD-CRO-015` vs `ACC-JTBD-DEAL-DESK-014` — both *"Ottimizzare"* discounts
  and margin, same pattern (OPTIMIZE/L3), same `so_that`, same `trigger`. Two
  roles own one commercial-policy job with no stated boundary between them.

Partial: `ACC-JTBD-CS-DIR-002` *"Disegnare onboarding e time-to-value"* vs
`ACC-JTBD-CVM-006` *"Gestire onboarding..."*. Design-vs-run is a legitimate
split, but the two records share `so_that` and `trigger`, so the catalogue does
not express the distinction it relies on.

Rejected on reading (6): `CRO-015/REV-FIN-008`, `CRO-016/REV-FIN-009`,
`CRO-010/CS-DIR-007`, `CS-DIR-011/CVM-009`, `SALES-MGR-012/CAMPAIGN-012`,
`PARTNER-002/ANALYTICS-003` — each pairs a different verb (govern vs forecast,
optimise vs evaluate, prepare vs govern) over a shared object, which is a real
role split, not a duplicate.

### 7. 23 compound jobs — *proved by parse, confirmed on 4*

Two infinitives in one name is two jobs in one row. Sharpest:

- `ACC-JTBD-CAMPAIGN-016` *"Riattivare, rinnovare ed espandere clienti"* — three
  verbs, three different lifecycle motions with different economics, one
  acceptance block.
- `ACC-JTBD-SDR-012` *"Qualificare e passare opportunità"* — qualification and
  handoff have different owners and different failure modes.
- `ACC-JTBD-AE-002` *"Importare e riconciliare account e contatti assegnati"* —
  import and reconciliation are separate jobs with separate failure modes.
- `ACC-JTBD-SERVICE-010` *"Instradare, escalare e fare swarming"* — the clearest
  case in the corpus, because the record convicts itself: three verbs in the name,
  and a `so_that` that covers only the **first** —
  `"assegnare ogni record una sola volta, al proprietario corretto, entro SLA e con motivazione"`.
  That is routing. Escalation and swarming appear in the job name and in no stated
  outcome, so two thirds of the row is untestable as written.

None can be satisfied or tested as one job.

### 8. Split vocabulary — *proved*

| Concept | Competing terms in use |
|---|---|
| opportunity | `deal` in 37 records, `opportunità` in 28 |
| customer | `account` in 28, `cliente` in 20, `customer` in 16 |
| pipeline | `pipeline` in 149, `funnel` in 24 |

Three concepts, eight surface terms, no glossary. The detector fires only when
the second-most-used variant appears in at least 5 records, so these are split
vocabularies rather than incidental synonyms.

### 9. Solution phrasing — *suspected, 15 candidates, 6 read*

Confirmed as naming an artefact rather than an outcome:
`ACC-JTBD-ANALYTICS-005` *"Creare dashboard operative ed executive"*,
`ACC-JTBD-ANALYTICS-003` *"Configurare accessi e certificazione dashboard"*,
`ACC-JTBD-CRM-ADMIN-009` *"Gestire template, viste e dashboard"*,
`ACC-JTBD-CRO-SPEC-014` *"Ridurre attrito e campi non necessari"*.

Rejected as false positives on reading: `ACC-JTBD-ENABLE-012` *"Raccogliere
feedback dal campo"* — `campo` here is *the field* as in field sales, not a form
field; and `ACC-JTBD-INTEGRATION-DEV-006` *"Implementare webhook e event
subscription"* — for an Integration/API Developer the webhook **is** the
deliverable, and its `so_that` is a genuine outcome (*"scambiare dati e azioni
senza perdita, duplicazione o rottura dei contratti"*). The remaining 9 are
unscreened.

## The 20 capabilities referenced by no job

Exactly 20 of the 225 catalogue capabilities appear in neither `capabilities.core`
nor `capabilities.supporting` of any of the 600 jobs. Set arithmetic, **proved**,
and consistent with the 205-referenced figure.

| Capability | Name | Domain |
|---|---|---|
| `AUT-005` | Job schedulato e ricorrente | Workflow & Automation |
| `AUT-016` | Workflow template e blueprint | Workflow & Automation |
| `AUT-018` | Agent-triggered workflow | Workflow & Automation |
| `COL-002` | Comment, mention e collaboration | Collaboration & Enablement |
| `COL-010` | Change communication | Collaboration & Enablement |
| `CSV-018` | Entitlement, contract e service eligibility | Customer Success & Service |
| `DAT-008` | Golden record e master data management | Customer Data Platform |
| `DEV-006` | Custom action e serverless function | Developer Platform |
| `DEV-018` | Versioned migration | Developer Platform |
| `GOV-001` | SSO e MFA | Governance & Security |
| `GOV-004` | DSAR, export e delete | Governance & Security |
| `GOV-012` | Vendor e connector governance | Governance & Security |
| `GOV-015` | Access review e recertification | Governance & Security |
| `GOV-016` | Data minimization e purpose limitation | Governance & Security |
| `MKT-008` | Web e in-app personalization | Marketing & Growth |
| `PLT-004` | Custom object e custom field | Platform Foundation |
| `PLT-009` | Ricerca, indicizzazione e viste | Platform Foundation |
| `PLT-014` | Localizzazione, valuta e fuso orario | Platform Foundation |
| `PLT-015` | Esperienza mobile e offline | Platform Foundation |
| `SAL-023` | Mobile sales workspace | Sales CRM |

The shape matters more than the count. **Five of the twenty are Governance &
Security** — SSO/MFA, DSAR, vendor governance, access recertification, data
minimisation — the largest single-domain cluster in the gap. A 600-job
desired-state catalogue in which no job needs authentication, no job needs a data
subject access request and no job needs access recertification has a blind spot
in exactly the area `docs/QUALITY_GATES.md` §4 lists as an unmet production gate.
The rest cluster into platform extensibility (`PLT-004`, `PLT-009`, `DEV-006`)
and mobile/offline (`PLT-015`, `SAL-023`), which read as deliberate scope
exclusions rather than oversights — but the catalogue does not say so anywhere,
and an unstated exclusion is indistinguishable from a gap.

A further **89 capabilities are supporting-only** — referenced by at least one
job but core to none (`MISSING_DEPENDENCY`). Concentrated in `DAT` (12), `AUT`
(11), `DEV` (11) and `AIA` (10). The extreme cases are `AUT-003` (supporting in
159 jobs, core in 0), `AIA-025` and `AIA-027` (98 each), and `AIA-019` (68).

## What was deliberately not attempted

- **No coverage or roadmap status.** Not assigned, not inferred, not implied.
  All 600 rows remain `NOT_ASSESSED`. The coverage/roadmap overlays are another
  agent's surface and this branch does not touch `docs/jtbd/coverage/`.
- **No catalogue rewrites.** No record was edited. The checksum below proves it.
- **No crosswalk to repository capabilities.** Whether Accordo implements
  `GOV-001` is a coverage question and out of scope; the finding is that no *job*
  references it.
- **No embedding or LLM-based similarity.** Ruled out by the reproducibility
  requirement — a threshold nobody can recompute is not a detector.
- **No cross-field semantic contradiction search** beyond the autonomy/approval
  rule. Detecting that two records' *outcomes* cannot both hold needs meaning, and
  a deterministic proxy for it would have been a lexicon pretending to be a proof.
  Stated as a gap rather than faked.
- **No per-record role/trigger plausibility judgement.** The corpus-level proof
  (finding 2) makes it moot: the triggers are templated, so no individual record
  can be shown incoherent against a trigger that was never role-specific.
- **GRANULAR_UI_TASK candidates were not read.** All 6 are unscreened; the
  detector's own lexicon includes verbs (`importare`, `chiudere`) that are
  ordinary business verbs in Italian, so expect low precision.
- **No `npm run verify`.** This branch adds two files under `docs/jtbd/quality/`
  and one under `docs/jtbd/tools/`, touching no code, no test, no manifest and no
  document that `verify` covers.

## Integrity

```console
$ sha256sum docs/jtbd/catalog/jtbd.jsonl
c771e3c6b113903d5dc6e35dad6e793e345106e256aea586fedd062b3a611c28
```

Unchanged from the branch point. The detector opens the catalogue read-only and
writes only to `docs/jtbd/quality/`.

## Overlay schema

`docs/jtbd/quality/findings.json`, one entry per finding:

| Field | Meaning |
|---|---|
| `findingType` | one of the twelve types in the counts table |
| `jtbdId` | the record, a capability id, or `CORPUS` for corpus-level findings |
| `jtbdIds` | the id pair or list, for findings about a relationship between records |
| `evidence` | the exact quoted field that shows it, kept short |
| `recommendedDisposition` | proposal only — a human decides |
| `reviewStatus` | `unreviewed` for all 715; no human has reviewed any finding |
| `basis` | `proved` or `suspected`, as defined above |
| `note` | the limit of what the detector can claim |

`reviewStatus` is `unreviewed` on every finding, including the 36 records read
during this audit. An agent reading a record is a confirmation, recorded in this
document; it is not a review.
