// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
// The only reach into customer-data: its public package entry (the same file
// a composition imports), never its private `src/` modules. What the card
// reads — the consolidated profile — travels through the declared
// `customer-profile@1` capability below, so both packages share the
// provider's name resolution instead of the hub re-resolving its own.
import { createCustomerProfileCapability } from '../../customer-data/src/index.js';
import { CUSTOMER_CARD_CONTRACT, readCustomerCard, shapeCustomerCard } from './card.js';
import { renderCustomerCardHtml } from './render.js';

/**
 * **Customer Hub v1 — the readable customer card, and nothing else.**
 *
 * A native framework package with **zero owned records** (`resources: []`):
 * the card is a projection over the host contact/company and the packages
 * the application composes. `read-customer-profile` stays the consolidation
 * authority; this package only shapes it into the card a phone can open.
 *
 * Per-space enablement is composition: a space whose project lists
 * `createCustomerHubPackage()` in `generatedDomains` serves the card, a
 * space that does not list it has no `readCustomerCard` operation at all.
 * There is no flag to misread — the operation exists or it does not.
 */

export const CUSTOMER_HUB_DOMAIN = 'customer-hub';

export { CUSTOMER_CARD_CONTRACT, readCustomerCard, renderCustomerCardHtml, shapeCustomerCard };

/**
 * @param {{ config?: Record<string, string> }} [options]
 */
export function createCustomerHubPackage(options = {}) {
  // The profile reader carries the provider's name resolution: the hub never
  // resolves customer-data module names from its own options, so a remapped
  // customer-data composition cannot leave the hub reading the wrong tables.
  // Both factories are constructed side by side in one composition file, and
  // both must receive the same config — see the README.
  const profileCapability = createCustomerProfileCapability(options.config);

  return selectPackageGraph(definePackage({
    packageContract: 1,
    name: CUSTOMER_HUB_DOMAIN,
    version: 1,
    label: 'Customer Hub',
    description:
      'One phone-readable customer card per record: name, phone, email, social profiles, contact-or-customer status, '
      + 'active package, notes and contact history. A read-only projection over the contact record and the composed '
      + 'packages — it owns no records and creates none.',
    // The no-new-master-record guarantee, as a declaration: this package
    // owns no tables. A table added here later fails the hub test that
    // asserts this list stays empty.
    resources: [],

    // The one declared reach into another package: the consolidated profile
    // the card is shaped from. Without customer-data composed, the
    // application refuses to start naming this edge — never a missing-module
    // stack trace at card-read time. Everything beyond the host contact and
    // this profile stays optional and reads "not available" with a reason.
    requires: [{ package: 'customer-data', capability: 'customer-profile', version: 1 }],

    capabilities: [],
    actions: [],
    policies: [],

    operations: [
      {
        operationContract: 1,
        name: 'read-customer-card',
        appMethod: 'readCustomerCard',
        label: 'Read one phone-readable customer card',
        description:
          'Read the customer card for one contact or company: identity, phone, socials, status, active package, notes '
          + 'and history, shaped from the consolidated profile. Creates nothing.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind, e.g. "company" or "contact".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
        ],
        create(runtime) {
          // Opened once at composition with the caller's modules — the same
          // binding `domains.capability()` would hand an action, with the
          // provider's names and the caller's transaction. An operation cannot
          // reach the capability registry (the ADR-032 operation context is
          // closed), so the provider's public factory is opened here instead;
          // the declared `requires` edge above keeps that reach fail-closed.
          const profile = profileCapability.create({ modules: runtime.modules, consumer: CUSTOMER_HUB_DOMAIN });
          return (request) => readCustomerCard({
            core: runtime.core,
            subject: { resource: request?.resource, id: request?.id },
            readProfile: (input) => profile.readProfile(input),
          });
        },
      },
    ],

    metadata() {
      return {
        customerHubContract: 1,
        ownsRecords: false,
        reuses: ['contact', 'company', 'read-customer-profile'],
      };
    },
  }));
}
