import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readQuoteVersionEvidence, renderQuoteVersionPdf } from '../packages/commercial/src/quote-pdf.js';
import { VAT_RATE_BPS, vatAmountCents, withVatTotals } from '../packages/commercial/src/money.js';
import { project, boot } from './helpers/contracts-project.js';

/**
 * Frozen VAT on the backoffice quote (accordo BO-F2-03, second slice):
 * subtotale + IVA 22% + totale per commercial period, pinned at submit.
 *
 * VAT is a statutory constant, not catalog data: submit freezes the rate
 * and every amount inside the version row's totalsJson, the PDF evidence
 * reads that frozen view (never the live catalog), and a version frozen
 * before VAT renders with no VAT section, exactly as before.
 */

const ACTOR = { type: 'user', id: 'quote-vat' };

function servicesOf(app) {
  const service = (name) => app.modules.get(name).service;
  return {
    versions: service('quote-version'),
    lines: service('quote-version-line'),
    components: service('quote-version-component'),
    totals: service('quote-version-total'),
    terms: service('quote-version-term'),
  };
}

/** Same rendering as the document (integer cents, two decimals). */
function eur(cents) {
  return `${Math.trunc(cents / 100)}.${String(Math.abs(cents % 100)).padStart(2, '0')} EUR`;
}

/** A real PDF: every xref entry lands on the object it names. */
function assertXrefValid(bytes) {
  const text = bytes.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'), 'a PDF header opens the bytes');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'the EOF marker closes the bytes');
}

test('money: VAT is integer-only, truncating, never rounding up', () => {
  assert.equal(VAT_RATE_BPS, 2200, 'the pinned statutory rate is 22%');
  assert.equal(vatAmountCents(10_000), 2_200, '22% of 100.00 EUR');
  assert.equal(vatAmountCents(199), 43, '199c × 22% = 43.78c truncates to 43c');
  assert.equal(vatAmountCents(0), 0, 'zero net carries zero VAT');
});

test('money: withVatTotals keeps groups separate with one gross figure each', () => {
  const totals = {
    oneTimeTotal: { currency: 'EUR', listAmountCents: 10_000, discountAmountCents: 500, netAmountCents: 9_500 },
    recurringTotals: [
      { currency: 'EUR', interval: 'month', intervalCount: 1, listAmountCents: 3_000, discountAmountCents: 300, netAmountCents: 2_700 },
    ],
  };
  const taxed = withVatTotals(totals);
  assert.equal(taxed.oneTimeTotal, totals.oneTimeTotal, 'the net groups travel verbatim');
  assert.equal(taxed.vatRateBps, 2200, 'the rate pins onto the frozen view');
  assert.deepEqual(
    [taxed.vat.oneTime.vatAmountCents, taxed.vat.oneTime.grossAmountCents],
    [Math.trunc(9_500 * 2200 / 10_000), 9_500 + Math.trunc(9_500 * 2200 / 10_000)],
    'one-time VAT and gross follow the trunc rule',
  );
  assert.equal(taxed.vat.recurring.length, 1, 'one VAT entry per recurring group');
  assert.equal(taxed.vat.recurring[0].grossAmountCents, 2_700 + Math.trunc(2_700 * 2200 / 10_000), 'recurring gross follows the trunc rule');
  assert.ok(!('grandTotal' in taxed) && !('totalGross' in taxed), 'unlike periods are never summed');
});

test('quote VAT: submit freezes subtotale, IVA 22% and totale per period', async (t) => {
  const root = project(t, { withDomain: false });
  const context = await boot(root, join(root, 'data', 'quote-vat.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offerOf = (key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
  const company = await app.services.companies.create({ name: 'IVA SpA' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'IVA deal', type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'quote-vat' },
    { actor: ACTOR },
  );
  const quote = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor: ACTOR,
  })).result.quote;

  // v1 submits with a rejecting discount; the refusal keeps the draft (BO-F2-04),
  // so v2 carries the story's presets — 0%, 5%, 10% — with no revise step.
  const added = await app.runAction({
    module: 'quote', action: 'add-line', recordId: quote.id,
    input: { offerId: offerOf('fixture:offer:enterprise').id, quantity: 2, discountBps: 6000 }, actor: ACTOR,
  });
  const submitted = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR,
  });
  assert.equal(submitted.result.version.decision, 'reject', 'a 60% line discount rejects, so the draft can move on');
  const v1 = submitted.result.version;

  const evidence = await readQuoteVersionEvidence(servicesOf(app), v1.id);
  assert.equal(evidence.version.vatRateBps, 2200, 'the version pins the 22% rate');
  assert.ok(evidence.totals.length > 0, 'the version carries frozen totals');
  for (const total of evidence.totals) {
    const expectedVat = Math.trunc(total.netAmountCents * 2200 / 10_000);
    assert.equal(total.vatAmountCents, expectedVat, `VAT follows the trunc rule (${total.kind})`);
    assert.equal(total.grossAmountCents, total.netAmountCents + expectedVat, `gross is net + VAT (${total.kind})`);
  }

  const pdf = renderQuoteVersionPdf(evidence);
  assertXrefValid(pdf.pdfBytes);
  const text = pdf.pdfBytes.toString('latin1');
  assert.ok(text.includes('IVA 22%'), 'the document prints the VAT rate');
  const oneTime = evidence.totals.find((total) => total.kind === 'one_time');
  // The PDF escapes parentheses, so the assertions match the escaped bytes.
  const period = '\\(una tantum\\)';
  assert.ok(text.includes(`Subtotale ${period}: ${eur(oneTime.netAmountCents)} netti`), 'the net subtotal prints');
  assert.ok(text.includes(`IVA 22% ${period}: ${eur(oneTime.vatAmountCents)}`), 'the VAT amount prints');
  assert.ok(text.includes(`Totale IVA inclusa ${period}: ${eur(oneTime.grossAmountCents)}`), 'the gross total prints');

  // The draft moves on: v1 keeps its frozen VAT while v2 freezes its own with
  // the story's discount presets (0%, 5%, 10%).
  await app.runAction({
    module: 'quote', action: 'update-line', recordId: quote.id,
    input: { lineId: added.result.line.id, quantity: 2, discountBps: 0 }, actor: ACTOR,
  });
  await app.runAction({
    module: 'quote', action: 'add-line', recordId: quote.id,
    input: { offerId: offerOf('fixture:offer:api-monthly').id, quantity: 3, discountBps: 500 }, actor: ACTOR,
  });
  await app.runAction({
    module: 'quote', action: 'add-line', recordId: quote.id,
    input: { offerId: offerOf('fixture:offer:support-annual').id, quantity: 1, discountBps: 1000 }, actor: ACTOR,
  });
  const resubmitted = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR,
  });
  if (resubmitted.result.version.decision === 'approval_required') {
    await app.runAction({ module: 'quote', action: 'approve', recordId: quote.id, input: {}, actor: ACTOR });
  }
  const v2 = await readQuoteVersionEvidence(servicesOf(app), resubmitted.result.version.id);
  assert.deepEqual(
    v2.lines.map((line) => line.discountBps).sort((a, b) => a - b),
    [0, 500, 1000],
    'v2 freezes the story discount presets: 0%, 5% and 10%',
  );
  for (const total of v2.totals) {
    assert.equal(total.grossAmountCents, total.netAmountCents + Math.trunc(total.netAmountCents * 2200 / 10_000), `v2 gross follows the trunc rule (${total.kind})`);
  }
  const frozenAgain = await readQuoteVersionEvidence(servicesOf(app), v1.id);
  assert.deepEqual(
    frozenAgain.totals.map(({ vatAmountCents: vat, grossAmountCents: gross }) => [vat, gross]),
    evidence.totals.map(({ vatAmountCents: vat, grossAmountCents: gross }) => [vat, gross]),
    'v1 VAT never moves with the draft',
  );
  assert.deepEqual(renderQuoteVersionPdf(frozenAgain).pdfBytes, pdf.pdfBytes, 'v1 renders byte-identical after revise and v2');
});

test('quote PDF: a pre-VAT version renders with no VAT section', () => {
  const evidence = {
    version: {
      id: 'qv-old', versionNumber: 1, quoteId: 'q1', opportunityId: null,
      priceBookId: 'pb1', currency: 'EUR', submittedAt: '2026-10-20T00:00:00.000Z',
      submittedBy: 'u1', policy: null, policyVersion: null, policyDecision: null,
      maxLineDiscountBps: 0, effectiveDiscountBps: 0, vatRateBps: null,
    },
    lines: [{
      offerName: 'Old', offerLogicalKey: null, offerRevision: null, sku: null,
      quantity: 1, discountBps: 0, position: 1,
      listAmountCents: 10_000, discountAmountCents: 0, netAmountCents: 10_000,
      components: [],
    }],
    totals: [{
      kind: 'one_time', currency: 'EUR', interval: null, intervalCount: null,
      listAmountCents: 10_000, discountAmountCents: 0, netAmountCents: 10_000,
      vatAmountCents: null, grossAmountCents: null,
    }],
    terms: null,
  };
  const text = renderQuoteVersionPdf(evidence).pdfBytes.toString('latin1');
  assert.ok(!text.includes('IVA'), 'no VAT section is invented for a pre-VAT version');
  assert.ok(text.includes('Subtotale \\(una tantum\\): 100.00 EUR netti'), 'the net subtotal still prints');
});
