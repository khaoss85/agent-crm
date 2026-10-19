// @ts-check

import { AppError, ValidationError } from '../../core/index.js';

/**
 * The five AI permission switches of one space (BO-F0-06, backoffice
 * "08 Spazi e accessi").
 *
 * A switch answers one question: may the agent perform this class of action
 * on its own in this space? When the switch is off, the action is never
 * executed — it becomes a proposal a human approves, and the approval itself
 * is the only path forward.
 *
 * The space is an opaque id owned by the control plane. This package stores
 * no spaces, no members and no invitations: it stores per-space switch
 * overrides and the proposals a switched-off action produced, both keyed by
 * that opaque id. A space the control plane never issued simply has no rows.
 */

/** The five AI permission keys, frozen. One more is a product decision. */
export const SPACE_AI_PERMISSIONS = Object.freeze([
  'merge-duplicates',
  'drafts',
  'send-without-approval',
  'book-appointments',
  'move-offers',
]);

/**
 * The effective value when a space stored no override.
 *
 * Only `send-without-approval` is off by default: an unattended send is the
 * one action the roadmap calls out as opt-in, so a fresh space sends nothing
 * until its owner flips the switch. Everything else defaults to on — each
 * still degrades to a human-approved proposal the moment it is switched off.
 */
export const SPACE_AI_PERMISSION_DEFAULTS = Object.freeze({
  'merge-duplicates': true,
  drafts: true,
  'send-without-approval': false,
  'book-appointments': true,
  'move-offers': true,
});

const MAX_SPACE_ID = 128;

/**
 * Validate an opaque space id issued by the control plane. The shape is
 * checked, the existence is not: only the control plane knows its spaces.
 *
 * @param {unknown} value
 * @returns {string} the trimmed id
 */
export function checkSpaceId(value) {
  if (typeof value !== 'string') {
    throw new ValidationError('spaceId must be a string issued by the control plane', { field: 'spaceId' });
  }
  const id = value.trim();
  // eslint-disable-next-line no-control-regex
  if (id === '' || id.length > MAX_SPACE_ID || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new ValidationError('spaceId must be a non-empty id of at most 128 characters', { field: 'spaceId' });
  }
  return id;
}

/**
 * Validate one of the five permission keys. Exact match only: anything else
 * — including `__proto__`, `constructor` or a longer dotted path — is a
 * typed refusal, never a default.
 *
 * @param {unknown} value
 * @returns {string} the key
 */
export function checkPermissionKey(value) {
  if (typeof value === 'string' && SPACE_AI_PERMISSIONS.includes(value)) {
    return value;
  }
  throw new AppError(`Unknown space AI permission "${String(value)}"`, {
    code: 'SPACE_PERMISSION_UNKNOWN', status: 400,
  });
}

/**
 * Read the stored override for one switch of one space. `overrideRows` are
 * stored `space-permission-override` rows; only rows carrying this space's id
 * are honored — a row of another space is ignored even when a caller passes
 * it in by mistake, which is what keeps one space's switches invisible from
 * the others.
 *
 * @param {string} spaceId the opaque space id
 * @param {string} permission one of the five keys
 * @param {Array<{spaceId?: unknown, permission?: unknown, enabled?: unknown}>} [overrideRows]
 * @returns {boolean} the effective value
 */
export function effectivePermission(spaceId, permission, overrideRows = []) {
  const key = checkPermissionKey(permission);
  for (const row of overrideRows) {
    if (row && typeof row === 'object' && row.spaceId === spaceId && row.permission === key) {
      return row.enabled === true;
    }
  }
  return SPACE_AI_PERMISSION_DEFAULTS[key] === true;
}

/**
 * Resolve all five effective values for one space.
 *
 * @param {unknown} spaceId the opaque space id
 * @param {Array<{spaceId?: unknown, permission?: unknown, enabled?: unknown}>} [overrideRows]
 * @returns {Record<string, boolean>} frozen key → effective value
 */
export function resolveSpacePermissions(spaceId, overrideRows = []) {
  const id = checkSpaceId(spaceId);
  const rows = Array.isArray(overrideRows) ? overrideRows : [];
  const resolved = {};
  for (const key of SPACE_AI_PERMISSIONS) {
    resolved[key] = effectivePermission(id, key, rows);
  }
  return Object.freeze(resolved);
}

/**
 * Gate one AI action: allow it, or turn it into a proposal.
 *
 * This is the whole BO-F0-06 promise in one function: a switched-off action
 * is never executed by this path. The caller that receives `proposal` records
 * the proposal and stops; there is no third outcome.
 *
 * @param {{spaceId: unknown, permission: unknown, overrideRows?: Array<{spaceId?: unknown, permission?: unknown, enabled?: unknown}>}} input
 * @returns {{decision: 'allow' | 'proposal', spaceId: string, permission: string, enabled: boolean}} frozen
 */
export function evaluateAiPermission(input) {
  const record = input && typeof input === 'object' ? input : {};
  const spaceId = checkSpaceId(record.spaceId);
  const permission = checkPermissionKey(record.permission);
  const enabled = effectivePermission(spaceId, permission, record.overrideRows);
  return Object.freeze({
    decision: enabled ? 'allow' : 'proposal',
    spaceId,
    permission,
    enabled,
  });
}
