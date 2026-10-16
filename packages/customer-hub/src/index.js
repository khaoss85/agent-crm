// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
import { resolvedNames } from '../../customer-data/src/store.js';
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
  const names = resolvedNames(options.config);

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

    // Nothing is required: every source beyond the host contact is optional
    // and reads "not available" with a reason when it is not composed.
    requires: [],

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
          return (request) => readCustomerCard({
            modules: runtime.modules, core: runtime.core, names,
            subject: { resource: request?.resource, id: request?.id },
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
