import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readQuoteVersionEvidence, renderQuoteVersionPdf } from '../packages/commercial/src/quote-pdf.js';
import { requireSignedTerm } from '../packages/commercial/src/terms.js';
import { project, boot } from './helpers/contracts-project.js';

/**
 * Frozen-version quote PDF (accordo BO-F2-03, first slice): the backoffice
 * "anteprima PDF" renders the immutable quote version, never the live draft.
 * The journey below submits v1, renders it, moves the draft on (revise +
 * resubmit as v2) and proves the v1 bytes never move with it.
 */

const ACTOR = { type: 'user', id: 'quote-pdf' };

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

/** A real PDF: every xref entry lands on the object it names. */
function assertXrefValid(bytes) {
  const text = bytes.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4\n'), 'a PDF header opens the bytes');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'the EOF marker closes the bytes');
  const xrefAt = text.indexOf('\nxref\n');
  assert.ok(xrefAt > 0, 'a cross-reference table is present');
  const lines = text.slice(xrefAt).split('\n');
  assert.deepEqual(lines.slice(0, 2), ['', 'xref'], 'the table opens the xref section');
  assert.ok(/^0 \d+$/.test(lines[2]), 'a single subsection header follows xref');
  const entries = lines.slice(3);
  let id = 0;
  for (const entry of entries) {
    if (/^trailer$/.test(entry)) break;
    const match = /^(\d{10}) \d{5} ([fn]) $/.exec(entry);
    assert.ok(match, `xref entry parses: ${entry}`);
    if (match[2] === 'n') {
      id += 1;
      const offset = Number(match[1]);
      assert.ok(text.startsWith(`${id} 0 obj`, offset), `object ${id} sits at its xref offset`);
    }
  }
  assert.ok(id >= 5, 'catalog, pages, font, page and contents are all present');
}

test('quote PDF: frozen v1 bytes never move when the draft moves on', async (t) => {
  const root = project(t, { withDomain: false });
  const context = await boot(root, join(root, 'data', 'quote-pdf.sqlite'));
  t.after(() => context.close());
  const { app } = context;

  await app.syncCatalog({ provider: 'fixture-saas-catalog', actor: ACTOR });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offerOf = (key) => app.modules.get('offer').service.listWhere({ logicalKey: key, active: true })[0];
  const company = await app.services.companies.create({ name: 'PDF SpA' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create(
    { companyId: company.id, name: 'PDF deal', type: 'new_business', valueCents: 100_000, currency: 'EUR', stage: 'discovery', owner: 'quote-pdf' },
    { actor: ACTOR },
  );
  const quote = (await app.runAction({
    module: 'opportunity', action: 'create-quote', recordId: opportunity.id, input: { priceBookId: book.id }, actor: ACTOR,
  })).result.quote;

  const enterprise = offerOf('fixture:offer:enterprise');
  const added = await app.runAction({
    module: 'quote', action: 'add-line', recordId: quote.id,
    input: { offerId: enterprise.id, quantity: 2, discountBps: 6000 }, actor: ACTOR,
  });
  const submitted = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR,
  });
  assert.equal(submitted.result.version.decision, 'reject', 'a 60% line discount rejects, so the draft can move on');
  const v1 = submitted.result.version;

  const frozenA = await readQuoteVersionEvidence(servicesOf(app), v1.id);
  const pdfA = renderQuoteVersionPdf(frozenA);
  assertXrefValid(pdfA.pdfBytes);
  assert.match(pdfA.documentHash, /^[0-9a-f]{64}$/, 'the document carries a sha256 hash');
  assert.equal(pdfA.versionId, v1.id, 'the render names the version it froze');
  const textA = pdfA.pdfBytes.toString('latin1');
  assert.ok(textA.includes(`versione ${v1.versionNumber}`), 'the version number is printed');

  // The draft moves on: a policy-refused submit never leaves the draft
  // (BO-F2-04), so reprice and submit v2 with no revise step.
  await app.runAction({
    module: 'quote', action: 'update-line', recordId: quote.id,
    input: { lineId: added.result.line.id, quantity: 5, discountBps: 500 }, actor: ACTOR,
  });
  const resubmitted = await app.runAction({
    module: 'quote', action: 'submit', recordId: quote.id,
    input: { policy: 'standard-sales-discount', version: 1 }, actor: ACTOR,
  });
  assert.equal(resubmitted.result.version.versionNumber, v1.versionNumber + 1, 'the moved draft froze a second version');

  // v1 renders byte-identical: the PDF came from the frozen rows, not the draft.
  const frozenAgain = await readQuoteVersionEvidence(servicesOf(app), v1.id);
  const pdfAgain = renderQuoteVersionPdf(frozenAgain);
  assert.deepEqual(pdfAgain.pdfBytes, pdfA.pdfBytes, 'v1 renders byte-identical after the draft moved on to v2');
  assert.equal(pdfAgain.documentHash, pdfA.documentHash, 'the document hash is stable too');

  // v2 is a different frozen document.
  const pdfB = renderQuoteVersionPdf(await readQuoteVersionEvidence(servicesOf(app), resubmitted.result.version.id));
  assert.notDeepEqual(pdfB.pdfBytes, pdfA.pdfBytes, 'v2 renders different bytes');
  assertXrefValid(pdfB.pdfBytes);
});

test('quote PDF: hostile evidence stays a valid, deterministic document', () => {
  const evidence = {
    version: {
      id: 'qv-hostile', versionNumber: 3, quoteId: 'q1', opportunityId: null,
      priceBookId: 'pb1', currency: 'EUR', submittedAt: '2026-10-20T00:00:00.000Z',
      submittedBy: 'u1', policy: null, policyVersion: null, policyDecision: null,
      maxLineDiscountBps: 0, effectiveDiscountBps: 0,
    },
    lines: [{
      offerName: 'Offerta (prova) \\ promo \u20ac100 \ud83d\ude00 ${x}',
      offerLogicalKey: 'k', offerRevision: 1, sku: 's', quantity: 1, discountBps: 0,
      position: 1, listAmountCents: 12345, discountAmountCents: 0, netAmountCents: 12345,
      components: [{
        componentKey: 'c', label: 'Voce (a\\b)', chargeType: 'one_time', pricingModel: 'flat_fee',
        interval: null, intervalCount: null, quantity: 0, unitAmountCents: null,
        flatAmountCents: 12345, listAmountCents: 12345, discountAmountCents: 0,
        netAmountCents: 12345, sourcePricingModel: null,
      }],
    }],
    totals: [{
      kind: 'one_time', currency: 'EUR', interval: null, intervalCount: null,
      listAmountCents: 12345, discountAmountCents: 0, netAmountCents: 12345,
    }],
    terms: null,
  };
  const first = renderQuoteVersionPdf(evidence);
  const second = renderQuoteVersionPdf(evidence);
  assert.deepEqual(first.pdfBytes, second.pdfBytes, 'the same evidence always renders the same bytes');
  assertXrefValid(first.pdfBytes);
  const text = first.pdfBytes.toString('latin1');
  assert.ok(text.includes('123.45 EUR'), 'the frozen net amount is printed');
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text), 'no raw control bytes escape into the document');
  assert.ok(text.includes('?'), 'unencodable evidence degrades to a visible placeholder, never a broken byte');
});

test('quote PDF: a verified term snapshot renders, a tampered one refuses', async () => {
  const versionRow = { id: 'qv-term', versionNumber: 1, quoteId: 'q1', priceBookId: 'pb1', currency: 'EUR' };
  const lineRow = {
    id: 'l1', offerName: 'Offerta', offerLogicalKey: 'k', offerRevision: 1, sku: 's',
    quantity: 1, discountBps: 0, position: 1,
    listAmountCents: 100, discountAmountCents: 0, netAmountCents: 100,
  };
  const totalRow = {
    kind: 'one_time', currency: 'EUR', interval: null, intervalCount: null,
    listAmountCents: 100, discountAmountCents: 0, netAmountCents: 100,
  };
  const signed = requireSignedTerm({
    effectiveDate: '2026-01-01', termStartDate: '2026-01-01', termEndDate: '2027-01-01',
    autoRenew: true, renewalNoticeDays: 30,
  });
  const termRow = { versionId: 'qv-term', quoteId: 'q1', sourceKey: 'qvt:qv-term', ...signed };
  const stub = (terms) => ({
    versions: { get: async () => versionRow },
    lines: { listWhere: async () => [lineRow] },
    components: { listWhere: async () => [] },
    totals: { listWhere: async () => [totalRow] },
    terms: { listWhere: async () => terms },
  });

  const evidence = await readQuoteVersionEvidence(stub([termRow]), 'qv-term');
  assert.equal(evidence.terms.termsFingerprint, signed.termsFingerprint, 'the verified snapshot renders its fingerprint');
  const pdf = renderQuoteVersionPdf(evidence);
  assert.ok(pdf.pdfBytes.toString('latin1').includes(signed.termsFingerprint), 'the PDF prints the verified fingerprint');

  const tampered = { ...termRow, termDays: 1 };
  await assert.rejects(
    readQuoteVersionEvidence(stub([tampered]), 'qv-term'),
    (error) => error.code === 'TERMS_FINGERPRINT_MISMATCH',
    'an out-of-band mutation of the term row refuses instead of rendering as signed',
  );
  await assert.rejects(
    readQuoteVersionEvidence(stub([termRow, { ...termRow, sourceKey: 'qvt:qv-term:2' }]), 'qv-term'),
    (error) => error.code === 'TERMS_SNAPSHOT_AMBIGUOUS',
    'two term snapshots for one version refuse instead of picking one to print',
  );
});

test('quote PDF: unknown versions and empty snapshots refuse', async () => {
  await assert.rejects(
    readQuoteVersionEvidence({ versions: { get: async () => null } }, 'qv-missing'),
    (error) => error.code === 'VERSION_NOT_FOUND',
    'an unknown version refuses instead of rendering an empty document',
  );
  assert.throws(
    () => renderQuoteVersionPdf({ version: { id: 'x' }, lines: [], totals: [], terms: null }),
    (error) => error.name === 'ValidationError',
    'evidence without frozen rows never becomes a PDF',
  );
});
