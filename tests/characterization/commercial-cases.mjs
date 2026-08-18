import { normalizeIds, observation } from './characterization-contract.mjs';
import { boot, characterizationProject, cli, commercialSchemaBlock, commercialSchemaLocation, COMMERCIAL_MODULES } from './commercial-harness.mjs';

/**
 * The Commercial Operations characterization cases.
 *
 * Everything here is driven through the **public** surface — the SDK over a
 * real HTTP server, `/api/schema`, the CLI — because the question the
 * extraction has to answer is "does a consumer see the same thing", and an
 * in-process call cannot answer it. The exceptions are deliberate: exact audit
 * and trace counts are read straight from storage (no public surface offers an
 * unpaged read), and the two-connection races open a second real application
 * on the same database, which is the only honest way to race.
 *
 * Every observation is classified. Only `contractual` and
 * `compatibility_required` are compared against the baseline; `incidental` is
 * recorded and never asserted, and `pre_extraction_evidence` records the
 * wiring the extraction exists to change. Amounts are frozen as **values** —
 * a suite that summarizes money into pass/fail has already lost the cent it
 * exists to protect.
 */

/** Names of record modules, derived once from the manifest list. */
const MODULE_NAMES = COMMERCIAL_MODULES.map((manifest) => manifest.replace('.module.json', ''));

/**
 * Wall-clock fields. Catalog sync stamps `startedAt`/`completedAt`/
 * `effectiveAt` (and every record its `createdAt`/`updatedAt`) from the real
 * clock, so their values are masked to presence. Action-driven timestamps
 * (`submittedAt`, `requestedAt`, `decidedAt`) come from the pinned application
 * clock and stay asserted by value.
 */
const OPAQUE = new Set(['createdAt', 'updatedAt', 'startedAt', 'completedAt', 'effectiveAt']);

/** JSON-carrying evidence columns, parsed before freezing so ids inside them normalize. */
const JSON_FIELDS = new Set(['totalsJson', 'breakdownJson', 'tiersJson', 'tierBreakdownJson']);

/**
 * A record with wall-clock values masked, JSON evidence parsed, and generated
 * identifiers normalized **positionally** so identity relationships survive:
 * two rows pointing at one quote render the same token, and a cross-wired id
 * is a visible difference.
 */
function stable(record, mapping = new Map()) {
  const out = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (OPAQUE.has(key)) {
      out[key] = value === null || value === undefined ? null : '<present>';
    } else if (JSON_FIELDS.has(key) && typeof value === 'string') {
      try { out[key] = JSON.parse(value); } catch { out[key] = value; }
    } else {
      out[key] = value;
    }
  }
  return normalizeIds(out, mapping);
}

/** One shared mapping across a set of records, so cross-record links survive. */
function stableAll(records) {
  const mapping = new Map();
  return records.map((record) => stable(record, mapping));
}

/** A refusal, reduced to what a consumer depends on. */
const refusal = (promise) => promise.then(
  () => ({ refused: false, status: null, code: null }),
  (error) => ({ refused: true, status: error.status ?? null, code: error.code ?? null }),
);

/** Exact, unpaged audit counts — no public read is unpaged, so storage answers. */
function auditCounts(app) {
  const rows = app.database.raw.prepare('SELECT action, COUNT(*) AS n FROM audit_events GROUP BY action ORDER BY action').all();
  return Object.fromEntries(rows.map((row) => [row.action, row.n]));
}

/** Exact, unpaged trace counts by workflow and status. */
function traceCounts(app) {
  const rows = app.database.raw
    .prepare('SELECT workflow_name, status, COUNT(*) AS n FROM workflow_runs GROUP BY workflow_name, status ORDER BY workflow_name, status').all();
  return Object.fromEntries(rows.map((row) => [`${row.workflow_name}:${row.status}`, row.n]));
}

/** Create a core company + opportunity to hang quotes on. Deterministic input. */
async function seedOpportunity(app, name) {
  const actor = { type: 'user', id: 'la0-seed' };
  const company = await app.services.companies.create({ name: `Co ${name}` }, { actor });
  return app.services.opportunities.create(
    { companyId: company.id, name, type: 'new_business', valueCents: 1_000_000, currency: 'EUR', stage: 'discovery', owner: 'la0' },
    { actor },
  );
}

const offerOf = (app, key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
const svc = (app, name) => app.modules.get(name).service;

/** @param {(entry: ReturnType<typeof observation>) => void} record */
export async function runCommercialCases(t, record) {
  const root = characterizationProject(t);
  const instance = await boot(root, `${root}/data/la0-commercial.sqlite`, { catalogTimeoutMs: 150 });
  t.after(() => instance.close().catch(() => {}));
  const { app, client, agentClient } = instance;

  // Every dispatched domain event, by name. Registered before the first write.
  const eventCounts = {};
  app.events.subscribe('*', ({ event }) => { eventCounts[event] = (eventCounts[event] ?? 0) + 1; });

  // -------------------------------------------------------------------------
  // architecture — what the extraction must MIGRATE, not what it must preserve
  // -------------------------------------------------------------------------
  const schema = await client.schema();
  const block = commercialSchemaBlock(schema);
  record(observation({
    id: 'architecture.schema-commercial-block-present',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'schema',
    observed: { present: Boolean(block), foundAt: commercialSchemaLocation(schema) },
    note: 'Published today as an ambient `commercial` block on /api/schema from app.commercial.metadata(). After extraction it should be the package\'s own schema contribution — a deliberate migration, not a behaviour change to hide.',
  }));
  record(observation({
    id: 'architecture.app-commercial-field-present',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: { present: typeof app.commercial === 'object' && app.commercial !== null },
    note: 'The ambient registries on the application object, injected into every action context. The extraction replaces them with registries the package owns.',
  }));
  record(observation({
    id: 'architecture.catalog-sync-ownership',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'http',
    observed: { appMethod: typeof app.syncCatalog === 'function', route: 'POST /api/catalog/sync' },
    note: 'The one Commercial-owned kernel HTTP route and app method. No package can contribute a route or an application operation today — the B7 seam evidence in the ExecPlan. The route behaviour itself is frozen contractually by the catalog.* observations.',
  }));

  // The published contract: contents are contractual wherever the block lives.
  record(observation({
    id: 'architecture.schema-contract-strings',
    category: 'architecture',
    classification: 'contractual',
    surface: 'schema',
    observed: {
      commercialContract: block?.commercialContract ?? null,
      pricingContract: block?.pricingContract ?? null,
      money: block?.money ?? null,
      discounts: block?.discounts ?? null,
      totals: block?.totals ?? null,
      unsupportedModels: block?.unsupportedModels ?? null,
      chargeTypes: block?.chargeTypes ?? null,
      pricingModels: block?.pricingModels ?? null,
      recurringIntervals: block?.recurringIntervals ?? null,
      maxDiscountBps: block?.maxDiscountBps ?? null,
      maxQuantity: block?.maxQuantity ?? null,
      quantitySemantics: block?.quantitySemantics ?? null,
    },
  }));
  record(observation({
    id: 'architecture.definition-kinds-published',
    category: 'architecture',
    classification: 'contractual',
    surface: 'schema',
    observed: {
      catalogProviders: (block?.catalogProviders ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
      discountPolicies: (block?.discountPolicies ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
    },
  }));
  for (const kind of ['catalogProviders', 'discountPolicies']) {
    for (const entry of block?.[kind] ?? []) {
      record(observation({
        id: `architecture.fingerprint.${kind}.${entry.name}@${entry.version}`,
        category: 'architecture',
        classification: 'contractual',
        surface: 'schema',
        observed: entry.fingerprint,
      }));
    }
  }

  // Module surface: read-only capabilities and managed fields, per module.
  const moduleCapabilities = {};
  const managedFields = {};
  for (const name of MODULE_NAMES) {
    const meta = (schema.generatedModules ?? []).find((entry) => entry.name === name);
    moduleCapabilities[name] = [...(meta?.capabilities ?? [])].sort();
    managedFields[name] = (meta?.fields ?? []).filter((field) => field.writable === 'managed').map((field) => field.name).sort();
  }
  record(observation({
    id: 'architecture.module-capabilities',
    category: 'architecture',
    classification: 'contractual',
    surface: 'schema',
    observed: moduleCapabilities,
  }));
  record(observation({
    id: 'architecture.managed-fields',
    category: 'architecture',
    classification: 'contractual',
    surface: 'schema',
    observed: managedFields,
  }));

  const quoteMeta = (schema.generatedModules ?? []).find((entry) => entry.name === 'quote');
  record(observation({
    id: 'architecture.quote-actions-advertised',
    category: 'architecture',
    classification: 'contractual',
    surface: 'action-metadata',
    observed: (quoteMeta?.actions ?? []).map((entry) => entry.name).sort(),
  }));
  record(observation({
    id: 'architecture.opportunity-actions-advertised',
    category: 'architecture',
    classification: 'contractual',
    surface: 'action-metadata',
    observed: (schema.coreModuleActions?.opportunity ?? []).map((entry) => entry.name).sort(),
  }));
  const quoteActionByName = new Map((quoteMeta?.actions ?? []).map((entry) => [entry.name, entry]));
  const opportunityActionByName = new Map((schema.coreModuleActions?.opportunity ?? []).map((entry) => [entry.name, entry]));
  for (const [name, action] of [
    ['create-quote', opportunityActionByName.get('create-quote')],
    ...['add-line', 'update-line', 'remove-line', 'submit', 'approve', 'reject', 'revise'].map((entry) => [entry, quoteActionByName.get(entry)]),
  ]) {
    record(observation({
      id: `architecture.action-contract.${name}`,
      category: 'architecture',
      classification: 'contractual',
      surface: 'action-metadata',
      observed: {
        actionContract: action?.actionContract ?? null,
        path: action?.path ?? null,
        stateField: action?.stateField ?? null,
        fromStates: [...(action?.fromStates ?? [])].sort(),
        confirm: Boolean(action?.confirm),
        input: (action?.input ?? []).map((entry) => ({ name: entry.name, type: entry.type, required: Boolean(entry.required) })),
      },
    }));
  }

  // The Admin quote screens render purely from this data; the browser itself
  // is tests/admin-quotes.test.js's job (ADMIN_RENDER_NOT_MODELLED).
  record(observation({
    id: 'architecture.admin-read-data',
    category: 'architecture',
    classification: 'contractual',
    surface: 'admin',
    observed: {
      blockPresent: Boolean(block),
      discountPolicyOptions: (block?.discountPolicies ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
    },
    note: 'The presence gate and the submit dropdown in apps/admin/public/admin-quotes.js read exactly this.',
  }));

  // Read-only boundary: POST/PATCH fail closed on every commercial module.
  const readOnly = {};
  for (const name of ['price-book', 'quote', 'quote-version', 'offer']) {
    readOnly[name] = {
      create: await refusal(client.module(name).create({})),
      update: await refusal(client.module(name).update('some-id', {})),
    };
  }
  record(observation({
    id: 'architecture.read-only-refusals',
    category: 'architecture',
    classification: 'contractual',
    surface: 'http',
    observed: readOnly,
  }));

  // -------------------------------------------------------------------------
  // catalog — sync, records, idempotency, revisions
  // -------------------------------------------------------------------------
  const sync1 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  record(observation({
    id: 'catalog.sync.first-run',
    category: 'catalog',
    classification: 'contractual',
    surface: 'http',
    observed: normalizeIds({ ok: sync1.ok, provider: sync1.provider, providerVersion: sync1.providerVersion, counts: sync1.counts, runId: sync1.runId }),
  }));
  record(observation({
    id: 'catalog.sync.run-record',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(svc(app, 'catalog-sync-run').listWhere({ provider: 'fixture-saas-catalog' })),
  }));

  const auditBeforeResync = app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  const eventsBeforeResync = Object.values(eventCounts).reduce((sum, n) => sum + n, 0);
  const sync2 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  record(observation({
    id: 'catalog.sync.rerun-idempotent',
    category: 'catalog',
    classification: 'contractual',
    surface: 'http',
    observed: {
      counts: sync2.counts,
      auditDelta: app.database.raw.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n - auditBeforeResync,
      eventDelta: Object.values(eventCounts).reduce((sum, n) => sum + n, 0) - eventsBeforeResync,
    },
    note: 'An identical re-sync writes only its sync-run evidence: no fake audits, no fake events, no rewritten rows.',
  }));

  record(observation({
    id: 'catalog.records.price-book',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(svc(app, 'price-book').listWhere({ sourceKey: 'fixture:pb:standard-eur' })),
  }));
  const products = svc(app, 'product').listWhere({ provider: 'fixture-saas-catalog' })
    .sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : 1));
  record(observation({
    id: 'catalog.records.products',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(products),
  }));
  record(observation({
    id: 'catalog.records.product-versions',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(products.map((product) => svc(app, 'product-version').listWhere({ productId: product.id })
      .sort((a, b) => a.version - b.version)).flat()),
  }));
  const offers = svc(app, 'offer').listWhere({ provider: 'fixture-saas-catalog' })
    .sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : 1));
  // An offer's sourceFingerprint hashes its declared data INCLUDING the
  // generated productVersionId, so it is a run-input fingerprint — asserted by
  // presence and by the properties that matter (identical re-sync writes
  // nothing; a v2 catalog produces a new revision), never by value.
  record(observation({
    id: 'catalog.records.offers',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(offers.map((offer) => ({
      ...offer,
      sourceFingerprint: typeof offer.sourceFingerprint === 'string' && /^[0-9a-f]{64}$/.test(offer.sourceFingerprint)
        ? '<offer-declared-fingerprint>' : offer.sourceFingerprint,
    }))),
  }));
  const componentRows = offers.flatMap((offer) => svc(app, 'price-component').listWhere({ offerId: offer.id })
    .sort((a, b) => a.position - b.position)
    .map((component) => ({
      ...component,
      tiers: svc(app, 'price-tier').listWhere({ componentId: component.id })
        .sort((a, b) => a.position - b.position)
        .map((tier) => ({ position: tier.position, upToQuantity: tier.upToQuantity, unitAmountCents: tier.unitAmountCents, flatAmountCents: tier.flatAmountCents })),
    })));
  record(observation({
    id: 'catalog.records.components-and-tiers',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(componentRows),
  }));
  record(observation({
    id: 'catalog.unsupported-offer-preserved-not-approximated',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: (() => {
      const metered = offers.find((offer) => offer.logicalKey === 'fixture:offer:bandwidth-metered');
      return {
        quoteEligible: metered?.quoteEligible ?? null,
        unsupportedReason: metered?.unsupportedReason ?? null,
        componentRows: metered ? svc(app, 'price-component').countWhere({ offerId: metered.id }) : null,
      };
    })(),
  }));

  // The auxiliary catalog: a USD book, an inactive book and a cross-book offer.
  const auxSync = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'la0-aux-catalog' } });
  record(observation({
    id: 'catalog.sync.aux-provider',
    category: 'catalog',
    classification: 'contractual',
    surface: 'http',
    observed: { counts: auxSync.counts, provider: auxSync.provider },
  }));

  // -------------------------------------------------------------------------
  // quote — lifecycle, server pricing, grouped totals
  // -------------------------------------------------------------------------
  const book = svc(app, 'price-book').listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const dormantBook = svc(app, 'price-book').listWhere({ sourceKey: 'la0:pb:dormant' })[0];
  const enterprise = offerOf(app, 'fixture:offer:enterprise');
  const storage = offerOf(app, 'fixture:offer:storage-monthly');
  const support = offerOf(app, 'fixture:offer:support-annual');
  const setup = offerOf(app, 'fixture:offer:setup');
  const apiAddon = offerOf(app, 'fixture:offer:api-monthly');
  const metered = svc(app, 'offer').listWhere({ logicalKey: 'fixture:offer:bandwidth-metered' })[0];
  const usdOffer = offerOf(app, 'la0:offer:usd-widget');
  const quotes = client.module('quote');

  const opportunity = await seedOpportunity(app, 'Main journey');
  record(observation({
    id: 'quote.create-against-inactive-book',
    category: 'quote',
    classification: 'contractual',
    surface: 'http',
    observed: await refusal(client.request(
      `/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`,
      { method: 'POST', body: { priceBookId: dormantBook.id } },
    )),
  }));
  const created = await client.request(
    `/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`,
    { method: 'POST', body: { priceBookId: book.id } },
  );
  const quoteId = created.result.quote.id;
  record(observation({
    id: 'quote.created',
    category: 'quote',
    classification: 'contractual',
    surface: 'http',
    observed: normalizeIds(created.result.quote),
  }));
  record(observation({
    id: 'quote.submit-empty-refused',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(quotes.action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 })),
  }));

  const entLine = await quotes.action(quoteId, 'add-line', { offerId: enterprise.id, quantity: 30 });
  record(observation({
    id: 'quote.add-line.enterprise-30',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds({ line: entLine.result.line, quote: entLine.result.quote }),
  }));
  const storageLine = await quotes.action(quoteId, 'add-line', { offerId: storage.id, quantity: 250 });
  record(observation({
    id: 'quote.add-line.storage-graduated-250',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds(storageLine.result.line),
  }));
  const supportLine = await quotes.action(quoteId, 'add-line', { offerId: support.id, quantity: 1, discountBps: 500 });
  record(observation({
    id: 'quote.add-line.support-discounted',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds(supportLine.result.line),
  }));
  await quotes.action(quoteId, 'add-line', { offerId: setup.id, quantity: 400 });

  // A scratch line, then its removal: history preserved, totals recalculated.
  const scratch = await quotes.action(quoteId, 'add-line', { offerId: apiAddon.id, quantity: 10 });
  const removed = await quotes.action(quoteId, 'remove-line', { lineId: scratch.result.line.id });
  record(observation({
    id: 'quote.remove-line-recalculates',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds({
      quote: removed.result.quote,
      removedRowStillStored: svc(app, 'quote-line').listWhere({ quoteId, removed: true }).length,
    }),
  }));

  record(observation({
    id: 'quote.refusals.not-eligible-and-cross-book',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      metered: await refusal(quotes.action(quoteId, 'add-line', { offerId: metered.id, quantity: 1 })),
      crossBook: await refusal(quotes.action(quoteId, 'add-line', { offerId: usdOffer.id, quantity: 1 })),
      staleRevision: await refusal(quotes.action(quoteId, 'add-line', { offerId: setup.id, quantity: 1, expectedRevision: 1 })),
    },
  }));

  const quoteRecord = await quotes.get(quoteId);
  record(observation({
    id: 'quote.grouped-totals',
    category: 'quote',
    classification: 'contractual',
    surface: 'storage',
    observed: (() => {
      const totals = JSON.parse(quoteRecord.totalsJson);
      return {
        oneTimeTotal: totals.oneTimeTotal,
        recurringTotals: totals.recurringTotals,
        recurringGroupCount: quoteRecord.recurringGroupCount,
        oneTimeNetCents: quoteRecord.oneTimeNetCents,
        hasGrandTotal: Object.hasOwn(totals, 'grandTotal'),
      };
    })(),
  }));

  const submitted = await quotes.action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 });
  record(observation({
    id: 'quote.submit.auto-approve',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds({ version: submitted.result.version, approvalId: submitted.result.approvalId, quote: submitted.result.quote }),
  }));
  record(observation({
    id: 'quote.approved-is-terminal',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      addLine: await refusal(quotes.action(quoteId, 'add-line', { offerId: setup.id, quantity: 1 })),
      resubmit: await refusal(quotes.action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 })),
    },
  }));

  // -------------------------------------------------------------------------
  // versions — the immutable evidence a submission writes
  // -------------------------------------------------------------------------
  const versionId = submitted.result.version.id;
  record(observation({
    id: 'versions.version-record',
    category: 'versions',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(svc(app, 'quote-version').listWhere({ quoteId })),
  }));
  record(observation({
    id: 'versions.version-lines',
    category: 'versions',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(svc(app, 'quote-version-line').listWhere({ versionId }).sort((a, b) => a.position - b.position)),
  }));
  const versionComponents = svc(app, 'quote-version-component').listWhere({ versionId })
    .sort((a, b) => (a.componentKey < b.componentKey ? -1 : a.componentKey > b.componentKey ? 1 : (a.id < b.id ? -1 : 1)));
  record(observation({
    id: 'versions.version-components',
    category: 'versions',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(versionComponents),
  }));
  record(observation({
    id: 'versions.version-totals',
    category: 'versions',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(svc(app, 'quote-version-total').listWhere({ versionId })
      .sort((a, b) => (`${a.kind}|${a.interval}` < `${b.kind}|${b.interval}` ? -1 : 1))),
  }));

  // -------------------------------------------------------------------------
  // approval — the human boundary and one-decision algebra
  // -------------------------------------------------------------------------
  const oppB = await seedOpportunity(app, 'Approval band');
  const quoteB = (await client.request(`/api/modules/opportunity/records/${oppB.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await quotes.action(quoteB, 'add-line', { offerId: enterprise.id, quantity: 10, discountBps: 2000 });
  const pending = await quotes.action(quoteB, 'submit', { policy: 'standard-sales-discount', version: 1 });
  record(observation({
    id: 'approval.approval-required-version',
    category: 'approval',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds({ version: pending.result.version, quoteStatus: pending.result.quote.status }),
  }));
  record(observation({
    id: 'approval.approval-record',
    category: 'approval',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(svc(app, 'quote-approval').listWhere({ quoteId: quoteB })),
  }));
  record(observation({
    id: 'approval.agent-actor-refused',
    category: 'approval',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(agentClient.module('quote').action(quoteB, 'approve', {})),
  }));
  const decided = await quotes.action(quoteB, 'approve', { reason: 'Within delegated authority' });
  record(observation({
    id: 'approval.approve-decision',
    category: 'approval',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds(decided.result),
  }));
  record(observation({
    id: 'approval.already-decided',
    category: 'approval',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(quotes.action(quoteB, 'reject', { reason: 'Too late' })),
  }));
  record(observation({
    id: 'approval.decided-record',
    category: 'approval',
    classification: 'contractual',
    surface: 'storage',
    observed: stableAll(svc(app, 'quote-approval').listWhere({ quoteId: quoteB })),
  }));

  // Reject → revise → version 2 under policy v2, distinct fingerprints.
  const oppC = await seedOpportunity(app, 'Rejected then revised');
  const quoteC = (await client.request(`/api/modules/opportunity/records/${oppC.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await quotes.action(quoteC, 'add-line', { offerId: enterprise.id, quantity: 10, discountBps: 6000 });
  const rejected = await quotes.action(quoteC, 'submit', { policy: 'standard-sales-discount', version: 1 });
  record(observation({
    id: 'approval.policy-reject',
    category: 'approval',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds({ version: rejected.result.version, quoteStatus: rejected.result.quote.status, approvalId: rejected.result.approvalId }),
  }));
  const revised = await quotes.action(quoteC, 'revise', {});
  record(observation({
    id: 'quote.revise-reopens-draft',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds(revised.result.quote),
  }));
  const cLines = svc(app, 'quote-line').listWhere({ quoteId: quoteC, removed: false });
  const updatedLine = await quotes.action(quoteC, 'update-line', { lineId: cLines[0].id, discountBps: 300 });
  record(observation({
    id: 'quote.update-line-reprices',
    category: 'quote',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds(updatedLine.result.line),
  }));
  const second = await quotes.action(quoteC, 'submit', { policy: 'standard-sales-discount', version: 2 });
  record(observation({
    id: 'approval.version-2-under-policy-v2',
    category: 'approval',
    classification: 'contractual',
    surface: 'sdk',
    observed: normalizeIds({
      version: second.result.version,
      quoteStatus: second.result.quote.status,
      distinctFingerprintFromV1: second.result.version.policyFingerprint !== rejected.result.version.policyFingerprint,
    }),
  }));
  record(observation({
    id: 'approval.historical-version-keeps-decision',
    category: 'approval',
    classification: 'contractual',
    surface: 'storage',
    observed: (() => {
      const v1 = svc(app, 'quote-version').listWhere({ quoteId: quoteC, versionNumber: 1 })[0];
      return { policyDecision: v1.policyDecision, policyVersion: v1.policyVersion, decisionReason: v1.decisionReason };
    })(),
  }));

  // -------------------------------------------------------------------------
  // catalog v2 — new immutable revisions; frozen evidence; pinned re-pricing
  // -------------------------------------------------------------------------
  // A draft opened BEFORE the catalog moves, to prove pinned re-pricing after.
  const oppD = await seedOpportunity(app, 'Pinned before catalog change');
  const quoteD = (await client.request(`/api/modules/opportunity/records/${oppD.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  const dLine = await quotes.action(quoteD, 'add-line', { offerId: enterprise.id, quantity: 30 });

  const frozenBefore = svc(app, 'quote-version-component').listWhere({ versionId })
    .sort((a, b) => (a.componentKey < b.componentKey ? -1 : 1))
    .map((component) => ({ componentKey: component.componentKey, listAmountCents: component.listAmountCents, tiersJson: component.tiersJson }));
  const sync3 = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog', input: { variant: 'v2' } } });
  record(observation({
    id: 'catalog.v2.revision-counts',
    category: 'catalog',
    classification: 'contractual',
    surface: 'http',
    observed: { counts: sync3.counts },
  }));
  const freshEnterprise = offerOf(app, 'fixture:offer:enterprise');
  record(observation({
    id: 'catalog.v2.new-offer-revision',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      newRevision: freshEnterprise.revision,
      oldRevisionActive: svc(app, 'offer').get(enterprise.id).active,
      newTiers: svc(app, 'price-component').listWhere({ offerId: freshEnterprise.id })
        .filter((component) => component.pricingModel === 'volume')
        .flatMap((component) => svc(app, 'price-tier').listWhere({ componentId: component.id })
          .sort((a, b) => a.position - b.position)
          .map((tier) => [tier.upToQuantity, tier.unitAmountCents])),
    },
  }));
  const frozenAfter = svc(app, 'quote-version-component').listWhere({ versionId })
    .sort((a, b) => (a.componentKey < b.componentKey ? -1 : 1))
    .map((component) => ({ componentKey: component.componentKey, listAmountCents: component.listAmountCents, tiersJson: component.tiersJson }));
  record(observation({
    id: 'versions.frozen-across-catalog-change',
    category: 'versions',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      byteIdentical: JSON.stringify(frozenBefore) === JSON.stringify(frozenAfter),
      componentAmounts: frozenAfter.map((component) => [component.componentKey, component.listAmountCents]),
    },
  }));
  record(observation({
    id: 'versions.superseded-revision-refused-on-new-drafts',
    category: 'versions',
    classification: 'contractual',
    surface: 'sdk',
    observed: await refusal(quotes.action(quoteD, 'add-line', { offerId: enterprise.id, quantity: 1 })),
  }));
  const repriced = await quotes.action(quoteD, 'update-line', { lineId: dLine.result.line.id, quantity: 40 });
  record(observation({
    id: 'versions.draft-repriced-from-pinned-revision',
    category: 'versions',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      volumeComponent: repriced.result.line.components
        .filter((component) => component.pricingModel === 'volume')
        .map((component) => ({ quantity: component.quantity, listAmountCents: component.listAmountCents })),
    },
    note: 'After the v2 catalog, an existing draft line still prices from its pinned v1 offer revision: 40 seats at the v1 tier, never the v2 price.',
  }));
  const newDraftLine = await quotes.action(quoteD, 'add-line', { offerId: freshEnterprise.id, quantity: 30 });
  record(observation({
    id: 'catalog.v2.new-draft-prices-at-new-revision',
    category: 'catalog',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      volumeComponent: newDraftLine.result.line.components
        .filter((component) => component.pricingModel === 'volume')
        .map((component) => ({ quantity: component.quantity, listAmountCents: component.listAmountCents })),
    },
  }));

  // -------------------------------------------------------------------------
  // catalog — provider failure semantics, no partial state
  // -------------------------------------------------------------------------
  const offerCountBeforeFailures = svc(app, 'offer').countWhere({});
  const failures = {};
  for (const variant of ['fail', 'slow', 'invalid', 'bad-tiers']) {
    failures[variant] = await refusal(client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog', input: { variant } } }));
  }
  failures.oversized = await refusal(client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'la0-aux-catalog', input: { variant: 'oversized' } } }));
  record(observation({
    id: 'catalog.provider-failures',
    category: 'catalog',
    classification: 'contractual',
    surface: 'http',
    observed: failures,
  }));
  record(observation({
    id: 'catalog.provider-failures-leave-no-partial-state',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      offerCountUnchanged: svc(app, 'offer').countWhere({}) === offerCountBeforeFailures,
      failedTraces: app.database.raw
        .prepare("SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_name = 'catalog.sync' AND status = 'failed'").get().n,
    },
  }));
  record(observation({
    id: 'catalog.unknown-provider-refused',
    category: 'catalog',
    classification: 'contractual',
    surface: 'http',
    observed: {
      unknown: await refusal(client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'never-registered' } })),
      missingProvider: await refusal(client.request('/api/catalog/sync', { method: 'POST', body: {} })),
    },
  }));

  // Declared deactivateMissing: honoured only under the provider's own config.
  const genFirst = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'la0-deactivating-catalog', input: { generation: 'first' } } });
  const genSecond = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'la0-deactivating-catalog', input: { generation: 'second' } } });
  record(observation({
    id: 'catalog.deactivate-missing-honoured',
    category: 'catalog',
    classification: 'contractual',
    surface: 'http',
    observed: {
      firstCounts: genFirst.counts,
      secondCounts: genSecond.counts,
      gonerActive: svc(app, 'product').listWhere({ sourceKey: 'la0:product:goner' })[0]?.active ?? null,
      keeperActive: svc(app, 'product').listWhere({ sourceKey: 'la0:product:keeper' })[0]?.active ?? null,
    },
  }));
  record(observation({
    id: 'catalog.missing-not-deactivated-without-declared-config',
    category: 'catalog',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      // fixture-saas-catalog declares deactivateMissing: false; failed and v2
      // syncs above never deactivated its products.
      activeFixtureProducts: svc(app, 'product').countWhere({ provider: 'fixture-saas-catalog', sourceKind: 'provider', active: true }),
    },
  }));

  // -------------------------------------------------------------------------
  // hostile input
  // -------------------------------------------------------------------------
  const hostileIds = {};
  for (const hostile of ['__proto__', 'constructor', 'prototype', 'toString', '<script>alert(1)</script>']) {
    hostileIds[hostile] = {
      offerId: await refusal(quotes.action(quoteD, 'add-line', { offerId: hostile, quantity: 1 })),
      provider: await refusal(client.request('/api/catalog/sync', { method: 'POST', body: { provider: hostile } })),
    };
  }
  record(observation({
    id: 'hostile-input.prototype-shaped-identifiers',
    category: 'hostile-input',
    classification: 'contractual',
    surface: 'http',
    observed: { ...hostileIds, polluted: {}.polluted !== undefined },
  }));

  const forged = await client.request(`/api/modules/quote/records/${quoteD}/actions/add-line`, {
    method: 'POST',
    body: { offerId: freshEnterprise.id, quantity: 2, listAmountCents: 1, netAmountCents: 1, unitAmountCents: 1, totalCents: 1, breakdownJson: '[]' },
  });
  record(observation({
    id: 'hostile-input.forged-amounts-ignored',
    category: 'hostile-input',
    classification: 'contractual',
    surface: 'http',
    observed: {
      listAmountCents: forged.result.line.listAmountCents,
      netAmountCents: forged.result.line.netAmountCents,
    },
    note: 'The server prices from the pinned catalog; client-supplied amounts never survive.',
  }));

  const malformed = {};
  for (const [label, input] of [
    ['quantity-zero', { offerId: freshEnterprise.id, quantity: 0 }],
    ['quantity-negative', { offerId: freshEnterprise.id, quantity: -5 }],
    ['quantity-fractional', { offerId: freshEnterprise.id, quantity: 1.5 }],
    ['quantity-string', { offerId: freshEnterprise.id, quantity: '10' }],
    ['quantity-over-bound', { offerId: freshEnterprise.id, quantity: 1_000_001 }],
    ['discount-over-10000', { offerId: freshEnterprise.id, quantity: 1, discountBps: 10001 }],
    ['discount-negative', { offerId: freshEnterprise.id, quantity: 1, discountBps: -1 }],
    ['offer-id-oversized', { offerId: 'x'.repeat(10_001), quantity: 1 }],
  ]) {
    malformed[label] = await refusal(client.request(`/api/modules/quote/records/${quoteD}/actions/add-line`, { method: 'POST', body: input }));
  }
  malformed['non-object-body'] = await refusal(client.request(`/api/modules/quote/records/${quoteD}/actions/add-line`, { method: 'POST', body: [1, 2] }));
  record(observation({
    id: 'hostile-input.malformed-quote-inputs',
    category: 'hostile-input',
    classification: 'contractual',
    surface: 'http',
    observed: malformed,
  }));
  record(observation({
    id: 'hostile-input.errors-do-not-leak',
    category: 'hostile-input',
    classification: 'contractual',
    surface: 'http',
    observed: await client.module('quote').action(quoteD, 'add-line', { offerId: 'missing-offer', quantity: 1 }).then(
      () => ({ refused: false, leaky: null }),
      (error) => ({ refused: true, leaky: /SELECT |INSERT |\/home\/|at Object|node:internal/.test(String(error.message)) }),
    ),
  }));

  // A hostile provider payload: bounded fields refuse; accepted text is stored
  // verbatim. Storing verbatim is the recorded decision for the provider trust
  // boundary (EXTRACTION_PREPARATION: display safety is the renderer's job).
  const hostileSync = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'la0-aux-catalog', input: { variant: 'hostile' } } });
  const hostileProduct = svc(app, 'product').listWhere({ sourceKey: 'la0:product:hostile' })[0];
  const hostileVersion = hostileProduct ? svc(app, 'product-version').listWhere({ productId: hostileProduct.id })[0] : null;
  record(observation({
    id: 'hostile-input.provider-payload-stored-verbatim',
    category: 'hostile-input',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      counts: hostileSync.counts,
      name: hostileVersion?.name ?? null,
      descriptionLength: (hostileVersion?.description ?? '').length,
      polluted: {}.polluted !== undefined,
    },
    note: 'Markup, template syntax and control characters inside bounded provider text are stored verbatim by recorded decision; oversized fields were refused in catalog.provider-failures.',
  }));

  // -------------------------------------------------------------------------
  // concurrency — invariants, never the winner
  // -------------------------------------------------------------------------
  const oppE = await seedOpportunity(app, 'Submit race');
  const quoteE = (await client.request(`/api/modules/opportunity/records/${oppE.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await quotes.action(quoteE, 'add-line', { offerId: freshEnterprise.id, quantity: 5 });
  const submitRace = await Promise.allSettled([
    quotes.action(quoteE, 'submit', { policy: 'standard-sales-discount', version: 1 }),
    quotes.action(quoteE, 'submit', { policy: 'standard-sales-discount', version: 1 }),
  ]);
  record(observation({
    id: 'concurrency.submit-race-one-version',
    category: 'concurrency',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      fulfilled: submitRace.filter((entry) => entry.status === 'fulfilled').length,
      conflicts: submitRace.filter((entry) => entry.status === 'rejected' && entry.reason.status === 409).length,
      versions: svc(app, 'quote-version').countWhere({ quoteId: quoteE }),
    },
  }));

  // Two concurrent approvals of one pending version: exactly one decision.
  // Racing approve against reject would leave WHICH action completed to the
  // scheduler, and the trace counts below would inherit that noise — racing
  // the same action keeps every downstream count deterministic while proving
  // the same one-decision algebra.
  const oppF = await seedOpportunity(app, 'Decide race');
  const quoteF = (await client.request(`/api/modules/opportunity/records/${oppF.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await quotes.action(quoteF, 'add-line', { offerId: freshEnterprise.id, quantity: 5, discountBps: 2000 });
  await quotes.action(quoteF, 'submit', { policy: 'standard-sales-discount', version: 1 });
  const decideRace = await Promise.allSettled([
    quotes.action(quoteF, 'approve', {}),
    quotes.action(quoteF, 'approve', {}),
  ]);
  record(observation({
    id: 'concurrency.decide-race-one-decision',
    category: 'concurrency',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      fulfilled: decideRace.filter((entry) => entry.status === 'fulfilled').length,
      conflicts: decideRace.filter((entry) => entry.status === 'rejected' && entry.reason.status === 409).length,
      approvalMatchesQuote: (() => {
        const quote = svc(app, 'quote').get(quoteF);
        return svc(app, 'quote-approval').get(quote.currentApprovalId).status === quote.status;
      })(),
    },
  }));

  // -------------------------------------------------------------------------
  // fault injection — a failure mid-version rolls everything back
  // -------------------------------------------------------------------------
  const userActor = { type: 'user', id: 'la0-commercial' };
  const oppH = await seedOpportunity(app, 'Fault injection');
  const quoteH = (await client.request(`/api/modules/opportunity/records/${oppH.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  await quotes.action(quoteH, 'add-line', { offerId: freshEnterprise.id, quantity: 4, discountBps: 2000 });
  const beforeFault = svc(app, 'quote').get(quoteH);
  const componentService = svc(app, 'quote-version-component');
  const realCreate = componentService.createManaged.bind(componentService);
  componentService.createManaged = async () => { throw new Error('injected component failure'); };
  let faultOutcome;
  try {
    faultOutcome = await refusal(app.runAction({ module: 'quote', action: 'submit', recordId: quoteH, input: { policy: 'standard-sales-discount', version: 1 }, actor: userActor }));
  } finally {
    componentService.createManaged = realCreate;
  }
  const afterFault = svc(app, 'quote').get(quoteH);
  record(observation({
    id: 'concurrency.fault-injection-rolls-back',
    category: 'concurrency',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      submitFailed: faultOutcome.refused,
      statusUnchanged: afterFault.status === beforeFault.status && afterFault.status === 'draft',
      draftRevisionUnchanged: afterFault.draftRevision === beforeFault.draftRevision,
      versions: svc(app, 'quote-version').countWhere({ quoteId: quoteH }),
      approvals: svc(app, 'quote-approval').countWhere({ quoteId: quoteH }),
    },
  }));

  // -------------------------------------------------------------------------
  // audit, events, trace — exact counts at the end of a deterministic journey
  // -------------------------------------------------------------------------
  record(observation({
    id: 'audit.action-vocabulary',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'audit',
    observed: Object.keys(auditCounts(app)).sort(),
  }));
  record(observation({
    id: 'audit.counts-by-action',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'audit',
    observed: auditCounts(app),
  }));
  record(observation({
    id: 'events.counts-by-type',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'events',
    observed: eventCounts,
  }));
  record(observation({
    id: 'trace.counts-by-workflow-and-status',
    category: 'audit-events-trace',
    classification: 'contractual',
    surface: 'trace',
    observed: traceCounts(app),
  }));
  record(observation({
    id: 'trace.run-order',
    category: 'audit-events-trace',
    classification: 'incidental',
    surface: 'trace',
    observed: app.database.raw.prepare('SELECT workflow_name FROM workflow_runs ORDER BY rowid LIMIT 40').all().map((row) => row.workflow_name),
    note: 'Nothing declares an ordering for the trace listing; recorded, never asserted.',
  }));

  // -------------------------------------------------------------------------
  // two real connections — after the exact counts, because the winner of a
  // cross-connection race is scheduling, and every count above must stay
  // deterministic. The observation freezes invariants only.
  // -------------------------------------------------------------------------
  const oppG = await seedOpportunity(app, 'Two connections');
  const quoteG = (await client.request(`/api/modules/opportunity/records/${oppG.id}/actions/create-quote`, { method: 'POST', body: { priceBookId: book.id } })).result.quote.id;
  const secondInstance = await boot(root, `${root}/data/la0-commercial.sqlite`, { busyTimeoutMs: 400 });
  const edits = await Promise.allSettled([
    app.runAction({ module: 'quote', action: 'add-line', recordId: quoteG, input: { offerId: freshEnterprise.id, quantity: 2 }, actor: userActor }),
    secondInstance.app.runAction({ module: 'quote', action: 'add-line', recordId: quoteG, input: { offerId: freshEnterprise.id, quantity: 3 }, actor: userActor }),
  ]);
  await secondInstance.close();
  const survivingLines = svc(app, 'quote-line').listWhere({ quoteId: quoteG, removed: false });
  const totalsG = JSON.parse(svc(app, 'quote').get(quoteG).totalsJson);
  const expectedMonthly = survivingLines.reduce((sum, line) => {
    const breakdown = JSON.parse(line.breakdownJson);
    return sum + breakdown.components.filter((component) => component.interval === 'month')
      .reduce((inner, component) => inner + component.netAmountCents, 0);
  }, 0);
  record(observation({
    id: 'concurrency.two-connection-edit-invariants',
    category: 'concurrency',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      everyOutcomeFulfilledOr409: edits.every((entry) => entry.status === 'fulfilled' || entry.reason?.status === 409),
      rawSqliteErrorSurfaced: edits.some((entry) => entry.status === 'rejected' && /SQLITE_BUSY/.test(String(entry.reason?.message))),
      totalsMatchSurvivingLines:
        (totalsG.recurringTotals.find((group) => group.interval === 'month') ?? { netAmountCents: 0 }).netAmountCents === expectedMonthly,
    },
  }));

  // -------------------------------------------------------------------------
  // app inspect — the composition as AX1 reports it today
  // -------------------------------------------------------------------------
  const inspect = cli(root, ['app', 'inspect', '--json']);
  let inspectReport = null;
  try { inspectReport = JSON.parse(inspect.stdout); } catch { inspectReport = null; }
  record(observation({
    id: 'architecture.app-inspect-valid',
    category: 'architecture',
    classification: 'contractual',
    surface: 'app-inspect',
    observed: { exitCode: inspect.status, valid: inspectReport?.valid ?? null, problems: (inspectReport?.problems ?? []).length },
  }));
  record(observation({
    id: 'architecture.app-inspect-commercial-shape',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'app-inspect',
    observed: {
      packages: (inspectReport?.packages ?? []).map((entry) => entry.name).sort(),
      commercialProviders: (inspectReport?.providers ?? [])
        .filter((entry) => entry.registry === 'commercial')
        .map((entry) => `${entry.kind}:${entry.name}@${entry.version}`).sort(),
    },
    note: 'Today Commercial appears through the fixed composition slot and the providers listing. After extraction it appears as a discovered package; this shape is the thing the extraction changes.',
  }));

  return { root, instance };
}

/**
 * Restart: the same answers from the same database in a new process-level
 * application — a domain that only reproduces its prices while its process is
 * warm has not preserved them.
 */
export async function runRestartCases(t, record) {
  const root = characterizationProject(t, { name: 'accordo-la0-commercial-restart-' });
  const dbPath = `${root}/data/la0-restart.sqlite`;

  let instance = await boot(root, dbPath);
  t.after(() => instance.close().catch(() => {}));
  await instance.client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  const book = svc(instance.app, 'price-book').listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const enterprise = offerOf(instance.app, 'fixture:offer:enterprise');
  const opportunity = await seedOpportunity(instance.app, 'Restart journey');
  const quoteId = (await instance.client.request(
    `/api/modules/opportunity/records/${opportunity.id}/actions/create-quote`,
    { method: 'POST', body: { priceBookId: book.id } },
  )).result.quote.id;
  await instance.client.module('quote').action(quoteId, 'add-line', { offerId: enterprise.id, quantity: 30 });
  const before = await instance.client.module('quote').action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 });

  await instance.close();
  instance = await boot(root, dbPath);

  const persisted = await instance.client.module('quote').get(quoteId);
  record(observation({
    id: 'storage-restart.quote-identical',
    category: 'storage-restart',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      status: persisted.status,
      totals: JSON.parse(persisted.totalsJson),
      currentVersionNumber: persisted.currentVersionNumber,
    },
  }));
  record(observation({
    id: 'storage-restart.version-evidence-counts',
    category: 'storage-restart',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      versions: svc(instance.app, 'quote-version').countWhere({ quoteId }),
      lines: svc(instance.app, 'quote-version-line').countWhere({ versionId: before.result.version.id }),
      components: svc(instance.app, 'quote-version-component').countWhere({ versionId: before.result.version.id }),
      totals: svc(instance.app, 'quote-version-total').countWhere({ versionId: before.result.version.id }),
    },
  }));
  record(observation({
    id: 'storage-restart.reboot-passes-fingerprint-drift-check',
    category: 'storage-restart',
    classification: 'contractual',
    surface: 'storage',
    observed: { rebooted: true },
    note: 'Booting a second application over the same database re-verifies every persisted provider and policy fingerprint; a reboot that survives is the drift check passing.',
  }));

  // A fresh identical quote after restart reproduces the same amounts.
  const opportunity2 = await seedOpportunity(instance.app, 'Restart reproduction');
  const quote2 = (await instance.client.request(
    `/api/modules/opportunity/records/${opportunity2.id}/actions/create-quote`,
    { method: 'POST', body: { priceBookId: book.id } },
  )).result.quote.id;
  await instance.client.module('quote').action(quote2, 'add-line', { offerId: enterprise.id, quantity: 30 });
  const again = await instance.client.module('quote').action(quote2, 'submit', { policy: 'standard-sales-discount', version: 1 });
  record(observation({
    id: 'storage-restart.resubmit-reproduces',
    category: 'storage-restart',
    classification: 'contractual',
    surface: 'sdk',
    observed: {
      sameDecision: again.result.version.decision === before.result.version.decision,
      sameTotals: JSON.stringify(again.result.version.totals) === JSON.stringify(before.result.version.totals),
      samePolicyFingerprint: again.result.version.policyFingerprint === before.result.version.policyFingerprint,
    },
  }));
}

/**
 * Scale: a 520-product catalog, synced and read back exactly. Correctness
 * reads must never depend on a page bound, and 520 is past every one of them.
 */
export async function runScaleCases(t, record) {
  const root = characterizationProject(t, { name: 'accordo-la0-commercial-scale-' });
  const instance = await boot(root, `${root}/data/la0-scale.sqlite`);
  t.after(() => instance.close().catch(() => {}));
  const { app, client } = instance;

  const sync = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'la0-aux-catalog', input: { variant: 'big' } } });
  record(observation({
    id: 'scale.big-catalog-sync-counts',
    category: 'scale',
    classification: 'contractual',
    surface: 'http',
    observed: { counts: sync.counts },
  }));
  const productService = svc(app, 'product');
  record(observation({
    id: 'scale.exact-reads-beyond-page-bounds',
    category: 'scale',
    classification: 'contractual',
    surface: 'storage',
    observed: {
      countWhere: productService.countWhere({ provider: 'la0-aux-catalog', sourceKind: 'provider', active: true }),
      listWhere: productService.listWhere({ provider: 'la0-aux-catalog' }).length,
      pagedListCapped: (await client.module('product').list({ limit: 500 })).items.length,
    },
    note: 'countWhere/listWhere are the complete query; the paged list() caps at 500 by design and is a display bound, not a correctness read.',
  }));
  const sample = productService.listWhere({ sourceKey: 'la0:product:bulk-517' })[0] ?? null;
  record(observation({
    id: 'scale.row-517-exact',
    category: 'scale',
    classification: 'contractual',
    surface: 'storage',
    observed: sample ? stable(sample) : null,
  }));
  // Re-sync of the big catalog: still zero rewrites at scale.
  const resync = await client.request('/api/catalog/sync', { method: 'POST', body: { provider: 'la0-aux-catalog', input: { variant: 'big' } } });
  record(observation({
    id: 'scale.big-catalog-resync-idempotent',
    category: 'scale',
    classification: 'contractual',
    surface: 'http',
    observed: { counts: resync.counts },
  }));
}
