// @ts-check
// Registry of code-first pipeline definitions (ADR-014). Each entry is a
// checked-in definition validated fail-closed at app startup: contract
// version, canonical names, unique stage keys/orders, one open default stage,
// bounded labels, a staged-eligible target module.
//
// This repository ships no pipelines of its own; the B2B Lead starter
// (examples/starters/b2b-lead-qualification) registers its sales pipeline here
// when applied into a project. An empty registry keeps all pre-pipeline
// behavior unchanged: opportunities simply carry null pipeline state.

/**
 * @typedef {import('../../core/src/pipeline-registry.js').PipelineDefinition} PipelineDefinition
 */

/** @type {PipelineDefinition[]} */
export const generatedPipelines = [];
