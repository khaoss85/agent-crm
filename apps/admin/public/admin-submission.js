// @ts-check

/**
 * Admin owns one root idempotency key at the user-submission boundary.
 * Low-level fetch helpers never invent a replacement key.
 */

export const ADMIN_SUBMISSION_STORAGE = 'accordo.admin.submission.v1';
export const ADMIN_SUBMISSION_REQUIRED = 'ADMIN_SUBMISSION_REQUIRED';
export const ADMIN_SUBMISSION_DIVERGED = 'ADMIN_SUBMISSION_DIVERGED';

const KEY_RE = /^v1\.\d{8}\.[0-9a-f]{32}$/;

/**
 * @param {() => string} [clock]
 */
export function issueAdminKey(clock) {
  const instant = typeof clock === 'function' ? clock() : new Date().toISOString();
  const bucket = String(instant).slice(0, 10).replaceAll('-', '');
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `v1.${bucket}.${hex}`;
}

/**
 * Canonical request fingerprint. Domain payload is hashed, never stored.
 *
 * @param {{ path: string, method: string, body?: unknown }} request
 */
export function fingerprintRequest(request) {
  return JSON.stringify({
    path: request.path,
    method: (request.method ?? 'POST').toUpperCase(),
    body: canonicalize(request.body ?? null),
  });
}

/**
 * @param {unknown} value
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(canonicalize);
  const keys = Object.keys(/** @type {object} */ (value)).sort();
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of keys) out[key] = canonicalize(/** @type {any} */ (value)[key]);
  return out;
}

/**
 * Durable recovery metadata. Never credentials, never domain payload.
 *
 * @param {{
 *   key: string,
 *   issuedAt: string,
 *   path: string,
 *   method: string,
 *   fingerprint: string,
 *   route?: string,
 * }} entry
 */
export function recoveryRecord(entry) {
  if (!KEY_RE.test(entry.key)) throw new Error('Invalid submission key');
  return Object.freeze({
    key: entry.key,
    issuedAt: entry.issuedAt,
    path: entry.path,
    method: entry.method,
    fingerprint: entry.fingerprint,
    route: entry.route ?? entry.path,
  });
}

/**
 * @param {Storage | { getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} storage
 */
export function loadRecoveries(storage) {
  try {
    const raw = storage.getItem(ADMIN_SUBMISSION_STORAGE);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item === 'object' && KEY_RE.test(item.key))
      .map((item) => recoveryRecord({
        key: item.key,
        issuedAt: String(item.issuedAt ?? ''),
        path: String(item.path ?? ''),
        method: String(item.method ?? 'POST'),
        fingerprint: String(item.fingerprint ?? ''),
        route: item.route,
      }));
  } catch {
    return [];
  }
}

/**
 * @param {Storage | { getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} storage
 * @param {ReturnType<typeof recoveryRecord>[]} records
 */
export function persistRecoveries(storage, records) {
  const safe = records.map((item) => recoveryRecord(item));
  if (safe.length === 0) storage.removeItem(ADMIN_SUBMISSION_STORAGE);
  else storage.setItem(ADMIN_SUBMISSION_STORAGE, JSON.stringify(safe));
}

/**
 * @param {unknown} options
 */
export function requireSubmissionContext(options) {
  const key = options && typeof options === 'object' ? /** @type {any} */ (options).idempotencyKey : undefined;
  if (typeof key !== 'string' || !KEY_RE.test(key)) {
    const error = new Error('Admin mutations require a submission-owned Idempotency-Key');
    /** @type {any} */ (error).code = ADMIN_SUBMISSION_REQUIRED;
    throw error;
  }
  return key;
}

/**
 * @param {{
 *   storage?: Storage | { getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void },
 *   clock?: () => string,
 *   transport: (path: string, options: Record<string, unknown>) => Promise<any>,
 * }} options
 */
function memoryStorage() {
  /** @type {Map<string, string>} */
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

/**
 * View-local controller over an Admin client. Mutations go through
 * {@link createSubmissionController}; GET stays on the raw client. The shared
 * `fetch` helper still refuses a raw mutation without a key.
 *
 * @param {{request: Function}} client
 * @param {{ submissions?: ReturnType<typeof createSubmissionController>, storage?: any }} [deps]
 */
export function bindAdminMutations(client, deps = {}) {
  const submissions = deps.submissions ?? createSubmissionController({
    storage: deps.storage ?? (typeof globalThis.localStorage === 'undefined' ? memoryStorage() : globalThis.localStorage),
    transport: (path, options) => client.request(path, {
      method: options.method,
      body: typeof options.body === 'string' ? options.body : JSON.stringify(options.body ?? {}),
      idempotencyKey: options.idempotencyKey,
      headers: { ...(options.headers ?? {}), 'Idempotency-Key': options.idempotencyKey },
    }),
  });
  return {
    submissions,
    client: {
      /**
       * @param {string} path
       * @param {Record<string, unknown>} [options]
       */
      request(path, options = {}) {
        const method = String(options.method ?? 'GET').toUpperCase();
        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
          let body = options.body ?? {};
          if (typeof body === 'string') {
            try { body = body === '' ? {} : JSON.parse(body); } catch { /* fingerprint the raw string */ }
          }
          return submissions.submit({
            path,
            method,
            body,
            key: typeof options.idempotencyKey === 'string' ? options.idempotencyKey : undefined,
          });
        }
        return client.request(path, options);
      },
    },
  };
}

export function createSubmissionController(options) {
  const storage = options.storage ?? globalThis.localStorage;
  const clock = options.clock ?? (() => new Date().toISOString());
  const transport = options.transport;
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();

  function remember(record) {
    const current = loadRecoveries(storage).filter((item) => item.key !== record.key);
    current.push(record);
    persistRecoveries(storage, current);
  }

  function forget(key) {
    persistRecoveries(storage, loadRecoveries(storage).filter((item) => item.key !== key));
  }

  /**
   * One logical user submission. Double-click / Enter+click joins the pending
   * promise. A changed payload under a retained key refuses client-side.
   *
   * @param {{
   *   path: string,
   *   method?: string,
   *   body?: unknown,
   *   key?: string,
   * }} spec
   */
  function submit(spec) {
    const method = (spec.method ?? 'POST').toUpperCase();
    const fingerprint = fingerprintRequest({ path: spec.path, method, body: spec.body });
    const key = spec.key && KEY_RE.test(spec.key) ? spec.key : issueAdminKey(clock);
    const retained = loadRecoveries(storage).find((item) => item.key === key);
    if (retained && retained.fingerprint !== fingerprint) {
      const error = new Error('Retained submission key cannot change payload');
      /** @type {any} */ (error).code = ADMIN_SUBMISSION_DIVERGED;
      return Promise.reject(error);
    }
    const existing = inflight.get(key);
    if (existing) return existing;

    const record = recoveryRecord({
      key,
      issuedAt: clock(),
      path: spec.path,
      method,
      fingerprint,
    });
    remember(record);

    const pending = Promise.resolve()
      .then(() => transport(spec.path, {
        method,
        body: spec.body,
        idempotencyKey: key,
      }))
      .then((result) => {
        forget(key);
        inflight.delete(key);
        return result;
      }, (error) => {
        const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined;
        if (code !== 'COMMIT_OUTCOME_UNKNOWN') forget(key);
        inflight.delete(key);
        throw error;
      });
    inflight.set(key, pending);
    return pending;
  }

  return Object.freeze({
    submit,
    issueKey: () => issueAdminKey(clock),
    recoveries: () => loadRecoveries(storage),
    forget,
    inflight: () => inflight.size,
  });
}
