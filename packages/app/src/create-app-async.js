// @ts-check

import { AppError } from '../../core/src/errors.js';
import { startPortableSqliteApp } from './portable-app.js';

/**
 * Public portable async factory. It composes kernel Company, Contact,
 * Opportunity and Approval over the source-private SQLite lifecycle. The
 * default selected graph is an explicit packageContract 2 with empty package,
 * action and module lists. Bundled and generated v1 registries are never the
 * default. This module does not import or wrap the synchronous v1 factory.
 */

const DEFAULT_SELECTED_GRAPH = Object.freeze({
  packageContract: 2,
  packages: Object.freeze([]),
  actions: Object.freeze([]),
  modules: Object.freeze([]),
});

const POSTGRES_KEYS = Object.freeze([
  'connection',
  'connectionString',
  'url',
  'databaseUrl',
  'postgres',
  'postgresql',
  'controlPlane',
]);

const UNSUPPORTED_KEYS = Object.freeze([
  'spine',
  'identityVerifier',
  'authorize',
  'security',
  'deploymentStorage',
  'openDatabase',
  'listen',
  'providers',
]);

function storageUnavailable(adapter) {
  return new AppError(
    'the PostgreSQL adapter is not available; the portable factory remains SQLite until the production adapter lands',
    {
      code: 'STORAGE_ADAPTER_UNAVAILABLE',
      status: 400,
      details: { adapter },
    },
  );
}

function optionUnsupported(option) {
  return new AppError(
    `createAccordoAppAsync does not support "${option}"`,
    {
      code: 'PORTABLE_OPTION_UNSUPPORTED',
      status: 400,
      details: { option },
    },
  );
}

/**
 * @param {any} options
 */
function refuseUnavailableOptions(options) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    return;
  }

  let adapter;
  try {
    adapter = options.adapter;
  } catch {
    throw storageUnavailable('unknown');
  }
  if (adapter != null && adapter !== 'sqlite') {
    throw storageUnavailable('postgresql');
  }

  for (const key of POSTGRES_KEYS) {
    let value;
    try {
      value = options[key];
    } catch {
      throw storageUnavailable('postgresql');
    }
    if (value != null) throw storageUnavailable('postgresql');
  }

  let dbPath;
  try {
    dbPath = options.dbPath;
  } catch {
    throw storageUnavailable('postgresql');
  }
  if (typeof dbPath === 'string' && /^postgres(ql)?:\/\//i.test(dbPath)) {
    throw storageUnavailable('postgresql');
  }

  for (const key of UNSUPPORTED_KEYS) {
    let value;
    try {
      value = options[key];
    } catch {
      throw optionUnsupported(key);
    }
    if (value != null) throw optionUnsupported(key);
  }
}

/**
 * Own one portable SQLite application. Startup is unconditionally async.
 *
 * @param {{
 *   dbPath?: string,
 *   busyTimeoutMs?: number,
 *   clock?: () => string,
 *   approvalThresholdCents?: number,
 *   catalogTimeoutMs?: number,
 *   signatureTimeoutMs?: number,
 *   selected?: any,
 *   adapter?: unknown,
 * }} [options]
 */
export async function createAccordoAppAsync(options = {}) {
  refuseUnavailableOptions(options);
  const selected = options.selected === undefined ? DEFAULT_SELECTED_GRAPH : options.selected;
  return startPortableSqliteApp({
    selected,
    dbPath: options.dbPath,
    busyTimeoutMs: options.busyTimeoutMs,
    clock: options.clock,
    approvalThresholdCents: options.approvalThresholdCents,
    catalogTimeoutMs: options.catalogTimeoutMs,
    signatureTimeoutMs: options.signatureTimeoutMs,
  });
}
