// @ts-check

/**
 * Per-space pipeline stage customization (BO-F2-02, backoffice roadmap
 * "06 Pipeline"; technical decision Q-K2: customization is a per-space
 * configuration validated against the 5 closed stage types, never a fork of
 * the code-first definition).
 *
 * A space starts from a code-first base definition
 * (`packages/core/src/pipeline-registry.js`, ADR-014) and overrides it:
 * rename (label), reorder (order), recolor, retype (one of the 5 closed
 * types: open, won, paid, lost, renewal), add a stage, remove a stage.
 * Removing a stage that still contains offers is refused with a reason
 * (`STAGE_NOT_EMPTY`); removing the default stage without naming a new one
 * is refused as well.
 *
 * AI stage suggestions (e.g. Sopralluogo/Preventivo) are proposals, never
 * applied by themselves: `proposePipelineStages` records a `proposed`
 * suggestion with evidence, and only `confirmStageProposal` — called by a
 * human actor — turns it into confirmed stages to apply. There is no code
 * path that applies a proposal without a human confirmation.
 *
 * Everything here is pure and storage-agnostic: callers pass offer counts
 * in (`offerCounts`), persist the returned frozen config, and audit the
 * decision wherever they already audit writes. No CRM table is touched.
 */

import { randomUUID } from 'node:crypto';
import { AppError, ForbiddenError, ValidationError } from '../core/src/errors.js';
import { PIPELINE_STAGE_TYPES, validatePipelineDefinition } from '../core/src/pipeline-registry.js';
import { nowIso } from '../core/src/time.js';

const COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const SPACE_ID_MAX = 128;

/**
 * @typedef {{key: string, label?: string, order: number, type: string, probability: number, color?: string}} SpaceStageInput
 * @typedef {{
 *   rename?: Record<string, string>,
 *   reorder?: Record<string, number>,
 *   recolor?: Record<string, string>,
 *   retype?: Record<string, string>,
 *   add?: SpaceStageInput[],
 *   remove?: string[],
 *   defaultStage?: string
 * }} StageChanges
 */

function requireSpaceId(spaceId) {
  if (typeof spaceId !== 'string' || spaceId.length === 0 || spaceId.length > SPACE_ID_MAX) {
    throw new ValidationError('spaceId must be a non-empty string of at most 128 characters');
  }
  return spaceId;
}

/** @param {unknown} value @param {string} stageKey */
function requireValidColor(value, stageKey) {
  if (typeof value !== 'string' || !COLOR_RE.test(value)) {
    throw new ValidationError(
      `stage "${stageKey}" color must be a hex color like #f80 or #ff8800`,
      { field: 'color', stage: stageKey },
    );
  }
  return value;
}

/**
 * @param {Record<string, number> | Map<string, number> | undefined} offerCounts
 * @param {string} stageKey
 */
function offerCountFor(offerCounts, stageKey) {
  if (offerCounts === undefined) return 0;
  const raw = offerCounts instanceof Map ? offerCounts.get(stageKey) : offerCounts[stageKey];
  if (raw === undefined) return 0;
  if (!Number.isInteger(raw) || raw < 0) {
    throw new ValidationError(
      `offerCounts for stage "${stageKey}" must be a non-negative integer when provided`,
      { field: 'offerCounts', stage: stageKey },
    );
  }
  return raw;
}

/**
 * Customize the stages of a code-first base pipeline for one space.
 * Returns a frozen per-space stage list; the base definition is never
 * mutated. The result always satisfies the same structural rules as a
 * code-first definition (closed types, unique keys/orders, probability and
 * cardinality rules, an open default stage).
 *
 * @param {any} baseDefinition a valid code-first pipeline definition
 * @param {StageChanges} [changes] renames, reorders, colors, types, additions, removals
 * @param {{spaceId: string, offerCounts?: Record<string, number> | Map<string, number>}} options
 */
export function customizePipelineStages(baseDefinition, changes = {}, options = {}) {
  const spaceId = requireSpaceId(options.spaceId);
  if (!baseDefinition || typeof baseDefinition !== 'object' || !Array.isArray(baseDefinition.stages)) {
    throw new ValidationError('baseDefinition must be a pipeline definition with a stages array');
  }
  const { rename = {}, reorder = {}, recolor = {}, retype = {}, add = [], remove = [] } = changes ?? {};

  const stages = baseDefinition.stages.map((stage) => ({ ...stage }));
  const byKey = new Map(stages.map((stage) => [stage.key, stage]));
  /** @param {string} key @param {string} change */
  const known = (key, change) => {
    if (typeof key !== 'string' || !byKey.has(key)) {
      throw new ValidationError(
        `${change} targets unknown stage "${String(key)}" of pipeline "${baseDefinition.name ?? 'unknown'}"`,
        { field: change, stage: String(key) },
      );
    }
    return byKey.get(key);
  };

  for (const key of remove) {
    known(key, 'remove');
    const count = offerCountFor(options.offerCounts, key);
    if (count > 0) {
      throw new AppError(
        `Cannot remove stage "${key}" from pipeline "${baseDefinition.name}" (space "${spaceId}"): ` +
          `it still contains ${count} offer${count === 1 ? '' : 's'}; move or close them first`,
        {
          code: 'STAGE_NOT_EMPTY',
          status: 409,
          details: { spaceId, pipeline: baseDefinition.name, stage: key, offerCount: count },
        },
      );
    }
    byKey.delete(key);
  }
  const remaining = stages.filter((stage) => byKey.has(stage.key));

  for (const [key, label] of Object.entries(rename)) {
    known(key, 'rename').label = label;
  }
  for (const [key, order] of Object.entries(reorder)) {
    known(key, 'reorder').order = order;
  }
  for (const [key, color] of Object.entries(recolor)) {
    known(key, 'recolor').color = requireValidColor(color, key);
  }
  for (const [key, type] of Object.entries(retype)) {
    if (typeof type !== 'string' || !PIPELINE_STAGE_TYPES.includes(type)) {
      throw new ValidationError(
        `stage "${key}" type must be one of: ${PIPELINE_STAGE_TYPES.join(', ')}`,
        { field: 'type', stage: key },
      );
    }
    known(key, 'retype').type = type;
  }
  for (const stage of add) {
    if (!stage || typeof stage !== 'object') {
      throw new ValidationError('added stages must be objects', { field: 'add' });
    }
    if (byKey.has(stage.key)) {
      throw new ValidationError(`duplicate stage key "${stage.key}"`, { field: 'add', stage: stage.key });
    }
    if (stage.color !== undefined) requireValidColor(stage.color, stage.key);
    const record = { ...stage };
    byKey.set(record.key, record);
    remaining.push(record);
  }

  const defaultStage = changes?.defaultStage ?? baseDefinition.defaultStage;
  if (defaultStage !== undefined && !remaining.some((stage) => stage.key === defaultStage)) {
    throw new ValidationError(
      `defaultStage "${defaultStage}" is not a stage of pipeline "${baseDefinition.name}" for space "${spaceId}"` +
        (remove.includes(/** @type {string} */ (baseDefinition.defaultStage))
          ? ': the previous default was removed, name its replacement'
          : ''),
      { field: 'defaultStage' },
    );
  }

  // The result keeps the code-first guarantees: the base targets an eligible
  // module already (validated at startup), so the module check is trivially
  // true here — what matters is re-proving the structural rules.
  const candidate = {
    pipelineContract: 1,
    name: baseDefinition.name,
    module: baseDefinition.module,
    defaultStage,
    stages: remaining,
  };
  validatePipelineDefinition(candidate, { moduleExists: () => true });

  return Object.freeze({
    spaceId,
    pipeline: baseDefinition.name,
    defaultStage: candidate.defaultStage,
    stages: Object.freeze(
      [...remaining]
        .sort((a, b) => a.order - b.order)
        .map((stage) => Object.freeze({
          key: stage.key,
          label: stage.label ?? stage.key,
          order: stage.order,
          type: stage.type,
          probability: stage.probability,
          ...(stage.color !== undefined ? { color: stage.color } : {}),
        })),
    ),
  });
}

/**
 * Record an AI stage suggestion (e.g. Sopralluogo/Preventivo) as a proposal.
 * The returned proposal is `proposed` and carries the exact candidate stages
 * plus the evidence behind them — it changes nothing by itself.
 *
 * @param {{spaceId: string, baseDefinition: any, candidateStages: SpaceStageInput[], proposedBy: {type: string, id: string}, evidence: string[]}} args
 */
export function proposePipelineStages({ spaceId, baseDefinition, candidateStages, proposedBy, evidence }) {
  requireSpaceId(spaceId);
  if (!baseDefinition || typeof baseDefinition !== 'object' || typeof baseDefinition.name !== 'string') {
    throw new ValidationError('baseDefinition must be a pipeline definition');
  }
  if (!Array.isArray(candidateStages) || candidateStages.length === 0) {
    throw new ValidationError('candidateStages must be a non-empty array of stages');
  }
  if (!proposedBy || typeof proposedBy.type !== 'string' || typeof proposedBy.id !== 'string' || proposedBy.id === '') {
    throw new ValidationError('proposedBy must name the proposer as { type, id }');
  }
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some((item) => typeof item !== 'string' || item === '')) {
    throw new ValidationError('evidence must be a non-empty array of reasons behind the suggestion');
  }
  for (const stage of candidateStages) {
    if (stage.color !== undefined) requireValidColor(stage.color, stage.key);
  }
  const candidate = {
    pipelineContract: 1,
    name: baseDefinition.name,
    module: baseDefinition.module,
    defaultStage: baseDefinition.defaultStage,
    stages: candidateStages.map((stage) => ({ ...stage })),
  };
  validatePipelineDefinition(candidate, { moduleExists: () => true });
  return Object.freeze({
    kind: 'pipeline-stage-proposal',
    id: randomUUID(),
    status: 'proposed',
    spaceId,
    pipeline: baseDefinition.name,
    stages: Object.freeze(candidate.stages.map((stage) => Object.freeze({ ...stage }))),
    evidence: Object.freeze([...evidence]),
    proposedBy: Object.freeze({ type: proposedBy.type, id: proposedBy.id }),
    proposedAt: nowIso(),
    decidedBy: null,
    decidedAt: null,
    reason: null,
  });
}

/**
 * Confirm or reject a stage proposal. Only a person (`actor.type === 'user'`)
 * can decide — an AI actor confirming its own suggestion is refused, so a
 * suggestion is never applied by itself. Accepting returns the candidate
 * stages for the caller to apply (e.g. via `customizePipelineStages` wiring);
 * this function persists nothing.
 *
 * @param {any} proposal a proposal from `proposePipelineStages`
 * @param {{actor: {type: string, id: string}, decision: 'accept' | 'reject', reason?: string}} args
 */
export function confirmStageProposal(proposal, { actor, decision, reason }) {
  if (!proposal || proposal.kind !== 'pipeline-stage-proposal') {
    throw new ValidationError('proposal must come from proposePipelineStages');
  }
  if (proposal.status !== 'proposed') {
    throw new AppError(`proposal ${proposal.id ?? ''} is already decided (${proposal.status})`, {
      code: 'PROPOSAL_ALREADY_DECIDED',
      status: 409,
      details: { id: proposal.id ?? null, status: proposal.status },
    });
  }
  if (!actor || typeof actor.type !== 'string' || typeof actor.id !== 'string' || actor.id === '') {
    throw new ValidationError('confirming a stage proposal requires an actor as { type, id }');
  }
  if (actor.type !== 'user') {
    throw new ForbiddenError('only a person can confirm a stage proposal — an AI suggestion is never applied by itself');
  }
  if (decision !== 'accept' && decision !== 'reject') {
    throw new ValidationError('decision must be "accept" or "reject"');
  }
  if (decision === 'reject' && (typeof reason !== 'string' || reason === '')) {
    throw new ValidationError('rejecting a stage proposal requires a reason');
  }
  const decided = Object.freeze({
    ...proposal,
    status: decision === 'accept' ? 'confirmed' : 'rejected',
    decidedBy: Object.freeze({ type: actor.type, id: actor.id }),
    decidedAt: nowIso(),
    reason: typeof reason === 'string' ? reason : null,
  });
  return { proposal: decided, stages: decision === 'accept' ? decided.stages : null };
}
