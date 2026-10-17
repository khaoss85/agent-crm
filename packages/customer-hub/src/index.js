// @ts-check

import { AppError, definePackage, selectPackageGraph } from '../../core/index.js';
// No import from any other domain package — not even customer-data's public
// entry. What the card reads (the consolidated profile) arrives as the
// provider's own created `customer-profile@1` capability object, handed to
// this factory at the composition site. Re-instantiating the provider factory
// here would resolve customer-data's module names a second time from this
// package's options, and the two resolutions could diverge; consuming the
// created handle means there is exactly one name resolution: the provider's.
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
 * @param {{ customerData?: { capabilities?: Array<any> } }} [options]
 *   `customerData` is the composed customer-data package definition — the
 *   same object the composition lists beside this package. The hub takes the
 *   created `customer-profile@1` capability object from it, so the profile is
 *   always read with the provider's own name resolution and never with a
 *   second resolution from this package's options.
 */
export function createCustomerHubPackage(options = {}) {
  // The offered capability object, created once by the provider factory with
  // the provider's config. Held here by reference — never re-instantiated, so
  // a remapped customer-data composition cannot leave the hub reading the
  // wrong tables while customer-data itself works.
  const offered = Array.isArray(options.customerData?.capabilities)
    ? options.customerData.capabilities.find((entry) => entry?.name === 'customer-profile' && entry?.version === 1) ?? null
    : null;

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
          // closed), so the created capability object handed to this factory
          // is opened here instead; the declared `requires` edge above keeps a
          // missing provider fail-closed at startup, and this check keeps a
          // missing handle fail-closed at composition with the edge named.
          if (!offered || typeof offered.create !== 'function') {
            throw new AppError(
              'The customer-hub package requires the customer-data package capability customer-profile@1: '
              + 'compose it with the provider definition, e.g. createCustomerHubPackage({ customerData }) '
              + 'beside createCustomerDataPackage()',
              { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
            );
          }
          const profile = offered.create({ modules: runtime.modules, consumer: CUSTOMER_HUB_DOMAIN });
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
