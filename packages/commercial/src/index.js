// @ts-check

import { definePackage } from '../../core/index.js';
import { CommercialRegistries } from './registry.js';
import { buildCommercialActions } from './actions.js';
import { createCatalogSync } from './catalog-sync.js';
import {
  createCommercialQuotesCapability, createCommercialQuotesVerifiedCapability, createCommercialQuoteBindingCapability,
} from './capability.js';

/**
 * The Commercial Operations domain package (ADR-016, extracted under ADR-018).
 *
 * The second legacy domain to leave the kernel. It owns the catalog (products,
 * versions, price books, offers, components, tiers, sync runs), server-priced
 * quotes with immutable versions, and versioned discount approval: fourteen
 * record modules, eight quote actions, the declared catalog providers and
 * discount policies, and two capabilities.
 *
 * **Nothing about what it prices or decides changed in the move.** That is not
 * a claim, it is the acceptance criterion: LA0-Commercial
 * (`npm run characterize:commercial`) froze every externally observable amount,
 * refusal and fingerprint before the extraction, and an asserted value that
 * moves fails the build.
 *
 * What did change is that the domain is now *optional and declared*: composed
 * by a static import in `packages/domains/generated/index.js`, never imported
 * by the kernel, reached by other packages only through `commercial-quotes@1`
 * and `commercial-quote-binding@1`.
 *
 * The one deliberate residue: catalog sync's HTTP route and app method stay
 * kernel-attached, because no package can contribute a route or an application
 * operation today. The package owns the code
 * (`createCatalogSyncOperation` below); `create-app` wires it with a single
 * named lookup, recorded as B7 seam evidence in the ExecPlan.
 */

export const COMMERCIAL_DOMAIN = 'commercial';

/**
 * The record modules this package owns. `resources` declares ownership, so a
 * second package claiming one is a startup collision. The `opportunity` a
 * quote hangs on is deliberately absent — it is the host application's record;
 * Commercial acts on it (`opportunity.create-quote`) and would be wrong to
 * claim it.
 *
 * As with Intelligence, the list names the default record modules; a project
 * that renames modules through `config` keeps the rename at the composition
 * boundary.
 */
export const COMMERCIAL_RESOURCES = Object.freeze([
  'product', 'product-version', 'price-book', 'offer', 'price-component', 'price-tier',
  'catalog-sync-run', 'quote', 'quote-line', 'quote-version', 'quote-version-line',
  'quote-version-component', 'quote-version-total', 'quote-approval',
  // Signed commercial terms (M16b prerequisite): the per-quote draft term and
  // the write-once per-version snapshot the signature document embeds.
  'quote-term', 'quote-version-term',
]);

/**
 * Build the domain definition the application composes.
 *
 * The declared definition kinds arrive the same way they always did — from
 * checked-in project source — and are validated fail-closed by the registries
 * (ADR-015/ADR-016). ADR-022 applied as Intelligence applied it: providers
 * keep the provider contract, discount policies keep the versioned
 * fingerprinted contract, and `policies` on the package stays empty because
 * the persisted identity in shipped databases (`catalog-provider`,
 * `discount-policy` rows in `definition_versions`) outranks the registry's
 * `domain-policy:commercial:<kind>` typing — see `persistFingerprints` below.
 *
 * @param {{
 *   catalogProviders?: any[], discountPolicies?: any[],
 *   config?: Record<string, string>,
 * }} [options] `config` carries the record-module renames the action builders
 *   and catalog sync already understood before the move.
 */
export function createCommercialDomain(options = {}) {
  const registries = new CommercialRegistries({
    catalogProviders: options.catalogProviders ?? [],
    discountPolicies: options.discountPolicies ?? [],
  });
  const config = options.config;

  const pkg = definePackage({
    packageContract: 1,
    name: COMMERCIAL_DOMAIN,
    // Version 2: signed commercial terms — two new resources (`quote-term`,
    // `quote-version-term`), `quote.submit` freezing the term snapshot, and
    // the additive `versionTerm` read on `commercial-quotes@1`. A package
    // version describes the composition contract, and the contract grew.
    // Every pre-existing record, action contract and capability answer is
    // byte-identical (held by the LA0-Commercial baseline).
    // 3: offers commercial-quotes@2 alongside @1 — the authoritative signed-term
    // verifier is a new required method with a stronger guarantee (ADR-036).
    version: 3,
    label: 'Commercial Operations',
    description:
      'Catalog, server-priced quotes and versioned discount approval: immutable products, offers and tiers synchronized from declared providers, quotes priced only by the server, immutable quote versions with per-component evidence, and human-decided discount approval under fingerprinted policies.',
    resources: [...COMMERCIAL_RESOURCES],
    capabilities: [
      createCommercialQuotesCapability(registries, config),
      // @2 adds the authoritative signed-term verifier; @1 stays offered
      // byte-identical for any consumer that has not migrated (ADR-036).
      createCommercialQuotesVerifiedCapability(registries, config),
      createCommercialQuoteBindingCapability(),
    ],
    actions: buildCommercialActions(config, registries),
    // Deliberately empty; see `persistFingerprints` below. The definitions ARE
    // versioned fingerprinted policies in every sense ADR-022 means, but the
    // rows that record them already exist in shipped databases under their own
    // type strings, and those rows are the immutability evidence.
    policies: [],
    /**
     * The declared application operation (ADR-032): catalog synchronization,
     * attached generically as `app.syncCatalog` — replacing the named lookup
     * `create-app` carried as recorded B7 seam residue. The run name
     * `catalog.sync` is a frozen consumer-visible value in the LA0-Commercial
     * baseline and is grandfathered explicitly (ADR-032).
     */
    operations: [
      {
        operationContract: 1,
        name: 'sync-catalog',
        label: 'Synchronize catalog',
        appMethod: 'syncCatalog',
        description:
          'Synchronize a declared catalog provider\'s normalized catalog into immutable commercial records: the provider call runs outside the write transaction, reconciliation is atomic, and a CatalogSyncRun records the evidence.',
        input: [
          { name: 'provider', type: 'string', required: true, hint: 'Registered catalog provider name.' },
        ],
        create(runtime) {
          return createCatalogSync({
            database: runtime.database,
            events: runtime.events,
            modules: runtime.modules,
            commercial: registries,
            config: { catalogTimeoutMs: runtime.config.catalogTimeoutMs },
            moduleNames: config ? {
              product: config.productModule,
              productVersion: config.productVersionModule,
              priceBook: config.priceBookModule,
              offer: config.offerModule,
              component: config.componentModule,
              tier: config.tierModule,
              syncRun: config.syncRunModule,
            } : {},
          });
        },
      },
    ],
    /** Function-free, additive schema metadata — the same block as before the move. */
    metadata() {
      return registries.metadata();
    },
  });

  /**
   * **Fingerprint persistence stays exactly where it was** — the same recorded
   * ADR-022 deviation the Intelligence extraction made, for the same reason.
   * Commercial has been writing `definition_versions` rows typed
   * `catalog-provider` and `discount-policy` since M10; handing them to the
   * package registry would write a second set of rows in every shipped
   * database, leave the originals unmatched, and silently retire the drift
   * check that makes a registered version immutable. Persisted identity
   * outranks a remapping.
   *
   * @param {any} database
   */
  pkg.persistFingerprints = (database) => registries.persistFingerprints(database);

  /** The registries, for the composition that owns this package instance. */
  pkg.registries = registries;
  return pkg;
}

export { CommercialRegistries } from './registry.js';
export { buildCommercialActions } from './actions.js';
export { createCatalogSync } from './catalog-sync.js';
export {
  createCommercialQuotesCapability, createCommercialQuotesVerifiedCapability,
  createCommercialQuoteBindingCapability, QUOTE_BINDING_FIELDS,
} from './capability.js';
