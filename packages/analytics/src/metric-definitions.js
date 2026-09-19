// @ts-check

import { ValidationError } from '../../core/src/errors.js';

/**
 * Declared pipeline metrics (Analytics Studio M16, first increment).
 *
 * A metric is data, not code: name, version, which semantic field is measured,
 * how rows group and which currency partition they stay inside. The compiler
 * is the only reader; adding a metric means adding a frozen entry here plus
 * its fixture correctness test — never a new code path.
 */

export const METRIC_DEFINITIONS = Object.freeze({
  pipeline_value_by_stage: Object.freeze({
    version: 1,
    description: 'Open pipeline value by stage, summed in integer minor units and partitioned by currency.',
    measure: Object.freeze({ kind: 'sum', field: 'opportunity.amountMinor' }),
    groupBy: Object.freeze(['opportunity.stage']),
    partitionBy: Object.freeze(['opportunity.currency']),
    filterable: Object.freeze(['opportunity.stage', 'opportunity.type', 'opportunity.owner', 'opportunity.currency']),
    rowCap: 1000,
  }),
});

/**
 * @param {string} name
 */
export function resolveMetric(name) {
  const metrics = /** @type {Record<string, any>} */ (METRIC_DEFINITIONS);
  if (typeof name !== 'string' || !Object.hasOwn(metrics, name)) {
    throw new ValidationError(`unknown metric: ${String(name).slice(0, 120)}`, { metric: name });
  }
  return metrics[name];
}
