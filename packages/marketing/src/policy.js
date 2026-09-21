// @ts-check

import {
  ValidationError,
  NotFoundError,
  createDefinitionVersionStore,
  computeDefinitionFingerprint,
  validateDeclaredConfig,
} from '../../core/index.js';
import { PROPOSAL_CHANNELS, PROPOSAL_MODES } from './proposal.js';

/**
 * The versioned proposal policy (MK1).
 *
 * One policy kind — `proposal-policy` — naming which sections a proposal must
 * state and which channels and modes it may name. Versioned and fingerprinted
 * on the hardened declared-definition mechanism (ADR-015): Map-backed
 * per-app registries, fail-closed startup, strict canonical fingerprints over
 * name + version + declared JSON-safe config, persisted in
 * `definition_versions` inside one transaction. Metadata is function-free.
 *
 * What this policy deliberately does NOT carry: providers. MK1 contacts no
 * provider by any path, so there is no provider registry to declare, install
 * or misconfigure. The provider rationale a proposal states is prose a human
 * reads, not a handle the runtime resolves.
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_LABEL = 80;
const MAX_VERSION = 1_000_000;

/** @param {any} definition */
export function defineProposalPolicy(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('proposal policy definition must be an object');
  }
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ValidationError(`proposal policy "${String(definition.name)}": name must match ${NAME_RE}`);
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1 || definition.version > MAX_VERSION) {
    throw new ValidationError(`proposal policy "${definition.name}": version must be a positive integer (1–${MAX_VERSION})`);
  }
  if (definition.label !== undefined && (typeof definition.label !== 'string' || definition.label.length === 0 || definition.label.length > MAX_LABEL)) {
    throw new ValidationError(`proposal policy "${definition.name}": label must be a non-empty string of at most ${MAX_LABEL} characters`);
  }
  validateDeclaredConfig(`proposal policy "${definition.name}@${definition.version}"`, definition.config);
  const config = definition.config ?? {};
  if (config.allowedChannels !== undefined) {
    if (!Array.isArray(config.allowedChannels) || config.allowedChannels.length === 0
      || config.allowedChannels.some((channel) => !PROPOSAL_CHANNELS.includes(channel))) {
      throw new ValidationError(`proposal policy "${definition.name}": allowedChannels must be a non-empty subset of ${PROPOSAL_CHANNELS.join(', ')}`);
    }
  }
  if (config.allowedModes !== undefined) {
    if (!Array.isArray(config.allowedModes) || config.allowedModes.length === 0
      || config.allowedModes.some((mode) => !PROPOSAL_MODES.includes(mode))) {
      throw new ValidationError(`proposal policy "${definition.name}": allowedModes must be a non-empty subset of ${PROPOSAL_MODES.join(', ')}`);
    }
  }
  return definition;
}

/**
 * @param {string} type
 * @param {{definition: {name: string, version: number}, fingerprint: string}} entry
 */
function identity(type, entry) {
  return {
    type,
    name: entry.definition.name,
    version: entry.definition.version,
    fingerprint: entry.fingerprint,
  };
}

/** Per-app marketing registries; one malformed definition stops startup. */
export class MarketingRegistries {
  /** @param {{proposalPolicies?: any[]}} [definitions] */
  constructor(definitions = {}) {
    /** @type {Map<string, any>} */
    this.proposalPolicies = new Map();

    for (const definition of definitions.proposalPolicies ?? []) {
      defineProposalPolicy(definition);
      const key = `${definition.name}@${definition.version}`;
      if (this.proposalPolicies.has(key)) {
        throw new ValidationError(`Duplicate proposal policy identity: ${key}`);
      }
      this.proposalPolicies.set(key, {
        definition,
        fingerprint: computeDefinitionFingerprint({
          type: 'proposal-policy',
          name: definition.name,
          version: definition.version,
          config: definition.config ?? null,
        }),
      });
    }
  }

  /** @param {string} name @param {number} version — returns {definition, fingerprint} */
  getProposalPolicy(name, version) {
    const entry = this.proposalPolicies.get(`${name}@${version}`);
    if (!entry) throw new NotFoundError('Proposal policy', `${name}@${version}`);
    return entry;
  }

  /**
   * Persist-or-verify every identity in definition_versions, in one
   * transaction (ADR-015 semantics: drift under a registered version throws).
   * @param {any} database
   */
  persistFingerprints(database) {
    createDefinitionVersionStore(database).persist([
      ...[...this.proposalPolicies.values()].map((entry) => identity('proposal-policy', entry)),
    ]);
  }

  /** Serializable, function-free metadata for /api/schema. */
  metadata() {
    return {
      marketingContract: 1,
      notModeled: ['sending', 'publishing', 'spending', 'audience execution', 'consent validation', 'provider installation', 'scheduling', 'attribution'],
      proposalPolicyContract: 1,
      channels: [...PROPOSAL_CHANNELS],
      modes: [...PROPOSAL_MODES],
      externalEffects: 'none: this package contacts no provider, sends nothing, publishes nothing and spends nothing',
      proposalPolicies: [...this.proposalPolicies.values()]
        .sort((a, b) => (a.definition.name === b.definition.name
          ? a.definition.version - b.definition.version
          : a.definition.name < b.definition.name ? -1 : 1))
        .map(({ definition, fingerprint }) => ({
          name: definition.name,
          version: definition.version,
          label: definition.label ?? definition.name,
          fingerprint,
        })),
    };
  }
}
