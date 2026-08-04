// @ts-check

import { ApprovalService } from './approval-service.js';

export const approvalModuleDefinition = Object.freeze({
  name: 'approval',
  version: '0.1.0',
  description: 'Human decisions required by explicit commercial policies.',
  entities: [
    {
      name: 'approval',
      fields: [
        'id', 'opportunityId', 'status', 'reason', 'requestedBy', 'decidedBy',
        'requestedAt', 'decidedAt',
      ],
    },
  ],
});

/** @param {{database: any, audit: any, events: any, opportunities: any}} dependencies */
export function createApprovalModule(dependencies) {
  const service = new ApprovalService(dependencies);
  return { ...approvalModuleDefinition, service };
}

export { ApprovalService };
