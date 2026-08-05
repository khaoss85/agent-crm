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
 * Transition rules this milestone: open → open, open → won, open → lost.
 * No moves out of won/lost (409 TERMINAL_STAGE), no same-stage moves
 * (409 SAME_STAGE — a stale double-submit must be visible, not a silent
 * no-op), no reopen. `fromStage`, when supplied, is an optimistic-concurrency
 * check (mismatch → 409 STALE_STAGE). A move to the lost stage requires a
 * non-blank `reason`, recorded as `closeReason`.
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
    ],
    /** @param {any} ctx */
    async execute({ record, input, managed, pipelines, step, now }) {
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
      if (currentStage.type !== 'open') {
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
        // Coherence is enforced, not assumed: an open stage never carries
        // terminal-only fields (a corrupt out-of-band closedAt is cleared on
        // the next legitimate open move), won never carries a lost reason,
        // and a reason supplied for a non-lost target is deliberately ignored.
        ...(targetStage.type === 'open' ? { closedAt: null, closeReason: null } : {}),
        ...(targetStage.type === 'won' ? { closedAt: timestamp, closeReason: null } : {}),
        ...(targetStage.type === 'lost' ? { closedAt: timestamp, closeReason: input.reason } : {}),
      };
      const updated = await managed(record.id, patch);
      step('transition', {
        pipeline: pipeline.name,
        from: currentStage.key,
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
        from: currentStage.key,
        to: targetStage.key,
      };
    },
  };
}
