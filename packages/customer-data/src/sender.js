// @ts-check

import { AppError, ValidationError, normalizeActor } from '../../core/index.js';
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

/** Provenance for identities and candidates this resolution writes: it runs outside any import run. */
export const SENDER_RUN_ID = 'channel-sender';

/** Separators a phone handle may carry without changing who it names. The `+` prefix is kept. */
const PHONE_SEPARATOR_RE = /[ .\-()/]/g;

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
    const digits = /** @type {string} */ (trimmed).replace(PHONE_SEPARATOR_RE, '');
    if (digits === '') {
      throw new ValidationError('the phone handle names nobody once separators are removed', { field: 'handle' });
    }
    return digits;
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

  return Object.freeze({
    system: /** @type {string} */ (channel),
    externalId,
    email,
    firstName: safeString(request.firstName, 'firstName'),
    lastName: safeString(request.lastName, 'lastName'),
    companyName: safeString(request.companyName, 'companyName'),
    domain,
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
      return await core.findCompaniesByNormalizedName(name);
    },
  };
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
 */
export async function createSubjectForRow(core, row, actor) {
  if (!core || typeof core.createCompany !== 'function') {
    throw new AppError('customer-data cannot create records without the core adapters', {
      code: 'CUSTOMER_DATA_CORE_UNAVAILABLE', status: 500,
    });
  }
  if (row.email) {
    // A contact needs a company: reuse the named one when it exists, else
    // create it. Both go through the adapters, never through raw SQL.
    const companies = row.companyName ? await core.findCompaniesByNormalizedName(row.companyName) : [];
    const company = companies.length === 1
      ? companies[0]
      : await core.createCompany({ name: row.companyName ?? deriveCompanyName(row), domain: row.domain ?? null }, { actor });
    const contact = await core.createContact({
      companyId: company.id,
      firstName: row.firstName ?? 'Unknown',
      lastName: row.lastName ?? 'Unknown',
      email: row.email,
    }, { actor });
    return { resource: 'contact', id: contact.id, owner: 'host', ownerPackage: null, label: contact.email ?? row.email };
  }
  const company = await core.createCompany({ name: row.companyName, domain: row.domain ?? null }, { actor });
  return { resource: 'company', id: company.id, owner: 'host', ownerPackage: null, label: company.name ?? row.companyName };
}

/**
 * @param {{email: string|null, domain: string|null}} row
 */
function deriveCompanyName(row) {
  const domain = row.domain;
  return domain ? domain : `Unknown (${row.email})`;
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
 * with the import apply path.
 *
 * @param {{modules: any, names: any, policy: {name: string, version: number, fingerprint: string},
 *   pairs: Array<{left: any, right: any}>, rule: string, evidence: string, runId: string, actor: any}} input
 */
export async function recordCandidatePairs({
  modules, names, policy, pairs, rule, evidence, runId, actor,
}) {
  const candidates = trusted(modules, names.candidate);
  let written = 0;
  for (const { left, right } of pairs) {
    const sourceKey = `duplicate:${subjectKey(left)}|${subjectKey(right)}`;
    if ((await deciding(candidates, { sourceKey }))[0]) continue;
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

    if (known) {
      const knownSubject = {
        resource: known.subjectResource,
        id: known.subjectId,
        owner: known.subjectOwner,
        ownerPackage: known.subjectOwnerPackage,
        label: known.subjectLabel,
      };
      const knownContact = asContact(knownSubject);
      if (knownContact && emailSubject && emailSubject.id !== knownContact.id) {
        // The handle names one contact and the email names another. That is
        // conflicting evidence about one sender: a candidate for a human,
        // never an automatic re-link.
        const written = await database.transactionAsync(async () => recordCandidatePairs({
          modules, names, policy,
          pairs: distinctPairs([knownSubject, emailSubject]),
          rule: 'external-identity',
          evidence: `channel handle ${sender.system} names one contact and the sender email names another`,
          runId: SENDER_RUN_ID,
          actor,
        }));
        return Object.freeze({
          system: sender.system,
          outcome: 'unresolved',
          rule: 'external-identity',
          contact: null,
          candidates: [knownSubject, emailSubject].map((subject) => Object.freeze({ ...subject })),
          candidatesWritten: written,
          identity: null,
          evidence: `channel handle ${sender.system} names one contact and the sender email names another; a human decides`,
        });
      }
      if (knownContact) {
        return Object.freeze({
          system: sender.system,
          outcome: 'matched',
          rule: 'external-identity',
          contact: Object.freeze({ ...knownContact }),
          candidates: [],
          candidatesWritten: 0,
          identity: 'existing',
          evidence: `channel handle ${sender.system} already names this contact`,
        });
      }
      return senderUnresolved(sender, actor, {
        rule: 'external-identity',
        candidates: emailSubject ? [knownSubject, emailSubject] : [knownSubject],
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
      const identity = await database.transactionAsync(async () => {
        const raced = await reader.externalIdentity(sender.system, sender.externalId);
        // A concurrent resolution won: replay it. A non-contact winner is
        // not a contact — the next call takes the known-identity path.
        if (raced && raced.subjectResource !== 'contact') return 'non-contact';
        if (raced) return 'existing';
        return recordExternalIdentityRow({
          modules, names, system: sender.system, externalId: sender.externalId,
          subject, runId: SENDER_RUN_ID, actor,
        });
      });
      if (identity === 'non-contact') {
        return decide({ ...request, handle: sender.externalId });
      }
      return Object.freeze({
        system: sender.system,
        outcome: 'matched',
        rule: result.rule,
        contact: Object.freeze({ resource: 'contact', id: result.subject.id }),
        candidates: [],
        candidatesWritten: 0,
        identity,
        evidence: result.evidence,
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
      const created = await database.transactionAsync(async () => {
        const raced = await reader.externalIdentity(sender.system, sender.externalId);
        if (raced && raced.subjectResource !== 'contact') return { replayed: false, nonContact: true };
        if (raced) {
          return { replayed: true, contactId: raced.subjectId };
        }
        const contact = await core.createContact({
          companyId: result.subject.id,
          firstName: sender.firstName ?? 'Unknown',
          lastName: sender.lastName ?? 'Unknown',
          email: sender.email,
        }, { actor });
        const subject = {
          resource: 'contact', id: contact.id, owner: 'host', ownerPackage: null,
          label: contact.email ?? sender.email,
        };
        await recordExternalIdentityRow({
          modules, names, system: sender.system, externalId: sender.externalId,
          subject, runId: SENDER_RUN_ID, actor,
        });
        return { replayed: false, contactId: contact.id };
      });
      if (created.nonContact) {
        // A concurrent write linked this handle to a non-contact: re-resolve
        // through the known-identity path instead of creating beside it.
        return decide({ ...request, handle: sender.externalId });
      }
      if (created.replayed && created.contactId) {
        return Object.freeze({
          system: sender.system,
          outcome: 'matched',
          rule: 'external-identity',
          contact: Object.freeze({ resource: 'contact', id: created.contactId }),
          candidates: [],
          candidatesWritten: 0,
          identity: 'existing',
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

    const created = await database.transactionAsync(async () => {
      const raced = await reader.externalIdentity(sender.system, sender.externalId);
      if (raced && raced.subjectResource !== 'contact') return { replayed: false, nonContact: true };
      if (raced) {
        return { replayed: true, contactId: raced.subjectId };
      }
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
        runId: SENDER_RUN_ID,
        actor,
      });
      return { replayed: false, contactId: subject.id };
    });
    if (created.nonContact) {
      // A concurrent write linked this handle to a non-contact: re-resolve
      // through the known-identity path instead of creating beside it.
      return decide({ ...request, handle: sender.externalId });
    }
    if (created.replayed && created.contactId) {
      return Object.freeze({
        system: sender.system,
        outcome: 'matched',
        rule: 'external-identity',
        contact: Object.freeze({ resource: 'contact', id: created.contactId }),
        candidates: [],
        candidatesWritten: 0,
        identity: 'existing',
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
      runId: SENDER_RUN_ID,
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
