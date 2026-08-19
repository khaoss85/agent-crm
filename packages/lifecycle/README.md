# Renewal & Expansion Operations (M16a)

The operational lifecycle **after** activation: what is coming up for renewal,
what a human decided about it, and what Commercial has been asked to do next.

Named `lifecycle` rather than `renewals` because non-renewal, expansion and
contraction all live here, and none of them is a renewal.

## Compose it

```js
import { createLifecyclePackage } from '../../lifecycle/src/index.js';
export const generatedDomains = [createContractsDomain(...), createLifecyclePackage()];
```

It requires `contracts/contract-lifecycle-source@2`. Without Contracts composed,
the application **refuses to start** and names the unmet edge.

## What it does

| Action | Writes | Actor |
|---|---|---|
| `plan-renewal` | **nothing** | any |
| `record-renewal-decision` | immutable decision evidence | user |
| `request-commercial-followup` | immutable handoff candidate | user |
| `resolve-commercial-followup` | terminal transition with a reason | user |

Expansion and contraction are two of the five `intent` values on
`request-commercial-followup`, not separate records. **M16a records no
successor** — there is no successor field, table or action in any of the four
actions above, because a successor has to exist before it can be linked.

**M16b adds the five that create one** (ADR-034,
`docs/RENEWAL_AMENDMENT.md`): `plan-amendment` (writes nothing),
`open-amendment-run`, `attach-successor-order`, `execute-amendment` and
`abandon-amendment-run`. The successor agreement itself is written by Contracts
through `contracts-successor-activation@1`, inside this package's transaction —
so Lifecycle owns the renewal *cycle* and none of the commercial truth.

## Retrying is safe, and diverging is not

Both records have a **business identity** — derived from the ask, never from the
clock, because a key that moves every millisecond identifies nothing:

| Record | Identity | Key |
|---|---|---|
| renewal decision | (contract, calendar date) | `renewal-decision:<contractId>:<asOf>` |
| commercial follow-up | (contract, intent, round) | `commercial-followup:<contractId>:<intent>:<round>` |

An identity alone is only half the story. The client whose *response* was lost
retries the identical ask and, before this, was told `409` — so from where it
stood the work had never happened and there was no way to find out that it had.
So a repeat is compared against what was recorded:

- **identical** → the existing record is returned, exactly as the first call
  returned it. A retry is safe however often it happens, across a restart, and
  from a second connection.
- **different** → `409`, **naming the fields that differ**
  (`details.conflictingFields`) and the record it collided with. Recorded intent
  is never silently overwritten.

Only the caller's own inputs are compared — `decision` and `reason` for a
decision, `summary` and `decisionId` for a follow-up. Everything else on the row
is derived from evidence the caller does not control, and comparing it would
turn an unrelated change elsewhere into a spurious conflict.

**New work is not collapsed.** At most one follow-up of a given intent is open on
a contract at a time, and *that open one* is the current ask. The round number
advances only once the previous round reached `resolved_externally` or
`withdrawn`, so renewal coming round again next year is round two — its own row,
its own baseline, its own evidence.

## What it will never say

This package records **intent**, not outcomes:

- a decision to pursue is **not** a renewal — nothing is renewed until a signed
  successor exists;
- `not_renewing` is **non-renewal intent recorded** — it ends no contract,
  cancels no subscription, stops no service and recognizes no churn;
- a follow-up is a **request**, not an instruction — it creates no quote, order
  or contract and mutates no signed record.

## Term provenance is not optional

M12 records activation terms as **operational metadata**, and `termsSource`
exists because those dates may never have been signed. Every date this package
reports carries its source, so a consumer physically cannot report a date
without being able to say where it came from.

`term.signed` is **derived from that source**, never asserted beside it: a
single map in `packages/contracts/src/lifecycle-capability.js` classifies every
`termsSource` the contract's enum allows, and the capability reads that enum off
the live module contract and **refuses to open at all** while any declared value
is unclassified. That is deliberately a runtime refusal and not only a failing
test: the manifest and the map live in the same package but in different files,
and the failure a test catches on CI is the same failure that would otherwise be
answered — wrongly, silently and confidently — in production.

The map can carry `true`, so a future signed source needs no breaking change. It
is `false` for every source that exists today. A *stored* value outside the
declared enum reports `signed: null` — "nobody classified this" — with
`signedBasis: 'UNCLASSIFIED_TERM_SOURCE'` and a matching `evidenceGaps` entry,
because an absent decision is not the same fact as a decided `false`. Nothing
unclassified is ever reported as signed: reporting an unsigned date as a signed
renewal term is the failure this package exists to prevent.

## Money is grouped, never totalled

A commercial baseline is grouped by **currency, charge type, interval and
interval count**. A one-time fee and a monthly charge are not the same kind of
money; neither are monthly and quarterly, which M12 spells as `month x 1` and
`month x 3`. There is no FX here — so there is no grand total, because it would
not be a number anybody should act on.

The same rule holds for the row that *stores* money. A follow-up records the
scalar summary — `baselineNetAmountCents`, `baselineChargeType`,
`baselineInterval`, `baselineIntervalCount` — only when the baseline collapses to
exactly one kind of money, because "EUR 1,200.00" is not a fact: annually, and
once, are two different asks.

When the baseline is mixed, the scalar is `null` rather than a total that is not
money — but the evidence is **not** dropped with it. Every follow-up carries
`baselineGroupsJson`, the immutable grouped evidence in one deterministic order,
plus `baselineGroupCount` so "there is no single amount" is a stated fact rather
than something to infer from four nulls. It is exactly what `plan-renewal`
computes, frozen at the moment of the ask.

## Why amendment execution arrived late, and what it still is not

A real amendment needs a new signed instrument and re-priced lines. At M16a,
pricing lived in Commercial and signature in Signature, both still inside
`packages/core` with no capability to reach them — so the work was deferred by
decision (`docs/plans/m16a-renewal-expansion-operations.md`). Both were extracted
afterwards, and ADR-033 supplied the missing fact: a commercial term the customer
actually signed. **M16b discharges that deferral** (ADR-034).

What it still is not: a renewal produces a **successor agreement**, not an edit —
no historical contract, version, line, subscription or obligation row is ever
modified. Nothing renews automatically, because there is no scheduler; `autoRenew`
and `renewalNoticeDays` stay recorded-only on both provenances. Nobody is
notified. Nothing is billed, priced or cancelled. And a successor is built only
from an Order whose signed document carried the term — an Order without one is
refused `409 SUCCESSOR_TERMS_NOT_SIGNED`, because post-signature operational
dates are never promoted into a signed renewal term.
