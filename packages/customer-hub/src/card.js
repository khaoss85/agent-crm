// @ts-check

import { CUSTOMER_EVIDENCE_KEYS, NotFoundError, ValidationError, deriveCustomerStatus } from '../../core/index.js';
// This module imports nothing from customer-data — not even its entry. The
// consolidated profile arrives as a bound reader opened by `src/index.js`
// through the declared `customer-profile@1` capability, so the shaping below
// cannot diverge from the provider's name resolution. The status rule itself
// is shared with the customer list through the core (same `cliente` verdict
// on both screens, by construction).

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
export const CUSTOMER_EVIDENCE_SECTIONS = CUSTOMER_EVIDENCE_KEYS;

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
  // Newest first, like the profile: scan every phone-bearing identity and
  // take the first dialable one, so one newer non-dialable channel id never
  // hides an older callable number held beside the same record.
  const phoneIdentities = identities.filter((row) => PHONE_SYSTEMS.includes(String(row.system).toLowerCase()));
  const dialableIdentity = phoneIdentities.find((row) => toDialablePhone(row.externalId) !== null) ?? null;
  const newestHeld = phoneIdentities[0] ?? null;
  const phone = dialableIdentity
    ? Object.freeze({ available: true, value: dialableIdentity.externalId, system: dialableIdentity.system, reason: null })
    : newestHeld
      ? Object.freeze({
        available: false, value: null, system: null,
        reason: `the held ${newestHeld.system} identity '${newestHeld.externalId}' is not a dialable phone number (E.164 expected) — this is not a claim the customer has no phone`,
      })
      : Object.freeze({
        available: false, value: null, system: null,
        reason: 'no phone-bearing channel identity (WhatsApp, SMS, voice) is held beside this record — this is not a claim the customer has no phone',
      });

  const socials = Object.freeze(identities
    .filter((row) => SOCIAL_SYSTEMS.includes(String(row.system).toLowerCase()))
    .map((row) => Object.freeze({ system: row.system, handle: row.externalId })));

  // Signed business promotes; an absence claim needs proof, not silence: the
  // one shared rule below refuses the claim when evidence is unreadable.
  const status = deriveCustomerStatus({
    orders: profile.orders, contracts: profile.contracts, subscriptions: profile.subscriptions,
  });

  const subscriptions = profile.subscriptions?.available === true ? profile.subscriptions : null;
  // The profile count is a floor, not a total, when the owning module offers
  // no exact query (countIsComplete:false with a countNote): carry that
  // qualifier so the card never prints a bounded page as an exact total. And
  // the active list is filtered from the profile's first-50 slice: when that
  // slice is truncated and holds no active record, the card must not report a
  // definitive "no active package" — the active record may sit past the slice.
  // The same holds for a floor count (countIsComplete:false): the bounded page
  // is not the whole evidence, so "no active in hand" is unavailable-with-a-
  // reason, never a definitive "none" — mirroring the status absenceIsProven
  // guard two screens above.
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
    : (packageActive.length > 0 || (!packageTruncated && packageCountIsComplete))
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
        truncated: packageTruncated,
        active: Object.freeze([]),
        items: subscriptions.items ?? Object.freeze([]),
        reason: packageTruncated
          ? 'the subscriptions page is truncated and holds no active record in hand: '
            + 'an active package may exist past the readable slice, so this is not a claim none exists'
            + (packageQualifier ? ` (${packageQualifier})` : '')
          : 'the subscriptions count is a floor from a bounded page and the page holds no active record in hand: '
            + 'an active package may sit outside the readable evidence, so this is not a claim none exists'
            + (packageQualifier ? ` (${packageQualifier})` : ''),
      });

  const notes = Object.freeze({
    available: false, items: null,
    reason: 'this application composes no notes record for customers, so the card reports none rather than an empty list',
  });

  const readable = HISTORY_SECTIONS.filter((key) => profile[key]?.available === true);
  const historyItems = [];
  // Truncated means rows were actually left out: the cap stopped the loop
  // with profile rows still unconsumed, or a section we drew from reports its
  // own truncation. A complete timeline of exactly HISTORY_LIMIT rows reads
  // complete — the flag mirrors the profile's strict `rows.length > 50`.
  let capped = false;
  const consumedSections = [];
  for (const key of readable) {
    let took = 0;
    for (const item of profile[key]?.items ?? []) {
      if (historyItems.length >= HISTORY_LIMIT) { capped = true; break; }
      historyItems.push(Object.freeze({
        section: key, id: item.id, name: item.name ?? null, status: item.status ?? null,
      }));
      took += 1;
    }
    if (took > 0) consumedSections.push(key);
    if (capped) break;
  }
  const historyTruncated = capped || consumedSections.some((key) => profile[key]?.truncated === true);
  const history = readable.length === 0
    ? Object.freeze({
      available: false, items: Object.freeze([]), count: 0, truncated: false, completeTimeline: false,
      reason: 'no history-bearing package is composed in this application — this is not a claim nothing ever happened',
    })
    : Object.freeze({
      available: true, items: Object.freeze(historyItems), count: historyItems.length,
      truncated: historyTruncated, completeTimeline: false,
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
