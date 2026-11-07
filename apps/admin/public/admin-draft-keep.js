// @ts-check

/**
 * Unsaved text survives a lost session (backlog:5a40c73e54aa, B4 of
 * VALIDAZIONE-PRODOTTO.md).
 *
 * When an API answer says the session is gone, the shell leaves for the space
 * login and the page is thrown away: a long note typed into the scheda used to
 * vanish with it. Before leaving, the shell copies the text the operator typed
 * into the open view — named, visible text fields only — into this tab's
 * sessionStorage, keyed by the hash route. After the login brings the operator
 * back to the same route, the fields are filled again (only where still empty)
 * and the shell says so, so the operator saves again.
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

/**
 * Copy the typed text of the open view before the page is thrown away.
 * @param {{root: any, hash: string, storage: any, now?: number}} input
 * @returns {number} how many fields were kept
 */
export function captureDrafts({ root, hash, storage, now = Date.now() }) {
  if (!root || !storage || typeof hash !== 'string' || hash === '') return 0;
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
    storage.setItem(DRAFT_KEEP_KEY, JSON.stringify({ hash, at: now, fields }));
  } catch {
    return 0;
  }
  return fields.length;
}

/**
 * Fill the kept text back into the view the login returned to. A field the
 * operator already typed into is never overwritten. The copy is dropped once
 * used, or when it is stale; a copy for another route waits for that route.
 * @param {{root: any, hash: string, storage: any, now?: number}} input
 * @returns {number} how many fields were filled
 */
export function restoreDrafts({ root, hash, storage, now = Date.now() }) {
  if (!root || !storage || typeof hash !== 'string') return 0;
  let saved;
  try {
    const raw = storage.getItem(DRAFT_KEEP_KEY);
    if (typeof raw !== 'string' || raw === '') return 0;
    saved = JSON.parse(raw);
  } catch {
    return 0;
  }
  const drop = () => {
    try { storage.removeItem(DRAFT_KEEP_KEY); } catch { /* nothing to drop */ }
  };
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.fields)
    || typeof saved.at !== 'number' || now - saved.at > MAX_AGE_MS || now < saved.at) {
    drop();
    return 0;
  }
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
  // Used once: a later visit to the same route starts clean. A route that
  // did not show the field (a closed form) keeps nothing either — the copy
  // was for this one return.
  drop();
  return filled;
}

/**
 * The route a fresh kept draft belongs to, or null. The login may land the
 * operator on the shell's home (`#/` or no hash) instead of the scheda they
 * were on; the shell then goes back to that route once, so the draft can be
 * filled in where it was typed.
 * @param {{storage: any, now?: number}} input
 * @returns {string | null}
 */
export function pendingDraftRoute({ storage, now = Date.now() }) {
  if (!storage) return null;
  try {
    const raw = storage.getItem(DRAFT_KEEP_KEY);
    if (typeof raw !== 'string' || raw === '') return null;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved.hash !== 'string' || !saved.hash.startsWith('#/')
      || typeof saved.at !== 'number' || now - saved.at > MAX_AGE_MS || now < saved.at) return null;
    return saved.hash;
  } catch {
    return null;
  }
}
