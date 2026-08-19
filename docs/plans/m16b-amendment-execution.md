# ExecPlan — M16b Renewal & Amendment Execution from signed evidence

**Milestone:** M16b. **ADR:** ADR-034. **Branch:**
`claude/milestone-16b-amendment-execution`, from `e2ab00c`.

M16a records renewal *intent* and hands off. ADR-033 made a commercial term
**signed evidence** rather than post-signature operational metadata. M16b is the
execution counterpart of the first and the first real consumer of the second: a
**governed successor commercial agreement produced from immutable signed
evidence, and refused when that evidence is merely operational.**

## 1. The scope decision, made against the live architecture

Three shapes were compared before any code was written.

| Option | Verdict |
|---|---|
| **A — amend the source Contract in place** (new terms and lines on `commercial-contract` / `subscription`, history in a side table) | **rejected.** It rewrites what was agreed. Every M12 record is a snapshot of a signed instrument; overwriting `termStartDate` on the row that names `documentHash` H makes that row disagree with the document it cites, permanently and silently. `subscription.contractId` is UNIQUE, so the amended subscription could not carry the successor's own lines either. |
| **B — successor Contract Version on the same Contract** (`contract-version` 2, 3, …) | **rejected, though it looked natural.** `contract-version` already exists and is immutable, but the *contract row itself* carries the term (`termStartDate`, `termEndDate`, `termsSource`), and `currentVersionId` is a pointer. Moving the pointer without moving the term leaves the contract describing version 1's term while pointing at version 2; moving the term is Option A wearing a hat. And the UNIQUE `subscription.contractId` again forbids the successor subscription. |
| **C — successor Contract, with an immutable lineage record** | **chosen.** A successor commercial agreement *is* a new agreement: it has its own signed Order, its own document hash, its own term and its own subscription. It is therefore an ordinary M12 activation — identical in shape, written by the identical code path — plus one immutable `contract-succession` row that says which agreement it replaces. Nothing historical is touched, by construction rather than by discipline: **M16b executes no `UPDATE` against any pre-existing contract, version, line, subscription or obligation row.** |

The consequence worth stating: **the successor is not a special kind of
contract.** Reading it needs no M16b vocabulary; every M12/M13/M15 consumer
handles it already. Only the *lineage* is new.

### Why it is buildable now, and was not at M16a

M16a's plan recorded the blocker verbatim: "Pricing lives in Commercial and
signature in Signature, and both are still inside `packages/core` with no
capability to reach them." Both were extracted afterwards, and ADR-033 added
the missing fact — a term the customer actually signed. The blocker is gone;
the deferral is discharged rather than forgotten.

## 2. What this milestone is NOT

Not implemented, not stubbed, not implied anywhere in code, schema, Admin copy
or documentation: **billing · invoicing · payment · tax · usage rating ·
proration · revenue recognition · MRR/ARR/TCV · any scheduler · automatic or
clock-driven renewal · customer notification of any kind · RBAC or role
enforcement · arbitrary cancellation · retroactive mutation of any historical
record · price computation of any kind · any live catalog read.**

Two of these are the milestone's real temptations and get a named guard:

- **Automatic renewal.** `autoRenew` and `renewalNoticeDays` remain
  recorded-only on both provenances. No state in M16b moves on a date. Every
  transition has a human actor, and the state machine has no clock input at all.
- **"Signed" as a label.** M16b refuses to execute against an Order whose
  signed document carried no term (`SUCCESSOR_TERMS_NOT_SIGNED`). It never
  derives a successor term from an operational one, and it never re-labels an
  operational provenance. This refusal is the milestone's core invariant, and it
  is proven by test rather than asserted here.

## 3. Ownership split — declared capabilities only, nothing in `packages/core`

| Package | Owns |
|---|---|
| **Lifecycle** | planning, orchestration, the renewal/amendment **cycle** and its evidence: `amendment-run`, its state machine, and the five actions a human drives. |
| **Contracts** | the immutable successor activation and the **lineage**: `contract-succession`, the authoritative recomputation, the delta and its classification, and the new capability. |
| **Commercial** | unchanged. Quote / version / pricing / term evidence, reached through `commercial-quotes@1`. |
| **Signature** | unchanged. Signed document and Order evidence, reached through `signature-orders@1`. |

`packages/core` gains nothing. No package imports another's private module. The
one new edge is a declared capability:

```
lifecycle ── requires ──▶ contracts/contracts-successor-activation@1
lifecycle ── requires ──▶ contracts/contract-lifecycle-source@2      (M16a, unchanged)
contracts ── requires ──▶ signature/signature-orders@1               (M12/M16a, unchanged)
```

**Why the delta and the classification are computed inside Contracts, not
Lifecycle.** Lifecycle is the orchestrator and could compute a delta from two
capabilities it already holds. It must not: a label Lifecycle computes and hands
to Contracts is a **client-provided classification**, which D5 forbids and which
no amount of validation makes authoritative. Contracts owns the source contract
lines and already declares the Signature edge, so it is the one package that can
derive the delta from immutable evidence it reads itself. `planSuccession()` and
`executeSuccession()` therefore call **one** derivation function, so a plan and
an execution can never disagree about what the delta is.

## 4. Plan versus execute

| | `plan-amendment` | `execute-amendment` |
|---|---|---|
| Writes | **nothing** — no record, no audit, no domain event | the successor and its lineage, in one transaction |
| Actor | any | `actor.type === 'user'` only |
| Trust in the plan | none | **none** — every input is recomputed from immutable evidence inside the transaction |

A stale plan authorises nothing. `execute-amendment` accepts a
`successorOrderId` and a policy identity and re-derives everything else: the
signature evidence, the signed term, the customer coherence, the delta, the
classification, the term continuity and every refusal. The run's recorded
`ready` state is explicitly **an observation, not an authorisation** — the
record says so in its own description, and a run that was `ready` an hour ago is
still refused if the evidence moved.

## 5. The successor model

```
commercial-contract A ──┐
  (source, untouched)   │
                        ├─▶ contract-succession  (immutable, 1:1:1)
signed Order X ─────────┤        sourceContractId    UNIQUE
  (successor's own)     │        successorContractId UNIQUE
                        │        successorOrderId    UNIQUE
                        └─▶ commercial-contract B  (+ version 1, lines,
                                subscription, subscription lines, obligations)
```

**One execution per source, enforced by the database.** Three UNIQUE columns on
`contract-succession`, plus the two `commercial-contract` / `contract-activation`
UNIQUE `orderId` columns M12 already has. No in-process lock, no advisory flag,
no read-then-write window that a second connection can walk through: the losing
connection's whole transaction rolls back and it receives a stable code.

- `sourceContractId` UNIQUE — a contract has at most one successor. **No split
  lineage** is a schema fact.
- `successorContractId` UNIQUE — a contract has at most one predecessor.
- `successorOrderId` UNIQUE — a signed Order is consumed at most once; combined
  with M12's UNIQUE `commercial-contract.orderId`, an Order already activated
  standalone can never be adopted as a successor either.

**Signed Order identity is preserved.** The successor's commercial content is
copied from Order X by the same `writeActivation()` used by
`order.activate-contract` — same amounts, same tier schedules, same grouped
totals, same `documentHash`, same `sourceFingerprint`. No amount is
recalculated and the catalog is never read.

**Customer coherence** is required: Order X's `companyId` must equal the source
contract's `companyId` (and, when either lacks one, `customerEmail` must match).
A mismatch is `SUCCESSOR_CUSTOMER_MISMATCH`, refused rather than recorded.

**Term continuity is explicit and recorded, and blocks only when incoherent.**
Against the source's inclusive `termEndDate`:

| Relation | Recorded as | Blocks? |
|---|---|---|
| successor starts the day after the source ends | `contiguous`, `gapDays: 0` | no |
| successor starts later | `gap`, `gapDays: n > 0` | no — a lapse then a re-signing is real |
| successor starts on or before the source's end | `overlap`, `gapDays: n < 0` | no — a mid-term expansion is real |
| the source has no readable end date | `unknown` | no |
| successor starts **before the source's start** | — | **yes**, `SUCCESSOR_TERM_PRECEDES_SOURCE` |

Only the last is incoherent: an agreement cannot succeed one it began before.

## 6. Classification — derived, never supplied

Lines are matched on `offerLogicalKey|componentKey`, the pair that survives a
catalog revision. Each key is `unchanged`, `changed`, `added` or `removed`, with
the exact before/after of quantity, net amount, currency, charge type, interval
and interval count.

| Derived label | When |
|---|---|
| `renewal` | every key present both sides, quantities equal, amounts equal, recurrence equal |
| `expansion` | only quantity increases and/or added lines |
| `contraction` | only quantity decreases and/or removed lines |
| `mixed` | both directions of quantity movement |
| `commercial_change` | **everything else** — an amount that moved without a quantity moving, a changed recurrence, a currency change, or a key that is ambiguous because it appears twice on one side |

`commercial_change` is not a failure and never blocks execution: it is the
honest label for a change whose narrower name cannot be *derived*, and it ships
with the same exact per-line delta as every other label. A price uplift at
renewal is deliberately `commercial_change` and not `expansion` — nothing about
it expanded.

No MRR, ARR, TCV or single total is computed. Baselines travel grouped by
`(currency, chargeType, interval, intervalCount)`, before and after, never
summed across groups and never converted — there is no FX.

## 7. The amendment-run state machine

Explicit table, no rank, no clock input:

| From | Action | To |
|---|---|---|
| — | `open-amendment-run` | `planned` |
| `planned`, `awaiting_signed_order`, `ready` | `attach-successor-order` | `awaiting_signed_order` or `ready`, **derived from the evidence** |
| `ready` | `execute-amendment` | `executed` (terminal) |
| `planned`, `awaiting_signed_order`, `ready` | `abandon-amendment-run` | `abandoned` (terminal) |

- **No clock-driven transition.** Nothing here reads a due date.
- **No reopen.** `executed` and `abandoned` are terminal and never regress.
- **A new commercial round** may be opened on a source contract when its latest
  run is terminal — the M16a round pattern, keyed
  `amendment-run:<contractId>:<round>`, UNIQUE. A run that was abandoned does
  not block the next attempt; a run that **executed** does, permanently, because
  a source contract has exactly one successor and the next round belongs to that
  successor.
- An M16a `not_renewing` decision is **not** cancellation execution and moves
  nothing here. It remains recorded intent.

`awaiting_signed_order` versus `ready` is derived by calling the capability's
read-only plan at attach time and recording the gaps. It is a **recorded
observation with a timestamp**, never an authorisation.

## 8. Source validation at execution — stable codes, no driver text

Every refusal is an `AppError` with a stable code and an HTTP status. None
carries SQLite text, a provider payload or a stack.

| Code | Status | Means |
|---|---|---|
| `HUMAN_APPROVAL_REQUIRED` | 403 | agent actor attempted a write |
| `SOURCE_CONTRACT_NOT_FOUND` | 404 | the source contract does not exist |
| `SOURCE_CONTRACT_INCOHERENT` | 409 | the source has no current version, or a subscription line pointing outside its own contract |
| `SOURCE_TERM_PROVENANCE_UNCLASSIFIED` | 409 | the source's `termsSource` is outside the declared enum — `signed: null`, so nothing may be said about it |
| `SUCCESSOR_ORDER_NOT_FOUND` | 404 | no such order |
| `ORDER_NOT_ACTIVATABLE` | 409 | the order is not `accepted` (M12 code, reused) |
| `ORDER_NOT_SIGNED` | 409 | no envelope/artifact, or the envelope is not `completed` (M12 code, reused) |
| `SOURCE_INCOHERENT` | 409 | envelope/artifact/quote-version disagree (M12 code, reused) |
| `SOURCE_HASH_MISMATCH` | 409 | order, envelope, artifact or term snapshot disagree on the signed document (M12 code, reused) |
| `SOURCE_INCOMPLETE` | 409 | the order snapshot's line/component/total counts do not match (M12 code, reused) |
| **`SUCCESSOR_TERMS_NOT_SIGNED`** | **409** | **the order carries no `order-term`: the signed document carried no term, so no successor term can be claimed as signed. The milestone's core invariant.** |
| `SUCCESSOR_CUSTOMER_MISMATCH` | 409 | the order's customer is not the source's customer |
| `ORDER_ALREADY_ACTIVATED` | 409 | the order already produced a contract (M12 code, reused) |
| `SUCCESSOR_ORDER_ALREADY_CONSUMED` | 409 | the order is already some succession's successor |
| `CONFLICTING_SUCCESSOR` | 409 | the source contract already has a successor |
| `SUCCESSOR_TERM_PRECEDES_SOURCE` | 409 | the successor term starts before the source term started |
| `CLASSIFICATION_AMBIGUOUS` | 409 | the activation policy could not classify a component (M12 code, reused) |
| `TERM_ALREADY_ENDED` | 409 | the successor term ended before execution (M12 code, reused) |
| `AMENDMENT_RUN_NOT_READY` | 409 | the run is not in `ready` |
| `AMENDMENT_RUN_ALREADY_OPEN` | 409 | a non-terminal run already exists on this contract |
| `AMENDMENT_RUN_TERMINAL` | 409 | the run reached `executed`/`abandoned` and does not move again |

Reusing M12's codes is deliberate: the evidence being validated is the *same*
evidence, and inventing a parallel vocabulary for it would make two names for
one refusal.

## 9. Atomicity, idempotency, concurrency

**One transaction.** `execute-amendment` writes, in order: the activation run,
the successor contract, its version, the `currentVersionId` link, the
subscription, every contract line and its subscription line / delivery
obligation / service obligation, the activation completion patch, the Order's
`contractId` link, the `contract-succession` row, and the run's move to
`executed`. A failure at any point rolls the whole thing back. Fault injection
after **every** write is part of the evidence, not a sample of it.

**Idempotency (a lost response).** A repeat that finds the run already
`executed` re-reads the succession and returns the identical payload when the
submitted `successorOrderId` matches; a repeat naming a *different* order is
refused `AMENDMENT_RUN_TERMINAL` with the recorded value. Nothing is
overwritten, and a retry is never punished with a dead end.

**Concurrency (two connections).** Both pass their reads; the first write to
collide decides it — `contract-activation.orderId` for two executions of the
same order, `contract-succession.sourceContractId` for two runs on the same
source. The loser's transaction rolls back **whole** and it receives
`ORDER_ALREADY_ACTIVATED` / `CONFLICTING_SUCCESSOR`, never a driver string.
Exactly one successor exists afterwards, and there is no partial one.

**Post-commit event dispatch failure** stays a business success, as under the
current ADR, and is visible separately.

## 10. Capability — `contracts-successor-activation@1`

One capability, sized by its one real consumer, offered by Contracts:

| Method | Writes | Purpose |
|---|---|---|
| `planSuccession({sourceContractId, successorOrderId})` | no | the whole coherence answer: refusals, source and successor evidence with provenance, delta, classification, term continuity |
| `executeSuccession({sourceContractId, successorOrderId, policy, policyVersion, executionRef, actor})` | yes | recompute authoritatively, then write the successor and the lineage inside the caller's transaction |
| `succession(sourceContractId)` / `successionBySuccessor(id)` / `successionByOrder(id)` | no | frozen lineage reads |

Not a capability per method, no public HTTP mutation bypass (the records are
read-only managed modules; the only write path is the action), and the schema
metadata it contributes is function-free.

**Version 1, and Contracts moves to `version: 7`** — new records, a new offered
capability and a new action surface change the composition contract.
`contract-lifecycle-source@2` and both obligation capabilities answer
byte-identically and keep their versions. **Lifecycle moves to `version: 2`**
for the same reason.

## 11. Admin

`apps/admin/public/admin-lifecycle.js`, rendered under an activated contract
from `admin-contracts.js`, exactly as Delivery and Service are. Package-scoped,
not package-owned: the framework still has no seam for a package to contribute
an Admin extension (AX1 publishes `ADMIN_EXTENSIONS_UNSUPPORTED`), so the
section lives in the Admin app and renders only while `/api/schema` publishes
`domains.lifecycle.amendmentContract`.

State-aware, one state at a time: no run → open; `planned` → attach;
`awaiting_signed_order` → the gaps and **no execute control**; `ready` → the
delta, the classification, both signed-terms provenances and one human execute
control; `executed` → immutable result and lineage, **no control at all**;
`abandoned` → the reason and a new-round control.

**Signed-terms provenance never collapses.** The source and the successor each
render their own provenance sentence verbatim from the capability — signed
snapshot, post-signature operational, or absent/unknown — and the three are
never merged into one badge.

Four disclaimers render verbatim, always: no billing/invoice/payment; no
automatic renewal and no scheduler; no customer notification; a human actor is
an audit identity, not RBAC.

**Real Chromium evidence is required** for the full path and is recorded in
`docs/ADMIN_SMOKE.md` with its commit, browser build and check count.

## 12. Evidence

Package conformance for commercial / signature / contracts / lifecycle · AX1
visibility and AX2 citability · DX4 declared-edge conformance · DX5 declared
scripts · DX10 solution verify · absence / detach / reattach with rows
preserved in separate processes · exact reads past the 500-row bound on the
three paths where correctness uses a collection query (the run-round guard, the
succession guards, the delta's line reads) and stated N/A on primary-key paths ·
atomicity with fault injection after every write · idempotent replay · divergent
refusal · two-connection races on both unique columns · restart with old data ·
an old database carrying pre-M16b rows upgraded in place · exact audit, event
and trace **counts** · hostile input across every field and route · real
Chromium · and **all three LA0 characterization replays byte-identical**
(Signature `fe1875bf…`, Commercial `82c1f02f…`, Intelligence `f80592be…`).

Where it lives: `tests/lifecycle-amendment-execution.test.js` (arithmetic,
classification, state table, wording), `tests/lifecycle-amendment-execution-e2e.test.js`
(everything that is a claim about a running application),
`tests/lifecycle-amendment-upgrade.test.js` (a shipped M16a project adopting
M16b over live rows), `tests/admin-lifecycle.test.js` (the Admin section against
the real request shape), and `tests/package-contract.test.js` for conformance.

## 13. DX Simplicity Gate

- **Failure mode prevented:** an agent executing a renewal against a stale plan,
  an unsigned order, or an operational term relabelled as signed — each of which
  produces a *successor commercial agreement* nobody agreed to. This is the
  most expensive class of mistake in the repository's domain.
- **Existing primitives tried first:** `order.activate-contract` was extended in
  place rather than duplicated — `writeActivation()` is now shared, and a
  successor is byte-identically shaped to an ordinary activation. M16a's
  round-keying, replay and `requireHuman` helpers are reused, not reinvented.
- **Semantic overlap minimised:** one plan action and one execute action; the
  three lifecycle-management actions exist because the state they move is real
  evidence, not a flag.
- **Portable:** everything is in the packages, the Package Contract and the
  Quality Gates. Nothing is harness-specific.
- **Machine-readable evidence:** stable error codes, a derived classification,
  a fingerprinted policy identity on every record, and the succession row itself.
- **Horizontal?** No — this is a domain capability between two domain packages,
  so the Compatibility Backfill Rule does not apply and no
  `LEGACY_ALIGNMENT_MATRIX.md` row is added. Stated rather than skipped.
- **The end-user goal flow gets simpler:** "renew this contract" was previously
  *record intent, then do the whole commercial motion by hand and link nothing*.
  It is now plan → attach the signed order → execute, with the lineage recorded.
