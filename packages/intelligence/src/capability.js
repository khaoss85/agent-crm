// @ts-check

import { AppError } from '../../core/index.js';

/**
 * `intelligence@1` — what this package offers to **other packages**, and the
 * thing ADR-021 exists to create.
 *
 * Before the extraction, the registries were an ambient field on the
 * application object. Every action received them whether or not it declared
 * anything, and a custom package could never obtain the same access, which is
 * the equality `docs/PACKAGE_AUTHORING.md` §14 promises. A consumer now
 * declares `intelligence@1` in `requires` and opens it, and the dependency is
 * an edge `crm app inspect` reports and `crm package test` enforces.
 *
 * The capability is deliberately **read-only over declared definitions**. It
 * exposes what a consumer needs to reason about scoring and routing — which
 * models exist, at which version, with which fingerprint — and no way to
 * register a definition, reach a record or open a transaction. A consumer that
 * wants to score a lead calls the action; it does not get the storage.
 */

/** @param {any} registries the package's own IntelligenceRegistries instance */
export function createIntelligenceCapability(registries) {
  return {
    name: 'intelligence',
    version: 1,
    description:
      'Read the declared enrichment providers, scoring models, routing policies and routing targets, with their versions and declared-definition fingerprints. Grants no registration, no storage access and no evaluation of another package\'s records.',
    create() {
      if (!registries) {
        throw new AppError('intelligence@1 was opened without its registries', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      return {
        capabilityContract: 1,

        /** Every declared definition, function-free and safe to serialize. */
        definitions() {
          return registries.metadata();
        },

        /**
         * One scoring model's identity, or null. The fingerprint is what makes
         * a past decision explainable, so it travels with the version.
         * @param {string} name @param {number} version
         */
        scoringModel(name, version) {
          const entry = registries.metadata().scoringModels
            .find((/** @type {any} */ model) => model.name === name && model.version === version);
          return entry ?? null;
        },

        /**
         * One routing policy's identity, or null.
         * @param {string} name @param {number} version
         */
        routingPolicy(name, version) {
          const entry = registries.metadata().routingPolicies
            .find((/** @type {any} */ policy) => policy.name === name && policy.version === version);
          return entry ?? null;
        },

        /**
         * The declared routing targets and the fingerprint of the whole set.
         *
         * ADR-022: targets are declared configuration, not a managed resource —
         * nothing mutates them at runtime, and `capacity` is a declared ceiling
         * whose moving half is counted from Lead records at decision time. The
         * set fingerprint is what a RoutingRun records, so it is offered
         * alongside rather than derived by the consumer.
         */
        routingTargets() {
          const metadata = registries.metadata();
          return { targets: metadata.routingTargets, fingerprint: metadata.routingTargetsFingerprint };
        },
      };
    },
  };
}
