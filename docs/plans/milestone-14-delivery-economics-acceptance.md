# ExecPlan — Milestone 14: Delivery Economics & Customer Acceptance

**Status: in progress.** Extends `packages/delivery` (M13). Guides:
`docs/DELIVERY_ECONOMICS.md`, `packages/delivery/README.md`. Decision: ADR-019.

Context: `docs/strategy/DELIVERY_SERVICE.md` (the domain),
`docs/PACKAGE_AUTHORING.md` and ADR-018 addenda 3–4 (the package contract this
extends), and Milestone 13, which produced the planned project this milestone
executes against.

## What this milestone is, in one sentence

M13 **planned** a delivery project. M14 lets a human **run** it — start work,
record the time and money it actually consumed, compare that against a
versioned plan, govern changes to scope, and record whether the customer said
it was done — without pretending to be an accounting system, a billing system,
a partner portal, a resource-planning suite, a legally verified signature
system or a scheduler.

## Three architectures compared

**1. Generic editable CRUD records for time, cost, change and acceptance.**
Fastest: five module manifests and the generated Admin, done in a day. It is
also wrong in a way that cannot be patched later. Time and expense are
*evidence* — the record of what was consumed. Editable evidence is not
evidence: an economics snapshot computed on Tuesday stops being reproducible on
Wednesday, and "who decided this change request" becomes whoever edited the row
last. Acceptance in particular is a claim about what a customer said; a
writable `decision` field makes that claim worthless. **Rejected.**

**2. Put delivery economics and acceptance in the kernel.** Every project would
carry time entries, cost policies, change requests and acceptance, whether it
delivers anything or not — directly against ADR-018's core budget rule, and
against the M13 evidence that a domain does not need a kernel concept to work.
It would also put "what is a cost" and "what is acceptance" where no customer
can replace them, and those are exactly the decisions a customer's business
disagrees with. **Rejected.**

**3. Bounded Delivery-package actions, policies and immutable evidence records
(chosen).** Everything lands in `packages/delivery`: explicit transition tables,
append-only time and expense evidence written only through actions, a versioned
immutable economics plan, a reproducible snapshot, a governed change request and
bounded acceptance evidence. The kernel learns nothing. The package contract is
the same `packageContract: 1` merged in PR #17, extended by adding capabilities
rather than changing the contract.

**What option 3 explicitly is not:** a universal project-management or finance
DSL. There is no generic costing language, no rule engine over money, no
scheduling solver. Each decision that varies by business is a small, versioned,
fingerprinted policy with declared config — the same shape as every other policy
in this framework.

## The terminology decision, made once

The numbers M14 produces are **delivery-management estimates**. The vocabulary
is fixed, and the code, schema, Admin and docs use it consistently:

| Used | Never used |
|---|---|
| commercial delivery value | recognized revenue |
| planned delivery cost | budget (in the accounting sense) |
| actual delivery cost | cost of goods sold |
| operational margin estimate | accounting margin, profit |
| variance to plan | forecast variance |

Commercial delivery value comes **only** from the immutable work-package
snapshot M13 copied from the M12 delivery obligation. No client-submitted value,
no live catalog lookup, no re-pricing.

Money rules inherited unchanged from ADR-014: integer minor units, safe
integers, uppercase three-letter currency shape, **no FX, no cross-currency
sum**. Every total is grouped by currency. No ISO exponent is claimed.

## Scope decisions worth naming

| Question | Decision |
|---|---|
| Does acceptance create billing eligibility? | **No.** The signed commercial source (M10–M12) contains no billing-on-acceptance term, so inventing one post-signature would be fabricating a commercial fact. Acceptance is recorded; the billing-trigger JTBD stays **not supported**, and the docs say billing timing must enter the *signed* model first |
| Are change requests applied? | **Governed, not applied.** A change request is proposed, decided and recorded with its impact as evidence. It never mutates a signed Order, Contract, Quote or the commercial delivery value. A commercial-impact request terminates at `pending_commercial_amendment` — a real state meaning "this needs a commercial amendment that M14 does not implement" |
| Can work reopen? | **No.** `completed` is terminal in M14. Reopen is a design decision with its own invariants; an untested reopen path is worse than none |
| Is acceptance a signature? | **No.** No legal assurance, no verified customer identity, no portal. It is evidence recorded by a local user actor, and the Admin says so on screen |
| Partner cost? | An **operational input** — planned fixed cost and actual cost evidence, with actor and reason. No invoice, revenue share, commission, payment, tax, submission or portal |

## What ships

**Execution states**, with explicit allowed-transition tables and no
numeric-rank branching:

```text
delivery-project        pending_kickoff → active → completed
delivery-work-package   planned → active → completed
delivery-milestone      planned → active → completed → accepted | rejected
```

Acceptance is deliberately a *separate* pair of states after `completed`: a
project is not accepted because its work finished, and the two facts have
different authors.

**Four transition actions** — `start-delivery-project`, `start-work-package`,
`complete-work-package`, `complete-milestone` — each requiring a user actor,
each with optimistic-concurrency refusal on a stale expected state.

**Evidence records**, all append-only, all `writable: "managed"`, all written
only through actions:

```text
delivery-economics-plan          the versioned immutable plan, per work package
delivery-time-entry              minutes, resource ref, server-derived cost
delivery-expense                 amount, category, bounded external reference
delivery-economics-snapshot      a reproducible grouped computation
delivery-change-request          proposed → approved | rejected | pending_commercial_amendment
delivery-acceptance              requested → accepted | rejected
```

**A cost policy** (`delivery-cost-policy`), versioned and fingerprinted with
declared config, mapping a resource role or partner engagement to a rate per
minute in a currency. Deterministic, synchronous, deep-frozen input, no clock,
network, database or randomness — the same contract as every other policy.

**New capabilities**, additive, leaving `delivery-obligations@1` untouched:

```text
delivery-projects@1     read-only project, work-package and milestone facts
delivery-economics@1    read-only grouped economics for a project
```

## Guarantees to prove

1. **Append-only means append-only** — no public create or update for any
   evidence record, through service, HTTP, SDK, Admin or MCP.
2. **Atomic under fault injection** after every write and before commit, for
   every mutating action; the retry produces exactly one result.
3. **Idempotent and concurrency-safe** — DB-enforced source keys, tested under
   repeats, a same-app race, two connections and a restart.
4. **Reproducible economics** — a snapshot recomputed later from the same
   inputs is identical, and an old snapshot still reads correctly after newer
   entries and plan versions exist.
5. **Never sums two currencies**, and every arithmetic step is safe-integer
   checked.
6. **Exact reads** — every correctness path is an indexed lookup, proven past
   500 rows; paging is a UI bound, disclosed separately.
7. **The commercial source is immutable** — renaming the customer, changing the
   catalog and restarting leave every stored number unchanged.
8. **The kernel is untouched** — no delivery file under `packages/core/src`, no
   kernel import of delivery, and `packageContract: 1` unchanged.

## Explicitly out of scope

Billing, invoicing, payment, revenue recognition, accounting, FX, tax, partner
portal or access, partner invoices, revenue share, commission, resource
scheduling and capacity, payroll, file or receipt storage, the commercial
amendment Quote/Order flow, legally qualified acceptance, service contracts,
entitlements, SLA, support cases, customer success, renewal, a scheduler or
durable outbox, auth/tenancy/RBAC, PostgreSQL, Cloud, Marketing runtime,
Analytics Studio, Design-to-CRM ingestion, extraction of M9–M11, and any
package marketplace or publication.

## Definition of done

The states, actions, evidence records, cost policy and capabilities above; the
Admin delivery execution views with their caveats; the extended starter journey;
the test suites proving the eight guarantees; the guide, README, skill, JTBD and
status updates; `npm run verify`, the starter twice including from a path with
spaces, and the Chromium smoke. Then per `docs/QUALITY_GATES.md` §5: the
adversarial review, then a human merge. **The M14 PR is left open.**
