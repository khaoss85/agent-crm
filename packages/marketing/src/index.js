// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
import { MarketingRegistries } from './policy.js';
import { buildMarketingActions } from './actions.js';
import { createMarketingProposalsCapability } from './capability.js';

/**
 * The Marketing domain package (MK1 — Funnel Insight + Campaign Proposal).
 *
 * It owns the funnel observation primitives (definition, run, drop insight),
 * the campaign proposal with its immutable versions, the versioned proposal
 * policy and the observation and plan-then-approve record actions. An agent observes a
 * bounded funnel insight and prepares a complete CampaignProposal in Admin.
 *
 * **Nothing is sent, published or spent.** That is not a slogan, it is the
 * acceptance criterion: this package declares no provider, holds no
 * credential, opens no socket and reaches no table outside its own five
 * resources. The provider rationale a proposal states is prose a human reads,
 * never a handle the runtime resolves — so "no provider is contacted by any
 * path" holds structurally, not by discipline.
 *
 * What this package does NOT do, deliberately: audiences and snapshots,
 * consent and suppression, sending of any kind, content assets and landing
 * pages, journeys, experiments, paid media, attribution. Those are MK2–MK7,
 * each its own package, each its own approval.
 *
 * Composition is one static import in `packages/domains/generated/index.js`
 * (a project that does not want marketing removes the line and keeps working);
 * the kernel never imports this package.
 */

export const MARKETING_DOMAIN = 'marketing';

/** The record modules this package owns. `resources` declares ownership, so a second package claiming one is a startup collision. */
export const MARKETING_RESOURCES = Object.freeze([
  'funnel-definition', 'funnel-run', 'funnel-drop-insight',
  'campaign-proposal', 'campaign-version',
]);

/** The policy kind this package versions. */
export const PROPOSAL_POLICY_KIND = 'proposal-policy';

/**
 * Build the domain definition the application composes.
 *
 * @param {{proposalPolicies?: any[], config?: Record<string, string>}} [options]
 *   `proposalPolicies` are proposal policy definitions (validated here);
 *   `config` carries record-module renames.
 */
export function createMarketingDomain(options = {}) {
  const registries = new MarketingRegistries({
    proposalPolicies: options.proposalPolicies ?? [],
  });
  const config = options.config;

  const pkg = definePackage({
    packageContract: 1,
    name: MARKETING_DOMAIN,
    // 1: MK1 — funnel insight plus proposal planning with approval locked to
    // human actors. A package version describes the composition contract.
    version: 1,
    label: 'Marketing proposals',
    description:
      'Funnel insight and campaign proposals with human approval: bounded funnel observations with derived drop insights, complete-or-refused campaign proposals under a versioned policy, and immutable approved versions. Sends, publishes and spends nothing.',
    resources: [...MARKETING_RESOURCES],
    capabilities: [
      createMarketingProposalsCapability(config),
    ],
    actions: buildMarketingActions(registries, config),
    policies: (options.proposalPolicies ?? []).map((definition) => ({
      kind: PROPOSAL_POLICY_KIND,
      definition,
    })),
    /** Function-free, additive schema metadata — the registries own the shape. */
    metadata() {
      return registries.metadata();
    },
  });

  /**
   * Fingerprint persistence for the declared proposal policies
   * (ADR-015 semantics: drift under a registered version stops the next boot).
   * @param {any} database
   */
  pkg.persistFingerprints = (database) => registries.persistFingerprints(database);

  /** The registries, for the composition that owns this package instance. */
  pkg.registries = registries;
  return selectPackageGraph(pkg, options.packageContract === 2 ? 2 : 1);
}

/** Distinct awaited contract-2 graph. Existing `createMarketingDomain()` callers keep v1. */
export function createMarketingDomainV2(options = {}) {
  return createMarketingDomain({ ...options, packageContract: 2 });
}

export { MarketingRegistries, defineProposalPolicy } from './policy.js';
export { buildMarketingActions, buildProposeAction, buildApproveAction } from './actions.js';
export { createMarketingProposalsCapability } from './capability.js';
export { deriveDropInsight } from './funnel.js';
export {
  reviewProposal, approveProposal,
  REQUIRED_PROPOSAL_SECTIONS, PROPOSAL_CHANNELS, PROPOSAL_MODES,
} from './proposal.js';
