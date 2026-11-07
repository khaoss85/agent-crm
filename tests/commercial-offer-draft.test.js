import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OFFER_DRAFT_PURPOSE,
  MAX_OFFER_DRAFT_PROMPT_CHARS,
  MAX_OFFER_DRAFT_PROMPT_OFFERS,
  buildOfferDraftMessages,
  suggestOfferDraft,
} from '../packages/commercial/src/offer-draft.js';
import { applyDiscount } from '../packages/commercial/src/money.js';

/**
 * AI-suggested offer draft from one operator sentence (backlog:7847b4cf,
 * «Bozza dell'offerta da una frase»): the panel's «scrivi …» line fills the
 * offer fields by itself. The model chooses which catalog offers, the domain
 * computes the money from catalog prices and enforces the discount policy —
 * unknown offers and over-policy discounts refuse with typed codes instead
 * of entering the draft, and with the LLM off the draft stays off.
 */

const OFFERS = [
  { offerId: 'offer:ingressi-10', name: 'Carnet 10 ingressi', priceCents: 5000, currency: 'EUR', maxDiscountBps: 2000 },
  { offerId: 'offer:mensile', name: 'Mensile sala', priceCents: 3900, currency: 'EUR', maxDiscountBps: 1000 },
];

const validAnswer = (body) => ({ text: JSON.stringify(body) });

test('offer draft: «offerta 10 ingressi con sconto 10%» drafts the catalog offer with the computed total', async () => {
  const complete = async () => validAnswer({
    title: 'Carnet 10 ingressi con sconto',
    expectedCloseDate: '2026-12-31',
    lines: [{ offerId: 'offer:ingressi-10', quantity: 1, discountBps: 1000 }],
  });
  const result = await suggestOfferDraft({
    prompt: 'offerta 10 ingressi con sconto 10%',
    offers: OFFERS,
    policy: { maxDiscountBps: 2000, currency: 'EUR' },
    complete,
  });
  assert.equal(result.status, 'ok', 'the draft lands');
  assert.deepEqual(result.refused, [], 'nothing refuses on the happy path');
  assert.equal(result.draft.title, 'Carnet 10 ingressi con sconto', 'the title travels through');
  assert.equal(result.draft.valueCents, 4500, 'the total is priced server-side: 5000 at 10% off');
  assert.equal(result.draft.currency, 'EUR', 'the currency travels through');
  assert.equal(result.draft.expectedCloseDate, '2026-12-31', 'the closing date travels through');
  assert.deepEqual(result.draft.catalogOfferIds, ['offer:ingressi-10'], 'only catalog ids travel through');
});

test('offer draft: an invented offer never enters the draft', async () => {
  const complete = async () => validAnswer({
    lines: [
      { offerId: 'offer:fantasma', quantity: 1 },
      { offerId: 'offer:mensile', quantity: 2 },
    ],
  });
  const result = await suggestOfferDraft({ prompt: 'offerta mensile', offers: OFFERS, complete });
  assert.equal(result.status, 'ok', 'the known line still lands');
  assert.deepEqual(result.draft.catalogOfferIds, ['offer:mensile'], 'the invented id stays out');
  assert.equal(result.draft.valueCents, 7800, 'the total prices only the known line');
  assert.deepEqual(
    result.refused.map(({ code }) => code),
    ['OFFER_DRAFT_UNKNOWN_OFFER'],
    'the invented offer refuses with its typed code',
  );
});

test('offer draft: a discount above the policy stays out of the draft', async () => {
  const complete = async () => validAnswer({
    lines: [{ offerId: 'offer:mensile', quantity: 1, discountBps: 5000 }],
  });
  const result = await suggestOfferDraft({
    prompt: 'mensile con sconto 50%',
    offers: OFFERS,
    policy: { maxDiscountBps: 1000, currency: 'EUR' },
    complete,
  });
  assert.equal(result.status, 'ok', 'the call still answers');
  assert.deepEqual(result.draft.catalogOfferIds, [], 'the over-policy line stays out');
  assert.ok(!('valueCents' in result.draft), 'no total without an accepted line');
  assert.ok(!('currency' in result.draft), 'no currency without an accepted line');
  assert.ok(!('title' in result.draft), 'no title without an accepted line');
  assert.ok(!('expectedCloseDate' in result.draft), 'no closing date without an accepted line');
  assert.deepEqual(
    result.refused.map(({ code }) => code),
    ['OFFER_DRAFT_DISCOUNT_ABOVE_POLICY'],
    'the over-policy discount refuses with its typed code',
  );
});

test('offer draft: bad quantities, discounts and dates refuse with typed codes', async () => {
  const badLines = async (lines) => suggestOfferDraft({
    prompt: 'offerta',
    offers: OFFERS,
    complete: async () => validAnswer({ lines }),
  });
  const zeroQty = await badLines([{ offerId: 'offer:mensile', quantity: 0 }]);
  assert.deepEqual(zeroQty.refused.map(({ code }) => code), ['OFFER_DRAFT_QUANTITY_INVALID']);
  const badDiscount = await badLines([{ offerId: 'offer:mensile', discountBps: 10001 }]);
  assert.deepEqual(badDiscount.refused.map(({ code }) => code), ['OFFER_DRAFT_DISCOUNT_INVALID']);
  const notAnObject = await badLines(['offerta mensile']);
  assert.deepEqual(notAnObject.refused.map(({ code }) => code), ['OFFER_DRAFT_LINE_INVALID']);
  await assert.rejects(
    badLines([{ offerId: 'offer:mensile' }]).then(() => suggestOfferDraft({
      prompt: 'offerta',
      offers: OFFERS,
      complete: async () => validAnswer({ lines: [{ offerId: 'offer:mensile' }], expectedCloseDate: '31-12-2026' }),
    })),
    (error) => error?.code === 'OFFER_DRAFT_DATE_INVALID',
    'a misshapen closing date refuses the whole call, never reaching the panel',
  );
  await assert.rejects(
    suggestOfferDraft({ prompt: 'offerta', offers: OFFERS, complete: async () => ({ text: 'non json' }) }),
    (error) => error?.code === 'OFFER_DRAFT_INVALID',
    'a non-JSON answer refuses the whole call',
  );
});

test('offer draft: the prompt is bounded like the panel input', async () => {
  const complete = async () => validAnswer({ lines: [] });
  await assert.rejects(
    suggestOfferDraft({ prompt: 'x'.repeat(MAX_OFFER_DRAFT_PROMPT_CHARS + 1), offers: OFFERS, complete }),
    (error) => error?.code === 'ERR_VALIDATION' || /at most 500/.test(error?.message ?? ''),
    'a 501-character prompt refuses',
  );
  await assert.rejects(
    suggestOfferDraft({ prompt: '   ', offers: OFFERS, complete }),
    () => true,
    'an empty prompt refuses',
  );
});

test('offer draft: without AI or catalog the draft stays off, never hallucinated', async () => {
  const noComplete = await suggestOfferDraft({ prompt: 'offerta', offers: OFFERS, complete: null });
  assert.equal(noComplete.status, 'llm-disabled', 'no completion function means no draft');
  assert.equal(noComplete.draft, null, 'nothing is drafted without the model');
  const noCatalog = await suggestOfferDraft({
    prompt: 'offerta',
    offers: [],
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:qualcosa' }] }),
  });
  assert.equal(noCatalog.status, 'no-evidence', 'no catalog means no draft');
  assert.equal(noCatalog.draft, null, 'nothing is drafted from an empty catalog');
  const spaceOff = await suggestOfferDraft({
    prompt: 'offerta',
    offers: OFFERS,
    complete: async () => { throw Object.assign(new Error('spento'), { code: 'LLM_SPACE_DISABLED' }); },
  });
  assert.equal(spaceOff.status, 'llm-disabled', 'a switched-off space reads as llm-disabled');
  assert.equal(OFFER_DRAFT_PURPOSE, 'suggest', 'the draft spends under the audited suggest purpose');
});

test('offer draft: money stays honest when prices or currencies disagree', async () => {
  const unpriced = await suggestOfferDraft({
    prompt: 'offerta',
    offers: [{ offerId: 'offer:listino', name: 'A listino' }],
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:listino' }] }),
  });
  assert.ok(!('valueCents' in unpriced.draft), 'a line without a catalog price leaves the total out');
  assert.deepEqual(unpriced.draft.catalogOfferIds, ['offer:listino'], 'the line still drafts');
  const mixed = await suggestOfferDraft({
    prompt: 'offerta',
    offers: [
      { offerId: 'offer:a', priceCents: 1000, currency: 'EUR' },
      { offerId: 'offer:b', priceCents: 2000, currency: 'USD' },
    ],
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:a' }, { offerId: 'offer:b' }] }),
  });
  assert.ok(!('valueCents' in mixed.draft), 'mixed currencies never sum into one total');
  assert.ok(!('currency' in mixed.draft), 'a mixed currency never travels as one');
  const relabelled = await suggestOfferDraft({
    prompt: 'offerta',
    offers: [{ offerId: 'offer:a', priceCents: 1000, currency: 'EUR' }],
    policy: { currency: 'USD' },
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:a' }] }),
  });
  assert.ok(!('valueCents' in relabelled.draft), 'a policy currency never relabels another currency total');
  assert.ok(!('currency' in relabelled.draft), 'a contradicting policy currency never travels');
  const messages = buildOfferDraftMessages({
    prompt: 'offerta 10 ingressi con sconto 10%',
    offers: OFFERS,
    policy: { maxDiscountBps: 2000, currency: 'EUR' },
  });
  assert.equal(messages.length, 2, 'the model gets system plus user messages');
  assert.match(messages[1].content, /offer:ingressi-10/, 'the catalog travels in the prompt');
  assert.match(messages[1].content, /offerta 10 ingressi/, 'the member sentence travels in the prompt');
});

test('offer draft: the tighter ceiling wins on both sides', async () => {
  const offers = [{ offerId: 'offer:x', priceCents: 10000, currency: 'EUR', maxDiscountBps: 2000 }];
  const looseLine = async (policy) => suggestOfferDraft({
    prompt: 'offerta',
    offers,
    policy,
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:x', quantity: 1, discountBps: 1500 }] }),
  });
  const overSpace = await looseLine({ maxDiscountBps: 1000 });
  assert.deepEqual(
    overSpace.refused.map(({ code }) => code),
    ['OFFER_DRAFT_DISCOUNT_ABOVE_POLICY'],
    'a per-offer allowance never loosens the space ceiling',
  );
  const overOffer = await suggestOfferDraft({
    prompt: 'offerta',
    offers: [{ offerId: 'offer:x', priceCents: 10000, currency: 'EUR', maxDiscountBps: 500 }],
    policy: { maxDiscountBps: 2000 },
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:x', quantity: 1, discountBps: 1500 }] }),
  });
  assert.deepEqual(
    overOffer.refused.map(({ code }) => code),
    ['OFFER_DRAFT_DISCOUNT_ABOVE_POLICY'],
    'the space ceiling never loosens the per-offer ceiling',
  );
});

test('offer draft: the draft total nets through applyDiscount, the one rounding rule', async () => {
  // One table holds every rounding case of the earlier rounds and this one:
  // each draft total equals list minus the truncated discount amount, never
  // the per-line floor of list * (10000 - bps) / 10000, which reads one cent
  // low whenever the discount does not divide evenly.
  const cases = [
    { priceCents: 1, quantity: 1, discountBps: 5000 },
    { priceCents: 3, quantity: 1, discountBps: 3333 },
    { priceCents: 999, quantity: 1, discountBps: 5000 },
    { priceCents: 5000, quantity: 1, discountBps: 1000 },
    { priceCents: 3900, quantity: 2, discountBps: 0 },
  ];
  for (const { priceCents, quantity, discountBps } of cases) {
    const result = await suggestOfferDraft({
      prompt: 'offerta',
      offers: [{ offerId: 'offer:case', priceCents, currency: 'EUR' }],
      complete: async () => validAnswer({ lines: [{ offerId: 'offer:case', quantity, discountBps }] }),
    });
    const expected = applyDiscount(priceCents * quantity, discountBps).netAmountCents;
    assert.equal(
      result.draft.valueCents,
      expected,
      `${priceCents} x ${quantity} at ${discountBps} bps nets ${expected}`,
    );
  }
  const penny = await suggestOfferDraft({
    prompt: 'offerta',
    offers: [{ offerId: 'offer:penny', priceCents: 1, currency: 'EUR' }],
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:penny', quantity: 1, discountBps: 5000 }] }),
  });
  assert.equal(penny.draft.valueCents, 1, 'one cent at 50% off nets 1: list minus a truncated zero discount');
});

test('offer draft: a priced line without a currency never joins a single-currency total', async () => {
  const result = await suggestOfferDraft({
    prompt: 'offerta',
    offers: [
      { offerId: 'offer:a', priceCents: 1000, currency: 'EUR' },
      { offerId: 'offer:b', priceCents: 2000 },
    ],
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:a' }, { offerId: 'offer:b' }] }),
  });
  assert.ok(!('valueCents' in result.draft), 'a null currency breaks unanimity, so no total is labelled EUR');
  assert.ok(!('currency' in result.draft), 'no currency is emitted without unanimity');
  assert.deepEqual(result.draft.catalogOfferIds, ['offer:a', 'offer:b'], 'both lines still draft');
});

test('offer draft: a misshapen closing date refuses even with zero accepted lines', async () => {
  await assert.rejects(
    suggestOfferDraft({
      prompt: 'offerta',
      offers: OFFERS,
      complete: async () => validAnswer({
        lines: [{ offerId: 'offer:fantasma' }],
        expectedCloseDate: '31-12-2026',
      }),
    }),
    (error) => error?.code === 'OFFER_DRAFT_DATE_INVALID',
    'the date is validated before the empty draft is returned',
  );
  const validEmpty = await suggestOfferDraft({
    prompt: 'offerta',
    offers: OFFERS,
    policy: { maxDiscountBps: 1000, currency: 'EUR' },
    complete: async () => validAnswer({
      lines: [{ offerId: 'offer:mensile', quantity: 1, discountBps: 5000 }],
      expectedCloseDate: '2026-12-31',
    }),
  });
  assert.ok(!('expectedCloseDate' in validEmpty.draft), 'a valid date still stays out of an empty draft');
});

test('offer draft: the prompt carries at most 50 active offers', async () => {
  assert.equal(MAX_OFFER_DRAFT_PROMPT_OFFERS, 50, 'the prompt bound is fifty');
  const offers = Array.from({ length: 55 }, (_, index) => ({
    offerId: `offer:item-${index}`,
    priceCents: 1000,
    currency: 'EUR',
  }));
  const messages = buildOfferDraftMessages({ prompt: 'offerta', offers, policy: {} });
  assert.ok(!messages[1].content.includes('offer:item-54'), 'the 55th offer never reaches the prompt');
  assert.match(messages[1].content, /offer:item-49/, 'the first fifty still travel');
  const result = await suggestOfferDraft({
    prompt: 'offerta',
    offers,
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:item-54' }] }),
  });
  assert.deepEqual(
    result.refused.map(({ code }) => code),
    ['OFFER_DRAFT_UNKNOWN_OFFER'],
    'beyond the fifty the model never saw, a line refuses as unknown',
  );
});

test('offer draft: the message shows the space ceiling, not the tightest line', async () => {
  const messages = buildOfferDraftMessages({
    prompt: 'offerta',
    offers: [{ offerId: 'offer:x', priceCents: 10000, currency: 'EUR', maxDiscountBps: 500 }],
    policy: { maxDiscountBps: 2000 },
  });
  assert.match(messages[1].content, /20%/, 'the space ceiling of 2000 bps travels as its own number');
  assert.doesNotMatch(messages[1].content, /Sconto massimo di spazio: 5%/, 'no minimum poses as the space rule');
});

test('offer draft: a 100% line with no ceiling refuses without an approval flow', async () => {
  const result = await suggestOfferDraft({
    prompt: 'offerta',
    offers: [{ offerId: 'offer:free', priceCents: 1000, currency: 'EUR' }],
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:free', quantity: 1, discountBps: 10000 }] }),
  });
  assert.deepEqual(
    result.refused.map(({ code }) => code),
    ['OFFER_DRAFT_DISCOUNT_ABOVE_POLICY'],
    'a free line stays out when nobody set a ceiling',
  );
  assert.deepEqual(result.draft.catalogOfferIds, [], 'nothing drafts from the refused line');
});

test('offer draft: the draft carries rows with product, quantity, price and discount, and the total is their sum (backlog:8efd56406c7e)', async () => {
  const result = await suggestOfferDraft({
    prompt: 'offerta pacchetto 10 PT con sconto 10% e due mensili',
    offers: [
      { offerId: 'offer:pt-10', name: 'Pacchetto 10 PT', priceCents: 35000, currency: 'EUR', maxDiscountBps: 2000 },
      { offerId: 'offer:mensile', name: 'Mensile sala', priceCents: 3900, currency: 'EUR', maxDiscountBps: 1000 },
    ],
    policy: { maxDiscountBps: 2000, currency: 'EUR' },
    complete: async () => validAnswer({
      title: 'Pacchetto 10 PT e mensili',
      lines: [
        { offerId: 'offer:pt-10', quantity: 1, discountBps: 1000 },
        { offerId: 'offer:mensile', quantity: 2, discountBps: 0 },
      ],
    }),
  });
  assert.equal(result.status, 'ok', 'the draft lands');
  assert.equal(result.draft.lines.length, 2, 'two rows draft');
  assert.deepEqual(result.draft.lines[0], {
    offerId: 'offer:pt-10', name: 'Pacchetto 10 PT', quantity: 1,
    priceCents: 35000, currency: 'EUR', discountBps: 1000,
    netCents: applyDiscount(35000, 1000).netAmountCents,
  }, 'the first row names the catalog product with its price and discount');
  assert.deepEqual(result.draft.lines[1], {
    offerId: 'offer:mensile', name: 'Mensile sala', quantity: 2,
    priceCents: 3900, currency: 'EUR', discountBps: 0,
    netCents: applyDiscount(7800, 0).netAmountCents,
  }, 'the second row prices quantity 2 without discount');
  const sum = result.draft.lines.reduce((total, line) => total + line.netCents, 0);
  assert.equal(result.draft.valueCents, sum, 'the total is the sum of the rows');
  assert.deepEqual(result.draft.catalogOfferIds, ['offer:pt-10', 'offer:mensile'], 'the ids stay beside the rows');
});

test('offer draft: an empty draft carries empty rows, never an invented product', async () => {
  const result = await suggestOfferDraft({
    prompt: 'offerta',
    offers: OFFERS,
    complete: async () => validAnswer({ lines: [{ offerId: 'offer:fantasma' }] }),
  });
  assert.deepEqual(result.draft.lines, [], 'no row drafts from an unknown offer');
  assert.deepEqual(result.draft.catalogOfferIds, [], 'no id drafts either');
});
