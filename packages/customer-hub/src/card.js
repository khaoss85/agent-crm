// @ts-check

import { NotFoundError, ValidationError } from '../../core/index.js';
// This module imports nothing from customer-data — not even its entry. The
// consolidated profile arrives as a bound reader opened by `src/index.js`
// through the declared `customer-profile@1` capability, so the shaping below
// cannot diverge from the provider's name resolution.

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
 *   subscriptions), otherwise `contatto`. The negative claim is definitive
 *   only when all three evidence packages are readable with complete zero
 *   counts; otherwise the reason names what was not readable, never "none";
 * - active package: the subscriptions section of the profile;
 * - notes: this application composes no notes record for customers, so the
 *   card reports the field as unavailable rather than inventing one;
 * - history: the profile sections flattened into one list, newest first
 *   within each section, capped like the profile itself.
 */

export const CUSTOMER_CARD_CONTRACT = 1;

/** Identity systems whose external id is a callable phone number. */
export const PHONE_SYSTEMS = Object.freeze(['whatsapp', 'sms', 'voice', 'phone', 'tel', 'mobile']);

/**
 * A phone-bearing identity IS a phone number only when the held id dials as
 * E.164 once display formatting (spaces, dashes, dots, parentheses) is
 * stripped. A CRM identifier such as `CRM-1` is held, never callable.
 *
 * @param {unknown} value the held external id
 * @returns {string|null} the normalized E.164 number, or null when not dialable
 */
export function toDialablePhone(value) {
  const normalized = String(value ?? '').replace(/[\s\-().]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(normalized) ? normalized : null;
}

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
 * @param {{core?: any, subject: {resource: string, id: string}, readProfile: (input: {core?: any, subject: {resource: string, id: string}}) => Promise<any>}} input
 */
export async function readCustomerCard({ core, subject, readProfile }) {
  const resource = subject?.resource;
  const id = subject?.id;
  if (typeof resource !== 'string' || typeof id !== 'string' || resource === '' || id === '') {
    throw new ValidationError('a customer card needs a subject resource and id', { field: 'id' });
  }
  if (typeof readProfile !== 'function') {
    throw new ValidationError('a customer card needs the customer-data profile reader (customer-profile@1)', { field: 'profile' });
  }
  const profile = await readProfile({ core, subject: { resource, id } });
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
  const dialable = phoneIdentity ? toDialablePhone(phoneIdentity.externalId) : null;
  const phone = phoneIdentity && dialable
    ? Object.freeze({ available: true, value: phoneIdentity.externalId, system: phoneIdentity.system, reason: null })
    : phoneIdentity
      ? Object.freeze({
        available: false, value: null, system: null,
        reason: `the held ${phoneIdentity.system} identity is not a dialable phone number (E.164 expected) — this is not a claim the customer has no phone`,
      })
      : Object.freeze({
        available: false, value: null, system: null,
        reason: 'no phone-bearing channel identity (WhatsApp, SMS, voice) is held beside this record — this is not a claim the customer has no phone',
      });

  const socials = Object.freeze(identities
    .filter((row) => SOCIAL_SYSTEMS.includes(String(row.system).toLowerCase()))
    .map((row) => Object.freeze({ system: row.system, handle: row.externalId })));

  // Signed business promotes; an absence claim needs proof, not silence: a
  // section the application never composed (available:false) or read only
  // partially (countIsComplete:false) refuses the claim that nothing exists.
  const evidence = CUSTOMER_EVIDENCE_SECTIONS
    .filter((key) => profile[key]?.available === true && (profile[key]?.count ?? 0) > 0);
  const describeSection = (key) => {
    const section = profile[key];
    if (section?.available !== true) return `${key}: not readable here`;
    if ((section.count ?? 0) > 0) return `${key}: ${section.count} on record`;
    if (section.countIsComplete === false) return `${key}: partially readable`;
    return `${key}: none on record`;
  };
  const absenceIsProven = CUSTOMER_EVIDENCE_SECTIONS.every(
    (key) => profile[key]?.available === true
      && (profile[key]?.count ?? 0) === 0
      && profile[key]?.countIsComplete !== false,
  );
  const status = evidence.length > 0
    ? Object.freeze({ value: 'cliente', reason: `signed business on record: ${evidence.join(', ')}` })
    : absenceIsProven
      ? Object.freeze({
        value: 'contatto',
        reason: 'no orders, contracts or subscriptions reference this customer — quotes and opportunities alone do not promote a contact',
      })
      : Object.freeze({
        value: 'contatto',
        reason: `no signed business found in the composed packages (${CUSTOMER_EVIDENCE_SECTIONS.map(describeSection).join('; ')})`
          + ' — the evidence packages are not all readable here, so this is not a claim none exist',
      });

  const subscriptions = profile.subscriptions?.available === true ? profile.subscriptions : null;
  // The profile count is a floor, not a total, when the owning module offers
  // no exact query (countIsComplete:false with a countNote): carry that
  // qualifier so the card never prints a bounded page as an exact total. And
  // the active list is filtered from the profile's first-50 slice: when that
  // slice is truncated and holds no active record, the card must not report a
  // definitive "no active package" — the active record may sit past the slice.
  const packageCountIsComplete = subscriptions ? subscriptions.countIsComplete !== false : true;
  const packageTruncated = subscriptions ? subscriptions.truncated === true : false;
  const packageActive = Object.freeze((subscriptions?.items ?? []).filter((item) => item.status === 'active'));
  const packageQualifier = packageCountIsComplete
    ? null
    : (subscriptions?.countNote
      ?? 'the subscriptions count is a floor from a bounded page, not an exact total');
  const activePackage = !subscriptions
    ? Object.freeze({
      available: false, count: null, countIsComplete: true, countNote: null, truncated: false,
      active: Object.freeze([]), items: Object.freeze([]),
      reason: profile.subscriptions?.reason
        ?? 'subscriptions are not composed in this application — this is not a claim the customer holds no package',
    })
    : (packageActive.length > 0 || !packageTruncated)
      ? Object.freeze({
        available: true,
        count: subscriptions.count,
        countIsComplete: packageCountIsComplete,
        countNote: subscriptions.countNote ?? null,
        truncated: packageTruncated,
        active: packageActive,
        items: subscriptions.items ?? Object.freeze([]),
        reason: packageQualifier,
      })
      : Object.freeze({
        available: false,
        count: subscriptions.count,
        countIsComplete: packageCountIsComplete,
        countNote: subscriptions.countNote ?? null,
        truncated: true,
        active: Object.freeze([]),
        items: subscriptions.items ?? Object.freeze([]),
        reason: 'the subscriptions page is truncated and holds no active record in hand: '
          + 'an active package may exist past the readable slice, so this is not a claim none exists'
          + (packageQualifier ? ` (${packageQualifier})` : ''),
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
