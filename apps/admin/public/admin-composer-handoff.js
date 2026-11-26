// @ts-check

/**
 * backlog:ab7c38cbcca5 — the offer message handed from the offer page to the
 * customer's scheda composer.
 *
 * The offer page prepares the ready Italian message with the acceptance
 * link; «Scrivi a <cliente>» leaves it here and opens the customer's scheda,
 * which takes it once and opens its composer with the message already in
 * the text. A message belongs to one customer in one space: it is keyed by
 * the active space read at both ends, so a space switch in between, another
 * customer's scheda or a later visit never receive it. One-shot (taken means
 * gone), short-lived, in memory for this tab only — never storage, never the
 * address.
 *
 * @param {{ space: () => string | null, now?: () => number, ttlMs?: number }} options
 */
export function createComposerHandoff({ space, now = () => Date.now(), ttlMs = 10 * 60 * 1000 }) {
  /** @type {null | { key: string, text: string, subject: string, at: number }} */
  let held = null;
  /** @param {unknown} resource @param {unknown} id */
  const keyOf = (resource, id) => {
    if (typeof resource !== 'string' || !/^[a-z][a-z0-9-]*$/.test(resource)) return null;
    if (typeof id !== 'string' || id === '') return null;
    return `${space() ?? ''}\u0000${resource}\u0000${id}`;
  };
  return {
    /**
     * The offer page leaves the message for this customer, replacing any
     * earlier one: only the last prepared message is ever handed over.
     * The subject is used by an email composer whose own subject is empty.
     * @param {unknown} resource @param {unknown} id @param {unknown} text @param {unknown} [subject]
     * @returns {boolean} whether the message was kept
     */
    stage(resource, id, text, subject = '') {
      const key = keyOf(resource, id);
      const body = typeof text === 'string' ? text.trim() : '';
      if (key === null || body === '') return false;
      held = { key, text: body, subject: typeof subject === 'string' ? subject.trim() : '', at: now() };
      return true;
    },
    /**
     * The scheda takes the message meant for the customer it shows, in the
     * active space, once. Null when there is none, when it is for someone
     * else (left in place for them) or when it is too old (dropped).
     * @param {unknown} resource @param {unknown} id
     * @returns {{ text: string, subject: string } | null}
     */
    take(resource, id) {
      if (held === null) return null;
      if (now() - held.at > ttlMs) {
        held = null;
        return null;
      }
      const key = keyOf(resource, id);
      if (key === null || key !== held.key) return null;
      const { text, subject } = held;
      held = null;
      return { text, subject };
    },
  };
}

/**
 * The composer text after a handed-over message lands: the message alone on
 * an empty draft, the draft untouched when it already carries the message,
 * otherwise the draft first and the message after a blank line — typed text
 * is never lost.
 * @param {unknown} draft @param {string} message
 * @returns {string}
 */
export function mergeHandoffIntoDraft(draft, message) {
  const typed = typeof draft === 'string' ? draft : '';
  if (typed.trim() === '') return message;
  if (typed.includes(message)) return typed;
  return `${typed.replace(/\s+$/, '')}\n\n${message}`;
}
