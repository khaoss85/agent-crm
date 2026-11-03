import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../packages/core/index.js';
import {
  MESSAGE_DRAFT_KINDS,
  assertMessageDraftInput,
  buildMessageDraftPrompt,
  draftCustomerMessage,
  parseMessageDraftResponse,
} from '../packages/llm/src/message-draft.js';

/**
 * Customer message draft tests (backlog:5194f583): the composer asks for
 * three labeled wordings, an email subject and the suggested channel.
 * The card's own data reaches the model (the name and the latest inbound
 * line travel verbatim in the prompt), the suggestion stays among the
 * connected channels, an unusable model answer refuses typed, and a
 * disabled space or a missing key surfaces unchanged so the pilot can
 * answer its clear Italian line.
 */

const ACTOR = { type: 'user', id: 'message-draft-kit' };
const CHANNELS = ['whatsapp', 'email'];
const HISTORY = Object.freeze([
  Object.freeze({ direction: 'in', text: 'ciao, a che ora chiudete domani?' }),
  Object.freeze({ direction: 'out', text: 'Ciao Marco, chiudiamo alle 20.' }),
]);

const DRAFT_JSON = JSON.stringify({
  corta: 'Certo, ti confermo le 18 di domani.',
  lunga: 'Ciao Marco, ti confermo con piacere l\u2019appuntamento di domani alle 18: ti aspettiamo.',
  diretta: 'Domani alle 18, confermato.',
  oggetto: 'Conferma appuntamento di domani',
  canale: 'whatsapp',
});

/** A fake `complete` that captures the prompt and answers canned text. */
function fakeComplete({ text = DRAFT_JSON, throws = null, seen = null } = {}) {
  const complete = async (request) => {
    if (seen !== null) seen.request = request;
    if (throws !== null) throw throws;
    return { text, dryRun: false };
  };
  return complete;
}

test('the draft carries three labeled variants, a subject and a connected channel', async () => {
  const seen = {};
  const out = await draftCustomerMessage({
    complete: fakeComplete({ seen }),
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    intent: 'conferma lo spostamento alle 18',
    connectedChannels: CHANNELS,
  });
  assert.deepEqual(Object.keys(out).sort(), ['canale', 'corta', 'diretta', 'dryRun', 'lunga', 'oggetto']);
  assert.equal(out.canale, 'whatsapp');
  assert.equal(out.oggetto, 'Conferma appuntamento di domani');
  assert.ok(out.corta.length > 0 && out.lunga.length > 0 && out.diretta.length > 0);
  assert.equal(out.dryRun, false);
  assert.deepEqual(MESSAGE_DRAFT_KINDS, ['corta', 'lunga', 'diretta']);
  assert.equal(seen.request.purpose, 'assistant');
  assert.equal(seen.request.spaceId, 'presti');
});

test('the prompt carries the card history: the name and the latest inbound line', async () => {
  const seen = {};
  await draftCustomerMessage({
    complete: fakeComplete({ seen }),
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    intent: 'conferma lo spostamento alle 18',
    connectedChannels: CHANNELS,
  });
  const prompt = seen.request.messages.map((message) => message.content).join('\n');
  assert.ok(prompt.includes('Marco Rossi'), 'the customer name reaches the model');
  assert.ok(prompt.includes('ciao, a che ora chiudete domani?'), 'the latest inbound line reaches the model');
  assert.ok(prompt.includes('conferma lo spostamento alle 18'), 'the operator intent reaches the model');
});

test('buildMessageDraftPrompt is the prompt the draft sends', () => {
  const { messages } = buildMessageDraftPrompt({
    customerName: 'Marco Rossi',
    history: HISTORY,
    intent: 'conferma',
    connectedChannels: CHANNELS,
  });
  const prompt = messages.map((message) => message.content).join('\n');
  assert.ok(prompt.includes('Marco Rossi'));
  assert.ok(prompt.includes('ciao, a che ora chiudete domani?'));
});

test('a suggestion outside the connected channels falls back to the first connected one', async () => {
  const other = JSON.parse(DRAFT_JSON);
  other.canale = 'telegram';
  const out = await draftCustomerMessage({
    complete: fakeComplete({ text: JSON.stringify(other) }),
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    intent: 'conferma',
    connectedChannels: CHANNELS,
  });
  assert.equal(out.canale, 'whatsapp');
});

test('an unusable model answer refuses typed instead of reaching the composer', async () => {
  await assert.rejects(
    () => draftCustomerMessage({
      complete: fakeComplete({ text: 'certo, ti scrivo...' }),
      spaceId: 'presti',
      actor: ACTOR,
      customerName: 'Marco Rossi',
      history: HISTORY,
      intent: 'conferma',
      connectedChannels: CHANNELS,
    }),
    (error) => error instanceof AppError && error.code === 'MESSAGE_DRAFT_INVALID',
  );
});

test('a disabled space or a missing key surfaces unchanged for the pilot to translate', async () => {
  for (const code of ['LLM_SPACE_DISABLED', 'LLM_SECRET_UNAVAILABLE']) {
    const failure = new AppError('no ai here', { code, status: 403 });
    await assert.rejects(
      () => draftCustomerMessage({
        complete: fakeComplete({ throws: failure }),
        spaceId: 'presti',
        actor: ACTOR,
        customerName: 'Marco Rossi',
        history: HISTORY,
        intent: 'conferma',
        connectedChannels: CHANNELS,
      }),
      (error) => error instanceof AppError && error.code === code,
    );
  }
});

test('empty intent, empty name and no channels refuse before any provider is touched', async () => {
  let called = 0;
  const counting = async () => { called += 1; return { text: DRAFT_JSON }; };
  const base = {
    complete: counting,
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    intent: 'conferma',
    connectedChannels: CHANNELS,
  };
  await assert.rejects(() => draftCustomerMessage({ ...base, intent: '  ' }), /intent/);
  await assert.rejects(() => draftCustomerMessage({ ...base, customerName: '' }), /customerName/);
  await assert.rejects(() => draftCustomerMessage({ ...base, connectedChannels: [] }), /connectedChannels/);
  await assert.rejects(
    () => draftCustomerMessage({ ...base, history: [{ direction: 'sideways', text: 'ciao' }] }),
    /direction/,
  );
  assert.equal(called, 0);
});

test('parseMessageDraftResponse validates the labeled shape on its own', () => {
  const parsed = parseMessageDraftResponse(DRAFT_JSON, CHANNELS);
  assert.equal(parsed.corta, 'Certo, ti confermo le 18 di domani.');
  assert.equal(parsed.canale, 'whatsapp');
  assert.throws(() => parseMessageDraftResponse('{}', CHANNELS));
  assert.throws(
    () => parseMessageDraftResponse('not json at all', CHANNELS),
    (error) => error instanceof AppError && error.code === 'MESSAGE_DRAFT_INVALID',
  );
  assert.throws(() => assertMessageDraftInput({
    customerName: 'Marco', history: [], intent: 'x'.repeat(501), connectedChannels: CHANNELS,
  }), /intent/);
});
