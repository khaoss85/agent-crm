// @ts-check

/**
 * The starter's B2B sales pipeline (ADR-014): a checked-in, code-first
 * definition — reviewable source an agent can regenerate from a brief, never
 * runtime-mutable configuration. Registered in
 * packages/pipelines/generated/index.js when the starter is applied.
 *
 * Converted leads' Opportunities enter `discovery` (the declared default);
 * `move-stage` walks them through open stages to won or lost.
 */
export const b2bSalesPipeline = {
  pipelineContract: 1,
  name: 'b2b-sales',
  label: 'B2B Sales',
  module: 'opportunity',
  defaultStage: 'discovery',
  stages: [
    { key: 'discovery', label: 'Discovery', order: 10, type: 'open', probability: 10 },
    { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
    { key: 'proposal', label: 'Proposal', order: 30, type: 'open', probability: 60 },
    { key: 'negotiation', label: 'Negotiation', order: 40, type: 'open', probability: 80 },
    { key: 'won', label: 'Won', order: 50, type: 'won', probability: 100 },
    { key: 'lost', label: 'Lost', order: 60, type: 'lost', probability: 0 },
  ],
};

export default b2bSalesPipeline;
