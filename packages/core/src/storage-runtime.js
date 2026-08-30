// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';

/**
 * Request-local affine storage overlay. Portable `transactionAsync` publishes
 * the acquired client here instead of mutating the process-wide handle, so a
 * second request still sees the pool.
 *
 * @type {AsyncLocalStorage<{database: any, storage: any}>}
 */
const AFFINE_STORAGE = new AsyncLocalStorage();

/**
 * @param {any} database
 * @param {any} storage
 * @param {() => any} fn
 */
export function runWithAffineStorage(database, storage, fn) {
  return AFFINE_STORAGE.run({ database, storage }, fn);
}

/**
 * @param {any} database
 */
export function affineStorageFor(database) {
  const overlay = AFFINE_STORAGE.getStore();
  if (overlay && overlay.database === database) return overlay.storage;
  return null;
}

/**
 * @param {any} database
 */
function currentStorage(database) {
  return affineStorageFor(database) ?? database?.storage;
}

/**
 * Storage Contract access for dual SQLite-sync / PostgreSQL-async consumers.
 * The synchronous factory keeps `database.storage.sync`. PostgreSQL composition
 * exposes only the async handle. Callers that must stay byte-sync on SQLite
 * branch on {@link isSyncStorage} rather than returning a conditional Promise
 * from `createAccordoApp()`.
 *
 * @param {any} database
 */
export function isSyncStorage(database) {
  const storage = currentStorage(database);
  return Boolean(storage?.sync && typeof storage.sync.execute === 'function');
}

/**
 * @param {any} database
 */
export function storageApi(database) {
  const storage = currentStorage(database);
  if (!storage || typeof storage !== 'object') {
    throw new AppError('Storage Contract v1 handle is required', {
      code: 'STORAGE_UNAVAILABLE',
      status: 500,
    });
  }
  return storage.sync ?? storage;
}

/**
 * @param {any} value
 * @param {(resolved: any) => any} map
 */
export function settleStorageRead(database, value, map) {
  if (isSyncStorage(database)) return map(value);
  return Promise.resolve(value).then(map);
}

/**
 * @param {any} database
 * @param {object} statement
 * @param {(row: any) => any} map
 */
export function storageMaybeOne(database, statement, map) {
  return settleStorageRead(database, storageApi(database).maybeOne(statement), map);
}

/**
 * @param {any} database
 * @param {object} statement
 * @param {(row: any) => any} [map]
 */
export function storageMany(database, statement, map = (row) => row) {
  const rows = storageApi(database).many(statement);
  if (isSyncStorage(database)) return rows.map(map);
  return Promise.resolve(rows).then((resolved) => Promise.all(resolved.map(map)));
}

/**
 * Run a mutation atomically. SQLite uses a savepoint on the sync handle.
 * PostgreSQL uses a savepoint when an affine transaction is already open,
 * otherwise one outer SERIALIZABLE transaction.
 *
 * @param {any} database
 * @param {string} name
 * @param {(storage: any) => any} fn
 */
export async function storageMutate(database, name, fn) {
  if (isSyncStorage(database)) {
    const sync = storageApi(database);
    return sync.savepoint(name, () => fn(sync));
  }
  const storage = currentStorage(database);
  if (typeof storage.activeTransaction === 'function' && storage.activeTransaction()) {
    return storage.savepoint(name, () => fn(storage));
  }
  return storage.transaction((tx) => fn(tx));
}
