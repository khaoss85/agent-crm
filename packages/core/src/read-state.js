// @ts-check

/**
 * **Team read state: the one rule for "unread".**
 *
 * The watermark table (`conversation-read` in the interactions package) is
 * the only read memory: one row per conversation and member names the
 * instant up to which that member has seen the thread. Everything derived —
 * an inbound message's `read` flag on the timeline, a customer row's
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
 * Generic: nothing here knows about any package, table or route. The member
 * id vocabulary is the interactions package's (`validateMemberId` there);
 * here an actor id that does not fit it simply names no member, and reads
 * without a member omit read state instead of inventing it.
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
 * The team member behind an actor, if the actor id fits the member
 * vocabulary. The writer of a mark is always the actor — a request body
 * never names a member, so nobody marks another member read — and an actor
 * whose id does not fit simply gets no read state: reads omit the unread
 * fields instead of refusing the whole page over an identity shape.
 * @param {unknown} actor
 */
export function actorMemberId(actor) {
  const id = typeof actor?.id === 'string' ? actor.id : '';
  if (id === '' || id.length > 64) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._@/-]*$/.test(id)) return null;
  return id;
}
