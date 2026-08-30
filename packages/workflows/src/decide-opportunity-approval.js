// @ts-check

import { ConflictError, ValidationError } from '../../core/src/errors.js';
import { enumValue, requiredString } from '../../core/src/validation.js';

export const decideOpportunityApprovalWorkflow = Object.freeze({
  name: 'decide-opportunity-approval',
  description: 'Records a human approval decision and applies the resulting opportunity stage.',
  steps: [
    {
      name: 'load-approval',
      async execute({ input, services }) {
        const approvalId = requiredString(input.approvalId, 'approvalId');
        const decision = enumValue(input.decision, ['approved', 'rejected'], 'decision');
        const approval = await Promise.resolve(services.approvals.get(approvalId));
        const opportunity = await Promise.resolve(services.opportunities.get(approval.opportunityId));
        if (opportunity.stage !== 'approval_pending') {
          throw new ConflictError('The opportunity is no longer awaiting approval.', {
            opportunityId: opportunity.id,
            stage: opportunity.stage,
          });
        }
        return { approvalId, decision, approval, opportunity };
      },
    },
    {
      name: 'validate-human-decision',
      execute({ state, actor }) {
        if (!actor || actor.type !== 'user' || typeof actor.id !== 'string' || !actor.id.trim()) {
          throw new ValidationError('Approval decisions require an explicit human actor.');
        }
        return { targetStage: state.decision === 'approved' ? 'proposal' : 'qualification' };
      },
    },
    {
      name: 'apply-decision',
      async execute({ state, services, database, actor, runId }) {
        return database.transactionAsync(async () => {
          const approval = await services.approvals.decide(
            state.approvalId,
            state.decision,
            { actor, workflowRunId: runId },
          );
          const opportunity = await services.opportunities.setStage(
            approval.opportunityId,
            state.targetStage,
            { actor, workflowRunId: runId },
          );
          return { approval, opportunity, outcome: state.decision };
        });
      },
    },
  ],
});
