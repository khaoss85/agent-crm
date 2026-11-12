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
  // Backlog 099c41c32355 (Reporting like the Pipeline board): the board
  // shows the per-pipeline placement, so these two metrics group by the
  // placement column (`pipeline_stage`) instead of the legacy core `stage`
  // column — same rows the board lists, same phases the board names. The
  // legacy metrics below stay for spaces with no composed pipeline.
  pipeline_value_by_pipeline_stage: Object.freeze({
    version: 1,
    description: 'Open pipeline value by per-pipeline stage, summed in integer minor units and partitioned by currency.',
    measure: Object.freeze({ kind: 'sum', field: 'opportunity.amountMinor' }),
    groupBy: Object.freeze(['opportunity.pipelineStage']),
    partitionBy: Object.freeze(['opportunity.currency']),
    filterable: Object.freeze(['opportunity.pipelineStage', 'opportunity.pipelineKey', 'opportunity.type', 'opportunity.owner', 'opportunity.currency']),
    rowCap: 1000,
  }),
  pipeline_close_schedule_by_pipeline: Object.freeze({
    version: 1,
    description: 'Pipeline value by owner, per-pipeline stage and expected close date, summed in integer minor units and partitioned by currency.',
    measure: Object.freeze({ kind: 'sum', field: 'opportunity.amountMinor' }),
    groupBy: Object.freeze(['opportunity.owner', 'opportunity.pipelineStage', 'opportunity.expectedCloseDate']),
    partitionBy: Object.freeze(['opportunity.currency']),
    filterable: Object.freeze(['opportunity.pipelineStage', 'opportunity.pipelineKey', 'opportunity.owner', 'opportunity.type', 'opportunity.currency']),
    rowCap: 1000,
  }),
  // BO-F5-02 Reporting: the dashboard's period/persona recalculation reads
  // this metric and pipeline_value_by_stage through compileReport/runReport —
  // never ad-hoc storage queries. Groups are exact (owner, stage, ISO date):
  // month bucketing is the dashboard builder's declared post-processing in
  // packages/analytics/src/dashboard.js, never the registry's.
  pipeline_close_schedule: Object.freeze({
    version: 1,
    description: 'Pipeline value by owner, stage and expected close date, summed in integer minor units and partitioned by currency.',
    measure: Object.freeze({ kind: 'sum', field: 'opportunity.amountMinor' }),
    groupBy: Object.freeze(['opportunity.owner', 'opportunity.stage', 'opportunity.expectedCloseDate']),
    partitionBy: Object.freeze(['opportunity.currency']),
    filterable: Object.freeze(['opportunity.owner', 'opportunity.stage', 'opportunity.type', 'opportunity.currency']),
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
