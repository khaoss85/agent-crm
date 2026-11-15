// @ts-check

/**
 * One-time customer handoff between /bo screens (voce 714433c2).
 *
 * The scheda cliente's «Nuova offerta» and «Nuovo appuntamento» start the
 * creation flows with the customer already chosen. The Admin router carries
 * path-only hashes (no query tail), and the target screens own separate
 * state, so the card stashes the pick here and the target takes it once:
 * `takePendingCustomerPick` reads and clears, so a later visit starts
 * unpicked again. The pick is `{ resource, id, name, company }` — the same
 * shape the calendar manual form already holds, plus the linked company the
 * offer form files under (null when the scheda knows none) — and only names
 * records; every creation still validates server-side, so a stale pick
 * refuses there, never books the wrong customer. Without a storage the
 * write is a noop and the take is null: the creation screen opens unpicked,
 * never broken.
 */

const KEY_PREFIX = 'accordo.bo.customer-pick.';

const VALID_RESOURCES = new Set(['contact', 'company']);

/** @param {unknown} screen */
function keyFor(screen) {
  if (typeof screen !== 'string' || !/^[a-z][a-z0-9-]{0,40}$/.test(screen)) return null;
  return `${KEY_PREFIX}${screen}`;
}

/** @param {any} storage */
function storageApi(storage) {
  if (
    storage === null || storage === undefined
    || typeof storage.getItem !== 'function'
    || typeof storage.setItem !== 'function'
    || typeof storage.removeItem !== 'function'
  ) return null;
  return storage;
}

/**
 * The company linked to the picked record, when the scheda knows one. The
 * offer form needs it — an opportunity is always filed under a company —
 * while the appointment form ignores it. Auxiliary, never identity: a broken
 * company degrades to null instead of refusing the record.
 * @param {unknown} company
 * @returns {{id: string, name: string} | null}
 */
function validCompany(company) {
  if (company === null || company === undefined) return null;
  if (typeof company !== 'object') return null;
  const { id, name } = /** @type {{id: unknown, name: unknown}} */ (company);
  if (typeof id !== 'string' || id === '') return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  return { id, name: name.trim() };
}

/**
 * @param {unknown} pick
 * @returns {{resource: string, id: string, name: string, company: {id: string, name: string} | null} | null}
 */
function validPick(pick) {
  if (pick === null || typeof pick !== 'object') return null;
  const { resource, id, name } = /** @type {{resource: unknown, id: unknown, name: unknown}} */ (pick);
  if (!VALID_RESOURCES.has(/** @type {string} */ (resource))) return null;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  const company = validCompany(/** @type {{company?: unknown}} */ (pick).company);
  return { resource: /** @type {string} */ (resource), id, name: name.trim(), company };
}

/**
 * Stash the customer the next creation screen should start with.
 * @param {any} storage
 * @param {unknown} screen
 * @param {unknown} pick
 * @returns {boolean} true when the pick was stored.
 */
export function writePendingCustomerPick(storage, screen, pick) {
  const api = storageApi(storage);
  const key = keyFor(screen);
  const clean = validPick(pick);
  if (api === null || key === null || clean === null) return false;
  api.setItem(key, JSON.stringify(clean));
  return true;
}

/**
 * Take the stashed customer once (read + clear).
 * @param {any} storage
 * @param {unknown} screen
 * @returns {{resource: string, id: string, name: string} | null}
 */
export function takePendingCustomerPick(storage, screen) {
  const api = storageApi(storage);
  const key = keyFor(screen);
  if (api === null || key === null) return null;
  let raw = null;
  try {
    raw = api.getItem(key);
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    api.removeItem(key);
  } catch {
    // The pick was read; a clear failure only risks a repeat, never a loss.
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return validPick(parsed);
}

const EVENT_KEY = 'accordo.bo.calendar-event';

/**
 * @param {unknown} pick
 * @returns {{id: string, day: string, member?: string} | null}
 */
function validEvent(pick) {
  if (pick === null || typeof pick !== 'object') return null;
  const { id, day, member } = /** @type {{id: unknown, day: unknown, member?: unknown}} */ (pick);
  if (typeof id !== 'string' || id === '' || id.length > 200) return null;
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  if (typeof member === 'string' && member !== '' && member.length <= 200) return { id, day, member };
  return { id, day };
}

/**
 * Stash the calendar event the Calendario opens on entry (backlog:bd5e84545021:
 * Oggi's «Fonti: Appuntamento delle …» opened the technical record page).
 * Same one-time handoff as the customer pick: the calendar takes it once,
 * shows the week of `day` (Rome calendar day, YYYY-MM-DD) and selects the
 * event `id` there; `member`, when given, is the team member holding it,
 * loaded and shown whatever the calendar's filters say. A stale id simply
 * selects nothing.
 * @param {any} storage
 * @param {unknown} pick `{ id, day }`
 * @returns {boolean} true when the event was stored.
 */
export function writePendingCalendarEvent(storage, pick) {
  const api = storageApi(storage);
  const clean = validEvent(pick);
  if (api === null || clean === null) return false;
  try {
    api.setItem(EVENT_KEY, JSON.stringify(clean));
  } catch {
    return false;
  }
  return true;
}

/**
 * Take the stashed calendar event once (read + clear).
 * @param {any} storage
 * @returns {{id: string, day: string, member?: string} | null}
 */
export function takePendingCalendarEvent(storage) {
  const api = storageApi(storage);
  if (api === null) return null;
  let raw = null;
  try {
    raw = api.getItem(EVENT_KEY);
    if (typeof raw === 'string' && raw !== '') api.removeItem(EVENT_KEY);
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return validEvent(JSON.parse(raw));
  } catch {
    return null;
  }
}

const CLIENTI_VIEW_KEY = 'accordo.bo.clienti-view';

/**
 * Stash the Clienti view the list opens on (backlog:c2bf6b206d96: Oggi's
 * «Vedi tutte» lands on Clienti › Da rispondere). Same one-time handoff as
 * the picks above: the list takes it once; a view the server does not know
 * refuses there with its own message.
 * @param {any} storage
 * @param {unknown} view a view id (`da-rispondere`)
 * @returns {boolean} true when the view was stored.
 */
export function writePendingClientiView(storage, view) {
  const api = storageApi(storage);
  if (api === null || typeof view !== 'string' || !/^[a-z0-9-]{1,40}$/.test(view)) return false;
  try {
    api.setItem(CLIENTI_VIEW_KEY, view);
  } catch {
    return false;
  }
  return true;
}

/**
 * Take the stashed Clienti view once (read + clear), null without one.
 * @param {any} storage
 * @returns {string | null}
 */
export function takePendingClientiView(storage) {
  const api = storageApi(storage);
  if (api === null) return null;
  try {
    const raw = api.getItem(CLIENTI_VIEW_KEY);
    if (typeof raw !== 'string' || raw === '') return null;
    api.removeItem(CLIENTI_VIEW_KEY);
    return /^[a-z0-9-]{1,40}$/.test(raw) ? raw : null;
  } catch {
    return null;
  }
}
