// @ts-check

/**
 * Offer stage moves proposed from a customer reply (accordo sales pipeline).
 *
 * When the customer answers in the conversation, the agent reads the message
 * and proposes the next pipeline step, quoting the sentence behind it —
 * e.g. «ha chiesto il prezzo → Proposta». Nothing moves by itself:
 * `routeOfferMoveFromReply` returns a `proposal` decision carrying a frozen
 * `offer-move-proposal`, and only `confirmOfferMoveProposal` — called by a
 * human actor — turns it into a confirmed move the caller applies (e.g. via
 * the `move-stage` action). The one exception is a space with the
 * `move-offers` AI switch on: then the route returns an `apply` decision and
 * the caller moves the offer straight away.
 *
 * A rejected proposal never comes back for the same message: the caller
 * passes the message ids it already refused (`rejectedMessageIds`, persisted
 * beside its own audit wherever it already audits writes) and a repeat
 * refuses with `OFFER_MOVE_ALREADY_REJECTED` instead of a new proposal.
 *
 * Everything here is pure and storage-agnostic: callers persist proposals
 * and decisions, resolve the `move-offers` switch (`space-permissions`
 * `effectivePermission`) and move the offer. No CRM table is touched.
 */

import { randomUUID } from 'node:crypto';
import { AppError, ForbiddenError, ValidationError } from '../core/src/errors.js';
import { nowIso } from '../core/src/time.js';

const SPACE_ID_MAX = 128;
const ID_MAX = 256;
const BODY_MAX = 20000;
const QUOTE_MAX = 2000;

/** @param {unknown} value @param {string} field @param {number} max */
function requireText(value, field, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new ValidationError(`${field} must be a non-empty string of at most ${max} characters`, { field });
  }
  return value;
}

/** @param {unknown} value */
function requireSpaceId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > SPACE_ID_MAX) {
    throw new ValidationError('spaceId must be a non-empty string of at most 128 characters', { field: 'spaceId' });
  }
  return value;
}

/** @param {unknown} value */
function requireSuggestedBy(value) {
  if (!value || typeof value !== 'object' || typeof value.type !== 'string' || typeof value.id !== 'string' || value.id === '') {
    throw new ValidationError('suggestedBy must name the proposer as { type, id }', { field: 'suggestedBy' });
  }
  return { type: value.type, id: value.id };
}

/**
 * Route one customer reply to either a stage proposal or a direct move.
 *
 * @param {{
 *   spaceId: unknown,
 *   opportunityId: unknown,
 *   messageId: unknown,
 *   messageBody: unknown,
 *   fromStage: unknown,
 *   toStage: unknown,
 *   quote: unknown,
 *   suggestedBy: unknown,
 *   moveOffersEnabled?: unknown,
 *   rejectedMessageIds?: unknown,
 * }} args
 */
export function routeOfferMoveFromReply(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ValidationError('routeOfferMoveFromReply needs an argument object', { field: 'args' });
  }
  const spaceId = requireSpaceId(args.spaceId);
  const opportunityId = requireText(args.opportunityId, 'opportunityId', ID_MAX);
  const messageId = requireText(args.messageId, 'messageId', ID_MAX);
  const messageBody = requireText(args.messageBody, 'messageBody', BODY_MAX);
  const fromStage = requireText(args.fromStage, 'fromStage', ID_MAX);
  const toStage = requireText(args.toStage, 'toStage', ID_MAX);
  if (toStage === fromStage) {
    throw new ValidationError('toStage must differ from fromStage: a proposal moves the offer somewhere else', {
      field: 'toStage',
      fromStage,
    });
  }
  const quote = requireText(args.quote, 'quote', QUOTE_MAX);
  if (!messageBody.includes(quote)) {
    throw new ValidationError('quote must be a sentence of the customer reply it motivates', {
      field: 'quote',
      messageId,
    });
  }
  const suggestedBy = requireSuggestedBy(args.suggestedBy);

  const rejected = args.rejectedMessageIds ?? [];
  if (!Array.isArray(rejected) || rejected.some((entry) => typeof entry !== 'string')) {
    throw new ValidationError('rejectedMessageIds must be an array of message id strings when provided', {
      field: 'rejectedMessageIds',
    });
  }
  if (rejected.includes(messageId)) {
    throw new AppError(
      `Offer move for message ${messageId} was already refused: a rejected proposal never comes back for the same message`,
      { code: 'OFFER_MOVE_ALREADY_REJECTED', status: 409, details: { spaceId, opportunityId, messageId } },
    );
  }

  if (args.moveOffersEnabled === true) {
    return Object.freeze({
      decision: 'apply',
      spaceId,
      opportunityId,
      messageId,
      fromStage,
      toStage,
      reason: `move-offers is on for this space: «${quote}» moves the offer from ${fromStage} to ${toStage} with no confirmation`,
      suggestedBy: Object.freeze({ ...suggestedBy }),
    });
  }

  return Object.freeze({
    decision: 'proposal',
    proposal: Object.freeze({
      kind: 'offer-move-proposal',
      id: randomUUID(),
      status: 'proposed',
      spaceId,
      opportunityId,
      messageId,
      fromStage,
      toStage,
      quote,
      proposedBy: Object.freeze({ ...suggestedBy }),
      proposedAt: nowIso(),
      decidedBy: null,
      decidedAt: null,
      reason: null,
    }),
  });
}

/**
 * Confirm or refuse a stage proposal. Only a person (`actor.type === 'user'`)
 * can decide — an AI decider refusing or confirming its own suggestion is
 * refused, so a proposal never moves the offer by itself.
 *
 * @param {any} proposal a proposal from `routeOfferMoveFromReply`
 * @param {{actor: unknown, decision: unknown, reason?: unknown}} args
 */
export function confirmOfferMoveProposal(proposal, { actor, decision, reason } = {}) {
  if (!proposal || proposal.kind !== 'offer-move-proposal') {
    throw new ValidationError('proposal must come from routeOfferMoveFromReply', { field: 'proposal' });
  }
  if (proposal.status !== 'proposed') {
    throw new AppError(`proposal ${proposal.id ?? ''} is already decided (${proposal.status})`, {
      code: 'PROPOSAL_ALREADY_DECIDED',
      status: 409,
      details: { id: proposal.id ?? null, status: proposal.status },
    });
  }
  if (!actor || typeof actor !== 'object' || typeof actor.type !== 'string' || typeof actor.id !== 'string' || actor.id === '') {
    throw new ValidationError('confirming an offer move requires an actor as { type, id }', { field: 'actor' });
  }
  if (actor.type !== 'user') {
    throw new ForbiddenError('only a person can confirm an offer move — an AI suggestion never moves the offer by itself');
  }
  if (decision !== 'accept' && decision !== 'reject') {
    throw new ValidationError('decision must be "accept" or "reject"', { field: 'decision' });
  }
  if (decision === 'reject' && (typeof reason !== 'string' || reason === '')) {
    throw new ValidationError('rejecting an offer move requires a reason', { field: 'reason' });
  }
  const decided = Object.freeze({
    ...proposal,
    status: decision === 'accept' ? 'confirmed' : 'rejected',
    decidedBy: Object.freeze({ type: actor.type, id: actor.id }),
    decidedAt: nowIso(),
    reason: typeof reason === 'string' ? reason : null,
  });
  return {
    proposal: decided,
    move: decision === 'accept'
      ? Object.freeze({ opportunityId: proposal.opportunityId, fromStage: proposal.fromStage, toStage: proposal.toStage })
      : null,
  };
}
