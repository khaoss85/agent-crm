# Contract, subscription and renewal

**Status: design only. None of the primitives below exists.**

Milestone 11 ends at an immutable Order. The roadmap then went straight to
Delivery — which skips the layer every SaaS business actually runs on. An Order
is *what was agreed, once*. A subscription is *what is true now, and until
when*. Delivery, Service, renewal and every recurring-revenue metric depend on
the second one, and today it is missing.

## The gap, concretely

The Order records `EUR 2,850.00 / month` as a grouped total. It does not record:

- when the commitment starts or ends;
- whether it is still active;
- what happens on the renewal date;
- what the customer is entitled to;
- what changed when they added ten seats in March.

Without those, **MRR, ARR, TCV, renewal date, expansion, contraction and churn
cannot be computed** — and M10/M11 deliberately refuse to derive them from
grouped totals. That refusal was correct; this layer is what removes it.

## Future primitives

| Primitive | Purpose |
|---|---|
| `CommercialContract` | the customer-level agreement an Order activates |
| `ContractVersion` | an immutable contract state; amendments create new versions |
| `Subscription` | one recurring commitment under a contract |
| `SubscriptionLine` | one recurring charge, sourced from an Order Component |
| `SubscriptionTerm` | start, end, duration, auto-renew flag, notice period |
| `Activation` | the audited transition from signed Order to live contract |
| `Entitlement` | what the customer may use (seats, support tier, capacity) |
| `Amendment` | an audited change to a live subscription |
| `SeatChange` | a quantity amendment |
| `Expansion` / `Contraction` | classified value changes |
| `Cancellation` | termination before term end |
| `NonRenewal` | a term allowed to lapse |
| `Renewal` | a new term continuing an existing subscription |
| `RenewalOpportunity` | the sales object created ahead of a renewal date |
| `PriceUpliftPolicy` | a versioned, code-first rule for renewal pricing |

Every one follows the established model: immutable evidence, managed writes
only, code-first versioned policies, and no client-supplied amounts.

## Mapping from the immutable Order

```text
recurring Order Components
  → Subscription Lines            (interval, intervalCount, quantity, tier schedule, net amount)

one-time Order Components
  → future Delivery scope / work packages   (setup, migration, training)

support / service components
  → Entitlements / Service Contract          (support tier, SLA, capacity)
```

Rules that must hold:

1. Activation **copies** from the Order snapshot; it never re-reads the catalog. The M11 Order is already independently readable, which is what makes this safe.
2. Every subscription line keeps its full provenance: order line, order component, quote version, offer revision, product version.
3. The Order stays immutable. Activation adds new records and a link; it does not modify the Order.
4. Activation is idempotent per Order — a deterministic key, one contract, one subscription set, however many times it is invoked.
5. An amendment never rewrites history: it creates a new version and records what changed, by whom, when and why.

## Before any recurring-revenue metric may be computed

**MRR** needs an active subscription, a normalized period, a stated conversion rule for non-monthly intervals, and a documented treatment of one-time charges (excluded).

**ARR** needs MRR plus an explicit annualization policy, stated rather than assumed.

**TCV** needs a committed term length — a contract-level fact that does not exist today.

**Renewal date** needs a term with an end and a notice period.

**Expansion / contraction / churn** need amendment history classified at the moment of change, not inferred later from a diff.

Until those exist, no document, endpoint or dashboard may present these numbers.
The M10/M11 grouped totals are period sums of one quote — they are **not** MRR.

## Future JTBDs (all *not supported*)

| ID | Job |
|---|---|
| CS-01 | Activate a commercial contract from a signed Order |
| CS-02 | Activate a subscription with its lines and initial term |
| CS-03 | Amend seats or quantity on a live subscription |
| CS-04 | Record an expansion or a contraction, classified at the time of change |
| CS-05 | Calculate MRR, ARR and TCV from real contract data |
| CS-06 | Schedule a renewal ahead of term end |
| CS-07 | Create a renewal opportunity from an expiring subscription |
| CS-08 | Apply a versioned price-uplift policy at renewal |
| CS-09 | Cancel or non-renew a subscription with an audited reason |
| CS-10 | Read a complete amendment history for a subscription |

CS-06 and CS-07 additionally require `JOBS_AND_OUTBOX.md`: there is no scheduler,
so nothing can trigger on a future date. M12 therefore stops at activation.

## Boundaries

Out of scope for this layer, and for M12: invoicing, billing runs, payment,
usage rating, proration, tax, FX, revenue recognition, dunning, credit notes.
This layer records **what is committed and what is true now** — money movement
is a separate system.
