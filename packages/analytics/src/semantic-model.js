// @ts-check

import { ValidationError } from '../../core/src/errors.js';

/**
 * Pipeline semantic model (Analytics Studio M16, first increment).
 *
 * The single place physical schema knowledge lives for pipeline analytics:
 * business names an agent may compose map to physical table/column pairs.
 * Anything not listed here cannot appear in a compiled report — the compiler
 * resolves names through this map only, so an unlisted name fails closed
 * instead of reaching storage.
 */

const CURRENCY_RE = /^[A-Z]{3}$/;

/** @param {unknown} value */
function isPlainRecord(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null;
}

/**
 * @param {unknown} value
 * @param {string} field
 */
function requireStageKey(value, field) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a stage key string`, { field });
  }
  return value;
}

export const PIPELINE_SEMANTIC_MODEL = Object.freeze({
  version: 1,
  dataset: Object.freeze({ table: 'opportunities' }),
  fields: Object.freeze({
    'opportunity.amountMinor': Object.freeze({
      column: 'value_cents',
      kind: 'money_minor',
      description: 'Opportunity value in integer 1/100 currency units (ADR-014 money contract).',
    }),
    'opportunity.currency': Object.freeze({
      column: 'currency',
      kind: 'currency',
      description: 'Uppercase ISO-shaped currency code. Partition key: amounts are never summed across currencies.',
      validate: (/** @type {unknown} */ value) => {
        if (typeof value !== 'string' || !CURRENCY_RE.test(value)) {
          throw new ValidationError('currency must be an uppercase 3-letter code', { field: 'currency' });
        }
        return value;
      },
    }),
    'opportunity.stage': Object.freeze({
      column: 'stage',
      kind: 'stage',
      description: 'Pipeline stage key as stored (persistent identifier, ADR-014).',
      validate: requireStageKey,
    }),
    'opportunity.type': Object.freeze({
      column: 'type',
      kind: 'opportunity_type',
      description: 'Opportunity type (new_business, renewal, upsell).',
    }),
    'opportunity.owner': Object.freeze({
      column: 'owner',
      kind: 'owner',
      description: 'Owning user key.',
    }),
    'opportunity.expectedCloseDate': Object.freeze({
      column: 'expected_close_date',
      kind: 'iso_date',
      description: 'Expected close date, ISO string or null.',
    }),
  }),
});

/**
 * Resolve a business field name to its physical column. Unknown names throw —
 * there is no fallback and no prefix matching.
 * @param {string} name
 */
export function resolveField(name) {
  const fields = /** @type {Record<string, {column: string, kind: string, description: string, validate?: (value: unknown) => unknown}>} */ (
    PIPELINE_SEMANTIC_MODEL.fields
  );
  if (typeof name !== 'string' || !Object.hasOwn(fields, name)) {
    throw new ValidationError(`unknown semantic field: ${String(name).slice(0, 120)}`, { field: name });
  }
  return fields[name];
}

/**
 * True only for a plain JSON-safe record — rejects arrays, class instances
 * and prototype-pollution carriers before any key is read.
 * @param {unknown} value
 */
export function requireFilterRecord(value) {
  if (!isPlainRecord(value)) {
    throw new ValidationError('filters must be a plain object', {});
  }
  return /** @type {Record<string, unknown>} */ (value);
}
