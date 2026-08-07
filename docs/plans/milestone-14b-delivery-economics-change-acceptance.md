# ExecPlan — Milestone 14b1: Delivery Economics

**Status: implemented, this PR.** Extends `packages/delivery` (M13 handover,
M14a execution). Guides: `packages/delivery/README.md`,
`docs/DELIVERY_HANDOVER.md`. Decisions: ADR-018 and its addenda (the package
contract), ADR-019 and addendum 1 (module evolution), ADR-014 (money),
ADR-015 (declared-definition fingerprints).

## The split, and why it is stated rather than quietly taken

M14b as scoped covered economics, change requests, deliverables and customer
acceptance — four models with four different invariants, roughly seven new
record types, ten actions, an Admin section and a full evidence battery. That
is not one reviewable PR, and a milestone nobody can review is a milestone
nobody has checked.

| | Scope | Status |
|---|---|---|
| **M14b1 — Delivery economics** | the cost policy, append-only time and expense evidence, the versioned economic plan, and the reproducible economic snapshot | **implemented, this PR** |
| **M14b2 — Change, deliverables and acceptance** | governed change requests, the commercial-change handoff, deliverable evidence and recorded customer acceptance | **not started, and recorded in `TASKS.md` and the roadmap** |

The second slice is named in the roadmap, in `TASKS.md` and in the status file
with its scope intact. It is deferred, not dropped.

## What M14b1 is, in one sentence

M14a let a human run a delivery project; M14b1 records **what it consumed** —
time and expenses as immutable evidence — and computes a reproducible
**delivery contribution estimate** against a versioned plan, without pretending
to be an accounting system, a billing system, a payroll system or a resource
planner.

## Three architectures compared

**1. One broad project-management and finance engine.** A generic costing
language, a rule engine over money, a scheduling solver. It would answer every
question and be verifiable for none: an expression language over money is a
product with its own threat model, and nothing in this repository could state
what a number means. **Rejected.**

**2. Editable generic CRUD records for time, cost and plan.** Fastest to build
and wrong in a way that cannot be patched later. Time and expense are
*evidence*: an editable row means a snapshot computed on Tuesday stops being
reproducible on Wednesday, and "who recorded this" becomes whoever saved last.
**Rejected.**

**3. Bounded Delivery-package actions over immutable evidence (chosen).**
Append-only records written only through actions that require a human actor, a
versioned fingerprinted cost policy, and snapshots that recompute from the
evidence they cite. The kernel learns nothing about delivery economics.

## Money, stated once

ADR-014 unchanged: integer minor units, safe integers, uppercase three-letter
currency shape, **no FX and no cross-currency sum**. Every total is grouped by
currency, and a group is a complete answer for that currency alone. The
repository's existing 1/100-unit, two-decimal convention holds; no ISO-4217
exponent is claimed.

Cost is computed server-side, never accepted from a client:

```text
cost = roundHalfUp(ratePerHourMinorUnits × minutes / 60)
```

Round-half-up on a non-negative integer numerator, computed in integers
throughout, with every intermediate bounded well inside the safe-integer range.

## Vocabulary, fixed

| Used | Never used |
|---|---|
| commercial delivery input | recognized revenue |
| planned delivery cost | budget (in the accounting sense) |
| actual delivery cost | cost of goods sold |
| delivery contribution estimate | gross margin · profit · accounting margin |
| variance to plan | forecast variance |
| one-time commercial value | ARR · MRR · TCV · annualized value |

## The recurrence boundary (adversarial review of PR #23)

The first implementation summed every work package's `netAmountCents` into one
`commercialDeliveryValueCents` and subtracted total actual cost from it. A
recurring delivery obligation prices **one period**; recorded cost is a **spend
to date**. The starter fixture happens to contain only one-time obligations, so
nothing failed — but any project with a subscription obligation would have
produced a confident, meaningless number.

The v1 rule now implemented:

- commercial input is grouped by **currency + charge type + interval + interval
  count** and published as `commercialInputs[]`;
- `deliveryContributionEstimateCents` is computed **only** when every input in
  that currency is one-time, and is `null` otherwise;
- `contributionBasis` is `one_time` or `unavailable`, with
  `contributionUnavailableReason` ∈ {`recurring_commercial_input`,
  `unknown_commercial_shape`, `no_commercial_input`};
- a snapshot with no recognizable charge type is *unknown*, never assumed
  one-time;
- `varianceToPlanCents` compares two costs and stays available everywhere.

No ARR, MRR or TCV; no annualization; no sum across periods; no sum across
currencies. Term and normalization semantics are out of scope until a contract
term model exists.

## What ships

**A cost policy** (`delivery-cost-policy`), versioned and fingerprinted with
declared config: a category or partner engagement maps to a rate per hour in a
currency. Deterministic, synchronous, deep-frozen input, no clock, network,
database or randomness. Rates are **operational planning inputs**, never
payroll or accounting truth, and nothing reads an HR system.

**Four append-only evidence records**, all `writable: "managed"`, written only
through actions:

```text
delivery-time-entry        minutes, contributor, category, server-derived cost
delivery-expense-entry     amount, category, vendor reference
delivery-economic-plan     one immutable version per publish, with its items
delivery-economic-snapshot a reproducible grouped computation
```

**Six actions**, each requiring `actor.type === 'user'`:

```text
record-delivery-time        on a work package of a running project
record-delivery-expense     on a work package of a running project
publish-economic-plan       a new immutable version; never an edit
snapshot-delivery-economics grouped by currency, citing its inputs
preview-delivery-economics  read-only; an agent may call it
```

**One new capability**, additive, leaving `delivery-obligations@1` and the M14a
surface untouched:

```text
delivery-economics@1   read-only grouped economics for a delivery project
```

## Scope decisions worth naming

| Question | Decision |
|---|---|
| Where does commercial value come from? | **Only** the immutable work-package snapshot M13 copied from the M12 delivery obligation. No live catalog, no quote draft, no re-pricing. An obligation with no deterministic amount is reported as unavailable evidence, never invented |
| Can evidence be edited or deleted? | **No.** No public create, update or delete on any evidence record, through service, HTTP, SDK, Admin or MCP. A correction is a new entry, which is what evidence means |
| May an agent record time? | **No.** An agent may inspect and preview; recording, publishing and snapshotting are human decisions. That is a human-actor boundary, not RBAC |
| Does a snapshot mix currencies? | **Never.** Groups only, and the absence of FX is stated on the wire |
| Does anything bill? | **No.** No invoice, payment, tax, revenue recognition, partner payout or billing-eligibility record exists |

## Guarantees to prove

1. **Append-only means append-only** — no public write path exists at all.
2. **Human-only** — an agent actor is refused `403`, and the refusal writes nothing.
3. **Exact arithmetic** — 1/30/60/61 minutes, half-cent ties, safe-integer
   bounds and overflow, internal and partner, multiple currencies.
4. **Reproducible** — a snapshot recomputed later from the same evidence is
   identical, and an old snapshot still reads correctly after newer entries and
   plan versions exist.
5. **Never sums two currencies.**
6. **Atomic under fault injection** after every write and before commit, with
   the retry producing exactly one result.
7. **Idempotent and concurrency-safe** — DB-enforced source keys, tested under
   repeats, a same-app race, two connections and a restart.
8. **Exact reads** — every correctness path is an indexed lookup, proven past
   500 rows; paging is a UI bound, disclosed separately.
9. **The commercial source is immutable** — renaming the customer, changing the
   catalog and restarting leave every stored number unchanged.
10. **The kernel is untouched** — no delivery file under `packages/core/src`, no
    kernel import of delivery, `packageContract: 1` unchanged.
11. **AX1 sees it** — the new capability, resources, actions and policy appear
    in `crm app inspect --json`, with no config value and no health claim.

## Explicitly out of scope

Invoicing, payment, tax, FX, accounting or revenue recognition, resource
scheduling and capacity, partner payout, secure portals or RBAC, service
contracts, SLA, renewal, automatic billing eligibility — and, deferred to
M14b2 by the split above: change requests, the commercial-change handoff,
deliverables and recorded customer acceptance.

## Definition of done

The policy, the four records, the six actions, the capability, the Admin
section, the extended starter journey, the suites proving the eleven
guarantees, the guide, README, skill, JTBD and status updates; `npm run verify`
and `npm run smoke` from a clean clone, the starter twice including from a path
with spaces, and the Chromium smoke. Then per `docs/QUALITY_GATES.md` §5: the
adversarial review, then a human merge. **The M14b1 PR is left open.**

## Two further defects the adversarial review of PR #23 found

**A requested cost policy version was silently ignored.** `costPolicy()` fell
back to the first registered policy the moment no policy *name* was supplied,
so `policyVersion: 99` alone priced the work at version 1 and stored that on the
time entry, with a `200` and no mention of the substitution. A named policy,
a named version, or both must now exist, or the action refuses
`409 DELIVERY_COST_POLICY_MISSING` with the registered list. Nothing is
substituted onto stored money evidence.

**A divergent retry under a reused `entryKey` was absorbed.** Recording the same
key with 480 minutes instead of 60 returned `200 created: false` over the old
entry: the correction was lost and the response looked like success. The
framework already refuses a replayed external event id carrying a different
payload (`signature-operations.js`), and evidence money is derived from deserves
at least that. A retry is now compared field by field against what the key
stored, and a difference is `409 DELIVERY_EVIDENCE_CONFLICT` naming the
divergent fields. An identical retry stays idempotent.
