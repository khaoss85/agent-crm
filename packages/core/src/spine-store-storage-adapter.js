// @ts-check

import { AppError } from './errors.js';
import { createSqliteStorage } from './storage-contract.js';

/**
 * Resolve the closed synchronous storage seam used by the public v1 Spine
 * store. Released callers could pass either the framework database wrapper or
 * its SQLite driver directly; the latter remains a compatibility input, but
 * raw-driver access stays inside the SQLite adapter closure.
 *
 * The public v1 store never opens a transaction through this handle. Its
 * historical mutation and audit writes are deliberately separate, so a
 * transaction request on the compatibility-only adapter is a programming
 * error rather than an invitation to invent new semantics here.
 *
 * @param {any} database
 */
export function spineStoreStorage(database) {
  if (database?.storage?.sync) return database.storage.sync;
  const transactionUnavailable = () => {
    throw new AppError('The direct SQLite Spine-store compatibility handle cannot open a transaction', {
      code: 'SPINE_STORE_TRANSACTION_UNAVAILABLE', status: 500,
    });
  };
  return createSqliteStorage(
    database,
    transactionUnavailable,
    async () => transactionUnavailable(),
  ).sync;
}
