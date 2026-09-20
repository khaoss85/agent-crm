// @ts-check

import { AppError } from '../../core/index.js';

/**
 * What Marketing offers to **other packages** — one read-only capability,
 * sized by its measured real consumers: none yet (MK1 proposes; nothing
 * downstream consumes a proposal until MK2 sends one).
 *
 * `marketing-proposals@1` reads a proposal and its immutable version evidence
 * inside the caller's transaction. The rows are returned as stored, frozen:
 * the column shapes ARE the contract a consumer copies without interpreting.
 * It grants no proposal write, no approval, no provider access and no storage
 * handle — there is no provider access to grant.
 */

/** @param {any} modules @param {string} name */
function service(modules, name) {
  const module = modules.get(name);
  if (!module?.service) {
    throw new AppError(`The marketing package is installed without its "${name}" records`, {
      code: 'MARKETING_STORAGE_INVALID', status: 500,
    });
  }
  return module.service;
}

function mapValue(value, map) {
  return value && typeof value.then === 'function' ? value.then(map) : map(value);
}

function missingOnly(error) {
  if (error?.code !== 'NOT_FOUND') throw error;
  return null;
}

/** Exact primary-key read; infrastructure failures remain failures. */
function safeGet(recordService, id) {
  try {
    const value = recordService.get(id);
    return value && typeof value.then === 'function' ? value.catch(missingOnly) : value;
  } catch (error) {
    return missingOnly(error);
  }
}

/** @param {any} modules */
function requireModules(context, capability) {
  const modules = context?.modules;
  if (!modules || typeof modules.get !== 'function') {
    throw new AppError(`${capability} requires the caller's modules view`, {
      code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
    });
  }
  return modules;
}

/**
 * `marketing-proposals@1` — read-only proposal and campaign-version evidence.
 *
 * @param {Record<string, string>} [config] module renames
 */
export function createMarketingProposalsCapability(config) {
  const names = {
    proposal: config?.proposalModule ?? 'campaign-proposal',
    version: config?.versionModule ?? 'campaign-version',
    insight: config?.insightModule ?? 'funnel-drop-insight',
  };
  return {
    name: 'marketing-proposals',
    version: 1,
    description:
      'Read a campaign proposal and its immutable campaign-version evidence plus the funnel-drop insight it answers. Grants no proposal write, no approval, no provider access and no storage handle.',
    /** @param {{modules?: any, consumer?: string}} context */
    create(context = {}) {
      const modules = requireModules(context, 'marketing-proposals@1');
      return {
        capabilityContract: 1,

        /** One proposal row, or null. @param {string} proposalId */
        proposal(proposalId) {
          const record = typeof proposalId === 'string' && proposalId !== '' ? safeGet(service(modules, names.proposal), proposalId) : null;
          return mapValue(record, row => row ? Object.freeze({ ...row }) : null);
        },

        /** Every version of one proposal, version-ordered. @param {string} proposalId */
        proposalVersions(proposalId) {
          if (typeof proposalId !== 'string' || proposalId === '') return Object.freeze([]);
          return mapValue(service(modules, names.version).listWhere({ proposalId }), rows => Object.freeze(rows
            .sort((a, b) => (a.versionNumber === b.versionNumber ? (a.id < b.id ? -1 : 1) : a.versionNumber - b.versionNumber))
            .map((row) => Object.freeze({ ...row }))));
        },

        /** One funnel-drop insight row, or null. @param {string} insightId */
        insight(insightId) {
          const record = typeof insightId === 'string' && insightId !== '' ? safeGet(service(modules, names.insight), insightId) : null;
          return mapValue(record, row => row ? Object.freeze({ ...row }) : null);
        },
      };
    },
  };
}
