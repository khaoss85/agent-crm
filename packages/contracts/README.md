# `packages/contracts` — the Contracts domain package

The first domain package built under ADR-018: it turns a **signed immutable
Order** into a Commercial Contract, a Subscription and explicit pending
delivery and service obligations.

It is **optional**. The kernel does not import it, does not know the words
contract, subscription or obligation, and boots identically without it.

Full guide: [`docs/CONTRACT_ACTIVATION.md`](../../docs/CONTRACT_ACTIVATION.md).
Decision record: ADR-018 and its Milestone 12 addendum in
[`DECISIONS.md`](../../DECISIONS.md).

## Enabling it in a project

1. Apply the eight record manifests in `modules/` with the module factory:

   ```bash
   npm run crm -- module create packages/contracts/modules/contract-activation.module.json --apply
   # …and the other seven, in the order listed in modules/
   ```

2. Register the domain in the checked-in registry — the same path any
   third-party package uses:

   ```js
   // packages/domains/generated/index.js
   import { createContractsDomain } from '../../contracts/src/index.js';
   import { b2bSaasOrderActivationV1 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';

   export const generatedDomains = [
     createContractsDomain({ policies: [b2bSaasOrderActivationV1] }),
   ];
   ```

Removing that import removes the domain: the two actions disappear from
`/api/schema`, the Admin section disappears with them, and every other
milestone keeps working. (The record tables stay until you drop them — the
framework never deletes data behind you.)

## What you must supply

An **Order Activation Policy**: the versioned, fingerprinted decision of what
each signed order component becomes. Recurrence alone never decides
(annual support is not a subscription; a recurring API charge may create no
obligation at all), so the policy maps explicit identity — component key, SKU,
offer — and returns `ambiguous` for anything it does not recognize, which
blocks activation until a human classifies it with a reason.

```js
import { defineOrderActivationPolicy } from './src/index.js';

export const policy = defineOrderActivationPolicy({
  name: 'my-order-activation',
  version: 1,
  config: { componentKeys: { 'platform-fee': 'subscription', 'setup-fee': 'delivery' } },
  classifyComponent({ component, line, config }) {
    const key = String(component.componentKey).split(':').pop();
    const type = config.componentKeys[key];
    return type
      ? { type, reason: `component "${key}" is mapped to ${type}` }
      : { type: 'ambiguous', reason: `component "${key}" is not mapped by this policy version` };
  },
});
```

Rules the runtime enforces: deterministic and synchronous (no clock, network,
database or randomness), total (a throw is a `500`, never a silent default),
bounded reasons, thresholds in `config` so they are inside the fingerprint, and
a published new version rather than an edit to an existing one.

A worked example with two versions:
[`examples/starters/b2b-lead-qualification/contracts.js`](../../examples/starters/b2b-lead-qualification/contracts.js).

## Layout

```text
src/index.js             createContractsDomain(): actions, policies, schema metadata
src/activation.js        order.plan-activation (read-only) and order.activate-contract
src/activation-policy.js the policy contract, classification bounds, human overrides
src/dates.js             calendar dates and the inclusive term
modules/                 eight read-only record manifests
```

## What it does not do

Billing, invoicing, payment, usage rating, proration, tax, FX, revenue
recognition, MRR/ARR/TCV, amendments, seat changes, renewal (there is no
scheduler), cancellation, delivery execution, service activation, entitlements
and SLA. Obligations are recorded markers: nothing executes, schedules, staffs
or completes them.
