// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { profileFor } from './profile.js';
import { resolvedNames } from './store.js';

/**
 * `customer-profile@1` — the consolidated profile as a declared capability,
 * because it has a real consumer.
 *
 * The consumer is the customer-hub package: the phone-readable customer card
 * is shaped from this profile, and the hub must read it through the provider's
 * own name resolution rather than re-resolving module names from its own
 * options. A hub that resolves its own defaults while customer-data was
 * composed with remapped module names reads the wrong tables (or throws
 * `CUSTOMER_DATA_STORAGE_INVALID`) while customer-data itself works.
 *
 * Read-only by construction: it hands back the frozen profile, creates
 * nothing, and grants no write, no linking and no storage handle. The absence
 * contract is the profile's own — a package that is not composed reads
 * `available: false` with a reason, never an empty result.
 *
 * `customer-identity@1` is untouched: it answers "which records, called what",
 * this one answers "everything composed, consolidated for one record".
 */
export function createCustomerProfileCapability(config) {
  const names = resolvedNames(config);
  return {
    name: 'customer-profile',
    version: 1,
    description:
      'Read the consolidated read-only customer profile for one record across the packages the application composes. '
      + 'Creates nothing. A package that is not composed reads "not available" with a reason rather than empty.',
    /** @param {{modules?: any, consumer?: string}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('customer-profile@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      return Object.freeze({
        capabilityContract: 1,

        /**
         * The consolidated profile for one subject, read with the provider's
         * name resolution inside the caller's modules — so the read runs
         * inside the caller's transaction like any capability reach.
         * @param {{core?: any, subject: {resource: string, id: string}}} input
         */
        async readProfile({ core, subject } = {}) {
          const resource = subject?.resource;
          const id = subject?.id;
          if (typeof resource !== 'string' || typeof id !== 'string' || resource === '' || id === '') {
            throw new ValidationError('a profile read needs a subject resource and id', { field: 'id' });
          }
          return await profileFor({ modules, core, names, subject: { resource, id } });
        },
      });
    },
  };
}
