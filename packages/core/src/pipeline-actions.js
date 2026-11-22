// @ts-check

import { AppError, ValidationError } from './errors.js';
import { findStage } from './pipeline-registry.js';

/**
 * Generic, pipeline-driven `move-stage` action factory (ADR-014). The returned
 * definition is an ordinary code-first action: the starter (or a project)
 * registers it for a staged module, and every rule below is enforced
 * server-side against the registered pipeline — the Admin's stage select is
 * convenience, never authority.
 *
 * Transition rules this milestone: working stages (`open`, `renewal`) move to
 * working or terminal (`won`, `paid`, `lost`) stages. No moves out of a
 * terminal stage (`won`, `paid`, `lost`; 409 TERMINAL_STAGE), no same-stage
 * moves (409 SAME_STAGE — a stale double-submit must be visible, not a silent
 * no-op), no reopen.
 *
 * Board position (backlog:67a3116f4f65): `afterId` (the card it lands
 * right after) or `first: true` (top of the column) places the card inside
 * the target column through the module service's `positionOnBoard` — same
 * transaction, audited on the moved card. With a placement, `toStage` equal
 * to the current stage is a reorder inside the column: no SAME_STAGE, no
 * stage fields touched, and a terminal column can be reordered (nothing
 * reopens). Without a placement the move is exactly as before and the card
 * lands unplaced, on top. A module whose service has no board positions
 * refuses a placement (400) instead of ignoring it. `fromStage`, when supplied, is an optimistic-concurrency
 * check (mismatch → 409 STALE_STAGE). A move to the lost stage requires a
 * non-blank `reason`, recorded as `closeReason`. A move into `paid` closes
 * like `won` (payment received); a move into `renewal` stays working and
 * clears terminal-only fields like `open`.
 *
 * @param {{module: string}} options
 */
export function buildMoveStageAction({ module }) {
  return {
    module,
    name: 'move-stage',
    label: 'Move stage',
    description: 'Move this record to another pipeline stage.',
    actionContract: 1,
    input: [
      { name: 'toStage', type: 'string', required: true, hint: 'Target stage key from the pipeline definition.' },
      { name: 'fromStage', type: 'string', hint: 'Optional optimistic check: must match the current stage.' },
      { name: 'reason', type: 'string', hint: 'Required when moving to the lost stage.' },
      { name: 'afterId', type: 'string', hint: 'Optional board placement: the card this one lands right after, in the target column.' },
      { name: 'first', type: 'boolean', hint: 'Optional board placement: true puts the card at the top of the target column.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, managed, pipelines, modules, actor, step, now }) {
      const pipeline = pipelines.forModule(module);
      if (!pipeline) {
        throw new AppError(`No pipeline is registered for module "${module}"`, { code: 'NO_PIPELINE', status: 409 });
      }
      if (record.pipelineKey !== pipeline.name || !record.pipelineStage) {
        throw new AppError(
          `This record is not on pipeline "${pipeline.name}" — it has ${record.pipelineKey ? `pipeline "${record.pipelineKey}"` : 'no pipeline state'}`,
          { code: 'NO_PIPELINE', status: 409, details: { pipelineKey: record.pipelineKey, pipelineStage: record.pipelineStage } },
        );
      }
      const currentStage = findStage(pipeline, record.pipelineStage);
      if (!currentStage) {
        // Out-of-band write or a definition change that orphaned the record:
        // refuse rather than guess (mirrors CONVERSION_STATE_CORRUPT).
        throw new AppError(
          `Current stage "${record.pipelineStage}" does not belong to pipeline "${pipeline.name}" — pipeline state is corrupt; inspect the data`,
          { code: 'PIPELINE_STATE_CORRUPT', status: 409, details: { stage: record.pipelineStage } },
        );
      }
      if (input.fromStage !== undefined && input.fromStage !== record.pipelineStage) {
        throw new AppError(
          `Stale move: expected current stage "${input.fromStage}" but the record is in "${record.pipelineStage}"`,
          { code: 'STALE_STAGE', status: 409, details: { expected: input.fromStage, actual: record.pipelineStage } },
        );
      }
      const placement = boardPlacement(input);
      /** @type {any} */
      let boardService = null;
      if (placement) {
        if (input.first === true && input.afterId !== undefined) {
          throw new ValidationError('A board placement names afterId or first, not both', { field: 'afterId' });
        }
        boardService = modules && typeof modules.get === 'function' ? modules.get(module)?.service ?? null : null;
        if (!boardService || typeof boardService.positionOnBoard !== 'function') {
          throw new ValidationError(`Module "${module}" has no board positions; move without afterId/first`, { field: 'afterId' });
        }
        if (input.toStage === currentStage.key) {
          // A reorder inside the column: the stage stays, so a terminal
          // column can be reordered too — nothing reopens.
          const placed = await boardService.positionOnBoard(record.id, placement, { actor });
          step('reorder', { pipeline: pipeline.name, stage: currentStage.key, boardPosition: placed.boardPosition });
          return {
            record: {
              id: placed.id,
              pipelineKey: placed.pipelineKey,
              pipelineStage: placed.pipelineStage,
              stageEnteredAt: placed.stageEnteredAt,
              closedAt: placed.closedAt,
              closeReason: placed.closeReason,
              boardPosition: placed.boardPosition,
            },
            from: currentStage.key,
            to: currentStage.key,
          };
        }
      }
      if (currentStage.type !== 'open' && currentStage.type !== 'renewal') {
        throw new AppError(
          `Cannot move out of terminal stage "${currentStage.key}" (${currentStage.type}); reopening is not supported`,
          { code: 'TERMINAL_STAGE', status: 409, details: { stage: currentStage.key, type: currentStage.type } },
        );
      }
      const targetStage = findStage(pipeline, input.toStage);
      if (!targetStage) {
        throw new ValidationError(`toStage must be one of the pipeline's stages`, {
          field: 'toStage',
          allowed: pipeline.stages.map((stage) => stage.key),
        });
      }
      if (targetStage.key === currentStage.key) {
        throw new AppError(`The record is already in stage "${targetStage.key}"`, {
          code: 'SAME_STAGE', status: 409, details: { stage: targetStage.key },
        });
      }
      if (targetStage.type === 'lost' && !input.reason) {
        throw new ValidationError('reason is required when moving to the lost stage', { field: 'reason' });
      }

      const timestamp = now();
      const patch = {
        pipelineStage: targetStage.key,
        stageEnteredAt: timestamp,
        // Coherence is enforced, not assumed: a working stage never carries
        // terminal-only fields (a corrupt out-of-band closedAt is cleared on
        // the next legitimate working move), won/paid never carry a lost
        // reason, and a reason supplied for a non-lost target is deliberately
        // ignored.
        ...(targetStage.type === 'open' || targetStage.type === 'renewal' ? { closedAt: null, closeReason: null } : {}),
        ...(targetStage.type === 'won' || targetStage.type === 'paid' ? { closedAt: timestamp, closeReason: null } : {}),
        ...(targetStage.type === 'lost' ? { closedAt: timestamp, closeReason: input.reason } : {}),
      };
      let updated = await managed(record.id, patch);
      step('transition', {
        pipeline: pipeline.name,
        from: currentStage.key,
        to: targetStage.key,
        type: targetStage.type,
      });
      if (placement && boardService) {
        updated = await boardService.positionOnBoard(record.id, placement, { actor });
        step('reorder', { pipeline: pipeline.name, stage: targetStage.key, boardPosition: updated.boardPosition });
      }
      return {
        record: {
          id: updated.id,
          pipelineKey: updated.pipelineKey,
          pipelineStage: updated.pipelineStage,
          stageEnteredAt: updated.stageEnteredAt,
          closedAt: updated.closedAt,
          closeReason: updated.closeReason,
          ...(updated.boardPosition !== undefined ? { boardPosition: updated.boardPosition } : {}),
        },
        from: currentStage.key,
        to: targetStage.key,
      };
    },
  };
}

/**
 * Generic, pipeline-driven `assign-pipeline` action factory (ADR-014,
 * backlog:19efb8e3cee5). The single action that gives a pipeline to an
 * offer that has none: where `move-stage` refuses a record with no
 * pipeline state (409 NO_PIPELINE), this one adopts it — pipeline and
 * stage land together, in one audited write.
 *
 * Rules: the offer must carry no pipeline state (a pipelineKey with a
 * stage is already assigned — 409 ALREADY_ON_PIPELINE, move it with
 * `move-stage` instead). The target defaults to the pipeline's
 * defaultStage when `toStage` is omitted; a named stage must belong to
 * the module's pipeline or it is refused with an Italian message naming
 * the allowed stages. A move into `lost` requires a non-blank `reason`,
 * recorded as `closeReason`; `won`/`paid` close like `move-stage`, an
 * open/`renewal` target clears terminal-only fields — so Clienti,
 * Reporting and the Pipeline header read the assigned offer through the
 * same shared closed/won rule (backlog:1adf95307b31) from the first write.
 *
 * @param {{module: string}} options
 */
export function buildAssignPipelineAction({ module }) {
  return {
    module,
    name: 'assign-pipeline',
    label: 'Assign pipeline',
    description: 'Give this record the module pipeline and a stage, in one audited write.',
    actionContract: 1,
    input: [
      { name: 'toStage', type: 'string', hint: 'Target stage key from the pipeline definition; defaults to the pipeline default stage when omitted.' },
      { name: 'pipeline', type: 'string', hint: 'Optional confirmation: must name the module pipeline when supplied.' },
      { name: 'reason', type: 'string', hint: 'Required when assigning to the lost stage.' },
    ],
    /** @param {any} ctx */
    async execute({ record, input, managed, pipelines, step, now }) {
      const pipeline = pipelines.forModule(module);
      if (!pipeline) {
        throw new AppError(`No pipeline is registered for module "${module}"`, { code: 'NO_PIPELINE', status: 409 });
      }
      if (input.pipeline !== undefined && input.pipeline !== pipeline.name) {
        throw new ValidationError(
          `La pipeline "${input.pipeline}" non è quella di questo modulo: qui si assegna solo "${pipeline.name}"`,
          { field: 'pipeline', allowed: [pipeline.name] },
        );
      }
      if (record.pipelineKey && record.pipelineStage) {
        throw new AppError(
          `This record is already on pipeline "${record.pipelineKey}" (stage "${record.pipelineStage}") — move it with move-stage instead`,
          { code: 'ALREADY_ON_PIPELINE', status: 409, details: { pipelineKey: record.pipelineKey, pipelineStage: record.pipelineStage } },
        );
      }
      const targetKey = input.toStage ?? pipeline.defaultStage;
      const targetStage = findStage(pipeline, targetKey);
      if (!targetStage) {
        throw new ValidationError(
          `La fase "${targetKey}" non appartiene alla pipeline "${pipeline.name}": scegli una delle fasi: ${pipeline.stages.map((stage) => stage.key).join(', ')}`,
          { field: 'toStage', allowed: pipeline.stages.map((stage) => stage.key) },
        );
      }
      if (targetStage.type === 'lost' && !input.reason) {
        throw new ValidationError('reason is required when assigning to the lost stage', { field: 'reason' });
      }

      const timestamp = now();
      const patch = {
        pipelineKey: pipeline.name,
        pipelineStage: targetStage.key,
        stageEnteredAt: timestamp,
        ...(targetStage.type === 'open' || targetStage.type === 'renewal' ? { closedAt: null, closeReason: null } : {}),
        ...(targetStage.type === 'won' || targetStage.type === 'paid' ? { closedAt: timestamp, closeReason: null } : {}),
        ...(targetStage.type === 'lost' ? { closedAt: timestamp, closeReason: input.reason } : {}),
      };
      const updated = await managed(record.id, patch);
      step('assign', {
        pipeline: pipeline.name,
        from: null,
        to: targetStage.key,
        type: targetStage.type,
      });
      return {
        record: {
          id: updated.id,
          pipelineKey: updated.pipelineKey,
          pipelineStage: updated.pipelineStage,
          stageEnteredAt: updated.stageEnteredAt,
          closedAt: updated.closedAt,
          closeReason: updated.closeReason,
        },
        from: null,
        to: targetStage.key,
      };
    },
  };
}

/**
 * The board placement an input asks for, or null when it asks none.
 * @param {Record<string, any>} input
 * @returns {{afterId: string} | {first: true} | null}
 */
function boardPlacement(input) {
  if (typeof input.afterId === 'string' && input.afterId !== '') return { afterId: input.afterId };
  if (input.first === true) return { first: true };
  return null;
}
