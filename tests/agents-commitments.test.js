import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMMITMENT_KINDS,
  commitmentThreadKey,
  extractCommitments,
  recalcCommitments,
  recordCommitmentDismissal,
} from '../packages/agents/src/commitments.js';

/**
 * Commitment reminders (backlog:df9e199eb4ef), first slice: the pure
 * extraction and re-checking model. A team message promising something,
 * a note setting a callback and an unanswered customer request each yield
 * one proposal with its quoted phrase and deadline; phrases that promise
 * nothing yield nothing; a later team message on the same thread closes
 * the proposal at recalculation; «Ignora» never resurfaces. No LLM, no
 * network — the functions are synchronous by construction, so with the
 * AI off the run is identical. Relative deadlines anchor to the source
 * row's own date (review #1019 giro 1): re-reading the same rows
 * tomorrow keeps the original deadline.
 */

const TOMORROW_9AM = '2026-11-17T09:00:00.000Z';
const THURSDAY_9AM = '2026-11-19T09:00:00.000Z';

function teamMessage(overrides = {}) {
  return {
    id: 'm-team-1',
    direction: 'outbound',
    channel: 'whatsapp',
    conversationId: 'conv-1',
    occurredAt: '2026-11-16T08:00:00Z',
    subjectResource: 'contact',
    subjectId: 'c1',
    body: 'Ciao, ti mando il listino domani',
    ...overrides,
  };
}

function customerMessage(overrides = {}) {
  return {
    id: 'm-cust-1',
    direction: 'inbound',
    channel: 'whatsapp',
    conversationId: 'conv-1',
    occurredAt: '2026-11-16T08:00:00Z',
    subjectResource: 'contact',
    subjectId: 'c1',
    body: 'Ciao, mandami il preventivo',
    ...overrides,
  };
}

function teamNote(overrides = {}) {
  return {
    id: 'n1',
    kind: 'note',
    body: 'Ci sentiamo giovedì',
    occurredAt: '2026-11-16T08:00:00Z',
    subjectResource: 'contact',
    subjectId: 'c1',
    ...overrides,
  };
}

test('a team message promising a send yields a proposal with the quoted phrase and tomorrow', () => {
  const found = extractCommitments({ messages: [teamMessage()] });
  assert.equal(found.length, 1);
  const [proposal] = found;
  assert.equal(proposal.kind, COMMITMENT_KINDS.TEAM_PROMISE);
  assert.ok(proposal.quote.includes('ti mando il listino domani'));
  assert.equal(proposal.dueAt, TOMORROW_9AM);
  assert.equal(proposal.dueLabel, 'domani');
  assert.equal(proposal.key, 'commit:message:m-team-1');
});

test('a note setting a callback yields a proposal due Thursday linked to the note customer', () => {
  const found = extractCommitments({ notes: [teamNote()] });
  assert.equal(found.length, 1);
  const [proposal] = found;
  assert.equal(proposal.kind, COMMITMENT_KINDS.TEAM_PROMISE);
  assert.ok(proposal.quote.includes('Ci sentiamo giovedì'));
  assert.equal(proposal.dueAt, THURSDAY_9AM);
  assert.equal(proposal.customerRef.subjectId, 'c1');
  assert.equal(proposal.source.kind, 'note');
});

test('an unanswered customer request yields a proposal for the team', () => {
  const found = extractCommitments({ messages: [customerMessage()] });
  assert.equal(found.length, 1);
  const [proposal] = found;
  assert.equal(proposal.kind, COMMITMENT_KINDS.CUSTOMER_REQUEST);
  assert.ok(proposal.quote.includes('mandami il preventivo'));
});

test('re-reading the same rows later keeps the original deadline', () => {
  // The source rows say Monday: «domani» stays Tuesday no matter when
  // the run re-reads them — the deadline never slides forward.
  const first = extractCommitments({ messages: [teamMessage()], notes: [teamNote()] });
  const second = extractCommitments({ messages: [teamMessage()], notes: [teamNote()] });
  assert.equal(first[0].dueAt, TOMORROW_9AM);
  assert.equal(second[0].dueAt, first[0].dueAt);
  assert.equal(second[1].dueAt, THURSDAY_9AM);
});

test('phrases that promise nothing yield nothing, including past-tense receipts', () => {
  const bodies = [
    'Il listino è pronto',
    'Grazie mille!',
    'Ok, a presto',
    'Ti ho mandato il listino ieri',
    'Abbiamo inviato tutto la settimana scorsa',
  ];
  for (const body of bodies) {
    const team = extractCommitments({ messages: [teamMessage({ id: `t-${body.length}`, body })] });
    assert.equal(team.length, 0, `team promises nothing: ${body}`);
    const customer = extractCommitments({ messages: [customerMessage({ id: `c-${body.length}`, body })] });
    assert.equal(customer.length, 0, `customer requests nothing: ${body}`);
  }
});

test('a later team message on the same thread closes the proposal at recalculation', () => {
  const open = extractCommitments({ messages: [teamMessage()] });
  assert.equal(open.length, 1);
  const later = teamMessage({ id: 'm-team-2', body: 'Ecco il listino in allegato', occurredAt: '2026-11-16T10:00:00Z' });
  const recalculated = recalcCommitments({ commitments: open, messages: [teamMessage(), later] });
  assert.equal(recalculated.open.length, 0);
  assert.equal(recalculated.closed.length, 1);
  assert.equal(recalculated.closed[0].closedBy, 'm-team-2');
});

test('a customer request answered by the team closes too; a team message elsewhere does not', () => {
  const open = extractCommitments({ messages: [customerMessage()] });
  assert.equal(open.length, 1);
  const answer = teamMessage({ id: 'm-team-2', body: 'Certo, te lo mando subito', occurredAt: '2026-11-16T10:00:00Z' });
  const answered = recalcCommitments({ commitments: open, messages: [customerMessage(), answer] });
  assert.equal(answered.open.length, 0);
  assert.equal(answered.closed.length, 1);
  const elsewhere = teamMessage({
    id: 'm-team-3', conversationId: 'conv-9', body: 'Ecco qui', occurredAt: '2026-11-16T10:00:00Z',
  });
  const untouched = recalcCommitments({ commitments: open, messages: [customerMessage(), elsewhere] });
  assert.equal(untouched.open.length, 1);
  assert.equal(untouched.closed.length, 0);
});

test('a note commitment closes on a later team message for the same customer (review #1019 P1)', () => {
  const open = extractCommitments({ notes: [teamNote()] });
  assert.equal(open.length, 1);
  assert.ok(open[0].thread.startsWith('subject:'));
  const later = teamMessage({ id: 'm-team-2', body: 'Ecco il listino in allegato', occurredAt: '2026-11-16T10:00:00Z' });
  const recalculated = recalcCommitments({ commitments: open, messages: [later] });
  assert.equal(recalculated.open.length, 0);
  assert.equal(recalculated.closed.length, 1);
  assert.equal(recalculated.closed[0].closedBy, 'm-team-2');
});

test('a note commitment stays open on a team message for another customer', () => {
  const open = extractCommitments({ notes: [teamNote()] });
  assert.equal(open.length, 1);
  const other = teamMessage({
    id: 'm-team-9', subjectId: 'c9', conversationId: 'conv-9',
    body: 'Ecco qui', occurredAt: '2026-11-16T10:00:00Z',
  });
  const untouched = recalcCommitments({ commitments: open, messages: [other] });
  assert.equal(untouched.open.length, 1);
  assert.equal(untouched.closed.length, 0);
});

test('«Ignora» records a dismissal with its reason and the proposal never returns', () => {
  const open = extractCommitments({ messages: [teamMessage()] });
  const dismissed = recordCommitmentDismissal({}, open[0].key, 'Il cliente ha già il listino');
  const recalculated = recalcCommitments({ commitments: open, messages: [teamMessage()], dismissed });
  assert.equal(recalculated.open.length, 0);
  assert.equal(recalculated.closed.length, 0);
  assert.throws(() => recordCommitmentDismissal({}, '', 'perché'), /dismissal\.key/);
  assert.throws(() => recordCommitmentDismissal({}, open[0].key, '  '), /dismissal\.reason/);
});

test('malformed rows contribute nothing and never crash', () => {
  const found = extractCommitments({
    messages: [null, {}, { id: 'x' }, { id: 'y', direction: 'sideways', body: 'ti mando tutto domani' }],
    notes: [null, { id: 'z' }],
  });
  assert.equal(found.length, 0);
  const recalculated = recalcCommitments({ commitments: [null, {}], messages: null, dismissed: null });
  assert.equal(recalculated.open.length, 0);
  assert.equal(recalculated.closed.length, 0);
});

test('extraction and re-checking are synchronous: no async seam, no LLM call possible', () => {
  const extracted = extractCommitments({ messages: [teamMessage()] });
  assert.ok(!(extracted instanceof Promise));
  const recalculated = recalcCommitments({ commitments: [...extracted], messages: [] });
  assert.ok(!(recalculated instanceof Promise));
  assert.ok(!(recalculated.open instanceof Promise));
  const dismissed = recordCommitmentDismissal({}, 'commit:message:m-team-1', 'motivo');
  assert.ok(!(dismissed instanceof Promise));
  assert.ok(Object.isFrozen(extracted) && Object.isFrozen(recalculated.open));
});

test('threads group by conversation, or by customer and channel without one', () => {
  assert.equal(commitmentThreadKey({ conversationId: 'conv-1' }), 'conversation:conv-1');
  assert.equal(
    commitmentThreadKey({ subjectId: 'c1', subjectResource: 'contact', channel: 'whatsapp' }),
    'subject:contact:c1:whatsapp',
  );
  assert.equal(commitmentThreadKey({}), '');
});
