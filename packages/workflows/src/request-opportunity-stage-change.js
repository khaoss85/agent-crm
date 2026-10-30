// @ts-check

import { enumValue, requiredString } from '../../core/src/validation.js';
import { OPPORTUNITY_STAGES } from '../../core/src/schema.js';

export const requestOpportunityStageChangeWorkflow = Object.freeze({
  name: 'request-opportunity-stage-change',
  description: 'Moves an opportunity while enforcing explicit approval policy.',
  steps: [
    {
      name: 'load-opportunity',
      async execute({ input, services, sticky }) {
        const opportunityId = requiredString(input.opportunityId, 'opportunityId');
        const targetStage = enumValue(input.targetStage, [...OPPORTUNITY_STAGES], 'targetStage');
        const opportunity = await Promise.resolve(services.opportunities.get(opportunityId));
        // The intent is pinned to the stage the FIRST attempt saw. The
        // engine reuses one `sticky` object per run() call, so an envelope
        // retry (runIdempotentWrite re-executes the whole workflow after a
        // SERIALIZABLE abort) replays this same intent instead of re-reading
        // the concurrent winner's stage and committing a second transition.
        // A retry whose pin no longer holds loses with 409 in setStage.
        let originalStage = opportunity.stage;
        if (sticky !== null && typeof sticky === 'object') {
          if (sticky.originalStage === undefined) sticky.originalStage = opportunity.stage;
          originalStage = sticky.originalStage;
        }
        return { opportunity, opportunityId, targetStage, originalStage };
      },
    },
    {
      name: 'evaluate-commercial-policy',
      execute({ state, config }) {
        const thresholdCents = Number(config.approvalThresholdCents ?? 5_000_000);
        const requiresApproval =
          state.targetStage === 'proposal' &&
          state.opportunity.type === 'renewal' &&
          state.opportunity.valueCents >= thresholdCents;
        return {
          policy: {
            requiresApproval,
            thresholdCents,
            reason: requiresApproval
              ? `Renewal value ${state.opportunity.valueCents} cents meets approval threshold ${thresholdCents} cents.`
              : 'No approval policy matched.',
          },
        };
      },
    },
    {
      name: 'apply-stage-policy',
      async execute({ state, services, database, actor, runId }) {
        // The intent is pinned to the stage load-opportunity saw: a retry or
        // a concurrent winner must not re-base this request onto the new
        // stage (two terminal changes would commit twice). setStage reports
        // 409 when the pin no longer holds.
        return database.transactionAsync(async () => {
          if (!state.policy.requiresApproval) {
            const opportunity = await services.opportunities.setStage(
              state.opportunityId,
              state.targetStage,
              { actor, workflowRunId: runId, expectedFromStage: state.originalStage },
            );
            return { opportunity, approval: null, outcome: 'stage_changed' };
          }

          const opportunity = await services.opportunities.setStage(
            state.opportunityId,
            'approval_pending',
            { actor, workflowRunId: runId, expectedFromStage: state.originalStage },
          );
          const approval = await services.approvals.request(
            { opportunityId: state.opportunityId, reason: state.policy.reason },
            { actor, workflowRunId: runId },
          );
          return { opportunity, approval, outcome: 'approval_required' };
        });
      },
    },
  ],
});
