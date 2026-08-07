# ExecPlan — Milestone 15: Service Operations

**Status: implemented, this PR (open, unmerged).** A new optional domain package
`packages/service`, the **third** built under ADR-018 and the second that
depends on another package. Guides: `packages/service/README.md`,
`docs/SERVICE_OPERATIONS.md`. Decisions: ADR-018 and its addenda (the package
contract), ADR-019 (module evolution), ADR-012 (transaction-scoped events),
ADR-015 (fingerprinted declared definitions).

## What M15 is, in one sentence

M12 raised **pending Service Obligations** when a contract activated and then
stopped; M15 turns those obligations into an operational support relationship —
coverage, entitlements, support cases, elapsed-time SLA evidence and manually
recorded escalation — **without inventing a second legal contract, a customer
portal, a communication channel or a billing event**.

## Three domain boundaries compared

### 1. Reuse the Commercial Contract as the live support engine

Hang entitlements, cases and SLA state directly off `commercial-contract`.

- **For:** no new root object; one obvious place to look.
- **Against, decisively:** the Commercial Contract is *signed legal evidence*
  built in M12 with an immutable version chain. Support operations mutate
  constantly — a case opens, an SLA target is evaluated, ownership moves. Mixing
  a mutable operational lifecycle into a record whose entire value is that it
  does not move is how the immutability guarantee gets quietly relaxed. It also
  forces Service code inside `packages/contracts`, which owns commercial truth
  and must not grow a support domain.

**Rejected.**

### 2. A second legal `ServiceContract`

Create a parallel signed contract object for the service relationship.

- **For:** matches how some vendors sell support as a separate agreement.
- **Against:** this repository has exactly one signature path (M11) producing
  exactly one signed Order and one Commercial Contract. A second "contract" that
  nobody signed, with no envelope, no signer and no artifact, would be a legal
  claim the framework cannot support — precisely the class of overstatement the
  Quality Gates exist to stop. It would also duplicate term, renewal and party
  modelling that M12 already owns, and two contract objects invite the question
  "which one is authoritative?" that neither can answer.

**Rejected.** The name is the trap: anything called *Contract* here will be read
as signed.

### 3. A bounded **operational** Service package (chosen)

`packages/service` owns **Service Coverage** — an operational record linked to
the commercial source through the declared capability — plus Entitlements,
Support Cases, Case Activity, SLA evidence and Escalation evidence.

- The commercial source stays exactly where it is, untouched and unamended.
- The name says what it is: *coverage*, not a contract. Nothing in the package
  claims a signature, a party or a legal term.
- It is optional and detachable like Delivery, so a project that does not run
  support does not carry the concepts.
- The dependency direction is one-way: Service reads Contracts through
  `contracts/service-obligations@1` and Contracts never learns Service exists.

**Chosen.** The concept name is **ServiceCoverage** deliberately, and the guide
says in its first paragraph that it is not a signed agreement.

## Ticketing shape: three options

1. **A generic ticketing / contact-centre platform** — channels, queues,
   routing engines, macros. Rejected: it needs a communication runtime, an
   authenticated customer identity and a scheduler, none of which exist. Every
   one would have to be faked.
2. **Editable CRUD cases** — a `case` module with public create/update.
   Rejected: a support case is *evidence about a customer interaction*. A row
   anybody can edit afterwards cannot support an SLA claim, and it breaks the
   append-only discipline every other evidence record in this repository holds.
3. **Package-owned records with explicit state machines, versioned policy and
   append-only activity (chosen)** — the same shape M13/M14 proved: managed
   records, declared `fromStates`, human-only mutation, audit and trace on every
   write.

## What ships

```text
service-coverage        planned → active → ended
service-entitlement     immutable: what the obligation entitles the customer to
service-activation-run  immutable: which obligations were consumed, by whom, under which policy
support-case            new → in_progress → waiting_customer → resolved → closed
support-case-activity   append-only: notes, transitions, recorded customer replies, escalations
service-sla-evaluation  immutable: an elapsed-time judgement with the exact inputs it used
service-escalation      immutable: a human recorded that this was escalated
```

Every one is `writable: "managed"`.

## What M15 deliberately does not build

A second legal contract · billing, invoicing, payment or billing eligibility ·
an authenticated customer or agent portal · RBAC or tenancy · a contact centre,
telephony, e-mail, chat or WhatsApp connector · attachment or file storage · a
business-hours or holiday calendar · a scheduler or automatic escalation ·
a knowledge base · Customer Success health scoring · renewal or expansion ·
Analytics Studio.

## The SLA contract, stated exactly

M15 computes **elapsed wall-clock time against the injected UTC clock**, and
nothing else:

```text
firstResponseDueAt = openedAt + entitlement.firstResponseTargetMinutes
resolutionDueAt    = openedAt + entitlement.resolutionTargetMinutes
```

There is **no business-hours calendar, no holiday table, no timezone
interpretation and no clock pausing**. `waiting_customer` does **not** stop the
clock: pausing requires accumulated-time modelling with its own evidence, and a
half-implemented pause is worse than none because it silently understates a
breach.

An evaluation is a **judgement at a stated instant**, never ambient truth:

```text
met            answered before its target
on_track       open, and more than 25% of the window remains
at_risk        open, within the last 25% of the window
breached       open, past the target
not_applicable the entitlement declares no target for this measure
```

`preview-sla` computes from the injected clock and writes nothing.
`record-sla-evaluation` persists the same judgement **with the timestamp and the
input values it used**, so a stored evaluation is never mistaken for current
truth.

## Guarantees to prove

1. **Append-only** — no public create/update/delete on any of the seven records.
2. **Human-only** — an agent actor is refused `403`, and the refusal writes nothing.
3. **Plan writes nothing** — `plan-service-activation` creates no record, no audit row and no business event.
4. **One-way dependency** — Service imports nothing from `packages/contracts/src`, reaches it only through `contracts/service-obligations@1`, and the kernel gains no Service concept.
5. **Atomicity** — a failure injected after every write rolls back completely.
6. **Idempotency and concurrency** — deterministic source keys, DB-enforced; two connections racing any decision produce exactly one winner.
7. **Exact reads** — every correctness read is `listWhere`/`countWhere`, proved past 500 rows.
8. **Entitlement enforcement is server-side** — category, priority, dates, coverage state and open-case limit, none of it dependent on the UI.
9. **Truthful events** — the twelve declared Service events exist; `email.sent`, `customer.authenticated`, `sla.contractually-breached`, `invoice.created`, `payment.received` and `renewal.created` do not.
10. **Hostile input stays inert** across every field, in evidence, in errors and on screen.
11. **AX1 and AX2 see it** — the package, its capability edge, its resources, actions and policy fingerprint appear in `app inspect`, and a Solution Plan can cite them without AX2 executing anything.
12. **Absence is honest** — detaching the package removes its whole surface and nothing else; a missing `service-obligations@1` fails closed at startup with a named problem.
