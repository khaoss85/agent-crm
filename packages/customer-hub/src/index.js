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
import { CUSTOMER_TIMELINE_CONTRACT, readCustomerTimeline, shapeCustomerTimeline } from './timeline.js';

/**
 * **Customer Hub v1 — the readable customer card and its timeline, and
 * nothing else.**
 *
 * A native framework package with **zero owned records** (`resources: []`):
 * the card and the timeline are projections over the host contact/company and
 * the packages the application composes. `read-customer-profile` stays the
 * consolidation authority; this package only shapes it into the card a phone
 * can open and the conversation/appointment timeline the scheda renders.
 *
 * Per-space enablement is composition: a space whose project lists
 * `createCustomerHubPackage()` in `generatedDomains` serves the card and the
 * timeline, a space that does not list it has neither operation at all.
 * There is no flag to misread — the operations exist or they do not.
 */

export const CUSTOMER_HUB_DOMAIN = 'customer-hub';

export {
  CUSTOMER_CARD_CONTRACT,
  CUSTOMER_TIMELINE_CONTRACT,
  readCustomerCard,
  readCustomerTimeline,
  renderCustomerCardHtml,
  shapeCustomerCard,
  shapeCustomerTimeline,
};

/**
 * @param {{ customerData?: { capabilities?: Array<any> }, interactions?: { capabilities?: Array<any> }, appointments?: { capabilities?: Array<any> } }} [options]
 *   Each entry is the composed provider package definition — the same object
 *   the composition lists beside this package. The hub takes each created
 *   capability object from it, so every read runs with the provider's own
 *   name resolution and never with a second resolution from this package's
 *   options.
 */
export function createCustomerHubPackage(options = {}) {
  // The offered capability objects, created once by the provider factories
  // with the providers' config. Held here by reference — never
  // re-instantiated, so a remapped composition cannot leave the hub reading
  // the wrong tables while the providers themselves work.
  const offered = Array.isArray(options.customerData?.capabilities)
    ? options.customerData.capabilities.find((entry) => entry?.name === 'customer-profile' && entry?.version === 1) ?? null
    : null;
  const timelineOffered = Array.isArray(options.interactions?.capabilities)
    ? options.interactions.capabilities.find((entry) => entry?.name === 'interaction-timeline' && entry?.version === 1) ?? null
    : null;
  const scheduleOffered = Array.isArray(options.appointments?.capabilities)
    ? options.appointments.capabilities.find((entry) => entry?.name === 'appointment-schedule' && entry?.version === 1) ?? null
    : null;

  return selectPackageGraph(definePackage({
    packageContract: 1,
    name: CUSTOMER_HUB_DOMAIN,
    version: 1,
    label: 'Customer Hub',
    description:
      'One phone-readable customer card per record — identity, phone, socials, status, package, notes, history — '
      + 'plus the customer timeline: every thread with its latest entry, every booking, every contact point. '
      + 'Read-only projections over the contact record and the composed packages: owns no records, creates none.',
    // The no-new-master-record guarantee, as a declaration: this package
    // owns no tables. A table added here later fails the hub test that
    // asserts this list stays empty.
    resources: [],

    // The declared reaches into other packages: the consolidated profile the
    // card is shaped from, the interaction threads and entries the timeline
    // groups into conversations, and the appointment bookings the timeline
    // lists. Without any one of them composed, the application refuses to
    // start naming the missing edge — never a missing-module stack trace at
    // read time. Everything beyond the host contact and these three reads
    // stays optional and reads "not available" with a reason.
    requires: [
      { package: 'customer-data', capability: 'customer-profile', version: 1 },
      { package: 'interactions', capability: 'interaction-timeline', version: 1 },
      { package: 'appointments', capability: 'appointment-schedule', version: 1 },
    ],

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
      {
        operationContract: 1,
        name: 'read-customer-timeline',
        appMethod: 'readCustomerTimeline',
        label: 'Read one customer timeline: conversations, appointments, contact points',
        description:
          'Read the customer timeline for one contact or company: every conversation thread with its latest entry, '
          + 'every appointment booking soonest first, and every channel contact point — shaped from the interaction '
          + 'timeline, the appointment schedule and the consolidated profile. Creates nothing.',
        input: [
          { name: 'resource', type: 'string', hint: 'The record kind, e.g. "company" or "contact".' },
          { name: 'id', type: 'string', hint: 'The record id.' },
        ],
        create(runtime) {
          // Same closed-context opening as the card above: one created
          // handle per provider, opened once with the caller's modules, each
          // missing handle failing closed at composition with its edge named.
          if (!offered || typeof offered.create !== 'function') {
            throw new AppError(
              'The customer-hub package requires the customer-data package capability customer-profile@1: '
              + 'compose it with the provider definition, e.g. createCustomerHubPackage({ customerData }) '
              + 'beside createCustomerDataPackage()',
              { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
            );
          }
          if (!timelineOffered || typeof timelineOffered.create !== 'function') {
            throw new AppError(
              'The customer-hub timeline requires the interactions package capability interaction-timeline@1: '
              + 'compose it with the provider definition, e.g. createCustomerHubPackage({ customerData, interactions }) '
              + 'beside createInteractionsPackage()',
              { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
            );
          }
          if (!scheduleOffered || typeof scheduleOffered.create !== 'function') {
            throw new AppError(
              'The customer-hub timeline requires the appointments package capability appointment-schedule@1: '
              + 'compose it with the provider definition, e.g. createCustomerHubPackage({ customerData, appointments }) '
              + 'beside createAppointmentsPackage()',
              { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
            );
          }
          const profile = offered.create({ modules: runtime.modules, consumer: CUSTOMER_HUB_DOMAIN });
          const threads = timelineOffered.create({ modules: runtime.modules, consumer: CUSTOMER_HUB_DOMAIN });
          const schedule = scheduleOffered.create({ modules: runtime.modules, consumer: CUSTOMER_HUB_DOMAIN });
          return (request) => readCustomerTimeline({
            core: runtime.core,
            subject: { resource: request?.resource, id: request?.id },
            readProfile: (input) => profile.readProfile(input),
            readConversations: (subject) => threads.conversations(subject),
            readTimeline: (subject) => threads.timeline(subject),
            readSchedule: (subject) => schedule.scheduleFor(subject),
          });
        },
      },
    ],

    metadata() {
      return {
        customerHubContract: 1,
        ownsRecords: false,
        reuses: ['contact', 'company', 'read-customer-profile', 'interaction-timeline', 'appointment-schedule'],
      };
    },
  }), options.packageContract === 2 ? 2 : 1);
}

/** Distinct awaited contract-2 graph. Existing `createCustomerHubPackage()` callers keep v1. */
export function createCustomerHubPackageV2(options = {}) {
  return createCustomerHubPackage({ ...options, packageContract: 2 });
}
