// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { checkPermissionKey, checkSpaceId } from './permissions.js';

/**
 * The `space-ai-proposal` lifecycle, pure.
 *
 * A proposal is what a switched-off AI action becomes: `proposed` on record,
 * then `approved` or `refused` by a human, both terminal. There is no draft
 * state — recording the proposal IS the plan step — and no execution state:
 * executing the approved action stays the consumer's job, outside this
 * package. An approved proposal is the evidence a human authorized that one
 * action, nothing more.
 */

export const PROPOSAL_STATES = Object.freeze(['proposed', 'approved', 'refused']);
export const PROPOSAL_TERMINAL = Object.freeze(['approved', 'refused']);

const MAX_TEXT = 2000;
const MAX_KEY = 256;

/** @param {unknown} value @param {string} field */
function boundedText(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_TEXT) {
    throw new ValidationError(`${field} must be non-empty text of at most ${MAX_TEXT} characters`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function boundedKey(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_KEY) {
    throw new ValidationError(`${field} must be a non-empty key of at most ${MAX_KEY} characters`, { field });
  }
  return value;
}

/**
 * Build the stored row for one proposal. Deterministic identity:
 * `spaceId:permission:actionKey` — proposing the same action twice replays
 * the first proposal instead of opening a second one.
 *
 * @param {{spaceId: unknown, permission: unknown, actionKind: unknown, actionKey: unknown, summary: unknown, proposedAt: unknown}} input
 * @returns {{spaceId: string, permission: string, actionKind: string, actionKey: string, summary: string, sourceKey: string, status: string, proposedAt: string}} frozen
 */
export function buildAiProposal(input) {
  const record = input && typeof input === 'object' ? input : {};
  const spaceId = checkSpaceId(record.spaceId);
  const permission = checkPermissionKey(record.permission);
  const actionKind = boundedText(record.actionKind, 'actionKind');
  const actionKey = boundedKey(record.actionKey, 'actionKey');
  const summary = boundedText(record.summary, 'summary');
  if (typeof record.proposedAt !== 'string' || record.proposedAt.trim() === '') {
    throw new ValidationError('proposedAt must be an instant supplied by the caller', { field: 'proposedAt' });
  }
  return Object.freeze({
    spaceId,
    permission,
    actionKind,
    actionKey,
    summary,
    sourceKey: `${spaceId}:${permission}:${actionKey}`,
    status: 'proposed',
    proposedAt: record.proposedAt,
  });
}

/**
 * Decide one proposed row as a human. Recomputes terminality from the stored
 * row: an already-decided proposal is refused again with a typed conflict,
 * never re-decided.
 *
 * @param {{proposal: unknown, decision: unknown, actorId: unknown, decidedAt: unknown, refusalReason?: unknown}} input
 * @returns {{patch: {status: string, decidedBy: string, decidedAt: string, refusalReason: string | null}}} frozen
 */
export function decideAiProposal(input) {
  const record = input && typeof input === 'object' ? input : {};
  const proposal = record.proposal && typeof record.proposal === 'object' ? record.proposal : {};
  if (proposal.status !== 'proposed') {
    throw new AppError('Only a proposed AI action can be decided', {
      code: 'SPACE_PROPOSAL_STATE_INVALID', status: 409,
    });
  }
  const decision = record.decision;
  if (decision !== 'approved' && decision !== 'refused') {
    throw new ValidationError('decision must be approved or refused', { field: 'decision' });
  }
  if (typeof record.actorId !== 'string' || record.actorId.trim() === '') {
    throw new ValidationError('actorId must identify the deciding human', { field: 'actorId' });
  }
  if (typeof record.decidedAt !== 'string' || record.decidedAt.trim() === '') {
    throw new ValidationError('decidedAt must be an instant supplied by the caller', { field: 'decidedAt' });
  }
  let refusalReason = null;
  if (decision === 'refused') {
    refusalReason = typeof record.refusalReason === 'string' && record.refusalReason !== ''
      ? record.refusalReason.slice(0, MAX_TEXT)
      : 'no reason given';
  }
  return Object.freeze({
    patch: Object.freeze({
      status: decision,
      decidedBy: record.actorId,
      decidedAt: record.decidedAt,
      refusalReason,
    }),
  });
}
