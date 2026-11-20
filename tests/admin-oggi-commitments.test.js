// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { selectOpenCommitments } from '../packages/agents/src/commitments.js';
import { buildAdvisorActions } from '../apps/admin/public/admin-oggi.js';

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
