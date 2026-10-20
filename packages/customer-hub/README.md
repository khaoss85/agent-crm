# Customer Hub

One phone-readable customer card per record. A read-only projection — it owns
no tables and creates nothing.

## What it reuses (MEM_ACC_REUSE)

- The host contact/company (`packages/modules/contact|company`): name, email.
- `read-customer-profile` (`packages/customer-data`): canonical identity,
  channel identities, and every package section the application composes.
- Nothing else. There is deliberately no master customer table; Company and
  Contact stay the records, and this package only shapes them into a card.

## Field sources

| Card field      | Source                                                        |
| --------------- | ------------------------------------------------------------- |
| name, email     | host contact (or company) record                              |
| phone           | channel identity on a phone-bearing system (WhatsApp, SMS…) whose id dials as E.164; a non-dialable id reads as unavailable with a reason |
| social profiles | channel identities on Instagram, Facebook, TikTok            |
| status          | derived: `cliente` only on signed business (orders, contracts, subscriptions); otherwise `contatto` — a definitive "none" only when all three evidence packages are readable with complete zero counts, otherwise the reason names what was not readable |
| active package  | subscriptions section of the profile, with its count qualifier (`countIsComplete`/`countNote`): a floor count reads as "at least N"; when the subscriptions page is truncated and holds no active record, the package reads as unavailable with a reason (an active record may sit past the slice), never as a definitive "none" |
| notes           | unavailable: no notes record exists — reported with a reason   |
| history         | profile sections flattened, newest first within each section  |

Every field the application cannot supply answers "not available" with a
reason — never an empty value that could be mistaken for "none".

## Enablement per space

Composition, not a flag: a space whose project lists
`createCustomerHubPackage()` in `packages/domains/generated/index.js` serves
`readCustomerCard`; a space that does not list it has no card operation.

The hub declares `requires: [{ package: 'customer-data', capability:
'customer-profile', version: 1 }]` and reads the profile through the
provider's own created handle, so there is exactly one name resolution: the
provider's. Compose the hub with the provider definition, side by side in
`packages/domains/generated/index.js`:

```js
const customerData = createCustomerDataPackage();
export const generatedDomains = [
  customerData,
  createCustomerHubPackage({ customerData }),
];
```

The hub imports no file from any other domain package — a remapped
customer-data composition keeps serving the card with no change here. Without
the provider composed, the application refuses to start naming the unmet edge;
without the handle, the card operation fails closed at composition.

## Timeline

`readCustomerTimeline` needs the same hub composed with the two timeline
providers beside customer-data:

```js
const interactions = createInteractionsPackage();
const appointments = createAppointmentsPackage({ work });
export const generatedDomains = [
  customerData,
  work,
  interactions,
  appointments,
  createCustomerHubPackage({ customerData, interactions, appointments }),
];
```

The threads and bookings providers stay out of `requires` on purpose: without
them the application still boots and serves the card, and opening the timeline
fails closed naming the missing edge.

## Async graph (contract 2)

`createCustomerHubPackageV2()` is the awaited twin for application graphs
composed with `packageContract: 2` — the reader that serves every shared
space. Compose it beside the providers' own `*V2` factories:

```js
const customerData = createCustomerDataPackageV2();
const work = createWorkPackageV2();
const interactions = createInteractionsPackageV2();
const appointments = createAppointmentsPackageV2({ work });
export const generatedDomains = [
  customerData,
  work,
  interactions,
  appointments,
  createCustomerHubPackageV2({ customerData, interactions, appointments }),
];
```

The v1 factory stays the synchronous graph: existing `createCustomerHubPackage()`
callers keep it, unchanged. The twin reads the same provider capabilities
(`customer-profile`, `interaction-timeline`, `appointment-schedule` at version
1) through the same handed-over definitions, so a remapped composition keeps
serving the card and the timeline with no change here; only the graph
contract differs. A v1 hub composed in a contract-2 graph refuses to start
with `PACKAGE_ASYNC_CONTRACT_REQUIRED` — compose the twin instead.

## Rendering

`renderCustomerCardHtml(card)` returns one self-contained HTML document (no
external assets, no script) with `tel:`/`mailto:` links — it opens on a phone
straight from the device.

## Blueprint

This package is the `customer-hub` module of the workspace Blueprint: the
control plane allow-lists the module name and the shared app composes this
package for spaces that enable it (platform + pilot wiring, separate change).
