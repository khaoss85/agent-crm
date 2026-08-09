// @ts-check

import { definePackage } from '../../core/index.js';
import { IntelligenceRegistries } from './registry.js';
import { buildEnrichAction, buildRecordSignalAction, buildScoreAction, buildRouteAction } from './actions.js';
import { createIntelligenceCapability } from './capability.js';

/**
 * The Lead Intelligence domain package.
 *
 * This is the oldest domain in the repository and the first legacy one to move
 * out of `packages/core`. It owns enrichment, behavioural signals, explainable
 * versioned scoring, routing and assignment: its seven record modules, its four
 * actions, its declared definitions and the `intelligence@1` capability.
 *
 * **Nothing about what it decides changed in the move.** That is not a claim,
 * it is the acceptance criterion: LA0 (`npm run characterize:intelligence`)
 * froze every externally observable decision before the extraction, and an
 * asserted value that moves fails the build.
 *
 * What did change is that the domain is now *optional and declared*. It is
 * composed by a static import in `packages/domains/generated/index.js`, the
 * kernel never imports it, and a consumer reaches it by declaring
 * `intelligence@1` rather than by finding it on the application object.
 *
 * What this package does NOT do, deliberately: it does not own the Lead. Its
 * actions target the **project-owned** `lead` record, which is a host-record
 * dependency and not a package dependency — see `resources` below.
 */

export const INTELLIGENCE_DOMAIN = 'intelligence';

/**
 * The record modules this package owns. The Lead is deliberately absent.
 *
 * `resources` declares what the package *owns*, so a second package claiming
 * one is a startup collision. Lead is not listed because Lead is the project's
 * record: Intelligence acts **on** it, writes its managed fields through the
 * action runtime, and would be wrong to claim it. A project can have a Lead
 * without Intelligence, and removing the package leaves the Lead intact.
 */
export const INTELLIGENCE_RESOURCES = Object.freeze([
  'enrichment-snapshot', 'behavioral-signal', 'score-run', 'score-contribution',
  'routing-run', 'route-evaluation', 'assignment',
]);

/**
 * Build the domain definition the application composes.
 *
 * The four declared definition kinds arrive the same way they always did —
 * from checked-in project source — and are validated fail-closed by the
 * registries. ADR-022: providers keep the provider contract, scoring models and
 * routing policies keep the versioned fingerprinted policy contract, and
 * routing targets are declared configuration of the routing capability rather
 * than a definition kind or a managed resource, because nothing mutates them.
 *
 * @param {{
 *   enrichmentProviders?: any[], scoringModels?: any[],
 *   routingPolicies?: any[], routingTargets?: any[],
 *   config?: {module?: string, timeoutMs?: number} & Record<string, string|number>,
 * }} [options] `config` is the same builder configuration the starter passed
 *   before the move — record-module renames and the enrichment timeout.
 */
export function createIntelligenceDomain(options = {}) {
  const registries = new IntelligenceRegistries({
    enrichmentProviders: options.enrichmentProviders ?? [],
    scoringModels: options.scoringModels ?? [],
    routingPolicies: options.routingPolicies ?? [],
    routingTargets: options.routingTargets ?? [],
  });

  const pkg = definePackage({
    packageContract: 1,
    name: INTELLIGENCE_DOMAIN,
    version: 1,
    label: 'Lead Intelligence',
    description:
      'Enriches leads from declared providers, records behavioural signals, scores them with explainable versioned models and routes them to declared targets — every decision carrying the fingerprint of the definition that made it.',
    resources: [...INTELLIGENCE_RESOURCES],
    capabilities: [createIntelligenceCapability(registries)],
    actions: [
      buildEnrichAction(options.config, registries),
      buildRecordSignalAction(options.config, registries),
      buildScoreAction(options.config, registries),
      buildRouteAction(options.config, registries),
    ],
    // Deliberately empty; see `persistFingerprints` below. The definitions ARE
    // versioned fingerprinted policies in every sense ADR-022 means, but the
    // rows that record them already exist in shipped databases under their own
    // type strings, and those rows are the immutability evidence.
    policies: [],
    /** Function-free, additive schema metadata — the same block as before the move. */
    metadata() {
      return registries.metadata();
    },
  });

  /**
   * **Fingerprint persistence stays exactly where it was, and this is the one
   * place the extraction deliberately departs from ADR-022's literal wording.**
   *
   * ADR-022 says scoring models and routing policies use the `policies`
   * contract. That is right about the *contract* — versioned, fingerprinted,
   * declared config — and silent about the *persisted identity*. The package
   * registry writes `definition_versions` rows typed
   * `domain-policy:intelligence:<kind>`; Intelligence has been writing
   * `scoring-model`, `routing-policy` and `enrichment-provider` since M9.
   *
   * Handing them to the registry would write a second set of rows in every
   * shipped database, leave the original rows unmatched, and silently retire
   * the drift check that makes a registered version immutable. An existing
   * database would boot and lose a guarantee, which is the worst available
   * outcome.
   *
   * So the package keeps its own persistence with the original type strings.
   * Persisted identity outranks a mapping decided before anyone looked at the
   * rows, and the deviation is recorded here rather than discovered later.
   *
   * @param {any} database
   */
  pkg.persistFingerprints = (database) => registries.persistFingerprints(database);
  /** The registries, for the composition that owns this package instance. */
  pkg.registries = registries;
  return pkg;
}

export { IntelligenceRegistries } from './registry.js';
export { buildEnrichAction, buildRecordSignalAction, buildScoreAction, buildRouteAction } from './actions.js';
export { ENRICHMENT_CAPABILITIES, ROUTING_TARGET_KINDS } from './registry.js';
