# ExecPlan — signed commercial terms through quote, signature and order

**Status: in progress.** Branch `claude/signed-commercial-terms` from
`d801851` (all domains package-native; contracts at v5; `applicationOperations`
v1 context closed to its five keys). Prerequisite for M16b amendment
execution: before an amendment can change the current terms, the application
must be able to carry terms that **were actually signed**, with provenance
that never overstates.

## C0 — the gap, verified live at `d801851`

- The signed document package (`buildDocumentPackage`,
  `packages/signature/src/operations.js`) contains the priced lines, policy
  evidence, parties, totals and signers — **no term of any kind**. Verified by
  reading the full document constructor.
- Terms enter the system in exactly one place: `order.activate-contract`
  (`packages/contracts/src/activation.js`) takes `effectiveDate`,
  `termStartDate`, `termEndDate`, `autoRenew`, `renewalNoticeDays` and a
  required `termsReason` as **post-signature human input**, validated by
  `requireTerm` (`packages/contracts/src/dates.js`) and stamped
  `termsSource: "post-signature-operational-activation"` — the only value the
  three contracts manifests declare.
- The provenance contract already anticipated this milestone:
  `TERM_SOURCE_SIGNED` (`packages/contracts/src/lifecycle-capability.js`) is a
  runtime-exhaustive classification map whose own documentation says "the day
  M12 gains a source that *is* signed … a `true` here is therefore possible,
  and no consumer has to change for a signed term to become expressible."
  `contract-lifecycle-source@2` refuses to open while any declared
  `termsSource` value is unclassified.

The gap is exactly as briefed. Proceed.

## C1 — architecture decision: Option B, the immutable signed term snapshot

Option A (relabel operational terms as signed) is rejected — it would make
`termsSource` lie. Option C (defer) is not needed: the term is representable
without reopening any Commercial model, **but only as new sibling records**,
because the LA0 baselines freeze every surface a column or an action would
touch (see the frozen-surface inventory below). Chosen flow:

```
quote-term (draft, per quote)
  └─ quote.submit validates + snapshots →  quote-version-term (write-once, per version)
       └─ buildDocumentPackage embeds  →  document.terms  →  documentHash (signed bytes)
            └─ verified completion copies → order-term (write-once, per order)
                 └─ order.activate-contract consumes → termsSource: signed-order-terms
                      └─ contract-lifecycle-source@2 reports signed: true (M16b's input)
```

### The frozen-surface inventory that forces this shape

All three LA0 baselines must replay with **zero asserted movement**
(Signature `fe1875bf…` 110 obs, Commercial `82c1f02f…` 107, Intelligence
`f80592be…` 151). The following asserted observations pin, byte for byte:

| Frozen observation | Consequence for this design |
|---|---|
| `quote.created`, `versions.version-record/-lines/-components/-totals`, `completion-order.order-record/-lines/-components/-tiers/-grouped-totals` — **whole stored rows** | no new column on `quote`, `quote-version` or `order` family tables; the snapshot lives in **new records** the LA0 projects never apply |
| `architecture.quote-actions-advertised`, `…opportunity-actions-advertised` — action **name lists** | no new action on `quote` or `opportunity` |
| `architecture.action-contract.submit` (and add-line, update-line, remove-line, approve, reject, revise, create-quote) — full **input lists** | no new input on any existing commercial action; `submit` may gain *behaviour*, not inputs |
| `schema-metadata.request-signature-action-contract` — request-signature **input list** | no term input at signature time (correct anyway: terms freeze at version creation) |
| `document.package-structure` + the document-hash algebra observations | `document.terms` exists **only when the version carries a term row**; a termless version produces byte-identical canonical bytes and hash — extend, never reshape; `documentContract` stays `1` |
| `architecture.module-capabilities` / `managed-fields` iterate the harness's fixed `MODULE_NAMES` | new modules are invisible to the baseline as long as the harness manifest lists stay untouched (they do) |
| `unownedCommercialSource` / `unownedSignatureSource` sweeps require every package file to be digest-owned | the new manifests and any new source file join `BEHAVIOUR_BEARING_SOURCE` (harness seam edit; source digests are never asserted) |

Entry path decision, stated for the reviewer: draft terms are a **new
public-writable record** (`quote-term`) rather than a new action or a new
input, because every action surface a term could enter through is frozen by
the baselines. This is the first public-writable record in the commercial
family, and it is safe because a draft term binds nothing: it becomes
commercial fact only through `quote.submit` (which validates it and freezes a
write-once snapshot) and becomes a **signed** fact only through the existing
human signature ceremony (`request-signature` already refuses agent actors).
The human authority boundary is the signature, not the draft — exactly the C4
framing ("human author boundary is not RBAC").

## C2 — the term model (smallest bounded set)

`{ effectiveDate, termStartDate, termEndDate, autoRenew, renewalNoticeDays }`
plus derived `termDays`, a `termsContract: 1` version marker and a
`termsFingerprint` (sha-256 over the canonical term tuple, so consumers can
compare terms across versions without re-canonicalizing the document).

- Calendar dates validated through the **canonical round-trip authority**
  (`requireCalendarDate` in `packages/core`) — same rule contracts already
  uses; `2026-02-30` is refused, no timezone is ever inferred.
- `termEndDate` is **inclusive** (both boundary days inside the term), stated
  on every surface, matching the operational model so the two provenances are
  comparable.
- Same coherence rules as the operational validator, owned by commercial
  (`packages/commercial/src/terms.js`), because commercial cannot import
  contracts (dependency direction): start ≥ effective, end ≥ start, ≤ 3650
  days, `renewalNoticeDays` 0–365 integer ≤ term length and only with
  `autoRenew`.
- **Not modeled, deliberately**: termination and non-renewal clauses (nothing
  in this repository signs or stores them today — adding them would invent
  signed semantics no document carries), billing, tax, payment terms,
  revenue recognition, usage commitments. `renewalNoticeDays` remains
  recorded-only: no scheduler exists.
- `termsReason` does **not** exist on the signed path: the reason a signed
  term exists is the signature itself; the stored provenance says so.

## C3 — immutability and the document hash

- `quote.submit` reads the quote's `quote-term` row; if present it is
  validated (refusing submit with field-level errors on an incoherent term)
  and snapshotted into `quote-version-term` — write-once, fully managed, in
  the same transaction as the version itself.
- `buildDocumentPackage` gains `terms` **only when the version has a term
  snapshot**: `{ termsContract, effectiveDate, termStartDate, termEndDate,
  endDateInclusive: true, autoRenew, renewalNoticeDays }`. The hash covers
  the canonical bytes, so any term change after submission is a **new
  version with a new hash** — the same rule the priced lines already obey.
  Old inputs (no term row) canonicalize to byte-identical bytes.
- Verified completion re-derives the document from the version rows (the
  existing integrity check) — the rebuild includes the term snapshot, so a
  completion only succeeds when the stored term still matches the signed
  bytes — and copies it into `order-term` (write-once, one per order, same
  transaction as the Order).
- **No silent backfill**: existing signed orders have no `order-term` row and
  keep their historical provenance. Activation of such an order runs the
  operational path unchanged, input for input, message for message.

## C4 — consumption, provenance and compatibility

- `commercial-quotes@1` gains `versionTerm(versionId)` and
  `signature-orders@1` gains `orderTerm(orderId)` — frozen row or null.
  **Version decision, stated for the reviewer**: both stay at version 1.
  The M16a precedent moved a capability to @2 because *existing answers
  changed shape* (refusals added, `signed: null` introduced). Here every
  existing answer is byte-identical; a new read method is additive surface
  the next consumer opts into. The package versions move instead (they
  describe the composition contract): commercial 1→2, signature 1→2,
  contracts 5→6.
- Contracts: the three manifests widen `termsSource` with
  `signed-order-terms` (ADR-019 revision, enum-widen rebuild migration);
  `TERM_SOURCE_SIGNED` classifies it `true` — the exhaustiveness gate makes
  shipping the enum without the classification impossible.
  `order.activate-contract`: when the order carries a term snapshot, manual
  term inputs are **refused** (`SIGNED_TERMS_AUTHORITATIVE`) and the snapshot
  is copied; when absent, the operational path is unchanged and the manual
  inputs remain required at execution. `plan-activation` reports which case
  applies (`requiredInputs`, `termsProvenance`).
  `contract-lifecycle-source@2`'s `provenanceNote` becomes source-conditional
  (the hardcoded "OPERATIONAL metadata" sentence would lie about a signed
  row); `signed: true` flows from the map exactly as its design anticipated.
- Admin shows terms provenance as exactly one of **signed snapshot /
  post-signature operational / absent-unknown**, never collapsed: the quote
  view shows the version's signed term (when present), the contracts view
  labels the term by its stored source. Admin tests use the repository's
  fake-DOM harness; real-Chromium evidence remains the repository-wide
  manual gap (QUALITY_GATES §4) — recorded as a limitation, as every merged
  admin change before this one records it.
- Backward compatibility: old databases upgrade through the generated
  revision migrations (enum widen + new tables); an upgrade test on data
  that predates the feature follows the `service-operations-upgrade`
  pattern; detach/reattach and package-absence behaviour covered by the
  existing absence suites plus the composition rules (no new `requires`
  edges are added by this milestone).

## Records added

| Record | Package | Writability | Uniqueness |
|---|---|---|---|
| `quote-term` | commercial | public draft (first such record — see C1 rationale) | one per quote (`quoteId` unique) |
| `quote-version-term` | commercial | fully managed, write-once at submit | one per version (`versionId` unique) |
| `order-term` | signature | fully managed, write-once at completion | one per order (`orderId` unique) |

## Verification plan

Both commercial and signature LA0 baselines regenerated on the final tree and
replayed with **byte-identical asserted fingerprints** (intelligence replayed
too); new e2e: draft term → submit snapshot → hash coverage (same version
without terms hashes differently; a changed term is a new version/hash) →
completion `order-term` → activation signed provenance → `termEvidence`
`signed: true`; refusal edges (incoherent term at submit, manual term input
against a signed order, unclassified-source gate); ADR-019 upgrade test on
pre-terms data; full battery (`verify`, `smoke`, `gtm:check` with re-measured
tour counts, `app inspect`, `project doctor`, `project verify`, both
scenarios, `crm package test` across first-party packages); PR opened and
left OPEN for independent review; PROJECT_STATUS/TASKS untouched.

## Results of record

- **C0 confirmed live** before any design: the document builder carries no
  term; terms enter only at `order.activate-contract`; `TERM_SOURCE_SIGNED`'s
  own documentation anticipated a signed source. Option B implemented.
- **LA0 acceptance**: both baselines regenerated on the final tree —
  Signature asserted fingerprint
  `fe1875bf9cb68a5b4e8f55f79127cbec57581b9cd0e0b668569422e3cee9c82f` (110
  observations) and Commercial
  `82c1f02fa3545f9c72abbc89121b26cb5562b3d792755f414275732310f3fcf2` (107)
  **byte-identical** across the milestone; Intelligence `f80592be…` (151)
  untouched. Non-asserted movement: source digests only (the new
  `terms.js`, the three manifests, and the edited commercial/signature
  sources joined `BEHAVIOUR_BEARING_SOURCE`; the baseline applications'
  manifest sets deliberately did NOT gain the new records).
- **Hash-path evidence** (`tests/signed-terms-e2e.test.js`): a termless
  version's document has no `terms` key — the pre-terms bytes exactly; a
  termed version's `document.terms` is asserted value for value and its
  `documentHash` differs from the termless twin's; a different term is a
  different `termsFingerprint` AND a different hash; a draft edit after
  signature moves neither the version snapshot nor the order term.
- **Backward compatibility**: the operational path replays input for input
  (plan `requiredInputs`, refusal on missing dates, operational provenance,
  `signed: false`); `tests/signed-terms-upgrade.test.js` proves the ADR-019
  path — a genuine pre-terms project (single-value enum manifests, no term
  tables) activates a contract, adopts revision 2 (enum-widen REBUILD) plus
  the three new manifests, reads its history back byte-identical and still
  `signed: false`, then carries a new signed journey on the same database.
- **One framework defect found and fixed in scope** (`fix(cli)`): DX4
  applied a package's manifests alphabetically, so `quote-term.module.json`
  (< `quote.module.json`) hit the factory's "apply the target module first"
  refusal and failed `modules.applied` for commercial and every package
  composing it as a provider. `packageManifests` now orders in-set
  reference targets first — the rail's own documented doctrine — with a
  regression test. All seven first-party packages conform.
- **Tour re-measured**: 74 modules, 9 packages, 69 resources, 59 actions,
  7 policies, 1 providers — swept onto C-22, README, LAUNCH_PACKET,
  GO_TO_MARKET, the landing template, answers/concepts and the regenerated
  llms assets; `gtm:check` green.
- Doctor: passed, 0 warnings. Package tests: commercial 24/0, signature
  26/0, contracts 26/0 (others unchanged and green).
