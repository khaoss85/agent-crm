// @ts-check

/**
 * Offer send gate (accordo BO-F2-06, backoffice "06 Pipeline").
 *
 * The prototype rule: above 20.000 € the titolare must approve, then the
 * offer goes out on the preferred channel with a Stripe link for the
 * 30% deposit. Owner decision Q-C2 (19/10): "la titolare" is a role
 * assigned per space (mirrored from the control plane as `owner`, see
 * `packages/space-permissions/src/invites.js` — the framework never stores
 * members); the threshold (default 20.000 €) and the deposit share
 * (default 30%) are configurable per space.
 *
 * What this file is: a deterministic, storage-agnostic policy. It never
 * touches the network, secrets, or tables, and it mints nothing: callers
 * enforce `authorizeOfferSend` before they send bytes through the existing
 * channels reply flow (preferred channel, BO-F1-07) and before they mint
 * the deposit checkout through the existing payments package (the fixture
 * Stripe adapter in tests, the real one when credentials exist). No
 * doubles (MEM_ACC_REUSE):
 *
 * - approvals are `packages/modules/approval` rows (`status: approved`);
 *   the role check takes the approver's space role as an explicit input
 *   because membership lives in the control plane, not here;
 * - the deposit link is `packages/payments` `requestPayment`/
 *   `createPayment` on the deposit amount this file computes;
 * - the send itself stays the channels package's reply path.
 *
 * Fail-closed: an unreadable amount, an unknown approval shape, a missing
 * owner, or a non-owner approval blocks both the send and the link with a
 * typed reason. The threshold is a deterministic rule: at or below it the
 * offer sends with no approval; above it nothing sends and no link is
 * minted without a registered `approved` approval decided by the owner
 * role of that space.
 */

import { ValidationError } from '../core/src/errors.js';

export const OFFER_SEND_GATE = 'offer-send-gate';
export const OFFER_SEND_GATE_VERSION = 1;

/** Default threshold: 20.000 € in minor units (per-space configurable). */
export const DEFAULT_OFFER_SEND_THRESHOLD_CENTS = 2_000_000;
/** Default deposit share: 30% in basis points (per-space configurable). */
export const DEFAULT_DEPOSIT_BPS = 3000;
/**
 * The space role that may release an above-threshold offer. "La titolare"
 * is the control-plane `owner` role mirrored by the space-permissions
 * package; operator/observer can never approve, whatever their user id.
 */
export const OWNER_ROLE = 'owner';

const MAX_THRESHOLD_CENTS = 1_000_000_000_000;
const MAX_ROLE_CHARS = 64;
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** @param {unknown} value @param {string} field */
function requireThresholdCents(value, field = 'thresholdCents') {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_THRESHOLD_CENTS) {
    throw new ValidationError(`${field} must be a positive safe integer of at most ${MAX_THRESHOLD_CENTS} cents`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireDepositBps(value, field = 'depositBps') {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new ValidationError(`${field} must be an integer of 1..10000 basis points`, { field });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireRole(value, field = 'requiredRole') {
  if (typeof value !== 'string' || value.trim() === '' || value.length > MAX_ROLE_CHARS
    || HOSTILE_KEYS.includes(value) || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ValidationError(`${field} must be bounded single-line role text of at most ${MAX_ROLE_CHARS} characters`, { field });
  }
  return value;
}

/** @param {unknown} value */
function requireAmountCents(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_THRESHOLD_CENTS * 10) {
    throw new ValidationError('amountCents must be a non-negative safe integer amount in minor units', { field: 'amountCents' });
  }
  return value;
}

/**
 * Build the per-space BO-F2-06 policy, ready to keep beside the space
 * overrides (like `customizePipelineStages` output): pure data, persisted
 * by the caller, never a table write here.
 *
 * @param {{thresholdCents?: unknown, depositBps?: unknown, requiredRole?: unknown}} [config]
 */
export function createOfferSendPolicy(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ValidationError('offer send policy config must be a plain object', { field: 'config' });
  }
  const thresholdCents = config.thresholdCents === undefined
    ? DEFAULT_OFFER_SEND_THRESHOLD_CENTS
    : requireThresholdCents(config.thresholdCents);
  const depositBps = config.depositBps === undefined
    ? DEFAULT_DEPOSIT_BPS
    : requireDepositBps(config.depositBps);
  const requiredRole = config.requiredRole === undefined
    ? OWNER_ROLE
    : requireRole(config.requiredRole);
  return Object.freeze({
    name: OFFER_SEND_GATE,
    version: OFFER_SEND_GATE_VERSION,
    label: 'Offerta sopra soglia: ok titolare, poi invio + acconto (BO-F2-06)',
    config: Object.freeze({ thresholdCents, depositBps, requiredRole }),
    evaluate: (ctx) => evaluateOfferAmount({ ...ctx, policy: { thresholdCents, depositBps, requiredRole } }),
  });
}

/**
 * The deterministic threshold rule without any approval I/O: at or below
 * the threshold the offer sends; above it an approval is required.
 *
 * @param {{amountCents: unknown, policy?: {thresholdCents?: unknown}}} ctx
 */
export function evaluateOfferAmount(ctx = {}) {
  const amountCents = requireAmountCents(ctx?.amountCents);
  const policy = ctx?.policy ?? {};
  const thresholdCents = policy.thresholdCents === undefined
    ? DEFAULT_OFFER_SEND_THRESHOLD_CENTS
    : requireThresholdCents(policy.thresholdCents, 'policy.thresholdCents');
  if (amountCents <= thresholdCents) {
    return Object.freeze({
      decision: 'send',
      reason: `offer ${amountCents}c within the ${thresholdCents}c threshold: no approval needed`,
      matchedRule: 'within-threshold',
      thresholdCents,
    });
  }
  return Object.freeze({
    decision: 'approval_required',
    reason: `offer ${amountCents}c above the ${thresholdCents}c threshold: owner approval required`,
    matchedRule: 'above-threshold',
    thresholdCents,
  });
}

/**
 * Deposit share of an offer amount, in minor units. Deterministic integer
 * math (rounded to the nearest cent), so the payments intent and the
 * receipt agree on the figure.
 *
 * @param {unknown} amountCents @param {unknown} [depositBps]
 */
export function computeDepositCents(amountCents, depositBps = DEFAULT_DEPOSIT_BPS) {
  const amount = requireAmountCents(amountCents);
  const bps = requireDepositBps(depositBps);
  return Math.floor((amount * bps + 5000) / 10_000);
}

/**
 * Authorize one offer send (and its deposit link) for one space.
 *
 * Both the send and the link share the single verdict: above the
 * threshold with no usable approval, `sendAllowed` and `linkAllowed` are
 * both false and the caller must mint nothing. The approval is a
 * `packages/modules/approval` row; `approverRole` is the decider's space
 * role resolved by the caller from control-plane membership (the
 * framework stores no members). `spaceHasOwner: false` means the space
 * has no titolare assigned: the offer blocks with its reason, because no
 * one in that space can release it.
 *
 * The gate does not bind the approval to the offer (no storage here): the
 * caller passes only the approval row already loaded for this offer
 * (e.g. `findPendingByOpportunity` / `get`) and keeps that linkage in its
 * own audit, exactly like the quote approval link (`approval.quoteId`)
 * the commercial package checks before stamping.
 *
 * @param {{
 *   amountCents: unknown,
 *   policy?: {thresholdCents?: unknown, depositBps?: unknown, requiredRole?: unknown},
 *   approval?: {status?: unknown, decidedBy?: unknown} | null,
 *   approverRole?: unknown,
 *   spaceHasOwner?: unknown,
 * }} args
 */
export function authorizeOfferSend(args = {}) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ValidationError('authorizeOfferSend needs an argument object', { field: 'args' });
  }
  const amountCents = requireAmountCents(args.amountCents);
  const rawPolicy = args.policy ?? {};
  if (rawPolicy === null || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
    throw new ValidationError('policy must be an object when provided', { field: 'policy' });
  }
  const thresholdCents = rawPolicy.thresholdCents === undefined
    ? DEFAULT_OFFER_SEND_THRESHOLD_CENTS
    : requireThresholdCents(rawPolicy.thresholdCents, 'policy.thresholdCents');
  const depositBps = rawPolicy.depositBps === undefined
    ? DEFAULT_DEPOSIT_BPS
    : requireDepositBps(rawPolicy.depositBps, 'policy.depositBps');
  const requiredRole = rawPolicy.requiredRole === undefined
    ? OWNER_ROLE
    : requireRole(rawPolicy.requiredRole, 'policy.requiredRole');

  const frozen = (verdict) => Object.freeze({
    sendAllowed: verdict.sendAllowed,
    linkAllowed: verdict.sendAllowed,
    depositCents: verdict.sendAllowed ? computeDepositCents(amountCents, depositBps) : 0,
    depositBps: verdict.sendAllowed ? depositBps : 0,
    reason: verdict.reason,
    matchedRule: verdict.matchedRule,
    thresholdCents,
    requiredRole,
  });

  if (amountCents <= thresholdCents) {
    return frozen({
      sendAllowed: true,
      reason: `offer ${amountCents}c within the ${thresholdCents}c threshold: send, no approval needed`,
      matchedRule: 'within-threshold',
    });
  }

  if (args.spaceHasOwner === false) {
    return frozen({
      sendAllowed: false,
      reason: `offer ${amountCents}c above the ${thresholdCents}c threshold and the space has no ${requiredRole}: assign the owner role before sending`,
      matchedRule: 'blocked-no-owner',
    });
  }

  const approval = args.approval ?? null;
  const approved = approval !== null && typeof approval === 'object'
    && !Array.isArray(approval) && approval.status === 'approved';
  if (!approved) {
    const status = approval !== null && typeof approval === 'object' && !Array.isArray(approval)
      && typeof approval.status === 'string' ? approval.status : 'none';
    return frozen({
      sendAllowed: false,
      reason: `offer ${amountCents}c above the ${thresholdCents}c threshold: no registered ${requiredRole} approval (approval status: ${status})`,
      matchedRule: 'approval-required',
    });
  }

  const role = typeof args.approverRole === 'string' ? args.approverRole : '';
  if (role !== requiredRole) {
    return frozen({
      sendAllowed: false,
      reason: `offer ${amountCents}c above the ${thresholdCents}c threshold: approval decided by "${role || 'unknown'}", only ${requiredRole} releases it`,
      matchedRule: 'approver-not-owner',
    });
  }

  return frozen({
    sendAllowed: true,
    reason: `offer ${amountCents}c above the ${thresholdCents}c threshold: registered ${requiredRole} approval, send with a ${depositBps}bps deposit link`,
    matchedRule: 'approved-by-owner',
  });
}
