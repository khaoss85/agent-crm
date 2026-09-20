// @ts-check

import { AppError } from '../../core/index.js';
import { deciding, resolvedNames, trusted } from './store.js';

/**
 * **Scale-safe export of this package's own evidence (Customer Data
 * Operations v2).**
 *
 * The hazard this exists for is the one the package already names beside
 * its reads: `list()` is a bounded display page that clamps whatever limit
 * it is handed into `1..500`. Asking a page for a large set does not raise
 * the bound — it silently returns the newest 500. An export built on a page
 * is a short file that looks complete.
 *
 * So this export never touches a page. It counts first with the complete
 * `countWhere` query, states the row count and the bound on the answer, and
 * refuses with `EXPORT_WOULD_TRUNCATE` when the set does not fit — a
 * truncated export is a refusal, never a short file. The rows themselves
 * come from the complete `listWhere` read, and the answer reconciles the
 * two: a count that disagrees with the rows it counted is refused rather
 * than reported.
 *
 * The caller may ask for a SMALLER bound than the server's, never a larger
 * one: the bound is capacity the server declares, not courage the caller
 * supplies. The export writes nothing — it creates no run, no receipt, no
 * audit entry — and the role boundary lives where every other package
 * operation's lives: the enumerated HTTP route gates `records.read` before
 * this code runs.
 */

/** Twenty times the display page: large enough to be an export, bounded enough to be one call. */
export const EXPORT_MAX_ROWS = 10_000;

/**
 * @param {Record<string, string>} [config]
 */
export function exportableResources(config) {
  const names = resolvedNames(config);
  return Object.freeze({
    'customer-import-run': names.run,
    'customer-import-row': names.row,
    'external-identity': names.identity,
    'duplicate-candidate': names.candidate,
    'canonical-link': names.link,
    'data-quality-issue': names.issue,
    'customer-bulk-run': names.bulkRun,
    'customer-bulk-item': names.bulkItem,
  });
}

/**
 * @param {{
 *   database: any, modules: any, events: any, config?: Record<string, unknown>,
 * }} handles
 */
export function createCustomerDataExport({ database, modules, events, config }) {
  if (!database || !modules || !events) {
    throw new AppError('customer-data export needs database, modules and events', {
      code: 'CUSTOMER_DATA_STORAGE_INVALID', status: 500,
    });
  }
  const resources = exportableResources(config);

  return {
    /**
     * Export one managed record set, completely or not at all.
     * @param {{resource?: unknown, where?: unknown, bound?: unknown}} request
     */
    async exportCustomerRecords(request) {
      const resource = request?.resource;
      if (typeof resource !== 'string' || resources[resource] === undefined) {
        throw new AppError(
          `unknown export resource: one of ${Object.keys(resources).join(', ')}`,
          { code: 'EXPORT_UNKNOWN_RESOURCE', status: 400, details: { field: 'resource' } },
        );
      }
      const where = request?.where ?? {};
      if (typeof where !== 'object' || where === null || Array.isArray(where)) {
        throw new AppError('export filters must be an exact-match object', {
          code: 'EXPORT_FILTERS_INVALID', status: 400, details: { field: 'where' },
        });
      }
      const bound = request?.bound ?? EXPORT_MAX_ROWS;
      if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 1) {
        throw new AppError('the export bound must be a whole number of at least 1', {
          code: 'EXPORT_BOUND_INVALID', status: 400, details: { field: 'bound' },
        });
      }
      if (bound > EXPORT_MAX_ROWS) {
        throw new AppError(
          `the export bound is at most ${EXPORT_MAX_ROWS} rows: ask for less, not for a short file`,
          { code: 'EXPORT_BOUND_EXCEEDS_MAX', status: 400, details: { field: 'bound' } },
        );
      }

      const service = trusted(modules, resources[resource]);
      // The complete count first: the decision to refuse or to read is taken
      // on the whole set, never on a window of it.
      const rowCount = await Promise.resolve(service.countWhere({ ...where }));
      if (rowCount > bound) {
        throw new AppError(
          `this export holds ${rowCount} rows under a bound of ${bound}, so it refuses rather than returning a short file`,
          {
            code: 'EXPORT_WOULD_TRUNCATE', status: 409,
            details: Object.freeze({ resource, rowCount, bound }),
          },
        );
      }
      const rows = await deciding(service, { ...where });
      if (rows.length !== rowCount) {
        throw new AppError(
          'the export count disagrees with the rows it counted, so nothing is returned',
          {
            code: 'EXPORT_READ_INCONSISTENT', status: 500,
            details: Object.freeze({ resource, rowCount, read: rows.length }),
          },
        );
      }
      return Object.freeze({
        resource,
        rowCount,
        bound,
        complete: true,
        rows: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
      });
    },
  };
}
