// @ts-check

import { checkSpaceId } from './permissions.js';

/**
 * Space invitation review (BO-F0-06, "Invita persona").
 *
 * The control plane owns spaces, members and invitations; this package owns
 * the shape of a valid assignment. `reviewSpaceInvite` answers whether one
 * invitation assigns a known role and a known, non-empty set of response
 * channels — or refuses it with named reasons. Refusal is data, never an
 * error: the backoffice shows the reasons next to the form.
 *
 * Roles mirror the control plane's membership CHECK
 * (`accordo-platform/src/records/schema.sql`): `owner`, `operator`,
 * `observer`. The control plane is the authority; this list is a mirror, and
 * a role the control plane does not know is refused here first.
 */

/** Space roles, mirrored from the control plane — it owns them. */
export const SPACE_ROLES = Object.freeze(['owner', 'operator', 'observer']);

/**
 * Response channels one invited member may reply on.
 *
 * The names are the framework's own `CHANNELS`
 * (`packages/channels/src/adapter.js`) minus the entry-only ones: TikTok and
 * the site form take messages in but never carry a reply, so an invitation
 * naming them is refused. This list states that rule; it does not fork the
 * vocabulary.
 */
export const RESPONSE_CHANNELS = Object.freeze([
  'whatsapp',
  'instagram',
  'facebook',
  'sms',
  'email',
  'voice',
]);

const MAX_CHANNELS = 8;

/**
 * Review one space invitation without storing anything.
 *
 * @param {{spaceId: unknown, role: unknown, responseChannels: unknown}} input
 * @returns {{ok: boolean, errors: string[], invite: null | {spaceId: string, role: string, responseChannels: string[]}}} frozen
 */
export function reviewSpaceInvite(input) {
  const record = input && typeof input === 'object' ? input : {};
  /** @type {string[]} */
  const errors = [];
  let spaceId = null;
  try {
    spaceId = checkSpaceId(record.spaceId);
  } catch {
    errors.push('spaceId: a space issued by the control plane is required');
  }
  const role = typeof record.role === 'string' ? record.role : '';
  if (!SPACE_ROLES.includes(role)) {
    errors.push(`role: must be one of ${SPACE_ROLES.join(', ')}`);
  }
  const channels = Array.isArray(record.responseChannels) ? record.responseChannels : null;
  /** @type {string[]} */
  const accepted = [];
  if (!channels || channels.length === 0) {
    errors.push('responseChannels: at least one reply channel is required');
  } else if (channels.length > MAX_CHANNELS) {
    errors.push(`responseChannels: at most ${MAX_CHANNELS} channels`);
  } else {
    const seen = new Set();
    for (const channel of channels) {
      if (typeof channel !== 'string' || !RESPONSE_CHANNELS.includes(channel)) {
        errors.push(`responseChannels: "${String(channel)}" is not a reply channel`);
      } else if (seen.has(channel)) {
        errors.push(`responseChannels: "${channel}" is listed twice`);
      } else {
        seen.add(channel);
        accepted.push(channel);
      }
    }
  }
  if (errors.length > 0) {
    return Object.freeze({ ok: false, errors: Object.freeze([...errors]), invite: null });
  }
  return Object.freeze({
    ok: true,
    errors: Object.freeze([]),
    invite: Object.freeze({
      spaceId,
      role,
      responseChannels: Object.freeze([...accepted]),
    }),
  });
}
