// @ts-check

import {
  AppError, ConflictError, ValidationError, normalizeActor, normalizeCompanyName,
} from '../../core/index.js';
import {
  MAX_EXTERNAL_ID_LENGTH, domainShape, emailShape, safeString,
} from './normalize.js';
import { assertMatchResult } from './policy.js';
import {
  deciding, orderedPair, subjectFields, subjectKey, trusted,
} from './store.js';

/**
 * **Channel sender resolution — which contact a channel handle names.**
 *
 * Every channel identity (a WhatsApp number, an Instagram id, a Facebook id,
 * an email address, a TikTok id, a phone number) links to a contact through
 * the `external-identity` record this package already owns, resolved by the
 * `deterministic-customer-match` rule it already declares. Nothing here
 * invents a second identity store and no new record type is created.
 *
 * One call names one sender and answers one of three outcomes:
 *
 * - `matched` — the handle already names a contact, or the sender's evidence
 *   deterministically matches one. The channel identity is recorded (or its
 *   last sighting refreshed) and the contact is returned.
 * - `created` — an unknown sender carrying an email. A contact is created
 *   through the core adapters and the channel identity is recorded against
 *   it, exactly like an accepted import row.
 * - `unresolved` — the evidence points at more than one record, or at nobody
 *   this resolution may create. A `duplicate-candidate` is recorded for every
 *   pair the evidence names and nothing is merged, linked or created.
 *
 * Two boundaries are deliberate and stated, not silent:
 *
 * - a sender that matches nothing and carries no email creates no contact. A
 *   contact needs a globally-unique email and this resolution invents none —
 *   a bare handle with no linkable evidence is a human triage case, not a
 *   fabricated customer.
 * - a sender is never matched to a company. Channel identities name people;
 *   a sender whose evidence only reaches a company either creates its contact
 *   (when it carries an email) or stays unresolved.
 */

export const CHANNEL_SYSTEMS = Object.freeze([
  'whatsapp', 'instagram', 'facebook', 'email', 'tiktok', 'phone',
]);

/**
 * Systems a held identity row may carry besides the sender vocabulary
 * above (backlog:826e377c): imports accept any lowercase system identifier,
 * so legacy rows (sms, gmail, outlook, voice, tel, mobile, messenger,
 * calendar, web, form) exist and are held. Manual Collega/Scollega was
 * split into a follow-up voce by the owner (this PR keeps only the read of
 * observed identities); when it returns, its unlink gate must accept every
 * system a held row can carry, not just the sender vocabulary.
 * (Kept as a comment: no code reads this list while link/unlink is out.)
 */

/** Provenance for identities and candidates this resolution writes: it runs outside any import run. */
export const SENDER_RUN_ID = 'channel-sender';

/**
 * Where an automatic lead comes from (backlog:13c09f03): the only two syncs
 * that invent contacts. Closed vocabulary — an unknown value refuses,
 * never a silently unattributed customer.
 */
export const SENDER_ORIGINS = Object.freeze(['gmail', 'calendar']);

/** The run recorded on identity and candidate rows: origin-scoped when the caller names one, the plain run otherwise. */
export function runIdFor(sender) {
  return sender?.origin === null || sender?.origin === undefined
    ? SENDER_RUN_ID
    : `${SENDER_RUN_ID}:${sender.origin}`;
}

/** Separators a phone handle may carry without changing who it names. The `+` prefix is kept. */
const PHONE_SEPARATOR_RE = /[ .\-()/]/g;

/**
 * A uniqueness conflict means somebody else won the race: the handle or the
 * email this resolution is about to claim is already stored. The caller
 * re-reads and replays the winner instead of surfacing a 500. Anything that
 * is not a uniqueness conflict is rethrown untouched.
 *
 * @param {unknown} error
 */
export function isWinnerConflict(error) {
  if (error instanceof ConflictError) return true;
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed')) return true;
    if (error.message.includes('duplicate key value violates unique constraint')) return true;
  }
  if (error !== null && typeof error === 'object') {
    const code = /** @type {any} */ (error).code;
    if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

/**
 * Normalize one channel handle to the external id stored beside the contact.
 * Exact after normalization — the same discipline as the match policy: no
 * fuzzy comparison, no scoring, no tie-break.
 *
 * @param {string} channel @param {string} handle
 */
export function normalizeChannelHandle(channel, handle) {
  const trimmed = safeString(handle, 'handle', { max: MAX_EXTERNAL_ID_LENGTH, required: true });
  if (channel === 'email') {
    const shaped = emailShape(trimmed);
    if (!shaped.ok) {
      throw new ValidationError('the email handle is not a valid address shape', { field: 'handle' });
    }
    return /** @type {string} */ (shaped.value);
  }
  if (channel === 'whatsapp' || channel === 'phone') {
    const compact = /** @type {string} */ (trimmed).replace(PHONE_SEPARATOR_RE, '');
    // A channel phone identity is a phone number: without at least one digit
    // past the separators and the optional leading `+` it names nobody, so
    // it is refused instead of being stored as a linkable `phone:+` identity.
    const withoutPlus = compact.startsWith('+') ? compact.slice(1) : compact;
    if (!/[0-9]/.test(withoutPlus)) {
      throw new ValidationError('the phone handle names nobody without at least one digit', { field: 'handle' });
    }
    return compact;
  }
  return /** @type {string} */ (trimmed);
}

/**
 * Validate and normalize one sender request. Throws fail-closed; nothing is
 * read or written before the whole request proves well-formed.
 *
 * @param {any} request
 */
export function normalizeChannelSender(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ValidationError('a sender resolution needs a request object');
  }
  const channel = safeString(request.channel, 'channel', { max: 64, required: true });
  if (!CHANNEL_SYSTEMS.includes(/** @type {string} */ (channel))) {
    throw new ValidationError(
      `channel must be one of ${CHANNEL_SYSTEMS.join(', ')}`, { field: 'channel' });
  }
  const externalId = normalizeChannelHandle(
    /** @type {string} */ (channel), request.handle);

  let email = null;
  if (channel === 'email') {
    email = externalId;
    if (request.email !== undefined && request.email !== null && request.email !== '') {
      // On the email channel the handle IS the observed address, so a
      // caller-supplied email naming another address is contradictory
      // evidence about one sender. It is kept, never silently dropped: the
      // resolver turns the contradiction into a candidate for a human.
      const shaped = emailShape(request.email);
      if (!shaped.ok) {
        throw new ValidationError('the sender email is not a valid address shape', { field: 'email' });
      }
      email = shaped.value;
    }
  } else if (request.email !== undefined && request.email !== null && request.email !== '') {
    const shaped = emailShape(request.email);
    if (!shaped.ok) {
      throw new ValidationError('the sender email is not a valid address shape', { field: 'email' });
    }
    email = shaped.value;
  }

  let domain = null;
  if (request.domain !== undefined && request.domain !== null && request.domain !== '') {
    const shaped = domainShape(request.domain);
    if (!shaped.ok) {
      throw new ValidationError('the sender domain is not a valid domain shape', { field: 'domain' });
    }
    domain = shaped.value;
  }

  // The sync that observed this sender (backlog:13c09f03). Absent on every
  // older caller — the identity row keeps the plain run, exactly as
  // before — and a value outside the closed vocabulary refuses, so a
  // lead is never created without a known provenance.
  let origin = null;
  if (request.origin !== undefined && request.origin !== null && request.origin !== '') {
    if (typeof request.origin !== 'string' || !SENDER_ORIGINS.includes(request.origin)) {
      throw new ValidationError('sender origin must be one of gmail, calendar', { field: 'origin' });
    }
    origin = request.origin;
  }

  return Object.freeze({
    system: /** @type {string} */ (channel),
    externalId,
    email,
    firstName: safeString(request.firstName, 'firstName'),
    lastName: safeString(request.lastName, 'lastName'),
    companyName: safeString(request.companyName, 'companyName'),
    domain,
    origin,
  });
}

/**
 * The read side the sender resolution resolves against. Built per call so a
 * resolution always sees current state — the same discipline as the import
 * path, shared with it rather than reimplemented.
 *
 * @param {{modules: any, names: any, core: any}} input
 */
export function createPolicyReader({ modules, names, core }) {
  return {
    async externalIdentity(system, externalId) {
      const rows = await deciding(trusted(modules, names.identity), { sourceKey: `${system}:${externalId}` });
      return rows.find((row) => row.status === 'active') ?? null;
    },
    async contactByEmail(email) {
      // Delegated: core owns email uniqueness and its normalization.
      if (!core || typeof core.findContactByEmail !== 'function') return null;
      return await core.findContactByEmail(email);
    },
    async companiesByName(name) {
      if (!core || typeof core.findCompaniesByNormalizedName !== 'function') return [];
      // A «no company» placeholder belongs to one contact: never a match
      // for another row (review #654, giro 4).
      return (await core.findCompaniesByNormalizedName(name)).filter((company) => !isNoCompany(company));
    },
  };
}

/**
 * The placeholder company behind a contact that names no company
 * (production 07/11). The core schema requires a company for every contact,
 * so the import gives such a contact its OWN placeholder under this name —
 * never a company derived from the email domain, and never one row shared
 * between customers (or spaces): an offer filed under it stays this
 * customer's. Customer reads (list, profile, card) read it as «no company»,
 * and the cleanup scan never pairs two of them as duplicates.
 */
export const NO_COMPANY_NAME = 'Senza azienda';

const NO_COMPANY_NORMALIZED = normalizeCompanyName(NO_COMPANY_NAME);

/**
 * Whether a company record is a «no company» placeholder. One predicate for
 * every reader, on the same normalization the company lookup uses.
 * @param {unknown} company
 */
export function isNoCompany(company) {
  const name = /** @type {any} */ (company)?.name;
  return typeof name === 'string' && normalizeCompanyName(name) === NO_COMPANY_NORMALIZED;
}

/**
 * Create the Company/Contact one resolved row names, through the core
 * adapters — never through raw SQL. Shared with the import apply path so a
 * sender-created contact is byte-for-byte the contact an import would have
 * created from the same evidence.
 *
 * @param {any} core
 * @param {{email: string|null, firstName: string|null, lastName: string|null, companyName: string|null, domain: string|null}} row
 * @param {any} actor
 * @param {{companyFromEmail?: boolean}} [options] Defaults to false
 *   (backlog:ece81578305d): the company is never derived from the email
 *   domain — a contact without Azienda takes its own placeholder. Only the
 *   import may pass `companyFromEmail: true` where a domain-derived company
 *   is intended; every other caller (sender resolution, enrichment) leaves
 *   the default.
 */
export async function createSubjectForRow(core, row, actor, options = {}) {
  if (!core || typeof core.createCompany !== 'function') {
    throw new AppError('customer-data cannot create records without the core adapters', {
      code: 'CUSTOMER_DATA_CORE_UNAVAILABLE', status: 500,
    });
  }
  if (row.email) {
    // The fallback names before any write (backlog:1a4d9b30): it refuses
    // an email that names nobody, so computing it first leaves no company
    // row behind when the lead cannot be created.
    const fallback = leadNamesForEmail(row.email);
    // A contact needs a company: reuse the named one when it exists, else
    // create it. Both go through the adapters, never through raw SQL.
    let company;
    // An explicit «Senza azienda» names no company (review #654, giro 4):
    // it takes the contact's own placeholder, never another customer's.
    const reservedName = Boolean(row.companyName) && isNoCompany({ name: row.companyName });
    if ((!row.companyName && options.companyFromEmail !== true) || reservedName) {
      // Production 07/11: a customer typed or imported with no Azienda got
      // the email domain as its company («esempio.invalid»). The core still
      // needs a company behind a contact, so the contact gets its own
      // NO_COMPANY_NAME placeholder — never a name derived from the email,
      // never a row another customer or space shares. An explicit domain
      // column stays on it as evidence (review #654).
      company = await core.createCompany({ name: NO_COMPANY_NAME, domain: row.domain ?? null }, { actor });
    } else {
      const companies = row.companyName
        ? (await core.findCompaniesByNormalizedName(row.companyName)).filter((found) => !isNoCompany(found))
        : [];
      company = companies.length === 1
        ? companies[0]
        : await core.createCompany({ name: row.companyName ?? deriveCompanyName(row), domain: row.domain ?? null }, { actor });
    }
    const contact = await core.createContact({
      companyId: company.id,
      firstName: row.firstName ?? fallback.firstName,
      lastName: row.lastName ?? fallback.lastName,
      email: row.email,
    }, { actor });
    return { resource: 'contact', id: contact.id, owner: 'host', ownerPackage: null, label: contact.email ?? row.email };
  }
  const company = await core.createCompany({ name: row.companyName, domain: row.domain ?? null }, { actor });
  return { resource: 'company', id: company.id, owner: 'host', ownerPackage: null, label: company.name ?? row.companyName };
}

/**
 * A lead's names from its email address (backlog:1a4d9b30): the first
 * token of the local part names, the rest describes
 * (`mario.rossi@azienda.it` becomes Mario Rossi). With no tokens the
 * trimmed local part itself names (`guido+tag@example.com` becomes
 * Guido); with no local part at all there is nobody to name, so the
 * helper refuses and no lead is created. The company the contact
 * needs is the sender domain when no company was named — an honest
 * placeholder, never an invented `Unknown (…)`. Both company and contact
 * names are required non-empty by their services, so a single-token
 * local part (`guido@example.com`) carries `—` as its last name instead
 * of an English placeholder.
 * @param {unknown} email
 */
export function leadNamesForEmail(email) {
  const text = typeof email === 'string' ? email : '';
  const at = text.lastIndexOf('@');
  const local = ((at > 0 ? text.slice(0, at) : text).split('+')[0] ?? '').trim();
  const tokens = local.split(/[._-]+/).map((token) => token.trim()).filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1, 64)).slice(0, 8);
  const firstName = tokens[0] ?? local.slice(0, 64);
  if (firstName === '' || !/[\p{L}\p{N}]/u.test(firstName)) {
    throw new ValidationError('lead email names nobody without a local part', { field: 'email' });
  }
  const lastName = tokens.length > 1 ? tokens.slice(1).join(' ').slice(0, 128) : '—';
  return { firstName, lastName };
}

/**
 * @param {{email: string|null, domain: string|null}} row
 */
function deriveCompanyName(row) {
  if (row.domain) return row.domain;
  const email = typeof row.email === 'string' ? row.email : '';
  const domain = email.slice(email.lastIndexOf('@') + 1).trim().toLowerCase();
  return domain !== '' ? domain : email;
}

/**
 * Record (or refresh the sighting of) the external identity naming a subject.
 * Shared with the import apply path: one identifier names one record, once —
 * a second sighting refreshes `lastObserved`, never a second row.
 *
 * @param {{modules: any, names: any, system: string, externalId: string,
 *   subject: {resource: string, id: string, owner: string, ownerPackage: string|null, label: string|null},
 *   runId: string, actor: any}} input
 * @returns {'linked'|'refreshed'}
 */
export async function recordExternalIdentityRow({
  modules, names, system, externalId, subject, runId, actor,
}) {
  const identities = trusted(modules, names.identity);
  const sourceKey = `${system}:${externalId}`;
  const existing = (await deciding(identities, { sourceKey }))[0];
  const now = new Date().toISOString();
  if (existing) {
    await identities.applyManaged(existing.id, { lastObservedRunId: runId, lastObservedAt: now }, { actor });
    return 'refreshed';
  }
  await identities.createManaged({
    sourceKey,
    system,
    externalId,
    ...subjectFields(subject),
    status: 'active',
    firstObservedRunId: runId,
    lastObservedRunId: runId,
    firstObservedAt: now,
    lastObservedAt: now,
  }, { actor });
  return 'linked';
}

/**
 * Record every pair of an ambiguous evidence set as an unresolved
 * duplicate candidate for a human. Never resolves, never merges — shared
 * with the import apply path. Pairs naming an opted-out contact are never
 * written (owner decision Q-G1): the count returned is the pairs stored.
 *
 * @param {{modules: any, names: any, policy: {name: string, version: number, fingerprint: string},
 *   pairs: Array<{left: any, right: any}>, rule: string, evidence: string, runId: string, actor: any}} input
 */
export async function recordCandidatePairs({
  modules, names, policy, pairs, rule, evidence, runId, actor,
}) {
  const candidates = trusted(modules, names.candidate);
  // Owner decision Q-G1 (BO-F1-04): a contact with an opt-out never enters a
  // union proposal. The single choke point for every proposal path (sender,
  // import, enrichment, connect) skips pairs naming an opted-out contact —
  // the pair is never written, so there is nothing for a human to decide on.
  const optOuts = trusted(modules, names?.optOut ?? 'enrichment-opt-out');
  async function optedOut(subject) {
    if (!subject || subject.resource !== 'contact' || !subject.id) return false;
    const rows = await deciding(optOuts, { subjectResource: 'contact', subjectId: subject.id });
    return rows.length > 0;
  }
  let written = 0;
  for (const { left, right } of pairs) {
    const sourceKey = `duplicate:${subjectKey(left)}|${subjectKey(right)}`;
    if ((await deciding(candidates, { sourceKey }))[0]) continue;
    if (await optedOut(left) || await optedOut(right)) continue;
    await candidates.createManaged({
      sourceKey,
      ...subjectFields(left, 'left'),
      ...subjectFields(right, 'right'),
      policy: policy.name,
      policyVersion: policy.version,
      policyFingerprint: policy.fingerprint,
      rule,
      evidence,
      status: 'unresolved',
      detectedByRunId: runId,
      detectedAt: new Date().toISOString(),
      decisionId: null,
      decidedReason: null,
      decidedByType: null,
      decidedById: null,
      decidedAt: null,
    }, { actor });
    written += 1;
  }
  return written;
}

/**
 * @param {Array<any>} subjects
 */
function distinctPairs(subjects) {
  const seen = new Map();
  for (const subject of subjects) {
    const key = subjectKey(subject);
    if (!seen.has(key)) seen.set(key, subject);
  }
  const unique = [...seen.values()];
  const pairs = [];
  for (let i = 0; i < unique.length; i += 1) {
    for (let j = i + 1; j < unique.length; j += 1) {
      pairs.push(orderedPair(unique[i], unique[j]));
    }
  }
  return pairs;
}

/**
 * @param {{resource: string, id: string}} subject
 */
function asContact(subject) {
  return subject.resource === 'contact' ? { resource: 'contact', id: subject.id } : null;
}

/** @param {any} runtime */
export function createChannelSenderResolution({
  database, modules, events, core, policy, names,
}) {
  if (!database || !modules || !events) {
    throw new ValidationError('channel sender resolution needs database, modules and events');
  }
  if (!policy || typeof policy.resolve !== 'function') {
    throw new ValidationError('channel sender resolution needs the declared match policy');
  }

  /**
   * Resolve one channel sender to its contact. Reads resolve against current
   * state; every write lands in one transaction, and the identity is
   * re-checked inside it so a concurrent resolution of the same sender
   * replays the winner instead of writing twice.
   *
   * @param {any} request
   */
  async function resolveChannelSender(request) {
    const answer = await decide(request);
    // Trace without PII: the handle that was resolved travels in storage
    // (the identity row), never in the event payload.
    events.emit?.('customer-data.sender.resolved', {
      system: answer.system, outcome: answer.outcome, rule: answer.rule,
    });
    return answer;
  }

  /**
   * @param {any} request
   */
  async function decide(request) {
    const sender = normalizeChannelSender(request);
    const actor = normalizeActor(request?.actor);
    const reader = createPolicyReader({ modules, names, core });

    const known = await reader.externalIdentity(sender.system, sender.externalId);
    const emailContact = sender.email ? await reader.contactByEmail(sender.email) : null;
    const emailSubject = emailContact
      ? {
        resource: 'contact', id: emailContact.id, owner: 'host', ownerPackage: null,
        label: emailContact.email ?? sender.email,
      }
      : null;
    const knownSubject = known
      ? {
        resource: known.subjectResource,
        id: known.subjectId,
        owner: known.subjectOwner,
        ownerPackage: known.subjectOwnerPackage,
        label: known.subjectLabel,
      }
      : null;

    if (sender.system === 'email' && sender.email !== sender.externalId) {
      // The observed handle and the caller-supplied email name different
      // addresses. Both point at one sender, so dropping either would decide
      // who the sender is: a candidate for a human instead. The one case
      // that still resolves is agreement — both name the same contact —
      // which falls through to the known-identity path below.
      const knownContactForEmail = knownSubject && knownSubject.resource === 'contact' ? knownSubject : null;
      const agrees = Boolean(knownContactForEmail && emailSubject && emailSubject.id === knownContactForEmail.id);
      if (!agrees) {
        const subjects = [];
        if (knownSubject) subjects.push(knownSubject);
        if (emailSubject && (!knownSubject || emailSubject.id !== knownSubject.id)) subjects.push(emailSubject);
        return senderUnresolved(sender, actor, {
          rule: 'external-identity',
          candidates: subjects,
          evidence: `channel handle ${sender.system} contradicts the sender email carried with it; a human decides`,
        });
      }
    }

    if (known) {
      const knownSubjectHere = /** @type {{resource: string, id: string, owner: string, ownerPackage: string|null, label: string|null}} */ (knownSubject);
      const knownContact = asContact(knownSubjectHere);
      if (knownContact && emailSubject && emailSubject.id !== knownContact.id) {
        // The handle names one contact and the email names another. That is
        // conflicting evidence about one sender: a candidate for a human,
        // never an automatic re-link.
        const written = await database.transactionAsync(async () => recordCandidatePairs({
          modules, names, policy,
          pairs: distinctPairs([knownSubjectHere, emailSubject]),
          rule: 'external-identity',
          evidence: `channel handle ${sender.system} names one contact and the sender email names another`,
          runId: runIdFor(sender),
          actor,
        }));
        return Object.freeze({
          system: sender.system,
          outcome: 'unresolved',
          rule: 'external-identity',
          contact: null,
          candidates: [knownSubjectHere, emailSubject].map((subject) => Object.freeze({ ...subject })),
          candidatesWritten: written,
          identity: null,
          evidence: `channel handle ${sender.system} names one contact and the sender email names another; a human decides`,
        });
      }
      if (knownContact) {
        // A second sighting refreshes lastObserved, never a second row —
        // the recorded promise in the package metadata and README.
        const identity = await database.transactionAsync(async () => recordExternalIdentityRow({
          modules, names, system: sender.system, externalId: sender.externalId,
          subject: knownSubjectHere,
          runId: runIdFor(sender), actor,
        }));
        return Object.freeze({
          system: sender.system,
          outcome: 'matched',
          rule: 'external-identity',
          contact: Object.freeze({ ...knownContact }),
          candidates: [],
          candidatesWritten: 0,
          identity,
          evidence: `channel handle ${sender.system} already names this contact`,
        });
      }
      return senderUnresolved(sender, actor, {
        rule: 'external-identity',
        candidates: emailSubject ? [knownSubjectHere, emailSubject] : [knownSubjectHere],
        evidence: `channel handle ${sender.system} names a ${known.subjectResource}, not a contact, so it cannot identify this sender`,
      });
    }

    const result = assertMatchResult(
      await policy.resolve({ row: sender, reader }),
      `Customer match policy "${policy.name}@${policy.version}"`);

    if (result.outcome === 'matched' && result.subject?.resource === 'contact') {
      const subject = {
        resource: 'contact',
        id: result.subject.id,
        owner: result.subject.owner ?? 'host',
        ownerPackage: result.subject.ownerPackage ?? null,
        label: result.subject.label ?? sender.email,
      };
      const linked = await database.transactionAsync(async () => {
        const raced = await reader.externalIdentity(sender.system, sender.externalId);
        // A concurrent resolution won: replay it. A non-contact winner is
        // not a contact — the next call takes the known-identity path.
        if (raced && raced.subjectResource !== 'contact') return { nonContact: true };
        const winner = raced
          ? {
            resource: 'contact',
            id: raced.subjectId,
            owner: raced.subjectOwner,
            ownerPackage: raced.subjectOwnerPackage,
            label: raced.subjectLabel,
          }
          : subject;
        // recordExternalIdentityRow links a first sighting and refreshes
        // lastObserved on a replayed one — never a second row. A uniqueness
        // conflict means a concurrent resolution committed the same handle
        // after the re-check above: replay the winner with the same
        // discipline the company and creation paths use instead of
        // surfacing the raw conflict.
        try {
          const identity = await recordExternalIdentityRow({
            modules, names, system: sender.system, externalId: sender.externalId,
            subject: winner, runId: runIdFor(sender), actor,
          });
          return { identity, contactId: winner.id, wonByRace: Boolean(raced) };
        } catch (error) {
          return replayRaceLoser(error);
        }
      });
      if (linked.nonContact) {
        return decide({ ...request, handle: sender.externalId });
      }
      if ((linked.replayed || linked.wonByRace) && linked.contactId) {
        // A replayed handle — whether it lost a uniqueness conflict or the
        // in-transaction re-check already found the winner — reports the
        // winner with the replay receipt, never the pre-read policy that
        // matched somebody else. The race-won link already refreshed the
        // sighting inside its transaction, so its identity is reused.
        const identity = linked.wonByRace
          ? linked.identity
          : await database.transactionAsync(async () => refreshReplayed(linked.contactId));
        return Object.freeze({
          system: sender.system,
          outcome: 'matched',
          rule: 'external-identity',
          contact: Object.freeze({ resource: 'contact', id: linked.contactId }),
          candidates: [],
          candidatesWritten: 0,
          identity,
          evidence: `channel handle ${sender.system} already names this contact`,
        });
      }
      return Object.freeze({
        system: sender.system,
        outcome: 'matched',
        rule: result.rule,
        contact: Object.freeze({ resource: 'contact', id: /** @type {string} */ (linked.contactId) }),
        candidates: [],
        candidatesWritten: 0,
        identity: linked.identity,
        evidence: result.evidence,
      });
    }

    /**
     * A sender email that appeared after the pre-transaction reads — a
     * concurrent resolution created its contact first. The caller links this
     * handle to the winner instead of creating a duplicate beside it.
     */
    async function replayEmailWinner() {
      if (!sender.email) return null;
      const winner = await reader.contactByEmail(sender.email);
      if (!winner) return null;
      return { replayed: true, contactId: winner.id };
    }

    /**
     * The creation write lost a uniqueness race after the re-checks. Re-read:
     * whoever won is now stored, so replay the winner. When no winner is
     * visible the error is genuine — rethrow it untouched.
     *
     * @param {unknown} error
     */
    async function replayRaceLoser(error) {
      if (!isWinnerConflict(error)) throw error;
      const retryHandle = await reader.externalIdentity(sender.system, sender.externalId);
      if (retryHandle && retryHandle.subjectResource === 'contact') {
        return { replayed: true, contactId: retryHandle.subjectId };
      }
      const retryEmail = await replayEmailWinner();
      if (retryEmail) return retryEmail;
      throw error;
    }

    /**
     * One write for a replayed handle: refresh its sighting, never a second
     * row. The refresh path only touches lastObserved, so the stored subject
     * snapshot is never rewritten.
     *
     * @param {string} contactId
     */
    async function refreshReplayed(contactId) {
      return recordExternalIdentityRow({
        modules, names, system: sender.system, externalId: sender.externalId,
        subject: {
          resource: 'contact', id: contactId, owner: 'host', ownerPackage: null,
          label: sender.email,
        },
        runId: runIdFor(sender), actor,
      });
    }

    if (result.outcome === 'matched' && result.subject?.resource === 'company') {
      if (!sender.email) {
        return senderUnresolved(sender, actor, {
          rule: result.rule,
          candidates: [{
            resource: 'company',
            id: result.subject.id,
            owner: result.subject.owner ?? 'host',
            ownerPackage: result.subject.ownerPackage ?? null,
            label: result.subject.label ?? null,
          }],
          evidence: 'the sender evidence reaches a company but carries no email, so no contact can be created or confirmed',
        });
      }
      if (sender.firstName == null || sender.lastName == null) {
        // The fallback names before any write (backlog:1a4d9b30): an email
        // that names nobody refuses here, so the transaction below never
        // opens and no contact — and no company — is written.
        try {
          leadNamesForEmail(sender.email);
        } catch {
          return senderUnresolved(sender, actor, {
            rule: result.rule,
            candidates: [],
            evidence: 'the sender email carries no nameable local part, so no contact is created; a human decides',
          });
        }
      }
      const created = await database.transactionAsync(async () => {
        const raced = await reader.externalIdentity(sender.system, sender.externalId);
        if (raced && raced.subjectResource !== 'contact') return { replayed: false, nonContact: true };
        if (raced) {
          return { replayed: true, contactId: raced.subjectId };
        }
        // The contact email is globally unique: a concurrent resolution may
        // have created its contact after the pre-transaction reads. Replay
        // the winner instead of duplicating it — or throwing on its
        // constraint. (The company itself is matched by id and guarded by
        // its foreign key, so there is no second record to re-check there.)
        const emailReplay = await replayEmailWinner();
        if (emailReplay) return emailReplay;
        try {
          const fallback = leadNamesForEmail(sender.email);
          const contact = await core.createContact({
            companyId: result.subject.id,
            firstName: sender.firstName ?? fallback.firstName,
            lastName: sender.lastName ?? fallback.lastName,
            email: sender.email,
          }, { actor });
          const subject = {
            resource: 'contact', id: contact.id, owner: 'host', ownerPackage: null,
            label: contact.email ?? sender.email,
          };
          await recordExternalIdentityRow({
            modules, names, system: sender.system, externalId: sender.externalId,
            subject, runId: runIdFor(sender), actor,
          });
          return { replayed: false, contactId: contact.id };
        } catch (error) {
          return replayRaceLoser(error);
        }
      });
      if (created.nonContact) {
        // A concurrent write linked this handle to a non-contact: re-resolve
        // through the known-identity path instead of creating beside it.
        return decide({ ...request, handle: sender.externalId });
      }
      if (created.replayed && created.contactId) {
        const identity = await database.transactionAsync(async () => refreshReplayed(created.contactId));
        return Object.freeze({
          system: sender.system,
          outcome: 'matched',
          rule: 'external-identity',
          contact: Object.freeze({ resource: 'contact', id: created.contactId }),
          candidates: [],
          candidatesWritten: 0,
          identity,
          evidence: `channel handle ${sender.system} already names this contact`,
        });
      }
      return Object.freeze({
        system: sender.system,
        outcome: 'created',
        rule: result.rule,
        contact: Object.freeze({ resource: 'contact', id: /** @type {string} */ (created.contactId) }),
        candidates: [],
        candidatesWritten: 0,
        identity: 'linked',
        evidence: `${result.evidence}; the sender email created its contact under that company`,
      });
    }

    if (result.outcome === 'unresolved') {
      return senderUnresolved(sender, actor, {
        rule: result.rule,
        candidates: result.candidates ?? [],
        evidence: result.evidence,
      });
    }

    if (!sender.email) {
      // Unknown sender, nothing linkable, and no email to create from. A
      // contact needs a globally-unique email and this resolution invents
      // none — a human triage case, recorded as unresolved with no writes.
      return Object.freeze({
        system: sender.system,
        outcome: 'unresolved',
        rule: 'none',
        contact: null,
        candidates: [],
        candidatesWritten: 0,
        identity: null,
        evidence: 'unknown sender with no linkable identity and no email: no contact created and nothing merged; a human decides',
      });
    }

    if (sender.firstName == null || sender.lastName == null) {
      // Same no-write guard as the company path (backlog:1a4d9b30): an
      // email that names nobody stays unresolved with no writes, instead
      // of refusing inside the creation transaction.
      try {
        leadNamesForEmail(sender.email);
      } catch {
        return senderUnresolved(sender, actor, {
          rule: 'none',
          candidates: [],
          evidence: 'the sender email carries no nameable local part, so no contact is created; a human decides',
        });
      }
    }

    const created = await database.transactionAsync(async () => {
      const raced = await reader.externalIdentity(sender.system, sender.externalId);
      if (raced && raced.subjectResource !== 'contact') return { replayed: false, nonContact: true };
      if (raced) {
        return { replayed: true, contactId: raced.subjectId };
      }
      // Same globally-unique email re-check as the company path: a
      // concurrent sender carrying this email may have created its contact
      // after the pre-transaction reads.
      const emailReplay = await replayEmailWinner();
      if (emailReplay) return emailReplay;
      try {
        const subject = await createSubjectForRow(core, sender, actor);
        if (subject.resource !== 'contact') {
          throw new AppError('a sender resolution creates a contact, never a bare company', {
            code: 'SENDER_SUBJECT_INVALID', status: 500,
          });
        }
        await recordExternalIdentityRow({
          modules, names, system: sender.system, externalId: sender.externalId,
          subject: {
            resource: subject.resource,
            id: subject.id,
            owner: subject.owner,
            ownerPackage: subject.ownerPackage,
            label: subject.label,
          },
          runId: runIdFor(sender),
          actor,
        });
        return { replayed: false, contactId: subject.id };
      } catch (error) {
        return replayRaceLoser(error);
      }
    });
    if (created.nonContact) {
      // A concurrent write linked this handle to a non-contact: re-resolve
      // through the known-identity path instead of creating beside it.
      return decide({ ...request, handle: sender.externalId });
    }
    if (created.replayed && created.contactId) {
      const identity = await database.transactionAsync(async () => refreshReplayed(created.contactId));
      return Object.freeze({
        system: sender.system,
        outcome: 'matched',
        rule: 'external-identity',
        contact: Object.freeze({ resource: 'contact', id: created.contactId }),
        candidates: [],
        candidatesWritten: 0,
        identity,
        evidence: `channel handle ${sender.system} already names this contact`,
      });
    }
    return Object.freeze({
      system: sender.system,
      outcome: 'created',
      rule: 'none',
      contact: Object.freeze({ resource: 'contact', id: /** @type {string} */ (created.contactId) }),
      candidates: [],
      candidatesWritten: 0,
      identity: 'linked',
      evidence: 'no existing record matched, so this sender created its contact',
    });
  }

  /**
   * @param {{system: string}} sender @param {any} actor
   * @param {{rule: string, candidates: any[], evidence: string}} input
   */
  async function senderUnresolved(sender, actor, input) {
    const pairs = distinctPairs(input.candidates);
    const written = pairs.length === 0 ? 0 : await database.transactionAsync(async () => recordCandidatePairs({
      modules, names, policy,
      pairs,
      rule: input.rule,
      evidence: input.evidence,
      runId: runIdFor(sender),
      actor,
    }));
    return Object.freeze({
      system: sender.system,
      outcome: 'unresolved',
      rule: input.rule,
      contact: null,
      candidates: Object.freeze(input.candidates.map((candidate) => Object.freeze({ ...candidate }))),
      candidatesWritten: written,
      identity: null,
      evidence: input.evidence,
    });
  }

  return { resolveChannelSender };
}
