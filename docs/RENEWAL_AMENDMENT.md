# Renewal and amendment execution

**Milestone M16b. ADR-035. Packages: `contracts` (v7) and `lifecycle` (v2).**

M16a records renewal *intent* and hands the commercial work to a person. This is
its execution counterpart: a **governed successor commercial agreement produced
from immutable signed evidence**, and refused when that evidence is merely
operational.

Read alongside `docs/CONTRACT_ACTIVATION.md` (what a contract is),
`docs/SIGNATURE_ORDER.md` (where the signed Order comes from) and ADR-033 (what
makes a term *signed*).

## What it is, in one paragraph

A renewal or amendment does not edit the agreement you already have. It produces
a **successor agreement**: its own signed Order, its own signed document hash,
its own term, its own Contract, Contract Version, Contract Lines, Subscription
and pending obligations — written by the *same* code path that activates any
other contract — plus one immutable `contract-succession` row saying which
agreement it replaces. Nothing historical is modified. There is no `UPDATE`
against any pre-existing contract, version, line, subscription or obligation row
anywhere in this milestone.

```
commercial-contract A ──┐
  (source, untouched)   │
                        ├─▶ contract-succession   (immutable, 1:1:1)
signed Order X ─────────┤
  (successor's own)     │
                        └─▶ commercial-contract B  + version 1, lines,
                                subscription, subscription lines, obligations
```

The consequence worth stating: **the successor is not a special kind of
contract.** Reading it needs no M16b vocabulary; every M12, M13 and M15 consumer
handles it already. Only the lineage is new.

## The one refusal that matters

> A successor agreement is built **only** from an Order whose signed document
> carried the commercial term.

The ADR-033 chain is: a `quote-term` draft binds nothing → `quote.submit` freezes
a write-once `quote-version-term` → the canonical document bytes carry `terms`
and the `documentHash` covers them → verified completion reproduces the hash and
writes the Order plus a write-once `order-term` → activation copies it verbatim
as `signed-order-terms`.

An Order without that snapshot is refused `409 SUCCESSOR_TERMS_NOT_SIGNED`. Its
dates would be post-signature operational metadata, and nothing in this
repository promotes those into a signed renewal term. A source contract whose
`termsSource` nobody classified (`signed: null`) is refused too — the honest
answer to "was this signed" is *cannot say*, and a successor may not be built on
an answer nobody has.

Provenance never collapses. The plan, the Admin and the lineage row each carry
the source's provenance and the successor's separately, in three distinguishable
states: **signed**, **post-signature operational**, **absent / unclassified**.

## The surface

Five actions ship in `packages/lifecycle`, and these are all of them.

| Action | Module | Writes | Actor |
|---|---|---|---|
| `plan-amendment` | `commercial-contract` | **nothing** | any |
| `open-amendment-run` | `commercial-contract` | the round | **user** |
| `attach-successor-order` | `amendment-run` | the observed readiness | **user** |
| `execute-amendment` | `amendment-run` | the successor and its lineage | **user** |
| `abandon-amendment-run` | `amendment-run` | the terminal state and its reason | **user** |

The write path itself lives in `packages/contracts`, behind one declared
capability — `contracts-successor-activation@1` — with `planSuccession`,
`executeSuccession` and three frozen lineage reads. Lifecycle imports nothing
from Contracts.

### Plan versus execute

`plan-amendment` writes **nothing**: no record, no audit entry, no domain event.
It answers the whole question — the open round, the candidate Order, the exact
line delta, the derived classification, the term continuity, both provenances,
and every reason execution would be refused.

`execute-amendment` trusts none of it. Every fact is recomputed inside its own
transaction from immutable evidence: the signature evidence, the signed term, the
customer coherence, the delta, the classification, the continuity and every
refusal. **A run recorded as `ready` is an observation with a timestamp, never an
authorisation** — a run that read `ready` an hour ago is refused if the evidence
moved since, and the suite proves exactly that by activating the candidate Order
standalone underneath a `ready` run.

## The round, and its state table

```
                open-amendment-run
                        │
                        ▼
                    planned ──────────────┐
                        │ attach          │
                        ▼                 │ abandon
   awaiting_signed_order ⇄ ready ─────────┤
                              │ execute   │
                              ▼           ▼
                          executed    abandoned
```

| From | To |
|---|---|
| `planned` | `awaiting_signed_order`, `ready`, `abandoned` |
| `awaiting_signed_order` | `awaiting_signed_order`, `ready`, `abandoned` |
| `ready` | `awaiting_signed_order`, `ready`, `executed`, `abandoned` |
| `executed` | — |
| `abandoned` | — |

- **Nothing in this table reads a clock.** There is no scheduler; every
  transition has a human actor.
- **Terminal never regresses.** `executed` and `abandoned` have empty rows.
- `awaiting_signed_order` exists because "this Order has not been signed yet" is
  a *wait*, while "this Order belongs to a different customer" is a wrong pairing
  that waiting never fixes. The second is refused at attach rather than parked,
  because parking it would promise a resolution that cannot arrive. Which is
  which is decided by the provider, not by a code list the consumer keeps: every
  refusal carries `resolvableByMaturity`.
- **A new round** may follow an abandoned one — identity is
  `amendment-run:<contractId>:<round>`, UNIQUE, and the round advances only once
  the previous one is terminal. A round that **executed** closes the agreement to
  further rounds permanently, because a contract is succeeded exactly once and
  the next round belongs to its successor.
- An M16a `not_renewing` decision is **not** cancellation execution and moves
  nothing here.

## Classification — derived, never supplied

Lines are matched on `offerLogicalKey|componentKey`, the pair that survives a
catalogue revision. Each key is `unchanged`, `changed`, `added` or `removed`,
with the exact before/after of quantity, net amount, currency, charge type,
interval and interval count.

| Label | Claimed when |
|---|---|
| `renewal` | every line present both sides, same quantity, amount, currency and recurrence |
| `expansion` | only quantity increases and/or added lines |
| `contraction` | only quantity decreases and/or removed lines |
| `mixed` | quantities moved in both directions |
| `commercial_change` | everything else |

`commercial_change` is not a failure and never blocks execution. It is the honest
label for a change whose narrower name cannot be *derived*, and it ships with the
same exact per-line delta as every other label. Deliberately included in it:

- **a price movement with no quantity movement** — a mid-term uplift is not an
  expansion, because nothing about it expanded;
- a changed recurrence or currency, where the two amounts are not comparable and
  there is no FX;
- a line identity appearing twice on one side, where the two agreements cannot be
  matched line for line at all.

The classification is computed by **Contracts**, the package that owns the source
lines and declares the Signature edge — never by the orchestrator, because a
label computed elsewhere and handed over is a client-provided classification.
`planSuccession()` and `executeSuccession()` call one derivation, so a plan and an
execution cannot disagree.

**No MRR, ARR, TCV or single total is computed.** Baselines travel grouped by
`(currency, chargeType, interval, intervalCount)` — quarterly is `month × 3` and
is not monthly — before and after, never summed across groups and never
converted.

## Term continuity

Measured against the source term's **inclusive** end date:

| Relation | Meaning | Blocks? |
|---|---|---|
| `contiguous` | the successor starts the day after the source ends (`gapDays: 0`) | no |
| `gap` | `gapDays > 0` days are covered by neither agreement | no |
| `overlap` | `gapDays < 0` days are covered by both | no |
| `unknown` | the source has no readable end date | no |

Only a successor term starting **before the source term started** is refused
(`SUCCESSOR_TERM_PRECEDES_SOURCE`). An overlap is a real mid-term amendment and a
gap is a real lapse-then-re-signing; refusing either would force somebody to
falsify dates to record their own history.

## Refusals

Every one is a stable code with an HTTP status. None carries SQLite text, a
provider payload or a stack.

| Code | Status | Means |
|---|---|---|
| `HUMAN_APPROVAL_REQUIRED` | 403 | an agent actor attempted a write |
| `SOURCE_CONTRACT_NOT_FOUND` | 404 | the source contract does not exist |
| `SOURCE_CONTRACT_INCOHERENT` | 409 | no current version, no lines, or a subscription line naming another contract |
| `SOURCE_TERM_PROVENANCE_UNCLASSIFIED` | 409 | the source's `termsSource` is outside the declared enum |
| `SUCCESSOR_ORDER_NOT_FOUND` | 404 | no such order |
| `SUCCESSOR_ORDER_IS_SOURCE_ORDER` | 409 | an agreement cannot succeed itself |
| `ORDER_NOT_ACTIVATABLE` / `ORDER_NOT_SIGNED` / `SOURCE_INCOHERENT` / `SOURCE_HASH_MISMATCH` / `SOURCE_INCOMPLETE` | 409 | M12's own signature-evidence refusals, reused unchanged |
| **`SUCCESSOR_TERMS_NOT_SIGNED`** | **409** | **the signed document carried no term** |
| `SUCCESSOR_CUSTOMER_MISMATCH` | 409 | the Order's customer is not the source's customer |
| `ORDER_ALREADY_ACTIVATED` | 409 | the Order already produced a contract |
| `SUCCESSOR_ORDER_ALREADY_CONSUMED` | 409 | the Order is already some succession's successor |
| `CONFLICTING_SUCCESSOR` | 409 | the source already has a successor |
| `SUCCESSOR_TERM_PRECEDES_SOURCE` | 409 | the successor starts before the source started |
| `CLASSIFICATION_AMBIGUOUS` / `TERM_ALREADY_ENDED` | 409 | M12's own activation refusals, reused unchanged |
| `AMENDMENT_RUN_NOT_READY` | 409 | the run is not `ready`, and readiness is re-proved rather than trusted |
| `AMENDMENT_RUN_ALREADY_OPEN` | 409 | a non-terminal round already exists; an identical repeat replays instead |
| `AMENDMENT_RUN_TERMINAL` | 409 | the round reached `executed`/`abandoned` and does not move again |

Reusing M12's codes is deliberate: the evidence being validated is the *same*
evidence, and a parallel vocabulary would be two names for one refusal.

## Atomicity, idempotency, concurrency

**One transaction.** Execution writes the activation run, the successor contract,
its version, the `currentVersionId` link, the subscription, every contract line
with its subscription line and obligations, the activation completion patch, the
Order's `contractId` link, the `contract-succession` row and the run's move to
`executed`. A failure at any point rolls all of it back — proven by injecting a
failure after **every** write.

**Idempotency.** A repeat that finds the run already `executed` re-reads the
lineage and returns the identical payload; a repeat naming a *different* Order is
refused `AMENDMENT_RUN_TERMINAL` with the recorded value. A replay writes nothing
and is not a second business event.

**Concurrency.** One execution per source is a **database** fact:
`contract-succession.sourceContractId`, `.successorContractId`,
`.successorOrderId` and `.executionRef` are each UNIQUE, on top of M12's UNIQUE
`commercial-contract.orderId` and `contract-activation.orderId`. There is no
in-process lock. The losing connection's whole transaction rolls back and it
receives a stable code — `ORDER_ALREADY_ACTIVATED`, `CONFLICTING_SUCCESSOR` or
the framework's normalized busy-database `CONFLICT` — never a driver string.

## Admin

`apps/admin/public/admin-lifecycle.js`, under an activated contract on the quote
route, rendering only while `/api/schema` publishes
`domains.lifecycle.amendment`. Package-scoped, not package-owned: the framework
has no seam for a package to contribute an Admin extension (AX1 publishes
`ADMIN_EXTENSIONS_UNSUPPORTED`).

One state at a time: no run → open · `planned` → attach · `awaiting_signed_order`
→ the gaps and **no execute control** · `ready` → the delta, the classification,
both provenances and one execute control · `executed` → immutable evidence and
**no control at all** · `abandoned` → the reason and a new round.

Four sentences render verbatim in every state:

- no invoice, payment or billing of any kind follows from executing a successor;
- nothing renews automatically — there is no scheduler;
- no customer, signer or colleague is notified;
- executing requires a signed-in user actor: a human-actor boundary for audit,
  **not** Sales, Legal or Finance role enforcement.

Real-Chromium evidence for the full path is recorded in `docs/ADMIN_SMOKE.md`.

## Not modeled, deliberately

Billing · invoicing · payment · tax · usage rating · proration · revenue
recognition · MRR/ARR/TCV · FX · any scheduler · automatic or clock-driven
renewal · renewal-notice delivery · customer notification of any kind · RBAC or
role enforcement · cancellation · price computation · any live catalog read ·
retroactive amendment of a historical record.

`autoRenew` and `renewalNoticeDays` remain **recorded only** on both
provenances: nothing fires on them and no notice is ever sent. Succeeding an
agreement is **not** cancelling it. The vocabulary reflects that — this milestone
records *"successor agreement executed"*, never *"renewed"*, *"amended"*,
*"cancelled"* or *"churned"* — and nothing here is a legal-assurance claim about
the instrument that was signed.

## Evidence

- `tests/lifecycle-amendment-execution-e2e.test.js` — the whole path against a
  real composed application: the signed-evidence refusal, the stale-`ready`
  refusal, the classification cases, the state table, replay, the agent-actor
  refusals, coherence refusals, continuity, exact audit/event counts, fault
  injection after every write, the two-connection race, reads past the 500-row
  bound, hostile input, restart.
- `tests/lifecycle-amendment-execution.test.js` — the delta arithmetic, the
  classification vocabulary, the continuity arithmetic, the state table and the
  published contracts.
- `tests/admin-lifecycle.test.js` — the Admin section against the real request
  shape.
- `tests/package-contract.test.js` — DX4 conformance for both packages.
- `docs/ADMIN_SMOKE.md` — the real-Chromium checks.
