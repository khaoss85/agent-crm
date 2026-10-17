// @ts-check

/**
 * The Accordo sales pipeline (ADR-014): a checked-in, code-first definition —
 * reviewable source, never runtime-mutable configuration. Registered in
 * `packages/pipelines/generated/index.js`, so every space composed from this
 * framework (including the Arvo pilot, which pins this repository) works the
 * same five stages: a request for information, a trial, a proposal, and the
 * two terminal outcomes, paid or lost.
 *
 * A new Opportunity opened from a conversation enters `richiesta-info` (the
 * declared default); `move-stage` walks it through the open stages to `pagato`
 * or `perso`.
 */
export const accordoSalesPipeline = {
  pipelineContract: 1,
  name: 'accordo-sales',
  label: 'Vendita Accordo',
  module: 'opportunity',
  defaultStage: 'richiesta-info',
  stages: [
    { key: 'richiesta-info', label: 'Richiesta info', order: 10, type: 'open', probability: 10 },
    { key: 'prova', label: 'Prova', order: 20, type: 'open', probability: 30 },
    { key: 'proposta', label: 'Proposta', order: 30, type: 'open', probability: 60 },
    { key: 'pagato', label: 'Pagato', order: 40, type: 'won', probability: 100 },
    { key: 'perso', label: 'Perso', order: 50, type: 'lost', probability: 0 },
  ],
};

export default accordoSalesPipeline;
