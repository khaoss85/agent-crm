# Matrix crosswalk — which desired job each coverage row is a claim about

Machine-readable form: `matrix_crosswalk.json`. Checked by `scripts/jtbd-gate.js`.

`docs/benchmarks/CRM_JTBD_MATRIX.md` is this repository's coverage record and predates the
desired-state catalogue by every milestone in it. Its rows are Accordo-primitive-shaped
("manage a custom business object", "create an immutable signed Order snapshot"); the
catalogue's are business-role-shaped ("configurare entità, campi, relazioni e layout",
"portare contratto a firma e close"). Neither is wrong. But until they are joined, a reader
cannot tell **which desired job a coverage row is a claim about** — and a coverage row that is
a claim about nothing in particular is the easiest kind to inflate.

## The five dispositions

Every matrix row gets exactly one. It is **derived** by `scripts/jtbd-gate.js` from the id
sets rather than typed, so a mapping cannot be labelled `identical` while citing three ids.

| Disposition | Means | Count |
|---|---|---|
| `identical` | one canonical job expresses this row, and no other row claims it | 81 |
| `split` | this row spans several canonical jobs | 16 |
| `consolidated` | this row shares its canonical job with at least one other matrix row | 40 |
| `superseded` | the row is retired in favour of another row that carries its evidence | 1 |
| `no_canonical_match` | nothing in the six hundred expresses this job | 26 |
| | **total rows** | **164** |

The 164 covers all 149 rows the matrix writes out plus the fifteen Cloud operator rows
(`CL-01…CL-15`) it declares in prose rather than in a table.

Distinct canonical jobs cited: **128** of 600. That is not a coverage number and must never be
read as one — it is how much of the desired portfolio this repository has so far written a row
*about*, in any status, including `not supported`.

## The v1 citation rule, and the one place it bends

**Every non-default coverage row must cite canonical JTBD ids.** 60 of the 164 rows carry a
non-default status (`partially supported`, `technically supported`, `validated end to end`),
and they cite 60 distinct canonical jobs between them.

Four of the 60 cite nothing, and the gate accepts them **only because each carries a written
`unmappedReason`**. A silent omission still fails with `JTBD_CROSSWALK_UNCITED`; what is
allowed is saying, in the file, that no canonical job exists. Bending it the other way — "must
cite, always" — would force a mapping to be invented, and inventing a mapping to satisfy a
gate is the failure this whole exercise is against.

| Row | Status | Why nothing matches |
|---|---|---|
| `JTBD-DS-02` create a delivery project from an Order | partially supported | the catalogue has no delivery or project-management persona among its thirty roles |
| `JTBD-DS-06` track hours and costs on delivery | validated end to end | no persona owns delivery effort capture; Revenue Finance works from bookings and revenue |
| `JTBD-DS-08` manage a Change Request with impact and approval | validated end to end | the catalogue's change jobs are configuration change and contract change, neither of which is a delivery change request |
| `JTBD-DS-09` collect customer acceptance on deliverables | partially supported | no canonical job records signed acceptance of a deliverable |

**All four are Delivery.** That is the finding, and it belongs to the *catalogue*, not to the
repository: a six-hundred-job corpus built around thirty commercial personas has a
delivery-execution blind spot, and Accordo has shipped four milestones into it. The count is
published as the generated fact `jtbd.crosswalk.unmapped_count`.

## The other 22 unmatched rows

All `not supported`, so the citation rule does not reach them, and each is recorded with a
reason anyway. They cluster:

- **Cloud operations (15).** No Cloud-operator persona exists in the catalogue. The operator
  jobs are specified in `CLOUD_JTBD.md`, a private-designated document.
- **Design-to-CRM (5).** No brand, visual-design or accessibility persona, and no canonical
  job starts from a design file.
- **Customer data operations (1).** `JTBD-DO-07` "search across modules" — the catalogue
  carries search only as capability `PLT-009`, which **no record references**.
- **Contracts (1).** `JTBD-CS-03` amend a live subscription in place.

## Where the drift is caught

The crosswalk copies each row's `matrixStatus`. When the matrix moves a table row and the
crosswalk is not updated, `scripts/jtbd-gate.js` fails with `JTBD_CROSSWALK_STATUS_DRIFT` —
two documents compared to each other, one layer out from ADR-039's document-versus-code check.
The prose rows (`JTBD-01`…`JTBD-15`) state their status in a sentence rather than a table cell
and are **not** covered by that comparison; that is a stated residual, not an oversight.

## The plan: this matrix becomes a generated view, and not in v1

The end state is that `CRM_JTBD_MATRIX.md`'s status columns are rendered from
`coverage.overlay.jsonl` and its ownership columns from `roadmap.overlay.jsonl`, so a status
exists in exactly one place. Three things have to be true first, and none of them is true
today:

1. **Every non-default row cites canonical ids without an exception list.** Four exceptions
   exist, and closing them means extending the *catalogue*, which is frozen and belongs to
   Phase D's desired-state owner, not to a generator.
2. **The prose rows become structured rows.** `JTBD-01`…`JTBD-15` carry actor, trigger,
   acceptance scenario, evidence, manual interventions and scope notes as paragraphs. A
   generator that owned them would delete the part a person wrote — the scope notes are
   the most load-bearing sentences in the document.
3. **ADR-039 `JTBD_ROWS_NOT_ENCODED` is amended, deliberately.** It holds that no job status
   is a generated fact and that only a person moves one. A generated matrix does not change
   who decides a status; it changes where the decision is *stored*. That is an ADR amendment,
   argued on its own, not a side effect of a tooling PR.

Until then the matrix stays hand-written and the crosswalk is what joins it to the catalogue.
