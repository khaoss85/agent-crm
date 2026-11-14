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
 * }} [options]
 */
export function withSchemaCache(request, {
  ttlMs = 30_000,
  now = () => Date.now(),
  space = () => null,
  storage = null,
  onChange = () => {},
} = {}) {
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
  /** @param {string} key @param {string} path @param {any} options */
  const renew = (key, path, options) => {
    const running = inFlight.get(key);
    if (running) return running;
    const before = copies.get(key) ?? null;
    const promise = request(path, options).then((value) => {
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
        } catch {
          // Quota or private mode: the next reload waits once, nothing more.
        }
      }
      if (before !== null && before.text !== text && key === spaceKey()) {
        try {
          onChange(key);
        } catch {
          // A repaint that fails never fails the read that answered.
        }
      }
      return value;
    });
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
      void renew(key, path, options).catch(() => {});
    }
    return Promise.resolve(copy.value);
  };
}

/** The sessionStorage key prefix of a space's schema copy. */
export const SCHEMA_STORAGE_PREFIX = 'bo-schema:';
