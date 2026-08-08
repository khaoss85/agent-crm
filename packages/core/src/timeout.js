// @ts-check

import { AppError } from './errors.js';

/**
 * Bounding an outbound call, in a module that names no domain.
 *
 * This was written for the enrichment provider call and lived in the Lead
 * Intelligence actions module for that reason alone. Catalog sync already
 * used it for a completely different outbound call, which meant Commercial
 * Operations imported an Intelligence file to bound a timeout.
 *
 * The behaviour did not change in the move, including the message text: the
 * LA0 baseline pins all three outcomes — resolved, rejected, timed out — and
 * the exact error a caller sees.
 */

/**
 * Bounded provider-call timeout. The losing promise is explicitly observed so
 * a late rejection can never become an unhandled rejection; a late RESOLUTION
 * is simply discarded (best-effort abandonment — the framework does not claim
 * cancellation, and nothing a provider settles late can be persisted because
 * persistence happens only in execute from the already-returned prepared
 * value).
 * @param {Promise<any>} promise @param {number} ms @param {string} label
 */
export function withTimeout(promise, ms, label) {
  /** @type {any} */
  let timer;
  const guarded = Promise.resolve(promise);
  guarded.catch(() => {}); // observe late rejections; never unhandled
  return Promise.race([
    guarded,
    new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new AppError(`${label} timed out after ${ms}ms`, { code: 'PROVIDER_TIMEOUT', status: 504 })),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
