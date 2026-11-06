// @ts-check

/**
 * One `GET /api/schema` per shell open, shared (production 04/11): the
 * customer card asked for the schema three times at once, each read took
 * 2.6 s on the shared host, and the duplicates pushed the card's own reads
 * past the web's concurrency limit (429 on timeline, identities and the next
 * appointment). A read in flight is shared by every caller; a settled answer
 * is kept for `ttlMs`; a failed read is never kept, so the next caller asks
 * again. Every other path goes straight through.
 *
 * @param {(path: string, options?: any) => Promise<any>} request the raw client request
 * @param {{ttlMs?: number, now?: () => number}} [options]
 */
export function withSchemaCache(request, { ttlMs = 30_000, now = () => Date.now() } = {}) {
  /** @type {{promise: Promise<any>, at: number} | null} */
  let entry = null;
  return (path, options = {}) => {
    const method = String(options?.method ?? 'GET').toUpperCase();
    if (path !== '/api/schema' || method !== 'GET') return request(path, options);
    if (entry !== null && now() - entry.at < ttlMs) return entry.promise;
    const promise = request(path, options);
    const mine = { promise, at: now() };
    entry = mine;
    promise.catch(() => {
      if (entry === mine) entry = null;
    });
    return promise;
  };
}
