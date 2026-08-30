// @ts-check

import { enumValue, requiredString } from '../../core/src/validation.js';
import { OPPORTUNITY_STAGES } from '../../core/src/schema.js';

export const requestOpportunityStageChangeWorkflow = Object.freeze({
  name: 'request-opportunity-stage-change',
  description: 'Moves an opportunity while enforcing explicit approval policy.',
  steps: [
    {
      name: 'load-opportunity',
      async execute({ input, services }) {
        const opportunityId = requiredString(input.opportunityId, 'opportunityId');
        const targetStage = enumValue(input.targetStage, [...OPPORTUNITY_STAGES], 'targetStage');
        const opportunity = await Promise.resolve(services.opportunities.get(opportunityId));
        return { opportunity, opportunityId, targetStage, originalStage: opportunity.stage };
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
        return database.transactionAsync(async () => {
          if (!state.policy.requiresApproval) {
            const opportunity = await services.opportunities.setStage(
              state.opportunityId,
              state.targetStage,
              { actor, workflowRunId: runId },
            );
            return { opportunity, approval: null, outcome: 'stage_changed' };
          }

          const opportunity = await services.opportunities.setStage(
            state.opportunityId,
            'approval_pending',
            { actor, workflowRunId: runId },
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
