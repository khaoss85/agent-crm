// @ts-check

import { CompanyService } from './company-service.js';

export const companyModuleDefinition = Object.freeze({
  name: 'company',
  version: '0.1.0',
  description: 'Organizations and accounts.',
  entities: [
    {
      name: 'company',
      fields: ['id', 'name', 'domain', 'createdAt', 'updatedAt'],
    },
  ],
});

/** @param {{database: any, audit: any, events: any}} dependencies */
export function createCompanyModule(dependencies) {
  const service = new CompanyService(dependencies);
  return { ...companyModuleDefinition, service };
}

export { CompanyService };
