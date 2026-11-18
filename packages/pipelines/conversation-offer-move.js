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
 * the `move-stage` action). The one exception is a space where the agent may
 * move offers alone: then the route returns an `apply` decision and the
 * caller moves the offer straight away.
 *
 * A rejected proposal never comes back for the same message: the caller
 * passes the message ids it already refused (`rejectedMessageIds`, persisted
 * beside its own audit wherever it already audits writes) and a repeat
 * refuses with `OFFER_MOVE_ALREADY_REJECTED` instead of a new proposal.
 *
 * Everything here is pure and storage-agnostic: callers persist proposals
 * and decisions, pass their stored `space-permission-override` rows as
 * `overrideRows`, and move the offer. When `overrideRows` is omitted every
 * reply stays a proposal (fail-closed): only explicitly passed rows may
 * auto-apply. The auto-apply gate lives inside this
 * module and always honors the master `ai-enabled` switch together with the
 * `move-offers` switch (`space-permissions` `isAiActionAllowed`): callers
 * must NOT pre-resolve with `effectivePermission`, which ignores the master
 * kill-switch. Moves that reach `move-stage` carry `spaceId` and, for the
 * lost stage, the non-blank close `reason` it requires. No CRM table is
 * touched.
 */

import { randomUUID } from 'node:crypto';
import { AppError, ForbiddenError, ValidationError } from '../core/src/errors.js';
import { findStage } from '../core/src/pipeline-registry.js';
import { nowIso } from '../core/src/time.js';
import { isAiActionAllowed } from '../space-permissions/src/permissions.js';
import { accordoSalesPipeline } from './accordo-sales.js';

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
 *   reason?: unknown,
 *   overrideRows?: unknown,
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
  const currentStage = findStage(accordoSalesPipeline, fromStage);
  if (!currentStage) {
    throw new ValidationError('fromStage must be one of the accordo-sales pipeline stages', {
      field: 'fromStage',
      allowed: accordoSalesPipeline.stages.map((stage) => stage.key),
    });
  }
  if (currentStage.type !== 'open' && currentStage.type !== 'renewal') {
    throw new AppError(
      `Cannot move out of terminal stage "${currentStage.key}" (${currentStage.type}); reopening is not supported`,
      { code: 'TERMINAL_STAGE', status: 409, details: { stage: currentStage.key, type: currentStage.type } },
    );
  }
  const targetStage = findStage(accordoSalesPipeline, toStage);
  if (!targetStage) {
    throw new ValidationError('toStage must be one of the accordo-sales pipeline stages', {
      field: 'toStage',
      allowed: accordoSalesPipeline.stages.map((stage) => stage.key),
    });
  }
  if (toStage === fromStage) {
    throw new ValidationError('toStage must differ from fromStage: a proposal moves the offer somewhere else', {
      field: 'toStage',
      fromStage,
    });
  }
  const closeReason = args.reason === undefined || args.reason === null
    ? null
    : requireText(args.reason, 'reason', QUOTE_MAX);
  const needsCloseReason = targetStage.type === 'lost';
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

  // Fail-closed: without the space's own override rows the gate cannot know
  // the space switched move-offers on (the documented defaults are on), so
  // the road is always a proposal. Only explicitly passed rows may auto-apply.
  const hasOverrideRows = args.overrideRows !== undefined && args.overrideRows !== null;
  const overrideRows = hasOverrideRows ? args.overrideRows : [];
  if (!Array.isArray(overrideRows)) {
    throw new ValidationError('overrideRows must be an array of space-permission-override rows when provided', {
      field: 'overrideRows',
    });
  }
  // The master ai-enabled switch gates everything: with the master off every
  // reply stays a proposal, whatever the move-offers switch says.
  if (hasOverrideRows && isAiActionAllowed(spaceId, 'move-offers', overrideRows)) {
    if (needsCloseReason && !closeReason) {
      throw new ValidationError('reason is required when moving to the lost stage', { field: 'reason' });
    }
    return Object.freeze({
      decision: 'apply',
      spaceId,
      opportunityId,
      messageId,
      fromStage,
      toStage,
      ...(needsCloseReason ? { reason: closeReason } : {}),
      move: Object.freeze({
        opportunityId,
        spaceId,
        fromStage,
        toStage,
        ...(needsCloseReason ? { reason: closeReason } : {}),
      }),
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
      closeReason,
      needsCloseReason,
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
  // A confirmed move to the lost stage must satisfy the move-stage contract:
  // move-stage refuses a lost move with no reason, so the accept carries the
  // close reason — supplied at confirm time, or suggested with the proposal.
  // The proposal is untrusted input (the caller persists it): its ids and
  // stages are re-checked against the same accordo-sales pipeline the route
  // uses. An unknown stage is refused, never coerced into a lost move.
  const confirmedSpaceId = requireSpaceId(proposal.spaceId);
  const confirmedOpportunityId = requireText(proposal.opportunityId, 'opportunityId', ID_MAX);
  if (!findStage(accordoSalesPipeline, proposal.fromStage)) {
    throw new ValidationError('proposal fromStage must be one of the accordo-sales pipeline stages', {
      field: 'proposal.fromStage',
      allowed: accordoSalesPipeline.stages.map((stage) => stage.key),
    });
  }
  const targetStage = typeof proposal.toStage === 'string' ? findStage(accordoSalesPipeline, proposal.toStage) : null;
  if (!targetStage) {
    throw new ValidationError('proposal toStage must be one of the accordo-sales pipeline stages', {
      field: 'proposal.toStage',
      allowed: accordoSalesPipeline.stages.map((stage) => stage.key),
    });
  }
  const needsCloseReason = targetStage.type === 'lost';
  const acceptReason = typeof reason === 'string' && reason !== ''
    ? reason
    : (typeof proposal.closeReason === 'string' && proposal.closeReason !== '' ? proposal.closeReason : null);
  if (decision === 'accept' && needsCloseReason && !acceptReason) {
    throw new ValidationError('accepting a move to the lost stage requires a reason', { field: 'reason' });
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
      ? Object.freeze({
        opportunityId: confirmedOpportunityId,
        spaceId: confirmedSpaceId,
        fromStage: proposal.fromStage,
        toStage: proposal.toStage,
        ...(needsCloseReason ? { reason: acceptReason } : {}),
      })
      : null,
  };
}
