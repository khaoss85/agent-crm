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
 * The master AI switch of one space (backlog:2c3156a47f8e, backoffice
 * "08 Spazi e accessi"). One key, stored as an override row like the five
 * switches above, but deliberately NOT one of them: the five answer "may
 * the agent do this on its own", the master answers "is the AI on in this
 * space at all". A fresh space runs with the AI on; the owner switches the
 * whole space off (and back on) from the /bo without touching the five.
 */
export const SPACE_AI_MASTER_KEY = 'ai-enabled';

/** The master default: a space with no master row runs with the AI on. */
export const SPACE_AI_MASTER_DEFAULT = true;

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
 * Validate a flippable switch key: one of the five permissions, or the
 * master `ai-enabled` switch. Only the `set-permission` write path accepts
 * the master; reads and gates keep the five-only key and consult the master
 * separately through `isAiEnabled`, so no five-keyed surface silently
 * changes shape.
 *
 * @param {unknown} value
 * @returns {string} the key
 */
export function checkFlippableKey(value) {
  if (typeof value === 'string' && (value === SPACE_AI_MASTER_KEY || SPACE_AI_PERMISSIONS.includes(value))) {
    return value;
  }
  throw new AppError(`Unknown space AI permission "${String(value)}"`, {
    code: 'SPACE_PERMISSION_UNKNOWN', status: 400,
  });
}

/**
 * The master AI state of one space. A stored master row wins; a space with
 * no master row runs with the AI on. Rows of another space never leak in —
 * only rows carrying this space's id are honored.
 *
 * @param {string} spaceId the opaque space id
 * @param {Array<{spaceId?: unknown, permission?: unknown, enabled?: unknown}>} [overrideRows]
 * @returns {boolean} the master state
 */
export function isAiEnabled(spaceId, overrideRows = []) {
  const id = checkSpaceId(spaceId);
  const rows = Array.isArray(overrideRows) ? overrideRows : [];
  const master = rows.find((row) => row && typeof row === 'object' && row.spaceId === id && row.permission === SPACE_AI_MASTER_KEY);
  if (!master) return SPACE_AI_MASTER_DEFAULT === true;
  return master.enabled === true;
}

/**
 * Whether one AI action may run alone in one space: the master on AND the
 * specific switch on. Either off turns the action into a proposal.
 *
 * @param {unknown} spaceId the opaque space id
 * @param {unknown} permission one of the five keys
 * @param {Array<{spaceId?: unknown, permission?: unknown, enabled?: unknown}>} [overrideRows]
 * @returns {boolean} true only when both the master and the switch are on
 */
export function isAiActionAllowed(spaceId, permission, overrideRows = []) {
  // Muse #734 P2: trim once, so the master and the switch read the same id.
  const id = checkSpaceId(spaceId);
  const rows = Array.isArray(overrideRows) ? overrideRows : [];
  if (!isAiEnabled(id, rows)) return false;
  return effectivePermission(id, permission, rows);
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
 * the proposal and stops; there is no third outcome. The space master switch
 * (`ai-enabled`, backlog:2c3156a47f8e) gates everything: with the master off
 * every action becomes a proposal no matter what its own switch says, while
 * `enabled` keeps reporting that switch's own honest value.
 *
 * @param {{spaceId: unknown, permission: unknown, overrideRows?: Array<{spaceId?: unknown, permission?: unknown, enabled?: unknown}>}} input
 * @returns {{decision: 'allow' | 'proposal', spaceId: string, permission: string, enabled: boolean}} frozen
 */
export function evaluateAiPermission(input) {
  const record = input && typeof input === 'object' ? input : {};
  const spaceId = checkSpaceId(record.spaceId);
  const permission = checkPermissionKey(record.permission);
  const rows = Array.isArray(record.overrideRows) ? record.overrideRows : [];
  const enabled = effectivePermission(spaceId, permission, rows);
  const allowed = isAiActionAllowed(spaceId, permission, rows);
  return Object.freeze({
    decision: allowed ? 'allow' : 'proposal',
    spaceId,
    permission,
    enabled,
  });
}
