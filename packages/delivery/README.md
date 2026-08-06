# `packages/delivery` — the Delivery domain package

The second domain package built under ADR-018, and the first that **depends on
another package**. It turns the pending Delivery Obligations of an activated
contract into a planned delivery project: one work package per obligation, a
milestone plan, and an optional third-party partner engagement.

It **plans**. It does not execute delivery — nothing starts, progresses,
completes, schedules, staffs, costs, bills or grants access.

Full guide: [`docs/DELIVERY_HANDOVER.md`](../../docs/DELIVERY_HANDOVER.md).
Authoring a package of your own:
[`docs/PACKAGE_AUTHORING.md`](../../docs/PACKAGE_AUTHORING.md).

## What it needs

```js
requires: [{ package: 'contracts', capability: 'delivery-obligations', version: 1 }]
```

That is the whole dependency. This package imports nothing from
`packages/contracts` and nothing from `packages/core/src` — only the public
kernel surface `packages/core/index.js` and the declared capability, opened
with the caller's own runtime handles so the cross-package write commits inside
one transaction.

Without the contracts package the delivery package **refuses to register**, and
says which capability it could not get.

## Enabling it

1. Apply the five record manifests in `modules/`:

   ```bash
   npm run crm -- module create packages/delivery/modules/delivery-handover-run.module.json --apply
   # …and delivery-project, delivery-work-package, delivery-milestone, delivery-partner-engagement
   ```

2. Register it in the checked-in composition file, after the contracts package:

   ```js
   // packages/domains/generated/index.js
   import { createDeliveryPackage } from '../../delivery/src/index.js';
   import { b2bDeliveryHandoverV1 } from '../../../examples/starters/b2b-lead-qualification/delivery.js';

   export const generatedDomains = [
     createContractsDomain({ policies: [b2bSaasOrderActivationV1] }),
     createDeliveryPackage({ policies: [b2bDeliveryHandoverV1] }),
   ];
   ```

Removing that import removes the package: its two actions and its Admin section
disappear, contracts keeps working, and delivery obligations simply stay
`pending_handover`. Your data is left alone.

Validate before booting:

```bash
npm run crm -- package validate packages/delivery
```

## What you must supply

A **Delivery Handover Policy**: the versioned, fingerprinted decision about who
performs each obligation, and what the project should be called and planned as.

```js
import { defineDeliveryHandoverPolicy } from './src/index.js';

export const policy = defineDeliveryHandoverPolicy({
  name: 'my-delivery-handover',
  version: 1,
  config: {
    componentKeys: {
      'setup-fee': { mode: 'internal', label: 'Setup', milestones: ['kickoff', 'go-live'] },
      'migration-records': { mode: 'partner', label: 'Data migration', milestones: ['kickoff', 'delivery'] },
    },
  },
  planObligation({ obligation, config }) {
    const key = String(obligation.componentKey).split(':').pop();
    const mapped = config.componentKeys[key];
    return mapped
      ? { deliveryMode: mapped.mode, workPackageLabel: mapped.label, milestoneKeys: mapped.milestones, reason: `"${key}" is mapped` }
      : { deliveryMode: 'ambiguous', workPackageLabel: obligation.label, milestoneKeys: [], reason: `"${key}" is not mapped by this policy version` };
  },
});
```

Rules the runtime enforces: deterministic and synchronous (no clock, network,
database or randomness), total (a throw is a `500`, never a silent default),
bounded labels, reasons and milestone keys, mappings in `config` so they are
inside the fingerprint, and a published new version rather than an edit.

Worked example with the starter's fixture:
[`examples/starters/b2b-lead-qualification/delivery.js`](../../examples/starters/b2b-lead-qualification/delivery.js).

## Layout

```text
src/index.js           createDeliveryPackage(): actions, policies, schema metadata
src/handover.js        plan-delivery-handover (read-only) and create-delivery-handover
src/handover-policy.js the policy contract, delivery modes, human overrides, partner validation
src/dates.js           post-sale planning dates
modules/               five read-only record manifests
```

## The partner boundary, stated plainly

A partner engagement is a **business reference and a name snapshot**. It grants
no account, no login, no portal, no invitation, no permission, no fee or
revenue share and no SLA, and at most one partner is modelled per project.
Nothing here notifies the partner or lets them see anything.

## What it does not do

Delivery execution, progress, status transitions, time tracking, expenses,
cost, margin, resource scheduling, capacity, change requests, customer
acceptance, billing milestones, invoicing, partner access, revenue share,
service contracts, entitlements, SLA and support cases.
