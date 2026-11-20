// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectOpenCommitments } from '../packages/agents/src/commitments.js';
import { buildAdvisorActions, createOggiView, loadOggiData } from '../apps/admin/public/admin-oggi.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Commitment reminders (backlog:df9e199eb4ef), follow-up slice: the wiring
 * the verifier missed on 2026-11-19 (packet min-accordo-df9e199eb4ef):
 * a note «ci sentiamo giovedì» produced no proposal in Oggi because
 * nothing called the extraction model — buildAdvisorActions ignored
 * commitments entirely. Red on the code before the cure, green after.
 */

const NOTE_THURSDAY = {
  id: 'n-prova-1',
  kind: 'note',
  body: 'Prova Accordo: ci sentiamo giovedì',
  occurredAt: '2026-11-16T08:00:00Z',
  subjectResource: 'contact',
  subjectId: 'c-presti-1',
};

test('repro: una nota «ci sentiamo giovedì» produce una proposta in Oggi', () => {
  const open = selectOpenCommitments({ notes: [NOTE_THURSDAY] });
  assert.equal(open.length, 1, 'the model extracts one commitment from the note');
  const { actions } = buildAdvisorActions({
    tasks: [],
    appointments: [],
    messages: [],
    conversations: [],
    submissions: [],
    commitments: open,
    now: new Date('2026-11-16T09:00:00Z'),
  });
  const proposals = actions.filter((action) => String(action?.id ?? '').startsWith('bo04:commitment:'));
  assert.equal(proposals.length, 1, 'Oggi shows one proposal for the written commitment');
  assert.ok(String(proposals[0].title).includes('ci sentiamo giovedì'), 'the proposal cites the written phrase');
  assert.ok(String(proposals[0].why).includes('gioved'), 'the proposal names the Thursday deadline');
});

test('un messaggio del team «ti mando il listino domani» produce una proposta con la scadenza di domani', () => {
  const open = selectOpenCommitments({
    messages: [{
      id: 'm-team-1',
      direction: 'outbound',
      channel: 'whatsapp',
      conversationId: 'conv-1',
      occurredAt: '2026-11-16T08:00:00Z',
      subjectResource: 'contact',
      subjectId: 'c1',
      body: 'Ciao, ti mando il listino domani',
    }],
  });
  assert.equal(open.length, 1);
  const { actions } = buildAdvisorActions({
    tasks: [],
    appointments: [],
    messages: [],
    conversations: [],
    submissions: [],
    commitments: open,
    now: new Date('2026-11-16T09:00:00Z'),
  });
  const [proposal] = actions.filter((action) => String(action?.id ?? '').startsWith('bo04:commitment:'));
  assert.ok(proposal, 'one team-promise proposal');
  assert.ok(String(proposal.title).includes('ti mando il listino domani'));
  assert.ok(String(proposal.why).includes('domani'));
});

test('un messaggio del cliente «mandami il preventivo» produce una proposta per il team', () => {
  const open = selectOpenCommitments({
    messages: [{
      id: 'm-cust-1',
      direction: 'inbound',
      channel: 'whatsapp',
      conversationId: 'conv-1',
      occurredAt: '2026-11-16T08:00:00Z',
      subjectResource: 'contact',
      subjectId: 'c1',
      body: 'Ciao, mandami il preventivo',
    }],
  });
  assert.equal(open.length, 1);
  const { actions } = buildAdvisorActions({
    tasks: [],
    appointments: [],
    messages: [],
    conversations: [],
    submissions: [],
    commitments: open,
    now: new Date('2026-11-16T09:00:00Z'),
  });
  const [proposal] = actions.filter((action) => String(action?.id ?? '').startsWith('bo04:commitment:'));
  assert.ok(proposal, 'one customer-request proposal');
  assert.ok(String(proposal.title).includes('mandami il preventivo'));
});

test('un messaggio del team dopo l\u2019impegno chiude la proposta al ricalcolo', () => {
  const extracted = selectOpenCommitments({
    messages: [{
      id: 'm-team-1',
      direction: 'outbound',
      channel: 'whatsapp',
      conversationId: 'conv-1',
      occurredAt: '2026-11-16T08:00:00Z',
      subjectResource: 'contact',
      subjectId: 'c1',
      body: 'Ciao, ti mando il listino domani',
    }],
  });
  assert.equal(extracted.length, 1);
  const later = {
    id: 'm-team-2',
    direction: 'outbound',
    channel: 'whatsapp',
    conversationId: 'conv-1',
    occurredAt: '2026-11-16T10:00:00Z',
    subjectResource: 'contact',
    subjectId: 'c1',
    body: 'Ecco il listino in allegato',
  };
  const stillOpen = selectOpenCommitments({
    messages: [
      {
        id: 'm-team-1',
        direction: 'outbound',
        channel: 'whatsapp',
        conversationId: 'conv-1',
        occurredAt: '2026-11-16T08:00:00Z',
        subjectResource: 'contact',
        subjectId: 'c1',
        body: 'Ciao, ti mando il listino domani',
      },
      later,
    ],
  });
  assert.equal(stillOpen.length, 0, 'the later team message closes the commitment');
  const { actions } = buildAdvisorActions({
    tasks: [],
    appointments: [],
    messages: [],
    conversations: [],
    submissions: [],
    commitments: stillOpen,
    now: new Date('2026-11-16T11:00:00Z'),
  });
  assert.equal(
    actions.filter((action) => String(action?.id ?? '').startsWith('bo04:commitment:')).length,
    0,
    'no proposal once the promise is kept',
  );
});

test('ogni proposta cita il record che la motiva e non chiama mai LLM', () => {
  const open = selectOpenCommitments({ notes: [NOTE_THURSDAY] });
  const { actions } = buildAdvisorActions({
    tasks: [],
    appointments: [],
    messages: [],
    conversations: [],
    submissions: [],
    commitments: open,
    now: new Date('2026-11-16T09:00:00Z'),
  });
  const [proposal] = actions.filter((action) => String(action?.id ?? '').startsWith('bo04:commitment:'));
  assert.ok(proposal, 'one proposal');
  assert.equal(proposal.record?.module, 'work-activity');
  assert.equal(proposal.record?.id, 'n-prova-1');
  assert.ok(typeof proposal.note === 'string' && proposal.note.includes('senza AI'), 'Oggi says it in one line');
});

/**
 * The verifier's 19/11 NON PASSA at the shell seam: the feed loaded but the
 * paint never received it, so the note produced no proposal on screen. These
 * tests drive the real view — feed answer, load, paint — through the fake
 * DOM: the quote must be readable on the painted day, and a refused feed
 * must leave the day intact (fail-soft, never a failure).
 */
const FEED_PROPOSAL = {
  key: 'commit:note:n-prova-1',
  kind: 'team-promise',
  quote: 'Prova Accordo: ci sentiamo giovedì',
  dueLabel: 'giovedì',
  occurredAt: '2026-11-16T08:00:00.000Z',
  dueAt: '2026-11-19T00:00:00.000Z',
  customerRef: { subjectResource: 'contact', subjectId: 'c-presti-1' },
  source: { kind: 'note', id: 'n-prova-1' },
};

function commitmentsViewClient({ feed } = {}) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { domains: { work: {}, appointments: {}, channels: {}, interactions: {} } };
      if (path === '/api/profile') return {};
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/oggi/commitments') return feed();
      if (path.startsWith('/api/modules/')) return { items: [] };
      if (path.startsWith('/api/customer-data/')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
}

test('la proposta del feed si legge nel giorno dipinto (nota → Oggi)', async () => {
  const client = commitmentsViewClient({
    feed: async () => ({ open: [FEED_PROPOSAL], messagesAvailable: true, notesAvailable: true, partial: false }),
  });
  const data = await loadOggiData(client, new Date('2026-11-16T09:00:00.000Z'));
  assert.deepEqual(data.commitments, [FEED_PROPOSAL], 'the load carries the feed into the day');
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOggiView({ doc, mount, client, navigate: () => {}, setTimer: () => null, clearTimer: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: new Date('2026-11-16T09:00:00.000Z') });
  assert.ok(mount.textContent.includes('ci sentiamo giovedì'), 'the painted day cites the written phrase');
  assert.ok(mount.textContent.includes('gioved'), 'the painted day names the Thursday deadline');
});

test('il feed rifiutato non rompe il giorno (fail-soft)', async () => {
  const client = commitmentsViewClient({
    feed: async () => { throw new Error('feed down'); },
  });
  const data = await loadOggiData(client, new Date('2026-11-16T09:00:00.000Z'));
  assert.deepEqual(data.commitments, [], 'no proposal, never a failure');
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOggiView({ doc, mount, client, navigate: () => {}, setTimer: () => null, clearTimer: () => {} });
  await view.render({ spaceName: 'Spazio', links: [], now: new Date('2026-11-16T09:00:00.000Z') });
  assert.ok(!mount.textContent.includes('ci sentiamo giovedì'), 'nothing invented without the feed');
});
