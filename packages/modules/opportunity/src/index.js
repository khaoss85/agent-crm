// @ts-check

import { OpportunityService } from './opportunity-service.js';

export const opportunityModuleDefinition = Object.freeze({
  name: 'opportunity',
  version: '0.1.0',
  description: 'New-business, renewal and upsell commercial processes.',
  entities: [
    {
      name: 'opportunity',
      fields: [
        'id', 'companyId', 'contactId', 'name', 'type', 'valueCents', 'currency',
        'stage', 'owner', 'expectedCloseDate', 'createdAt', 'updatedAt',
      ],
    },
  ],
});

/** @param {{database: any, audit: any, events: any, companies: any, contacts: any}} dependencies */
export function createOpportunityModule(dependencies) {
  const service = new OpportunityService(dependencies);
  return { ...opportunityModuleDefinition, service };
}

export { OpportunityService };
