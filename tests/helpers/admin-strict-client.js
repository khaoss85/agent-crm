// @ts-check

/**
 * Shared fake-client gate for the /bo tests (voce 5a553cb3).
 *
 * The real /bo client (apps/admin/public/app.js `api` and `moduleClient`)
 * refuses a mutation whose Idempotency-Key is not submission-owned BEFORE any
 * request leaves the browser (requireSubmissionContext, code
 * ADMIN_SUBMISSION_REQUIRED). A permissive fake hides a dead write:
 * production 04/11, all six customer-card writes died with no request at all
 * because the card used the raw client (#581).
 *
 * Every fake in tests/admin-*.test.js calls {@link enforceAdminWriteGate} as
 * the first line of its `request`, so a view that writes without going
 * through the submission controller fails here exactly as it would fail live.
 * GET stays open: reads never need a key. Key FORMAT stays the real client's
 * job (requireSubmissionContext); the fake pins the controller path: the key
 * the controller issued must reach the transport headers unchanged, which is
 * what {@link bindAdminMutations} and the views' own submission controllers
 * already do.
 */

import { ADMIN_SUBMISSION_REQUIRED } from '../../apps/admin/public/admin-submission.js';

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * @param {unknown} options request options as passed to `client.request`
 */
export function isAdminWrite(options) {
  const method = String(
    options && typeof options === 'object'
      ? /** @type {any} */ (options).method ?? 'GET'
      : 'GET',
  ).toUpperCase();
  return MUTATION_METHODS.has(method);
}

/**
 * Throw with the real client's code when a write travels without the
 * submission-owned pair `{ idempotencyKey, headers: { 'Idempotency-Key' } }`.
 *
 * @param {string} _path request path, kept for the failure message context
 * @param {unknown} options request options as passed to `client.request`
 */
export function enforceAdminWriteGate(_path, options = {}) {
  if (!isAdminWrite(options)) return;
  const key = /** @type {any} */ (options).idempotencyKey;
  const header = /** @type {any} */ (options).headers?.['Idempotency-Key'];
  if (typeof key !== 'string' || key === '' || header !== key) {
    const error = new Error('Admin mutations require a submission-owned Idempotency-Key');
    /** @type {any} */ (error).code = ADMIN_SUBMISSION_REQUIRED;
    throw error;
  }
}
