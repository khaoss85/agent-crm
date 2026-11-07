// @ts-check

/**
 * Unsaved text survives a lost session (backlog:5a40c73e54aa, B4 of
 * VALIDAZIONE-PRODOTTO.md).
 *
 * When an API answer says the session is gone, the shell leaves for the space
 * login and the page is thrown away: a long note typed into the scheda used to
 * vanish with it. Before leaving, the shell copies the text the operator typed
 * into the open view — named, visible text fields only — into this tab's
 * sessionStorage, keyed by the hash route and bound to the active space. After
 * the login brings the operator back to the same route in the same space, the
 * fields are filled again (only where still empty) and the shell says so, so
 * the operator saves again. A copy from another space never fills a field nor
 * moves the operator (review #634): sessionStorage outlives a space change in
 * the same tab, and one space's text must never be saved into another's.
 *
 * Bounds: at most MAX_FIELDS fields of at most MAX_CHARS characters, never a
 * password, hidden, file or checkbox input, and the copy expires after
 * MAX_AGE_MS. It lives in sessionStorage — this tab only, gone when the tab
 * closes — and every storage call is guarded: no storage means no keeping,
 * never a crash.
 */

export const DRAFT_KEEP_KEY = 'bo-unsaved-drafts';
const MAX_FIELDS = 20;
const MAX_CHARS = 5000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const TEXT_TYPES = new Set(['', 'text', 'email', 'tel', 'search', 'url']);
const NAME_SHAPE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** @param {any} node */
function* walk(node) {
  for (const child of Array.from(node?.childNodes ?? [])) {
    yield child;
    yield* walk(child);
  }
}

/** @param {any} node */
function textField(node) {
  const tag = String(node?.tagName ?? node?.nodeName ?? '').toLowerCase();
  if (tag !== 'input' && tag !== 'textarea') return null;
  if (typeof node.getAttribute !== 'function') return null;
  const name = node.getAttribute('name');
  if (typeof name !== 'string' || !NAME_SHAPE.test(name)) return null;
  if (tag === 'input' && !TEXT_TYPES.has(String(node.getAttribute('type') ?? '').toLowerCase())) return null;
  return { name, node };
}

/** @param {unknown} value */
function spaceKey(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Read the kept copy: null when there is none, it is malformed or stale.
 * @param {any} storage
 * @param {number} now
 */
function readKept(storage, now) {
  const raw = storage.getItem(DRAFT_KEEP_KEY);
  if (typeof raw !== 'string' || raw === '') return { saved: null, stale: false };
  const saved = JSON.parse(raw);
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.fields)
    || typeof saved.at !== 'number' || now - saved.at > MAX_AGE_MS || now < saved.at) {
    return { saved: null, stale: true };
  }
  return { saved, stale: false };
}

/**
 * Copy the typed text of the open view before the page is thrown away.
 * Without an active space nothing is kept: a copy must name its space.
 * @param {{root: any, hash: string, space: unknown, storage: any, now?: number}} input
 * @returns {number} how many fields were kept
 */
export function captureDrafts({ root, hash, space, storage, now = Date.now() }) {
  const owner = spaceKey(space);
  if (!root || !storage || typeof hash !== 'string' || hash === '' || owner === null) return 0;
  /** @type {Array<{name: string, value: string}>} */
  const fields = [];
  for (const node of walk(root)) {
    const field = textField(node);
    if (!field) continue;
    const value = typeof field.node.value === 'string' ? field.node.value : '';
    if (value.trim() === '' || fields.some((entry) => entry.name === field.name)) continue;
    fields.push({ name: field.name, value: value.slice(0, MAX_CHARS) });
    if (fields.length >= MAX_FIELDS) break;
  }
  if (fields.length === 0) return 0;
  try {
    storage.setItem(DRAFT_KEEP_KEY, JSON.stringify({ hash, space: owner, at: now, fields }));
  } catch {
    return 0;
  }
  return fields.length;
}

/**
 * Fill the kept text back into the view the login returned to. A field the
 * operator already typed into is never overwritten. The copy is dropped once
 * it filled something, or when it is stale; a copy for another route or
 * another space waits (until it expires) and fills nothing.
 * @param {{root: any, hash: string, space: unknown, storage: any, now?: number}} input
 * @returns {number} how many fields were filled
 */
export function restoreDrafts({ root, hash, space, storage, now = Date.now() }) {
  if (!root || !storage || typeof hash !== 'string') return 0;
  const drop = () => {
    try { storage.removeItem(DRAFT_KEEP_KEY); } catch { /* nothing to drop */ }
  };
  let kept;
  try {
    kept = readKept(storage, now);
  } catch {
    return 0;
  }
  if (kept.stale) drop();
  const saved = kept.saved;
  if (!saved) return 0;
  const owner = spaceKey(space);
  if (owner === null || saved.space !== owner) return 0;
  if (saved.hash !== hash) return 0;
  const byName = new Map();
  for (const node of walk(root)) {
    const field = textField(node);
    if (field && !byName.has(field.name)) byName.set(field.name, field.node);
  }
  let filled = 0;
  for (const entry of saved.fields.slice(0, MAX_FIELDS)) {
    if (!entry || typeof entry.name !== 'string' || typeof entry.value !== 'string') continue;
    const node = byName.get(entry.name);
    if (!node || (typeof node.value === 'string' && node.value !== '')) continue;
    node.value = entry.value.slice(0, MAX_CHARS);
    filled += 1;
  }
  // Used once it was offered back: a later visit to the same route starts
  // clean. A render that offered no empty field (a closed form, a field
  // already filled) consumes nothing — the copy stays until it expires, so
  // a later complete render can still restore it (review #634).
  if (filled > 0) drop();
  return filled;
}

/**
 * The route a fresh kept draft of this space belongs to, or null. The login
 * may land the operator on the shell's home (`#/` or no hash) instead of the
 * scheda they were on; the shell then goes back to that route once, so the
 * draft can be filled in where it was typed. Once: the copy is marked, so a
 * copy that outlives the return (nothing to fill yet) never bounces the
 * operator off the home again. A copy of another space never redirects.
 * @param {{storage: any, space: unknown, now?: number}} input
 * @returns {string | null}
 */
export function pendingDraftRoute({ storage, space, now = Date.now() }) {
  if (!storage) return null;
  const owner = spaceKey(space);
  if (owner === null) return null;
  try {
    const { saved } = readKept(storage, now);
    if (!saved || typeof saved.hash !== 'string' || !saved.hash.startsWith('#/')) return null;
    if (saved.space !== owner || saved.returned === true) return null;
    storage.setItem(DRAFT_KEEP_KEY, JSON.stringify({ ...saved, returned: true }));
    return saved.hash;
  } catch {
    return null;
  }
}
