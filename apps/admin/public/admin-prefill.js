// @ts-check

/**
 * One-time customer handoff between /bo screens (voce 714433c2).
 *
 * The scheda cliente's «Nuova offerta» and «Nuovo appuntamento» start the
 * creation flows with the customer already chosen. The Admin router carries
 * path-only hashes (no query tail), and the target screens own separate
 * state, so the card stashes the pick here and the target takes it once:
 * `takePendingCustomerPick` reads and clears, so a later visit starts
 * unpicked again. The pick is `{ resource, id, name }` — the same shape the
 * calendar manual form already holds — and only names a record; every
 * creation still validates server-side, so a stale pick refuses there,
 * never books the wrong customer. Without a storage the write is a noop
 * and the take is null: the creation screen opens unpicked, never broken.
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
 * @param {unknown} pick
 * @returns {{resource: string, id: string, name: string} | null}
 */
function validPick(pick) {
  if (pick === null || typeof pick !== 'object') return null;
  const { resource, id, name } = /** @type {{resource: unknown, id: unknown, name: unknown}} */ (pick);
  if (!VALID_RESOURCES.has(/** @type {string} */ (resource))) return null;
  if (typeof id !== 'string' || id === '') return null;
  if (typeof name !== 'string' || name.trim() === '') return null;
  return { resource: /** @type {string} */ (resource), id, name: name.trim() };
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
