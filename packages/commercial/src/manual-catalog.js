// @ts-check

import { randomUUID } from 'node:crypto';
import {
  AppError,
  CHARGE_TYPES,
  MAX_QUANTITY,
  PRICING_MODELS,
  ValidationError,
  computeDefinitionFingerprint,
  normalizeError,
  nowIso,
  requireActor,
  requireBps,
  writeTrace,
} from '../../core/index.js';
import { requireCurrency, validatePriceComponent } from './money.js';

/**
 * Manual catalog management (BO-F2-05, "gestione manuale senza Stripe"): the
 * trusted write path for products whose price source is NOT Stripe.
 *
 * Invariant (the read-only rule the backoffice renders): only Stripe-owned
 * rows are owned by their price source — every manual mutation refuses them
 * with PROVIDER_PRICE_READONLY, because Stripe stays the source of truth and
 * a re-sync would overwrite the operator. Rows imported from any other
 * provider (a static listino with no live sync in this codebase) are
 * operator-managed: the operator's first mutation takes the row over into
 * manual management (`sourceKind: 'internal'`, `provider: 'manual'` on the
 * product row; offers convert lazily to manual revisions on the first
 * reprice, moving to the manual book of their currency), so a later sync of
 * that provider never silently rewrites what the operator decided. Manual
 * rows (`sourceKind: 'internal'`, `provider: 'manual'`) are fully managed
 * here: create, describe, reprice, activate.
 *
 * Shape discipline mirrors catalog sync on purpose: versions stay immutable
 * (a description change opens version n+1), offers stay revisioned as a
 * whole (a price change opens revision n+1 and deactivates the previous one),
 * components and tiers are validated by `validatePriceComponent` — the same
 * gate sync applies — so a manual catalog the operations accept is a catalog
 * the sync would accept.
 */

export const MANUAL_PROVIDER = 'manual';
export const PRICE_SOURCE_READONLY = 'PROVIDER_PRICE_READONLY';

const MAX_TEXT = 500;
const MAX_COMPONENTS = 25;
const COMPONENT_KEY_RE = /^[a-z][a-z0-9-]{0,47}$/;
const LIST_DEFAULT_LIMIT = 200;
const LIST_MAX_LIMIT = 1000;

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

/** @param {unknown} value @param {string} field */
function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new ValidationError(`${field} must be a boolean when present`);
  }
  return value;
}

/**
 * The backoffice row unit ("a corpo", "ml", "m²", ...): short free text, or
 * null when the product has no unit to show. Empty and overlong units refuse
 * fail-closed, like every other row field.
 * @param {unknown} value @param {string} field
 */
function optionalUnit(value, field) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, 40);
}

/**
 * The backoffice "sconto max" row ceiling: null (no ceiling declared) or
 * integer basis points in the commercial 0–10000 idiom (1000 = 10%).
 * @param {unknown} value @param {string} field
 */
function optionalDiscountBps(value, field) {
  if (value === undefined || value === null) return null;
  return requireBps(value, field);
}

/**
 * The backoffice stock row: null means a service with no stock to count,
 * otherwise a non-negative integer (0 counts: sold out, still orderable).
 * @param {unknown} value @param {string} field
 */
function optionalStockQuantity(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_QUANTITY) {
    throw new ValidationError(`${field} must be an integer between 0 and ${MAX_QUANTITY} when present`);
  }
  return value;
}

/**
 * The three backoffice row fields as one validated bundle: unit (free text),
 * discount ceiling (basis points) and stock (null = service). Shared by the
 * manual writer and catalog sync so both gates refuse the same garbage.
 * @param {{unit?: unknown, maxDiscountBps?: unknown, stockQuantity?: unknown}} input @param {string} label
 */
export function normalizeRowFields(input, label) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    unit: optionalUnit(source.unit, `${label}.unit`),
    maxDiscountBps: optionalDiscountBps(source.maxDiscountBps, `${label}.maxDiscountBps`),
    stockQuantity: optionalStockQuantity(source.stockQuantity, `${label}.stockQuantity`),
  };
}

/**
 * The commercial snapshot a product version carries, in the shape r2
 * fingerprints (sku, name, description, category plus the three backoffice
 * row fields, null when absent). Legacy rows stored before r2 have no row
 * columns: they normalize to the same nulls, so an identical provider
 * catalog never opens a new version only because three nulls appeared.
 * @param {{sku?: unknown, name?: unknown, description?: unknown, category?: unknown, unit?: unknown, maxDiscountBps?: unknown, stockQuantity?: unknown} | null | undefined} row
 */
export function normalizeStoredCommercial(row) {
  const source = row && typeof row === 'object' ? row : {};
  return {
    sku: source.sku,
    name: source.name,
    description: source.description ?? null,
    category: source.category ?? null,
    unit: source.unit ?? null,
    maxDiscountBps: source.maxDiscountBps ?? null,
    stockQuantity: source.stockQuantity ?? null,
  };
}

/**
 * Legacy-tolerant unchanged check: a stored `sourceFingerprint` computed
 * before r2 (four keys, no row fields) never matches an r2 fingerprint of
 * the same product (seven keys with three nulls), so comparing fingerprints
 * alone would version every product on the first sync after the upgrade and
 * — because offers pin `productVersionId` — revise every offer. Recompute
 * the stored row in the r2 shape and compare that too: equal content stays
 * a no-op, any real change still opens a new version.
 * @param {{sourceFingerprint?: unknown} | null | undefined} storedRow @param {string} incomingFingerprint
 */
export function isUnchangedCommercial(storedRow, incomingFingerprint) {
  if (storedRow?.sourceFingerprint === incomingFingerprint) return true;
  try {
    return computeDefinitionFingerprint(normalizeStoredCommercial(storedRow)) === incomingFingerprint;
  } catch {
    return false;
  }
}

/** @param {unknown} value @param {string} field */
function requireComponentKey(value, field) {
  if (typeof value !== 'string' || !COMPONENT_KEY_RE.test(value)) {
    throw new ValidationError(`${field} must be a lowercase slug starting with a letter (letters, digits, hyphens, at most 48 characters)`);
  }
  return value;
}

/**
 * Whether a provider name is a Stripe price source: the only source the
 * manual writers never touch. The same derivation the backoffice uses to
 * render Stripe rows read-only, so the two never disagree about it.
 * @param {unknown} provider
 */
export function isStripeSource(provider) {
  return typeof provider === 'string' && provider.toLowerCase().includes('stripe');
}

/**
 * Whether a row is still owned by its price source. Taken-over rows
 * (`sourceKind: 'internal'`, `provider: 'manual'`) are operator-managed.
 * The catalog sync reuses this exact derivation, so the write guard and
 * the sync never disagree about ownership.
 * @param {{sourceKind?: unknown, provider?: unknown} | null} row
 */
export function isProviderOwned(row) {
  const provider = row?.provider ?? 'unknown';
  return row?.sourceKind === 'provider'
    || (row?.sourceKind === undefined && typeof provider === 'string' && provider !== MANUAL_PROVIDER);
}

/**
 * The price-source guard: Stripe-owned rows are read-only for manual
 * writers. Any other provider row (a static import with no live sync) is
 * operator-managed — the caller takes it over (see the module header).
 * @param {{sourceKind?: unknown, provider?: unknown} | null} row @param {string} what
 */
function requireManageableRow(row, what) {
  const provider = row?.provider ?? 'unknown';
  const providerOwned = isProviderOwned(row);
  if (providerOwned && isStripeSource(provider)) {
    throw new AppError(
      `${what} is owned by price source "${typeof provider === 'string' ? provider : 'unknown'}": provider prices are read-only — change them at the source and re-sync`,
      { code: PRICE_SOURCE_READONLY, status: 409 },
    );
  }
}

/**
 * Take a non-Stripe provider product over into manual management, so the
 * operator's edit is never silently rewritten by a later sync of that
 * provider. Stripe rows never reach here (the guard above refuses them);
 * manual rows are already managed and read back unchanged. The import's
 * external id stays on the row as provenance.
 * @param {{applyManaged: (id: string, patch: Record<string, unknown>, context: unknown) => Promise<any>}} products
 */
async function takeoverProviderProduct(products, product, context) {
  if (product.sourceKind !== 'provider' || isStripeSource(product.provider)) return product;
  return products.applyManaged(product.id, { sourceKind: 'internal', provider: MANUAL_PROVIDER }, context);
}

/**
 * Validate one manual price component in record field names and return its
 * normalized form. Coherence is NOT re-implemented: the candidate goes
 * through `validatePriceComponent`, the same gate catalog sync applies.
 */
function normalizeManualComponent(component, label) {
  if (!component || typeof component !== 'object' || Array.isArray(component)) {
    throw new ValidationError(`${label} must be an object`);
  }
  const key = requireComponentKey(component.key, `${label}.key`);
  if (!CHARGE_TYPES.includes(component.chargeType)) {
    throw new ValidationError(`${label}: chargeType must be one of: ${CHARGE_TYPES.join(', ')}`);
  }
  if (!PRICING_MODELS.includes(component.pricingModel)) {
    throw new ValidationError(`${label}: pricingModel must be one of: ${PRICING_MODELS.join(', ')}`);
  }
  // Model-incoherent extras must fail closed here, in input field names: the
  // shared gate below only sees the model-appropriate field, so anything else
  // would be silently dropped and the catalog would store a price its author
  // never declared (same rule as the workspace listino builder).
  /** @param {unknown} value */
  const hasExtraAmount = (value) => value !== undefined && value !== null && value !== 0;
  if (component.pricingModel === 'flat_fee') {
    if (hasExtraAmount(component.unitAmountCents)) {
      throw new ValidationError(`${label}: flat_fee components price by flatAmountCents; unitAmountCents is not supported`);
    }
  } else if (component.pricingModel === 'per_unit') {
    if (hasExtraAmount(component.flatAmountCents)) {
      throw new ValidationError(`${label}: per_unit components price by unitAmountCents; flatAmountCents is not supported`);
    }
  } else if (hasExtraAmount(component.flatAmountCents) || hasExtraAmount(component.unitAmountCents)) {
    throw new ValidationError(`${label}: volume and graduated components carry their amounts in tiers, not flatAmountCents/unitAmountCents`);
  }
  const candidate = {
    chargeType: component.chargeType,
    pricingModel: component.pricingModel,
    interval: component.interval ?? null,
    intervalCount: component.intervalCount ?? (component.chargeType === 'recurring' ? 1 : null),
    flatAmountCents: component.pricingModel === 'flat_fee' ? component.flatAmountCents : undefined,
    unitAmountCents: component.pricingModel === 'per_unit' ? component.unitAmountCents : undefined,
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

/** @param {unknown} input @param {string} label */
function normalizeManualOffers(input, label) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError(`${label} needs a non-empty offers array`);
  }
  return input.map((offer, index) => {
    const offerLabel = `${label}[${index}]`;
    if (!offer || typeof offer !== 'object' || Array.isArray(offer)) {
      throw new ValidationError(`${offerLabel} must be an object`);
    }
    const components = offer.components;
    if (!Array.isArray(components) || components.length === 0) {
      throw new ValidationError(`${offerLabel} needs at least one price component`);
    }
    if (components.length > MAX_COMPONENTS) {
      throw new ValidationError(`${offerLabel} exceeds the ${MAX_COMPONENTS}-component bound catalog sync enforces`);
    }
    const seen = new Set();
    const normalized = components.map((component, componentIndex) => {
      const candidate = normalizeManualComponent(component, `${offerLabel}.components[${componentIndex}]`);
      if (seen.has(candidate.key)) {
        throw new ValidationError(`${offerLabel} has a duplicate component key "${candidate.key}"`);
      }
      seen.add(candidate.key);
      return candidate;
    });
    return {
      name: requireText(offer.name, `${offerLabel}.name`, 200),
      active: offer.active === undefined ? true : requireBoolean(offer.active, `${offerLabel}.active`),
      components: normalized,
    };
  });
}

/**
 * @param {{database: any, events: any, modules: any, moduleNames?: Record<string, string>}} deps
 */
export function createManualCatalog({ database, events, modules, moduleNames = {} }) {
  const names = {
    product: moduleNames.product ?? 'product',
    productVersion: moduleNames.productVersion ?? 'product-version',
    priceBook: moduleNames.priceBook ?? 'price-book',
    offer: moduleNames.offer ?? 'offer',
    component: moduleNames.component ?? 'price-component',
    tier: moduleNames.tier ?? 'price-tier',
  };
  const service = (name) => {
    const module = modules.get(name);
    if (typeof module.service?.createManaged !== 'function') {
      throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
        code: 'COMMERCIAL_STORAGE_INVALID',
        status: 500,
      });
    }
    return module.service;
  };

  /**
   * The envelope every manual mutation runs in: the actor is a precondition
   * (`requireActor`, never anonymous), record events stay buffered until the
   * write transaction commits (so a later failure never leaves observed rows
   * that never committed), and a best-effort `catalog.manual` trace records
   * the run — the same discipline as `catalog.sync`, without its provider
   * fetch. A trace write failure never masks the mutation outcome.
   */
  async function runManual(operation, actor, write) {
    const runId = randomUUID();
    const startedAt = nowIso();
    /** @type {Array<{name: string, status: string, output?: unknown, error?: string}>} */
    const steps = [];
    /** @type {any} */
    let failure = null;
    /** @type {any} */
    let output = null;
    try {
      const who = requireActor(actor);
      output = await events.buffered(async (outbox) => {
        const value = await database.transactionAsync(async () => write({ actor: who }));
        steps.push({ name: 'catalog.manual.write', status: 'completed' });
        try {
          await outbox.commit();
        } catch (error) {
          const dispatchFailure = normalizeError(error);
          steps.push({ name: 'events.dispatch', status: 'failed', error: dispatchFailure.message });
          console.error(`[accordo] catalog.manual run ${runId}: business writes committed but event dispatch failed: ${dispatchFailure.message}`);
        }
        return value;
      });
      return output;
    } catch (error) {
      failure = normalizeError(error);
      throw failure;
    } finally {
      try {
        writeTrace(database, {
          runId,
          workflowName: 'catalog.manual',
          status: failure ? 'failed' : 'completed',
          input: { operation, actor: actor && typeof actor === 'object' ? { type: actor.type ?? null, id: actor.id ?? null } : null },
          output: failure ? null : output,
          error: failure ? failure.message : null,
          startedAt,
          steps,
        });
      } catch (traceError) {
        console.error(`[accordo] catalog.manual run ${runId}: failed to persist trace: ${traceError instanceof Error ? traceError.message : String(traceError)}`);
      }
    }
  }

  /**
   * Find the manual price book for a currency, creating it on first use. One
   * book per currency (`manual:book:<CUR>`); provider books are never reused
   * for manual products, so sources stay clean.
   */
  async function manualBookFor(currency, context) {
    const books = service(names.priceBook);
    const sourceKey = `manual:book:${currency}`;
    const existing = (await books.listWhere({ sourceKey }))[0];
    if (existing) {
      requireManageableRow(existing, `Price book "${existing.id}"`);
      if (existing.currency !== currency) {
        throw new AppError(`Manual price book currency is immutable (stored ${existing.currency}, requested ${currency})`, { code: 'SYNC_CONFLICT', status: 409 });
      }
      return existing;
    }
    return books.createManaged(
      { sourceKey, name: `Manuale ${currency}`, currency, sourceKind: 'internal', provider: MANUAL_PROVIDER, active: true },
      context,
    );
  }

  /** Persist one offer revision with its components and tiers. */
  async function persistOfferRevision(offer, { priceBookId, productId, productVersionId, currency }, context) {
    const offers = service(names.offer);
    const components = service(names.component);
    const tiers = service(names.tier);
    const declared = {
      name: offer.name,
      currency,
      quoteEligible: true,
      unsupportedReason: null,
      productVersionId,
      components: offer.components.map((component) => ({
        sourceKey: component.key,
        label: component.label,
        position: component.position,
        chargeType: component.chargeType,
        pricingModel: component.pricingModel,
        interval: component.interval,
        intervalCount: component.intervalCount,
        unitAmountCents: component.unitAmountCents,
        flatAmountCents: component.flatAmountCents,
        externalPriceId: component.externalPriceId,
        sourcePricingModel: `manual:${component.pricingModel}`,
        tiers: component.tiers.map((tier) => ({ position: tier.position, upTo: tier.upTo, unitAmountCents: tier.unitAmountCents, flatAmountCents: tier.flatAmountCents })),
      })),
    };
    const sourceFingerprint = computeDefinitionFingerprint(declared);
    const created = await offers.createManaged(
      {
        logicalKey: offer.logicalKey,
        revision: offer.revision,
        sourceKey: `${offer.logicalKey}:${offer.revision}`,
        priceBookId,
        productId,
        productVersionId,
        name: offer.name,
        currency,
        active: offer.active,
        quoteEligible: true,
        unsupportedReason: null,
        provider: MANUAL_PROVIDER,
        providerVersion: 1,
        providerFingerprint: 'manual',
        externalOfferId: null,
        componentCount: offer.components.length,
        sourceFingerprint,
      },
      context,
    );
    for (const component of offer.components) {
      const createdComponent = await components.createManaged(
        {
          offerId: created.id,
          sourceKey: `${created.sourceKey}:${component.key}`,
          componentKey: component.key,
          label: component.label,
          position: component.position,
          chargeType: component.chargeType,
          pricingModel: component.pricingModel,
          interval: component.interval,
          intervalCount: component.intervalCount,
          unitAmountCents: component.unitAmountCents,
          flatAmountCents: component.flatAmountCents,
          currency,
          provider: MANUAL_PROVIDER,
          externalPriceId: component.externalPriceId,
          sourcePricingModel: `manual:${component.pricingModel}`,
          tierCount: component.tiers.length,
        },
        context,
      );
      for (const tier of component.tiers) {
        await tiers.createManaged(
          {
            componentId: createdComponent.id,
            sourceKey: `${createdComponent.sourceKey}:t${tier.position}`,
            position: tier.position,
            upToQuantity: tier.upTo,
            unitAmountCents: tier.unitAmountCents,
            flatAmountCents: tier.flatAmountCents,
          },
          context,
        );
      }
    }
    return created;
  }

  /** Latest revision per logical key. */
  function latestRevisions(rows) {
    /** @type {Map<string, any>} */
    const latest = new Map();
    for (const row of rows) {
      const current = latest.get(row.logicalKey);
      if (!current || row.revision > current.revision) latest.set(row.logicalKey, row);
    }
    return [...latest.values()];
  }

  /**
   * The product write without an envelope: the same validated writes
   * `createProduct` performs, joining the caller's transaction and event
   * buffer instead of opening its own. Product import confirmation runs
   * inside one import transaction, so it calls this — never `createProduct`
   * (its own `events.buffered` scope refuses to nest, and its own
   * transaction would commit the product before the row is claimed).
   * @param {unknown} input @param {{actor: unknown}} context
   */
  async function writeProduct(input, context) {
    const sku = requireText(input.sku, 'sku', 100);
    const name = requireText(input.name, 'name', 200);
    const description = optionalText(input.description, 'description');
    const category = optionalText(input.category, 'category', 100);
    const currency = requireCurrency(input.currency, 'currency');
    if (input.offers !== undefined && input.components !== undefined) {
      throw new ValidationError('offers and components are alternatives: declare one offer list, or shorthand components for a single offer');
    }
    const offers = normalizeManualOffers(input.offers ?? [{ name, components: input.components }], 'offers');
    const products = service(names.product);
    const versions = service(names.productVersion);
    let book;
    if (input.priceBookId !== undefined && input.priceBookId !== null) {
      book = await service(names.priceBook).get(String(input.priceBookId));
      requireManageableRow(book, `Price book "${book.id}"`);
      if (book.currency !== currency) {
        throw new AppError(`Price book "${book.id}" is in ${book.currency}, the product declares ${currency}`, { code: 'CURRENCY_MISMATCH', status: 409 });
      }
      if (book.active !== true) {
        throw new AppError(`Price book "${book.id}" is not active`, { code: 'PRICE_BOOK_INACTIVE', status: 409 });
      }
    } else {
      book = await manualBookFor(currency, context);
    }
    const commercialData = { sku, name, description, category, ...normalizeRowFields(input, 'row') };
    const product = await products.createManaged(
      { sourceKey: `manual:product:${randomUUID()}`, sourceKind: 'internal', provider: MANUAL_PROVIDER, externalId: null, active: input.active === undefined ? true : requireBoolean(input.active, 'active') },
      context,
    );
    const version = await versions.createManaged(
      {
        productId: product.id, version: 1, sourceKey: `pv:${product.sourceKey}:1`,
        ...commercialData,
        provider: MANUAL_PROVIDER, providerVersion: 1, providerFingerprint: 'manual',
        sourceFingerprint: computeDefinitionFingerprint(commercialData), effectiveAt: nowIso(),
      },
      context,
    );
    const updated = await products.applyManaged(product.id, { currentVersionId: version.id }, context);
    const createdOffers = [];
    for (const offer of offers) {
      createdOffers.push(await persistOfferRevision(
        {
          logicalKey: `manual:offer:${randomUUID()}`,
          revision: 1,
          name: offer.name,
          active: offer.active,
          components: offer.components.map((component, componentIndex) => ({ ...component, position: componentIndex + 1 })),
        },
        { priceBookId: book.id, productId: product.id, productVersionId: version.id, currency },
        context,
      ));
    }
    return {
      product: { id: updated.id, sourceKey: updated.sourceKey, sku, name, active: updated.active, version: 1 },
      priceBook: { id: book.id, name: book.name, currency: book.currency },
      offers: createdOffers.map((row) => ({ id: row.id, logicalKey: row.logicalKey, revision: row.revision, name: row.name, active: row.active })),
    };
  }

  return {
    /**
     * Create a manual product with its prices, without any provider. One
     * transaction: book (found or created), product, version 1, one offer
     * revision 1 per declared offer.
     */
    async createProduct(input = {}, actor) {
      return runManual('create-manual-product', actor, async (context) => writeProduct(input, context));
    },

    /**
     * Caller-envelope variant of `createProduct` for atomic multi-record
     * flows (product import confirmation): the same validated writes,
     * joining the caller's transaction and event buffer. The caller opens
     * both — this refuses without an actor, like every manual mutation.
     */
    async createProductManaged(input = {}, context = {}) {
      requireActor(context?.actor);
      return writeProduct(input, context);
    },

    /** Edit a manual product's description: opens version n+1, never rewrites. */
    async updateProduct(input = {}, actor) {
      return runManual('update-manual-product', actor, async (context) => {
        const productId = requireText(input.productId, 'productId', 200);
        const products = service(names.product);
        const versions = service(names.productVersion);
        const product = await products.get(productId);
        requireManageableRow(product, `Product "${product.id}"`);
        const current = product.currentVersionId ? await versions.get(product.currentVersionId) : null;
        if (!current) {
          throw new AppError(`Product "${product.id}" has no current version`, { code: 'COMMERCIAL_STATE_CORRUPT', status: 409 });
        }
        const rowFields = normalizeRowFields({
          unit: input.unit === undefined ? current?.unit ?? null : input.unit,
          maxDiscountBps: input.maxDiscountBps === undefined ? current?.maxDiscountBps ?? null : input.maxDiscountBps,
          stockQuantity: input.stockQuantity === undefined ? current?.stockQuantity ?? null : input.stockQuantity,
        }, 'row');
        const commercialData = {
          sku: input.sku === undefined ? current?.sku : requireText(input.sku, 'sku', 100),
          name: input.name === undefined ? current?.name : requireText(input.name, 'name', 200),
          description: input.description === undefined ? current?.description ?? null : optionalText(input.description, 'description'),
          category: input.category === undefined ? current?.category ?? null : optionalText(input.category, 'category', 100),
          ...rowFields,
        };
        const sourceFingerprint = computeDefinitionFingerprint(commercialData);
        if (isUnchangedCommercial(current, sourceFingerprint)) {
          return { product: { id: product.id, version: current.version }, unchanged: true };
        }
        // A real change takes an imported row over; a no-op leaves it alone.
        await takeoverProviderProduct(products, product, context);
        const nextNumber = (await versions.countWhere({ productId: product.id })) + 1;
        const version = await versions.createManaged(
          {
            productId: product.id, version: nextNumber, sourceKey: `pv:${product.sourceKey}:${nextNumber}`,
            ...commercialData,
            provider: MANUAL_PROVIDER, providerVersion: 1, providerFingerprint: 'manual',
            sourceFingerprint, effectiveAt: nowIso(),
          },
          context,
        );
        await products.applyManaged(product.id, { currentVersionId: version.id }, context);
        return { product: { id: product.id, version: version.version }, unchanged: false };
      });
    },

    /**
     * Replace a manual product's prices: one new offer revision per declared
     * offer (the previous revision deactivates, history is never rewritten).
     * Stripe-owned offers refuse with PROVIDER_PRICE_READONLY; offers
     * imported from any other provider convert to manual revisions on the
     * manual book of their currency (the product row is taken over below).
     */
    async setPrices(input = {}, actor) {
      return runManual('set-manual-prices', actor, async (context) => {
        const productId = requireText(input.productId, 'productId', 200);
        const offers = normalizeManualOffers(input.offers, 'offers');
        if (!Array.isArray(input.offerIds) || input.offerIds.length !== offers.length) {
          throw new ValidationError('offerIds must name the offer row each declared offer replaces, in order');
        }
        const products = service(names.product);
        const offersService = service(names.offer);
        const product = await products.get(productId);
        requireManageableRow(product, `Product "${product.id}"`);
        await takeoverProviderProduct(products, product, context);
        if (!product.currentVersionId) {
          throw new AppError(`Product "${product.id}" has no current version`, { code: 'COMMERCIAL_STATE_CORRUPT', status: 409 });
        }
        const results = [];
        for (const [index, offer] of offers.entries()) {
          const current = await offersService.get(String(input.offerIds[index]));
          if (current.productId !== product.id) {
            throw new AppError(`Offer "${current.id}" belongs to another product`, { code: 'COMMERCIAL_STATE_CORRUPT', status: 409 });
          }
          if (current.provider !== MANUAL_PROVIDER && isStripeSource(current.provider)) {
            throw new AppError(
              `Offer "${current.id}" is owned by price source "${current.provider}": provider prices are read-only — change them at the source and re-sync`,
              { code: PRICE_SOURCE_READONLY, status: 409 },
            );
          }
          // Fail closed on a stale revision: only the latest revision per
          // logical key may be replaced, otherwise two writers fork history
          // (the loser used to get an obscure unique-violation rollback).
          const [latest] = latestRevisions(await offersService.listWhere({ logicalKey: current.logicalKey }));
          if (!latest || latest.id !== current.id) {
            throw new AppError(
              `Offer "${current.id}" is not the latest revision (latest is "${latest?.id ?? 'none'}"): re-read the catalog and retry`,
              { code: 'STALE_REVISION', status: 409, details: { offerId: current.id, latestOfferId: latest?.id ?? null } },
            );
          }
          const book = await service(names.priceBook).get(current.priceBookId);
          // Converted offers land on the manual book of their currency:
          // provider books are never reused for manual revisions, so sources
          // stay clean (the same rule manual creation follows).
          const targetBook = book.provider === MANUAL_PROVIDER
            ? book
            : await manualBookFor(book.currency, context);
          const declared = {
            name: offer.name,
            currency: targetBook.currency,
            quoteEligible: true,
            unsupportedReason: null,
            productVersionId: product.currentVersionId,
            components: offer.components.map((component, componentIndex) => ({
              sourceKey: component.key,
              label: component.label,
              position: componentIndex + 1,
              chargeType: component.chargeType,
              pricingModel: component.pricingModel,
              interval: component.interval,
              intervalCount: component.intervalCount,
              unitAmountCents: component.unitAmountCents,
              flatAmountCents: component.flatAmountCents,
              externalPriceId: component.externalPriceId,
              sourcePricingModel: `manual:${component.pricingModel}`,
              tiers: component.tiers.map((tier) => ({ position: tier.position, upTo: tier.upTo, unitAmountCents: tier.unitAmountCents, flatAmountCents: tier.flatAmountCents })),
            })),
          };
          const sourceFingerprint = computeDefinitionFingerprint(declared);
          if (current.sourceFingerprint === sourceFingerprint && current.active === offer.active) {
            results.push({ offerId: current.id, revision: current.revision, unchanged: true });
            continue;
          }
          await offersService.applyManaged(current.id, { active: false }, context);
          const created = await persistOfferRevision(
            {
              logicalKey: current.logicalKey,
              revision: current.revision + 1,
              name: offer.name,
              active: offer.active,
              components: offer.components.map((component, componentIndex) => ({ ...component, position: componentIndex + 1 })),
            },
            { priceBookId: targetBook.id, productId: product.id, productVersionId: product.currentVersionId, currency: targetBook.currency },
            context,
          );
          results.push({ offerId: created.id, revision: created.revision, unchanged: false });
        }
        return { productId: product.id, offers: results };
      });
    },

    /** Activate or deactivate a manual product and its current offers. */
    async setActive(input = {}, actor) {
      return runManual('set-manual-product-active', actor, async (context) => {
        const productId = requireText(input.productId, 'productId', 200);
        const active = requireBoolean(input.active, 'active');
        const products = service(names.product);
        const offersService = service(names.offer);
        const product = await products.get(productId);
        requireManageableRow(product, `Product "${product.id}"`);
        await takeoverProviderProduct(products, product, context);
        const updated = await products.applyManaged(product.id, { active }, context);
        // The flag propagates to every current offer revision, including
        // imported ones not yet repriced: the product row is manual from the
        // takeover above, so a later sync of that provider leaves it alone,
        // and the first reprice converts the offers to manual revisions.
        const current = latestRevisions(await offersService.listWhere({ productId: product.id }));
        for (const offer of current) {
          if (offer.active !== active) await offersService.applyManaged(offer.id, { active }, context);
        }
        return { product: { id: updated.id, active: updated.active } };
      });
    },

    /**
     * The backoffice product table (BO-F2-05 "11 Catalogo prodotti"): one row
     * per product with its current description, price source (`manual` or the
     * provider name), active flag and current prices — plus the source summary
     * the "connect Stripe" invite reads (no Stripe source synced yet → invite).
     * Filters: category (exact), active, source ('manual' or a provider name).
     */
    async listProducts(input = {}) {
      const category = optionalText(input.category, 'category', 100);
      const active = input.active === undefined || input.active === null ? null : requireBoolean(input.active, 'active');
      const source = optionalText(input.source, 'source', 120);
      const limit = input.limit === undefined || input.limit === null ? LIST_DEFAULT_LIMIT : input.limit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > LIST_MAX_LIMIT) {
        throw new ValidationError(`limit must be an integer between 1 and ${LIST_MAX_LIMIT}`);
      }
      const products = service(names.product);
      const versions = service(names.productVersion);
      const offersService = service(names.offer);
      const components = service(names.component);
      const tiers = service(names.tier);
      // The source summary answers "is a price source connected" for the
      // whole catalog: it runs over the complete product set BEFORE filters
      // or the row limit, so `source=manual` (or a short page) never reports
      // a synced Stripe source as missing.
      const all = await products.listWhere({});
      const byProvider = {};
      let manual = 0;
      for (const product of all) {
        if (product.sourceKind === 'internal') manual += 1;
        else {
          const name = String(product.provider);
          byProvider[name] = (byProvider[name] ?? 0) + 1;
        }
      }
      const rows = [];
      for (const product of all) {
        if (active !== null && product.active !== active) continue;
        const isManual = product.sourceKind === 'internal';
        const productSource = isManual ? MANUAL_PROVIDER : String(product.provider);
        if (source !== null && productSource !== source) continue;
        const version = product.currentVersionId ? await versions.get(product.currentVersionId) : null;
        if (!version) {
          throw new AppError(`Product "${product.id}" has no current version`, { code: 'COMMERCIAL_STATE_CORRUPT', status: 409 });
        }
        if (category !== null && version.category !== category) continue;
        const offerRows = [];
        for (const offer of latestRevisions(await offersService.listWhere({ productId: product.id }))) {
          const componentRows = [];
          const ordered = (await components.listWhere({ offerId: offer.id })).sort((a, b) => a.position - b.position);
          for (const component of ordered) {
            const schedule = (await tiers.listWhere({ componentId: component.id })).sort((a, b) => a.position - b.position);
            componentRows.push({
              key: component.componentKey ?? null,
              label: component.label,
              chargeType: component.chargeType,
              pricingModel: component.pricingModel,
              interval: component.interval,
              intervalCount: component.intervalCount,
              unitAmountCents: component.unitAmountCents,
              flatAmountCents: component.flatAmountCents,
              externalPriceId: component.externalPriceId,
              sourcePricingModel: component.sourcePricingModel,
              tiers: schedule.map((tier) => ({ upTo: tier.upToQuantity, unitAmountCents: tier.unitAmountCents, flatAmountCents: tier.flatAmountCents })),
            });
          }
          offerRows.push({
            offerId: offer.id,
            name: offer.name,
            active: offer.active,
            currency: offer.currency ?? null,
            quoteEligible: offer.quoteEligible,
            unsupportedReason: offer.unsupportedReason,
            components: componentRows,
          });
        }
        rows.push({
          productId: product.id,
          sku: version.sku,
          name: version.name,
          description: version.description,
          category: version.category,
          unit: version.unit ?? null,
          maxDiscountBps: version.maxDiscountBps ?? null,
          stockQuantity: version.stockQuantity ?? null,
          source: productSource,
          priceReadOnly: !isManual,
          active: product.active,
          version: version.version,
          offers: offerRows,
        });
        if (rows.length >= limit) break;
      }
      return { products: rows, summary: { manual, byProvider, stripeConnected: Object.keys(byProvider).some((name) => name.toLowerCase().includes('stripe')) } };
    },
  };
}
