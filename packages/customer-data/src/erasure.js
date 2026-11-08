// @ts-check

import { AppError, NotFoundError, ValidationError, normalizeActor } from '../../core/index.js';
import { CUSTOMER_SCAN_LIMIT } from './customers.js';
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
 * 1. **anonymize every place of the inventory** (`ERASURE_INVENTORY`
 *    below): the host contact and company rows, and every customer-data row
 *    that names the subject — identities, enriched fields, custom-field
 *    values, canonical links, duplicate candidates (either side), quality
 *    issues, import receipts, opt-outs, bulk receipts. Each place lists what
 *    it keeps and what the erasure writes; a place nobody can rewrite here
 *    (another package's rows, the core audit) is counted on the receipt as
 *    `retained` with its reason, never silently left behind;
 * 2. **record it** — one append-only `customer-erasure-log` row per erased
 *    subject (no name, no email, no phone: the registry never becomes a
 *    copy of what was erased), so a second erasure replays the stored row
 *    (replay contract: the requested subject in `erasedSubjects`, no counts
 *    or notes — branch on `replayed`);
 * 3. **exclude it** — every product read (list, profile, export) drops
 *    erased subjects by reading this same registry.
 *
 * **Fail closed, all or nothing.** Every read and every write of the
 * inventory runs inside one storage transaction. A read that fails (other
 * than a plain «not found») throws ERASURE_READ_FAILED, a write that fails
 * throws ERASURE_WRITE_FAILED: the transaction rolls back, no registry row
 * is written and no success receipt is returned. There is no half-erasure.
 *
 * The written legal basis is the one the status rule already enforces
 * (`customer-status.js`): signed business (orders, contracts,
 * subscriptions) must be kept, so a `cliente` refuses with
 * ERASURE_BLOCKED_SIGNED_BUSINESS. Uncertain evidence refuses too
 * (ERASURE_EVIDENCE_UNREADABLE).
 */

/** The purge reason written on every row this erasure rewrites. */
const PURGE_REASON = 'cancellazione-gdpr';

/** The placeholders the host rows take: unique where they must be, never identifying. */
const ANONYMOUS_CONTACT = Object.freeze({ firstName: 'Cliente', lastName: 'cancellato' });
const ANONYMOUS_COMPANY_NAME = 'Azienda cancellata';

/**
 * **The erasure inventory**: every place a contact's or company's personal
 * data can live in this framework, what it keeps, and what the erasure does
 * with it. It is the contract the code below implements one row at a time
 * and the PR body states as a table; a new place is a new row here.
 *
 * `action` is one of `anonymize` (the row stays, its personal fields are
 * rewritten), `exclude` (the row is read-only evidence for this package and
 * leaves every read) or `retain` (another owner keeps it: counted on the
 * receipt with the reason).
 */
export const ERASURE_INVENTORY = Object.freeze([
  { place: 'contact', keeps: 'firstName, lastName, email, role', action: 'anonymize' },
  { place: 'company', keeps: 'name, domain', action: 'anonymize' },
  { place: 'external-identity', keeps: 'externalId, sourceKey (email/phone), subjectLabel', action: 'anonymize' },
  { place: 'enriched-field', keeps: 'value, sourceDetail, decisionReason, sourceKey, subjectLabel', action: 'anonymize' },
  { place: 'custom-field-value', keeps: 'value', action: 'anonymize' },
  { place: 'canonical-link', keeps: 'subjectLabel, reason, withdrawnReason (also on rows of the same cluster)', action: 'anonymize' },
  { place: 'duplicate-candidate', keeps: 'leftLabel/rightLabel, evidence, decidedReason (either side)', action: 'anonymize' },
  { place: 'data-quality-issue', keeps: 'subjectLabel, evidence, resolutionReason', action: 'anonymize' },
  { place: 'customer-import-row', keeps: 'subjectLabel, reason (match evidence)', action: 'anonymize' },
  { place: 'enrichment-opt-out', keeps: 'subjectLabel (email), reason', action: 'anonymize' },
  { place: 'customer-bulk-item', keeps: 'reason of a failed decision on a candidate or issue of the subject', action: 'anonymize' },
  { place: 'customer-erasure-log', keeps: 'subject id, reason code from a closed list (never free text), decider', action: 'exclude' },
  { place: 'opportunity', keeps: 'deal name, contactId', action: 'retain' },
  { place: 'other-package-rows', keeps: 'messages, calls, appointments, tasks, forms, sequences', action: 'retain' },
  { place: 'core-audit-trace', keeps: 'audit_events, workflow_runs, trace_spans, write_outcomes', action: 'retain' },
]);

/**
 * **The erasure reason is a code from a closed list, never free text.**
 * The registry is append-only: whatever the reason says is kept forever.
 * A free-text reason lets a name through (an email or a phone can be
 * caught, a name cannot), so the registry and the receipt only ever hold
 * one of these codes. Any other value — free text included — refuses with
 * ValidationError and nothing is written: free text is never stored.
 */
export const ERASURE_REASONS = Object.freeze([
  'richiesta-interessato',
  'fine-rapporto',
  'dati-errati',
  'altro',
]);

function erasureReasonCode(value) {
  const code = typeof value === 'string' ? value.trim() : '';
  if (!ERASURE_REASONS.includes(code)) {
    throw new ValidationError(
      `il motivo della cancellazione è un codice: uno di ${ERASURE_REASONS.join(', ')} (il testo libero non si salva: il registro è permanente)`,
      { field: 'reason' },
    );
  }
  return code;
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

/** Placeholder key/identity once the real one is redacted: unique per row, never routable. */
function redacted(rowId) {
  return `cancellato:${rowId}`;
}

/** Placeholder contact email: unique per contact, RFC-reserved domain, never deliverable. */
function anonymizedEmail(contactId) {
  const local = `cancellato-${String(contactId).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40)}`;
  return `${local}@cancellato.invalid`;
}

/** A plain «this record does not exist» — the only read failure that is an answer, not an error. */
function isNotFound(error) {
  return error instanceof NotFoundError || error?.code === 'NOT_FOUND';
}

function causeOf(error) {
  return error?.message ?? String(error);
}

function isErasureError(error) {
  return error instanceof AppError && typeof error.code === 'string' && error.code.startsWith('ERASURE_');
}

/** A read of the inventory failed: nothing is erased, nothing is recorded. */
function readFailed(place, error) {
  if (isErasureError(error)) return error;
  return new AppError(
    `non si può leggere ${place}: la cancellazione è annullata e nulla è stato cancellato, riprova quando la lettura riesce`,
    { code: 'ERASURE_READ_FAILED', status: 409, details: Object.freeze({ place, cause: causeOf(error) }) },
  );
}

/** A write of the inventory failed: the transaction rolls back, nothing is recorded. */
function writeFailed(place, error) {
  if (isErasureError(error)) return error;
  return new AppError(
    `non si può riscrivere ${place}: la cancellazione è annullata e nulla è stato cancellato`,
    { code: 'ERASURE_WRITE_FAILED', status: 409, details: Object.freeze({ place, cause: causeOf(error) }) },
  );
}

async function guardedRead(place, fn) {
  try {
    return await fn();
  } catch (error) {
    throw readFailed(place, error);
  }
}

async function guardedWrite(place, fn) {
  try {
    return await fn();
  } catch (error) {
    throw writeFailed(place, error);
  }
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

/** True when a patch would change nothing on this row. */
function changesNothing(row, patch) {
  return Object.entries(patch).every(([key, value]) => (row?.[key] ?? null) === value);
}

/**
 * The customer-data rows that name a subject, and how each is anonymized.
 * `sides` are the subject-envelope prefixes the place stores (a duplicate
 * candidate names two records: `left` and `right`). `patch(row, sides, ctx)`
 * answers the rewrite for one row given which of its sides were erased.
 * @param {any} names
 */
function managedPlaces(names) {
  const labelsOf = (sides) => Object.fromEntries([...sides].map((side) => [`${side}Label`, null]));
  return [
    {
      place: 'external-identity', module: names.identity, sides: ['subject'],
      patch: (row) => ({
        status: 'superseded', externalId: redacted(row.id), sourceKey: redacted(row.id), subjectLabel: null,
      }),
    },
    {
      place: 'enriched-field', module: names.enriched, sides: ['subject'],
      patch: (row, _sides, { now }) => ({
        status: 'purged', value: null, sourceDetail: null, decisionReason: null, subjectLabel: null,
        // The key of an extracted proposal is a digest of the value: it
        // goes too, so nothing derived from the value survives.
        sourceKey: redacted(row.id),
        purgedAt: row.status === 'purged' && row.purgedAt ? row.purgedAt : now,
        purgeReason: row.status === 'purged' && row.purgeReason ? row.purgeReason : PURGE_REASON,
      }),
    },
    {
      place: 'custom-field-value', module: names.fieldValue, sides: ['subject'],
      patch: () => ({ value: null }),
    },
    {
      place: 'canonical-link', module: names.link, sides: ['subject'],
      // The human-written reasons may name the person: they go with the
      // snapshot. Rows of other members of the same cluster lose their
      // reasons too (see the cluster sweep), never their own labels.
      patch: () => ({ subjectLabel: null, reason: null, withdrawnReason: null }),
    },
    {
      place: 'duplicate-candidate', module: names.candidate, sides: ['left', 'right'],
      // Only the erased side's snapshot goes: the other side is a kept
      // customer and its label is its own. The evidence can quote the
      // erased identifier, so it goes whole. An open candidate is closed:
      // a pair with an erased record is no longer a decision for anyone,
      // and an open one would keep showing it on the kept customer's card.
      patch: (row, sides, { now, actorId }) => ({
        ...labelsOf(sides), evidence: null,
        ...(row.status === 'unresolved'
          ? { status: 'dismissed', decidedReason: PURGE_REASON, decidedByType: 'user', decidedById: actorId, decidedAt: now }
          : { decidedReason: row.decidedReason == null ? null : PURGE_REASON }),
      }),
    },
    {
      place: 'data-quality-issue', module: names.issue, sides: ['subject'],
      patch: (row, _sides, { now, actorId }) => ({
        subjectLabel: null, evidence: null,
        ...(row.status === 'open'
          ? { status: 'dismissed', resolutionReason: PURGE_REASON, decidedByType: 'user', decidedById: actorId, decidedAt: now }
          : { resolutionReason: row.resolutionReason == null ? null : PURGE_REASON }),
      }),
    },
    {
      place: 'customer-import-row', module: names.row, sides: ['subject'],
      patch: () => ({ subjectLabel: null, reason: null }),
    },
    {
      // The opt-out row itself stays: it is the subject's own instruction
      // never to be enriched again. Only its email snapshot and reason go.
      place: 'enrichment-opt-out', module: names.optOut, sides: ['subject'],
      patch: () => ({ subjectLabel: null, reason: null }),
    },
  ];
}

/** @param {{database: any, modules: any, events: any, config?: any, core: any, names: any}} handles */
export function createErasureOperations({ database, modules, events, core, names }) {
  if (!database || !modules || !events) {
    throw new ValidationError('customer erasure needs database, modules and events');
  }
  const places = managedPlaces(names);

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
      throw new ValidationError('la cancellazione chiede l’id del cliente', { field: 'id' });
    }
    if (request?.confirm !== true) {
      throw new ValidationError('la cancellazione va confermata dal titolare (confirm: true)', { field: 'confirm' });
    }
    const reason = erasureReasonCode(request?.reason);
    const subject = { resource, id: id.trim() };

    const erasureSvc = trusted(modules, names.erasure);
    const replayed = (await deciding(erasureSvc, {
      subjectResource: subject.resource, subjectId: subject.id,
    }))[0] ?? null;
    if (replayed) {
      return replayReceipt(replayed);
    }

    const contactsSvc = optional(modules, 'contact');
    const stored = await readHost(subject);
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
    // by companyId is personal data of the same customer. The contact list
    // is a bounded display page, so the cascade asks for the widest page
    // the service allows and refuses when it comes back full; a failed list
    // refuses too (ERASURE_CASCADE_UNREADABLE).
    if (subject.resource === 'company' && contactsSvc && typeof contactsSvc.list === 'function') {
      const linked = await listContactsOfCompany(contactsSvc, subject.id);
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
    // The legal gate, through the one status rule every reader shares.
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
    const ctx = { now, actor, actorId };
    const receipt = await database.transactionAsync(async () => {
      const notes = [];
      // 1. The subjects: the cluster, the cascade, and the company a last
      //    contact leaves behind. Decided inside the transaction, so the
      //    rows rewritten below are the rows this decision read.
      const erased = [...members];
      for (const member of members) {
        if (member.resource !== 'contact') continue;
        const orphan = await orphanCompanyOf(member, erased, notes);
        if (orphan) erased.push(orphan);
      }

      // 2. The host rows.
      const placeCounts = {};
      const bump = (place, by = 1) => { placeCounts[place] = (placeCounts[place] ?? 0) + by; };
      for (const member of erased) {
        if (await anonymizeHost(member, ctx)) bump(member.resource);
      }

      // 3. Every customer-data row naming an erased subject, one place at a
      //    time: read completely, then rewrite each row once.
      const touched = { candidate: [], issue: [], clusterKeys: new Set() };
      for (const place of places) {
        const service = optional(modules, place.module);
        if (!service) continue;
        const rows = await rowsNaming(place, service, erased);
        for (const { row, sides } of rows.values()) {
          if (place.place === 'canonical-link' && row.clusterKey) touched.clusterKeys.add(row.clusterKey);
          if (place.place === 'duplicate-candidate') touched.candidate.push(row.id);
          if (place.place === 'data-quality-issue') touched.issue.push(row.id);
          const patch = place.patch(row, sides, ctx);
          if (changesNothing(row, patch)) continue;
          await guardedWrite(place.place, () => service.applyManaged(row.id, patch, { actor }));
          bump(place.place);
        }
      }
      // 3b. The cluster sweep: a kept member's link rows carry the reasons
      //     written about the pair, which may name the erased person.
      bump('canonical-link', await sweepClusterReasons(touched.clusterKeys, erased, actor));
      // 3c. Bulk receipts of failed decisions on the candidates and issues
      //     just rewritten: their reason is an error text that may quote them.
      bump('customer-bulk-item', await sweepBulkReasons(touched, actor));

      // 4. What this erasure cannot rewrite, counted with its reason.
      const retained = await retainedPlaces(erased, profile);

      const counts = Object.freeze({
        subjects: erased.length,
        identitiesWithdrawn: placeCounts['external-identity'] ?? 0,
        enrichedPurged: placeCounts['enriched-field'] ?? 0,
        fieldValuesBlanked: placeCounts['custom-field-value'] ?? 0,
        places: Object.freeze(Object.fromEntries(Object.entries(placeCounts).filter(([, n]) => n > 0))),
      });
      const summary = summaryOf({ counts, retained, notes });

      // 5. The registry, last: a failure anywhere above leaves none.
      for (const member of erased) {
        await guardedWrite('customer-erasure-log', () => erasureSvc.createManaged({
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
        }, { actor }));
      }
      return Object.freeze({
        outcome: 'erased',
        replayed: false,
        subject: Object.freeze({ ...subject }),
        erasedSubjects: Object.freeze(erased.map((member) => Object.freeze({ resource: member.resource, id: member.id }))),
        erasedAt: now,
        erasedBy: Object.freeze({ type: 'user', id: actorId }),
        reason,
        counts,
        retained: Object.freeze(retained),
        notes: Object.freeze([...notes]),
        summary,
      });
    });

    if (events && typeof events.emit === 'function') {
      try { await events.emit('customer-data.customer-erased', { subject, erasedAt: receipt.erasedAt }); } catch { /* observability only */ }
    }
    return receipt;
  }

  /**
   * Read one host record. «Not found» is an answer (null); any other
   * failure is not, and stops the erasure: a swallowed read error would
   * skip the anonymization and still record a success.
   * @param {{resource: string, id: string}} subject
   */
  async function readHost(subject) {
    const service = optional(modules, subject.resource);
    if (!service || typeof service.get !== 'function') return null;
    try {
      return await service.get(subject.id);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw readFailed(subject.resource, error);
    }
  }

  /**
   * The one source of truth for "which contacts belong to this company"
   * wherever an erasure decides on it. A failed read throws
   * ERASURE_CASCADE_UNREADABLE instead of answering an empty list.
   */
  async function listContactsOfCompany(contactsSvc, companyId) {
    try {
      return (await contactsSvc.list({ companyId, limit: CUSTOMER_SCAN_LIMIT })) ?? [];
    } catch (error) {
      throw new AppError(
        'non si può verificare quali contatti sono collegati a questa azienda: la cancellazione è bloccata finché la lettura non riesce',
        {
          code: 'ERASURE_CASCADE_UNREADABLE', status: 409,
          details: Object.freeze({ companyId, cause: causeOf(error) }),
        },
      );
    }
  }

  /**
   * The company an erased contact leaves without contacts goes with it.
   * Kept when siblings exist (a full page still proves one), and kept when
   * the siblings cannot be read: absence unproven never erases a company
   * that may be shared. The contact and company reads themselves fail
   * closed — only «not found» means none.
   */
  async function orphanCompanyOf(member, erased, notes) {
    const contact = await readHost(member);
    if (!contact?.companyId) return null;
    const companyKey = `company:${contact.companyId}`;
    if (erased.some((entry) => subjectKey(entry) === companyKey)) return null;
    const contactsSvc = optional(modules, 'contact');
    if (!contactsSvc || typeof contactsSvc.list !== 'function') return null;
    let siblings;
    try {
      siblings = await listContactsOfCompany(contactsSvc, contact.companyId);
    } catch {
      notes.push('l’azienda collegata resta: non si è potuto verificare se ha altri contatti');
      return null;
    }
    const erasedIds = new Set(erased.filter((entry) => entry.resource === 'contact').map((entry) => entry.id));
    const others = siblings.filter((row) => row?.id && !erasedIds.has(row.id));
    if (others.length > 0) {
      notes.push(`l’azienda collegata resta: ha altri ${others.length} contatti`);
      return null;
    }
    const company = await readHost({ resource: 'company', id: contact.companyId });
    if (!company || isNoCompany(company)) return null;
    notes.push('l’azienda collegata non ha altri contatti ed è cancellata con questo cliente');
    return { resource: 'company', id: company.id, owner: 'host', ownerPackage: null };
  }

  /** Rewrite the host row of one erased subject. Fails closed when it cannot. */
  async function anonymizeHost(member, { actor }) {
    if (member.owner && member.owner !== 'host') return false;
    const service = optional(modules, member.resource);
    const current = await readHost(member);
    if (!current) return false;
    if (typeof service?.update !== 'function') {
      throw writeFailed(member.resource, new Error(`the ${member.resource} service offers no update`));
    }
    const patch = member.resource === 'contact'
      ? {
        ...ANONYMOUS_CONTACT,
        email: anonymizedEmail(member.id),
        // A job title identifies the person as surely as a name.
        role: null,
      }
      : { name: ANONYMOUS_COMPANY_NAME, domain: null };
    if (changesNothing(current, patch)) return false;
    await guardedWrite(member.resource, () => service.update(member.id, patch, { actor }));
    return true;
  }

  /**
   * Every row of one place naming any erased subject on any of its sides,
   * from complete reads, keyed by row id with the sides that matched.
   */
  async function rowsNaming(place, service, erased) {
    if (typeof service.listWhere !== 'function' || typeof service.applyManaged !== 'function') {
      throw readFailed(place.place, new Error('the module offers no complete read and managed write'));
    }
    const byId = new Map();
    for (const member of erased) {
      for (const side of place.sides) {
        const rows = await guardedRead(place.place, () => service.listWhere({
          [`${side}Resource`]: member.resource, [`${side}Id`]: member.id,
        }));
        for (const row of rows ?? []) {
          const entry = byId.get(row.id) ?? { row, sides: new Set() };
          entry.sides.add(side);
          byId.set(row.id, entry);
        }
      }
    }
    return byId;
  }

  async function sweepClusterReasons(clusterKeys, erased, actor) {
    const service = optional(modules, names.link);
    if (!service || clusterKeys.size === 0) return 0;
    const erasedKeys = new Set(erased.map(subjectKey));
    let cleared = 0;
    for (const clusterKey of clusterKeys) {
      const rows = await guardedRead('canonical-link', () => service.listWhere({ clusterKey }));
      for (const row of rows ?? []) {
        if (erasedKeys.has(`${row.subjectResource}:${row.subjectId}`)) continue;
        const patch = { reason: null, withdrawnReason: null };
        if (changesNothing(row, patch)) continue;
        await guardedWrite('canonical-link', () => service.applyManaged(row.id, patch, { actor }));
        cleared += 1;
      }
    }
    return cleared;
  }

  async function sweepBulkReasons(touched, actor) {
    const service = optional(modules, names.bulkItem);
    if (!service) return 0;
    let cleared = 0;
    for (const [moduleName, ids] of [[names.candidate, touched.candidate], [names.issue, touched.issue]]) {
      for (const recordId of ids) {
        const rows = await guardedRead('customer-bulk-item', () => service.listWhere({ recordModule: moduleName, recordId }));
        for (const row of rows ?? []) {
          if (row.outcome !== 'failed' || row.reason == null) continue;
          await guardedWrite('customer-bulk-item', () => service.applyManaged(row.id, { reason: null }, { actor }));
          cleared += 1;
        }
      }
    }
    return cleared;
  }

  /**
   * What this erasure cannot rewrite, counted on the receipt with its
   * reason instead of being left behind silently. Rows of another package
   * are its own: this package reaches them only to read, and their owner
   * rewrites them (named follow-up). The read is complete and fails closed
   * like every other: an unreadable count stops the erasure.
   */
  async function retainedPlaces(erased, profile) {
    const handled = new Set([
      'contact', 'company', 'opportunity',
      ...Object.values(names),
    ]);
    const retained = [];
    const opportunities = profile?.opportunities;
    if (opportunities?.available === true && (opportunities.count ?? 0) > 0) {
      retained.push(Object.freeze({
        place: 'opportunity', rows: opportunities.count, complete: opportunities.countIsComplete !== false,
        reason: 'trattativa commerciale: importi e fasi restano, il nome della trattativa non ha un percorso di riscrittura qui (seguito nominato)',
      }));
    }
    const listed = typeof modules.list === 'function' ? modules.list() : [];
    for (const entry of listed) {
      const name = entry?.name;
      if (typeof name !== 'string' || handled.has(name)) continue;
      const service = optional(modules, name);
      const fields = new Set((service?.manifest?.fields ?? []).map((field) => field?.name));
      const shapesFor = (member) => [
        ...(fields.has('subjectResource') && fields.has('subjectId')
          ? [{ subjectResource: member.resource, subjectId: member.id }] : []),
        ...(member.resource === 'contact' && fields.has('contactId') ? [{ contactId: member.id }] : []),
        ...(member.resource === 'company' && fields.has('companyId') ? [{ companyId: member.id }] : []),
      ];
      if (!erased.some((member) => shapesFor(member).length > 0)) continue;
      if (typeof service.listWhere !== 'function') {
        retained.push(Object.freeze({ place: name, rows: null, complete: false, reason: 'il modulo non offre una lettura completa' }));
        continue;
      }
      const ids = new Set();
      for (const member of erased) {
        for (const shape of shapesFor(member)) {
          const rows = await guardedRead(name, () => service.listWhere(shape));
          for (const row of rows ?? []) ids.add(row.id);
        }
      }
      if (ids.size > 0) {
        retained.push(Object.freeze({
          place: name, rows: ids.size, complete: true,
          reason: 'righe di un altro pacchetto: escluse dalle letture cliente, le riscrive il pacchetto proprietario (seguito nominato)',
        }));
      }
    }
    // The core history (audit, workflow runs, trace spans, write outcomes)
    // is append-only runtime evidence owned by core: it is declared on
    // every receipt, never claimed erased (named follow-up, ADR-018).
    retained.push(Object.freeze({
      place: 'core-audit-trace', rows: null, complete: false,
      reason: 'storico append-only del core (audit, esecuzioni, tracce): conserva i valori scritti prima della cancellazione, la sua redazione è un seguito nominato del core',
    }));
    return retained;
  }

  return Object.freeze({ eraseCustomer });
}

function summaryOf({ counts, retained, notes }) {
  const parts = [
    `${counts.subjects} soggett${counts.subjects === 1 ? 'o cancellato' : 'i cancellati'}`,
    `${counts.identitiesWithdrawn} identità ritirate`,
    `${counts.enrichedPurged} campi arricchiti purgati`,
    `${counts.fieldValuesBlanked} valori personalizzati azzerati`,
  ];
  const others = Object.entries(counts.places)
    .filter(([place]) => !['external-identity', 'enriched-field', 'custom-field-value'].includes(place));
  for (const [place, n] of others) parts.push(`${place}: ${n} righe anonimizzate`);
  for (const entry of retained) parts.push(`${entry.place}: ${entry.rows ?? '?'} righe conservate (${entry.reason})`);
  for (const note of notes) parts.push(note);
  return parts.join('; ');
}

/**
 * The replay contract, distinct from a first erasure by `replayed: true`.
 * A replay answers the stored row for the requested subject only: the
 * original tallies describe the whole cluster of that first call and are
 * not stored per row, so a replay carries no counts and no notes instead
 * of inventing them. `erasedSubjects` always holds the requested subject.
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
