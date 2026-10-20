// @ts-check

import { randomUUID } from 'node:crypto';

import { AppError, ValidationError, normalizeActor } from '../../core/index.js';
import { emailShape, safeString } from './normalize.js';
import {
  createPolicyReader, createSubjectForRow, recordCandidatePairs, recordExternalIdentityRow,
} from './sender.js';
import {
  deciding, orderedPair, subjectFields, trusted,
} from './store.js';

/**
 * **Contact enrichment from free sources (backlog:3de717335694).**
 *
 * The owner decision of 19/10 on Q-G1 allows contact enrichment with customer
 * notice and opt-out, and asks for a free way to fill contacts automatically.
 * The free sources are Google Contacts of the space (People API, behind the
 * same Google grant as Gmail/Calendar) and email signatures parsed locally.
 * No paid enrichment service is read, wired or referenced anywhere here.
 *
 * The governing shape is the package's own (ADR-037): existing business
 * records stay the source records, so enrichment NEVER writes the contact
 * (or company) record. A manually entered value wins by construction — there
 * is no write path that could overwrite it. Enriched attributes live beside
 * the record in `enriched-field` rows, each carrying its source and
 * observation date; consumers read the record first and the enriched rows as
 * fallback. Phones and secondary emails are additionally linked as
 * `external-identity` rows through the shared helper, so the card's
 * phone-bearing identities and the sender resolution see them exactly like
 * channel evidence.
 *
 * Resolution discipline, shared with sender and import:
 * - one Google resource id names one contact; the contact email is globally
 *   unique. Evidence naming two different contacts becomes an unresolved
 *   `duplicate-candidate` for a human — never a merge, never a second
 *   contact for the same person.
 * - an opted-out subject is never enriched again, and opting out purges the
 *   subject's active enriched rows (status `purged`, value cleared).
 *   Channel identities are untouched by the purge: they route messages,
 *   they are not enrichment.
 * - the Google Contacts source stays behind the `enrichmentGoogleContacts`
 *   package flag (off unless explicitly enabled) until the Google
 *   verification approves the `contacts.readonly` scope. Enabling it also
 *   requires that scope on the space's Google grant — the grant itself lives
 *   on the control plane, not here.
 */

/** The only sources enrichment accepts. Caller-controlled strings are never provenance. */
export const ENRICHMENT_SOURCES = Object.freeze(['google-contacts', 'email-signature']);
/** The only contact attributes enrichment may fill. Anything else refuses. */
export const ENRICHABLE_FIELDS = Object.freeze(['firstName', 'lastName', 'role', 'companyName', 'phone']);
export const GOOGLE_CONTACTS_SYSTEM = 'google-contacts';
const MAX_IMPORT_PEOPLE = 5000;

function requireSource(value) {
  if (typeof value !== 'string' || !ENRICHMENT_SOURCES.includes(value)) {
    throw new ValidationError('enrichment source must be "google-contacts" or "email-signature"', { field: 'source' });
  }
  return value;
}

function requireEmail(value) {
  const shaped = emailShape(value);
  if (!shaped.ok || !shaped.value) {
    throw new ValidationError('enrichment needs the contact email that names its subject', { field: 'email' });
  }
  return shaped.value;
}

function canonicalPhone(raw) {
  // Twin of the signature parser's rule: separators stripped, leading `+`
  // kept. A phone-bearing identity IS a phone number only when it dials.
  const digits = String(raw).replaceAll(/[ .\-()/]/g, '');
  if (!/^\+?[0-9]{6,18}$/.test(digits)) return null;
  return digits;
}

/**
 * Exactly the whitelisted fields, each bounded and control-safe. Unknown
 * keys refuse (a typo must not silently vanish); malformed phones refuse
 * the field, never the call — the receipt says what was skipped and why.
 */
function requireFields(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('enrichment needs at least one field to fill', { field: 'fields' });
  }
  const unknown = Object.keys(input).filter((key) => !ENRICHABLE_FIELDS.includes(key));
  if (unknown.length > 0) {
    throw new ValidationError(`enrichment cannot fill "${unknown[0]}": only ${ENRICHABLE_FIELDS.join(', ')}`, { field: 'fields' });
  }
  const fields = { firstName: null, lastName: null, role: null, companyName: null, phone: null };
  let provided = 0;
  for (const field of ['firstName', 'lastName', 'role', 'companyName']) {
    const value = safeString(input[field], field);
    fields[field] = value;
    if (value !== null) provided += 1;
  }
  const rawPhone = safeString(input.phone, 'phone');
  if (rawPhone !== null) {
    provided += 1;
    fields.phone = canonicalPhone(rawPhone);
  }
  if (provided === 0) {
    throw new ValidationError('enrichment needs at least one field to fill', { field: 'fields' });
  }
  return { fields, phoneRefused: rawPhone !== null && fields.phone === null };
}

function refusal(code, status, message) {
  return new AppError(message, { code, status });
}

/** @param {any} runtime */
export function createContactEnrichment({
  database, modules, events, core, policy, names, googleContacts,
}) {
  if (!database || !modules || !events) {
    throw new ValidationError('contact enrichment needs database, modules and events');
  }
  if (!policy || typeof policy.resolve !== 'function') {
    throw new ValidationError('contact enrichment needs the declared match policy');
  }
  // Build-time flag from the package composition (see index.js): off unless
  // explicitly enabled, until the Google verification approves the scope.
  const googleContactsEnabled = googleContacts === true;
  const enrichedName = names?.enriched ?? 'enriched-field';
  const optOutName = names?.optOut ?? 'enrichment-opt-out';

  function requireGoogleFlag() {
    if (!googleContactsEnabled) {
      throw refusal('ENRICHMENT_GOOGLE_CONTACTS_DISABLED', 409,
        'the Google Contacts source is behind its flag until the Google verification approves the contacts.readonly scope: enable enrichmentGoogleContacts and grant that scope first');
    }
  }

  async function optOutRow(contactId) {
    const rows = await deciding(trusted(modules, optOutName), {
      subjectResource: 'contact', subjectId: contactId,
    });
    return rows[0] ?? null;
  }

  function subjectOf(contactId, email) {
    return {
      resource: 'contact', id: contactId, owner: 'host', ownerPackage: null, label: email,
    };
  }

  function candidateOf(row) {
    return {
      resource: row.subjectResource, id: row.subjectId,
      owner: row.subjectOwner ?? 'host', ownerPackage: row.subjectOwnerPackage ?? null,
      label: row.subjectLabel ?? null,
    };
  }

  async function recordEnrichmentCandidate(left, right, evidence, runId, actor) {
    return recordCandidatePairs({
      modules, names, policy,
      pairs: [orderedPair(left, right)],
      rule: 'contact-enrichment',
      evidence,
      runId,
      actor,
    });
  }

  /**
   * Enrich one resolved contact inside a single transaction. Creates the
   * contact (through the core adapters, like sender and import) when the
   * email names nobody yet; links the Google resource id, the email and the
   * phone as external identities; stores one enriched-field row per filled
   * attribute. The contact record itself is never written.
   */
  async function enrichSubject({
    contactId, email, fields, phoneRefused, source, sourceDetail, googleResourceName, actor, runId,
  }) {
    return database.transactionAsync(async () => {
      const reader = createPolicyReader({ modules, names, core });
      let id = contactId;
      let created = false;
      if (!id) {
        if (!email) {
          throw refusal('ENRICHMENT_SUBJECT_UNKNOWN', 500, 'enrichment resolved no contact and carries no email');
        }
        const raced = await reader.contactByEmail(email);
        if (raced) {
          id = raced.id;
        } else {
          try {
            const domain = email.slice(email.lastIndexOf('@') + 1);
            const subject = await createSubjectForRow(core, {
              email,
              firstName: fields.firstName,
              lastName: fields.lastName,
              companyName: fields.companyName,
              domain,
            }, actor);
            id = subject.id;
            created = true;
          } catch (error) {
            // A concurrent enrichment won the email: replay the winner
            // instead of duplicating it — or throwing on its constraint.
            const winner = await reader.contactByEmail(email);
            if (winner) {
              id = winner.id;
            } else {
              throw error;
            }
          }
        }
      }
      if (!id) {
        throw refusal('ENRICHMENT_SUBJECT_UNKNOWN', 500, 'enrichment resolved no contact and created none');
      }

      if (await optOutRow(id)) {
        throw refusal('ENRICHMENT_OPTED_OUT', 409,
          'this contact opted out of enrichment: no new field is stored and the enriched fields are purged on opt-out');
      }

      const subject = subjectOf(id, email);
      const now = new Date().toISOString();
      const applied = [];
      let candidatesWritten = 0;

      if (googleResourceName) {
        const known = await reader.externalIdentity(GOOGLE_CONTACTS_SYSTEM, googleResourceName);
        if (known && known.subjectId !== id) {
          candidatesWritten += await recordEnrichmentCandidate(
            subject, candidateOf(known),
            `Google contact ${googleResourceName} already names another record: a human decides`,
            runId, actor);
        } else {
          await recordExternalIdentityRow({
            modules, names, system: GOOGLE_CONTACTS_SYSTEM, externalId: googleResourceName,
            subject, runId, actor,
          });
        }
      }

      if (email) {
        const knownEmail = await reader.externalIdentity('email', email);
        if (knownEmail && knownEmail.subjectId !== id) {
          candidatesWritten += await recordEnrichmentCandidate(
            subject, candidateOf(knownEmail),
            `email ${email} already names another record: a human decides`, runId, actor);
        } else {
          await recordExternalIdentityRow({
            modules, names, system: 'email', externalId: email, subject, runId, actor,
          });
        }
      }

      if (fields.phone) {
        const knownPhone = await reader.externalIdentity('phone', fields.phone);
        if (knownPhone && knownPhone.subjectId !== id) {
          candidatesWritten += await recordEnrichmentCandidate(
            subject, candidateOf(knownPhone),
            `phone ${fields.phone} already names another record: a human decides`, runId, actor);
        } else {
          await recordExternalIdentityRow({
            modules, names, system: 'phone', externalId: fields.phone, subject, runId, actor,
          });
          applied.push(await storeField(subject, 'phone', fields.phone, { source, sourceDetail, runId, now, actor }));
        }
      } else if (phoneRefused) {
        applied.push({
          field: 'phone', value: null, source, sourceDetail, observedAt: now,
          disposition: 'skipped-malformed',
        });
      }

      for (const field of ['firstName', 'lastName', 'role', 'companyName']) {
        if (fields[field] === null) continue;
        applied.push(await storeField(subject, field, fields[field], {
          source, sourceDetail, runId, now, actor,
        }));
      }

      return { id, created, applied, candidatesWritten };
    });
  }

  async function storeField(subject, field, value, {
    source, sourceDetail, runId, now, actor,
  }) {
    const rows = trusted(modules, enrichedName);
    const sourceKey = `enriched:${subject.resource}:${subject.id}:${field}:${source}`;
    const existing = (await deciding(rows, { sourceKey }))[0];
    const base = {
      ...subjectFields(subject),
      field, value, source,
      sourceDetail: sourceDetail ?? null,
      observedAt: now,
      observedByRunId: runId,
    };
    if (!existing) {
      await rows.createManaged({
        sourceKey, ...base, status: 'active', purgedAt: null, purgeReason: null,
      }, { actor });
      return {
        field, value, source, sourceDetail: sourceDetail ?? null, observedAt: now, disposition: 'stored',
      };
    }
    if (existing.status !== 'active' || existing.value !== value) {
      await rows.applyManaged(existing.id, {
        ...base, status: 'active', purgedAt: null, purgeReason: null,
      }, { actor });
      return {
        field, value, source, sourceDetail: sourceDetail ?? null, observedAt: now,
        disposition: existing.status === 'active' ? 'updated' : 'restored',
      };
    }
    await rows.applyManaged(existing.id, { observedAt: now, observedByRunId: runId }, { actor });
    return {
      field, value, source, sourceDetail: sourceDetail ?? null, observedAt: now, disposition: 'refreshed',
    };
  }

  function personFields(person) {
    // Reads the People API subset the fake models — names, emails, phones,
    // organizations — and nothing else. A person with no usable email and
    // no already-linked identity is skipped, never invented: a contact
    // needs a globally-unique email (NO_CONTACT_WITHOUT_EMAIL).
    if (!person || typeof person !== 'object' || Array.isArray(person)) {
      throw refusal('ENRICHMENT_SOURCE_MALFORMED', 500, 'a Google person must be an object');
    }
    const name = Array.isArray(person.names) ? person.names[0] ?? {} : {};
    const emails = Array.isArray(person.emailAddresses) ? person.emailAddresses : [];
    const phones = Array.isArray(person.phoneNumbers) ? person.phoneNumbers : [];
    const orgs = Array.isArray(person.organizations) ? person.organizations : [];
    let email = null;
    for (const entry of emails) {
      const shaped = emailShape(entry?.value);
      if (shaped.ok && shaped.value) {
        email = shaped.value;
        break;
      }
    }
    let phone = null;
    for (const entry of phones) {
      const candidate = canonicalPhone(entry?.canonicalForm ?? entry?.value ?? '');
      if (candidate) {
        phone = candidate;
        break;
      }
    }
    const org = orgs[0] ?? {};
    return {
      resourceName: typeof person.resourceName === 'string' ? person.resourceName : null,
      email,
      fields: {
        firstName: safeString(name.givenName, 'firstName'),
        lastName: safeString(name.familyName, 'lastName'),
        role: safeString(org.title, 'role'),
        companyName: safeString(org.name, 'companyName'),
        phone,
      },
    };
  }

  async function enrichGooglePerson(person, { actor, runId }) {
    const read = personFields(person);
    const reader = createPolicyReader({ modules, names, core });
    const known = read.resourceName
      ? await reader.externalIdentity(GOOGLE_CONTACTS_SYSTEM, read.resourceName)
      : null;
    const knownSubject = known
      ? {
        resource: known.subjectResource, id: known.subjectId,
        owner: known.subjectOwner ?? 'host', ownerPackage: known.subjectOwnerPackage ?? null,
        label: known.subjectLabel ?? null,
      }
      : null;
    const emailContact = read.email ? await reader.contactByEmail(read.email) : null;

    if (knownSubject && emailContact && knownSubject.id !== emailContact.id) {
      const written = await database.transactionAsync(async () => recordEnrichmentCandidate(
        { resource: 'contact', id: emailContact.id, owner: 'host', ownerPackage: null, label: emailContact.email },
        knownSubject,
        `Google contact ${read.resourceName} already names another record: a human decides`,
        runId, actor));
      return { outcome: 'candidate', candidatesWritten: written, evidence: 'google id and email name different contacts' };
    }
    if (known && known.subjectResource !== 'contact' && !emailContact) {
      return { outcome: 'skipped', reason: 'identity-names-non-contact', evidence: 'the Google id names a non-contact and carries no usable email' };
    }
    const contactId = emailContact ? emailContact.id : (knownSubject?.resource === 'contact' ? knownSubject.id : null);
    if (!contactId && !read.email) {
      return { outcome: 'skipped', reason: 'no-linkable-identity', evidence: 'no linked identity and no usable email: a contact needs a globally-unique email' };
    }
    const contactEmail = read.email ?? emailContact?.email ?? null;
    if (contactId && await optOutRow(contactId)) {
      return { outcome: 'skipped', reason: 'opted-out', evidence: 'the contact opted out of enrichment' };
    }
    const result = await enrichSubject({
      contactId: emailContact ? emailContact.id : contactId,
      email: contactEmail,
      fields: read.fields,
      phoneRefused: false,
      source: 'google-contacts',
      sourceDetail: read.resourceName,
      googleResourceName: read.resourceName,
      actor,
      runId,
    });
    return {
      outcome: result.created ? 'created' : 'enriched',
      contact: { resource: 'contact', id: result.id },
      applied: result.applied,
      candidatesWritten: result.candidatesWritten,
    };
  }

  return {
    /**
     * Enrich one contact from a free source. Matches by email (creating
     * the contact through the core adapters when it names nobody yet),
     * refuses on opt-out, and never writes the contact record itself.
     * @param {any} request
     */
    async applyContactEnrichment(request) {
      const actor = normalizeActor(request?.actor);
      const source = requireSource(request?.source);
      if (source === 'google-contacts') requireGoogleFlag();
      const email = requireEmail(request?.email);
      const { fields, phoneRefused } = requireFields(request?.fields);
      const sourceDetail = safeString(request?.sourceDetail, 'sourceDetail');
      const runId = typeof request?.runId === 'string' && request.runId !== ''
        ? request.runId
        : `enrichment:${source}`;
      const result = await enrichSubject({
        contactId: null, email, fields, phoneRefused, source, sourceDetail,
        googleResourceName: null, actor, runId,
      });
      events.emit?.('customer-data.enrichment.applied', {
        source, outcome: result.created ? 'created' : 'enriched',
        applied: result.applied.length, candidates: result.candidatesWritten,
      });
      return Object.freeze({
        system: source,
        outcome: result.created ? 'created' : 'enriched',
        rule: 'contact-enrichment',
        contact: Object.freeze({ resource: 'contact', id: result.id }),
        applied: Object.freeze(result.applied.map((row) => Object.freeze({ ...row }))),
        candidatesWritten: result.candidatesWritten,
        evidence: result.created
          ? 'no contact matched, so the email created its contact and the fields were stored beside it'
          : 'the fields were stored beside the contact with their source and date; the contact record is untouched',
      });
    },

    /**
     * Import one page-run of Google Contacts through the caller-built
     * source adapter (the fake in tests, the People API client in the
     * deployment). Behind the google-contacts flag; opted-out subjects
     * are skipped with no writes; conflicts become candidates.
     * @param {any} request
     */
    async importGoogleContacts(request) {
      const actor = normalizeActor(request?.actor);
      requireGoogleFlag();
      const adapter = request?.adapter;
      if (!adapter || typeof adapter.listConnections !== 'function') {
        throw new ValidationError('a Google Contacts import needs its source adapter', { field: 'adapter' });
      }
      const pageSize = request?.pageSize ?? 100;
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 500) {
        throw new ValidationError('a Google Contacts import pages 1-500 people at a time', { field: 'pageSize' });
      }
      const runId = typeof request?.runId === 'string' && request.runId !== ''
        ? request.runId
        : `enrichment:google-contacts:${randomUUID()}`;
      const counts = {
        people: 0, enriched: 0, created: 0, candidates: 0, skippedOptOut: 0, skippedNoIdentity: 0,
      };
      let pageToken = null;
      for (;;) {
        const page = await adapter.listConnections({ pageToken, pageSize, secret: request?.secret });
        if (!page || !Array.isArray(page.connections)) {
          throw refusal('ENRICHMENT_SOURCE_MALFORMED', 500, 'the Google Contacts source must answer paged connections');
        }
        for (const person of page.connections) {
          counts.people += 1;
          if (counts.people > MAX_IMPORT_PEOPLE) {
            throw refusal('ENRICHMENT_IMPORT_TOO_LARGE', 409, 'a Google Contacts import covers at most 5000 people per run');
          }
          const receipt = await enrichGooglePerson(person, { actor, runId });
          if (receipt.outcome === 'created') {
            counts.created += 1;
            counts.enriched += 1;
          } else if (receipt.outcome === 'enriched') {
            counts.enriched += 1;
          } else if (receipt.outcome === 'candidate') {
            counts.candidates += 1;
          } else if (receipt.reason === 'opted-out') {
            counts.skippedOptOut += 1;
          } else {
            counts.skippedNoIdentity += 1;
          }
        }
        if (!page.nextPageToken) break;
        pageToken = page.nextPageToken;
      }
      events.emit?.('customer-data.enrichment.imported', { source: 'google-contacts', ...counts });
      return Object.freeze({
        system: 'google-contacts',
        outcome: 'imported',
        rule: 'contact-enrichment',
        runId,
        counts: Object.freeze({ ...counts }),
        evidence: 'every person resolved to at most one contact; conflicts became candidates and opt-outs were skipped',
      });
    },

    /**
     * Opt one contact out of enrichment: records the refusal and purges
     * the subject's active enriched fields (status `purged`, value
     * cleared). Channel identities are not enrichment and stay.
     * @param {any} request
     */
    async optOutContactEnrichment(request) {
      const actor = normalizeActor(request?.actor);
      const email = requireEmail(request?.email);
      const reason = safeString(request?.reason, 'reason');
      const runId = typeof request?.runId === 'string' && request.runId !== ''
        ? request.runId
        : 'enrichment:opt-out';
      const reader = createPolicyReader({ modules, names, core });
      const contact = await reader.contactByEmail(email);
      if (!contact) {
        throw refusal('ENRICHMENT_SUBJECT_UNKNOWN', 404, 'no contact uses this email, so there is nothing to opt out');
      }
      const now = new Date().toISOString();
      const purged = await database.transactionAsync(async () => {
        const rows = trusted(modules, enrichedName);
        const optOuts = trusted(modules, optOutName);
        const subject = subjectOf(contact.id, contact.email);
        if (!await optOutRow(contact.id)) {
          await optOuts.createManaged({
            sourceKey: `optout:contact:${contact.id}`,
            ...subjectFields(subject),
            reason,
            optedOutAt: now,
            optedOutByRunId: runId,
          }, { actor });
        }
        const active = await deciding(rows, {
          subjectResource: 'contact', subjectId: contact.id, status: 'active',
        });
        for (const row of active) {
          await rows.applyManaged(row.id, {
            status: 'purged', value: null, purgedAt: now, purgeReason: reason ?? 'opt-out',
          }, { actor });
        }
        return active.length;
      });
      events.emit?.('customer-data.enrichment.opted-out', { purged });
      return Object.freeze({
        system: 'enrichment',
        outcome: 'opted-out',
        rule: 'contact-enrichment',
        contact: Object.freeze({ resource: 'contact', id: contact.id }),
        purged,
        evidence: 'no new enrichment will be stored and the enriched fields are purged; channel identities stay',
      });
    },
  };
}

