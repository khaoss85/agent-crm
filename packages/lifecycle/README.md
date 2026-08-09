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
reports carries its source, and `term.signed` is always `false`. A consumer
physically cannot report a date without being able to say where it came from.

## Money is grouped, never totalled

A commercial baseline is grouped by currency and recurrence. A one-time fee and
a monthly charge are not the same kind of money, and there is no FX here — so
there is no grand total, because it would not be a number anybody should act on.

## Why amendment execution is not here

A real amendment needs a new signed instrument and re-priced lines. Pricing
lives in Commercial and signature in Signature, and both are still inside
`packages/core` with no capability to reach them. That work is **M16b**, and it
waits on those domains becoming reachable — a deferral by decision, recorded in
`docs/plans/m16a-renewal-expansion-operations.md`.
