# LA0 characterization — Signature & Order (characterization only, no extraction)

**Status: in progress. This ExecPlan performs NO extraction and edits NO shared
runtime or source file.** It freezes the externally observable behaviour of the
Signature & Order domain (`packages/core/src/signature-operations.js`,
`signature-registry.js`, their HTTP routes, app methods, schema block, Admin
data and evidence rows) before any move, exactly as
`docs/plans/la0-legacy-characterization.md` did for Lead Intelligence.

Branch: `claude/signature-characterization`, from `origin/main` `5e53017`.
New files only: `tests/characterization/signature-*`,
`scripts/characterize-signature.mjs`, and this plan.

---

## 1. EARLY DELIVERABLE — the exact Signature/Order → Commercial consumption inventory

This section is written first and pushed first because the Commercial
characterization agent is blocked on it. Everything below is read off the
working tree at `5e53017`, file and line references included.

### 1.1 The headline finding

**Signature imports no Commercial code. Not one function.** The complete import
list of the two Signature kernel files:

- `packages/core/src/signature-operations.js` (1,080 lines) imports:
  `node:crypto`, `./errors.js`, `./external-operation.js`, `./time.js`,
  `./signature-registry.js`. Nothing else.
- `packages/core/src/signature-registry.js` (408 lines) imports:
  `node:crypto`, `./errors.js`, `./definition-fingerprint.js` (the neutral
  declared-definition module, already moved out of Intelligence). Nothing else.

There is no import of `commercial-actions.js`, `commercial-registry.js`,
`commercial-money.js` or `catalog-sync.js` anywhere in Signature, and no import
of any `signature-*` file anywhere in Commercial. The coupling is **entirely
through records and their semantics**, not through code. That is the boundary an
extraction has to preserve, and it is narrower than the file layout suggests.

### 1.2 Commercial records Signature reads, writes, and the exact call sites

All access goes through the module registry via the `trusted()` guard
(`signature-operations.js:107-116`), which requires the module to be a
read-only **managed** record module (`createManaged` present) and throws
`SIGNATURE_STORAGE_INVALID` (500) otherwise. Module names are configurable via
`resolvedNames(config)` (`signature-operations.js:87-104`) and default to the
`quote`-family names below. Signature therefore consumes Commercial's records
**by name**, at these sites:

| Commercial record | Access | Call sites (signature-operations.js) | Fields consumed |
|---|---|---|---|
| `quote` | read + managed write | action declaration `module: names.quote` (:333); `createCompletionEvidence` (:603-612); quote patch at completion (:803); `managed()` patch in `finalize` (:477) | read: `id`, `priceBookId`, `currency`, `status` (must be `approved` at completion or `409 VERSION_NOT_APPROVED`), `currentVersionId`; write (managed): `signatureEnvelopeId`, `signatureStatus` (finalize, :477), `orderId` + `signatureStatus: 'completed'` (completion, :803) |
| `quote-version` | read only | `requireApprovedVersion` (:303-324); `createCompletionEvidence` (:605-612); order snapshot copy (:690-718) | identity: `id`, `quoteId`, `versionNumber`, `submittedAt`, `opportunityId`, `currency`; **discount-policy evidence**: `policy`, `policyVersion`, `policyFingerprint`, `policyDecision` (`'reject'` refused :313), `decisionReason`, `maxLineDiscountBps`, `effectiveDiscountBps`; rollups copied onto the Order: `totalsJson`, `oneTimeNetCents`, `recurringGroupCount` |
| `quote-version-line` | read only (`listWhere({versionId})`, `countWhere`) | `buildDocumentPackage` (:222-224); `requireApprovedVersion` (:316); order-line copy (:680-744) | `id`, `versionId`, `offerId`, `offerLogicalKey`, `offerRevision`, `offerName`, `productId`, `productVersionId`, `sku`, `quantity`, `discountBps`, `componentCount`, `listAmountCents`, `discountAmountCents`, `netAmountCents`, `position` |
| `quote-version-component` | read only (`listWhere({versionId})`) | `buildDocumentPackage` (:225, :258-277); order-component copy (:745-771) | `id`, `versionLineId`, `componentId`, `componentKey`, `label`, `chargeType`, `pricingModel`, `interval`, `intervalCount`, `quantity`, `unitAmountCents`, `flatAmountCents`, `tiersJson` (parsed; per tier: `position`, `upTo`, `unitAmountCents`, `flatAmountCents` → order-tier rows :772-784), `tierBreakdownJson`, `listAmountCents`, `discountAmountCents`, `netAmountCents`, `provider`, `externalPriceId`, `sourcePricingModel` |
| `quote-version-total` | read only (`listWhere({versionId})`, `countWhere`) | `buildDocumentPackage` (:226, :279-294); `requireApprovedVersion` (:320); order-total copy (:787-802) | `kind`, `currency`, `interval`, `intervalCount`, `listAmountCents`, `discountAmountCents`, `netAmountCents` |

Not Commercial but adjacent, for completeness: `snapshotParties`
(:197-219) reads **host-CRM services** `services.opportunities`,
`services.companies`, `services.contacts` (fields: `id`, `companyId`,
`contactId`, `name`, `email`) exactly once, at request time; failures are
swallowed and the snapshot fields stay null. The parties snapshot is stored on
the envelope (`partiesJson`) and is the only party source ever used again.

### 1.3 Commercial functions and fingerprints: what Signature calls vs. copies

- **Functions called: none.** No Commercial function is invoked from Signature
  code, in either direction.
- **Fingerprints: copied opaquely, never computed.** `version.policyFingerprint`
  — produced by Commercial's discount-policy engine
  (`commercial-actions.js:465/573/604`) when the version is created — is
  embedded verbatim in the canonical document package
  (`buildDocumentPackage`, :238) and therefore inside the SHA-256
  `documentHash` that the provider signs. Signature never recomputes or
  validates it; a policy-fingerprint change in Commercial after versioning
  would surface only as `409 DOCUMENT_HASH_MISMATCH` at completion if the
  snapshot rows themselves moved.
- **Signature's own fingerprints** come from the neutral kernel
  (`computeDefinitionFingerprint`, `definition-fingerprint.js`), the same
  mechanism Commercial and Intelligence use — a shared *kernel* dependency, not
  a Commercial one.
- **Approval state consumed**: only `quote.status === 'approved'`
  (`fromStates: ['approved']` on the action, :340, re-checked at completion
  :610) and `version.policyDecision !== 'reject'` (:313). Signature never reads
  the `quote-approval` records or the approval workflow.

### 1.4 The semantic (non-code) contract Signature needs from Commercial

An extracted Signature package needs Commercial's capability contract to
guarantee, per quote version:

1. **Lifecycle facts**: `quote.status`/`currentVersionId` semantics — only the
   current, approved, non-rejected version is signable
   (`VERSION_MISMATCH`, `VERSION_SUPERSEDED`, `VERSION_NOT_APPROVED` :305-315);
2. **Snapshot immutability**: version lines/components/totals never rewritten
   after submission — the document hash is rebuilt from those rows at
   completion and must match byte-for-byte (:621-640);
3. **Snapshot completeness**: ≥1 line and ≥1 grouped total
   (`VERSION_SNAPSHOT_INCOMPLETE` :316-322);
4. **The column shapes** in the table above, including `tiersJson` /
   `tierBreakdownJson` encodings and the cents/bps money conventions
   (ADR-014) Signature copies without interpreting;
5. **Writable-managed seam on `quote`** for the four Signature-managed fields
   (`signatureEnvelopeId`, `signatureStatus`, `orderId` — declared in the
   project's `quote.module.json`, e.g.
   `examples/starters/b2b-lead-qualification/quote.module.json:70-81`), since
   Signature patches another domain's record at :477 and :803;
6. **A place to register the action**: `request-signature` is registered ON the
   `quote` module (`buildRequestSignatureAction`, :330-506), composed by the
   project's generated actions file (`tests/helpers/contracts-project.js:132-133`,
   starter `install.mjs:170-178`) — today a project file, not a package edge.

Downstream (for symmetry, not a blocker): Contract Activation — already a
package — reads Signature's `signature-envelope` and `signed-artifact` records
by module name (`packages/contracts/src/activation.js:38,84,87,203`) and the
`order` family; the same record-semantics seam question recurs there.

### 1.5 Verdict: `packages/core/src/external-operation.js` is a NEUTRAL kernel helper, not Signature-owned

Evidence, for and against, then the verdict:

- **It is imported by the kernel action runtime**
  (`action-runtime.js:8`), which runs the intent/external/finalize/compensate
  phases for **any** action declaring `externalOperation: 1`
  (`action-runtime.js:150`). That is a generic runtime path, not a Signature
  path.
- **It contains zero Signature vocabulary**: no envelope, signer, provider or
  quote concept — a generic phase sequencer (`runExternalOperation`), a
  bounded-timeout helper (`withExternalTimeout`), a phase-value freezer
  (`freezePhaseValue`), generic trace spans `<name>.intent|external|finalize|compensate`.
- **The matrix treats it as horizontal**: `LEGACY_ALIGNMENT_MATRIX.md:93` is a
  per-domain capability row — Signature `aligned — it is the contract's
  origin`, Commercial `partial` because catalog-sync predates it. A row that
  grades other domains against it is a capability row, not a domain file.
- **It is excluded from the measured extraction payload**: the M15 measurement
  (`LEGACY_ALIGNMENT_MATRIX.md:752`) counts Signature's kernel source to move
  as **1,488 lines, 2 files** = `signature-operations.js` (1,080) +
  `signature-registry.js` (408). `external-operation.js` (203) is not counted.
- **Honestly against**: `LEGACY_ALIGNMENT_MATRIX.md:52` lists it in Signature's
  "runtime home" row (historical origin — ADR-017 was the Signature
  milestone), and today `signature-operations.js` is the only *direct* caller
  of `runExternalOperation`/`withExternalTimeout` outside the action runtime
  (catalog-sync uses the neutral `withTimeout` instead). One-consumer-neutral —
  the same situation `computeDefinitionFingerprint` was in before the
  Blocker-1 helper move (`EXTRACTION_PREPARATION.md`), which was judged neutral
  by what it does, not where it sits or who calls it.

**Verdict: neutral helper. It stays in `packages/core` when Signature
extracts.** Consequence the integrator should relay: `runExternalOperation` /
`withExternalTimeout` are **not exported from `packages/core/index.js`** today
(only `withTimeout` and the fingerprint helpers are). An extracted Signature
package could reach the contract for its *action* via `externalOperation: 1`
(kernel-run), but its two app-level operations (`ingestSignatureEvent`,
`reconcileSignature`) call `runExternalOperation` directly — so extraction
needs either a public kernel export or a package-operations seam. That is a
capability-contract gap to record, not something this characterization changes.

### 1.6 Non-record kernel surface Signature occupies today (for the B7 section)

- HTTP routes owned in `apps/server/src/http-server.js`:
  `POST /api/signature/providers/:provider/events` (:245-257 — raw body,
  `{ rawBody: true, maxBodyBytes: 65_536 }`, system actor
  `signature:<provider>`, bounded `safeSignatureHeaders`) and
  `POST /api/signature/envelopes/:id/reconcile` (:262-266).
- App methods `app.ingestSignatureEvent` / `app.reconcileSignature` wired in
  `packages/app/src/create-app.js:241-254`; registries constructed at :142 from
  `packages/signature/generated/index.js` (`generatedSignatureProviders`).
- `/api/schema` block `signature` = `SignatureRegistries.metadata()`
  (`http-server.js:219`, `signature-registry.js:381-407`).

---

## 2. Approach (why this shape)

Three candidate shapes were considered, mirroring the Intelligence LA0:

1. **Reuse the Intelligence harness files directly** — rejected: they are
   shared characterization runtime for another domain's baseline; the brief
   forbids editing shared files, and their case corpus is domain-specific.
2. **A fresh ad-hoc test file with inline assertions** — rejected: no
   record/replay baseline, so a post-extraction run could not diff decisions;
   that is the failure LA0 exists to prevent.
3. **A Signature-owned copy of the LA0 pattern** (chosen): new
   `tests/characterization/signature-*` files implementing the same
   `legacyCharacterizationContract: 1` discipline — observation corpus,
   checked-in JSON baseline with exact values, source-digest staleness
   signal, a `scripts/characterize-signature.mjs` regenerator, and a test
   that replays the corpus against the current tree and fails on any moved
   value. Same contract, zero shared-file edits.

## 3. Freeze list (what the baseline must pin, with VALUES)

- provider contract: required handlers, identity validation, fingerprints,
  duplicate/ambiguous registration, metadata block field-for-field;
- envelope state machine: full transition table, terminal states,
  self-transitions, unknown states;
- canonical document: `canonicalJson` shapes (key order, arrays, unicode,
  non-finite refusal, `__proto__`/non-plain refusal), exact `documentHash`
  values, `DOCUMENT_TOO_LARGE` bound;
- signer normalization: bounds, email rules, dedupe, ordering, hostile input;
- request-signature: human-actor refusal, `ENVELOPE_EXISTS`, envelope/signer
  rows, instant-completion path, compensate-to-`failed` with
  `failurePhase`/`failureCode`;
- webhook ingestion: verification-before-state, HMAC window ±300 s inclusive,
  malformed headers, `SIGNATURE_INVALID` opacity, replay same-id-same-bytes,
  `EVENT_ID_CONFLICT` same-id-different-bytes, out-of-order `ignored`,
  after-terminal `ignored`, failed-processing redelivery resume, quarantine
  and later linking, `effect`/`effectReason` values;
- completion atomicity: one order per quote version, order/lines/components/
  tiers/totals exact values, `DOCUMENT_HASH_MISMATCH` on moved snapshot and on
  corrupted stored bytes, immutability against later catalog movement;
- reconciliation: terminal short-circuit, absent-at-provider →
  `PROVIDER_ENVELOPE_ABSENT`, idempotency-key recovery,
  `PROVIDER_ENVELOPE_MISMATCH`;
- external-operation semantics: phase order, timeout outcome, late settlement
  abandoned, trace span names and statuses, compensation failure visibility;
- races and restart: two-connection duplicate webhook, webhook vs reconcile,
  kill-between-phases recovery;
- exact audit/event/trace counts per journey, replay creating none;
- API/SDK/schema/Admin read surface; AX1 (`app inspect`) signature facts and
  AX2 plan bindability.

## 4. Verification plan

- full existing suite green before (baseline) and after (this branch);
- `npm run crm -- project doctor --json` green;
- characterization runner green against its committed baseline;
- no PR opened; branch pushed for the integrator.

Sections 5+ (B7 route/webhook seam evidence, readiness statement, results) are
appended as the work completes.
