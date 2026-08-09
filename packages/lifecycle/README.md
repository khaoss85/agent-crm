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

It requires `contracts/contract-lifecycle-source@1`. Without Contracts composed,
the application **refuses to start** and names the unmet edge.

## What it does

| Action | Writes | Actor |
|---|---|---|
| `plan-renewal` | **nothing** | any |
| `record-renewal-decision` | immutable decision evidence | user |
| `request-commercial-followup` | immutable handoff candidate | user |
| `resolve-commercial-followup` | terminal transition with a reason | user |

Four actions, and these are all of them. Expansion and contraction are two of
the five `intent` values on `request-commercial-followup`, not separate records,
and **nothing here records a successor** — there is no successor field, table or
action, because a successor has to exist before it can be linked, and creating
one is M16b.

Keys are derived from state, never from the clock:
`renewal-decision:<contractId>:<asOf>` (one decision per contract per day; a
second is a 409, not an overwrite) and
`commercial-followup:<contractId>:<intent>:<round>` (an open follow-up of the
same intent is refused, a resolved one does not block the next round).

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
`termsSource` the contract's enum allows, and a test fails if a new one is added
without a decision. It is `false` for every source that exists today, and an
unknown source stays `false` — reporting a signed term as unsigned costs
somebody a redundant check, while reporting an unsigned date as a signed
renewal term is the failure this package exists to prevent.

## Money is grouped, never totalled

A commercial baseline is grouped by currency and recurrence. A one-time fee and
a monthly charge are not the same kind of money, and there is no FX here — so
there is no grand total, because it would not be a number anybody should act on.

The same rule holds for the one row that *stores* money. A follow-up records
`baselineNetAmountCents` only when the baseline collapses to exactly one kind of
money, and then records `baselineChargeType` and `baselineInterval` beside it —
because "EUR 171.00" is not a fact, and monthly, annually and once are three
different asks. When the baseline is mixed, the amount is `null` rather than a
total that is not money.

## Why amendment execution is not here

A real amendment needs a new signed instrument and re-priced lines. Pricing
lives in Commercial and signature in Signature, and both are still inside
`packages/core` with no capability to reach them. That work is **M16b**, and it
waits on those domains becoming reachable — a deferral by decision, recorded in
`docs/plans/m16a-renewal-expansion-operations.md`.
