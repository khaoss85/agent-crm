// @ts-check

import { NotFoundError, ValidationError } from '../../core/index.js';
import { profileFor } from '../../customer-data/src/profile.js';
import { resolvedNames } from '../../customer-data/src/store.js';

/**
 * **The customer card: one readable projection, zero new records.**
 *
 * The card reuses the contact/company record the host application already owns
 * (`packages/modules/contact|company`) and the consolidated profile
 * (`read-customer-profile` in `packages/customer-data`). It creates nothing:
 * no master customer row, no copy of any business record, no new table. Every
 * field the card cannot read from a composed package answers "not available"
 * with a reason — never an empty value that could be mistaken for "none".
 *
 * Field sources, so a reader can trust each line:
 * - name, email: the host contact (or company) record itself;
 * - phone: a channel identity held beside the record (`external-identity`
 *   with a phone-bearing system such as WhatsApp or SMS) — a WhatsApp
 *   identity IS a phone number, and the contact record carries no phone
 *   field of its own;
 * - social profiles: channel identities on the social systems;
 * - status: derived — `cliente` only on signed business (orders, contracts,
 *   subscriptions), otherwise `contatto`, with the evidence named;
 * - active package: the subscriptions section of the profile;
 * - notes: this application composes no notes record for customers, so the
 *   card reports the field as unavailable rather than inventing one;
 * - history: the profile sections flattened into one list, newest first
 *   within each section, capped like the profile itself.
 */

export const CUSTOMER_CARD_CONTRACT = 1;

/** Identity systems whose external id is a callable phone number. */
export const PHONE_SYSTEMS = Object.freeze(['whatsapp', 'sms', 'voice', 'phone', 'tel', 'mobile']);

/** Identity systems shown as social profiles on the card. */
export const SOCIAL_SYSTEMS = Object.freeze(['instagram', 'facebook', 'tiktok']);

/** Signed business: the only evidence that promotes a contact to cliente. */
const CUSTOMER_EVIDENCE_SECTIONS = Object.freeze(['orders', 'contracts', 'subscriptions']);

/** Sections flattened into the card history, in card order. */
const HISTORY_SECTIONS = Object.freeze([
  'opportunities',
  'quotes',
  'orders',
  'contracts',
  'subscriptions',
  'deliveryProjects',
  'serviceCoverages',
  'supportCases',
  'workTasks',
  'successions',
]);

const HISTORY_LIMIT = 50;

/**
 * @param {{modules: any, core?: any, names?: any, subject: {resource: string, id: string}}} input
 */
export async function readCustomerCard({ modules, core, names, subject }) {
  const resource = subject?.resource;
  const id = subject?.id;
  if (typeof resource !== 'string' || typeof id !== 'string' || resource === '' || id === '') {
    throw new ValidationError('a customer card needs a subject resource and id', { field: 'id' });
  }
  const resolved = names ?? resolvedNames(undefined);
  const profile = await profileFor({ modules, core, names: resolved, subject: { resource, id } });
  return shapeCustomerCard(profile, { resource, id });
}

/**
 * The pure shaping step, separated so the card layout is provable without a
 * database: every status, package and history branch is a unit test over a
 * fabricated profile, while the database tests prove reuse and no-write.
 *
 * @param {any} profile the frozen profile from `read-customer-profile`
 * @param {{resource: string, id: string}} subject
 */
export function shapeCustomerCard(profile, subject) {
  const resource = subject?.resource;
  const id = subject?.id;

  const contact = profile.identity?.contact ?? null;
  const company = profile.identity?.company ?? null;
  if (!contact && !company) {
    throw new NotFoundError(String(resource ?? 'Customer'), String(id ?? 'unknown'));
  }
  const name = contact
    ? `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim() || contact.email
    : company?.name ?? null;
  const email = contact?.email ?? null;

  const identities = Array.isArray(profile.externalIdentities) ? profile.externalIdentities : [];
  const phoneIdentity = identities.find((row) => PHONE_SYSTEMS.includes(String(row.system).toLowerCase())) ?? null;
  const phone = phoneIdentity
    ? Object.freeze({ available: true, value: phoneIdentity.externalId, system: phoneIdentity.system, reason: null })
    : Object.freeze({
      available: false, value: null, system: null,
      reason: 'no phone-bearing channel identity (WhatsApp, SMS, voice) is held beside this record — this is not a claim the customer has no phone',
    });

  const socials = Object.freeze(identities
    .filter((row) => SOCIAL_SYSTEMS.includes(String(row.system).toLowerCase()))
    .map((row) => Object.freeze({ system: row.system, handle: row.externalId })));

  const evidence = CUSTOMER_EVIDENCE_SECTIONS
    .filter((key) => profile[key]?.available === true && (profile[key]?.count ?? 0) > 0);
  const status = evidence.length > 0
    ? Object.freeze({ value: 'cliente', reason: `signed business on record: ${evidence.join(', ')}` })
    : Object.freeze({
      value: 'contatto',
      reason: 'no orders, contracts or subscriptions reference this customer — quotes and opportunities alone do not promote a contact',
    });

  const subscriptions = profile.subscriptions?.available === true ? profile.subscriptions : null;
  const activePackage = subscriptions
    ? Object.freeze({
      available: true,
      count: subscriptions.count,
      active: Object.freeze((subscriptions.items ?? []).filter((item) => item.status === 'active')),
      items: subscriptions.items ?? Object.freeze([]),
      reason: null,
    })
    : Object.freeze({
      available: false, count: null, active: Object.freeze([]), items: Object.freeze([]),
      reason: profile.subscriptions?.reason
        ?? 'subscriptions are not composed in this application — this is not a claim the customer holds no package',
    });

  const notes = Object.freeze({
    available: false, items: null,
    reason: 'this application composes no notes record for customers, so the card reports none rather than an empty list',
  });

  const readable = HISTORY_SECTIONS.filter((key) => profile[key]?.available === true);
  const historyItems = [];
  for (const key of readable) {
    for (const item of profile[key]?.items ?? []) {
      historyItems.push(Object.freeze({
        section: key, id: item.id, name: item.name ?? null, status: item.status ?? null,
      }));
      if (historyItems.length >= HISTORY_LIMIT) break;
    }
    if (historyItems.length >= HISTORY_LIMIT) break;
  }
  const history = readable.length === 0
    ? Object.freeze({
      available: false, items: Object.freeze([]), count: 0, truncated: false, completeTimeline: false,
      reason: 'no history-bearing package is composed in this application — this is not a claim nothing ever happened',
    })
    : Object.freeze({
      available: true, items: Object.freeze(historyItems), count: historyItems.length,
      truncated: historyItems.length >= HISTORY_LIMIT, completeTimeline: false,
      reason: 'Accordo-managed records only: marketing, analytics and external channels are not represented',
    });

  return Object.freeze({
    customerCardContract: CUSTOMER_CARD_CONTRACT,
    subject: Object.freeze({ resource, id }),
    name,
    company: company ? Object.freeze({ id: company.id, name: company.name }) : null,
    phone,
    email,
    socials,
    status,
    activePackage,
    notes,
    history,
  });
}
