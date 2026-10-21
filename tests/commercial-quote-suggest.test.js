import test from 'node:test';
import assert from 'node:assert/strict';
import {
  QUOTE_SUGGEST_PURPOSE,
  buildSuggestMessages,
  suggestQuoteLines,
} from '../packages/commercial/src/quote-suggest.js';

/**
 * AI-suggested quote lines (accordo BO-F2-03, "Suggerisci voci dalle
 * conversazioni" with a cited motive): every suggestion carries its motive
 * in words plus the source excerpt it was drawn from, unknown offers and
 * bad items refuse with typed codes instead of inventing lines, and with
 * the LLM off suggestions stay off — never hallucinated.
 */

const OFFERS = [
  { offerId: 'offer:enterprise', name: 'Enterprise Plan' },
  { offerId: 'offer:support', name: 'Support Pack' },
];
const EXCERPTS = [
  { id: 'm1', text: 'Ci servono 3 licenze enterprise da gennaio, e il pacchetto di supporto.' },
  { id: 'm2', text: 'Il cliente chiede se lo sconto vale anche per il rinnovo.' },
];

const validAnswer = (items) => ({ text: JSON.stringify(items) });

test('suggest: valid lines carry motive and cited source, bad items refuse', async () => {
  const complete = async () => validAnswer([
    { offerId: 'offer:enterprise', quantity: 3, motive: 'Il cliente chiede 3 licenze enterprise.', sourceExcerptId: 'm1' },
    { offerId: 'offer:support', quantity: 1, motive: 'Il cliente chiede il pacchetto di supporto.', sourceExcerptId: 'm1' },
    { offerId: 'offer:ghost', quantity: 1, motive: 'Offerta inventata dal modello.', sourceExcerptId: 'm1' },
    { offerId: 'offer:enterprise', quantity: 0, motive: 'Quantità impossibile.', sourceExcerptId: 'm1' },
    { offerId: 'offer:enterprise', quantity: 1, motive: '   ', sourceExcerptId: 'm1' },
    { offerId: 'offer:enterprise', quantity: 1, motive: 'Fonte mai passata.', sourceExcerptId: 'm9' },
  ]);
  const result = await suggestQuoteLines({ excerpts: EXCERPTS, offers: OFFERS, complete, maxSuggestions: 2 });
  assert.equal(result.status, 'ok', 'valid items still land');
  assert.equal(result.suggestions.length, 2, 'the two valid lines land');
  const [first, second] = result.suggestions;
  assert.equal(first.offerId, 'offer:enterprise', 'the offer id travels through');
  assert.equal(first.offerName, 'Enterprise Plan', 'the catalog name travels with it');
  assert.equal(first.quantity, 3, 'the quantity travels through');
  assert.ok(first.motive.length > 0, 'every suggestion carries its motive in words');
  assert.equal(first.sourceExcerptId, 'm1', 'every suggestion cites its source excerpt');
  assert.ok(second.sourceQuote.startsWith('Ci servono 3 licenze'), 'the quoted span comes from the cited excerpt');
  assert.deepEqual(
    result.refused.map(({ code }) => code),
    ['SUGGESTION_UNKNOWN_OFFER', 'SUGGESTION_QUANTITY_INVALID', 'SUGGESTION_MOTIVE_MISSING', 'SUGGESTION_UNKNOWN_SOURCE'],
    'each bad item refuses with its typed code',
  );
  const overLimit = await suggestQuoteLines({
    excerpts: EXCERPTS,
    offers: OFFERS,
    complete: async () => validAnswer([
      { offerId: 'offer:enterprise', quantity: 1, motive: 'Prima.', sourceExcerptId: 'm1' },
      { offerId: 'offer:support', quantity: 1, motive: 'Seconda.', sourceExcerptId: 'm1' },
      { offerId: 'offer:enterprise', quantity: 1, motive: 'Terza oltre il limite.', sourceExcerptId: 'm1' },
    ]),
    maxSuggestions: 2,
  });
  assert.equal(overLimit.suggestions.length, 2, 'the cap holds');
  assert.deepEqual(overLimit.refused.map(({ code }) => code), ['SUGGESTION_OVER_LIMIT'], 'the extra line refuses as over the limit');
});

test('suggest: without a completion function suggestions stay off', async () => {
  for (const complete of [null, undefined]) {
    const result = await suggestQuoteLines({ excerpts: EXCERPTS, offers: OFFERS, complete });
    assert.equal(result.status, 'llm-disabled', 'no model, no suggestions');
    assert.deepEqual(result.suggestions, [], 'nothing is hallucinated');
  }
});

test('suggest: a space with AI disabled maps to llm-disabled, never to lines', async () => {
  const disabled = new Error('AI is not enabled for this space: no text was sent anywhere');
  disabled.code = 'LLM_SPACE_DISABLED';
  const result = await suggestQuoteLines({ excerpts: EXCERPTS, offers: OFFERS, complete: async () => { throw disabled; } });
  assert.equal(result.status, 'llm-disabled', 'the space refusal becomes the off state');
  assert.deepEqual(result.suggestions, [], 'nothing is hallucinated');
  assert.match(result.reason, /not enabled/, 'the reason names the disabled space');
});

test('suggest: a non-array model reply refuses the whole call', async () => {
  await assert.rejects(
    () => suggestQuoteLines({ excerpts: EXCERPTS, offers: OFFERS, complete: async () => ({ text: 'ecco due idee...' }) }),
    (error) => error?.code === 'QUOTE_SUGGEST_INVALID',
    'garbage from the model is a typed refusal, not partial lines',
  );
  await assert.rejects(
    () => suggestQuoteLines({ excerpts: EXCERPTS, offers: OFFERS, complete: async () => ({ text: '{"offerId": "offer:enterprise"}' }) }),
    (error) => error?.code === 'QUOTE_SUGGEST_INVALID',
    'a non-array object refuses too',
  );
});

test('suggest: with no excerpts or no offers there is nothing to suggest from', async () => {
  const calls = [];
  const complete = async (request) => { calls.push(request); return validAnswer([]); };
  const noExcerpts = await suggestQuoteLines({ excerpts: [], offers: OFFERS, complete });
  assert.equal(noExcerpts.status, 'no-evidence', 'empty conversation, no call');
  const noOffers = await suggestQuoteLines({ excerpts: EXCERPTS, offers: [], complete });
  assert.equal(noOffers.status, 'no-evidence', 'empty catalog, no call');
  assert.deepEqual(calls, [], 'the model is never touched without evidence');
});

test('suggest: dry-run answers stay marked and prompts stay bounded', async () => {
  const seen = [];
  const long = `x`.repeat(3000);
  const many = Array.from({ length: 25 }, (_, index) => ({ id: `m${index}`, text: `estratto ${index} ${long}` }));
  const result = await suggestQuoteLines({
    excerpts: many,
    offers: OFFERS,
    complete: async (request) => { seen.push(request); return { text: '[]', dryRun: true }; },
  });
  assert.equal(result.status, 'ok', 'an empty array is a valid answer');
  assert.equal(result.dryRun, true, 'the fixture answer stays marked as a dry run');
  assert.equal(result.truncatedExcerpts, true, 'truncation is announced');
  assert.equal(seen.length, 1, 'one model call');
  const userContent = seen[0].messages.find((message) => message.role === 'user').content;
  assert.ok(!userContent.includes('m0 '), 'only the most recent excerpts travel');
  assert.ok(userContent.includes('[m24]'), 'the newest excerpt travels');
  assert.ok(userContent.length < 25 * 3000, 'long excerpts are cut to the bound');
  assert.equal(QUOTE_SUGGEST_PURPOSE, 'suggest', 'suggestions spend under the audited suggest purpose');
  assert.ok(Array.isArray(buildSuggestMessages({ excerpts: EXCERPTS, offers: OFFERS })), 'the prompt builder is importable for the future action wiring');
});
