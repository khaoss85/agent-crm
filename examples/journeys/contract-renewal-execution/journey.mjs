// @ts-check

/**
 * **Signed renewal → governed successor agreement**, on an injected clock.
 *
 * The third journey `crm scenario run` knows how to execute
 * (`packages/cli/src/scenario-journey.js`), and it exists for one reason the
 * other two cannot serve: **M16b's central claim is a refusal, and a refusal is
 * only evidence when a run actually attempts it.**
 *
 * The claim is narrow and expensive to get wrong. A renewal produces a
 * *successor commercial agreement* — its own signed Order, its own document
 * hash, its own term, its own Subscription — plus one immutable lineage row, and
 * **it is built only from a term the customer actually signed** (ADR-033). An
 * Order whose signed document carried no term is refused outright; its dates are
 * post-signature operational metadata, and nothing here promotes those into a
 * signed renewal term. This journey attempts that Order, and publishes the
 * refusal as a positive fact.
 *
 * ### It is a materially different composition, on purpose
 *
 * `commercial` + `signature` + `contracts` + `lifecycle`, and nothing else: no
 * `intelligence`, no `delivery`, no `service`, no `work`, no customer package,
 * no Lead or Task module. Lifecycle reaches Contracts through two declared
 * capabilities — `contract-lifecycle-source@2` and
 * `contracts-successor-activation@1` — and imports nothing from it, so a
 * composition without Delivery and without Service is the honest demonstration
 * of that boundary rather than an assertion about it (ADR-018).
 *
 * ### Why the clock is injected
 *
 * Not because anything here is time-dependent — nothing in M16b runs on a clock,
 * and that is the point. It is injected so the two terms are *fixed business
 * facts*: a source term ending 2027-08-31 and a successor term starting
 * 2027-09-01 are `contiguous` with `gapDays: 0` under the inclusive-end-date
 * rule, on any day this journey is ever run, and the successor contract is
 * `scheduled` because its term is in the future and **nothing transitions it**.
 * On a wall clock both facts would drift with the calendar.
 *
 * ### What it does NOT do — read this before writing a claim about it
 *
 * - **Nothing renews automatically.** There is no scheduler. `autoRenew` and
 *   `renewalNoticeDays` are recorded only, on both provenances, and the run
 *   publishes that nothing fired on them.
 * - **Nobody was notified.** No customer, signer or colleague is told that any
 *   of this happened, and the run publishes that as `false` rather than leaving
 *   it unsaid.
 * - **Nothing was billed.** No invoice, payment, tax, proration or revenue
 *   recognition exists to follow from an execution, and no MRR/ARR/TCV is
 *   derived anywhere.
 * - **Nothing historical moved.** The source agreement, its version, its lines
 *   and its subscription are fingerprinted as bytes before and after, and the
 *   run proves they are identical rather than arguing it.
 * - **Succeeding an agreement is not cancelling it.** There are no cancellation
 *   primitives, and this run creates none.
 * - There is no auth, tenancy or RBAC anywhere in this framework, so "a human
 *   did it" means an actor object said so.
 *
 * Run it directly:
 *   `node examples/journeys/contract-renewal-execution/journey.mjs`
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

/** The injected instant every write in this run is stamped with. */
const NOW = '2026-09-15T10:00:00.000Z';

/**
 * The two terms, as fixed business facts.
 *
 * `termEndDate` is **inclusive**, which decides the arithmetic: a successor
 * starting 2027-09-01 begins the day after a source ending 2027-08-31, so the
 * pair is `contiguous` with `gapDays: 0` — not one day later.
 */
const SOURCE_TERM = {
  effectiveDate: '2026-09-01', termStartDate: '2026-09-01', termEndDate: '2027-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};
const SUCCESSOR_TERM = {
  effectiveDate: '2027-09-01', termStartDate: '2027-09-01', termEndDate: '2028-08-31',
  autoRenew: true, renewalNoticeDays: 60,
};

const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:support-annual'];
const POLICY = { policy: 'b2b-saas-order-activation', policyVersion: 1 };
const ACTOR = { type: 'user', id: 'journey' };
const AGENT = { type: 'agent', id: 'bot' };

/** The rows of the SOURCE agreement that must be byte-identical afterwards. */
const HISTORICAL = [
  'commercial-contract', 'contract-version', 'contract-line',
  'subscription', 'subscription-line', 'contract-activation',
];

const keepRoot = process.env.ACCORDO_KEEP_ROOT;
const root = keepRoot ?? mkdtempSync(join(tmpdir(), 'accordo-renewal-journey-'));
if (keepRoot) mkdirSync(keepRoot, { recursive: true });

try {
  compose(root);
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const app = createAccordoApp({ dbPath: join(root, 'data', 'accordo.sqlite'), clock: () => NOW });
  try {
    // ---- the source agreement, on a SIGNED term -------------------------
    const source = await sell(app, root, { name: 'Renewal Journey', term: SOURCE_TERM });
    await act(app, 'order', source.order.id, 'activate-contract', { ...POLICY });
    const contract = app.modules.get('commercial-contract').service.listWhere({ orderId: source.order.id })[0];
    assert.ok(contract, 'the signed Order activated into exactly one commercial contract');
    assert.equal(contract.termsSource, 'signed-order-terms',
      'the source agreement carries the term the customer signed, not one typed afterwards');

    const historicalBefore = fingerprint(app);

    // ---- three successor Orders: one wrong, one unsigned, one real ------
    const stranger = await sell(app, root, { name: 'Renewal Journey Stranger', term: SUCCESSOR_TERM });
    const unsigned = await sell(app, root, {
      name: 'Renewal Journey Unsigned', company: source.company, contact: source.contact,
    });
    const successorOrder = await sell(app, root, {
      name: 'Renewal Journey Successor', company: source.company, contact: source.contact,
      term: SUCCESSOR_TERM, quantities: { 'fixture:offer:enterprise': 30 },
    });
    assert.equal(app.modules.get('order-term').service.listWhere({ orderId: unsigned.order.id }).length, 0,
      'the unsigned-term Order genuinely carries no signed term snapshot');

    // ---- planning writes nothing ---------------------------------------
    const beforePlan = rowCounts(app);
    const plan = (await act(app, 'commercial-contract', contract.id, 'plan-amendment', {
      successorOrderId: successorOrder.order.id, ...POLICY,
    })).result;
    const planWroteNothing = JSON.stringify(rowCounts(app)) === JSON.stringify(beforePlan);
    assert.equal(plan.writes, 'nothing — this is a read-only plan');
    assert.equal(plan.succession.coherent, true, JSON.stringify(plan.succession.refusals));

    // ---- the refusal this milestone exists for -------------------------
    const unsignedPlan = (await act(app, 'commercial-contract', contract.id, 'plan-amendment', {
      successorOrderId: unsigned.order.id, ...POLICY,
    })).result.succession;
    const unsignedTermRefused = unsignedPlan.refusals.some((entry) => entry.code === 'SUCCESSOR_TERMS_NOT_SIGNED');
    assert.equal(unsignedTermRefused, true, 'an Order whose signed document carried no term must be refused');
    assert.equal(unsignedPlan.successor.term, null, 'and no term is invented for it');

    // ---- the governed round --------------------------------------------
    const agentRefused = await refuses(
      () => act(app, 'commercial-contract', contract.id, 'open-amendment-run', { reason: 'agent tried' }, AGENT),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
    );
    const run = (await act(app, 'commercial-contract', contract.id, 'open-amendment-run', {
      reason: 'annual renewal cycle', asOf: '2026-09-15',
    })).result;
    assert.equal(run.state, 'planned');
    assert.equal(run.round, 1);

    // A pairing waiting will never fix is refused at attach rather than parked.
    const strangerRefused = await refuses(
      () => act(app, 'amendment-run', run.id, 'attach-successor-order', { successorOrderId: stranger.order.id, ...POLICY }),
      (error) => error.code === 'SUCCESSOR_CUSTOMER_MISMATCH',
    );

    // A pairing a maturing Order could still fix parks the round instead.
    const parked = (await act(app, 'amendment-run', run.id, 'attach-successor-order', {
      successorOrderId: unsigned.order.id, ...POLICY,
    })).result;
    assert.equal(parked.state, 'awaiting_signed_order');
    const executeFromParkedRefused = await refuses(
      () => act(app, 'amendment-run', run.id, 'execute-amendment', { ...POLICY }),
      (error) => error.code === 'AMENDMENT_RUN_NOT_READY',
    );

    const ready = (await act(app, 'amendment-run', run.id, 'attach-successor-order', {
      successorOrderId: successorOrder.order.id, ...POLICY,
    })).result;
    assert.equal(ready.state, 'ready');

    const executeAsAgentRefused = await refuses(
      () => act(app, 'amendment-run', run.id, 'execute-amendment', { ...POLICY }, AGENT),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
    );

    // ---- execution ------------------------------------------------------
    const executed = (await act(app, 'amendment-run', run.id, 'execute-amendment', { ...POLICY })).result;
    assert.equal(executed.replay, false);
    const successorContract = app.modules.get('commercial-contract').service.get(executed.successorContractId);
    const successorSubscription = app.modules.get('subscription').service.listWhere({ contractId: successorContract.id })[0];
    const lineage = app.modules.get('contract-succession').service.listWhere({ sourceContractId: contract.id })[0];
    assert.ok(lineage, 'exactly one immutable lineage row');
    assert.equal(lineage.successorContractId, successorContract.id);
    assert.equal(lineage.successorOrderId, successorOrder.order.id);

    // ---- history is byte-identical --------------------------------------
    const historicalAfter = fingerprint(app, historicalBefore.ids);
    const historyUnchanged = historicalAfter.bytes === historicalBefore.bytes;
    assert.equal(historyUnchanged, true, 'the source agreement was rewritten, which this milestone must never do');

    // ---- a lost response replays; it never produces a second successor ---
    const replayed = (await act(app, 'amendment-run', run.id, 'execute-amendment', { ...POLICY })).result;
    assert.equal(replayed.replay, true);
    assert.equal(app.modules.get('contract-succession').service.list({ limit: 500 }).length, 1);

    // ---- and the agreement is closed to further rounds forever -----------
    const secondRoundRefused = await refuses(
      () => act(app, 'commercial-contract', contract.id, 'open-amendment-run', { reason: 'again' }),
      (error) => error.code === 'CONFLICTING_SUCCESSOR',
    );
    const consumedOrderRefused = await refuses(
      () => act(app, 'order', successorOrder.order.id, 'activate-contract', { ...POLICY }),
      (error) => error.code === 'ORDER_ALREADY_ACTIVATED',
    );

    // ---- nothing exists that would bill, schedule or notify --------------
    for (const absent of ['invoice', 'payment', 'renewal-schedule', 'notification', 'billing-eligibility']) {
      assert.throws(() => app.modules.get(absent), /Module not found/, `"${absent}" must not exist`);
    }

    const rows = (name) => app.modules.get(name).service.list({ limit: 500 }).length;
    console.log(JSON.stringify({
      ok: true,
      summary: 'Composed commercial + signature + contracts + lifecycle and nothing else; sold and signed one '
        + 'agreement carrying a SIGNED commercial term and activated it; produced three further signed Orders — '
        + 'one for another customer, one whose signed document carried no term, and one for the same customer '
        + 'with its own signed term and one quantity raised; planned the renewal read-only and proved the plan '
        + 'wrote nothing; refused the Order with no signed term rather than promoting its operational dates; '
        + 'refused an agent actor at every writing step; refused the wrong customer at attach rather than parking '
        + 'it; parked the unsigned-term Order and refused to execute from that state; executed the successor as a '
        + 'human into its own contract, version, lines, subscription and one immutable 1:1:1 lineage row carrying '
        + 'a classification DERIVED from the line delta; proved the source agreement is byte-identical afterwards; '
        + 'replayed a lost response without producing a second successor; refused a second round and a standalone '
        + 'activation of the consumed Order; and billed, scheduled and notified nothing, because none of it exists.',

      // ---- numbers: how many of each record this run produced -------------
      commercialContracts: rows('commercial-contract'),
      contractSuccessions: rows('contract-succession'),
      amendmentRuns: rows('amendment-run'),
      subscriptions: rows('subscription'),
      contractVersions: rows('contract-version'),
      orders: rows('order'),
      orderTerms: rows('order-term'),
      auditEvents: app.audit.list({ limit: 500 }).length,
      workflowRuns: app.workflows.listRuns({ limit: 500 }).length,

      // ---- facts: what the run DECIDED, which a count cannot say ----------
      // The raw provenance strings, for a human reading the report — and the
      // same two facts as booleans, because a scenario observation may only
      // name a lowercase token and a provenance carries hyphens.
      sourceTermsSource: contract.termsSource,
      successorTermsSource: successorContract.termsSource,
      sourceTermIsSignedOrderTerms: contract.termsSource === 'signed-order-terms',
      successorTermIsSignedOrderTerms: successorContract.termsSource === 'signed-order-terms',
      sourceTermSigned: lineage.sourceTermSigned === true || lineage.sourceTermSigned === 1,
      successorContractStatus: successorContract.status,
      successorHasOwnSubscription: Boolean(successorSubscription) && successorSubscription.contractId === successorContract.id,
      planWroteNothing,
      classification: executed.classification,
      classificationDerivedNotSupplied: executed.classificationBasis === plan.succession.classificationBasis,
      termContinuity: executed.termContinuity,
      termGapDays: executed.termGapDays,
      termContinuityGapDaysIsZero: executed.termGapDays === 0,
      lineageIsOneToOne: rows('contract-succession') === 1
        && lineage.sourceContractId === contract.id
        && lineage.successorContractId === successorContract.id,
      historyUnchanged,
      replayProducedNoSecondSuccessor: replayed.replay === true && rows('contract-succession') === 1,

      // ---- refusals, published as positive facts --------------------------
      unsignedTermRefused,
      agentOpenRefused: agentRefused,
      agentExecuteRefused: executeAsAgentRefused,
      strangerCustomerRefused: strangerRefused,
      executeFromParkedRefused,
      secondRoundRefused,
      consumedOrderRefused,

      // ---- the omissions, stated rather than implied ----------------------
      anythingScheduled: false,
      anybodyNotified: false,
      anythingBilled: false,
      anythingCancelled: false,
      revenueFigureDerived: false,
    }, null, 2));
  } finally {
    app.close();
  }
} finally {
  if (!keepRoot) rmSync(root, { recursive: true, force: true });
}

/* --------------------------------------------------------------- helpers */

/** @param {any} app */
function act(app, module, recordId, action, input, actor = ACTOR) {
  return app.runAction({ module, action, recordId, input, actor });
}

/**
 * Run something that must be refused, and report **that it was** as a fact.
 *
 * A refusal is published as a positive boolean rather than as an absence: a
 * report that said "no successor was created" could be produced by a run that
 * never tried, and safety evidence a run can earn by doing nothing is worthless.
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

/** Row counts across every module, so "the plan wrote nothing" is a comparison. */
function rowCounts(app) {
  const counts = {};
  for (const module of app.modules.list()) {
    counts[module.name] = app.modules.get(module.name).service.list({ limit: 500 }).length;
  }
  return counts;
}

/**
 * The SOURCE agreement's rows as bytes.
 *
 * On the second call the ids recorded by the first are used, so a successor's
 * brand-new rows never enter the comparison — the claim is that *these* rows did
 * not move, not that no row was ever added.
 *
 * @param {any} app @param {Set<string>} [only]
 */
function fingerprint(app, only) {
  const ids = new Set();
  const parts = [];
  for (const module of HISTORICAL) {
    const rows = app.modules.get(module).service.list({ limit: 500 })
      .filter((row) => (only ? only.has(`${module}:${row.id}`) : true))
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const row of rows) {
      ids.add(`${module}:${row.id}`);
      parts.push(`${module}:${JSON.stringify(row)}`);
    }
  }
  return { ids, bytes: parts.join('\n') };
}

/** Drive one sale from catalog to a verified, signed, immutable Order. */
async function sell(app, projectRoot, { name, term = null, company = null, contact = null, quantities = {} }) {
  const { signatureFixture } = await import(
    pathToFileURL(join(projectRoot, 'examples/starters/b2b-lead-qualification/signature.js')).href);
  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offerOf = (key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
  const co = company ?? await app.services.companies.create({ name: `${name} SpA` }, { actor: ACTOR });
  const ct = contact ?? await app.services.contacts.create(
    { companyId: co.id, firstName: 'Mario', lastName: 'Rossi', email: `m.${slug(name)}@example.com` }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create({
    companyId: co.id, contactId: ct.id, name, type: 'new_business',
    valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'journey',
  }, { actor: ACTOR });
  const quote = (await act(app, 'opportunity', opportunity.id, 'create-quote', { priceBookId: book.id })).result.quote;
  for (const key of OFFERS) {
    await act(app, 'quote', quote.id, 'add-line', {
      offerId: offerOf(key).id, quantity: quantities[key] ?? 20, discountBps: 500,
    });
  }
  // The ADR-033 chain starts here: a draft term on the quote, frozen by submit
  // into the version snapshot, embedded in the signed document and covered by
  // its hash. Omitting it is how the "no signed term" Order is built.
  if (term) await app.modules.get('quote-term').service.create({ quoteId: quote.id, ...term }, { actor: ACTOR });
  const submitted = await act(app, 'quote', quote.id, 'submit', { policy: 'standard-sales-discount', version: 1 });
  if (submitted.result.version.decision === 'approval_required') {
    await act(app, 'quote', quote.id, 'approve', {});
  }
  await act(app, 'quote', quote.id, 'request-signature', {
    quoteVersionId: submitted.result.version.id, provider: 'fixture-signature', providerVersion: 1,
    signers: [{ name: 'Mario Rossi', email: `sign.${slug(name)}@example.com`, role: 'customer' }],
  });
  const envelope = app.modules.get('signature-envelope').service
    .listWhere({ quoteVersionId: submitted.result.version.id })[0];
  signatureFixture.markCompleted(envelope.idempotencyKey);
  const event = signatureFixture.event(envelope.idempotencyKey, 'completed', { providerEventId: `evt_${slug(name)}` });
  await app.ingestSignatureEvent({ provider: 'fixture-signature', rawBody: event.rawBody, headers: event.headers });
  const order = app.modules.get('order').service.listWhere({ quoteVersionId: submitted.result.version.id })[0];
  assert.ok(order, `a verified completion produced exactly one immutable Order for "${name}"`);
  return { order, quote, company: co, contact: ct };
}

/** @param {string} text */
function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Compose the application this journey runs against: the commercial, signature
 * and order records a sale needs, plus the **contracts** and **lifecycle**
 * packages — and deliberately nothing else.
 *
 * @param {string} projectRoot
 */
function compose(projectRoot) {
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(projectRoot, entry), { recursive: true });
  }
  for (const manifest of [
    'product.module.json', 'product-version.module.json', 'price-book.module.json',
    'offer.module.json', 'price-component.module.json', 'price-tier.module.json',
    'catalog-sync-run.module.json', 'quote.module.json', 'quote-line.module.json',
    'quote-version.module.json', 'quote-version-line.module.json',
    'quote-version-component.module.json', 'quote-version-total.module.json',
    'quote-approval.module.json', 'quote-term.module.json', 'quote-version-term.module.json',
  ]) applyModule(projectRoot, join(projectRoot, 'packages', 'commercial', 'modules', manifest));
  for (const manifest of [
    'signature-envelope.module.json', 'signature-signer.module.json',
    'signature-event.module.json', 'signed-artifact.module.json',
    'order.module.json', 'order-line.module.json', 'order-component.module.json',
    'order-tier.module.json', 'order-total.module.json', 'order-term.module.json',
  ]) applyModule(projectRoot, join(projectRoot, 'packages', 'signature', 'modules', manifest));
  for (const manifest of [
    'contract-activation.module.json', 'commercial-contract.module.json',
    'contract-version.module.json', 'contract-line.module.json',
    'subscription.module.json', 'subscription-line.module.json',
    'delivery-obligation.module.json', 'service-obligation.module.json',
    'contract-succession.module.json',
  ]) applyModule(projectRoot, join(projectRoot, 'packages', 'contracts', 'modules', manifest));
  for (const manifest of [
    'renewal-decision.module.json', 'commercial-followup.module.json', 'amendment-run.module.json',
  ]) applyModule(projectRoot, join(projectRoot, 'packages', 'lifecycle', 'modules', manifest));

  writeFileSync(join(projectRoot, 'packages', 'actions', 'generated', 'index.js'), [
    '// @ts-check',
    '// The quote actions arrive with the commercial package, request-signature',
    '// with signature, and the amendment actions with lifecycle.',
    'export const generatedActions = [];',
    '',
  ].join('\n'));
  writeFileSync(join(projectRoot, 'packages', 'domains', 'generated', 'index.js'), [
    "import { createCommercialDomain } from '../../commercial/src/index.js';",
    "import { fixtureSaasCatalogProvider, standardSalesDiscountV1, standardSalesDiscountV2 } from '../../../examples/starters/b2b-lead-qualification/commercial.js';",
    "import { createSignatureDomain } from '../../signature/src/index.js';",
    "import { fixtureSignatureProvider } from '../../../examples/starters/b2b-lead-qualification/signature.js';",
    "import { createContractsDomain } from '../../contracts/src/index.js';",
    "import { b2bSaasOrderActivationV1, b2bSaasOrderActivationV2 } from '../../../examples/starters/b2b-lead-qualification/contracts.js';",
    "import { createLifecyclePackage } from '../../lifecycle/src/index.js';",
    'export const generatedDomains = [',
    '  createCommercialDomain({',
    '    catalogProviders: [fixtureSaasCatalogProvider],',
    '    discountPolicies: [standardSalesDiscountV1, standardSalesDiscountV2],',
    '  }),',
    '  createSignatureDomain({ signatureProviders: [fixtureSignatureProvider] }),',
    '  createContractsDomain({ policies: [b2bSaasOrderActivationV1, b2bSaasOrderActivationV2] }),',
    '  createLifecyclePackage(),',
    '];',
    '',
  ].join('\n'));
}

/** @param {string} projectRoot @param {string} manifestPath */
function applyModule(projectRoot, manifestPath) {
  const result = spawnSync(
    process.execPath,
    ['--no-warnings', join(projectRoot, 'packages/cli/bin/accordo.js'), 'module', 'create', manifestPath, '--apply', '--root', projectRoot],
    { encoding: 'utf8', cwd: projectRoot },
  );
  if (result.status !== 0) {
    throw new Error(`Failed to apply ${manifestPath}:\n${result.stdout}\n${result.stderr}`);
  }
}
