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

An **Order Activation Policy**: the versioned, fingerprinted decision about
each signed order component, on **two independent axes** —

- `commercialActivation`: is this a recurring right (a Subscription Line) or not?
- `obligations`: does it also owe `delivery` work, `service`, both, or nothing?

Recurrence decides neither (annual support is a recurring right *and* a service
obligation; a recurring API charge may be neither), so the policy maps explicit
identity — component key, SKU, offer — and returns `ambiguous` on the axis it
cannot decide, which blocks activation until a human resolves that axis with a
reason.

```js
import { defineOrderActivationPolicy } from './src/index.js';

export const policy = defineOrderActivationPolicy({
  name: 'my-order-activation',
  version: 1,
  config: {
    componentKeys: {
      'platform-fee': { commercial: 'subscription', obligations: [] },
      'support-fee': { commercial: 'subscription', obligations: ['service'] },
      'setup-fee': { commercial: 'non_subscription', obligations: ['delivery'] },
    },
  },
  classifyComponent({ component, line, config }) {
    const key = String(component.componentKey).split(':').pop();
    const mapped = config.componentKeys[key];
    return mapped
      ? { commercialActivation: mapped.commercial, obligations: mapped.obligations, reason: `component "${key}" is mapped` }
      : { commercialActivation: 'ambiguous', obligations: 'ambiguous', reason: `component "${key}" is not mapped by this policy version` };
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

## Two limitations you must not misread

1. **The term is not signed.** The signed document package carries priced
   lines, parties and signers and nothing about dates, so the term this package
   records is operational metadata entered after signature
   (`termsSource: "post-signature-operational-activation"`, with a required
   human reason). Do not present it as a signed commercial term.
2. **A future-dated contract is `scheduled` and stays that way.** There is no
   scheduler here; nothing transitions it to `active` on its start date.

## Renewal and amendment (M16b, ADR-035)

Since M16b this package can also produce a **successor agreement**: a second
activation of a second signed Order, written by the *same* activation writer,
plus one immutable `contract-succession` row naming what it replaces
(`contracts-successor-activation@1`, consumed by the lifecycle package). It is
the only capability here that writes, it grants no storage handle, and it
modifies **no** historical contract, version, line, subscription or obligation
row. A successor is built only from an Order carrying the ADR-033 signed term
snapshot; an Order whose signed document carried no term is refused `409
SUCCESSOR_TERMS_NOT_SIGNED`. The whole model is in `docs/RENEWAL_AMENDMENT.md`.

## What it does not do

Billing, invoicing, payment, usage rating, proration, tax, FX, revenue
recognition, MRR/ARR/TCV, seat changes on a live subscription, automatic or
scheduled renewal (there is no scheduler), renewal-notice delivery, customer
notification, cancellation, delivery execution, service activation, entitlements
and SLA. Obligations are recorded markers: nothing executes, schedules, staffs
or completes them.
