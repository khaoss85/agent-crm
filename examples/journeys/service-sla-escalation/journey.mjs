// @ts-check

/**
 * **Service case → SLA evaluation → escalation evidence**, on an injected clock.
 *
 * This is the second journey `crm scenario run` knows how to execute
 * (`packages/cli/src/scenario-journey.js`), and it exists for one reason the
 * first one cannot serve: **Service is time-dependent and the starter is not.**
 *
 * `examples/starters/b2b-lead-qualification/install.mjs` runs on the real wall
 * clock, deliberately — it is a product installer and a starter that faked the
 * date would be lying about what a customer gets. But an SLA state is a
 * *function of the clock*: `packages/service/src/service-actions.js`
 * `evaluateSla()` reads `now()` and nothing else, and the actions expose no
 * `at` parameter. So on the real clock a case opened seconds ago is always
 * `on_track`, the boundary between `at_risk` and `breached` is four hours away,
 * and **no run can ever observe it**. That is not a gap in the scenario
 * document; it is a gap in what a wall-clock journey can witness.
 *
 * This journey composes an application with an injected, fixed UTC clock
 * (`createAccordoApp({ clock })`, `packages/core/src/time.js`) and steps it, so
 * the SLA boundary is observed **exactly**: the same case, evaluated at its
 * first-response due instant and one millisecond later, is `at_risk` and then
 * `breached`. A regression in the comparison at that boundary — `>` becoming
 * `>=` — changes a business outcome and nothing else, and this is the only run
 * in the repository that would fail on it.
 *
 * ### It is a materially different composition, on purpose
 *
 * `contracts` + `service`, and nothing else: no `intelligence`, no `delivery`,
 * no `lifecycle`, no customer package, no Lead or Task module. Service reaches
 * contracts through the one declared capability `contracts/service-obligations@1`
 * and imports nothing from it, so a composition without Delivery is the honest
 * demonstration of that (ADR-018). Consumer #1 and consumer #2 therefore report
 * different composition fingerprints and different package sets, which is what
 * `EVIDENCE_IS_ONE_COMPOSITION` has always claimed and nothing previously
 * showed.
 *
 * ### What it does NOT do — read this before writing a claim about it
 *
 * Service is **partial**, and this run invents nothing to hide that
 * (`docs/SERVICE_OPERATIONS.md`):
 *
 * - there is no auth, tenancy or RBAC anywhere in this framework, so "a human
 *   did it" means an actor object said so;
 * - **nothing was notified, routed, emailed, called or messaged.** Every
 *   notification-shaped result here is published as `false` and observed as
 *   `false`, because a support tool that silently claims to have told somebody
 *   is worse than one that never offers to;
 * - the SLA is **elapsed wall-clock minutes**. No business-hours calendar, no
 *   holiday table, no timezone interpretation, and `waiting_customer` does not
 *   pause it. A recorded evaluation is what the clock said at a stated instant;
 *   it is **not** a contractual or legal determination that anybody breached
 *   anything;
 * - escalation is a human **recording** that something was escalated. It routes
 *   to nobody and pages nobody;
 * - no billing, invoicing, renewal, contract amendment or customer portal
 *   exists, and this run proves the commercial record did not move rather than
 *   asserting it.
 *
 * Run it directly:
 *   `node examples/journeys/service-sla-escalation/journey.mjs`
 *
 * Exit 0 means every guarantee below held. Nothing is written to your own
 * database or into this repository: the application is composed in a temporary
 * directory (or in `ACCORDO_KEEP_ROOT`, which is how the scenario runner asks
 * for a project it can then inspect through AX1).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const journeyDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(journeyDir, '..', '..', '..');

/**
 * The injected clock, and every instant it is stepped to.
 *
 * These are the business facts of the run. They are constants in checked-in
 * source, not values a scenario document supplies — a document that could name
 * an instant could name the instant that makes a breach disappear, and the
 * whole point of a scenario is that it cannot choose its own answer.
 *
 * The standard support tier in `examples/starters/b2b-lead-qualification/service.js`
 * gives 240 first-response minutes and 2880 resolution minutes, so:
 *
 * ```text
 * openedAt            2026-09-15T11:00:00.000Z
 * firstResponseDueAt  2026-09-15T15:00:00.000Z   (+240 minutes, exactly)
 * resolutionDueAt     2026-09-17T11:00:00.000Z   (+2880 minutes, exactly)
 * ```
 */
const SALE_AT = '2026-09-15T10:00:00.000Z';
const CASE_OPENED_AT = '2026-09-15T11:00:00.000Z';
/** The first-response due instant itself: `now === due`, which is not yet late. */
const AT_THE_BOUNDARY = '2026-09-15T15:00:00.000Z';
/** One millisecond later, which is. */
const ONE_MS_PAST_THE_BOUNDARY = '2026-09-15T15:00:00.001Z';
const RESPONDED_AT = '2026-09-15T15:05:00.000Z';
const RESOLVED_AT = '2026-09-16T09:00:00.000Z';
const CLOSED_AT = '2026-09-16T09:30:00.000Z';

/** The contract term, so the contract is `active` rather than `scheduled`. */
const TERM = {
  effectiveDate: '2026-09-01',
  termStartDate: '2026-09-01',
  termEndDate: '2027-08-31',
  termsReason: 'agreed with the customer after signature',
};
/** Coverage begins today against the injected clock, never in the future. */
const COVERAGE_START = SALE_AT.slice(0, 10);

const ACTOR = { type: 'user', id: 'journey' };
const AGENT = { type: 'agent', id: 'bot' };

/** The commercial records that must not move once the sale is done. */
const COMMERCIAL = [
  'quote', 'quote-version', 'quote-version-line', 'quote-version-component', 'quote-version-total',
  'order', 'order-line', 'order-component', 'order-total',
  'commercial-contract', 'contract-version', 'contract-line', 'subscription', 'subscription-line',
];

const keepRoot = process.env.ACCORDO_KEEP_ROOT;
const root = keepRoot ?? mkdtempSync(join(tmpdir(), 'accordo-service-journey-'));
if (keepRoot) mkdirSync(keepRoot, { recursive: true });

try {
  compose(root);

  /** The injected clock. One mutable instant; every read is canonical UTC. */
  let instant = SALE_AT;
  const clock = () => instant;
  /** Step the clock. Time never moves by itself in this journey. */
  const at = (next) => { instant = next; };

  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: join(root, 'data', 'service-journey.sqlite'), clock });

  try {
    assert.equal(app.now(), SALE_AT, 'the application reads the injected clock, not the wall clock');

    // ---- the sale, only as far as Service needs it --------------------------
    // A ServiceCoverage is activated from an activated contract's pending
    // service obligations. There is no shortcut and this journey invents none:
    // the obligation has to be raised by a real activation of a real signed
    // Order, or the coverage would be a row nobody sold.
    const contract = await sellTo(app, root);

    const obligations = app.modules.get('service-obligation').service.listWhere({ contractId: contract.id });
    assert.equal(obligations.length, 1, 'the annual support component raised exactly one service obligation');
    assert.equal(obligations[0].status, 'pending_activation');

    const commercialBefore = commercialRows(app);

    // ---- plan: read-only, and an agent may call it ---------------------------
    const plan = await act(app, 'commercial-contract', contract.id, 'plan-service-activation', {}, AGENT);
    assert.equal(plan.result.plan.decidable, true);
    assert.equal(plan.result.plan.entitlements.length, 1);
    assert.equal(plan.result.plan.entitlements[0].supportTier, 'standard');
    assert.equal(app.modules.get('service-coverage').service.list().length, 0, 'planning records nothing');

    // ---- the two refusals that make activation a decision, not a default ----
    const ambiguousRefused = await refuses(
      () => act(app, 'commercial-contract', contract.id, 'activate-service', {
        coverageKey: 'support', customerRef: 'customer:acme', startDate: COVERAGE_START,
        policy: 'b2b-service-activation-premium-only',
      }),
      (error) => error.code === 'SERVICE_ACTIVATION_AMBIGUOUS',
    );
    const agentRefused = await refuses(
      () => act(app, 'commercial-contract', contract.id, 'activate-service', {
        coverageKey: 'support', customerRef: 'customer:acme', startDate: COVERAGE_START,
      }, AGENT),
      (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
    );

    // ---- activation ---------------------------------------------------------
    const activated = await act(app, 'commercial-contract', contract.id, 'activate-service', {
      coverageKey: 'support', customerRef: 'customer:acme', startDate: COVERAGE_START,
    });
    const coverage = activated.result.serviceCoverage;
    const entitlement = activated.result.entitlements[0];
    assert.equal(coverage.status, 'active');
    assert.match(coverage.policyFingerprint, /^[0-9a-f]{64}$/, 'the activation policy version is fingerprinted');
    assert.equal(entitlement.firstResponseTargetMinutes, 240);
    assert.equal(entitlement.resolutionTargetMinutes, 2880);
    assert.equal(
      app.modules.get('service-obligation').service.listWhere({ contractId: contract.id })[0].status,
      'activated',
      'the obligation is consumed through the declared capability, by the package that owns it',
    );

    // ---- a case the entitlement genuinely covers ----------------------------
    const categoryRefused = await refuses(
      () => act(app, 'service-entitlement', entitlement.id, 'record-service-case', {
        caseKey: 'billing-question', title: 'An invoice question', category: 'billing', priority: 'normal',
      }),
      (error) => error.code === 'SERVICE_CATEGORY_NOT_COVERED',
    );

    at(CASE_OPENED_AT);
    const supportCase = (await act(app, 'service-entitlement', entitlement.id, 'record-service-case', {
      caseKey: 'sync-fails', title: 'Sync fails after the upgrade',
      description: 'It stopped overnight; the log shows a migration error.',
      category: 'bug', priority: 'high', customerContactRef: 'contact:jane',
    })).result.supportCase;
    assert.equal(supportCase.status, 'new');
    assert.equal(supportCase.openedAt, CASE_OPENED_AT, 'the case is opened at the injected instant');
    assert.equal(supportCase.firstResponseDueAt, AT_THE_BOUNDARY,
      'firstResponseDueAt is openedAt + 240 elapsed minutes, exactly');
    assert.equal(supportCase.resolutionDueAt, '2026-09-17T11:00:00.000Z');

    // ---- THE BOUNDARY -------------------------------------------------------
    // Two instants, one millisecond apart, on the same unanswered case. This is
    // the whole reason this journey exists, and no wall-clock run can see it.
    at(AT_THE_BOUNDARY);
    const onTheBoundary = (await act(app, 'support-case', supportCase.id, 'preview-sla', {}, AGENT)).result;
    assert.equal(onTheBoundary.persisted, false, 'previewing writes nothing at all');
    assert.equal(onTheBoundary.slaPreview.evaluatedAt, AT_THE_BOUNDARY);
    assert.equal(onTheBoundary.slaPreview.firstResponseState, 'at_risk',
      'at the due instant itself the target is not yet missed');

    at(ONE_MS_PAST_THE_BOUNDARY);
    const pastTheBoundary = (await act(app, 'support-case', supportCase.id, 'preview-sla', {}, AGENT)).result;
    assert.equal(pastTheBoundary.slaPreview.firstResponseState, 'breached',
      'one millisecond later it is');
    assert.equal(pastTheBoundary.slaPreview.resolutionState, 'on_track',
      'the resolution target is a separate, still-open judgement');

    // ---- the late first response, and what it does NOT do -------------------
    at(RESPONDED_AT);
    const responded = await act(app, 'support-case', supportCase.id, 'record-first-response', {
      note: 'Acknowledged; reproducing now.',
    });
    assert.equal(responded.result.supportCase.status, 'in_progress');
    assert.equal(responded.result.sent, false, 'nothing was emailed, called or messaged');
    const secondResponseRefused = await refuses(
      () => act(app, 'support-case', supportCase.id, 'record-first-response', {}),
      (error) => error.status === 409,
    );

    // The evidence a person would cite: what the clock said, at a stated
    // instant, with the inputs it used.
    const recorded = await act(app, 'support-case', supportCase.id, 'record-sla-evaluation', {
      evaluationKey: 'first-response-missed',
    });
    const evaluation = recorded.result.slaEvaluation;
    assert.equal(evaluation.firstResponseState, 'breached',
      'a first response after the due instant is breached, permanently — the record does not improve with time');
    assert.equal(evaluation.evaluatedAt, RESPONDED_AT);
    assert.equal(recorded.result.contractualBreach, false,
      'the framework records elapsed time; it does not determine that a contract was breached');
    const basisStatesNoBusinessHours = /no business hours/.test(String(evaluation.basis))
      && /no paused clock/.test(String(evaluation.basis));

    // ---- escalation: recorded by a human, routed to nobody -------------------
    const escalation = (await act(app, 'support-case', supportCase.id, 'record-escalation', {
      escalationKey: 'to-management', level: 'management',
      reason: 'the first-response target was missed and the customer asked for a call',
      targetRef: 'team:support-leads', slaEvaluationId: evaluation.id,
    })).result;
    assert.equal(escalation.routed, false, 'nothing was routed');
    assert.equal(escalation.notified, false, 'nobody was notified');
    const escalationCitesEvaluation = escalation.escalation.slaEvaluationId === evaluation.id;
    assert.equal(escalationCitesEvaluation, true,
      'the escalation cites the evaluation it was raised on, so the two records are one story');

    // ---- the state machine refuses the shortcut ------------------------------
    const shortcutRefused = await refuses(
      () => act(app, 'support-case', supportCase.id, 'transition-case', { toStatus: 'closed' }),
      (error) => error.code === 'SERVICE_TRANSITION_NOT_ALLOWED',
    );

    at(RESOLVED_AT);
    const resolved = await act(app, 'support-case', supportCase.id, 'transition-case', {
      toStatus: 'resolved', resolutionSummary: 'A schema migration was missing; applied and verified.',
    });
    assert.equal(resolved.result.customerAccepted, false, 'resolved is not customer acceptance');
    assert.equal(resolved.result.billed, false, 'nothing bills; there is no billing');

    at(CLOSED_AT);
    await act(app, 'support-case', supportCase.id, 'transition-case', { toStatus: 'closed' });
    const closedCase = app.modules.get('support-case').service.get(supportCase.id);

    const finalEvaluation = (await act(app, 'support-case', supportCase.id, 'record-sla-evaluation', {
      evaluationKey: 'at-close',
    })).result.slaEvaluation;
    assert.equal(finalEvaluation.firstResponseState, 'breached');
    assert.equal(finalEvaluation.resolutionState, 'met',
      'the resolution target was met even though the first-response target was not');

    // ---- and after all of it, the sale is exactly as it was ------------------
    const commercialAfter = commercialRows(app);
    assert.equal(commercialAfter, commercialBefore,
      'operating support amended no Quote, Order, Contract or Subscription');
    for (const absent of ['invoice', 'payment', 'renewal', 'service-contract', 'billing-eligibility']) {
      assert.throws(() => app.modules.get(absent), /Module not found/, `"${absent}" must not exist`);
    }

    const rows = (name) => app.modules.get(name).service.list({ limit: 500 }).length;
    console.log(JSON.stringify({
      ok: true,
      summary: 'Composed contracts + service and nothing else; sold one annual-support subscription through '
        + 'catalog, quote, discount policy, signature and one immutable Order; activated that Order into a '
        + 'commercial contract raising exactly one pending service obligation; refused an ambiguous activation '
        + 'and an agent actor; activated an operational ServiceCoverage with one immutable Entitlement through a '
        + 'fingerprinted versioned policy; refused an uncovered category; opened one support case on an injected '
        + 'clock and observed its first-response SLA at the due instant (at_risk) and one millisecond later '
        + '(breached); recorded a late first response that notified nobody; recorded the breach as immutable '
        + 'evidence about a stated instant that is explicitly not a contractual determination; recorded a human '
        + 'escalation citing that evidence which routed and notified nobody; refused closing straight from '
        + 'in_progress; resolved and closed the case over the declared transition table; and moved no commercial '
        + 'row in the process.',

      // ---- numbers: how many of each record this run produced ---------------
      serviceCoverages: rows('service-coverage'),
      serviceEntitlements: rows('service-entitlement'),
      serviceActivationRuns: rows('service-activation-run'),
      supportCases: rows('support-case'),
      supportCaseActivities: rows('support-case-activity'),
      slaEvaluations: rows('service-sla-evaluation'),
      escalations: rows('service-escalation'),
      commercialContracts: rows('commercial-contract'),
      serviceObligations: rows('service-obligation'),
      auditEvents: app.audit.list({ limit: 500 }).length,
      workflowRuns: app.workflows.listRuns({ limit: 500 }).length,

      // ---- facts: what the run DECIDED, which a count cannot say -------------
      coverageStatus: coverage.status,
      caseFinalStatus: closedCase.status,
      firstResponseStateAtDueInstant: onTheBoundary.slaPreview.firstResponseState,
      firstResponseStateOneMsLater: pastTheBoundary.slaPreview.firstResponseState,
      recordedFirstResponseState: evaluation.firstResponseState,
      recordedResolutionState: finalEvaluation.resolutionState,
      slaBasisStatesNoBusinessHours: basisStatesNoBusinessHours,
      contractualBreachDetermined: recorded.result.contractualBreach,
      firstResponseNotificationSent: responded.result.sent,
      escalationRouted: escalation.routed,
      escalationNotified: escalation.notified,
      escalationCitesSlaEvaluation: escalationCitesEvaluation,
      amendedCommercialRecord: activated.result.amendedCommercialRecord,
      commercialRecordUnchanged: commercialAfter === commercialBefore,
      caseBilled: resolved.result.billed,
      customerAcceptedOnResolve: resolved.result.customerAccepted,
      ambiguousActivationRefused: ambiguousRefused,
      agentActivationRefused: agentRefused,
      uncoveredCategoryRefused: categoryRefused,
      secondFirstResponseRefused: secondResponseRefused,
      closeFromInProgressRefused: shortcutRefused,
    }, null, 2));
  } finally {
    app.close();
  }
} finally {
  if (!keepRoot) rmSync(root, { recursive: true, force: true });
}

/**
 * Compose the application this journey runs against: the commercial, signature
 * and order records a sale needs, plus the **contracts** and **service**
 * packages — and deliberately nothing else.
 *
 * @param {string} root
 */
function compose(root) {
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples', 'starters', 'b2b-lead-qualification');
  for (const manifest of [
    'product.module.json', 'product-version.module.json', 'price-book.module.json',
    'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
    'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
    'quote-version.module.json', 'quote-version-line.module.json',
    'quote-version-component.module.json', 'quote-version-total.module.json',
    'quote-approval.module.json',
  ]) applyModule(root, join(root, 'packages', 'commercial', 'modules', manifest));
  for (const manifest of [
    'signature-envelope.module.json', 'signature-signer.module.json',
    'signature-event.module.json', 'signed-artifact.module.json',
    'order.module.json', 'order-line.module.json', 'order-component.module.json',
    'order-tier.module.json', 'order-total.module.json',
  ]) applyModule(root, join(starter, manifest));
  for (const manifest of [
    'contract-activation.module.json', 'commercial-contract.module.json',
    'contract-version.module.json', 'contract-line.module.json',
    'subscription.module.json', 'subscription-line.module.json',
    'delivery-obligation.module.json', 'service-obligation.module.json',
  ]) applyModule(root, join(root, 'packages', 'contracts', 'modules', manifest));
  for (const manifest of [
    'service-coverage.module.json', 'service-entitlement.module.json',
    'service-activation-run.module.json', 'support-case.module.json',
    'support-case-activity.module.json', 'service-sla-evaluation.module.json',
    'service-escalation.module.json',
  ]) applyModule(root, join(root, 'packages', 'service', 'modules', manifest));

  writeFileSync(join(root, 'packages', 'actions', 'generated', 'index.js'), [
    '// @ts-check',
    "import { buildRequestSignatureAction } from '../../core/src/signature-operations.js';",
    '',
    '// The quote actions arrive with the commercial package below.',
    'export const generatedActions = [buildRequestSignatureAction()];',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages', 'signature', 'generated', 'index.js'), [
    '// @ts-check',
    "import { fixtureSignatureProvider } from '../../../examples/starters/b2b-lead-qualification/signature.js';",
    '',
    'export const generatedSignatureProviders = [fixtureSignatureProvider];',
    '',
  ].join('\n'));
  // The composition file is the ONLY place a project names its packages.
  // Two lines, and Service reaches Contracts through a declared capability.
  writeFileSync(join(root, 'packages', 'domains', 'generated', 'index.js'), [
    '// @ts-check',
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    'import {',
    '  fixtureSaasCatalogProvider,',
    '  standardSalesDiscountV1,',
    '  standardSalesDiscountV2,',
    "} from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
    "import { createContractsDomain } from '../../contracts/src/index.js';",
    "import { createServicePackage } from '../../service/src/index.js';",
    "import { b2bSaasOrderActivationV1, b2bSaasOrderActivationV2 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';",
    'import {',
    '  b2bServiceActivationV1,',
    '  b2bServiceActivationPremiumOnlyV1,',
    "} from '../../../examples/starters/b2b-lead-qualification/service.js';",
    '',
    'export const generatedDomains = [',
    '  createCommercialDomain({',
    '    catalogProviders: [fixtureSaasCatalogProvider],',
    '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
    '  }),',
    '  createContractsDomain({ policies: [b2bSaasOrderActivationV1, b2bSaasOrderActivationV2] }),',
    '  createServicePackage({ policies: [b2bServiceActivationV1, b2bServiceActivationPremiumOnlyV1] }),',
    '];',
    '',
  ].join('\n'));
}

/**
 * Drive one sale to an **activated** contract, only as far as Service needs it:
 * an enterprise platform line, a one-time setup and the annual support that
 * becomes the service obligation this whole journey is about.
 *
 * @param {any} app @param {string} root
 */
async function sellTo(app, root) {
  const { signatureFixture } = await import(
    pathToFileURL(join(root, 'examples/starters/b2b-lead-qualification/signature.js')).href);

  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offerOf = (key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];

  const company = await app.services.companies.create({ name: 'Acme SpA' }, { actor: ACTOR });
  const contact = await app.services.contacts.create(
    { companyId: company.id, firstName: 'Mario', lastName: 'Rossi', email: 'mario.rossi@acme.example' },
    { actor: ACTOR },
  );
  const opportunity = await app.services.opportunities.create({
    companyId: company.id, contactId: contact.id, name: 'Acme platform + support',
    type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'journey',
  }, { actor: ACTOR });

  const quote = (await act(app, 'opportunity', opportunity.id, 'create-quote', { priceBookId: book.id })).result.quote;
  for (const key of ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual']) {
    await act(app, 'quote', quote.id, 'add-line', { offerId: offerOf(key).id, quantity: 20, discountBps: 500 });
  }
  const submitted = await act(app, 'quote', quote.id, 'submit', { policy: 'standard-sales-discount', version: 1 });
  if (submitted.result.version.decision === 'approval_required') {
    await act(app, 'quote', quote.id, 'approve', {});
  }
  await act(app, 'quote', quote.id, 'request-signature', {
    quoteVersionId: submitted.result.version.id,
    provider: 'fixture-signature', providerVersion: 1,
    signers: [{ name: 'Mario Rossi', email: 'mario.rossi@acme.example', role: 'customer' }],
  });
  const envelope = app.modules.get('signature-envelope').service
    .listWhere({ quoteVersionId: submitted.result.version.id })[0];
  signatureFixture.markCompleted(envelope.idempotencyKey);
  const event = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: 'evt_service_journey' });
  await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: event.rawBody, headers: event.headers });

  const order = app.modules.get('order').service.listWhere({ quoteVersionId: submitted.result.version.id })[0];
  assert.ok(order, 'a verified completion produced exactly one immutable Order');
  await act(app, 'order', order.id, 'activate-contract', {
    policy: 'b2b-saas-order-activation', policyVersion: 1, ...TERM,
  });
  const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: order.id })[0];
  assert.ok(contract, 'the signed Order activated into exactly one commercial contract');
  return contract;
}

/** Every commercial row, as bytes, so "nothing was amended" is proved not argued. */
function commercialRows(app) {
  return JSON.stringify(COMMERCIAL.map((module) => app.modules.get(module).service.list({ limit: 500 })));
}

/** @param {any} app */
function act(app, module, recordId, action, input, actor = ACTOR) {
  return app.runAction({ module, action, recordId, input, actor });
}

/**
 * Run something that must be refused, and report **that it was** as a fact.
 *
 * A refusal is published as a positive boolean rather than as an absence: a
 * report that said "no case was created" could be produced by a run that never
 * tried, and safety evidence that a run can earn by doing nothing is worthless.
 *
 * @param {() => Promise<any>} attempt @param {(error: any) => boolean} expected
 */
async function refuses(attempt, expected) {
  try {
    await attempt();
  } catch (error) {
    assert.equal(expected(error), true, `refused, but not in the expected way: ${String(error?.code ?? error)}`);
    return true;
  }
  assert.fail('the operation was expected to be refused and was not');
  return false;
}

/** @param {string} root @param {string} manifestPath */
function applyModule(root, manifestPath) {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), 'module', 'create', manifestPath, '--apply', '--root', root],
    { encoding: 'utf8', cwd: root },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to apply ${manifestPath}:\n${result.stdout}\n${result.stderr}`);
  }
}
