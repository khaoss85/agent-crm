// @ts-check

import { NotFoundError, ValidationError } from './errors.js';

export const SUPPORTED_PIPELINE_CONTRACT = 1;
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const STAGE_TYPES = new Set(['open', 'won', 'lost']);
const LABEL_MAX = 80;

/**
 * Code-first pipeline definitions (ADR-014). A pipeline is a checked-in,
 * validated, deterministic sequence of stages for one staged-eligible module.
 * Definitions are source an agent can generate from a brief and a human can
 * review — never runtime-mutable rows, never a transition DSL.
 *
 * @typedef {{
 *   pipelineContract: 1,
 *   name: string,
 *   label?: string,
 *   module: string,
 *   defaultStage: string,
 *   stages: Array<{key: string, label?: string, order: number, type: 'open' | 'won' | 'lost', probability: number}>
 * }} PipelineDefinition
 */

/**
 * Validate one pipeline definition. Fail closed: a malformed definition throws
 * and stops app startup. Source is trusted (ADR-008 threat model); this guards
 * against accidental or stale definitions.
 *
 * @param {any} definition
 * @param {{moduleExists: (name: string) => boolean}} deps
 */
export function validatePipelineDefinition(definition, deps) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('Pipeline definition must be an object');
  }
  const label = typeof definition.name === 'string' ? `pipeline "${definition.name}"` : 'pipeline';
  if (definition.pipelineContract !== SUPPORTED_PIPELINE_CONTRACT) {
    throw new ValidationError(`${label}: pipelineContract must be ${SUPPORTED_PIPELINE_CONTRACT}`);
  }
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ValidationError(`${label}: name must match ${NAME_RE}`);
  }
  if (definition.label !== undefined && (typeof definition.label !== 'string' || definition.label.length === 0 || definition.label.length > LABEL_MAX)) {
    throw new ValidationError(`${label}: label must be a non-empty string of at most ${LABEL_MAX} characters`);
  }
  if (typeof definition.module !== 'string' || !NAME_RE.test(definition.module)) {
    throw new ValidationError(`${label}: module must match ${NAME_RE}`);
  }
  if (!deps.moduleExists(definition.module)) {
    throw new ValidationError(
      `${label}: target module "${definition.module}" is not staged-eligible — pipelines require a module that stores pipeline state (currently the action-eligible core modules; generated-module pipeline state is future work)`,
    );
  }
  if (!Array.isArray(definition.stages) || definition.stages.length === 0) {
    throw new ValidationError(`${label}: stages must be a non-empty array`);
  }

  const keys = new Set();
  const orders = new Set();
  let openCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  for (const stage of definition.stages) {
    if (!stage || typeof stage !== 'object') throw new ValidationError(`${label}: each stage must be an object`);
    if (typeof stage.key !== 'string' || !NAME_RE.test(stage.key)) {
      throw new ValidationError(`${label}: stage keys must match ${NAME_RE}`);
    }
    if (keys.has(stage.key)) throw new ValidationError(`${label}: duplicate stage key "${stage.key}"`);
    keys.add(stage.key);
    if (stage.label !== undefined && (typeof stage.label !== 'string' || stage.label.length === 0 || stage.label.length > LABEL_MAX)) {
      throw new ValidationError(`${label}: stage "${stage.key}" label must be a non-empty string of at most ${LABEL_MAX} characters`);
    }
    if (!Number.isInteger(stage.order)) {
      throw new ValidationError(`${label}: stage "${stage.key}" order must be an integer`);
    }
    if (orders.has(stage.order)) {
      throw new ValidationError(`${label}: duplicate stage order ${stage.order} — orders must be unique so the board is deterministic`);
    }
    orders.add(stage.order);
    if (!STAGE_TYPES.has(stage.type)) {
      throw new ValidationError(`${label}: stage "${stage.key}" type must be one of: ${[...STAGE_TYPES].join(', ')}`);
    }
    if (stage.type === 'open') openCount += 1;
    if (stage.type === 'won') wonCount += 1;
    if (stage.type === 'lost') lostCount += 1;
    if (!Number.isInteger(stage.probability) || stage.probability < 0 || stage.probability > 100) {
      throw new ValidationError(`${label}: stage "${stage.key}" probability must be an integer 0–100`);
    }
    if (stage.type === 'won' && stage.probability !== 100) {
      throw new ValidationError(`${label}: the won stage must have probability 100`);
    }
    if (stage.type === 'lost' && stage.probability !== 0) {
      throw new ValidationError(`${label}: the lost stage must have probability 0`);
    }
  }
  if (openCount === 0) throw new ValidationError(`${label}: at least one open stage is required`);
  if (wonCount > 1) throw new ValidationError(`${label}: at most one won stage is supported in this milestone`);
  if (lostCount > 1) throw new ValidationError(`${label}: at most one lost stage is supported in this milestone`);
  if (typeof definition.defaultStage !== 'string' || !keys.has(definition.defaultStage)) {
    throw new ValidationError(`${label}: defaultStage must name one of the stage keys`);
  }
  const defaultStage = definition.stages.find((stage) => stage.key === definition.defaultStage);
  if (defaultStage.type !== 'open') {
    throw new ValidationError(`${label}: defaultStage must be an open stage`);
  }
  return definition;
}

/**
 * Registry of pipeline definitions, Map-keyed by name (prototype-safe) with an
 * additional module index. At most ONE pipeline per module in this milestone,
 * so lookups by module stay deterministic.
 */
export class PipelineRegistry {
  /** @param {{moduleExists: (name: string) => boolean}} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, PipelineDefinition>} */
    this.byName = new Map();
    /** @type {Map<string, PipelineDefinition>} */
    this.byModule = new Map();
  }

  /** @param {any} definition */
  register(definition) {
    validatePipelineDefinition(definition, this.deps);
    if (this.byName.has(definition.name)) {
      throw new ValidationError(`Duplicate pipeline name: ${definition.name}`);
    }
    if (this.byModule.has(definition.module)) {
      throw new ValidationError(
        `Module "${definition.module}" already has pipeline "${this.byModule.get(definition.module)?.name}"; one pipeline per module in this milestone`,
      );
    }
    this.byName.set(definition.name, definition);
    this.byModule.set(definition.module, definition);
    return definition;
  }

  /** @param {string} name */
  get(name) {
    const pipeline = this.byName.get(name);
    if (!pipeline) throw new NotFoundError('Pipeline', name);
    return pipeline;
  }

  /** The pipeline targeting a module, or null (pipelines are optional). @param {string} module */
  forModule(module) {
    return this.byModule.get(module) ?? null;
  }

  /** Deterministic list for schema metadata, sorted by name. */
  list() {
    return [...this.byName.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((pipeline) => pipelineMetadata(pipeline));
  }
}

/**
 * Serializable metadata: never functions, deterministic stage order.
 * @param {PipelineDefinition} pipeline
 */
export function pipelineMetadata(pipeline) {
  return {
    pipelineContract: SUPPORTED_PIPELINE_CONTRACT,
    name: pipeline.name,
    label: pipeline.label ?? pipeline.name,
    module: pipeline.module,
    defaultStage: pipeline.defaultStage,
    movePath: `/api/modules/${pipeline.module}/records/:id/actions/move-stage`,
    stages: [...pipeline.stages]
      .sort((a, b) => a.order - b.order)
      .map((stage) => ({
        key: stage.key,
        label: stage.label ?? stage.key,
        order: stage.order,
        type: stage.type,
        probability: stage.probability,
      })),
  };
}

/** Ordered stages helper used by the runtime. @param {PipelineDefinition} pipeline */
export function orderedStages(pipeline) {
  return [...pipeline.stages].sort((a, b) => a.order - b.order);
}

/** @param {PipelineDefinition} pipeline @param {string} key */
export function findStage(pipeline, key) {
  return pipeline.stages.find((stage) => stage.key === key) ?? null;
}
