import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTACT_BRIEF_LINES,
  CONTACT_BRIEF_PURPOSE,
  assertContactBriefInput,
  briefCustomer,
  buildContactBriefPrompt,
  parseContactBriefResponse,
} from '../packages/llm/src/contact-brief.js';
import { LLM_PURPOSES } from '../packages/llm/src/operations.js';

/**
 * Customer brief tests (backlog:317fcc684f51): the top of the scheda
 * cliente shows three short AI lines — chi è, cosa è successo, cosa dire
 * adesso — each with its own source. The card's own data reaches the
 * model, a line without a source never appears, a new message, offer or
 * appointment changes the brief, no line judges the person, and a dry run
 * (AI off) stays off so the section does not appear.
 */

const ACTOR = { type: 'user', id: 'contact-brief-kit' };
const HISTORY = Object.freeze([
  Object.freeze({ direction: 'in', text: 'ciao, avete pacchetti per due persone?' }),
  Object.freeze({ direction: 'out', text: 'Ciao Marco, sì: il pacchetto coppia da 10 ingressi.' }),
]);
const OFFERS = Object.freeze(['offerta pacchetto coppia 10 ingressi, inviata il 10/11']);
const APPOINTMENTS = Object.freeze(['prova gratuita fissata per il 18/11 alle 18:00']);

const BRIEF_JSON = JSON.stringify({
  chiE: { testo: 'Marco chiede per due persone, interessato al pacchetto coppia.', fonte: 'messaggio WhatsApp: pacchetti per due persone' },
  cosaSuccesso: { testo: 'Gli abbiamo proposto il pacchetto coppia e fissato la prova del 18/11.', fonte: 'offerta del 10/11 e appuntamento del 18/11' },
  cosaDire: { testo: 'Conferma la prova di domani alle 18 e ricorda il pacchetto coppia.', fonte: 'appuntamento del 18/11 alle 18:00' },
});

/** A fake `complete` that captures the prompt and answers canned text. */
function fakeComplete({ text = BRIEF_JSON, seen = null } = {}) {
  const complete = async (request) => {
    if (seen !== null) seen.request = request;
    return { text, dryRun: false };
  };
  return complete;
}

test('contact-brief is its own audited purpose', () => {
  assert.equal(CONTACT_BRIEF_PURPOSE, 'contact-brief');
  assert.ok(LLM_PURPOSES.includes('contact-brief'), 'the purpose travels the audited complete path');
  assert.deepEqual(CONTACT_BRIEF_LINES, ['chiE', 'cosaSuccesso', 'cosaDire']);
});

test('the brief carries three lines, each with its source', async () => {
  const seen = {};
  const out = await briefCustomer({
    complete: fakeComplete({ seen }),
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    offers: OFFERS,
    appointments: APPOINTMENTS,
  });
  assert.deepEqual(Object.keys(out.lines).sort(), ['chiE', 'cosaDire', 'cosaSuccesso']);
  for (const key of CONTACT_BRIEF_LINES) {
    assert.ok(out.lines[key].testo.length > 0, `${key} has text`);
    assert.ok(out.lines[key].fonte.length > 0, `${key} has a source`);
  }
  assert.equal(out.dryRun, false);
  assert.equal(seen.request.purpose, 'contact-brief');
  assert.equal(seen.request.spaceId, 'presti');
});

test('the prompt carries the card data verbatim: name, message, offer, appointment', async () => {
  const seen = {};
  await briefCustomer({
    complete: fakeComplete({ seen }),
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    offers: OFFERS,
    appointments: APPOINTMENTS,
  });
  const prompt = seen.request.messages.map((message) => message.content).join('\n');
  assert.ok(prompt.includes('Marco Rossi'), 'the customer name reaches the model');
  assert.ok(prompt.includes('avete pacchetti per due persone?'), 'the latest inbound line reaches the model');
  assert.ok(prompt.includes('pacchetto coppia 10 ingressi'), 'the newest offer reaches the model');
  assert.ok(prompt.includes('18/11 alle 18:00'), 'the newest appointment reaches the model');
});

test('buildContactBriefPrompt is the prompt the brief sends', () => {
  const { messages } = buildContactBriefPrompt({
    customerName: 'Marco Rossi',
    history: HISTORY,
    offers: OFFERS,
    appointments: APPOINTMENTS,
  });
  const prompt = messages.map((message) => message.content).join('\n');
  assert.ok(prompt.includes('Marco Rossi'));
  assert.ok(prompt.includes('avete pacchetti per due persone?'));
  assert.ok(prompt.includes('pacchetto coppia 10 ingressi'));
  assert.ok(prompt.includes('18/11 alle 18:00'));
});

test('a line without a source does not appear', async () => {
  const partial = JSON.parse(BRIEF_JSON);
  partial.cosaDire = { testo: 'Ricordagli la prova.', fonte: '' };
  const out = await briefCustomer({
    complete: fakeComplete({ text: JSON.stringify(partial) }),
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    offers: OFFERS,
    appointments: APPOINTMENTS,
  });
  assert.ok(out.lines.chiE, 'the sourced line stays');
  assert.ok(out.lines.cosaSuccesso, 'the sourced line stays');
  assert.equal(out.lines.cosaDire, undefined, 'the sourceless line does not appear');
});

test('a new message, offer or appointment regenerates the brief', async () => {
  const first = {};
  const second = {};
  await briefCustomer({
    complete: fakeComplete({ seen: first }),
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    offers: OFFERS,
    appointments: APPOINTMENTS,
  });
  const longerHistory = [...HISTORY, { direction: 'in', text: 'la sposto a giovedì alle 19?' }];
  const newerOffer = [...OFFERS, 'sconto prova gratuita, inviato oggi'];
  const newerAppointment = [...APPOINTMENTS, 'prova spostata a giovedì alle 19:00'];
  await briefCustomer({
    complete: fakeComplete({ seen: second }),
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: longerHistory,
    offers: newerOffer,
    appointments: newerAppointment,
  });
  const firstPrompt = first.request.messages.map((message) => message.content).join('\n');
  const secondPrompt = second.request.messages.map((message) => message.content).join('\n');
  assert.notEqual(secondPrompt, firstPrompt, 'new events change the prompt');
  assert.ok(secondPrompt.includes('giovedì alle 19'), 'the new message, offer and appointment reach the model');
  assert.ok(!firstPrompt.includes('giovedì alle 19'), 'the old prompt did not have them');
});

test('the prompt bans personality judgments', () => {
  const { messages } = buildContactBriefPrompt({
    customerName: 'Marco Rossi',
    history: HISTORY,
    offers: OFFERS,
    appointments: APPOINTMENTS,
  });
  const prompt = messages.map((message) => message.content).join('\n').toLowerCase();
  assert.ok(prompt.includes('mai giudizi'), 'the user message bans personality judgments');
  assert.ok(prompt.includes('disc'), 'the ban names DISC');
  assert.ok(prompt.includes('mbti'), 'the ban names MBTI');
  const system = messages[0].content.toLowerCase();
  assert.ok(system.includes('mai giudizi'), 'the system message bans judgments too');
});

test('a fake answer that judges the person refuses typed', async () => {
  const judging = JSON.parse(BRIEF_JSON);
  judging.chiE = { testo: 'Marco è un narcisista da manuale, profilo DISC dominante.', fonte: 'messaggio WhatsApp' };
  await assert.rejects(
    () => briefCustomer({
      complete: fakeComplete({ text: JSON.stringify(judging) }),
      spaceId: 'presti',
      actor: ACTOR,
      customerName: 'Marco Rossi',
      history: HISTORY,
      offers: OFFERS,
      appointments: APPOINTMENTS,
    }),
    (error) => error?.code === 'CONTACT_BRIEF_JUDGMENT',
  );
});

test('parseContactBriefResponse drops the sourceless line and refuses judgments', () => {
  const partial = JSON.parse(BRIEF_JSON);
  delete partial.cosaSuccesso.fonte;
  const parsed = parseContactBriefResponse(JSON.stringify(partial));
  assert.ok(parsed.lines.chiE && parsed.lines.cosaDire);
  assert.equal(parsed.lines.cosaSuccesso, undefined);
  const judging = JSON.parse(BRIEF_JSON);
  judging.cosaDire = { testo: 'Digli che è pigro e maleducato.', fonte: 'appuntamento' };
  assert.throws(() => parseContactBriefResponse(JSON.stringify(judging)), (error) => error?.code === 'CONTACT_BRIEF_JUDGMENT');
  assert.throws(() => parseContactBriefResponse('non json'), (error) => error?.code === 'CONTACT_BRIEF_INVALID');
  const innocent = JSON.parse(BRIEF_JSON);
  innocent.cosaDire = { testo: 'Ne abbiamo discusso in chiamata: conferma la prova.', fonte: 'appuntamento del 18/11' };
  assert.doesNotThrow(() => parseContactBriefResponse(JSON.stringify(innocent)), 'ordinary words pass the judgment fence');
});

test('with the AI off (dry run) the brief stays off: no lines to show', async () => {
  const complete = async () => ({ text: 'fixture answer', dryRun: true });
  const out = await briefCustomer({
    complete,
    spaceId: 'presti',
    actor: ACTOR,
    customerName: 'Marco Rossi',
    history: HISTORY,
    offers: OFFERS,
    appointments: APPOINTMENTS,
  });
  assert.equal(out.status, 'llm-disabled');
  assert.equal(out.lines, null, 'no presentable wording rides a dry run: the section does not appear');
  assert.equal(out.dryRun, true);
});

test('bad input refuses fail-closed', () => {
  assert.throws(() => assertContactBriefInput(null), /plain object/);
  assert.throws(
    () => assertContactBriefInput({ customerName: '  ', history: [], offers: [], appointments: [] }),
    /customerName/,
  );
  assert.throws(
    () => assertContactBriefInput({ customerName: 'Marco', history: [{ direction: 'sideways', text: 'x' }] }),
    /direction/,
  );
});
