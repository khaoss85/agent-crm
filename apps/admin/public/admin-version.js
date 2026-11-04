// @ts-check

/**
 * Bundle-update notice for the Admin shell (backlog:49bd3657b0f8).
 *
 * A release is a new process, hence a new bundle name: the server builds
 * the bundle at serve time and the name carries its content hash, while an
 * open tab keeps the old bundle in memory. Without a notice the tab writes
 * through the old code until the session looks lost. This module polls the
 * served bundle identity and either reloads the tab (nothing unsaved) or
 * shows a persistent notice the operator confirms (text still on screen).
 *
 * Keeping text safe is the whole point, so the reload waits whenever the
 * page holds unsent text: any non-empty textarea or text-like input counts
 * as unsaved, and views with non-DOM draft state mark it through
 * markUnsaved. A false dirty only delays the reload behind a notice; a
 * false clean would lose text, so the heuristic leans dirty.
 *
 * Pure on purpose: every decision is a tested function of its inputs, and
 * the only impure edges (fetch, reload, timers) arrive as parameters.
 */

export const BO_VERSION_POLL_MS = 60000;

export const BO_UPDATE_BANNER_ID = 'bo-update-banner';

export const BO_UPDATE_NOTICE = 'È disponibile una nuova versione · Aggiorna';

const BO_BUNDLE_NAME_PATTERN = /^bo-[0-9a-f]+\.js$/;

/** Text-like input types whose content is user text worth keeping. */
const BO_TEXT_INPUT_TYPES = Object.freeze(new Set([
  '',
  'text',
  'search',
  'tel',
  'email',
  'url',
  'password',
  'number',
]));

let boReloadFired = false;

/** Sources with programmatic draft state, by caller-chosen key. */
const boUnsavedSources = new Set();

/**
 * Mark programmatic draft state (a view holding text outside the DOM).
 * @param {unknown} source a caller-chosen key naming the draft
 * @param {boolean} [unsaved]
 */
export function markUnsaved(source, unsaved = true) {
  if (typeof source !== 'string' || source === '') return;
  if (unsaved) boUnsavedSources.add(source);
  else boUnsavedSources.delete(source);
}

/**
 * Forget draft marks: one source, or every source when omitted.
 * @param {unknown} [source]
 */
export function clearUnsaved(source) {
  if (source === undefined) boUnsavedSources.clear();
  else if (typeof source === 'string' && source !== '') boUnsavedSources.delete(source);
}

/**
 * Reset the watch state (one reload per page): tests only.
 */
export function resetVersionWatchState() {
  boReloadFired = false;
  boUnsavedSources.clear();
}

/**
 * Read the served bundle identity. Anything else — a login page followed
 * home, an error page, a truncated body — reads as unknown, never as a
 * mandate to reload.
 * @param {unknown} text
 */
export function parseVersionPayload(text) {
  if (typeof text !== 'string' || text === '') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const jsName = /** @type {any} */ (parsed).jsName;
  if (typeof jsName !== 'string' || !BO_BUNDLE_NAME_PATTERN.test(jsName)) return null;
  return Object.freeze({ jsName });
}

/**
 * The bundle name this tab was served, from its own script tag. Null when
 * the page carries no hashed bundle (development entry, unknown shell).
 * @param {{ querySelectorAll?: Function } | undefined} [doc]
 */
export function currentBundleName(doc) {
  let source = doc;
  if (source === undefined || source === null) {
    if (typeof globalThis.document === 'undefined') return null;
    source = globalThis.document;
  }
  let scripts;
  try {
    scripts = typeof source.querySelectorAll === 'function'
      ? source.querySelectorAll('script[src]')
      : [];
  } catch {
    return null;
  }
  const list = Array.isArray(scripts) ? scripts : Array.from(scripts ?? []);
  for (const script of list) {
    let src = null;
    try {
      src = typeof script.getAttribute === 'function' ? script.getAttribute('src') : script?.src;
    } catch {
      continue;
    }
    if (typeof src !== 'string' || src === '') continue;
    const leaf = src.split('?')[0].split('#')[0].split('/').pop() ?? '';
    if (BO_BUNDLE_NAME_PATTERN.test(leaf)) return leaf;
  }
  return null;
}

/**
 * @param {unknown} current the bundle this tab runs, or null when unknown
 * @param {unknown} served the bundle the server serves now, or null
 */
export function isUpdateAvailable(current, served) {
  if (typeof current !== 'string' || current === '') return false;
  if (served === null || typeof served !== 'object' || Array.isArray(served)) return false;
  const jsName = /** @type {any} */ (served).jsName;
  if (typeof jsName !== 'string' || jsName === '') return false;
  return jsName !== current;
}

/**
 * Whether the page holds unsent text: an explicit draft mark, or any
 * non-empty textarea or text-like input. Selects and option controls never
 * count: they carry a value by construction, so they would pin the notice
 * on every screen. What the notice does not cover is named in the PR.
 * @param {{ querySelectorAll?: Function } | undefined} [doc]
 */
export function hasUnsavedWork(doc) {
  if (boUnsavedSources.size > 0) return true;
  let source = doc;
  if (source === undefined || source === null) {
    if (typeof globalThis.document === 'undefined') return boUnsavedSources.size > 0;
    source = globalThis.document;
  }
  let fields;
  try {
    fields = typeof source.querySelectorAll === 'function'
      ? source.querySelectorAll('textarea, input')
      : [];
  } catch {
    return false;
  }
  const list = Array.isArray(fields) ? fields : Array.from(fields ?? []);
  for (const field of list) {
    if (field === null || typeof field !== 'object') continue;
    if (field.disabled === true) continue;
    const tag = typeof field.tagName === 'string' ? field.tagName.toUpperCase() : '';
    if (tag === 'TEXTAREA') {
      if (typeof field.value === 'string' && field.value !== '') return true;
      continue;
    }
    if (tag !== 'INPUT') continue;
    let type = '';
    try {
      type = typeof field.getAttribute === 'function'
        ? String(field.getAttribute('type') ?? '').toLowerCase()
        : String(field.type ?? '').toLowerCase();
    } catch {
      continue;
    }
    if (!BO_TEXT_INPUT_TYPES.has(type)) continue;
    if (typeof field.value === 'string' && field.value !== '') return true;
  }
  return false;
}

/**
 * Show the persistent update notice, or return the one already on screen.
 * The whole notice is one button: its label is the notice itself, so the
 * operator reads and confirms in one gesture. Text only, never markup.
 * @param {{ getElementById?: Function, createElement?: Function, body?: any } | undefined} [doc]
 * @param {{ onUpdate?: Function }} [options]
 */
export function ensureUpdateBanner(doc, options = {}) {
  let source = doc;
  if (source === undefined || source === null) {
    if (typeof globalThis.document === 'undefined') return null;
    source = globalThis.document;
  }
  try {
    const existing = typeof source.getElementById === 'function'
      ? source.getElementById(BO_UPDATE_BANNER_ID)
      : null;
    if (existing) return existing;
    if (typeof source.createElement !== 'function' || !source.body) return null;
    const banner = source.createElement('button');
    banner.setAttribute('type', 'button');
    banner.setAttribute('id', BO_UPDATE_BANNER_ID);
    banner.setAttribute('class', 'bo-update-banner');
    banner.textContent = BO_UPDATE_NOTICE;
    const onUpdate = options?.onUpdate;
    banner.addEventListener('click', () => {
      if (typeof onUpdate === 'function') onUpdate();
    });
    source.body.appendChild(banner);
    return banner;
  } catch {
    return null;
  }
}

/**
 * One poll against the served bundle identity.
 *
 * Returns `current` (same bundle), `reloaded` (new bundle, nothing
 * unsaved, the tab reloaded), `deferred` (new bundle, text on screen, the
 * notice waits for the operator), `unknown` (this tab carries no bundle
 * name to compare) or `failed` (the read said nothing usable — retried on
 * the next navigation or minute, never a notice).
 */
export async function checkBundleVersion(options = {}) {
  const adminBase = typeof options?.adminBase === 'string' ? options.adminBase : '';
  const fetchImpl = typeof options?.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  let doc = options?.doc;
  if (doc === undefined || doc === null) {
    doc = typeof globalThis.document === 'undefined' ? undefined : globalThis.document;
  }
  const win = options?.win
    ?? (typeof globalThis.window === 'undefined' ? undefined : globalThis.window);
  const current = currentBundleName(doc);
  if (current === null) return 'unknown';
  if (fetchImpl === null) return 'failed';
  let text = null;
  try {
    const response = await fetchImpl(`${adminBase}/version.json`, { cache: 'no-store' });
    if (!response || response.ok !== true) return 'failed';
    text = await response.text();
  } catch {
    return 'failed';
  }
  const served = parseVersionPayload(text);
  if (served === null) return 'failed';
  if (!isUpdateAvailable(current, served)) return 'current';
  if (hasUnsavedWork(doc)) {
    ensureUpdateBanner(doc, {
      onUpdate: () => {
        if (typeof options?.reload === 'function') options.reload();
        else if (win?.location && typeof win.location.reload === 'function') win.location.reload();
      },
    });
    return 'deferred';
  }
  if (boReloadFired) return 'deferred';
  boReloadFired = true;
  if (typeof options?.reload === 'function') options.reload();
  else if (win?.location && typeof win.location.reload === 'function') win.location.reload();
  return 'reloaded';
}

/**
 * Watch the served bundle from the first paint: once now, on every
 * navigation and every minute after. A failed poll only waits for the
 * next one; the shell never notices the watch.
 */
export function startBundleWatch(options = {}) {
  const adminBase = typeof options?.adminBase === 'string' ? options.adminBase : '';
  const pollMs = Number.isInteger(options?.pollMs) && options.pollMs > 0
    ? options.pollMs
    : BO_VERSION_POLL_MS;
  let doc = options?.doc;
  if (doc === undefined || doc === null) {
    doc = typeof globalThis.document === 'undefined' ? undefined : globalThis.document;
  }
  const win = options?.win
    ?? (typeof globalThis.window === 'undefined' ? undefined : globalThis.window);
  const check = () => {
    try {
      const pending = checkBundleVersion({ ...options, adminBase, doc, win });
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      // The watch never breaks the shell.
    }
  };
  check();
  let onHash = null;
  try {
    if (win && typeof win.addEventListener === 'function') {
      onHash = () => check();
      win.addEventListener('hashchange', onHash);
    }
  } catch {
    onHash = null;
  }
  let timer = null;
  try {
    timer = setInterval(check, pollMs);
  } catch {
    timer = null;
  }
  return () => {
    try {
      if (timer !== null) clearInterval(timer);
    } catch {
      // Stopping is best-effort.
    }
    try {
      if (onHash !== null && win && typeof win.removeEventListener === 'function') {
        win.removeEventListener('hashchange', onHash);
      }
    } catch {
      // Stopping is best-effort.
    }
  };
}
