// @ts-check

import { ANONYMOUS_ACTOR } from '../../core/index.js';

/**
 * **Team read state: the one rule for "unread".**
 *
 * The watermark table (`conversation-read`, owned by this package) is the
 * only read memory: one row per conversation and member names the instant
 * up to which that member has seen the thread. Everything derived — an
 * inbound message's `read` flag on the scheda timeline, a customer row's
 * `unreadCount` on the list, the `da-leggere` view — asks this one function,
 * so the scheda badge and the list badge can never disagree about the same
 * message. The rule:
 *
 * - only inbound messages can be unread (the team does not unread its own
 *   words; an outbound delivery confirmation is a channel fact, never a
 *   team watermark);
 * - without a watermark every inbound message is unread;
 * - with one, an inbound message later than the watermark is unread.
 *
 * Instants compare lexically, like the watermarked reads beside it: stored
 * watermarks and stored message instants are both ISO-8601 UTC, so lexical
 * order is chronological order. A message with no readable instant counts
 * as unread only when nothing was ever marked — a mark always names an
 * instant it can reach, so a dateless row can never light up forever.
 *
 * Generic: nothing here knows about any other package, table or route. The
 * member id vocabulary is this package's (`validateMemberId`); here an
 * actor id that does not fit it simply names no member, and reads without
 * a member omit read state instead of inventing it.
 * @param {{direction?: unknown, occurredAt?: unknown}} message
 * @param {unknown} watermark the member's `lastReadAt` on the message's conversation, if any
 */
export function isInboundUnread(message, watermark) {
  if (message?.direction !== 'inbound') return false;
  if (watermark === undefined || watermark === null || watermark === '') return true;
  const at = typeof message?.occurredAt === 'string' ? message.occurredAt : '';
  if (at === '') return false;
  return at > String(watermark);
}

/**
 * Count one subject's unread inbound messages from rows already in hand,
 * against one member's watermarks. Pure: the caller did the batched reads
 * (the list already holds every message), so this never touches storage.
 * The rule is `isInboundUnread` above, the same one the scheda's `read`
 * flags answer — a row's `unreadCount` is exactly the number of its entries
 * the scheda would badge.
 *
 * Only message rows count: a call row never does, even when it names a
 * direction. A message outside any conversation has no watermark to move —
 * no mark can ever clear it, so it never counts, or it would light up
 * forever. Null watermarks (unreadable table) mean no read state at all:
 * the caller omits the counts instead of inventing them.
 * @param {Array<any>} messages the subject's message rows
 * @param {Map<string, unknown>|null|undefined} watermarks conversation id to `lastReadAt`, or null when unreadable
 */
export function countUnreadForSubject(messages, watermarks) {
  if (watermarks === null || watermarks === undefined) return null;
  let unread = 0;
  let lastUnreadAt = null;
  for (const row of messages ?? []) {
    if (row?.entry === 'call' || row?.direction !== 'inbound') continue;
    if (row?.conversationId === undefined || row?.conversationId === null || row?.conversationId === '') continue;
    const watermark = watermarks.get(String(row.conversationId)) ?? null;
    if (!isInboundUnread(row, watermark)) continue;
    unread += 1;
    const at = typeof row?.occurredAt === 'string' ? row.occurredAt : '';
    if (at !== '' && (lastUnreadAt === null || at > lastUnreadAt)) lastUnreadAt = at;
  }
  return Object.freeze({ unread, lastUnreadAt });
}

/**
 * The team member behind an actor, if the actor id fits the member
 * vocabulary. Only a human user names a member: an agent, system or missing
 * actor type never does, so a non-user actor with a colliding id cannot read
 * another member's watermarks. The writer of a mark is always the actor — a
 * request body never names a member, so nobody marks another member read —
 * and an actor whose id does not fit simply gets no read state: reads omit
 * the unread fields instead of refusing the whole page over an identity
 * shape.
 * @param {unknown} actor
 */
export function actorMemberId(actor) {
  if (actor?.type !== 'user') return null;
  const id = typeof actor?.id === 'string' ? actor.id : '';
  if (id === '' || id.length > 64) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/.test(id)) return null;
  // The same three names the interactions member vocabulary refuses: as a
  // Map key they are harmless, but a watermark read under one would silently
  // match nothing and light every row up — no member, no read state.
  if (id === '__proto__' || id === 'constructor' || id === 'prototype') return null;
  // The anonymous actor fits the vocabulary but names nobody: without this
  // branch an unauthenticated read would answer read state for a phantom
  // member instead of omitting it. A member literally called `anonymous`
  // gets no read state either — documented, and the safer direction.
  if (id === ANONYMOUS_ACTOR.id) return null;
  return id;
}
