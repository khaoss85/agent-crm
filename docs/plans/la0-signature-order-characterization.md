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

## 5. What was frozen (results)

Baseline: `tests/characterization/signature-baseline.json` —
`legacyCharacterizationContract: 1`, domain `signature-order`, attachment
`kernel-wired-action-and-fixed-provider-slot`, **109 observations / 1,214
asserted values** (95 `contractual`, 3 `compatibility_required`, 2
`incidental`, 1 `defect_candidate`, 8 `pre_extraction_evidence`). Generated
three times; consecutive runs were byte-identical across every observed
value, and the one deliberate late addition (the terminal-state idempotency
refusal) regenerated as exactly one added observation with zero moved values
— the reviewed-regeneration loop demonstrated on this domain too.
Regeneration: `node scripts/characterize-signature.mjs` (npm alias arrives at
extraction time by design).

Highlights, by family:

- **provider contract**: required handlers, identity/config validation,
  registration refusals (dup identity, `__proto__` name), Map-backed lookup
  (`PROVIDER_AMBIGUOUS` on by-name with two versions), fixture fingerprints by
  exact value; normalization refusals for envelopes/events/artifacts
  (`PROVIDER_INVALID` 502, provider may never assert `preparing`/`failed`);
  idempotency-key-is-a-lookup checks (`PROVIDER_ENVELOPE_MISMATCH` on hash,
  signer set, envelope id; no-echo weaker guarantee accepted).
- **document**: canonical JSON over ten shapes with exact serializations,
  refusals (non-finite, function, non-plain object), an exact fixed-document
  SHA-256, CRLF/LF and NFC/NFD and `1`/`"1"` divergence, hash-covers-exact-bytes,
  `DOCUMENT_TOO_LARGE`, locale-independent `byteOrder`; the full parsed
  document-package structure of a real envelope (ids tokenized positionally).
- **envelope lifecycle**: the full 8×8 transition matrix (unknown state
  included) cell by cell; `ENVELOPE_EXISTS` (409) on repeat request;
  `HUMAN_APPROVAL_REQUIRED` (403) for agent actors with the exact message;
  `VERSION_MISMATCH`; failed-envelope-cannot-resend; declined/voided terminal
  facts (no order, signer evidence, quote.signatureStatus stays at its
  finalize-time value — recorded with the note that downstream consumers read
  the envelope).
- **webhook**: applied/ignored/quarantined `effect`+`effectReason` values;
  replay same-id-same-bytes = stable duplicate; same-id-different-bytes =
  `EVENT_ID_CONFLICT` 409; out-of-order ignored; after-terminal ignored with
  `envelope already completed (terminal)`; failed-processing redelivery
  RESUMES (inbox row `processed:false, effect:pending` after fault, exactly
  one complete order after retry); quarantine of unknown-envelope events and
  their adoption at reconcile; HMAC verification outcome table with injected
  clock — inclusive ±300 s boundary (300 in, 301 out, both sides), malformed
  headers, wrong key/body, invalid-UTF-8 bytes verified as bytes; the HTTP
  route's 401 `SIGNATURE_INVALID` that never echoes the payload; unknown and
  `__proto__` provider names 404; oversized raw body refused at 64 KiB;
  verified-but-hostile payload (`__proto__`/`constructor` keys) quarantined
  with no prototype pollution.
- **completion & Order**: request/finalize evidence dumps (envelope, signers,
  parties snapshot, quote managed fields); the completed envelope, signed
  artifact (signer evidence JSON, artifact linkage to its completion event,
  provider-reported artifactHash), and the entire Order snapshot — order row,
  lines, components (tier schedules and band breakdowns parsed), tiers,
  grouped totals — with every amount in cents asserted by exact value;
  exactly-one-order proof; instant-terminal `createEnvelope` answers complete
  with artifact+order; immutability proven by mutating catalog prices,
  deactivating offers and renaming every company, then re-reading byte-identical
  evidence.
- **external-operation semantics**: `DEFAULT_EXTERNAL_TIMEOUT_MS` (5000);
  resolved/rejected/timed-out outcomes with exact messages; late settlement
  abandoned with no unhandledRejection; `freezePhaseValue` (frozen plain JSON,
  functions/cycles/non-plain refused, dangerous keys dropped); trace span
  names/statuses for the successful request (`…intent/external/finalize`),
  the failed request (`…external` failed + `…compensate` completed), and the
  completion event run; provider outage → compensate → `failed` with
  `failurePhase`/`failureCode`; provider timeout → `PROVIDER_TIMEOUT` 504.
- **reconciliation**: terminal short-circuit (`terminal`), absent-at-provider
  (`PROVIDER_ENVELOPE_ABSENT`, honest `failed`), foreign-envelope refusal
  leaves state untouched, idempotency-key recovery after a real crash.
- **races & restart**: a real killed child process (exit 9 during finalize)
  → intent survives as `preparing` with no provider id → re-request refused →
  reconcile recovers by idempotency key → exactly ONE envelope ever; two app
  instances on one database ingesting the same completed event → one order,
  one inbox row, no raw SQLite error (interleaving detail recorded as
  incidental); webhook racing reconcile → one order, one artifact; full
  restart → envelope/order/schema byte-identical, reconcile a safe no-op.
- **audit/events/trace exactness**: exact per-entity audit deltas for the
  request (envelope 3, signer 1, quote 1, rest 0) and the completion
  (envelope 1, signer 1, event 2, artifact 1, order 1, line 1, component 3,
  tier 3, total 2, quote 1); exact dispatched domain-event counts per stage;
  a replay creates **zero** of everything; trace vocabulary and event-run
  status counts.
- **scale**: 520 inbox rows past the 500-row display bound — exact
  `countWhere`, exact row lookup beyond the bound, bounded paged list.
- **AX1/AX2**: `crm app inspect --json` exits 0, `valid`, and cites
  `request-signature`, `signature-envelope` and `order` (the facts a Solution
  Plan binds to); where the provider slot appears is recorded as
  `pre_extraction_evidence`, because the extraction moves it.

**Defect candidate (1), reproduced and not frozen**: signer `name`/`role`
accept control characters — a newline is stored verbatim, and a NUL byte is
accepted but **not stored byte-identically** (silent storage mutation), on
data that becomes part of the signed document package. The identical class was
already fixed for `record-signal` in `1e40d1e`, and `partner-scorecard`
refuses control characters. Recommended: the same write-time refusal on signer
text fields, as a separate pre-extraction fix.

### Gaps — what could not be frozen, and why (declared, not discovered)

- Ingest/reconcile timestamps (`receivedAt`, `failedAt`, reconcile-path
  `sentAt`…) are wall-clock: `createSignatureOperations` does not receive the
  injected app clock (`create-app.js` passes `now` to `runRecordAction` but
  not to the signature operations), so these fields are asserted by presence
  only. A small clock-injection improvement candidate — behaviour-visible only
  in timestamps, deliberately not smuggled into this branch.
- The fine interleaving of the two-connection race is scheduling-dependent and
  recorded as `incidental`; the deterministic contract (one order, one winner,
  no raw SQLite error) is what is asserted.
- Only the deterministic fixture provider exists; no real provider's error
  shapes, artifact formats or webhook cadence are characterized (none exists
  to characterize — `docs/SIGNATURE_ORDER.md` claims none).
- Admin is characterized at the data level (the reads its screens make, the
  refusals on writes), not as rendered DOM — the repository-wide manual
  browser gap (`QUALITY_GATES.md` §4).
- AX2 is frozen as inspect-citability facts, not as a full
  `solution check` round-trip: a plan is bound to a composition digest, and an
  extraction *changes* the composition, so `PLAN_STALE` after the move is
  designed behaviour, not a regression a characterization may freeze.

## 6. B7 evidence — the Signature-owned HTTP seam (record only, nothing built)

Where owned today (`apps/server/src/http-server.js`):

- `POST /api/signature/providers/:provider/events` (:245-257): registered
  with `{ rawBody: true, maxBodyBytes: 65_536 }` — the ONLY route in the
  kernel server using the raw-body option; passes exact bytes to
  `app.ingestSignatureEvent`, bounds headers through `safeSignatureHeaders`,
  and constructs the actor itself: `{ type: 'system', id: 'signature:<provider>' }`.
- `POST /api/signature/envelopes/:id/reconcile` (:262-266): plain JSON route
  delegating to `app.reconcileSignature` with the caller's actor.
- Both methods wired on the app object in `packages/app/src/create-app.js`
  (:241-254); `SignatureRegistries` built from the fixed slot
  `packages/signature/generated/index.js` (:142).

**Why generated actions/resources do not suffice for the webhook** — four
structural mismatches, each measured against the action runtime:

1. **Identity.** A record action is addressed
   `/api/modules/:module/records/:id/actions/:action` — by CRM record id. A
   webhook's identity is `(provider, providerEventId)`, and the target
   envelope may not exist locally at all (the quarantine case is contractual:
   the event is evidence before it has a record to attach to).
2. **Bytes.** Action input passes `readJson` → `validateActionInput` →
   `sanitizeJsonSafe`: decoded, validated, re-shaped. Verification must see
   the exact bytes the provider signed — a re-serialization would verify a
   different document, and invalid UTF-8 would be silently replaced (both
   frozen in the baseline).
3. **Actor.** Actions take the authenticated caller's actor from headers. The
   webhook caller is unauthenticated by design and authenticated by HMAC; the
   route synthesizes the system actor itself and never trusts headers for it.
4. **Refusal shape.** A verification failure must be a stable 401 that echoes
   neither payload, signature nor key — not a validation error envelope that
   reflects input back.

**Could a declared action solve it?** For **reconcile — nearly yes**: it
addresses an existing record (`signature-envelope`) by id, takes no raw body,
uses the ordinary actor path, and its runtime shape is exactly an
`externalOperation: 1` action (read-only intent, provider call, finalize).
Two things stop it today: envelope records are read-only managed modules with
`get`/`list` capabilities only (an action registration would make the module
action-eligible, a public-surface change), and the operation lives on the app
object, not the action registry. For **the webhook — no**: mismatches 1–4 are
contract-level, not registration-level.

**Would a package need a custom endpoint?** Yes — an extracted Signature
package needs exactly one: the webhook. Reconcile could ride a declared action
if the record-capability question above is answered; the webhook cannot.

**The exact contract a generic package-route seam would need** (measured from
what the signature route consumes today — this is the B7 shopping list):

- **declaration**: method + path template, declared by the package and
  namespaced/collision-checked at composition, visible in `app inspect` and
  gone on detach (the matrix's detach/reattach proof);
- **raw body**: an opt-in `rawBody` mode delivering unmodified bytes with a
  package-declared `maxBodyBytes` bound (65 536 here);
- **headers**: a package-declared allowlist, lowercased and size-bounded
  before provider code sees them (today: `safeSignatureHeaders`);
- **actor synthesis**: the declaration states the system-actor identity the
  handler runs as (`signature:<provider>`); the seam must NOT hand the
  handler an authenticated-user actor path;
- **execution**: handler runs outside any transaction and reaches only the
  package's own operations (which internally use `runExternalOperation` for
  transaction discipline, trace and events);
- **refusals**: kernel-normalized error envelope with stable codes, never
  echoing the raw body — the 401/404/409 semantics frozen in this baseline;
- **schema**: the endpoint published as package metadata (today the
  `eventEndpoint` string in `signature.metadata()` — already the right shape).

## 7. Readiness statement

**No extraction was performed, no shared runtime/source file was modified, no
package.json edit was made.** The branch adds exactly: this plan, five files
under `tests/characterization/signature-*`, and
`scripts/characterize-signature.mjs`.

Before a Signature & Order extraction can start it needs, in order:

1. **From Commercial's capability contract** (the §1 inventory is the spec):
   guaranteed read access to `quote`, `quote-version`,
   `quote-version-{line,component,total}` with the exact field shapes of
   §1.2; the lifecycle semantics (`status === 'approved'`,
   `currentVersionId`, `policyDecision`); snapshot immutability after
   submission; the managed-write seam for the four signature-managed quote
   fields (or an inversion where Commercial consumes signature events); and a
   home for registering `request-signature` on the quote record. Note DX4's
   finding: acting on **host-application** records is ordinary and passes
   `package test` — the quote family is host-supplied manifests today, so the
   hard requirement is the *semantic* contract, not a code seam. No code
   import edge exists to design (§1.1).
2. **From the kernel**: the package HTTP-route seam of §6 (webhook), an
   answer for reconcile (declared action vs seam route), and either a public
   `packages/core/index.js` export of `runExternalOperation`/
   `withExternalTimeout` or an app-operations seam — neither is exported
   today (§1.5), so the package could not run `ingestSignatureEvent`/
   `reconcileSignature` at all.
3. **The pre-extraction fix** for the signer control-character defect
   candidate (§5), so the extraction PR does not mix a behaviour change with
   a move — the exact sequencing lesson LA0 recorded for Lead Intelligence.
4. Then: extraction against this baseline, with
   `tests/characterization/signature-harness.mjs` as the only
   characterization file the move edits.
