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
| phone           | channel identity on a phone-bearing system (WhatsApp, SMS…)   |
| social profiles | channel identities on Instagram, Facebook, TikTok            |
| status          | derived: `cliente` only on signed business (orders, contracts, subscriptions); otherwise `contatto`, evidence named |
| active package  | subscriptions section of the profile                          |
| notes           | unavailable: no notes record exists — reported with a reason   |
| history         | profile sections flattened, newest first within each section  |

Every field the application cannot supply answers "not available" with a
reason — never an empty value that could be mistaken for "none".

## Enablement per space

Composition, not a flag: a space whose project lists
`createCustomerHubPackage()` in `packages/domains/generated/index.js` serves
`readCustomerCard`; a space that does not list it has no card operation.

## Rendering

`renderCustomerCardHtml(card)` returns one self-contained HTML document (no
external assets, no script) with `tel:`/`mailto:` links — it opens on a phone
straight from the device.

## Blueprint

This package is the `customer-hub` module of the workspace Blueprint: the
control plane allow-lists the module name and the shared app composes this
package for spaces that enable it (platform + pilot wiring, separate change).
