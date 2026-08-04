// @ts-check

import { ContactService } from './contact-service.js';

export const contactModuleDefinition = Object.freeze({
  name: 'contact',
  version: '0.1.0',
  description: 'People associated with companies.',
  entities: [
    {
      name: 'contact',
      fields: ['id', 'companyId', 'firstName', 'lastName', 'email', 'role', 'createdAt', 'updatedAt'],
    },
  ],
});

/** @param {{database: any, audit: any, events: any, companies: any}} dependencies */
export function createContactModule(dependencies) {
  const service = new ContactService(dependencies);
  return { ...contactModuleDefinition, service };
}

export { ContactService };
