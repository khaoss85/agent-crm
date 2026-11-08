// @ts-check

import { AppError, ValidationError, normalizeActor } from '../../core/index.js';
import { CUSTOMER_SCAN_LIMIT } from './customers.js';
import { safeString } from './normalize.js';
import { canonicalClusterFor, profileFor } from './profile.js';
import { isNoCompany } from './sender.js';
import {
  deciding,
  optional,
  subjectKey,
  trusted,
} from './store.js';

/**
 * **GDPR erasure (backlog:d271d723, validazione B6): delete a customer truly.**
 *
 * The framework has no storage delete and generated records are never
 * removed, so erasing means three things together, in one transaction:
 *
 * 1. **anonymize what is writable** — the contact PII (name, email) is
 *    rewritten to non-identifying values, channel identities are withdrawn
 *    (`superseded`) with their identifier redacted, enriched fields are
 *    purged like an opt-out, custom-field values are blanked;
 * 2. **record it** — one append-only `customer-erasure-log` row per erased
 *    subject (no name, no email, no phone: the registry never becomes a
 *    copy of what was erased), so a second erasure replays the stored row
 *    (replay contract: the requested subject in `erasedSubjects`, no counts
 *    or notes — branch on `replayed`);
 * 3. **exclude it** — every product read (list, profile, export) drops
 *    erased subjects by reading this same registry, so the customer
 *    disappears from Clienti, search, the direct link and export.
 *
 * The written legal basis is the one the status rule already enforces
 * (`customer-status.js`): signed business (orders, contracts,
 * subscriptions) must be kept, so a `cliente` refuses with
 * ERASURE_BLOCKED_SIGNED_BUSINESS. Uncertain evidence refuses too
 * (ERASURE_EVIDENCE_UNREADABLE): a composed package that cannot prove a
 * complete zero count blocks the erasure instead of risking a customer
 * the law requires kept.
 *
 * Out of this slice on purpose (named follow-ups, not silent gaps):
 * interaction messages and calls, appointments and the company record
 * (its service offers no update) are excluded from reads but their stored
 * rows are not rewritten here — their owning packages do that.
 */

const MAX_REASON = 300;

/**
 * What the erasure reason may never carry: the registry is append-only and
 * would keep the copy forever, contradicting its no-PII promise. An email
 * address or a phone number inside the reason refuses with ValidationError;
 * names cannot be detected reliably, so the operation contract (and the
 * reason hint) tells the operator to write why, never who.
 */
const REASON_EMAIL_RE = /[^\s@]+@[^\s@.]+\.[^\s@.]+/;
// A phone-shaped run: at least 9 characters of digits and phone
// separators holding 9 or more digits. A date (08/11/2026, 8 digits)
// passes; a real number (+39 333 123 4567, 12 digits) refuses.
const REASON_PHONE_RUN_RE = /[+\d][\d\s\-./()]{8,}/g;

function reasonHasPhone(reason) {
  for (const run of reason.match(REASON_PHONE_RUN_RE) ?? []) {
    if (run.replace(/\D/g, '').length >= 9) return true;
  }
  return false;
}

function assertReasonCarriesNoPii(reason) {
  if (REASON_EMAIL_RE.test(reason) || reasonHasPhone(reason)) {
    throw new ValidationError(
      'il motivo non deve contenere email o telefoni: il registro è permanente e non conserva dati personali',
      { field: 'reason' },
    );
  }
  return reason;
}

/**
 * The evidence sections that can hold signed business, and the module each
 * needs to exist. A section whose module is not composed holds no rows in
 * this application, so there is nothing of that kind to keep — this is a
 * deployment fact, not uncertainty. A section whose module IS composed must
 * prove absence (readable, zero, complete); a failed read or a bounded page
 * fails closed instead of erasing a customer the law requires kept.
 */
const EVIDENCE_MODULES = Object.freeze([
  { key: 'orders', module: 'order' },
  { key: 'contracts', module: 'commercial-contract' },
  { key: 'subscriptions', module: 'subscription' },
]);

function erasureEvidenceIsProven({ modules, profile }) {
  return EVIDENCE_MODULES.every(({ key, module }) => {
    const service = optional(modules, module);
    if (!service || typeof service.list !== 'function') return true;
    const section = profile?.[key] ?? null;
    return section?.available === true
      && (section?.count ?? 0) === 0
      && section?.countIsComplete !== false;
  });
}

/** The erasure registry row key for one subject. */
export function erasureSourceKey(resource, id) {
  return `erasure:${resource}:${id}`;
}

/** Placeholder identity once the real one is redacted: unique per row, never routable. */
function redactedIdentity(rowId) {
  return `cancellato:${rowId}`;
}

/** Placeholder contact email: unique per contact, RFC-reserved domain, never deliverable. */
function anonymizedEmail(contactId) {
  const local = `cancellato-${String(contactId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)}`;
  return `${local}@cancellato.invalid`;
}

/**
 * Every erased subject key (`resource:id`), from the complete registry
 * read. An absent registry (an older composition) erases nothing and
 * excludes nothing — never a refusal.
 * @param {{modules: any, names: any}} handles
 */
export async function readErasedSubjects({ modules, names }) {
  const service = optional(modules, names.erasure);
  if (!service || typeof service.listWhere !== 'function') return Object.freeze(new Set());
  const rows = await deciding(service, {});
  return Object.freeze(new Set(rows.map((row) => `${row.subjectResource}:${row.subjectId}`)));
}

/**
 * Whether one subject was erased. A correctness read, never a page.
 * @param {{modules: any, names: any}} handles
 */
export async function isErased({ modules, names }, resource, id) {
  const service = optional(modules, names.erasure);
  if (!service || typeof service.listWhere !== 'function') return false;
  const rows = await deciding(service, { subjectResource: resource, subjectId: id });
  return rows.length > 0;
}

/** @param {{database: any, modules: any, events: any, config?: any, core: any, names: any}} handles */
export function createErasureOperations({ database, modules, events, core, names }) {
  if (!database || !modules || !events) {
    throw new ValidationError('customer erasure needs database, modules and events');
  }

  /**
   * Erase one customer: confirm, gate, anonymize, record, exclude.
   * @param {{resource?: unknown, id?: unknown, confirm?: unknown, reason?: unknown, actor?: unknown}} request
   */
  async function eraseCustomer(request) {
    const actor = normalizeActor(request?.actor);
    // The fail-closed anonymous actor ({type:'user',id:'anonymous'}) holds
    // no membership and authorizes nothing: a destructive GDPR operation
    // needs a named titolare, never the absence of one.
    if (!actor || typeof actor !== 'object' || actor.type !== 'user' || actor.id === 'anonymous') {
      throw new AppError('Cancellare un cliente è una decisione del titolare', {
        code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
      });
    }
    const resource = request?.resource;
    if (resource !== 'contact' && resource !== 'company') {
      throw new ValidationError('la cancellazione chiede un cliente contact o company', { field: 'resource' });
    }
    const id = request?.id;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new ValidationError('la cancellazione chiede l\u2019id del cliente', { field: 'id' });
    }
    if (request?.confirm !== true) {
      throw new ValidationError('la cancellazione va confermata dal titolare (confirm: true)', { field: 'confirm' });
    }
    const reason = assertReasonCarriesNoPii(
      safeString(request?.reason, 'reason', { max: MAX_REASON, required: true }),
    );
    const subject = { resource, id: id.trim() };

    const erasureSvc = trusted(modules, names.erasure);
    const replayed = (await deciding(erasureSvc, {
      subjectResource: subject.resource, subjectId: subject.id,
    }))[0] ?? null;
    if (replayed) {
      return replayReceipt(replayed);
    }

    const contactsSvc = optional(modules, 'contact');
    const companiesSvc = optional(modules, 'company');
    const stored = await readStoredSubject({ contactsSvc, companiesSvc }, subject);
    if (!stored) {
      throw new AppError('cliente non trovato', {
        code: 'ERASURE_SUBJECT_NOT_FOUND', status: 404,
      });
    }

    // The whole canonical cluster goes together: linked records are one
    // customer by a human decision, and erasing half would leave the other
    // half naming the same person.
    const cluster = await canonicalClusterFor({ modules, names, subject });
    const members = cluster.members.map((member) => ({
      resource: member.resource, id: member.id,
      owner: member.owner ?? 'host', ownerPackage: member.ownerPackage ?? null,
    }));

    // A company erasure cascades to its contacts: contact PII linked only
    // by companyId is personal data of the same customer, and leaving it
    // behind would keep names and emails listing in Clienti. The contact
    // list is a bounded display page, so the cascade asks for the widest
    // page the service allows and refuses when it comes back full: a page
    // that may be truncated never drives a half-erasure (a read that
    // decides something is never a page).
    if (subject.resource === 'company' && contactsSvc && typeof contactsSvc.list === 'function') {
      let linked = [];
      try {
        linked = (await contactsSvc.list({ companyId: subject.id, limit: CUSTOMER_SCAN_LIMIT })) ?? [];
      } catch {
        linked = [];
      }
      if (linked.length >= CUSTOMER_SCAN_LIMIT) {
        throw new AppError(
          'questa azienda ha troppi contatti collegati per verificarli tutti in una lettura: la cancellazione è bloccata finché la lettura non è completa',
          {
            code: 'ERASURE_CASCADE_INCOMPLETE', status: 409,
            details: Object.freeze({ subject: { ...subject } }),
          },
        );
      }
      for (const row of linked) {
        if (!row || typeof row.id !== 'string' || row.id === '') continue;
        const candidate = { resource: 'contact', id: row.id, owner: 'host', ownerPackage: null };
        if (!members.some((member) => subjectKey(member) === subjectKey(candidate))) {
          members.push(candidate);
        }
      }
    }
    // The legal gate, through the one status rule every reader shares: a
    // customer with signed business on record is kept, never erased. And
    // uncertain evidence never erases either: a composed package that
    // cannot be read fully (a failed read, a bounded page) leaves absence
    // unproven, so the operation fails closed instead of anonymizing a
    // customer the law requires kept. A package that is not composed at
    // all holds no rows here, so it proves nothing and blocks nothing
    // (see erasureEvidenceIsProven).
    const profile = await profileFor({ modules, core, names, subject });
    if (profile?.status?.value === 'cliente') {
      const counts = {
        orders: profile.orders?.count ?? null,
        contracts: profile.contracts?.count ?? null,
        subscriptions: profile.subscriptions?.count ?? null,
      };
      throw new AppError(
        'questo cliente ha documenti firmati (ordini, contratti o abbonamenti) e la legge chiede di conservarli: la cancellazione è bloccata',
        {
          code: 'ERASURE_BLOCKED_SIGNED_BUSINESS', status: 409,
          details: Object.freeze({ subject: { ...subject }, counts }),
        },
      );
    }
    if (!erasureEvidenceIsProven({ modules, profile })) {
      throw new AppError(
        'non si può verificare che non ci siano documenti firmati (ordini, contratti o abbonamenti): la cancellazione è bloccata finché le letture non sono complete',
        {
          code: 'ERASURE_EVIDENCE_UNREADABLE', status: 409,
          details: Object.freeze({
            subject: { ...subject },
            statusReason: profile?.status?.reason ?? null,
          }),
        },
      );
    }

    const now = new Date().toISOString();
    const actorId = String(actor.id ?? 'unknown');
    const receipt = await database.transactionAsync(async () => {
      const erased = [];
      let identitiesWithdrawn = 0;
      let enrichedPurged = 0;
      let fieldValuesBlanked = 0;
      const notes = [];
      for (const member of members) {
        const outcome = await eraseMember(member, { now, actor });
        identitiesWithdrawn += outcome.identitiesWithdrawn;
        enrichedPurged += outcome.enrichedPurged;
        fieldValuesBlanked += outcome.fieldValuesBlanked;
        if (outcome.note) notes.push(outcome.note);
        erased.push(member);
        if (outcome.orphanCompany && !erased.some((entry) => subjectKey(entry) === subjectKey(outcome.orphanCompany))) {
          const orphanOutcome = await eraseMember(outcome.orphanCompany, { now, actor, orphan: true });
          identitiesWithdrawn += orphanOutcome.identitiesWithdrawn;
          enrichedPurged += orphanOutcome.enrichedPurged;
          fieldValuesBlanked += orphanOutcome.fieldValuesBlanked;
          if (orphanOutcome.note) notes.push(orphanOutcome.note);
          erased.push(outcome.orphanCompany);
        }
      }
      const summary = summaryOf({ erased, identitiesWithdrawn, enrichedPurged, fieldValuesBlanked, notes });
      const rows = [];
      for (const member of erased) {
        const row = await erasureSvc.createManaged({
          sourceKey: erasureSourceKey(member.resource, member.id),
          subjectResource: member.resource,
          subjectId: member.id,
          subjectOwner: member.owner,
          subjectOwnerPackage: member.ownerPackage,
          reason,
          erasedByType: 'user',
          erasedById: actorId,
          erasedAt: now,
          via: cluster.linked ? 'erase-customer:cluster' : 'erase-customer',
          summary,
        }, { actor });
        rows.push(row);
      }
      return Object.freeze({
        outcome: 'erased',
        replayed: false,
        subject: Object.freeze({ ...subject }),
        erasedSubjects: Object.freeze(erased.map((member) => Object.freeze({ resource: member.resource, id: member.id }))),
        erasedAt: now,
        erasedBy: Object.freeze({ type: 'user', id: actorId }),
        reason,
        counts: Object.freeze({ subjects: erased.length, identitiesWithdrawn, enrichedPurged, fieldValuesBlanked }),
        notes: Object.freeze([...notes]),
        summary,
      });
    });

    if (events && typeof events.emit === 'function') {
      try { await events.emit('customer-data.customer-erased', { subject, erasedAt: receipt.erasedAt }); } catch { /* observability only */ }
    }
    return receipt;
  }

  async function readStoredSubject({ contactsSvc, companiesSvc }, subject) {
    const get = async (service) => {
      if (!service || typeof service.get !== 'function') return null;
      try {
        return await service.get(subject.id);
      } catch {
        return null;
      }
    };
    if (subject.resource === 'contact') return get(contactsSvc);
    return get(companiesSvc);
  }

  async function eraseMember(member, { now, actor, orphan = false }) {
    const outcome = {
      identitiesWithdrawn: 0, enrichedPurged: 0, fieldValuesBlanked: 0, note: null, orphanCompany: null,
    };
    if (member.resource === 'contact') {
      const contactsSvc = optional(modules, 'contact');
      const contact = await readStoredSubject({ contactsSvc, companiesSvc: null }, member);
      if (contact) {
        await contactsSvc.update(member.id, {
          firstName: 'Cliente',
          lastName: 'cancellato',
          email: anonymizedEmail(member.id),
          // A job title identifies the person as surely as a name, so it
          // goes with the rest of the PII instead of surviving the erasure.
          role: null,
        }, { actor });
      }
      outcome.note = null;
      // An orphan company goes with its last contact: the company service
      // offers no update, so the row stays but the registry excludes it
      // from every product read like the contact itself.
      if (contact?.companyId && !orphan) {
        // The widest page the service allows: a full page still proves
        // siblings exist (the erased contact is one of them), so the
        // company is kept — the safe direction needs no exact count.
        let siblings = [];
        try {
          siblings = (contactsSvc && typeof contactsSvc.list === 'function')
            ? (await contactsSvc.list({ companyId: contact.companyId, limit: CUSTOMER_SCAN_LIMIT })) ?? []
            : [];
        } catch {
          siblings = [];
        }
        const others = (siblings ?? []).filter((row) => row?.id !== member.id);
        if (others.length === 0) {
          const companiesSvc = optional(modules, 'company');
          const company = await readStoredSubject(
            { contactsSvc: null, companiesSvc },
            { resource: 'company', id: contact.companyId },
          );
          if (company && !isNoCompany(company)) {
            outcome.orphanCompany = { resource: 'company', id: company.id, owner: 'host', ownerPackage: null };
            outcome.note = 'l\u2019azienda collegata non ha altri contatti ed è esclusa dalle letture con questo cliente';
          }
        } else {
          outcome.note = `l\u2019azienda collegata resta: ha altri ${others.length} contatti`;
        }
      }
    } else if (!orphan) {
      outcome.note = 'la scheda azienda resta nel database (il record azienda non si può riscrivere in questa versione) ma è esclusa da Clienti, ricerca, scheda ed export';
    } else {
      outcome.note = 'azienda senza altri contatti: esclusa dalle letture con il contatto cancellato';
    }
    outcome.identitiesWithdrawn = await withdrawIdentities(member, { now, actor });
    outcome.enrichedPurged = await purgeEnriched(member, { now, actor });
    outcome.fieldValuesBlanked = await blankFieldValues(member, { actor });
    return outcome;
  }

  async function withdrawIdentities(member, { now, actor }) {
    const service = optional(modules, names.identity);
    if (!service || typeof service.listWhere !== 'function' || typeof service.applyManaged !== 'function') return 0;
    const rows = await deciding(service, { subjectResource: member.resource, subjectId: member.id });
    let withdrawn = 0;
    for (const row of rows) {
      if (row?.status === 'superseded' && String(row?.externalId ?? '').startsWith('cancellato:')) continue;
      await service.applyManaged(row.id, {
        status: 'superseded',
        externalId: redactedIdentity(row.id),
        sourceKey: redactedIdentity(row.id),
        subjectLabel: null,
      }, { actor });
      withdrawn += 1;
    }
    void now;
    return withdrawn;
  }

  async function purgeEnriched(member, { now, actor }) {
    const service = optional(modules, names.enriched);
    if (!service || typeof service.listWhere !== 'function' || typeof service.applyManaged !== 'function') return 0;
    const rows = await deciding(service, { subjectResource: member.resource, subjectId: member.id });
    let purged = 0;
    for (const row of rows) {
      if (row?.status === 'purged') continue;
      await service.applyManaged(row.id, {
        status: 'purged', value: null, sourceDetail: null, decisionReason: null,
        // The display snapshot carries the contact email (subjectLabel),
        // so it goes with the value: no PII copy survives beside the
        // erased subject — like the identity path already does.
        subjectLabel: null,
        purgedAt: now, purgeReason: 'cancellazione-gdpr',
      }, { actor });
      purged += 1;
    }
    return purged;
  }

  async function blankFieldValues(member, { actor }) {
    const service = optional(modules, names.fieldValue);
    if (!service || typeof service.listWhere !== 'function' || typeof service.applyManaged !== 'function') return 0;
    const rows = await deciding(service, { subjectResource: member.resource, subjectId: member.id });
    let blanked = 0;
    for (const row of rows) {
      if (row?.value === null || row?.value === undefined) continue;
      await service.applyManaged(row.id, { value: null }, { actor });
      blanked += 1;
    }
    return blanked;
  }

  return Object.freeze({ eraseCustomer });
}

function summaryOf({ erased, identitiesWithdrawn, enrichedPurged, fieldValuesBlanked, notes }) {
  const parts = [
    `${erased.length} soggett${erased.length === 1 ? 'o cancellato' : 'i cancellati'}`,
    `${identitiesWithdrawn} identità ritirate`,
    `${enrichedPurged} campi arricchiti purgati`,
    `${fieldValuesBlanked} valori personalizzati azzerati`,
  ];
  for (const note of notes) parts.push(note);
  return parts.join('; ');
}

/**
 * The replay contract, distinct from a first erasure by `replayed: true`.
 * A replay answers the stored row for the requested subject only: the
 * original tallies (identities withdrawn, fields purged, notes) describe
 * the whole cluster of that first call and are not stored per row, so a
 * replay carries no counts and no notes instead of inventing them.
 * `erasedSubjects` always holds the requested subject, so readers can
 * treat both shapes the same for membership and must branch on
 * `replayed` before reading counts or notes.
 */
function replayReceipt(row) {
  const subject = Object.freeze({ resource: row.subjectResource, id: row.subjectId });
  return Object.freeze({
    outcome: 'erased',
    replayed: true,
    subject,
    erasedSubjects: Object.freeze([subject]),
    erasedAt: row.erasedAt ?? null,
    erasedBy: Object.freeze({ type: row.erasedByType ?? 'user', id: row.erasedById ?? null }),
    reason: row.reason ?? null,
    summary: row.summary ?? null,
  });
}
