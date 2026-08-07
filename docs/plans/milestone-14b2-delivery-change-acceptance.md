# ExecPlan — Milestone 14b2: Delivery Change, Deliverables and Acceptance

**Status: implemented and independently reviewed, this PR (open, unmerged).** Extends `packages/delivery`
(M13 handover, M14a execution, M14b1 economics) additively. Guides:
`packages/delivery/README.md`, `docs/DELIVERY_CHANGE_ACCEPTANCE.md`. Decisions:
ADR-018 and its addenda (the package contract), ADR-019 (module evolution),
ADR-012 (transaction-scoped events), ADR-014 (money).

## What M14b2 is, in one sentence

M14b1 recorded what a delivery project **consumed**; M14b2 records what changed
about it, what it **produced**, and whether anyone said the work was **done** —
as evidence, without pretending any of it is a contract amendment, a billing
trigger or a legally binding customer signature.

## The split this completes

M14b was scoped as economics + change + deliverables + acceptance and split
because four models with four different invariants is not one reviewable PR.
M14b1 shipped the economics. This is the rest, with its scope intact.

## Three architectures compared

**1. Editable project-management CRUD.** A change request you can edit, a
deliverable you can tick, an acceptance you can un-tick. Fastest to build and
wrong in the way that cannot be patched later: acceptance is *testimony about a
moment*, and a row somebody can edit afterwards is not testimony. **Rejected.**

**2. A generic workflow and approval engine.** Configurable states, configurable
approvers, a rule language over transitions. It would express change management
and everything else, and verify none of it: the framework could not state what
any particular approval meant. The kernel already refuses an expression language
over money for the same reason. **Rejected.**

**3. Bounded package-owned evidence with explicit actions (chosen).**
Append-only records written only through actions that require a human actor,
over explicit state tables, in the package that owns the domain. The kernel
learns nothing about change requests or acceptance.

## What ships

```text
delivery-change-request            proposed → approved | rejected | pending_commercial_followup
delivery-plan-revision             immutable, versioned: the replan an approval produced
delivery-commercial-change         immutable candidate handed to a future commercial amendment
delivery-deliverable               planned → completed, tied to server-authoritative execution state
delivery-acceptance-request        immutable: what was submitted for acceptance, and when
delivery-acceptance-evidence       immutable: what a human recorded a customer as having said
```

Every one is `writable: "managed"` — no public create, update or delete
anywhere.

## The commercial boundary, which is the whole risk

A change request that costs money must **never** reach the signed commercial
record. M14b2 may raise a `delivery-commercial-change` candidate and stop.
Nothing here mutates a Quote, an Order, a Contract, a Contract Version or a
Subscription; nothing creates an amendment; nothing sends anything anywhere. A
future Commercial Amendment milestone consumes the candidate through a declared
capability, in the package that owns commercial truth.

The `pending_commercial_followup` state exists precisely so the handoff is a
*state a human can see*, not an implicit hop.

## Acceptance is evidence, not authentication

The strongest claim M14b2 makes is: **a user actor recorded that a customer
accepted or rejected.** It is not an authenticated customer action, not a legal
signature, not a verified identity, and not authorization to bill. There is no
customer portal, no external send, and no Billing Eligibility record — the
Production Spine gates all of them, and saying otherwise would be the most
damaging overclaim available in this domain.

## Rejection semantics, decided

A rejected acceptance **preserves execution history**. It records the rejection
and requires a new Change Request to replan; it does not destructively reopen
completed work packages or milestones. Reopening would rewrite the M14a
execution evidence that M14b1's economics are computed from, and a snapshot
taken on Tuesday must still reproduce on Wednesday.

## Scope decisions worth naming

| Question | Decision |
|---|---|
| Can an approved replan rewrite the handover? | **No.** The M13 source snapshot, the signed Order and completed historical work are immutable. A revision describes *future* scope and dates |
| Does a completed deliverable mean accepted? | **No.** Two different facts with two different authors, and conflating them is how a framework accidentally claims a customer signed off |
| May an agent decide a change request or record acceptance? | **No.** `actor.type === 'user'`, refused `403 HUMAN_APPROVAL_REQUIRED`. A human-actor boundary, not RBAC |
| Does anything bill? | **No.** No invoice, payment, billing eligibility or revenue event exists |
| Does anything schedule? | **No.** There is no scheduler; no state moves on a clock |
| Does a raised commercial candidate ever end? | **Yes, and it must.** A candidate blocks acceptance over the scope it touches, and the change request's `pending_commercial_followup` is terminal — so without `resolve-commercial-change` one approval would have blocked a project's acceptance evidence permanently. Recording the outcome amends nothing; it says a human closed the question elsewhere |
| Does the customer label decide whether a scope can be re-asked? | **No.** `customerRef` is an unverified operator label, so it is frozen and stored but kept out of the scope fingerprint. Otherwise a rejected scope could be re-asked as "Acme" instead of "ACME" |

## Not modeled — stated, not implied

Invoicing, payment, billing eligibility, contract amendment, Quote/Order
mutation, legal acceptance, authenticated customer identity, customer portal,
external send or notification, e-signature, resource scheduling, capacity,
document or binary storage, SLA, Service, entitlements — and AX3, `crm doctor`,
package scaffold and generic Admin action filtering, which are tooling items on
`docs/CODER_TOOLING_ROADMAP.md` rather than Delivery scope.

## Guarantees to prove

1. **Append-only** — no public create/update/delete on any of the six records.
2. **Human-only** — an agent actor is refused `403`, and the refusal writes nothing.
3. **Commercial isolation** — no commercial record changes, proved by fingerprinting the commercial rows before and after a commercial-change request.
4. **Source immutability** — deactivating or renaming the source data leaves every stored snapshot unchanged.
5. **Atomicity** — a failure injected after every write rolls back completely, with no partial audit, event or trace.
6. **Idempotency and concurrency** — deterministic source keys, DB-enforced; two connections racing a decision produce exactly one.
7. **Exact reads** — every correctness read is `listWhere`, proved past 500 rows.
8. **Truthful events** — the seven M14b2 events exist; `quote.amended`, `invoice.created`, `payment.received`, `customer.authenticated`, `customer.legally-accepted` and `service.activated` do not.
9. **Hostile input stays inert** across every field, in evidence and in errors.
10. **AX1 and AX2 see it** — the new resources, actions and capabilities appear in `app inspect`, and a Solution Plan can cite them without AX2 executing anything.
11. **No refusal is a dead end** — every state this milestone can refuse from has a stated, human-driven way out, and the two that could have trapped a project (an unresolved commercial candidate, a settled acceptance scope) are proved recoverable rather than argued to be.
