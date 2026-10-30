// @ts-check

import { AppError, ValidationError, normalizeActor } from '../../core/index.js';
import { createBulkRunner } from './bulk.js';
import { aggregateChannelOrigins } from './capability-channel-origins.js';
import { deriveCustomerStatus } from './customer-status.js';
import {
  CUSTOMER_COLUMNS, CUSTOMER_LIST_CONTRACT, CUSTOMER_PAGE_SIZES, CUSTOMER_SCAN_LIMIT, CUSTOMER_SORTS,
  CUSTOMER_VIEWS, applyCustomerListQuery, filterCustomerRows, parseCustomerListQuery, shapeCustomerRow,
} from './customers.js';
import { createCustomerDataExport } from './export.js';
import { IMPORT_MAPPING, REASON, mappingFingerprint, resolveBatch } from './import.js';
import { detectIssues } from './quality.js';
import { belongsToCustomer, canonicalClusterFor, profileFor } from './profile.js';
import {
  createPolicyReader, createSubjectForRow, recordCandidatePairs, recordExternalIdentityRow,
} from './sender.js';
import {
  deciding, optional, orderedPair, resolvedNames, subjectFields, subjectKey, trusted,
} from './store.js';
import { ENRICHABLE_FIELDS } from './enrichment.js';

/**
 * **The application operations (ADR-032): import preview, import apply, bulk
 * apply, export, and the consolidated profile read.**
 *
 * These are application-scoped rather than record actions because none of them
 * belongs to a single record: an import is about a batch that may create the
 * very records it targets, a bulk spans many records, an export spans a whole
 * record set, and a profile spans every optional package that happens to be
 * composed. That is exactly the shape ADR-032 exists for, and the bounded
 * context it hands over — database, modules, events, config — is all they
 * take.
 *
 * The three properties worth stating once:
 *
 * - **preview writes nothing.** It resolves and returns receipts. No business
 *   record, no `customer-data` record, no audit entry, no event.
 * - **apply re-resolves inside its own transaction.** A preview is never an
 *   authorisation; the same resolution runs again against state as it is at
 *   commit time.
 * - **the profile reads.** It creates nothing, and a package that is not
 *   composed reads `available: false` with a reason rather than an empty list
 *   that would read as "this customer has none".
 */

/** @param {any} runtime @param {any} registries */
export function createCustomerDataOperations({ database, modules, events, config, core, policy, names }) {
  if (!database || !modules || !events) {
    throw new ValidationError('customer-data operations need database, modules and events');
  }
  if (!policy || typeof policy.resolve !== 'function') {
    throw new ValidationError('customer-data operations need the declared match policy');
  }

  /**
   * The read side the policy resolves against. It is built per call so a
   * resolution always sees current state — never a cached view captured when
   * the operation was composed. Shared with the channel sender resolution.
   */
  const readerFor = () => createPolicyReader({ modules, names, core });

  /** Shared summary shape for both preview and apply. */
  const summarize = (resolution, mode, runId = null) => ({
    mode,
    runId,
    system: resolution.system,
    acceptance: resolution.acceptance,
    mapping: { name: IMPORT_MAPPING.name, version: IMPORT_MAPPING.version, fingerprint: mappingFingerprint() },
    policy: { name: policy.name, version: policy.version, fingerprint: policy.fingerprint },
    idempotencyKey: resolution.idempotencyKey,
    counts: resolution.counts,
    receipts: resolution.receipts.map((receipt) => Object.freeze({
      index: receipt.index,
      outcome: receipt.outcome,
      reasonCode: receipt.reasonCode,
      reason: receipt.reason,
      matchRule: receipt.rule,
      subject: receipt.subject ?? null,
      candidates: receipt.candidates ?? [],
      willCreate: Boolean(receipt.created),
    })),
    limitations: LIMITATIONS,
  });

  return {
    /**
     * Import preview. **Writes nothing** — the whole point of the surface.
     * @param {any} request
     */
    async previewCustomerImport(request) {
      const resolution = await resolveBatch({ request, policy, reader: readerFor() });
      return Object.freeze({
        ...summarize(resolution, 'preview'),
        writes: 'nothing — this is a preview, and it records neither business data nor an import run',
      });
    },

    /**
     * Import apply. Human-or-agent, but every write is inside one transaction
     * and the resolution is recomputed here rather than trusted from a caller.
     * @param {any} request
     */
    async applyCustomerImport(request) {
      const actor = normalizeActor(request?.actor);
      // Re-resolve authoritatively. A preview handed in by the caller is
      // deliberately ignored: stale readiness authorises nothing.
      const resolution = await resolveBatch({ request, policy, reader: readerFor() });

      if (resolution.acceptance === 'all_or_nothing' && resolution.counts.rejected + resolution.counts.skipped > 0) {
        throw new AppError(
          `This import is all-or-nothing and ${resolution.counts.rejected + resolution.counts.skipped} of ${resolution.counts.rows} rows could not be accepted, so nothing was written`,
          {
            code: 'IMPORT_NOT_FULLY_ACCEPTABLE', status: 409,
            details: Object.freeze({ counts: resolution.counts, firstProblemRow: resolution.receipts.find((r) => r.outcome !== 'accepted')?.index ?? null }),
          },
        );
      }

      const runs = trusted(modules, names.run);
      const existing = (await runs.listWhere({ idempotencyKey: resolution.idempotencyKey }))[0];
      if (existing) {
        // Same payload → same run. A *different* payload cannot reach here:
        // the key is derived from the payload itself.
        return Object.freeze({
          ...summarize(resolution, 'apply', existing.id),
          replayed: true,
          writes: 'nothing new — this exact import was already applied, and its run is returned unchanged',
        });
      }

      const applied = await database.transactionAsync(async () => {
        const run = await runs.createManaged({
          sourceKey: `customer-import:${resolution.idempotencyKey}`,
          idempotencyKey: resolution.idempotencyKey,
          system: resolution.system,
          mapping: IMPORT_MAPPING.name,
          mappingVersion: IMPORT_MAPPING.version,
          mappingFingerprint: mappingFingerprint(),
          policy: policy.name,
          policyVersion: policy.version,
          policyFingerprint: policy.fingerprint,
          acceptance: resolution.acceptance,
          status: 'applied',
          rowCount: resolution.counts.rows,
          acceptedCount: resolution.counts.accepted,
          rejectedCount: resolution.counts.rejected,
          skippedCount: resolution.counts.skipped,
          candidateCount: 0,
          issueCount: 0,
          actorType: actor.type,
          actorId: actor.id,
          appliedAt: new Date().toISOString(),
        }, { actor });

        let candidateCount = 0;
        let issueCount = 0;

        for (const receipt of resolution.receipts) {
          let subject = receipt.subject ?? null;

          // Create the record the row names, when nothing matched it.
          if (receipt.outcome === 'accepted' && receipt.created) {
            subject = await createSubjectFor(receipt.row, actor);
          }

          await trusted(modules, names.row).createManaged({
            sourceKey: `customer-import-row:${run.id}:${receipt.index}`,
            runId: run.id,
            rowIndex: receipt.index,
            inputDigest: receipt.inputDigest,
            outcome: receipt.outcome,
            reasonCode: receipt.reasonCode,
            reason: receipt.reason,
            matchRule: receipt.rule,
            ...subjectFields(subject ?? { resource: 'none', id: 'none', owner: 'host', ownerPackage: null, label: null }),
            createdSubject: Boolean(receipt.created),
          }, { actor });

          // External identity: recorded for every accepted row that carries one.
          if (receipt.outcome === 'accepted' && subject && receipt.row?.externalId) {
            await recordExternalIdentity(receipt.row, subject, run.id, actor);
          }

          // Ambiguity becomes a candidate for a human, never a decision.
          if (receipt.outcome === 'skipped' && receipt.reasonCode === REASON.AMBIGUOUS) {
            candidateCount += await recordCandidates(receipt, run.id, actor);
          }
        }

        // Data-quality findings from this run's own evidence.
        issueCount = await recordIssues({ resolution, runId: run.id, actor });

        await runs.applyManaged(run.id, { candidateCount, issueCount }, { actor });
        return { run, candidateCount, issueCount };
      });

      events.emit?.('customer-data.import.applied', {
        runId: applied.run.id, system: resolution.system, counts: resolution.counts,
      });

      return Object.freeze({
        ...summarize(resolution, 'apply', applied.run.id),
        replayed: false,
        candidateCount: applied.candidateCount,
        issueCount: applied.issueCount,
      });
    },

    /**
     * Bulk-apply one of this package's human decisions across many records.
     * One transaction per item, one receipt per item, and a run that reads
     * `partial` when not every item applied. See `./bulk.js` for the
     * resume and replay discipline.
     * @param {any} request
     */
    async applyBulkCustomerAction(request) {
      return createBulkRunner({ database, modules, events, config, core, policy, names })
        .applyBulkAction(request);
    },

    /**
     * Export one of this package's managed record sets: counted first,
     * refused rather than truncated, complete or not at all. Writes nothing.
     * @param {any} request
     */
    async exportCustomerRecords(request) {
      return createCustomerDataExport({ database, modules, events, config })
        .exportCustomerRecords(request);
    },

    /**
     * The consolidated, read-only profile. Creates nothing.
     * @param {{resource?: string, id?: string}} request
     */
    async readCustomerProfile(request) {
      const resource = request?.resource;
      const id = request?.id;
      if (typeof resource !== 'string' || typeof id !== 'string' || resource === '' || id === '') {
        throw new ValidationError('a profile read needs a subject resource and id', { field: 'id' });
      }
      return profileFor({ modules, core, names, subject: { resource, id } });
    },

    /**
     * The enrichment read for the scheda cliente (BO-F4-03): every active
     * enriched field of the customer's whole cluster — linked identities
     * included — each with the free source that filled it and its
     * observation date, plus the opt-out state of the subject. Creates
     * nothing: enrichment rows land only through the enrichment action,
     * which refuses opted-out subjects before writing. A manually entered
     * value always wins by construction (enrichment never writes the
     * record), so these rows are the fallback the scheda shows — each
     * citing its source, never a sourceless value.
     * @param {{resource?: string, id?: string}} request
     */
    async readCustomerEnrichment(request) {
      const resource = request?.resource;
      const id = request?.id;
      if (typeof resource !== 'string' || typeof id !== 'string' || resource === '' || id === '') {
        throw new ValidationError('an enrichment read needs a subject resource and id', { field: 'id' });
      }
      // The whole cluster, not just the named record: enriched fields hang
      // off member contacts while the scheda may name the company.
      const cluster = await canonicalClusterFor({ modules, names, subject: { resource, id } });
      const memberIndex = new Map(cluster.members.map((member, index) => [subjectKey(member), index]));
      const fieldOrder = new Map(ENRICHABLE_FIELDS.map((field, index) => [field, index]));
      const enrichedSvc = trusted(modules, names.enriched);
      const collected = [];
      for (const member of cluster.members) {
        const rows = await deciding(enrichedSvc, {
          subjectResource: member.resource, subjectId: member.id, status: 'active',
        });
        for (const row of rows) {
          collected.push(Object.freeze({
            subject: Object.freeze({ resource: member.resource, id: member.id }),
            field: row.field,
            value: row.value,
            source: row.source,
            sourceDetail: row.sourceDetail ?? null,
            observedAt: row.observedAt,
          }));
        }
      }
      collected.sort((a, b) => (
        (memberIndex.get(subjectKey(a.subject)) ?? 0) - (memberIndex.get(subjectKey(b.subject)) ?? 0)
        || (fieldOrder.get(a.field) ?? ENRICHABLE_FIELDS.length) - (fieldOrder.get(b.field) ?? ENRICHABLE_FIELDS.length)
        || String(a.source).localeCompare(String(b.source))
      ));
      const optOut = (await deciding(trusted(modules, names.optOut), {
        subjectResource: resource, subjectId: id,
      }))[0] ?? null;
      return Object.freeze({
        customerEnrichmentContract: 1,
        subject: Object.freeze({ resource, id }),
        linked: cluster.linked,
        optedOut: optOut
          ? Object.freeze({ reason: optOut.reason ?? null, optedOutAt: optOut.optedOutAt ?? null })
          : null,
        items: Object.freeze(collected),
      });
    },

    /**
     * The customer list (BO-F1-05): one server page over the host contact and
     * company records, enriched from the same reads the scheda uses. Creates
     * nothing. Every read behind a row is a complete exact-match query except
     * the host scan itself, which is a bounded display read: when the bound
     * truncates it the answer says `complete: false` and the total is a
     * floor, never an exact count.
     * @param {any} request
     */
    async listCustomerRecords(request) {
      return listCustomerRecords({ modules, core, names }, request);
    },

    /**
     * Channel origins (BO-F6-13, slice 2): new customers per origin channel
     * and ISO week from the active external-identity rows. Creates nothing.
     * The same pure aggregation the `customer-channel-origins@1` capability
     * answers, so the pilot route and any declared consumer read identical
     * numbers by construction.
     * @param {any} request ignored: the aggregate is whole-table by design
     */
    async countCustomerChannelOrigins(request) {
      void request;
      // A correctness read, never a display page: see `deciding` in store.js.
      const rows = await deciding(trusted(modules, names.identity), { status: 'active' });
      const { origins, undated } = aggregateChannelOrigins(rows);
      return Object.freeze({ origins, undated });
    },
  };

  /** Create the Company/Contact this row names, through the core adapters. Shared with the sender resolution. */
  async function createSubjectFor(row, actor) {
    return createSubjectForRow(core, row, actor);
  }

  async function recordExternalIdentity(row, subject, runId, actor) {
    await recordExternalIdentityRow({
      modules, names, system: row.system, externalId: row.externalId, subject, runId, actor,
    });
  }

  async function recordCandidates(receipt, runId, actor) {
    const list = receipt.candidates ?? [];
    const pairs = [];
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        pairs.push(orderedPair(list[i], list[j]));
      }
    }
    return recordCandidatePairs({
      modules, names, policy, pairs, rule: receipt.rule, evidence: receipt.reason, runId, actor,
    });
  }

  async function recordIssues({ resolution, runId, actor }) {
    const issues = trusted(modules, names.issue);
    const found = await detectIssues({ resolution, modules, names });
    let written = 0;
    for (const issue of found) {
      const sourceKey = `issue:${issue.kind}:${issue.subject ? subjectKey(issue.subject) : `run:${runId}:${issue.index ?? 0}`}`;
      if ((await issues.listWhere({ sourceKey }))[0]) continue;
      await issues.createManaged({
        sourceKey,
        kind: issue.kind,
        ...subjectFields(issue.subject ?? { resource: 'none', id: 'none', owner: 'host', ownerPackage: null, label: null }),
        evidence: issue.evidence,
        detector: issue.detector,
        detectorVersion: 1,
        detectedByRunId: runId,
        detectedAt: new Date().toISOString(),
        status: 'open',
        resolutionReason: null,
        decidedByType: null,
        decidedById: null,
        decidedAt: null,
      }, { actor });
      written += 1;
    }
    return written;
  }
}

/**
 * The customer list read (BO-F1-05). Module-level so tests drive it with a
 * fake module map; the operation above hands it the composed runtime.
 *
 * Reads, all optional except the host records:
 * - contacts + companies (bounded display scan; truncation is reported);
 * - channel identities beside each subject (complete exact-match reads);
 * - signed-business evidence, opportunities, work tasks, subscriptions,
 *   messages, calls and budget signals (complete when the owning module
 *   offers `listWhere`, otherwise a bounded page flagged partial, otherwise
 *   unavailable with its reason — never an empty claim).
 * Writes nothing.
 */
export async function listCustomerRecords({ modules, core, names }, request) {
  void core;
  const query = parseCustomerListQuery(request);
  const contactsSvc = optional(modules, 'contact');
  const companiesSvc = optional(modules, 'company');
  if (!contactsSvc || typeof contactsSvc.list !== 'function') {
    throw new AppError('the customer list needs the host contact records', { code: 'CUSTOMER_LIST_UNAVAILABLE', status: 409 });
  }
  if (!companiesSvc || typeof companiesSvc.list !== 'function') {
    throw new AppError('the customer list needs the host company records', { code: 'CUSTOMER_LIST_UNAVAILABLE', status: 409 });
  }
  const contacts = await contactsSvc.list({ limit: CUSTOMER_SCAN_LIMIT });
  const companies = await companiesSvc.list({ limit: CUSTOMER_SCAN_LIMIT });
  const complete = contacts.length < CUSTOMER_SCAN_LIMIT && companies.length < CUSTOMER_SCAN_LIMIT;
  const companyById = new Map(companies.map((company) => [company.id, company]));
  const subjects = [];
  const seenCompanies = new Set();
  for (const contact of contacts) {
    const company = (contact?.companyId && companyById.get(contact.companyId)) || null;
    if (company) seenCompanies.add(company.id);
    subjects.push({ contact, company });
  }
  for (const company of companies) {
    if (!seenCompanies.has(company.id)) subjects.push({ contact: null, company });
  }
  const refs = {
    companyIds: new Set(companies.map((company) => company.id)),
    contactIds: new Set(contacts.map((contact) => contact.id)),
    opportunityIds: new Set(),
  };
  const keyOf = (resource, id) => `${resource}:${id}`;
  const subjectKeys = subjects.map(({ contact, company }) => (
    contact ? keyOf('contact', contact.id) : keyOf('company', company.id)
  ));

  // One batched exact-match read per module: the IN shapes for both host
  // kinds at once, so the whole list costs a bounded handful of indexed
  // queries instead of one read per customer.
  const batched = async (moduleName, extraShapes = []) => {
    const service = optional(modules, moduleName);
    if (!service) return { rows: [], readable: false };
    const shapes = [
      { subjectResource: 'contact', subjectId: [...refs.contactIds] },
      { subjectResource: 'company', subjectId: [...refs.companyIds] },
      ...extraShapes,
    ].filter((shape) => Array.isArray(shape.subjectId) ? shape.subjectId.length > 0 : true);
    if (typeof service.listWhere === 'function') {
      const byId = new Map();
      let exact = false;
      for (const shape of shapes) {
        try {
          for (const row of await service.listWhere(shape)) byId.set(row.id, row);
          exact = true;
        } catch {
          // A module that declares none of these shapes is not readable from
          // here; the next shape (or the fallback below) still runs.
        }
      }
      // An exact read with zero rows is complete, not partial: falling
      // through to the bounded page would mislabel an exact zero as a floor.
      if (exact) return { rows: [...byId.values()], readable: true, complete: true };
    }
    if (typeof service.list === 'function') {
      const rows = (await service.list({ limit: CUSTOMER_SCAN_LIMIT }))
        .filter((row) => belongsToCustomer(row, refs));
      return { rows, readable: true, complete: false };
    }
    return { rows: [], readable: false };
  };

  const identities = await batched(names.identity);
  const identitiesBySubject = new Map(subjectKeys.map((key) => [key, []]));
  for (const row of identities.rows) {
    const key = keyOf(row.subjectResource, row.subjectId);
    if (identitiesBySubject.has(key) && row?.status === 'active') identitiesBySubject.get(key).push(row);
  }

  const opportunities = await batched('opportunity', [
    { companyId: [...refs.companyIds] },
    { contactId: [...refs.contactIds] },
  ]);
  for (const row of opportunities.rows) {
    if (row?.id) refs.opportunityIds.add(row.id);
  }

  // Evidence after opportunities: an evidence row may name the opportunity
  // rather than the customer, and that hop is explicit, never guessed.
  const evidenceReads = {};
  for (const [sectionKey, moduleName] of [['orders', 'order'], ['contracts', 'commercial-contract'], ['subscriptions', 'subscription']]) {
    evidenceReads[sectionKey] = await batched(moduleName, [
      { companyId: [...refs.companyIds] },
      { contactId: [...refs.contactIds] },
      ...(refs.opportunityIds.size > 0 ? [{ opportunityId: [...refs.opportunityIds] }] : []),
    ]);
  }

  const tasks = await batched('work-task');
  const messages = await batched('interaction-message');
  const calls = await batched('interaction-call');
  let signals = { rows: [], readable: false };
  if (query.spaceId) {
    const signalSvc = optional(modules, 'call-signal');
    if (signalSvc && typeof signalSvc.listWhere === 'function') {
      const byId = new Map();
      for (const resource of ['contact', 'company']) {
        const ids = resource === 'contact' ? [...refs.contactIds] : [...refs.companyIds];
        if (ids.length === 0) continue;
        try {
          for (const row of await signalSvc.listWhere({ spaceId: query.spaceId, subjectResource: resource, subjectId: ids })) {
            if (row?.signalType === 'budget') byId.set(row.id, row);
          }
        } catch {
          // A renamed signal module stays unreadable, never misread.
        }
      }
      signals = { rows: [...byId.values()], readable: true };
    }
  }

  // A derived view over an unreadable dependency refuses with its reason,
  // never with an exact-looking empty page: the two derived views need the
  // work and subscription packages, and without them "no renewals" would be
  // a claim the application cannot make. A truncated dependency read
  // (complete:false from a list-only fallback or a bound the scan hit)
  // refuses the same way: it would silently omit renewals or callbacks
  // while totalIsExact stays true.
  if (query.view?.id === 'rinnovi-30-giorni'
    && (evidenceReads.subscriptions.readable !== true || evidenceReads.subscriptions.complete === false)) {
    throw new AppError('the rinnovi-30-giorni view needs the subscription records, which are not readable here', { code: 'CUSTOMER_LIST_UNAVAILABLE', status: 409 });
  }
  if (query.view?.id === 'ricontattare-oggi'
    && (tasks.readable !== true || tasks.complete === false)) {
    throw new AppError('the ricontattare-oggi view needs the work-task records, which are not readable here', { code: 'CUSTOMER_LIST_UNAVAILABLE', status: 409 });
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = subjects.map(({ contact, company }) => {
    const resource = contact ? 'contact' : 'company';
    const id = contact?.id ?? company?.id;
    const key = keyOf(resource, id);
    const directIds = {
      companyIds: new Set(company ? [company.id] : []),
      contactIds: new Set(contact ? [contact.id] : []),
    };
    const subject = { resource, id };
    // This customer's own opportunities first (company/contact reference),
    // so the opportunity hop below is scoped to this customer: an order
    // that names another customer's opportunity must not promote this one.
    // On a contact row a company match alone never pulls in another
    // contact's contact-scoped record, or every card in the company shares
    // the same offer.
    const myOpportunities = opportunities.rows.filter((row) => belongsToCustomer(row, {
      ...directIds,
      opportunityIds: new Set(),
    }, subject));
    const mine = (row) => belongsToCustomer(row, {
      ...directIds,
      opportunityIds: new Set(myOpportunities.map((entry) => entry?.id).filter((entry) => entry != null)),
    }, subject);
    const statusBySubject = new Map([[key, deriveCustomerStatus({
      orders: sectionSummary(evidenceReads.orders, mine),
      contracts: sectionSummary(evidenceReads.contracts, mine),
      subscriptions: sectionSummary(evidenceReads.subscriptions, mine),
    })]]);
    const openValue = myOpportunities
      .filter((row) => row?.stage !== 'won' && row?.stage !== 'lost')
      .reduce((sum, row) => sum + (Number(row?.valueCents ?? 0) || 0), 0);
    const currencies = [...new Set(myOpportunities.map((row) => row?.currency).filter((currency) => typeof currency === 'string' && currency !== ''))];
    const myTasks = tasks.rows.filter(mine).filter((row) => row?.status === 'open');
    // The callback view filters on this one value, so it must be the most
    // actionable open task — overdue first, then due today — never the
    // earliest-sorted row, where an undated task ('') would sort before any
    // date and hide a callback that is due.
    const taskRank = (row) => {
      const day = typeof row?.dueAt === 'string' ? row.dueAt.slice(0, 10) : '';
      if (day !== '' && day < today) return 0;
      if (day === today) return 1;
      return 2;
    };
    myTasks.sort((a, b) => (taskRank(a) - taskRank(b))
      || String(a?.dueAt ?? '').localeCompare(String(b?.dueAt ?? '')));
    const next = myTasks[0] ?? null;
    const myMessages = [...messages.rows.filter(mine), ...calls.rows.filter(mine)];
    let lastContactAt = null;
    let lastContactChannel = null;
    // The preview is the latest message body read above — calls name no
    // body field, so a latest call (or a non-string body) previews as null.
    let lastContactText = null;
    for (const row of myMessages) {
      const time = Date.parse(String(row?.occurredAt ?? ''));
      if (!Number.isFinite(time)) continue;
      if (lastContactAt === null || time > Date.parse(String(lastContactAt))) {
        lastContactAt = row.occurredAt;
        lastContactChannel = row.channel ?? null;
        lastContactText = typeof row?.body === 'string' ? row.body : null;
      }
    }
    const renewalWithinDays = evidenceReads.subscriptions.rows.filter(mine).some((row) => (
      row?.status === 'active' && withinDays(row?.endDate, today, 30)
    ));
    const mySignals = signals.rows.filter(mine);
    mySignals.sort((a, b) => String(b?.observedAt ?? '').localeCompare(String(a?.observedAt ?? '')));
    const budgetSignal = mySignals[0] ?? null;
    return shapeCustomerRow({ contact, company }, {
      identitiesBySubject,
      statusBySubject,
      activityBySubject: new Map(lastContactAt === null ? [] : [[key, { occurredAt: lastContactAt, channel: lastContactChannel, text: lastContactText }]]),
      offerBySubject: new Map(myOpportunities.length === 0 ? [] : [[key, {
        valueCents: openValue, currency: currencies.length === 1 ? currencies[0] : null,
      }]]),
      taskBySubject: new Map(next === null ? [] : [[key, {
        title: next.title ?? null,
        dueAt: next.dueAt ?? null,
        overdue: typeof next.dueAt === 'string' && next.dueAt !== '' && next.dueAt.slice(0, 10) < today,
      }]]),
      renewalBySubject: new Map([[key, renewalWithinDays]]),
      budgetBySubject: new Map(budgetSignal === null ? [] : [[key, {
        available: true,
        value: typeof budgetSignal.excerpt === 'string' && budgetSignal.excerpt !== '' ? budgetSignal.excerpt : null,
        source: { resource, id },
      }]]),
    });
  });

  const page = applyCustomerListQuery(rows, query, today);
  // Per-view pill counts (prototype checklist C10: `<etichetta> <n>`): the
  // same predicate the page applies, counted without pagination over the
  // current explicit filters. A view without a count renders its label
  // only — honest absence, never an exact-looking floor: no count when the
  // subject scan truncated (complete:false), nor for a derived view whose
  // dependency is unreadable or partial here.
  const views = CUSTOMER_VIEWS.map((view) => {
    const entry = { id: view.id, label: view.label };
    if (complete !== true) return entry;
    if (view.id === 'ricontattare-oggi' && (tasks.readable !== true || tasks.complete === false)) return entry;
    if (view.id === 'rinnovi-30-giorni'
      && (evidenceReads.subscriptions.readable !== true || evidenceReads.subscriptions.complete === false)) return entry;
    return { ...entry, count: filterCustomerRows(rows, query, view, today).length };
  });
  return Object.freeze({
    customerListContract: CUSTOMER_LIST_CONTRACT,
    items: page.items,
    total: page.total,
    page: page.page,
    pageSize: page.pageSize,
    pages: page.pages,
    complete,
    totalIsExact: complete,
    views,
    sorts: CUSTOMER_SORTS.map((sort) => ({ ...sort })),
    columns: CUSTOMER_COLUMNS.map((column) => ({ ...column })),
    pageSizes: [...CUSTOMER_PAGE_SIZES],
  });
}

/** Evidence summary for one customer from a batched section read. */
function sectionSummary(read, mine) {
  if (!read || read.readable !== true) {
    return { available: false, count: null, countIsComplete: true };
  }
  const count = read.rows.filter(mine).length;
  return { available: true, count, countIsComplete: read.complete !== false };
}

/** YYYY-MM-DD within (today, today + days]. */
function withinDays(value, today, days) {
  if (typeof value !== 'string' || value === '') return false;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const end = new Date(`${today}T00:00:00.000Z`).getTime() + days * 86400000;
  const endDay = new Date(end).toISOString().slice(0, 10);
  return day > today && day <= endDay;
}

/** Stated on every operation result, because a limit nobody reads is not a limit. */
export const LIMITATIONS = Object.freeze([
  'NO_FUZZY_MATCHING — every rule is exact; ambiguity is reported unresolved and never guessed',
  'NO_AUTOMATIC_MERGE — a duplicate candidate is never resolved without a human decision',
  'NO_CONTACT_WITHOUT_EMAIL — a sender that matches nothing and carries no email creates no contact: a contact needs a globally-unique email and the sender resolution invents none',
  'NO_PHYSICAL_MERGE — canonical identity is a logical link; no record is deleted, rewritten or cascaded',
  'NO_REMOTE_PROVIDER — v1 accepts bounded rows only: no credential, no fetch, no file path',
  'NO_RAW_PAYLOAD — provenance is stored, the source payload is not',
  'NO_MANUAL_OVERWRITE — enrichment never writes the contact record: a manually entered value wins by construction and enriched fields live beside it with their source and date',
  'NO_PAID_ENRICHMENT — enrichment reads free sources only (Google Contacts, email signatures): no paid enrichment service is wired, called or referenced',
  'OPT_OUT_IS_FINAL — an opted-out subject is never enriched again and its active enriched fields are purged on opt-out',
  'NO_RBAC — a human actor is an audit identity, not role enforcement; the Production Spine does not exist',
  'NO_LEGAL_ASSURANCE — nothing here is a GDPR, consent, retention or erasure claim',
  'NOT_A_COMPLETE_TIMELINE — the profile spans Accordo-managed records only, and says so per package',
  'PARTIAL_IS_PARTIAL — a bulk run that did not apply every item reads partial, never completed',
  'NO_SILENT_TRUNCATION — an export that would exceed its bound refuses instead of returning a short file',
]);

export { canonicalClusterFor };
