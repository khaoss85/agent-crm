// @ts-check

/**
 * One `GET /api/schema` per space, served from the last copy while it renews.
 *
 * Production 04/11: the customer card asked for the schema three times at
 * once, each read took 2.6 s on the shared host, and the duplicates pushed
 * the card's own reads past the web's concurrency limit. A read in flight
 * is shared by every caller; a failed read is never kept.
 *
 * backlog:c048bf6f2dd3 (born in #881): screens still waited for the schema
 * every 30 s — 1-3 s per read on the pilot — before their own reads. Now the
 * last copy known for the space answers at once and a renewal runs behind
 * it; the network is awaited only the very first time a space is opened in
 * this tab. A renewed copy that differs (version or content) is kept and
 * `onChange(space)` tells the shell to repaint the screen.
 *
 * A boot read dropped as stale (its screen moved on) proves nothing, so it
 * is read again once with a fresh key; every wait has a timeout that
 * re-reads, so a hung fetch never hangs the menu (backlog:312dd81f83ba).
 *
 * The copy is kept per space — never one space's schema for another — in
 * memory and, when a storage is given, in the tab's sessionStorage, so a
 * reload of the same tab opens without waiting. The schema is the
 * application's own description (modules, fields, workflows, pipelines,
 * providers, the spine's declared contract): no customer record, no
 * person's name, e-mail or phone. A storage that refuses the write (quota,
 * private mode) only costs the next reload its wait.
 *
 * Every other path goes straight through.
 *
 * @param {(path: string, options?: any) => Promise<any>} request the raw client request
 * @param {{
 *   ttlMs?: number,
 *   now?: () => number,
 *   space?: () => string | null,
 *   storage?: { getItem: (key: string) => string | null, setItem: (key: string, value: string) => void } | null,
 *   onChange?: (space: string) => void,
 *   timeoutMs?: number,
 * }} [options]
 */
export function withSchemaCache(request, {
  ttlMs = 30_000,
  now = () => Date.now(),
  space = () => null,
  storage = null,
  onChange = () => {},
  warn = defaultWarn,
  timeoutMs = 10_000,
} = {}) {
  // Review Muse #898: a swallowed failure leaves its cause — once per kind,
  // never a burst on every read.
  const warned = new Set();
  /** @param {string} area @param {unknown} error */
  const warnOnce = (area, error) => {
    if (warned.has(area)) return;
    warned.add(area);
    try {
      warn(`bo-schema ${area}:`, error instanceof Error ? error.name : 'unknown', String(/** @type {any} */ (error)?.code ?? ''));
    } catch {
      // Logging never breaks the cache.
    }
  };
  /** @type {Map<string, {value: any, text: string, at: number}>} */
  const copies = new Map();
  /** @type {Map<string, Promise<any>>} */
  const inFlight = new Map();
  const spaceKey = () => {
    let raw = null;
    try {
      raw = space();
    } catch {
      raw = null;
    }
    return typeof raw === 'string' ? raw : '';
  };
  const storageKey = (key) => `${SCHEMA_STORAGE_PREFIX}${key}`;
  /** The copy this tab already holds for the space: memory first, then the tab's storage. @param {string} key */
  const known = (key) => {
    const inMemory = copies.get(key);
    if (inMemory) return inMemory;
    if (storage === null) return null;
    try {
      const text = storage.getItem(storageKey(key));
      if (typeof text !== 'string' || text === '') return null;
      // A copy from storage is as old as can be: it answers now and renews.
      const copy = { value: JSON.parse(text), text, at: -Infinity };
      copies.set(key, copy);
      return copy;
    } catch {
      return null;
    }
  };
  /**
   * Whether a schema read failed only because its screen moved on
   * (READ_STALE from admin-core.js): the drop proved nothing about the space,
   * so the wait reads again with a fresh key instead of failing. Duck-typed
   * by code so this module stays standalone and node-testable.
   * @param {unknown} error
   */
  const isStaleDrop = (error) => error !== null
    && typeof error === 'object'
    && /** @type {any} */ (error).code === 'READ_STALE';

  /** @param {string} key @param {string} path @param {any} options */
  const renew = (key, path, options) => {
    const running = inFlight.get(key);
    if (running) return running;
    const before = copies.get(key) ?? null;
    const store = (value) => {
      let text;
      try {
        text = JSON.stringify(value);
      } catch {
        text = '';
      }
      copies.set(key, { value, text, at: now() });
      if (storage !== null && text !== '') {
        try {
          storage.setItem(storageKey(key), text);
        } catch (error) {
          // Quota or private mode: the next reload waits once, nothing more.
          warnOnce('copy not stored', error);
        }
      }
      if (before !== null && before.text !== text && key === spaceKey()) {
        try {
          onChange(key);
        } catch (error) {
          // A repaint that fails never fails the read that answered.
          warnOnce('change not applied', error);
        }
      }
      return value;
    };
    // backlog:312dd81f83ba (ritorno 1): the boot read without a copy is
    // dropped as stale on purpose — route() moves the navigation token
    // right after it leaves — and the drop proved nothing. It is read
    // again once, with the fresh key; a drop that stays stale still fails.
    let attempts = 0;
    const attempt = () => {
      attempts += 1;
      return request(path, options).then(store, (error) => {
        if (isStaleDrop(error) && attempts === 1) return attempt();
        throw error;
      });
    };
    // backlog:312dd81f83ba (ritorno 1): every wait has a timeout that
    // re-reads — a hung fetch never hangs the menu. The timed-out flight
    // leaves the map, so the next wait starts a fresh read; a late answer
    // from the orphaned flight still lands as the copy (self-healing).
    const limit = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 0;
    let timer = null;
    const network = attempt();
    const guarded = limit > 0 && typeof setTimeout === 'function' && typeof clearTimeout === 'function'
      ? new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          timer = null;
          if (inFlight.get(key) === promise) inFlight.delete(key);
          reject(Object.assign(new Error('schema read timed out'), { code: 'SCHEMA_READ_TIMEOUT' }));
        }, limit);
        network.then(
          (value) => { if (timer !== null) { clearTimeout(timer); timer = null; } resolve(value); },
          (error) => { if (timer !== null) { clearTimeout(timer); timer = null; } reject(error); },
        );
      })
      : network;
    const promise = guarded;
    inFlight.set(key, promise);
    promise.then(
      () => { if (inFlight.get(key) === promise) inFlight.delete(key); },
      () => { if (inFlight.get(key) === promise) inFlight.delete(key); },
    );
    return promise;
  };
  return (path, options = {}) => {
    const method = String(options?.method ?? 'GET').toUpperCase();
    if (path !== '/api/schema' || method !== 'GET') return request(path, options);
    const key = spaceKey();
    const copy = known(key);
    if (copy === null) return renew(key, path, options);
    if (now() - copy.at >= ttlMs) {
      // The renewal runs behind the answer; a failed one keeps the copy.
      void renew(key, path, options).catch((error) => warnOnce('renewal failed', error));
    }
    return Promise.resolve(copy.value);
  };
}

/** @param {...unknown} parts */
function defaultWarn(...parts) {
  if (typeof console !== 'undefined' && typeof console.warn === 'function') console.warn(...parts);
}

/**
 * The shell's schema client (review Muse #898): keyed by the mount
 * (`/w/<space>/bo`) plus the active space, kept in the tab's storage, and —
 * when a renewed schema differs — refreshing the navigation only. The
 * screen in use is never repainted under the person (a form open, a text
 * half typed): it reads the new schema at its next navigation.
 * @param {{
 *   request: (path: string, options?: any) => Promise<any>,
 *   adminBase: string,
 *   activeSpace: () => string | null,
 *   storage?: { getItem: (key: string) => string | null, setItem: (key: string, value: string) => void } | null,
 *   refreshNav: () => unknown,
 *   ttlMs?: number, now?: () => number, warn?: (...parts: unknown[]) => void,
 * }} options
 */
export function createShellSchemaClient({ request, adminBase, activeSpace, storage = null, refreshNav, ttlMs, now, warn }) {
  return withSchemaCache(request, {
    ...(ttlMs !== undefined ? { ttlMs } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(warn !== undefined ? { warn } : {}),
    space: () => `${adminBase}|${activeSpace() ?? ''}`,
    storage,
    onChange: () => { void refreshNav(); },
  });
}

/** The sessionStorage key prefix of a space's schema copy. */
export const SCHEMA_STORAGE_PREFIX = 'bo-schema:';

/**
 * Identity of one schema copy for the shell's stamp (backlog:c048bf6f2dd3,
 * ritorno 1): the version when the schema names one, plus a short FNV-1a
 * digest of the copy — the same algorithm as spaceBadgeIndex in
 * admin-shell.js, kept here so this module stays standalone and
 * node-testable. A content change without a version bump still moves the
 * stamp. A missing or unserializable value stamps empty, never throws. The
 * schema is the application's own description (modules, fields, workflows,
 * pipelines, providers, the spine's declared contract): no customer record,
 * no person's name, e-mail or phone — safe to show.
 * @param {unknown} schema
 */
export function schemaStampOf(schema) {
  const empty = { version: '', digest: '' };
  if (schema === null || typeof schema !== 'object') return empty;
  const rawVersion = /** @type {any} */ (schema).version;
  const version = typeof rawVersion === 'string' || typeof rawVersion === 'number' ? String(rawVersion) : '';
  let text = '';
  try {
    text = JSON.stringify(schema) ?? '';
  } catch {
    return { version, digest: '' };
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return { version, digest: (hash >>> 0).toString(16).padStart(8, '0') };
}
