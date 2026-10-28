// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
import { CommercialRegistries } from './registry.js';
import { buildCommercialActions } from './actions.js';
import { createCatalogSync } from './catalog-sync.js';
import { createManualCatalog } from './manual-catalog.js';
import { createProductImport, openProductImportLlm } from './product-import.js';
import {
  createCommercialQuotesVerifiedAsyncCapability,
  createCommercialQuotesVerifiedCapability, createCommercialQuoteBindingCapability,
} from './capability.js';
import { createPackageCreditsCapability } from './package-credits.js';

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
 * by the kernel, reached by other packages only through `commercial-quotes@2`
 * and `commercial-quote-binding@1` (`commercial-quotes@1` retired: every
 * consumer moved to the integrity-verifying contract).
 *
 * The one deliberate residue: catalog sync's HTTP route and app method stay
 * kernel-attached, because no package can contribute a route or an application
 * operation today. The package owns the code
 * (`createCatalogSyncOperation` below); `create-app` wires it with a single
 * named lookup, recorded as B7 seam evidence in the ExecPlan.
 */

export const COMMERCIAL_DOMAIN = 'commercial';

/**
 * Build the product-import helper for an operation runtime, honoring the
 * record-module renames the package accepts at its composition boundary.
 * The AI extraction runs through the handed-over llm-complete@1 handle;
 * without the handover the AI source refuses and the manual source works.
 */
function importFor(runtime, config, llmCapability) {
  const helper = createProductImport({
    database: runtime.database,
    events: runtime.events,
    modules: runtime.modules,
    moduleNames: config ? {
      product: config.productModule,
      productVersion: config.productVersionModule,
      priceBook: config.priceBookModule,
      offer: config.offerModule,
      component: config.componentModule,
      tier: config.tierModule,
      productImport: config.productImportModule,
      productImportRow: config.productImportRowModule,
    } : {},
  });
  return {
    // The llm handover opens lazily and only for the AI source: a
    // composition without llm still boots and runs manual imports.
    startImport: (input, actor) => {
      const record = input && typeof input === 'object' ? input : {};
      if (record.source !== 'ai') return helper.startImport(input, actor);
      const opened = openProductImportLlm(llmCapability ?? null, runtime);
      return helper.startImport(input, actor, opened ? {
        complete: ({ messages, maxTokens }) => opened.complete({
          actor, spaceId: record.spaceId, purpose: 'suggest', messages, maxTokens,
        }),
      } : {});
    },
    confirmRow: (input, actor) => helper.confirmRow(input, actor),
    rejectRow: (input, actor) => helper.rejectRow(input, actor),
    readImport: (input) => helper.readImport(input),
  };
}

/**
 * Build the manual-catalog helper for an operation runtime, honoring the
 * record-module renames the package accepts at its composition boundary.
 */
function manualFor(runtime, config) {
  return createManualCatalog({
    database: runtime.database,
    events: runtime.events,
    modules: runtime.modules,
    moduleNames: config ? {
      product: config.productModule,
      productVersion: config.productVersionModule,
      priceBook: config.priceBookModule,
      offer: config.offerModule,
      component: config.componentModule,
      tier: config.tierModule,
    } : {},
  });
}

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
  'catalog-sync-run', 'product-import', 'product-import-row',
  'quote', 'quote-line', 'quote-version', 'quote-version-line',
  'quote-version-component', 'quote-version-total', 'quote-approval',
  // Signed commercial terms (M16b prerequisite): the per-quote draft term and
  // the write-once per-version snapshot the signature document embeds.
  'quote-term', 'quote-version-term',
  // Package credits: one paid grant of N entries per row, scaled by the
  // appointments that happened. The balance is computed from the stored
  // appointment rows, so this resource holds grants only, never a counter.
  'package-credit',
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
 *   config?: Record<string, string>, llm?: { capabilities?: Array<any> },
 * }} [options] `config` carries the record-module renames the action builders
 *   and catalog sync already understood before the move. `llm` is the
 *   composed llm package definition (handover, optional): the AI product
 *   import opens its `llm-complete@1` capability from it, and a composition
 *   without it still boots and runs manual imports.
 */
export function createCommercialDomain(options = {}) {
  const registries = new CommercialRegistries({
    catalogProviders: options.catalogProviders ?? [],
    discountPolicies: options.discountPolicies ?? [],
  });
  const config = options.config;
  // The handed-over llm package definition, like the appointments handover:
  // the created capability object is held by reference and opened per
  // runtime, so a remapped composition cannot silently swap the extractor.
  const llmCapability = Array.isArray(options.llm?.capabilities)
    ? options.llm.capabilities.find((entry) => entry?.name === 'llm-complete' && entry?.version === 1) ?? null
    : null;
  if (options.llm !== undefined && options.llm !== null && llmCapability === null) {
    throw new AppError(
      'The commercial package needs the llm package capability llm-complete@1: '
      + 'hand over the composed llm package definition, e.g. createCommercialDomain({ llm }) beside createLlmPackage()',
      { code: 'PACKAGE_DEPENDENCY_MISMATCH', status: 409 },
    );
  }

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
    // 4: retires commercial-quotes@1 — every in-repo consumer reads through
    // @2, and the registry refuses a @1 requirement naming the consumer, so
    // the composition contract shrank by one offered capability.
    // 5: offers package-credits@1 alongside the quote capabilities — one paid
    // grant of N entries per row plus the balance computed from the stored
    // appointment rows. Additive: every pre-existing record, action contract
    // and capability answer is byte-identical (held by the LA0-Commercial
    // baseline, regenerated for the new files only).
    // 6: manual catalog operations (BO-F2-05) — create/update/reprice/
    // activate manual products plus the product-table read. Additive:
    // provider sync, quotes and capabilities are untouched.
    // 7: product import drafts (BO-F2-07) — an import from a document or
    // typed by hand persists pending draft rows confirmed one by one; the
    // AI extraction drafts through the handed-over llm-complete@1 handle
    // and stays off without it. Additive: manual writes and reads are
    // untouched.
    version: 7,
    label: 'Commercial Operations',
    description:
      'Catalog, server-priced quotes and versioned discount approval: immutable products, offers and tiers synchronized from declared providers, quotes priced only by the server, immutable quote versions with per-component evidence, and human-decided discount approval under fingerprinted policies.',
    resources: [...COMMERCIAL_RESOURCES],
    capabilities: [
      // @2 carries the authoritative signed-term verifier every consumer of
      // signed terms must call (ADR-036); @1 is retired, its reads embedded
      // byte-identically in @2's base. The contract-2 graph offers the awaited
      // twin instead: same name and version, every storage read awaited, so a
      // published synchronous contract never changes shape.
      (options.packageContract === 2
        ? createCommercialQuotesVerifiedAsyncCapability(registries, config)
        : createCommercialQuotesVerifiedCapability(registries, config)),
      createCommercialQuoteBindingCapability(),
      // Package credits: grants plus the balance read from the appointment
      // rows. No `requires` edge on appointments by design — see
      // package-credits.js: the appointment read is optional through the
      // caller's modules view, and absence answers available:false.
      createPackageCreditsCapability({
        moduleNames: {
          credit: config?.creditModule,
          appointment: config?.appointmentModule,
        },
      }),
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
      {
        operationContract: 1,
        name: 'create-manual-product',
        label: 'Create manual product',
        appMethod: 'createManualProduct',
        description:
          'Create a manually managed product with its prices, without any provider: product, version 1 and one offer revision 1 per declared offer, in one transaction.',
        input: [
          { name: 'sku', type: 'string', required: true, hint: 'Product code shown in the backoffice table.' },
          { name: 'name', type: 'string', required: true, hint: 'Product name.' },
          { name: 'currency', type: 'string', required: true, hint: 'Uppercase three-letter currency code.' },
          { name: 'priceBookId', type: 'string', required: false, hint: 'Manual price book id; omitted finds or creates the manual book of the currency.' },
          { name: 'offers', type: 'json', required: false, hint: 'Offer list with price components; or shorthand components for one offer.' },
          { name: 'unit', type: 'string', required: false, hint: 'Backoffice row unit ("a corpo", "ml", "m²"); null when the row shows none.' },
          { name: 'maxDiscountBps', type: 'json', required: false, hint: 'Backoffice "sconto max" ceiling in basis points (1000 = 10%); null for no ceiling.' },
          { name: 'stockQuantity', type: 'json', required: false, hint: 'Backoffice stock count; null means a service with no stock to count.' },
        ],
        create(runtime) {
          const manual = manualFor(runtime, config);
          return (input, actor) => manual.createProduct(input, actor);
        },
      },
      {
        operationContract: 1,
        name: 'update-manual-product',
        label: 'Update manual product',
        appMethod: 'updateManualProduct',
        description:
          'Edit a manually managed product description (sku, name, description, category, unit, maxDiscountBps, stockQuantity): opens version n+1, never rewrites. Provider-owned products refuse.',
        input: [
          { name: 'productId', type: 'string', required: true, hint: 'Manual product id.' },
          { name: 'name', type: 'string', required: false, hint: 'New product name.' },
          { name: 'unit', type: 'string', required: false, hint: 'New backoffice row unit; null clears it.' },
          { name: 'maxDiscountBps', type: 'json', required: false, hint: 'New "sconto max" ceiling in basis points; null clears it.' },
          { name: 'stockQuantity', type: 'json', required: false, hint: 'New stock count; null marks a service.' },
        ],
        create(runtime) {
          const manual = manualFor(runtime, config);
          return (input, actor) => manual.updateProduct(input, actor);
        },
      },
      {
        operationContract: 1,
        name: 'set-manual-prices',
        label: 'Set manual prices',
        appMethod: 'setManualPrices',
        description:
          'Replace a manually managed product prices: one new offer revision per declared offer, previous revisions deactivate. Provider-owned offers refuse.',
        input: [
          { name: 'productId', type: 'string', required: true, hint: 'Manual product id.' },
          { name: 'offerIds', type: 'json', required: true, hint: 'Offer row ids replaced, in the order of the declared offers.' },
          { name: 'offers', type: 'json', required: true, hint: 'Replacement offers with price components.' },
        ],
        create(runtime) {
          const manual = manualFor(runtime, config);
          return (input, actor) => manual.setPrices(input, actor);
        },
      },
      {
        operationContract: 1,
        name: 'set-manual-product-active',
        label: 'Set manual product active',
        appMethod: 'setManualProductActive',
        description:
          'Activate or deactivate a manually managed product and its current offers. Provider-owned products refuse.',
        input: [
          { name: 'productId', type: 'string', required: true, hint: 'Manual product id.' },
          { name: 'active', type: 'json', required: true, hint: 'Target active flag (JSON boolean).' },
        ],
        create(runtime) {
          const manual = manualFor(runtime, config);
          return (input, actor) => manual.setActive(input, actor);
        },
      },
      {
        operationContract: 1,
        name: 'list-catalog-products',
        label: 'List catalog products',
        appMethod: 'listCatalogProducts',
        description:
          'The backoffice product table: one row per product with current description, price source, active flag and current prices. Filters: category, active, source.',
        input: [
          { name: 'category', type: 'string', required: false, hint: 'Exact category filter.' },
          { name: 'active', type: 'json', required: false, hint: 'Active flag filter (JSON boolean).' },
          { name: 'source', type: 'string', required: false, hint: "'manual' or a provider name." },
          { name: 'limit', type: 'integer', required: false, hint: 'Max rows (default 200, at most 1000).' },
        ],
        create(runtime) {
          const manual = manualFor(runtime, config);
          return (input) => manual.listProducts(input);
        },
      },
      {
        operationContract: 1,
        name: 'start-product-import',
        label: 'Start product import',
        appMethod: 'startProductImport',
        description:
          'Start a product import (BO-F2-07): manual rows or an AI extraction from the document text become pending draft rows the operator confirms one by one. Writes no product.',
        input: [
          { name: 'source', type: 'string', required: true, hint: "'manual' for operator-typed rows, 'ai' for extraction from the document text." },
          { name: 'rows', type: 'json', required: false, hint: 'Manual rows: [{ sku, name, description?, category?, amountCents }].' },
          { name: 'documentText', type: 'string', required: false, hint: 'Text extracted from the PDF, spreadsheet or photo (AI source).' },
          { name: 'documentRef', type: 'string', required: false, hint: 'Opaque document reference, e.g. the file name (AI source).' },
          { name: 'currency', type: 'string', required: true, hint: 'Uppercase three-letter currency code for every draft.' },
          { name: 'priceBookId', type: 'string', required: false, hint: 'Manual price book id; omitted finds or creates the manual book of the currency at confirm time.' },
          { name: 'spaceId', type: 'string', required: false, hint: 'The Accordo space slug (required for the AI source: the extraction is audited for this space).' },
        ],
        create(runtime) {
          const imports = importFor(runtime, config, llmCapability);
          return (input, actor) => imports.startImport(input, actor);
        },
      },
      {
        operationContract: 1,
        name: 'confirm-product-import-row',
        label: 'Confirm product import row',
        appMethod: 'confirmProductImportRow',
        description:
          'Confirm one pending import row: writes exactly one manual product through the manual catalog, then marks the row. Confirming the same row twice replays the first product.',
        input: [
          { name: 'importId', type: 'string', required: true, hint: 'Product import id.' },
          { name: 'rowId', type: 'string', required: true, hint: 'Pending draft row id.' },
        ],
        create(runtime) {
          const imports = importFor(runtime, config, llmCapability);
          return (input, actor) => imports.confirmRow(input, actor);
        },
      },
      {
        operationContract: 1,
        name: 'reject-product-import-row',
        label: 'Reject product import row',
        appMethod: 'rejectProductImportRow',
        description:
          'Reject one pending import row: no product is written, the decision is stored.',
        input: [
          { name: 'importId', type: 'string', required: true, hint: 'Product import id.' },
          { name: 'rowId', type: 'string', required: true, hint: 'Pending draft row id.' },
        ],
        create(runtime) {
          const imports = importFor(runtime, config, llmCapability);
          return (input, actor) => imports.rejectRow(input, actor);
        },
      },
      {
        operationContract: 1,
        name: 'read-product-import',
        label: 'Read product import',
        appMethod: 'readProductImport',
        description:
          'Read one product import with its draft rows in order and the pending/confirmed/rejected counts.',
        input: [
          { name: 'importId', type: 'string', required: true, hint: 'Product import id.' },
        ],
        create(runtime) {
          const imports = importFor(runtime, config, llmCapability);
          return (input) => imports.readImport(input);
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
  return selectPackageGraph(pkg, options.packageContract === 2 ? 2 : 1);
}

/** Distinct awaited contract-2 graph. Existing `createCommercialDomain()` callers keep v1. */
export function createCommercialDomainV2(options = {}) {
  return createCommercialDomain({ ...options, packageContract: 2 });
}

export { CommercialRegistries } from './registry.js';
export { createPriceListCatalogProvider, validatePriceListConfig, PRICE_LIST_CATALOG_CODE_VERSION } from './price-list.js';
export {
  CATALOG_PRICE_RULES, CATALOG_PRICE_RULES_VERSION, DEFAULT_OWNER_APPROVAL_KEY,
  createCatalogPriceRules,
} from './price-rules.js';
export { createStripeCatalogProvider, createFixtureStripeCatalogClient } from './stripe-catalog.js';
export { buildCommercialActions } from './actions.js';
export { createCatalogSync } from './catalog-sync.js';
export { createManualCatalog, MANUAL_PROVIDER, PRICE_SOURCE_READONLY } from './manual-catalog.js';
export {
  MAX_DOCUMENT_CHARS,
  MAX_IMPORT_ROWS,
  PRODUCT_IMPORT_AI_UNAVAILABLE,
  PRODUCT_IMPORT_PURPOSE,
  buildImportMessages,
  createProductImport,
  extractProductDrafts,
  normalizeDraftRow,
  normalizeManualRows,
  openProductImportLlm,
} from './product-import.js';
export {
  createCommercialQuotesAsyncCapability,
  createCommercialQuotesCapability, createCommercialQuotesVerifiedAsyncCapability,
  createCommercialQuotesVerifiedCapability,
  createCommercialQuoteBindingCapability, QUOTE_BINDING_FIELDS,
} from './capability.js';
export {
  PACKAGE_CREDITS_CONTRACT, allocateConsumption, consumingAppointments,
  createPackageCreditsCapability, grantPackageEntries, isUniqueConflict as isPackageCreditUniqueConflict,
  readPackageBalance, resolveCreditModule, validateCreditSubject, validatePackageCreditGrant,
} from './package-credits.js';
export { VAT_RATE_BPS, vatAmountCents, withVatTotals } from './money.js';
export {
  QUOTE_SUGGEST_PURPOSE, MAX_SUGGESTIONS, MAX_EXCERPTS, MAX_EXCERPT_CHARS,
  MAX_MOTIVE_CHARS, SOURCE_QUOTE_CHARS, buildSuggestMessages, suggestQuoteLines,
} from './quote-suggest.js';
