import test from 'node:test';
import assert from 'node:assert/strict';
import {
  confirmOfferMoveProposal,
  routeOfferMoveFromReply,
} from '../packages/pipelines/conversation-offer-move.js';

/**
 * Conversations: the agent proposes the pipeline step from the customer
 * reply (KOMBO map, sections 8-9), the step moves only after confirmation
 * unless the `move-offers` switch is on for the space, and a refused
 * proposal never comes back for the same message.
 */

const SPACE = 'space-presti';
const OPPORTUNITY = 'opp-1';
const AI = { type: 'agent', id: 'reply-reader' };
const PERSON = { type: 'user', id: 'coach-guido' };

/**
 * Fake AI: a deterministic stand-in for the reply reader. It suggests a
 * step from keywords and always grounds the suggestion in one sentence of
 * the reply it read.
 */
function fakeSuggestStage(messageBody, fromStage) {
  const sentence = (word) => messageBody.split(/(?<=[.!?])\s+/).find((part) => part.includes(word)) ?? null;
  if (fromStage === 'richiesta-info' && messageBody.includes('prezzo')) {
    return { toStage: 'proposta', quote: sentence('prezzo') };
  }
  if (fromStage === 'prova' && messageBody.includes('iniziare')) {
    return { toStage: 'proposta', quote: sentence('iniziare') };
  }
  if (messageBody.includes('non mi interessa')) {
    return { toStage: 'perso', quote: sentence('non mi interessa') };
  }
  return null;
}

function route(body, fromStage, overrides = {}) {
  const suggestion = fakeSuggestStage(body, fromStage);
  assert.ok(suggestion, 'the fake AI reads a step in this reply');
  return routeOfferMoveFromReply({
    spaceId: SPACE,
    opportunityId: OPPORTUNITY,
    messageId: 'wa:msg:1',
    messageBody: body,
    fromStage,
    toStage: suggestion.toStage,
    quote: suggestion.quote,
    suggestedBy: AI,
    ...overrides,
  });
}

// Acceptance: one reply produces one step proposal with the sentence behind it.
test('a reply produces a step proposal quoting the sentence that motivates it', () => {
  const body = 'Ciao! Quanto è il prezzo del pacchetto da dieci ingressi? Vorrei capire prima di venire.';
  const routed = route(body, 'richiesta-info');

  assert.equal(routed.decision, 'proposal');
  assert.equal(routed.proposal.status, 'proposed');
  assert.equal(routed.proposal.fromStage, 'richiesta-info');
  assert.equal(routed.proposal.toStage, 'proposta');
  assert.ok(body.includes(routed.proposal.quote), 'the quote is a sentence of the reply');
  assert.match(routed.proposal.quote, /prezzo/);
  assert.deepEqual(routed.proposal.proposedBy, AI);
  assert.ok(Object.isFrozen(routed) && Object.isFrozen(routed.proposal));
});

// Acceptance: the step moves only after confirmation, unless move-offers is on.
test('the step moves only after a person confirms, or straight away with move-offers on', () => {
  const body = 'Grazie, vorrei iniziare con il pacchetto da dieci ingressi.';

  // Switch off: the proposal moves nothing by itself.
  const routed = route(body, 'prova', { messageId: 'wa:msg:2', moveOffersEnabled: false });
  assert.equal(routed.decision, 'proposal');
  assert.equal(routed.proposal.status, 'proposed');

  // The agent cannot confirm its own suggestion.
  assert.throws(
    () => confirmOfferMoveProposal(routed.proposal, { actor: AI, decision: 'accept' }),
    (error) => error.code === 'FORBIDDEN',
  );

  // A person confirms: the caller may now move the offer, and only to the
  // proposed step.
  const { proposal, move } = confirmOfferMoveProposal(routed.proposal, { actor: PERSON, decision: 'accept' });
  assert.equal(proposal.status, 'confirmed');
  assert.deepEqual(proposal.decidedBy, PERSON);
  assert.deepEqual(move, { opportunityId: OPPORTUNITY, fromStage: 'prova', toStage: 'proposta' });

  // Switch on for the space: the reply moves the offer with no confirmation.
  const direct = route(body, 'prova', { messageId: 'wa:msg:3', moveOffersEnabled: true });
  assert.equal(direct.decision, 'apply');
  assert.equal(direct.fromStage, 'prova');
  assert.equal(direct.toStage, 'proposta');
});

// Acceptance: the refused proposal never comes back for the same message.
test('a refused proposal never returns for the same message, but new replies still propose', () => {
  const body = 'Grazie ma non mi interessa più, cancellate pure tutto.';
  const first = route(body, 'proposta', { messageId: 'wa:msg:9' });
  assert.equal(first.proposal.toStage, 'perso');

  const refused = confirmOfferMoveProposal(first.proposal, {
    actor: PERSON, decision: 'reject', reason: 'the customer may still renew in September',
  });
  assert.equal(refused.proposal.status, 'rejected');
  assert.equal(refused.move, null);

  // The same message proposing again is refused: the caller records
  // `wa:msg:9` in its rejected ids and passes them back.
  assert.throws(
    () => route(body, 'proposta', { messageId: 'wa:msg:9', rejectedMessageIds: ['wa:msg:9'] }),
    (error) => {
      assert.equal(error.code, 'OFFER_MOVE_ALREADY_REJECTED');
      assert.equal(error.status, 409);
      return true;
    },
  );

  // A new reply from the customer still produces its proposal.
  const next = route('no grazie, non mi interessa davvero.', 'proposta', { messageId: 'wa:msg:10' });
  assert.equal(next.decision, 'proposal');
  assert.equal(next.proposal.toStage, 'perso');
});

// Guards: same step, ungrounded quote, rejecting without a reason.
test('guards: no move to the same step, quotes from the reply, reasons for refusals', () => {
  const body = 'Quanto è il prezzo del pacchetto?';
  assert.throws(
    () => routeOfferMoveFromReply({
      spaceId: SPACE,
      opportunityId: OPPORTUNITY,
      messageId: 'wa:msg:4',
      messageBody: body,
      fromStage: 'richiesta-info',
      toStage: 'richiesta-info',
      quote: 'Quanto è il prezzo del pacchetto?',
      suggestedBy: AI,
    }),
    /toStage must differ from fromStage/,
  );
  assert.throws(
    () => routeOfferMoveFromReply({
      spaceId: SPACE,
      opportunityId: OPPORTUNITY,
      messageId: 'wa:msg:6',
      messageBody: body,
      fromStage: 'richiesta-info',
      toStage: 'proposta',
      quote: 'the customer asked for a discount',
      suggestedBy: AI,
    }),
    /quote must be a sentence of the customer reply/,
  );
  const routed = route(body, 'richiesta-info', { messageId: 'wa:msg:5' });
  assert.throws(
    () => confirmOfferMoveProposal(routed.proposal, { actor: PERSON, decision: 'reject' }),
    /rejecting an offer move requires a reason/,
  );
  assert.throws(
    () => confirmOfferMoveProposal({ ...routed.proposal, status: 'confirmed' }, { actor: PERSON, decision: 'accept' }),
    (error) => error.code === 'PROPOSAL_ALREADY_DECIDED',
  );
});
