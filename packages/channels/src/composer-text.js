// @ts-check

/**
 * The composer text fence (backlog:e9b4fc2f): every composer send carries a
 * host timeline row, and the row only stores what `safeMessageBody` stores —
 * at most 2000 characters, line feeds kept, every other control refused
 * (the interactions package owns that fence; a domain package reaches
 * another only through a declared capability, never a file import, so this
 * module mirrors it as the single source of truth every composer path
 * shares: the route fails fast here, the queue defends in depth here, and
 * the table test pins every case both review rounds named).
 *
 * Zero dependencies on purpose: the HTTP kernel and the operations both
 * import this file directly, so a heavier import would drag the queue
 * machinery (or the capability wiring) into the route.
 */

/** The most characters a stored composer text may hold after normalization. */
export const COMPOSER_TIMELINE_BODY_MAX = 2000;

/** Any control the timeline row refuses, the line feed aside. */
const COMPOSER_TEXT_CONTROL_RE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Why a composer text cannot be stored as its timeline row, or null when it
 * can. Pure: the same input refuses the same way at the route and at the
 * queue, so a 422 at either layer names the same composer limit — never a
 * route pass followed by a queue refusal of the identical text.
 *
 * @param {unknown} text the raw composer text
 * @returns {string|null} the refusal reason, or null when timeline-storable
 */
export function composerTimelineRefusal(text) {
  if (typeof text !== 'string') return 'message text must be a string';
  const normalized = text.replace(/\r\n/g, '\n').trim();
  if (normalized === '') return 'message text is blank: the timeline row stores no blank text';
  if (normalized.length > COMPOSER_TIMELINE_BODY_MAX) {
    return `message text is ${normalized.length} characters: the composer timeline row holds at most ${COMPOSER_TIMELINE_BODY_MAX}`;
  }
  if (COMPOSER_TEXT_CONTROL_RE.test(normalized.replace(/\n/g, ''))) {
    return 'message text carries a control character the timeline row refuses (line breaks excepted)';
  }
  return null;
}
