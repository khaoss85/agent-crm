// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { ValidationError } from '../packages/core/index.js';
import {
  SALES_PLAYBOOK_FIELDS,
  assertPlaybookProposalInput,
  buildPlaybookProposalPrompt,
  parsePlaybookProposalResponse,
  proposeSalesPlaybook,
} from '../packages/llm/src/sales-playbook.js';
import { assertMessageDraftPlaybook } from '../packages/llm/src/message-draft.js';
import { createAccordoApp } from '../packages/app/src/index.js';

/**
 * Sales playbook tests (backlog:ad7e03ac): one playbook per space, read
 * and edited by the member; the AI proposes it from the member's
 * description (a site travels only beside it, never alone) and nothing
 * is saved until the member confirms; with the
 * AI off the member compiles it by hand and the rest works.
 */

const ACTOR = { type: 'user', id: 'playbook-kit' };

const PROPOSAL_JSON = JSON.stringify({
  companyName: 'Presti Group',
  description: 'Palestra con personal training e corsi di gruppo.',
  website: 'https://prestigroup.example.it',
  products: 'Abbonamento mensile\nPacchetto 10 ingressi\nPersonal training',
  idealCustomer: 'Adulti 25-50 che vogliono rimettersi in forma vicino casa.',
  tone: 'Energico ma mai pressante.',
  avoidTopics: 'Mai promettere risultati medici o sconti non approvati.',
  links: 'https://prestigroup.example.it/orari',
  hours: 'Lun-Ven 6:30-22:00, Sab 8:00-13:00.',
});

/** A fake `complete` that captures the prompt and answers canned text. */
function fakeComplete({ text = PROPOSAL_JSON, throws = null, seen = null } = {}) {
  const complete = async (request) => {
    if (seen !== null) seen.request = request;
    if (throws !== null) throw throws;
    return { text, dryRun: false };
  };
  return complete;
}

const appFor = (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const definition = app.modules.get('sales-playbook');
  assert.ok(definition, 'the sales-playbook module is composed');
  return definition.service;
};

test('the playbook reads and edits: one row per space', async (t) => {
  const service = appFor(t);
  assert.equal(service.getBySpace('presti'), null, 'no playbook before the member compiles one');
  const created = await service.savePlaybook('presti', {
    companyName: 'Presti Group',
    products: 'Abbonamento mensile',
    hours: 'Lun-Ven 6:30-22:00.',
  }, { actor: ACTOR });
  assert.equal(created.spaceId, 'presti');
  assert.equal(created.companyName, 'Presti Group');
  assert.equal(created.tone, null, 'absent fields stay null');
  assert.deepEqual(service.getBySpace('presti'), created, 'the member reads what they saved');
  const rewritten = await service.savePlaybook('presti', {
    products: 'Abbonamento mensile\nPersonal training',
  }, { actor: ACTOR });
  assert.equal(rewritten.products, 'Abbonamento mensile\nPersonal training');
  assert.equal(rewritten.companyName, 'Presti Group', 'absent keys leave the rest');
  assert.equal(service.countWhere({ spaceId: 'presti' }), 1, 'a second save rewrites, never doubles');
});

test('the member compiles the playbook by hand with the AI off', async (t) => {
  const service = appFor(t);
  const hand = await service.savePlaybook('arvo', {
    companyName: 'Arvo',
    description: 'Fiori e piante.',
    products: 'Mazzo del giorno',
    idealCustomer: 'Chi cerca un regalo last minute.',
    tone: 'Gentile.',
    avoidTopics: 'Mai promettere consegne senza data.',
    links: '',
    hours: 'Lun-Sab 9:00-19:00.',
  }, { actor: ACTOR });
  assert.equal(hand.links, null, 'an empty string clears the field');
  assert.equal(service.getBySpace('arvo').hours, 'Lun-Sab 9:00-19:00.');
  assert.equal(service.getBySpace('presti'), null, 'spaces never share a playbook');
});

test('the AI proposes from a description and nothing is saved without confirm', async (t) => {
  const service = appFor(t);
  const seen = {};
  const out = await proposeSalesPlaybook({
    complete: fakeComplete({ seen }),
    spaceId: 'presti',
    actor: ACTOR,
    website: 'https://prestigroup.example.it',
    description: 'Palestra con personal training.',
  });
  assert.equal(out.dryRun, false);
  assert.equal(out.companyName, 'Presti Group');
  assert.ok(out.products.includes('Personal training'));
  assert.equal(seen.request.purpose, 'assistant');
  assert.equal(seen.request.spaceId, 'presti');
  assert.equal(service.getBySpace('presti'), null, 'the proposal alone writes no row');
  await service.savePlaybook('presti', { ...out }, { actor: ACTOR });
  assert.equal(service.getBySpace('presti').companyName, 'Presti Group');
});

test('the prompt carries the member source verbatim', () => {
  const { messages } = buildPlaybookProposalPrompt(assertPlaybookProposalInput({
    website: 'https://x.example',
    description: 'Palestra con personal training e corsi di gruppo.',
  }));
  const user = messages.find((entry) => entry.role === 'user').content;
  assert.ok(user.includes('Palestra con personal training e corsi di gruppo.'));
  assert.ok(user.includes('https://x.example'));
  assert.ok(user.includes('"companyName"'));
  assert.ok(user.includes('"hours"'));
  assert.deepEqual(
    Object.keys(assertPlaybookProposalInput({ description: 'Palestra.' })),
    ['website', 'description'],
  );
});

test('a description alone proposes, a website alone refuses', async () => {
  const seen = {};
  const out = await proposeSalesPlaybook({
    complete: fakeComplete({ seen }),
    spaceId: 'presti',
    actor: ACTOR,
    description: 'Palestra di quartiere.',
  });
  assert.equal(out.dryRun, false);
  assert.ok(seen.request);
  assert.throws(() => assertPlaybookProposalInput({}), ValidationError);
  assert.throws(() => assertPlaybookProposalInput({ website: '   ' }), ValidationError);
  assert.throws(
    () => assertPlaybookProposalInput({ website: 'https://x.example' }),
    /member description/,
    'no page fetch exists, so a bare URL grounds nothing',
  );
  await assert.rejects(
    proposeSalesPlaybook({
      complete: fakeComplete(),
      spaceId: 'presti',
      actor: ACTOR,
      website: 'https://x.example',
    }),
    ValidationError,
  );
});

test('an unusable model answer refuses typed, never an empty playbook', () => {
  assert.throws(() => parsePlaybookProposalResponse('not json'), /usable playbook/);
  assert.throws(
    () => parsePlaybookProposalResponse(JSON.stringify({ companyName: '', tone: '' })),
    /usable playbook/,
    'all-empty answers propose nothing',
  );
  const partial = parsePlaybookProposalResponse(JSON.stringify({ products: 'Solo corsi' }));
  assert.equal(partial.products, 'Solo corsi');
  assert.equal(partial.companyName, null, 'missing fields stay null for the member to fill');
  assert.deepEqual(Object.keys(partial).sort(), [...SALES_PLAYBOOK_FIELDS].sort());
});

test('the save keeps the draft fence, so a stored playbook stays draftable', async (t) => {
  const service = appFor(t);
  await assert.rejects(
    service.savePlaybook('presti', { products: `${'x'.repeat(2000)}y` }, { actor: ACTOR }),
    /at most 2000/,
    'over-long content refuses on save, never at draft time',
  );
  await assert.rejects(
    service.savePlaybook('presti', { products: 'Corsi\te serali' }, { actor: ACTOR }),
    /control characters/,
    'a tab refuses on save, never at draft time',
  );
  await assert.rejects(
    service.savePlaybook('presti', { products: 42 }, { actor: ACTOR }),
    /must be text/,
  );
  assert.equal(service.getBySpace('presti'), null, 'three refuses wrote no row');
  const boundary = await service.savePlaybook('presti', {
    companyName: 'Presti Group',
    products: 'x'.repeat(2000),
  }, { actor: ACTOR });
  assert.equal(boundary.products.length, 2000, 'exactly 2000 chars still saves');
  assert.doesNotThrow(
    () => assertMessageDraftPlaybook(service.getBySpace('presti')),
    'what the save accepted, the draft accepts too',
  );
});

test('a dry run answers off-status and saves nothing', async (t) => {
  const service = appFor(t);
  const out = await proposeSalesPlaybook({
    complete: async () => ({ text: 'fixture answer', dryRun: true }),
    spaceId: 'presti',
    actor: ACTOR,
    description: 'Palestra.',
  });
  assert.equal(out.status, 'llm-disabled');
  assert.equal(out.proposal, null);
  assert.equal(out.dryRun, true);
  assert.equal(service.getBySpace('presti'), null);
});
