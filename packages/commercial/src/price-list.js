// @ts-check

import { ValidationError } from '../../core/index.js';
import {
  CHARGE_TYPES,
  PRICING_MODELS,
} from '../../core/index.js';
import { requireCurrency, validatePriceComponent } from './money.js';
import {
  validateCatalogProvider,
  MAX_LABEL as MAX_PROVIDER_LABEL,
  PRICE_LIST_CATALOG_CODE_VERSION,
  PRICE_LIST_CATALOG_TEMPLATE,
  validatePriceListConstructorTemplate,
} from './registry.js';

// Re-exported so existing import sites keep working: the pin lives in
// registry.js, the single module that enforces it.
export {
  PRICE_LIST_CATALOG_CODE_VERSION,
  PRICE_LIST_CATALOG_TEMPLATE,
  validatePriceListConstructorTemplate,
};

/**
 * Workspace price lists (accordo D1): a gym's listino — lesson packs,
 * memberships, trial sessions — as plain JSON configuration, synchronized
 * into the SAME `product`, `price-book` and `offer` records every other
 * catalog uses. No new record, no new manifest, no parallel catalog.
 *
 * The listino is DATA, never code: a workspace edits its JSON and the next
 * `syncCatalog` materializes it. The shared process never runs
 * customer-specific code — this builder is the fixed generic bridge, and the
 * workspace values travel in the provider's declared `config`, which is
 * exactly what the ADR-015 fingerprint covers. A changed amount under an
 * unchanged version is drift and stops the next boot; publishing a new
 * version is how a price change ships.
 *
 * The closed-over value `fetchCatalog` reads IS the declared config object
 * (same reference, frozen), so the honest-limitation note in
 * `definition-fingerprint.js` does not apply here: nothing the fingerprint
 * should see hides in a closure.
 */

const WORKSPACE_KEY_RE = /^[a-z][a-z0-9-]{0,47}$/;
const MAX_TEXT = 500;
const MAX_COMPONENTS = 25;
// The provider name feeds the derived label (`Workspace price list (<name>)`,
// capped at MAX_PROVIDER_LABEL by the registry) and every
// `pricelist.<name>.*` source key (capped by KEY_RE in catalog sync). A long
// but otherwise valid name would only fail downstream, with an error that
// names the label or the key instead of the name — so the name carries the
// same limit up front, leaving room for the label wrapper.
const DERIVED_LABEL_PREFIX = 'Workspace price list (';
const DERIVED_LABEL_SUFFIX = ')';
const MAX_PROVIDER_NAME = MAX_PROVIDER_LABEL - DERIVED_LABEL_PREFIX.length - DERIVED_LABEL_SUFFIX.length;

/**
 * Historical `fetchCatalog` closure sources, pinned byte-for-byte for the one
 * transparent upgrade that drops closure text from the fingerprint (oldest
 * first, never edited, only appended): a database that registered while the
 * registry still hashed closure source keeps composing when the persisted
 * fingerprint matches one of these forms recomputed over the unchanged
 * listino data. A silent price change under a frozen version still stops the
 * boot, because the data rides along in the recomputed form.
 *
 * - pre-#271: the closure closed over the option field `name` directly;
 * - #271 (name → providerName): the same closure over `providerName`.
 */
const PRICE_LIST_CATALOG_LEGACY_FETCH_SOURCES = Object.freeze([
  [
    'async () => ({',
    '    sourceRef: `price-list:${name}`,',
    '    priceBooks: [{',
    '      sourceKey: `pricelist.${name}.book`,',
    '      name: priceListRef.priceBook.name,',
    '      currency: priceListRef.priceBook.currency,',
    '      active: priceListRef.priceBook.active,',
    '    }],',
    '    products: priceListRef.products.map((product) => ({',
    '      sourceKey: `pricelist.${name}.product.${product.key}`,',
    '      externalId: product.externalId,',
    '      sku: product.sku,',
    '      name: product.name,',
    '      description: product.description,',
    '      category: product.category,',
    '      active: product.active,',
    '    })),',
    '    offers: priceListRef.offers.map((offer) => ({',
    '      sourceKey: `pricelist.${name}.offer.${offer.key}`,',
    '      priceBookSourceKey: `pricelist.${name}.book`,',
    '      productSourceKey: `pricelist.${name}.product.${offer.product}`,',
    '      name: offer.name,',
    '      externalOfferId: offer.externalOfferId,',
    '      active: offer.active,',
    '      components: offer.components.map((component, index) => ({',
    '        sourceKey: `${offer.key}.${component.key}`,',
    '        label: component.label,',
    '        chargeType: component.chargeType,',
    '        pricingModel: component.pricingModel,',
    '        interval: component.interval,',
    '        intervalCount: component.intervalCount,',
    '        unitAmountCents: component.unitAmountCents,',
    '        flatAmountCents: component.flatAmountCents,',
    '        tiers: component.tiers.map((tier) => ({',
    '          upTo: tier.upTo,',
    '          unitAmountCents: tier.unitAmountCents,',
    '          flatAmountCents: tier.flatAmountCents,',
    '        })),',
    '        externalPriceId: component.externalPriceId,',
    '        sourcePricingModel: `pricelist:${component.pricingModel}`,',
    '      })),',
    '    })),',
    '  })',
  ].join('\n'),
  [
    'async () => ({',
    '    sourceRef: `price-list:${providerName}`,',
    '    priceBooks: [{',
    '      sourceKey: `pricelist.${providerName}.book`,',
    '      name: priceListRef.priceBook.name,',
    '      currency: priceListRef.priceBook.currency,',
    '      active: priceListRef.priceBook.active,',
    '    }],',
    '    products: priceListRef.products.map((product) => ({',
    '      sourceKey: `pricelist.${providerName}.product.${product.key}`,',
    '      externalId: product.externalId,',
    '      sku: product.sku,',
    '      name: product.name,',
    '      description: product.description,',
    '      category: product.category,',
    '      active: product.active,',
    '    })),',
    '    offers: priceListRef.offers.map((offer) => ({',
    '      sourceKey: `pricelist.${providerName}.offer.${offer.key}`,',
    '      priceBookSourceKey: `pricelist.${providerName}.book`,',
    '      productSourceKey: `pricelist.${providerName}.product.${offer.product}`,',
    '      name: offer.name,',
    '      externalOfferId: offer.externalOfferId,',
    '      active: offer.active,',
    '      components: offer.components.map((component, index) => ({',
    '        sourceKey: `${offer.key}.${component.key}`,',
    '        label: component.label,',
    '        chargeType: component.chargeType,',
    '        pricingModel: component.pricingModel,',
    '        interval: component.interval,',
    '        intervalCount: component.intervalCount,',
    '        unitAmountCents: component.unitAmountCents,',
    '        flatAmountCents: component.flatAmountCents,',
    '        tiers: component.tiers.map((tier) => ({',
    '          upTo: tier.upTo,',
    '          unitAmountCents: tier.unitAmountCents,',
    '          flatAmountCents: tier.flatAmountCents,',
    '        })),',
    '        externalPriceId: component.externalPriceId,',
    '        sourcePricingModel: `pricelist:${component.pricingModel}`,',
    '      })),',
    '    })),',
    '  })',
  ].join('\n'),
]);

/**
 * Freeze a normalized value in depth: the fingerprinted config must stay
 * immutable after registration, so nested products, offers, components and
 * tiers are frozen too, not just the top-level arrays.
 * @param {any} value
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

/** @param {unknown} value @param {string} field @param {number} [max] */
function requireText(value, field, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new ValidationError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field @param {number} [max] */
function optionalText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, max);
}

/** @param {unknown} value */
function requireProviderName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PROVIDER_NAME) {
    throw new ValidationError(
      `name must be a non-empty string of at most ${MAX_PROVIDER_NAME} characters, `
      + `so the derived label stays within ${MAX_PROVIDER_LABEL} characters`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireWorkspaceKey(value, field) {
  if (typeof value !== 'string' || !WORKSPACE_KEY_RE.test(value)) {
    throw new ValidationError(
      `${field} must be a lowercase slug starting with a letter (letters, digits, hyphens, at most 48 characters)`,
    );
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireActive(value, field) {
  if (value === undefined) return true;
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean when present`);
  }
  return value;
}

/**
 * Validate one workspace component and return its normalized provider form.
 * Pricing coherence is NOT re-implemented here: the candidate is built in
 * provider field names and passed through `validatePriceComponent`, the same
 * gate catalog sync applies — so a listino the builder accepts is a listino
 * the sync accepts.
 * @param {any} component @param {string} label
 */
function normalizeComponent(component, label) {
  if (!component || typeof component !== 'object' || Array.isArray(component)) {
    throw new ValidationError(`${label} must be an object`);
  }
  const key = requireWorkspaceKey(component.key, `${label}.key`);
  const chargeType = component.charge;
  if (!CHARGE_TYPES.includes(chargeType)) {
    throw new ValidationError(`${label}: charge must be one of: ${CHARGE_TYPES.join(', ')}`);
  }
  const pricingModel = component.model;
  if (!PRICING_MODELS.includes(pricingModel)) {
    throw new ValidationError(`${label}: model must be one of: ${PRICING_MODELS.join(', ')}`);
  }
  // Model-incoherent extras must fail closed here, in workspace field names:
  // the shared gate below only sees the model-appropriate field, so anything
  // else would be silently dropped and the listino would sync a price its
  // author never declared.
  /** @param {unknown} value */
  const hasExtraAmount = (value) => value !== undefined && value !== null && value !== 0;
  if (pricingModel === 'flat_fee') {
    if (hasExtraAmount(component.unitAmountCents)) {
      throw new ValidationError(`${label}: flat_fee components price by amountCents; unitAmountCents is not supported`);
    }
  } else if (pricingModel === 'per_unit') {
    if (hasExtraAmount(component.amountCents)) {
      throw new ValidationError(`${label}: per_unit components price by unitAmountCents; amountCents is not supported`);
    }
  } else if (hasExtraAmount(component.amountCents) || hasExtraAmount(component.unitAmountCents)) {
    throw new ValidationError(`${label}: volume and graduated components carry their amounts in tiers, not amountCents/unitAmountCents`);
  }
  const candidate = {
    chargeType,
    pricingModel,
    interval: component.interval ?? null,
    intervalCount: component.intervalCount ?? (chargeType === 'recurring' ? 1 : null),
    flatAmountCents: pricingModel === 'flat_fee' ? component.amountCents : undefined,
    unitAmountCents: pricingModel === 'per_unit' ? component.unitAmountCents : undefined,
    tiers: component.tiers,
  };
  let normalized;
  try {
    normalized = validatePriceComponent(candidate, label);
  } catch (error) {
    throw new ValidationError(error instanceof Error ? error.message : `${label} is not a coherent price component`);
  }
  return {
    key,
    label: requireText(component.label, `${label}.label`, 200),
    ...normalized,
    externalPriceId: optionalText(component.externalPriceId, `${label}.externalPriceId`, 200),
  };
}

/**
 * Validate a workspace price-list configuration and return its normalized,
 * JSON-safe form. Throws fail-closed with the field path: a misconfigured
 * listino stops composition, it never syncs half a catalog.
 * @param {unknown} input
 */
export function validatePriceListConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('price list must be a plain object with priceBook, products and offers');
  }
  const config = /** @type {Record<string, any>} */ (input);
  const book = config.priceBook;
  if (!book || typeof book !== 'object' || Array.isArray(book)) {
    throw new ValidationError('price list needs a priceBook object with name and currency');
  }
  const priceBook = {
    name: requireText(book.name, 'priceBook.name', 200),
    currency: (() => {
      try {
        return requireCurrency(book.currency, 'priceBook.currency');
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : 'priceBook.currency is invalid');
      }
    })(),
    active: requireActive(book.active, 'priceBook.active'),
  };

  if (!Array.isArray(config.products) || config.products.length === 0) {
    throw new ValidationError('price list needs a non-empty products array');
  }
  const productKeys = new Set();
  // Catalog sync rejects duplicate product externalIds at persist time
  // (catalog-sync.js): the builder mirrors that invariant at composition, so
  // a listino the builder accepts is a listino the sync accepts.
  const productExternalIds = new Map();
  const products = config.products.map((product, index) => {
    const label = `products[${index}]`;
    if (!product || typeof product !== 'object' || Array.isArray(product)) {
      throw new ValidationError(`${label} must be an object`);
    }
    const key = requireWorkspaceKey(product.key, `${label}.key`);
    if (productKeys.has(key)) {
      throw new ValidationError(`duplicate product key "${key}"`);
    }
    productKeys.add(key);
    const externalId = optionalText(product.externalId, `${label}.externalId`, 200);
    if (externalId !== null) {
      if (productExternalIds.has(externalId)) {
        throw new ValidationError(
          `${label}.externalId duplicates the externalId of products[${productExternalIds.get(externalId)}]`,
        );
      }
      productExternalIds.set(externalId, index);
    }
    return {
      key,
      sku: (() => {
        const sku = product.sku ?? key;
        return requireText(sku, `${label}.sku`, 100);
      })(),
      name: requireText(product.name, `${label}.name`, 200),
      description: optionalText(product.description, `${label}.description`),
      category: optionalText(product.category, `${label}.category`, 100),
      externalId,
      active: requireActive(product.active, `${label}.active`),
    };
  });

  if (!Array.isArray(config.offers) || config.offers.length === 0) {
    throw new ValidationError('price list needs a non-empty offers array');
  }
  const offerKeys = new Set();
  const offers = config.offers.map((offer, index) => {
    const label = `offers[${index}]`;
    if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
      throw new ValidationError(`${label} must be an object`);
    }
    const key = requireWorkspaceKey(offer.key, `${label}.key`);
    if (offerKeys.has(key)) {
      throw new ValidationError(`duplicate offer key "${key}"`);
    }
    offerKeys.add(key);
    const productKey = requireWorkspaceKey(offer.product, `${label}.product`);
    if (!productKeys.has(productKey)) {
      throw new ValidationError(`${label} references unknown product "${productKey}"`);
    }
    if (!Array.isArray(offer.components) || offer.components.length === 0) {
      throw new ValidationError(`${label} needs at least one price component`);
    }
    if (offer.components.length > MAX_COMPONENTS) {
      throw new ValidationError(`${label} exceeds the ${MAX_COMPONENTS}-component bound catalog sync enforces`);
    }
    const componentKeys = new Set();
    const components = offer.components.map((component, componentIndex) =>
      (() => {
        const normalized = normalizeComponent(component, `${label}.components[${componentIndex}]`);
        if (componentKeys.has(normalized.key)) {
          throw new ValidationError(`${label} has a duplicate component key "${normalized.key}"`);
        }
        componentKeys.add(normalized.key);
        return normalized;
      })(),
    );
    return {
      key,
      product: productKey,
      name: requireText(offer.name, `${label}.name`, 200),
      externalOfferId: optionalText(offer.externalOfferId, `${label}.externalOfferId`, 200),
      active: requireActive(offer.active, `${label}.active`),
      components,
    };
  });

  // The fingerprinted config must be immutable in depth: a shallow freeze
  // would let nested amounts drift under an unchanged version.
  return deepFreeze({ priceBook, products, offers });
}

/**
 * Build a declared catalog provider from a workspace price list.
 *
 * Source keys are namespaced per provider (`pricelist.<name>.*`) so two
 * workspaces' listini never collide in one database; every row still lands
 * in the existing commercial records through the normal sync.
 *
 * @param {{name: string, version: number, label?: string, priceList: unknown, deactivateMissing?: boolean}} options
 */
export function createPriceListCatalogProvider({ name, version, label, priceList, deactivateMissing = false }) {
  const providerName = requireProviderName(name);
  const normalized = validatePriceListConfig(priceList);
  if (typeof deactivateMissing !== 'boolean') {
    throw new ValidationError('deactivateMissing must be a boolean when present');
  }
  const priceListRef = normalized;
  const fetchCatalog = async () => ({
    sourceRef: `price-list:${providerName}`,
    priceBooks: [{
      sourceKey: `pricelist.${providerName}.book`,
      name: priceListRef.priceBook.name,
      currency: priceListRef.priceBook.currency,
      active: priceListRef.priceBook.active,
    }],
    products: priceListRef.products.map((product) => ({
      sourceKey: `pricelist.${providerName}.product.${product.key}`,
      externalId: product.externalId,
      sku: product.sku,
      name: product.name,
      description: product.description,
      category: product.category,
      active: product.active,
    })),
    offers: priceListRef.offers.map((offer) => ({
      sourceKey: `pricelist.${providerName}.offer.${offer.key}`,
      priceBookSourceKey: `pricelist.${providerName}.book`,
      productSourceKey: `pricelist.${providerName}.product.${offer.product}`,
      name: offer.name,
      externalOfferId: offer.externalOfferId,
      active: offer.active,
      components: offer.components.map((component, index) => ({
        sourceKey: `${offer.key}.${component.key}`,
        label: component.label,
        chargeType: component.chargeType,
        pricingModel: component.pricingModel,
        interval: component.interval,
        intervalCount: component.intervalCount,
        unitAmountCents: component.unitAmountCents,
        flatAmountCents: component.flatAmountCents,
        tiers: component.tiers.map((tier) => ({
          upTo: tier.upTo,
          unitAmountCents: tier.unitAmountCents,
          flatAmountCents: tier.flatAmountCents,
        })),
        externalPriceId: component.externalPriceId,
        sourcePricingModel: `pricelist:${component.pricingModel}`,
      })),
    })),
  });
  // The executed code is bound to the pinned template: an unbumped edit to
  // this closure — behaviour or otherwise — refuses here, at composition,
  // instead of syncing under an unchanged fingerprint.
  validatePriceListConstructorTemplate(fetchCatalog.toString());
  const provider = {
    name: providerName,
    version,
    // The constructor version moves the registry fingerprint on behaviour
    // change; the historical closure sources let databases registered before
    // the fingerprint dropped closure text keep composing (one transparent
    // migration, see CommercialRegistries.persistFingerprints).
    codeVersion: PRICE_LIST_CATALOG_CODE_VERSION,
    legacyFetchSources: PRICE_LIST_CATALOG_LEGACY_FETCH_SOURCES,
    label: label ?? `${DERIVED_LABEL_PREFIX}${providerName}${DERIVED_LABEL_SUFFIX}`,
    config: Object.freeze({
      source: 'price-list',
      deactivateMissing,
      priceList: priceListRef,
    }),
    fetchCatalog,
  };
  // Declared-definition discipline: malformed here stops startup, like every
  // other provider — and the fingerprint the registry computes over this
  // definition covers the listino data in config, so a silent price change
  // under a frozen version is drift, not an update. The registry recognizes
  // this provider as constructor-built by its pinned version plus its live
  // fetchCatalog source (see registry.js): there is no seal to carry or
  // forge, so the frozen shape above is the whole privilege.
  validateCatalogProvider(provider);
  return Object.freeze(provider);
}
