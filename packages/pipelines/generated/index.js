// @ts-check
// Registry of code-first pipeline definitions (ADR-014). Each entry is a
// checked-in definition validated fail-closed at app startup: contract
// version, canonical names, unique stage keys/orders, one open default stage,
// bounded labels, a staged-eligible target module.
//
// This repository ships the Accordo sales pipeline
// (../accordo-sales.js): every space composed from this framework — including
// the Arvo pilot, which consumes this repository pinned and has no apply step
// of its own — works the same stages (richiesta info, prova, proposta, pagato
// o perso). The B2B Lead starter (examples/starters/b2b-lead-qualification)
// keeps its own definition for throwaway projects and never registers here,
// because the registry holds at most one pipeline per module and startup
// refuses a second one fail-closed.

import { accordoSalesPipeline } from '../accordo-sales.js';

/**
 * @typedef {import('../../core/src/pipeline-registry.js').PipelineDefinition} PipelineDefinition
 */

/** @type {PipelineDefinition[]} */
export const generatedPipelines = [accordoSalesPipeline];
