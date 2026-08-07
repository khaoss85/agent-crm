// @ts-check

/**
 * Reproducible install + verification for the B2B Lead Qualification starter.
 *
 * It builds a clean throwaway project from the current repo, applies the Lead
 * and Task modules through the real module factory, registers the qualify and
 * disqualify actions, then drives the full capture → qualify | disqualify flow
 * in-process and asserts the guarantees the milestone promises:
 *
 *   - capture creates a lead in status `new`;
 *   - qualify (atomic) flips status to qualified and opens exactly one task;
 *   - a repeated qualify is a 409 with no second task / audit / event;
 *   - disqualify requires a reason and creates no task;
 *   - status can never be set to `qualified` through generic CRUD.
 *
 * Run it from anywhere:  node examples/starters/b2b-lead-qualification/install.mjs
 * Exit code 0 means every guarantee held. Nothing is written to your own DB.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const starterDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(starterDir, '..', '..', '..');

const root = mkdtempSync(join(tmpdir(), 'agent-crm-lead-starter-'));
try {
  // 1. Clean project copy — source only, never data or node_modules.
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }

  // 2. Apply the Lead module, then the Task module (Task references leads, so
  //    order matters: the factory refuses a reference to a not-yet-applied
  //    target).
  const starterInProject = join(root, 'examples', 'starters', 'b2b-lead-qualification');
  applyModule(root, join(starterInProject, 'lead.module.json'));
  applyModule(root, join(starterInProject, 'task.module.json'));
  // Lead Intelligence record modules (Milestone 9): every field is managed, so
  // the records are immutable through public CRUD and writable only by actions.
  for (const manifest of [
    'enrichment-snapshot.module.json',
    'behavioral-signal.module.json',
    'score-run.module.json',
    'score-contribution.module.json',
    'routing-run.module.json',
    'route-evaluation.module.json',
    'assignment.module.json',
    // Commercial Operations record modules (Milestone 10): all read-only
    // publicly — records exist only through catalog sync and quote actions.
    'product.module.json',
    'product-version.module.json',
    'price-book.module.json',
    'offer.module.json',
    'price-component.module.json',
    'price-tier.module.json',
    'catalog-sync-run.module.json',
    'quote.module.json',
    'quote-line.module.json',
    'quote-version.module.json',
    'quote-version-line.module.json',
    'quote-version-component.module.json',
    'quote-version-total.module.json',
    'quote-approval.module.json',
    // Signature and Order record modules (Milestone 11): immutable evidence,
    // written only by the signature operations through the trusted managed
    // path — never by public CRUD.
    'signature-envelope.module.json',
    'signature-signer.module.json',
    'signature-event.module.json',
    'signed-artifact.module.json',
    'order.module.json',
    'order-line.module.json',
    'order-component.module.json',
    'order-tier.module.json',
    'order-total.module.json',
  ]) {
    applyModule(root, join(starterInProject, manifest));
  }
  // Milestone 12 records live in the OPTIONAL contracts domain package, not in
  // the starter: a project that does not register the package never applies
  // these manifests and keeps every earlier milestone working.
  for (const manifest of [
    'contract-activation.module.json',
    'commercial-contract.module.json',
    'contract-version.module.json',
    'contract-line.module.json',
    'subscription.module.json',
    'subscription-line.module.json',
    'delivery-obligation.module.json',
    'service-obligation.module.json',
  ]) {
    applyModule(root, join(root, 'packages', 'contracts', 'modules', manifest));
  }
  // Milestone 13 records live in the OPTIONAL delivery domain package, which
  // depends on the contracts package through a declared capability.
  for (const manifest of [
    'delivery-handover-run.module.json',
    'delivery-project.module.json',
    'delivery-work-package.module.json',
    'delivery-milestone.module.json',
    'delivery-partner-engagement.module.json',
    // Milestone 14b1: the immutable economics evidence.
    'delivery-time-entry.module.json',
    'delivery-expense-entry.module.json',
    'delivery-economic-plan.module.json',
    'delivery-economic-plan-line.module.json',
    'delivery-economic-snapshot.module.json',
    // M14b2: change, deliverables and acceptance evidence.
    'delivery-change-request.module.json',
    'delivery-plan-revision.module.json',
    'delivery-commercial-change.module.json',
    'delivery-deliverable.module.json',
    'delivery-acceptance-request.module.json',
    'delivery-acceptance-evidence.module.json',
  ]) {
    applyModule(root, join(root, 'packages', 'delivery', 'modules', manifest));
  }
  // …and one CUSTOMER-AUTHORED package, to prove the authoring path works
  // without a kernel change (docs/PACKAGE_AUTHORING.md).
  applyModule(root, join(root, 'examples', 'custom-packages', 'partner-scorecard', 'modules', 'partner-scorecard.module.json'));

  // 3. Register the code-first actions by pointing the action registry at the
  //    starter's checked-in definitions.
  writeFileSync(
    join(root, 'packages', 'actions', 'generated', 'index.js'),
    [
      '// @ts-check',
      "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
      "import { disqualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/disqualify.js';",
      "import { convertLead } from '../../../examples/starters/b2b-lead-qualification/actions/convert.js';",
      "import { buildMoveStageAction } from '../../core/src/pipeline-actions.js';",
      'import {',
      '  buildEnrichAction,',
      '  buildRecordSignalAction,',
      '  buildScoreAction,',
      '  buildRouteAction,',
      "} from '../../core/src/intelligence-actions.js';",
      "import { buildCommercialActions } from '../../core/src/commercial-actions.js';",
      "import { buildRequestSignatureAction } from '../../core/src/signature-operations.js';",
      '',
      'export const generatedActions = [',
      '  qualifyLead,',
      '  disqualifyLead,',
      '  convertLead,',
      "  buildMoveStageAction({ module: 'opportunity' }),",
      '  buildEnrichAction(),',
      '  buildRecordSignalAction(),',
      '  buildScoreAction(),',
      '  buildRouteAction(),',
      '  ...buildCommercialActions(),',
      '  buildRequestSignatureAction(),',
      '];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'commercial', 'generated', 'index.js'),
    [
      '// @ts-check',
      'import {',
      '  fixtureSaasCatalogProvider,',
      '  standardSalesDiscountV1,',
      '  standardSalesDiscountV2,',
      "} from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
      '',
      'export const generatedCatalogProviders = [fixtureSaasCatalogProvider];',
      'export const generatedDiscountPolicies = [standardSalesDiscountV1, standardSalesDiscountV2];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'domains', 'generated', 'index.js'),
    [
      '// @ts-check',
      "import { createContractsDomain } from '../../contracts/src/index.js';",
      "import { createDeliveryPackage } from '../../delivery/src/index.js';",
      "import { createPartnerScorecardPackage } from '../../../examples/custom-packages/partner-scorecard/src/index.js';",
      "import { b2bSaasOrderActivationV1, b2bSaasOrderActivationV2 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';",
      "import { b2bDeliveryHandoverV1 } from '../../../examples/starters/b2b-lead-qualification/delivery.js';",
      "import { b2bDeliveryCostV1 } from '../../../examples/starters/b2b-lead-qualification/delivery-cost.js';",
      '',
      '// The composition file is the ONLY place a project names its packages.',
      '// Deleting a line removes that package; nothing in the kernel changes.',
      'export const generatedDomains = [',
      '  createContractsDomain({ policies: [b2bSaasOrderActivationV1, b2bSaasOrderActivationV2] }),',
      '  createDeliveryPackage({ policies: [b2bDeliveryHandoverV1], costPolicies: [b2bDeliveryCostV1] }),',
      '  createPartnerScorecardPackage(),',
      '];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'signature', 'generated', 'index.js'),
    [
      '// @ts-check',
      "import { fixtureSignatureProvider } from '../../../examples/starters/b2b-lead-qualification/signature.js';",
      '',
      'export const generatedSignatureProviders = [fixtureSignatureProvider];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'intelligence', 'generated', 'index.js'),
    [
      '// @ts-check',
      'import {',
      '  fixtureFirmographicsProvider,',
      '  b2bSaasScoreV1,',
      '  b2bSaasScoreV2,',
      '  b2bRoutingV1,',
      '  b2bRoutingV2,',
      '  routingTargets,',
      "} from '../../../examples/starters/b2b-lead-qualification/intelligence.js';",
      '',
      'export const generatedEnrichmentProviders = [fixtureFirmographicsProvider];',
      'export const generatedScoringModels = [b2bSaasScoreV1, b2bSaasScoreV2];',
      'export const generatedRoutingPolicies = [b2bRoutingV1, b2bRoutingV2];',
      'export const generatedRoutingTargets = routingTargets;',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'packages', 'pipelines', 'generated', 'index.js'),
    [
      '// @ts-check',
      "import { b2bSalesPipeline } from '../../../examples/starters/b2b-lead-qualification/pipeline.js';",
      '',
      'export const generatedPipelines = [b2bSalesPipeline];',
      '',
    ].join('\n'),
  );

  // 4. Boot the app from the throwaway project and drive the flow.
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAgentCrmApp({ dbPath: join(root, 'data', 'starter.sqlite') });
  const actor = { type: 'user', id: 'starter' };
  const leads = app.modules.get('lead').service;
  const tasks = app.modules.get('task').service;

  try {
    // Capture.
    const lead = await leads.create(
      { firstName: 'Dana', lastName: 'Rossi', email: 'dana@acme.example', companyName: 'Acme', source: 'referral' },
      { actor },
    );
    assert.equal(lead.status, 'new', 'a captured lead starts in status new');
    assert.equal(lead.qualifiedAt, null);

    // Qualify (atomic: lead updated + one task created).
    const qualified = await app.runAction({
      module: 'lead',
      action: 'qualify',
      recordId: lead.id,
      input: { dueAt: '2026-08-12T09:00:00Z' },
      actor,
    });
    assert.equal(qualified.result.lead.status, 'qualified');
    const openTasks = tasks.list({ limit: 500 }).filter((task) => task.leadId === lead.id);
    assert.equal(openTasks.length, 1, 'qualify creates exactly one follow-up task');
    assert.equal(openTasks[0].sourceKey, `qualify:${lead.id}`);
    assert.equal(leads.get(lead.id).status, 'qualified');

    // Repeat qualify → 409, and still exactly one task.
    await assert.rejects(
      () => app.runAction({ module: 'lead', action: 'qualify', recordId: lead.id, input: { dueAt: '2026-09-01T09:00:00Z' }, actor }),
      (error) => error.code === 'INVALID_STATE' && error.status === 409,
    );
    assert.equal(tasks.list({ limit: 500 }).filter((task) => task.leadId === lead.id).length, 1);

    // Disqualify a second lead: reason required, no task.
    const lead2 = await leads.create({ firstName: 'Sam', lastName: 'Neri', email: 'sam@beta.example' }, { actor });
    await assert.rejects(
      () => app.runAction({ module: 'lead', action: 'disqualify', recordId: lead2.id, input: {}, actor }),
      (error) => error.status === 400,
    );
    const disqualified = await app.runAction({
      module: 'lead',
      action: 'disqualify',
      recordId: lead2.id,
      input: { reason: 'No budget this year' },
      actor,
    });
    assert.equal(disqualified.result.lead.status, 'disqualified');
    assert.equal(tasks.list({ limit: 500 }).filter((task) => task.leadId === lead2.id).length, 0);

    // CRUD can never reach the qualified state.
    await assert.rejects(() => leads.update(lead2.id, { status: 'qualified' }, { actor }), (error) => error.code === 'VALIDATION_ERROR');
    await assert.rejects(() => leads.create({ firstName: 'X', lastName: 'Y', email: 'x@y.example', status: 'qualified' }, { actor }), (error) => error.code === 'VALIDATION_ERROR');

    // Convert the qualified lead: Company + Contact + one Opportunity, atomically.
    // (Lead 1 has companyName 'Acme' from capture.)
    const converted = await app.runAction({
      module: 'lead',
      action: 'convert',
      recordId: lead.id,
      input: { opportunityName: 'Acme — Enterprise', valueCents: 5_000_000, currency: 'eur' },
      actor,
    });
    assert.equal(converted.result.lead.status, 'converted');
    assert.equal(converted.result.company.reused, false, 'no Acme existed: company created');
    assert.equal(converted.result.contact.reused, false);
    const convertedLead = leads.get(lead.id);
    assert.equal(convertedLead.convertedCompanyId, converted.result.company.id);
    assert.equal(convertedLead.convertedContactId, converted.result.contact.id);
    assert.equal(convertedLead.convertedOpportunityId, converted.result.opportunity.id);
    const opportunity = app.services.opportunities.get(converted.result.opportunity.id);
    assert.equal(opportunity.valueCents, 5_000_000);
    assert.equal(opportunity.currency, 'EUR');
    assert.equal(opportunity.sourceKey, `lead-conversion:${lead.id}`);

    // Repeat conversion → 409; no second opportunity.
    await assert.rejects(
      () => app.runAction({ module: 'lead', action: 'convert', recordId: lead.id, input: { opportunityName: 'Again', valueCents: 1 }, actor }),
      (error) => error.code === 'INVALID_STATE' && error.status === 409,
    );

    // A second lead at the same company (different email) REUSES the company.
    const lead3 = await leads.create(
      { firstName: 'Luca', lastName: 'Bianchi', email: 'luca@acme.example', companyName: '  ACME ', source: 'event' },
      { actor },
    );
    await app.runAction({ module: 'lead', action: 'qualify', recordId: lead3.id, input: { dueAt: '2026-08-20T09:00:00Z' }, actor });
    const converted3 = await app.runAction({
      module: 'lead',
      action: 'convert',
      recordId: lead3.id,
      input: { opportunityName: 'Acme — Expansion', valueCents: 100 },
      actor,
    });
    assert.equal(converted3.result.company.id, converted.result.company.id, 'normalized "  ACME " reuses the Acme company');
    assert.equal(converted3.result.company.reused, true);
    assert.equal(app.services.companies.list().length, 1, 'exactly one Acme');

    // Conversion links are managed: CRUD cannot touch them.
    await assert.rejects(
      () => leads.update(lead3.id, { convertedOpportunityId: 'forged' }, { actor }),
      (error) => error.code === 'VALIDATION_ERROR',
    );

    // Pipeline (Milestone 8): converted opportunities entered Discovery.
    const opp1 = app.services.opportunities.get(converted.result.opportunity.id);
    assert.equal(opp1.pipelineKey, 'b2b-sales');
    assert.equal(opp1.pipelineStage, 'discovery');
    const move = (id, toStage, fromStage, extra = {}) => app.runAction({
      module: 'opportunity', action: 'move-stage', recordId: id,
      input: { toStage, fromStage, ...extra }, actor,
    });
    // Walk opportunity 1 through every open stage to Won.
    await move(opp1.id, 'demo', 'discovery');
    await move(opp1.id, 'proposal', 'demo');
    await move(opp1.id, 'negotiation', 'proposal');
    await move(opp1.id, 'won', 'negotiation');
    const won = app.services.opportunities.get(opp1.id);
    assert.equal(won.pipelineStage, 'won');
    assert.ok(won.closedAt, 'winning closes the opportunity');
    // Terminal stages refuse further moves.
    await assert.rejects(() => move(opp1.id, 'discovery', 'won'), (error) => error.code === 'TERMINAL_STAGE');
    // Opportunity 2 is Lost, with the required reason.
    const opp2 = app.services.opportunities.get(converted3.result.opportunity.id);
    await assert.rejects(() => move(opp2.id, 'lost', 'discovery'), (error) => error.code === 'VALIDATION_ERROR');
    await move(opp2.id, 'lost', 'discovery', { reason: 'Chose a competitor' });
    assert.equal(app.services.opportunities.get(opp2.id).closeReason, 'Chose a competitor');
    // Pipeline state is server-managed: CRUD cannot set it.
    await assert.rejects(
      () => app.services.opportunities.create({ companyId: converted.result.company.id, name: 'X', valueCents: 1, owner: 'x', pipelineStage: 'won' }, { actor }),
      (error) => error.code === 'VALIDATION_ERROR',
    );

    // ——— Lead Intelligence (Milestone 9): enrich → score → route ———
    const runIntel = (id, action, input) => app.runAction({ module: 'lead', action, recordId: id, input, actor });
    const signalAt = '2026-08-01T10:00:00Z';

    // Lead A: IT / Italian / enterprise / engaged → Enterprise Italy.
    const leadA = await leads.create({ firstName: 'Giulia', lastName: 'Ferrari', email: 'giulia@ferrari.example', companyName: 'Ferrari Sistemi', source: 'website' }, { actor });
    await runIntel(leadA.id, 'record-signal', { signalType: 'pricing-page-visited', observedAt: signalAt });
    await runIntel(leadA.id, 'record-signal', { signalType: 'demo-requested', observedAt: '2026-08-01T11:00:00Z' });
    const enrichedA = await runIntel(leadA.id, 'enrich', { provider: 'fixture-firmographics' });
    assert.equal(enrichedA.result.reused, false);
    assert.equal(enrichedA.result.snapshot.country, 'IT');
    // Repeat enrich reuses the non-expired snapshot — no second snapshot.
    const enrichedAgain = await runIntel(leadA.id, 'enrich', { provider: 'fixture-firmographics' });
    assert.equal(enrichedAgain.result.reused, true);
    const scoredA = await runIntel(leadA.id, 'score', { model: 'b2b-saas-score', version: 1 });
    assert.equal(scoredA.result.total, 75, 'enterprise 30 + country 10 + demo 25 + pricing 10');
    assert.equal(scoredA.result.contributions.filter((c) => c.matched).length, 4);
    const routedA = await runIntel(leadA.id, 'route', { policy: 'b2b-sales-routing', version: 1 });
    assert.equal(routedA.result.target.key, 'enterprise-italy');
    assert.equal(routedA.result.fallbackReason, null);

    // Lead B: ES / Spanish / mid score → Spain Sales.
    const leadB = await leads.create({ firstName: 'Carmen', lastName: 'Vega', email: 'carmen@sevilla.example', companyName: 'Sevilla Digital', source: 'referral' }, { actor });
    await runIntel(leadB.id, 'enrich', { provider: 'fixture-firmographics' });
    await runIntel(leadB.id, 'score', { model: 'b2b-saas-score', version: 1 });
    const routedB = await runIntel(leadB.id, 'route', { policy: 'b2b-sales-routing', version: 1 });
    assert.equal(routedB.result.target.key, 'spain-sales');

    // Lead C: unsupported territory → declared fallback queue, reason recorded.
    const leadC = await leads.create({ firstName: 'Jon', lastName: 'Stefansson', email: 'jon@reykjavik.example', companyName: 'Reykjavik Hosting', source: 'outbound' }, { actor });
    await runIntel(leadC.id, 'enrich', { provider: 'fixture-firmographics' });
    await runIntel(leadC.id, 'score', { model: 'b2b-saas-score', version: 1 });
    const routedC = await runIntel(leadC.id, 'route', { policy: 'b2b-sales-routing', version: 1 });
    assert.equal(routedC.result.target.key, 'unrouted-queue');
    assert.equal(routedC.result.fallbackReason, 'policy declined all eligible targets');

    // Rerouting an assigned lead is a stable conflict, not a silent reshuffle.
    await assert.rejects(
      () => runIntel(leadA.id, 'route', { policy: 'b2b-sales-routing', version: 1 }),
      (error) => error.code === 'ALREADY_ASSIGNED' && error.status === 409,
    );

    // Provider outage: honest failure, nothing persisted, no lead link.
    const leadFail = await leads.create({ firstName: 'Out', lastName: 'Age', email: 'x@fail.example' }, { actor });
    await assert.rejects(
      () => runIntel(leadFail.id, 'enrich', { provider: 'fixture-firmographics' }),
      (error) => error.code === 'PROVIDER_FAILED',
    );
    assert.equal(leads.get(leadFail.id).enrichmentSnapshotId, null);

    // Intelligence records are READ-ONLY publicly: the generated services have
    // no public create/update at all (capabilities get/list) — records exist
    // only through the trusted in-process createManaged used by the actions.
    const snapshotModule = app.modules.get('enrichment-snapshot');
    assert.deepEqual(snapshotModule.capabilities, ['get', 'list']);
    assert.equal(snapshotModule.service.create, undefined, 'no public snapshot create');
    assert.equal(snapshotModule.service.update, undefined, 'no public snapshot update');
    const scoreRunsSvc = app.modules.get('score-run').service;
    const assignmentsSvc = app.modules.get('assignment').service;
    const freshA = leads.get(leadA.id);
    assert.equal(freshA.assignedTargetId, 'enterprise-italy');
    assert.equal(scoreRunsSvc.get(freshA.scoreRunId).fingerprint, scoredA.result.fingerprint, 'runs carry the model fingerprint');
    assert.equal(assignmentsSvc.list().filter((a) => a.leadId === leadA.id).length, 1, 'exactly one assignment history entry');

    // ——— Commercial Operations (Milestone 10): catalog → composite quote → approval ———
    const sync1 = await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
    assert.equal(sync1.counts.productsCreated, 7);
    assert.equal(sync1.counts.offersCreated, 8);
    assert.ok(sync1.counts.componentsCreated >= 10, 'composite offers create several components');
    assert.ok(sync1.counts.tiersCreated >= 6, 'tier schedules persisted');
    assert.equal(sync1.counts.ineligibleOffers, 1, 'the metered offer is not quote eligible');
    // Idempotent re-sync: nothing created, nothing revised.
    const sync2 = await app.syncCatalog({ provider: 'fixture-saas-catalog', actor });
    assert.equal(sync2.counts.offersCreated + sync2.counts.offersRevised + sync2.counts.productsCreated + sync2.counts.versionsCreated, 0);

    const priceBook = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
    const offerOf = (key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
    const enterprise = offerOf('fixture:offer:enterprise');
    const storage = offerOf('fixture:offer:storage-monthly');
    const support = offerOf('fixture:offer:support-annual');
    const metered = offerOf('fixture:offer:bandwidth-metered');
    // The API add-on is quoted so that the signed order carries a component the
    // activation policy classifies as `other`: a real charge that creates no
    // subscription, delivery or service obligation. That decision is recorded
    // rather than assumed (Milestone 12).
    const apiAddon = offerOf('fixture:offer:api-monthly');
    // The setup offer carries a one-time setup fee (delivered internally) and
    // per-record data migration (delivered by a partner): the mix Milestone 13
    // hands over.
    const setupOffer = offerOf('fixture:offer:setup');
    assert.equal(metered.quoteEligible, false);
    assert.match(metered.unsupportedReason, /metered usage/);

    // A mixed quote: composite enterprise offer (one-time + monthly flat +
    // monthly volume-tiered seats) + graduated storage + annual support.
    const runQuote = (id, action, input) => app.runAction({ module: 'quote', action, recordId: id, input, actor });
    const createdQuote = await app.runAction({
      module: 'opportunity', action: 'create-quote', recordId: opp1.id,
      input: { priceBookId: priceBook.id }, actor,
    });
    const quoteId = createdQuote.result.quote.id;
    const enterpriseLine = await runQuote(quoteId, 'add-line', { offerId: enterprise.id, quantity: 30 });
    // 30 seats reach the 21–100 volume tier: the WHOLE quantity prices at 40.00.
    const seatComponent = enterpriseLine.result.line.components.find((component) => component.pricingModel === 'volume');
    assert.equal(seatComponent.listAmountCents, 30 * 4000, 'volume tier prices the entire quantity');
    assert.equal(enterpriseLine.result.quote.oneTimeTotal.netAmountCents, 500_000, 'flat setup charged once, not per seat');
    await runQuote(quoteId, 'add-line', { offerId: storage.id, quantity: 250 });
    await runQuote(quoteId, 'add-line', { offerId: support.id, quantity: 1, discountBps: 500 });
    await runQuote(quoteId, 'add-line', { offerId: apiAddon.id, quantity: 10 });
    await runQuote(quoteId, 'add-line', { offerId: setupOffer.id, quantity: 200 });

    const mixed = app.modules.get('quote').service.get(quoteId);
    const mixedTotals = JSON.parse(mixed.totalsJson);
    const monthly = mixedTotals.recurringTotals.find((group) => group.interval === 'month');
    const annual = mixedTotals.recurringTotals.find((group) => group.interval === 'year');
    // Monthly = platform 2,000.00 + seats 1,200.00 + graduated storage
    // (100×2.00 + 150×1.50 = 425.00) + API 10×9.00 = 3,715.00
    assert.equal(monthly.netAmountCents, 200_000 + 120_000 + 42_500 + 9_000);
    // One-time = enterprise setup 5,000.00 + setup fee 5,000.00 + migration
    // 200×0.25 = 10,050.00
    assert.equal(mixedTotals.oneTimeTotal.netAmountCents, 500_000 + 500_000 + 5_000);
    assert.equal(annual.netAmountCents, 1_000_000 - 50_000, 'annual support discounted 5%');
    assert.equal(mixedTotals.recurringTotals.length, 2, 'monthly and annual stay separate — no grand total');

    const submitted = await runQuote(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 });
    assert.equal(submitted.result.version.decision, 'auto_approve');
    assert.equal(submitted.result.quote.status, 'approved');
    const versionTotals = app.modules.get('quote-version-total').service.listWhere({ versionId: submitted.result.version.id });
    assert.equal(versionTotals.length, 3, 'one one-time group + monthly + annual');
    const versionComponents = app.modules.get('quote-version-component').service.listWhere({ versionId: submitted.result.version.id });
    assert.equal(versionComponents.length, 8, 'every component of every line is evidenced');
    const seatEvidence = versionComponents.find((component) => component.pricingModel === 'volume');
    assert.ok(JSON.parse(seatEvidence.tiersJson).length >= 3, 'the tier schedule is snapshotted');
    assert.ok(JSON.parse(seatEvidence.tierBreakdownJson).length >= 1, 'the tier breakdown is snapshotted');

    // Unsupported models can never be quoted.
    await assert.rejects(
      () => runQuote(quoteId, 'add-line', { offerId: metered.id, quantity: 1 }),
      (error) => error.code === 'INVALID_STATE' || error.code === 'OFFER_NOT_QUOTE_ELIGIBLE',
    );

    // Quote 2: high discount → human approval; agents cannot decide.
    const quote2 = (await app.runAction({
      module: 'opportunity', action: 'create-quote', recordId: opp2.id,
      input: { priceBookId: priceBook.id }, actor,
    })).result.quote.id;
    await runQuote(quote2, 'add-line', { offerId: enterprise.id, quantity: 10, discountBps: 2000 });
    const submitted2 = await runQuote(quote2, 'submit', { policy: 'standard-sales-discount', version: 1 });
    assert.equal(submitted2.result.version.decision, 'approval_required');
    assert.equal(submitted2.result.quote.status, 'pending_approval');
    await assert.rejects(
      () => app.runAction({ module: 'quote', action: 'approve', recordId: quote2, input: {}, actor: { type: 'agent', id: 'bot' } }),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
      'an agent actor cannot approve a discount',
    );
    const decided = await runQuote(quote2, 'reject', { reason: 'Discount too aggressive for this segment' });
    assert.equal(decided.result.quote.status, 'rejected');
    await runQuote(quote2, 'revise', {});
    const lines2 = app.modules.get('quote-line').service.listWhere({ quoteId: quote2, removed: false });
    await runQuote(quote2, 'update-line', { lineId: lines2[0].id, discountBps: 800 });
    const resubmitted = await runQuote(quote2, 'submit', { policy: 'standard-sales-discount', version: 1 });
    assert.equal(resubmitted.result.version.versionNumber, 2, 'monotonic version numbers');
    assert.equal(resubmitted.result.quote.status, 'approved');

    // The provider changes seat tiers AND the platform price: new immutable
    // offer revisions; the historical quote version is untouched.
    const sync3 = await app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'v2' }, actor });
    assert.ok(sync3.counts.offersRevised >= 2, 'tier and price changes create new offer revisions');
    const frozenSeats = app.modules.get('quote-version-component').service
      .listWhere({ versionId: submitted.result.version.id })
      .find((component) => component.pricingModel === 'volume');
    assert.equal(frozenSeats.listAmountCents, 30 * 4000, 'historical quoted amount unchanged after the tier change');
    assert.deepEqual(JSON.parse(frozenSeats.tiersJson)[0], { position: 1, upTo: 20, unitAmountCents: 5000, flatAmountCents: 0 }, 'historical tier schedule unchanged');
    // New drafts price at the NEW revision.
    const freshOffer = offerOf('fixture:offer:enterprise');
    assert.notEqual(freshOffer.id, enterprise.id, 'a new active revision exists');
    const quote3 = (await app.runAction({
      module: 'opportunity', action: 'create-quote', recordId: opp1.id, input: { priceBookId: priceBook.id }, actor,
    })).result.quote.id;
    const freshLine = await runQuote(quote3, 'add-line', { offerId: freshOffer.id, quantity: 30 });
    const freshSeats = freshLine.result.line.components.find((component) => component.pricingModel === 'volume');
    assert.equal(freshSeats.listAmountCents, 30 * 4200, 'new drafts use the new tier prices');
    // Superseded revisions cannot be added to a new draft.
    await assert.rejects(
      () => runQuote(quote3, 'add-line', { offerId: enterprise.id, quantity: 1 }),
      (error) => error.code === 'OFFER_INACTIVE',
    );

    // Commercial records are read-only publicly.
    const quoteModule = app.modules.get('quote');
    assert.deepEqual(quoteModule.capabilities, ['get', 'list']);
    assert.equal(quoteModule.service.create, undefined, 'no public quote create');

    // ---- Milestone 11: signature → verified events → immutable Order ----
    const { signatureFixture } = await import(pathToFileURL(join(starterInProject, 'signature.js')).href);
    const envelopes = app.modules.get('signature-envelope').service;
    const orders = app.modules.get('order').service;
    const requestSignature = (quote, quoteVersionId, signers, signActor = actor) => app.runAction({
      module: 'quote', action: 'request-signature', recordId: quote,
      input: { quoteVersionId, provider: 'fixture-signature', providerVersion: 1, signers },
      actor: signActor,
    });
    const customer = [{ name: 'Mario Rossi', email: 'mario.rossi@acme.example', role: 'customer', order: 1 }];

    // Sending is a real external side effect: an agent actor may prepare it,
    // but only a human user actor may send.
    await assert.rejects(
      () => requestSignature(quoteId, submitted.result.version.id, customer, { type: 'agent', id: 'bot' }),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
      'an agent actor cannot send for signature',
    );
    assert.equal(envelopes.list().length, 0, 'a refused send leaves no envelope behind');

    const requested = await requestSignature(quoteId, submitted.result.version.id, customer);
    assert.equal(requested.result.envelope.status, 'sent');
    const envelope = envelopes.listWhere({ quoteVersionId: submitted.result.version.id })[0];
    assert.equal(envelope.idempotencyKey, `env:quote-version:${submitted.result.version.id}`);
    // Exactly one envelope per quote version, ever: a repeat is refused rather
    // than creating a second provider envelope.
    await assert.rejects(
      () => requestSignature(quoteId, submitted.result.version.id, customer),
      (error) => error.code === 'ENVELOPE_EXISTS',
    );

    const ingest = (event) => app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: event.rawBody, headers: event.headers });
    // A forged webhook is refused before any state is touched.
    const forged = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_forged' });
    await assert.rejects(
      () => app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: forged.rawBody, headers: { 'x-signature-256': 'f'.repeat(64), 'x-signature-timestamp': forged.headers['x-signature-timestamp'] } }),
      (error) => error.code === 'SIGNATURE_INVALID' && error.status === 401,
    );
    assert.equal(app.modules.get('signature-event').service.list().length, 0);

    signatureFixture.markDelivered(envelope.idempotencyKey);
    assert.equal((await ingest(signatureFixture.event(envelope.idempotencyKey, 'delivered'))).applied, true);
    assert.equal(orders.list().length, 0, 'delivery is not completion');

    signatureFixture.markCompleted(envelope.idempotencyKey);
    const completionEvent = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_starter_completed' });
    const completion = await ingest(completionEvent);
    assert.equal(completion.applied, true);
    assert.equal(envelopes.get(envelope.id).status, 'completed');

    const artifact = app.modules.get('signed-artifact').service.listWhere({ envelopeId: envelope.id })[0];
    assert.equal(artifact.documentHash, envelope.documentHash, 'the signed package is the one that was sent');
    const order = orders.listWhere({ quoteVersionId: submitted.result.version.id })[0];
    assert.equal(order.status, 'accepted');
    assert.equal(order.totalsJson, app.modules.get('quote-version').service.get(submitted.result.version.id).totalsJson);
    assert.equal(app.modules.get('order-component').service.countWhere({ orderId: order.id }), versionComponents.length);
    assert.equal(app.modules.get('order-total').service.countWhere({ orderId: order.id }), versionTotals.length);

    // Replay, out-of-order and post-terminal events never change the outcome.
    assert.equal((await ingest(completionEvent)).duplicate, true);
    const lateSent = signatureFixture.event(envelope.idempotencyKey, 'sent', { providerEventId: 'evt_starter_late' });
    assert.equal((await ingest(lateSent)).applied, false);
    assert.equal(envelopes.get(envelope.id).status, 'completed');
    assert.equal(orders.list().length, 1, 'exactly one order');

    // A catalog change after signing cannot touch the signed evidence.
    await app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'v2' }, actor });
    assert.equal(orders.get(order.id).totalsJson, order.totalsJson);
    assert.equal(app.modules.get('signed-artifact').service.get(artifact.id).artifactHash, artifact.artifactHash);

    // A declined signature is terminal and produces no order.
    const declineEnvelopeRequest = await requestSignature(quote2, resubmitted.result.version.id, [{ name: 'Lucia Bianchi', email: 'lucia.bianchi@beta.example', role: 'customer', order: 1 }]);
    assert.equal(declineEnvelopeRequest.result.envelope.status, 'sent');
    const declinedEnvelope = envelopes.listWhere({ quoteVersionId: resubmitted.result.version.id })[0];
    signatureFixture.markDeclined(declinedEnvelope.idempotencyKey);
    assert.equal((await ingest(signatureFixture.event(declinedEnvelope.idempotencyKey, 'declined', { providerEventId: 'evt_starter_declined' }))).applied, true);
    assert.equal(envelopes.get(declinedEnvelope.id).status, 'declined');
    assert.equal(orders.listWhere({ quoteVersionId: resubmitted.result.version.id }).length, 0, 'a decline creates no order');
    assert.equal(orders.list().length, 1);

    // Signature and order records are read-only publicly, like every other
    // piece of commercial evidence.
    for (const name of ['signature-envelope', 'signature-signer', 'signature-event', 'signed-artifact', 'order', 'order-line', 'order-component', 'order-tier', 'order-total']) {
      const module = app.modules.get(name);
      assert.deepEqual(module.capabilities, ['get', 'list'], name);
      assert.equal(module.service.create, undefined, `no public create on ${name}`);
      assert.equal(module.service.update, undefined, `no public update on ${name}`);
    }

    // ---- Milestone 12: signed Order → Contract, Subscription, obligations ----
    // Everything below belongs to the optional `contracts` domain package: the
    // kernel does not know the words contract or subscription.
    // The term is operational metadata recorded AFTER signature: the signed
    // document carries none, so the package requires a human reason for it.
    // A term that starts today is active; one that starts later is recorded
    // as scheduled and stays that way — there is no scheduler (below).
    const today = app.now().slice(0, 10);
    const inOneYear = new Date(`${today}T00:00:00.000Z`);
    inOneYear.setUTCFullYear(inOneYear.getUTCFullYear() + 1);
    inOneYear.setUTCDate(inOneYear.getUTCDate() - 1);
    const TERM = {
      effectiveDate: today,
      termStartDate: today,
      termEndDate: inOneYear.toISOString().slice(0, 10),
      termsReason: 'renewal window agreed with the customer after signature',
    };
    const POLICY = { policy: 'b2b-saas-order-activation', policyVersion: 1 };
    // The delivery partner is a business reference and a name snapshot: this
    // milestone grants a partner no account, no portal and no permission.
    const PARTNER = { partnerRef: 'partner:abc-consulting', partnerName: 'ABC Consulting', reason: 'they run our data migrations' };
    const runOrder = (action, input, orderActor = actor) =>
      app.runAction({ module: 'order', action, recordId: order.id, input, actor: orderActor });

    // Planning is read-only, and it classifies from explicit identity — never
    // from recurrence. One component is deliberately unmapped by v1.
    const planned = await runOrder('plan-activation', POLICY);
    const plan = planned.result.plan;
    // Two independent axes: what recurs, and what is owed beyond the money.
    // Annual support is BOTH a subscription line and a service obligation.
    assert.deepEqual(plan.counts, { subscriptionLines: 3, delivery: 3, service: 1, noObligation: 3, ambiguous: 1 });
    assert.equal(plan.termsProvenance.source, 'post-signature-operational-activation');
    assert.equal(plan.activatable, false, 'an unclassified component blocks activation');
    assert.equal(app.modules.get('commercial-contract').service.list().length, 0, 'planning writes nothing');
    const ambiguous = plan.components.find((component) => component.requiresOverride);
    assert.ok(ambiguous.reason.includes('not mapped by this policy version'));

    // An agent may prepare the plan; it may never commit the business.
    await assert.rejects(
      () => runOrder('activate-contract', { ...POLICY, ...TERM }, { type: 'agent', id: 'bot' }),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
    );
    // And no human can activate past an ambiguity without deciding it.
    await assert.rejects(
      () => runOrder('activate-contract', { ...POLICY, ...TERM }),
      (error) => error.code === 'CLASSIFICATION_AMBIGUOUS' && error.status === 409,
    );
    // Impossible and reversed dates are refused before anything is created.
    await assert.rejects(
      () => runOrder('activate-contract', { ...POLICY, ...TERM, effectiveDate: '2026-02-30' }),
      (error) => error.status === 400,
    );
    await assert.rejects(
      () => runOrder('activate-contract', { ...POLICY, ...TERM, termStartDate: TERM.termEndDate, termEndDate: TERM.termStartDate }),
      (error) => error.status === 400,
    );
    // The term is not signed, so it must say where it came from.
    await assert.rejects(
      () => runOrder('activate-contract', { ...POLICY, ...TERM, termsReason: undefined }),
      (error) => error.status === 400 && /termsReason/.test(error.message),
    );
    // A notice period without auto-renewal is a clause that can never apply.
    await assert.rejects(
      () => runOrder('activate-contract', { ...POLICY, ...TERM, autoRenew: false, renewalNoticeDays: 30 }),
      (error) => error.status === 400 && /autoRenew/.test(error.message),
    );

    // The human decision: an explicit classification with a reason.
    const activated = await runOrder('activate-contract', {
      ...POLICY, ...TERM, autoRenew: true, renewalNoticeDays: 30,
      classificationOverrides: [
        {
          orderComponentId: ambiguous.orderComponentId,
          dimension: 'commercial',
          value: 'subscription',
          reason: 'storage is sold to this customer as a recurring right',
        },
        {
          orderComponentId: ambiguous.orderComponentId,
          dimension: 'obligations',
          value: [],
          reason: 'we host it; there is no delivery or service work to do',
        },
      ],
    });
    assert.deepEqual(activated.result.counts, { subscriptionLines: 4, delivery: 3, service: 1, noObligation: 4, ambiguous: 0 });

    const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: order.id })[0];
    assert.equal(contract.status, 'active');
    assert.equal(contract.sourceKey, `contract:order:${order.id}`);
    assert.ok(contract.termDays === 365 || contract.termDays === 366, 'the end date is inclusive');
    assert.equal(contract.documentHash, order.documentHash, 'the contract cites the signed document');
    assert.equal(orders.get(order.id).contractId, contract.id);
    const contractVersion = app.modules.get('contract-version').service.listWhere({ contractId: contract.id })[0];
    assert.equal(contractVersion.versionNumber, 1);
    assert.equal(contract.currentVersionId, contractVersion.id);

    const contractLines = app.modules.get('contract-line').service.listWhere({ contractId: contract.id });
    assert.equal(contractLines.length, 8, 'every order component becomes exactly one contract line');
    const byKey = (key) => contractLines.find((line) => String(line.componentKey).endsWith(key));
    const obligationsOf = (key) => JSON.parse(byKey(key).obligationsJson);
    assert.equal(byKey('ent-platform').commercialActivation, 'subscription', 'recurring platform fee → subscription line');
    assert.deepEqual(obligationsOf('ent-platform'), [], 'and it owes nothing further');
    assert.equal(byKey('ent-seats').commercialActivation, 'subscription', 'recurring seats → subscription line');
    assert.equal(byKey('ent-setup').commercialActivation, 'non_subscription', 'a one-time setup is not a recurring right');
    assert.deepEqual(obligationsOf('ent-setup'), ['delivery'], 'one-time setup → delivery obligation');
    // The two-axis case: recurring support is a subscription line AND a
    // service obligation. One exclusive answer would silently lose one of them.
    assert.equal(byKey('support-fee').commercialActivation, 'subscription', 'recurring support is recurring money');
    assert.deepEqual(obligationsOf('support-fee'), ['service'], 'and it is a future service obligation');
    assert.equal(byKey('api-calls').commercialActivation, 'non_subscription', 'a recurring charge is NOT automatically a recurring right');
    assert.deepEqual(obligationsOf('api-calls'), [], 'and it owes nothing further');
    const overridden = byKey('storage-gb');
    assert.equal(overridden.commercialOverridden, true);
    assert.equal(overridden.obligationsOverridden, true);
    assert.equal(overridden.policyCommercialActivation, 'ambiguous', 'the policy decision survives next to the override');
    assert.equal(overridden.overriddenBy, 'starter');
    // The term is operational metadata, and every record says so rather than
    // implying the customer signed these dates.
    assert.equal(contract.termsSource, 'post-signature-operational-activation');
    assert.equal(contract.termsReason, TERM.termsReason);
    assert.equal(contractVersion.termsSource, 'post-signature-operational-activation');
    // Amounts are copied from the signed order, never recomputed.
    const orderComponents = app.modules.get('order-component').service.listWhere({ orderId: order.id });
    for (const line of contractLines) {
      const source = orderComponents.find((component) => component.id === line.orderComponentId);
      assert.equal(line.netAmountCents, source.netAmountCents, `${line.componentKey} amount copied`);
    }

    const subscription = app.modules.get('subscription').service.listWhere({ contractId: contract.id })[0];
    assert.equal(subscription.lineCount, 4, 'platform, seats, support and the overridden storage line');
    assert.equal(app.modules.get('subscription-line').service.countWhere({ subscriptionId: subscription.id }), 4);
    assert.ok(
      app.modules.get('subscription-line').service.listWhere({ subscriptionId: subscription.id })
        .some((subLine) => String(subLine.componentKey).endsWith('support-fee')),
      'the recurring support commitment is a subscription line, not only an obligation',
    );
    const deliveries = app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id });
    assert.equal(deliveries.length, 3, 'enterprise setup, the setup fee and the data migration');
    for (const obligation of deliveries) {
      assert.equal(obligation.status, 'pending_handover', 'nothing executes it — it is a recorded obligation');
    }
    const services = app.modules.get('service-obligation').service.listWhere({ contractId: contract.id });
    assert.equal(services.length, 1);
    assert.equal(services[0].status, 'pending_activation');
    assert.equal(services[0].contractLineId, byKey('support-fee').id, 'both consequences cite one contract line');

    // A future-dated activation is SCHEDULED, never active — and nothing will
    // flip it, because this milestone has no scheduler.
    const laterOrder = orders.listWhere({ quoteVersionId: resubmitted.result.version.id })[0] ?? null;
    if (laterOrder) {
      const future = new Date(`${today}T00:00:00.000Z`);
      future.setUTCMonth(future.getUTCMonth() + 1);
      const start = future.toISOString().slice(0, 10);
      const end = new Date(future);
      end.setUTCFullYear(end.getUTCFullYear() + 1);
      const scheduled = await app.runAction({
        module: 'order', action: 'activate-contract', recordId: laterOrder.id,
        input: {
          ...POLICY, effectiveDate: today, termStartDate: start, termEndDate: end.toISOString().slice(0, 10),
          termsReason: 'starts next month by agreement',
        },
        actor,
      });
      assert.equal(scheduled.result.contract.status, 'scheduled');
    }

    // Activation is once: a second attempt is a stable refusal, not a second
    // contract, and the whole transaction is idempotent by identity.
    await assert.rejects(
      () => runOrder('activate-contract', { ...POLICY, ...TERM }),
      (error) => error.code === 'ORDER_ALREADY_ACTIVATED' && error.status === 409,
    );
    assert.equal(app.modules.get('commercial-contract').service.list().length, 1);

    // A catalog change after activation cannot move a single figure.
    await app.syncCatalog({ provider: 'fixture-saas-catalog', input: { variant: 'v2' }, actor });
    const platformLine = app.modules.get('contract-line').service.get(byKey('ent-platform').id);
    assert.equal(platformLine.netAmountCents, byKey('ent-platform').netAmountCents, 'a repriced catalog never touches a signed contract');

    // ---- Milestone 13: pending obligations → planned delivery handover ----
    // A SECOND domain package, reaching the first only through the declared
    // capability contracts/delivery-obligations@1.
    const DELIVERY_POLICY = { policy: 'b2b-delivery-handover', policyVersion: 1 };
    const runContract = (action, input, handoverActor = actor) =>
      app.runAction({ module: 'commercial-contract', action, recordId: contract.id, input, actor: handoverActor });

    const handoverPlan = (await runContract('plan-delivery-handover', DELIVERY_POLICY)).result.plan;
    assert.deepEqual(handoverPlan.counts, { workPackages: 3, internal: 2, partner: 1, ambiguous: 0 });
    assert.equal(handoverPlan.partnerRequired, true, 'the data migration is delivered by a partner');
    assert.deepEqual(handoverPlan.milestones.map((milestone) => milestone.key), ['kickoff', 'delivery', 'go-live']);
    assert.equal(handoverPlan.datesProvenance.source, 'post-sale-delivery-planning');
    assert.equal(app.modules.get('delivery-project').service.list().length, 0, 'planning writes nothing');

    // An agent may prepare the plan; it may not hand the work over.
    await assert.rejects(
      () => runContract('create-delivery-handover', { ...DELIVERY_POLICY, partner: PARTNER }, { type: 'agent', id: 'bot' }),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
    );
    // Partner-delivered work cannot be handed over without naming the partner.
    await assert.rejects(
      () => runContract('create-delivery-handover', { ...DELIVERY_POLICY }),
      (error) => error.code === 'PARTNER_REQUIRED' && error.status === 409,
    );
    // Planning dates are optional, but a half-window is not a plan.
    await assert.rejects(
      () => runContract('create-delivery-handover', { ...DELIVERY_POLICY, partner: PARTNER, targetStartDate: today }),
      (error) => error.status === 400,
    );

    const handover = await runContract('create-delivery-handover', {
      ...DELIVERY_POLICY,
      projectName: 'Acme — onboarding and migration',
      targetStartDate: today,
      targetEndDate: TERM.termEndDate,
      partner: PARTNER,
    });
    assert.equal(handover.result.obligationsHandedOver, 3);

    const deliveryProject = app.modules.get('delivery-project').service.listWhere({ contractId: contract.id })[0];
    assert.equal(deliveryProject.status, 'pending_kickoff', 'the project is planned, never started');
    assert.equal(deliveryProject.customerName, contract.customerName, 'it carries its own customer snapshot');
    assert.equal(deliveryProject.datesSource, 'post-sale-delivery-planning');

    const packages = app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: deliveryProject.id });
    assert.equal(packages.length, 3, 'one work package per delivery obligation');
    const packageBy = (key) => packages.find((row) => String(row.componentKey).endsWith(key));
    assert.equal(packageBy('ent-setup').deliveryMode, 'internal');
    assert.equal(packageBy('setup-fee').deliveryMode, 'internal');
    assert.equal(packageBy('migration-records').deliveryMode, 'partner', 'the migration is subcontracted');
    assert.equal(packageBy('migration-records').partnerRef, PARTNER.partnerRef);
    assert.equal(packageBy('ent-setup').partnerRef, null, 'internal work is not attributed to the partner');
    for (const workPackage of packages) {
      assert.equal(workPackage.status, 'planned');
      assert.ok(workPackage.netAmountCents > 0, 'the commercial amount is copied from the obligation');
    }

    const milestones = app.modules.get('delivery-milestone').service.listWhere({ deliveryProjectId: deliveryProject.id });
    assert.deepEqual(
      milestones.sort((a, b) => a.position - b.position).map((row) => row.milestoneKey),
      ['kickoff', 'delivery', 'go-live'],
    );
    const engagement = app.modules.get('delivery-partner-engagement').service.listWhere({ deliveryProjectId: deliveryProject.id })[0];
    assert.equal(engagement.partnerNameSnapshot, PARTNER.partnerName);
    assert.equal(engagement.status, 'planned', 'a planned engagement grants the partner nothing at all');
    assert.equal(engagement.workPackageCount, 1);

    // ---- Milestone 14a + 14b1: run the project, and record what it consumed ----
    //
    // Everything below is a human decision, and every number the server
    // computes. These are operational delivery estimates: nothing is invoiced,
    // paid, recognized as revenue or converted between currencies.
    const runDelivery = (module, id, action, input, as = actor) =>
      app.runAction({ module, action, recordId: id, input, actor: as });

    await runDelivery('delivery-project', deliveryProject.id, 'start-delivery-project', { note: 'kickoff held' });
    const internalPackage = packageBy('ent-setup');
    const partnerPackage = packageBy('migration-records');
    for (const workPackage of [internalPackage, partnerPackage]) {
      await runDelivery('delivery-work-package', workPackage.id, 'start-work-package', {});
    }

    // An agent may look at the economics; it may not record any of it.
    await assert.rejects(
      () => runDelivery('delivery-work-package', internalPackage.id, 'record-delivery-time', {
        entryKey: 'bot', contributorRef: 'bot', contributorType: 'internal',
        workDate: today, minutes: 60, category: 'consulting',
      }, { type: 'agent', id: 'bot' }),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
    );

    await runDelivery('delivery-work-package', internalPackage.id, 'record-delivery-time', {
      entryKey: 'onboarding-day-1', contributorRef: 'consultant:ana', contributorType: 'internal',
      workDate: today, minutes: 480, category: 'consulting', note: 'environment setup and first workshop',
    });
    await runDelivery('delivery-work-package', partnerPackage.id, 'record-delivery-time', {
      entryKey: 'migration-day-1', contributorRef: 'abc:marco', contributorType: 'partner',
      workDate: today, minutes: 300, category: 'migration', note: 'record migration dry run',
    });
    await runDelivery('delivery-work-package', internalPackage.id, 'record-delivery-expense', {
      entryKey: 'travel-1', expenseDate: today, category: 'travel',
      amountCents: 24_500, vendorRef: 'rail-operator', evidenceRef: 'exp-2026-0042',
    });

    const timeEntries = app.modules.get('delivery-time-entry').service.listWhere({ deliveryProjectId: deliveryProject.id });
    assert.equal(timeEntries.length, 2);
    const internalEntry = timeEntries.find((row) => row.contributorType === 'internal');
    const partnerEntry = timeEntries.find((row) => row.contributorType === 'partner');
    // 8 hours of internal consulting at the mapped 120.00/hour rate.
    assert.equal(internalEntry.ratePerHourCents, 12_000);
    assert.equal(internalEntry.costCents, 96_000, 'the server computed the cost from the policy rate');
    // 5 hours of partner migration at the mapped 90.00/hour rate.
    assert.equal(partnerEntry.ratePerHourCents, 9_000);
    assert.equal(partnerEntry.costCents, 45_000);
    assert.ok(partnerEntry.partnerEngagementId, 'partner time is attributed to the planned engagement');
    assert.ok(internalEntry.policyFingerprint.length >= 32, 'and to a fingerprinted policy version');

    // Evidence is evidence: there is no public write path to any of it.
    assert.equal(app.modules.get('delivery-time-entry').service.create, undefined);
    assert.equal(app.modules.get('delivery-time-entry').service.update, undefined);
    assert.equal(app.modules.get('delivery-economic-snapshot').service.update, undefined);

    const planV1 = await runDelivery('delivery-project', deliveryProject.id, 'publish-economic-plan', {
      reason: 'initial plan from the signed obligations',
      lines: [
        { kind: 'internal_time', category: 'consulting', plannedMinutes: 2400, plannedTotalCostCents: 480_000, currency: 'EUR', deliveryWorkPackageId: internalPackage.id },
        { kind: 'partner', category: 'migration', plannedMinutes: 1200, plannedTotalCostCents: 180_000, currency: 'EUR', deliveryWorkPackageId: partnerPackage.id },
        { kind: 'expense', category: 'travel', plannedTotalCostCents: 60_000, currency: 'EUR' },
      ],
    });
    assert.equal(planV1.result.plan.version, 1);

    const planV2 = await runDelivery('delivery-project', deliveryProject.id, 'publish-economic-plan', {
      reason: 'the customer added a second migration window',
      lines: [
        { kind: 'internal_time', category: 'consulting', plannedMinutes: 2400, plannedTotalCostCents: 480_000, currency: 'EUR', deliveryWorkPackageId: internalPackage.id },
        { kind: 'partner', category: 'migration', plannedMinutes: 1800, plannedTotalCostCents: 270_000, currency: 'EUR', deliveryWorkPackageId: partnerPackage.id },
        { kind: 'expense', category: 'travel', plannedTotalCostCents: 60_000, currency: 'EUR' },
      ],
    });
    assert.equal(planV2.result.plan.version, 2, 'a plan is versioned, never edited');
    assert.equal(
      app.modules.get('delivery-economic-plan').service.get(planV1.result.plan.id).reason,
      'initial plan from the signed obligations',
      'and version 1 stays exactly as it was published',
    );

    const snapshot = await runDelivery('delivery-project', deliveryProject.id, 'snapshot-delivery-economics', {
      snapshotKey: 'week-1',
    });
    const groups = JSON.parse(snapshot.result.snapshot.groupsJson);
    assert.equal(groups.length, 1, 'one group per currency, and this project is single-currency');
    const [economics] = groups;
    assert.equal(economics.currency, 'EUR');
    assert.equal(economics.actualTimeCostCents, 141_000, '96 000 internal + 45 000 partner');
    assert.equal(economics.actualPartnerCostCents, 45_000, 'the subcontracted share is visible on its own');
    assert.equal(economics.actualExpenseCostCents, 24_500);
    assert.equal(economics.totalActualCostCents, 165_500);
    assert.equal(economics.plannedCostCents, 810_000, 'measured against the latest plan version');
    // Every delivery obligation in this starter is one-time, so a contribution
    // estimate is defensible — and the group says so on the record rather than
    // leaving a reader to assume it. A project carrying a recurring obligation
    // would report `unavailable` here instead of a number that compares a
    // per-period price against a spend to date.
    assert.deepEqual(
      economics.commercialInputs.map((input) => input.chargeType), ['one_time'],
      'the delivery obligations handed over here are all one-time',
    );
    assert.equal(economics.contributionBasis, 'one_time');
    assert.equal(economics.contributionUnavailableReason, null);
    assert.equal(
      economics.deliveryContributionEstimateCents,
      economics.oneTimeCommercialValueCents - economics.totalActualCostCents,
      'an estimate, named as one — never a margin, a profit or recognized revenue',
    );
    assert.equal(snapshot.result.snapshot.timeEntryCount, 2);
    assert.match(snapshot.result.snapshot.roundingRule, /roundHalfUp/);

    // A snapshot is reproducible: the same evidence recomputes identically.
    const preview = await runDelivery('delivery-project', deliveryProject.id, 'preview-delivery-economics', {}, { type: 'agent', id: 'bot' });
    assert.deepEqual(preview.result.economics.groups, groups, 'and an agent may read it');
    assert.equal(preview.result.stored, false, 'a preview is never evidence');

    // Nothing above billed or paid anything. Acceptance records now exist —
    // M14b2 added them — so the assertion names what must not exist rather
    // than lumping acceptance in with billing: acceptance is evidence a human
    // recorded, and it authorizes nothing.
    assert.equal(
      app.modules.list().some((module) => /invoice|payment|billing/i.test(module.name)), false,
      'no invoice, payment or billing record exists anywhere in this framework',
    );

    // The cross-package write: exactly those obligations are handed over, and
    // the service obligation is not Delivery's business.
    const handedOver = app.modules.get('delivery-obligation').service.listWhere({ contractId: contract.id });
    assert.equal(handedOver.length, 3);
    for (const obligation of handedOver) {
      assert.equal(obligation.status, 'handed_over');
      assert.equal(obligation.handoverRef, deliveryProject.id);
    }
    assert.equal(
      app.modules.get('service-obligation').service.listWhere({ contractId: contract.id })[0].status,
      'pending_activation',
      'a service obligation is untouched by Delivery',
    );

    // A second handover is a stable refusal, not a second project.
    await assert.rejects(
      () => runContract('create-delivery-handover', { ...DELIVERY_POLICY, partner: PARTNER }),
      (error) => error.code === 'HANDOVER_ALREADY_EXISTS' && error.status === 409,
    );
    assert.equal(app.modules.get('delivery-project').service.list().length, 1);

    // ---- a CUSTOMER-AUTHORED package, attached the same way ----
    await assert.rejects(
      () => app.runAction({
        module: 'delivery-partner-engagement', action: 'rate-partner', recordId: engagement.id,
        input: { policy: 'standard-partner-rating', policyVersion: 1, score: 95, reason: 'bot opinion' },
        actor: { type: 'agent', id: 'bot' },
      }),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED',
    );
    const rated = await app.runAction({
      module: 'delivery-partner-engagement', action: 'rate-partner', recordId: engagement.id,
      input: { policy: 'standard-partner-rating', policyVersion: 1, score: 95, reason: 'delivered the migration on time' },
      actor,
    });
    assert.equal(rated.result.scorecard.rating, 'preferred');
    assert.equal(app.modules.get('partner-scorecard').service.list().length, 1);

    // Delivery and custom-package records are read-only publicly too.
    for (const name of [
      'delivery-handover-run', 'delivery-project', 'delivery-work-package',
      'delivery-milestone', 'delivery-partner-engagement', 'partner-scorecard',
    ]) {
      const module = app.modules.get(name);
      assert.deepEqual(module.capabilities, ['get', 'list'], name);
      assert.equal(module.service.create, undefined, `no public create on ${name}`);
      assert.equal(module.service.update, undefined, `no public update on ${name}`);
    }

    // Contract records are read-only publicly, like every other evidence
    // record: they exist only through the activation action.
    for (const name of [
      'contract-activation', 'commercial-contract', 'contract-version', 'contract-line',
      'subscription', 'subscription-line', 'delivery-obligation', 'service-obligation',
    ]) {
      const module = app.modules.get(name);
      assert.deepEqual(module.capabilities, ['get', 'list'], name);
      assert.equal(module.service.create, undefined, `no public create on ${name}`);
      assert.equal(module.service.update, undefined, `no public update on ${name}`);
    }

    console.log(JSON.stringify({
      ok: true,
      summary: 'Captured 3 leads; qualified 2; disqualified 1; converted 2 into 1 shared Company, 2 Contacts and 2 Opportunities entering Discovery; walked one to Won and one to Lost; terminal stages locked; enriched, scored (explainably) and routed 3 more leads with immutable snapshots, runs and assignment history; synced a composite fixture catalog idempotently (flat, per-unit, volume and graduated components across one-time, monthly and annual charges, plus one unsupported metered offer refused for quoting) and built mixed quotes with grouped one-time/monthly/annual totals — one auto-approved, one through human discount approval with reject → revise → version 2 — then proved a tier/price change creates new offer revisions while the historical quote version stays unchanged; sent an approved quote version for signature as a human actor (agents refused), refused a forged webhook, ingested verified delivered and completed events, produced signed-artifact evidence and exactly one immutable Order with its lines, components, tiers and grouped totals, proved replay and out-of-order events change nothing and a decline creates no order; then activated that signed order — through the optional contracts domain package — into one commercial contract with an immutable version and six contract lines classified on two explicit axes (platform and seats as subscription lines owing nothing further, a one-time setup as a pending delivery obligation, annual support as BOTH a subscription line and a pending service obligation, a recurring API charge deliberately as neither, and one component the policy refused to guess until a human decided both of its axes with reasons), recording the term as post-signature operational metadata with its stated source, refusing agent actors, impossible and reversed dates, a notice period without auto-renewal, a term with no stated source and any second activation, and recording a future-dated contract as scheduled because no scheduler exists; then handed that contract to delivery through a SECOND domain package — reaching the first only through the declared capability contracts/delivery-obligations@1 — planning a delivery project with three work packages (two internal, the data migration subcontracted to a named partner who is granted no access of any kind), a kickoff/delivery/go-live milestone plan and post-sale planning dates, marking exactly the three delivery obligations handed over while the service obligation stayed untouched, refusing agent actors, a missing partner, a half window and any second handover; and rated that partner through a CUSTOMER-AUTHORED package attached with no kernel change; CRUD cannot set lifecycle, conversion, pipeline, intelligence, commercial, signature, order or contract fields.',
      leads: leads.list().length,
      tasks: tasks.list().length,
      companies: app.services.companies.list().length,
      contacts: app.services.contacts.list().length,
      opportunities: app.services.opportunities.list().length,
      won: app.services.opportunities.list().filter((o) => o.pipelineStage === 'won').length,
      lost: app.services.opportunities.list().filter((o) => o.pipelineStage === 'lost').length,
    }, null, 2));
  } finally {
    app.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

/** @param {string} root @param {string} manifestPath */
function applyModule(root, manifestPath) {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), 'module', 'create', manifestPath, '--apply', '--root', root],
    { encoding: 'utf8', cwd: root },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to apply ${manifestPath}:\n${result.stdout}\n${result.stderr}`);
  }
}
