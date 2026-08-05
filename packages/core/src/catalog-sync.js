// @ts-check

import { randomUUID } from 'node:crypto';
import { AppError, ValidationError, normalizeError } from './errors.js';
import { nowIso } from './time.js';
import { writeTrace } from './action-runtime.js';
import { withTimeout } from './intelligence-actions.js';
import { computeDefinitionFingerprint } from './intelligence-registry.js';
import { requireAmount, requireCurrency, validatePriceComponent } from './commercial-money.js';

/**
 * Catalog synchronization (ADR-016): pull a provider's normalized catalog into
 * immutable commercial records.
 *
 *   validate provider → fetchCatalog OUTSIDE any transaction (bounded timeout,
 *   late settlement abandoned — ADR-015 discipline) → validate + normalize →
 *   ONE BEGIN IMMEDIATE transaction reconciling by DB-unique source keys →
 *   CatalogSyncRun evidence → commit → dispatch buffered events → best-effort
 *   trace.
 *
 * Catalog shape (ADR-016 corrected model):
 *
 *   Product → ProductVersion → Offer (rate plan) → PriceComponent(s) → Tier(s)
 *
 * An Offer is the sellable package; it may carry several components mixing
 * one-time and recurring charges with flat_fee / per_unit / volume /
 * graduated pricing. **An Offer is versioned as a whole**: its declared
 * commercial data (name, every component and every tier) is fingerprinted, and
 * any change creates a NEW offer revision with new immutable component and
 * tier rows while the previous revision is deactivated. Quote lines pin an
 * offer revision, so quoted evidence can never be rewritten by later catalog
 * movement.
 *
 * Unsupported provider models (metered usage, overage, proration, ramps,
 * minimum commitments, attribute-based/dynamic pricing, tax-inclusive
 * computation, FX, custom formulas) are **never approximated as flat prices**:
 * the offer is persisted with `quoteEligible = false` and a bounded
 * `unsupportedReason`, and none of its components are stored.
 */

const MAX_TEXT = 500;
const KEY_RE = /^[a-z][a-z0-9:._-]{0,199}$/;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_COMPONENTS = 25;

/** @param {unknown} value @param {string} field @param {number} [max] */
function requireText(value, field, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new AppError(`Catalog provider returned an invalid "${field}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field } });
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
function optionalText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, max);
}

/** @param {unknown} value @param {string} field */
function requireSourceKey(value, field) {
  if (typeof value !== 'string' || !KEY_RE.test(value)) {
    throw new AppError(`Catalog provider returned an invalid "${field}" (canonical source keys only)`, {
      code: 'PROVIDER_INVALID',
      status: 502,
      details: { field },
    });
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw new AppError(`Catalog provider returned an invalid "${field}" (boolean required)`, {
      code: 'PROVIDER_INVALID',
      status: 502,
      details: { field },
    });
  }
  return value;
}

/** Currency/amount errors from a provider payload are provider-contract errors. */
function providerChecked(fn, field) {
  try {
    return fn();
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : `invalid ${field}`, {
      code: 'PROVIDER_INVALID',
      status: 502,
      details: { field },
    });
  }
}

/**
 * Validate + normalize the provider payload. Anything off-contract is
 * PROVIDER_INVALID — the framework never persists unvalidated third-party data
 * and never stores raw payloads or secrets.
 */
function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Catalog provider returned a non-object result', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const result = /** @type {Record<string, any>} */ (raw);
  for (const list of ['priceBooks', 'products', 'offers']) {
    if (!Array.isArray(result[list])) {
      throw new AppError(`Catalog provider result needs an "${list}" array`, { code: 'PROVIDER_INVALID', status: 502 });
    }
  }
  const seen = new Set();
  const unique = (key, kind) => {
    const scoped = `${kind}:${key}`;
    if (seen.has(scoped)) {
      throw new AppError(`Catalog provider returned duplicate ${kind} sourceKey "${key}"`, { code: 'PROVIDER_INVALID', status: 502 });
    }
    seen.add(scoped);
    return key;
  };

  const priceBooks = result.priceBooks.map((book) => ({
    sourceKey: unique(requireSourceKey(book?.sourceKey, 'priceBook.sourceKey'), 'price-book'),
    name: requireText(book?.name, 'priceBook.name', 200),
    currency: providerChecked(() => requireCurrency(book?.currency, 'priceBook.currency'), 'priceBook.currency'),
    active: requireBoolean(book?.active ?? true, 'priceBook.active'),
  }));
  const externalProductIds = new Set();
  const products = result.products.map((product) => {
    const externalId = optionalText(product?.externalId, 'product.externalId', 200);
    if (externalId !== null) {
      if (externalProductIds.has(externalId)) {
        throw new AppError(`Catalog provider returned duplicate product externalId "${externalId}"`, { code: 'PROVIDER_INVALID', status: 502 });
      }
      externalProductIds.add(externalId);
    }
    return {
      sourceKey: unique(requireSourceKey(product?.sourceKey, 'product.sourceKey'), 'product'),
      externalId,
      sku: requireText(product?.sku, 'product.sku', 100),
      name: requireText(product?.name, 'product.name', 200),
      description: optionalText(product?.description, 'product.description'),
      category: optionalText(product?.category, 'product.category', 100),
      active: requireBoolean(product?.active ?? true, 'product.active'),
    };
  });

  const bookByKey = new Map(priceBooks.map((book) => [book.sourceKey, book]));
  const productKeys = new Set(products.map((product) => product.sourceKey));
  const offers = result.offers.map((offer) => {
    const sourceKey = unique(requireSourceKey(offer?.sourceKey, 'offer.sourceKey'), 'offer');
    const priceBookSourceKey = requireSourceKey(offer?.priceBookSourceKey, 'offer.priceBookSourceKey');
    const productSourceKey = requireSourceKey(offer?.productSourceKey, 'offer.productSourceKey');
    const book = bookByKey.get(priceBookSourceKey);
    if (!book) {
      throw new AppError(`Offer "${sourceKey}" references unknown price book "${priceBookSourceKey}"`, { code: 'PROVIDER_INVALID', status: 502 });
    }
    if (!productKeys.has(productSourceKey)) {
      throw new AppError(`Offer "${sourceKey}" references unknown product "${productSourceKey}"`, { code: 'PROVIDER_INVALID', status: 502 });
    }
    const rawComponents = offer?.components;
    if (!Array.isArray(rawComponents) || rawComponents.length === 0) {
      throw new AppError(`Offer "${sourceKey}" needs at least one price component`, { code: 'PROVIDER_INVALID', status: 502 });
    }
    if (rawComponents.length > MAX_COMPONENTS) {
      throw new AppError(`Offer "${sourceKey}" exceeds the ${MAX_COMPONENTS}-component bound`, { code: 'PROVIDER_INVALID', status: 502 });
    }

    // Unsupported provider models are preserved as provenance, never
    // approximated: the offer becomes ineligible for quoting and no component
    // rows are stored for it.
    const unsupported = rawComponents.find((component) => typeof component?.unsupportedModel === 'string' && component.unsupportedModel !== '');
    if (unsupported) {
      return {
        sourceKey,
        priceBookSourceKey,
        productSourceKey,
        name: requireText(offer?.name, 'offer.name', 200),
        currency: book.currency,
        active: requireBoolean(offer?.active ?? true, 'offer.active'),
        externalOfferId: optionalText(offer?.externalOfferId, 'offer.externalOfferId', 200),
        quoteEligible: false,
        unsupportedReason: requireText(
          offer?.unsupportedReason ?? `provider pricing model "${unsupported.unsupportedModel}" is not supported for quoting`,
          'offer.unsupportedReason',
        ),
        components: [],
      };
    }

    const componentKeys = new Set();
    const components = rawComponents.map((component, index) => {
      const componentKey = requireSourceKey(component?.sourceKey, 'component.sourceKey');
      if (componentKeys.has(componentKey)) {
        throw new AppError(`Offer "${sourceKey}" returned duplicate component sourceKey "${componentKey}"`, { code: 'PROVIDER_INVALID', status: 502 });
      }
      componentKeys.add(componentKey);
      const normalized = providerChecked(
        () => validatePriceComponent(component, `Offer "${sourceKey}" component "${componentKey}"`),
        'component',
      );
      return {
        ...normalized,
        sourceKey: componentKey,
        label: requireText(component?.label, 'component.label', 200),
        position: index + 1,
        externalPriceId: optionalText(component?.externalPriceId, 'component.externalPriceId', 200),
        sourcePricingModel: optionalText(component?.sourcePricingModel, 'component.sourcePricingModel', 100),
      };
    });
    return {
      sourceKey,
      priceBookSourceKey,
      productSourceKey,
      name: requireText(offer?.name, 'offer.name', 200),
      currency: book.currency,
      active: requireBoolean(offer?.active ?? true, 'offer.active'),
      externalOfferId: optionalText(offer?.externalOfferId, 'offer.externalOfferId', 200),
      quoteEligible: true,
      unsupportedReason: null,
      components,
    };
  });

  return {
    sourceRef: optionalText(result.sourceRef, 'sourceRef', 200),
    priceBooks,
    products,
    offers,
  };
}

/**
 * @param {{database: any, events: any, modules: any, commercial: any, config?: any, moduleNames?: Record<string, string>}} deps
 */
export function createCatalogSync({ database, events, modules, commercial, config = {}, moduleNames = {} }) {
  const names = {
    product: moduleNames.product ?? 'product',
    productVersion: moduleNames.productVersion ?? 'product-version',
    priceBook: moduleNames.priceBook ?? 'price-book',
    offer: moduleNames.offer ?? 'offer',
    component: moduleNames.component ?? 'price-component',
    tier: moduleNames.tier ?? 'price-tier',
    syncRun: moduleNames.syncRun ?? 'catalog-sync-run',
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

  /** @param {{provider: string, input?: unknown, actor?: unknown}} params */
  return async function syncCatalog({ provider: providerName, input, actor }) {
    const runId = randomUUID();
    const startedAt = nowIso();
    /** @type {Array<{name: string, status: string, output?: unknown, error?: string}>} */
    const steps = [];
    /** @type {any} */
    let failure = null;
    /** @type {any} */
    let output = null;
    try {
      const { definition: provider, fingerprint } = commercial.getCatalogProvider(providerName);
      const timeoutMs = Number.isSafeInteger(config.catalogTimeoutMs) && config.catalogTimeoutMs > 0
        ? config.catalogTimeoutMs
        : DEFAULT_TIMEOUT_MS;
      /** @type {unknown} */
      let raw;
      try {
        raw = await withTimeout(
          Promise.resolve(provider.fetchCatalog(input ?? {}, { now: nowIso })),
          timeoutMs,
          `Catalog provider "${provider.name}"`,
        );
      } catch (error) {
        if (error instanceof AppError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new AppError(`Catalog provider "${provider.name}" failed: ${message.slice(0, 200)}`, { code: 'PROVIDER_FAILED', status: 502 });
      }
      const catalog = normalizeCatalog(raw);
      steps.push({
        name: 'catalog.fetch',
        status: 'completed',
        output: { provider: provider.name, priceBooks: catalog.priceBooks.length, products: catalog.products.length, offers: catalog.offers.length },
      });

      output = await events.buffered(async (outbox) => {
        const value = await database.transactionAsync(async () => {
          const counts = {
            priceBooksCreated: 0,
            productsCreated: 0,
            versionsCreated: 0,
            offersCreated: 0,
            offersRevised: 0,
            componentsCreated: 0,
            tiersCreated: 0,
            unchanged: 0,
            deactivated: 0,
            ineligibleOffers: 0,
          };
          const products = service(names.product);
          const versions = service(names.productVersion);
          const books = service(names.priceBook);
          const offers = service(names.offer);
          const components = service(names.component);
          const tiers = service(names.tier);
          const context = { actor };

          /** @type {Map<string, any>} */
          const bookByKey = new Map();
          for (const book of catalog.priceBooks) {
            const existing = books.listWhere({ sourceKey: book.sourceKey })[0];
            if (!existing) {
              const created = await books.createManaged(
                { sourceKey: book.sourceKey, name: book.name, currency: book.currency, sourceKind: 'provider', provider: provider.name, active: book.active },
                context,
              );
              counts.priceBooksCreated += 1;
              bookByKey.set(book.sourceKey, created);
              continue;
            }
            if (existing.currency !== book.currency) {
              throw new AppError(
                `Price book "${book.sourceKey}" currency is immutable (stored ${existing.currency}, provider sent ${book.currency})`,
                { code: 'SYNC_CONFLICT', status: 409 },
              );
            }
            if (existing.name !== book.name || existing.active !== book.active) {
              bookByKey.set(book.sourceKey, await books.applyManaged(existing.id, { name: book.name, active: book.active }, context));
            } else {
              counts.unchanged += 1;
              bookByKey.set(book.sourceKey, existing);
            }
          }

          /** @type {Map<string, {product: any, versionId: string}>} */
          const productByKey = new Map();
          for (const incoming of catalog.products) {
            const commercialData = { sku: incoming.sku, name: incoming.name, description: incoming.description, category: incoming.category };
            const sourceFingerprint = computeDefinitionFingerprint(commercialData);
            const existing = products.listWhere({ sourceKey: incoming.sourceKey })[0];
            if (!existing) {
              const product = await products.createManaged(
                { sourceKey: incoming.sourceKey, sourceKind: 'provider', provider: provider.name, externalId: incoming.externalId, active: incoming.active },
                context,
              );
              const version = await versions.createManaged(
                {
                  productId: product.id, version: 1, sourceKey: `pv:${incoming.sourceKey}:1`,
                  ...commercialData,
                  provider: provider.name, providerVersion: provider.version, providerFingerprint: fingerprint,
                  sourceFingerprint, effectiveAt: startedAt,
                },
                context,
              );
              const updated = await products.applyManaged(product.id, { currentVersionId: version.id }, context);
              counts.productsCreated += 1;
              counts.versionsCreated += 1;
              productByKey.set(incoming.sourceKey, { product: updated, versionId: version.id });
              continue;
            }
            if (existing.externalId !== incoming.externalId) {
              throw new AppError(
                `Product "${incoming.sourceKey}" external id is immutable (stored ${existing.externalId ?? 'null'}, provider sent ${incoming.externalId ?? 'null'}) — a re-parented identity must use a new source key`,
                { code: 'SYNC_CONFLICT', status: 409 },
              );
            }
            const currentVersion = existing.currentVersionId ? versions.get(existing.currentVersionId) : null;
            let versionId = currentVersion?.id ?? null;
            if (!currentVersion || currentVersion.sourceFingerprint !== sourceFingerprint) {
              const nextNumber = versions.countWhere({ productId: existing.id }) + 1;
              const version = await versions.createManaged(
                {
                  productId: existing.id, version: nextNumber, sourceKey: `pv:${incoming.sourceKey}:${nextNumber}`,
                  ...commercialData,
                  provider: provider.name, providerVersion: provider.version, providerFingerprint: fingerprint,
                  sourceFingerprint, effectiveAt: nowIso(),
                },
                context,
              );
              await products.applyManaged(existing.id, { currentVersionId: version.id, active: incoming.active }, context);
              counts.versionsCreated += 1;
              versionId = version.id;
            } else if (existing.active !== incoming.active) {
              await products.applyManaged(existing.id, { active: incoming.active }, context);
            } else {
              counts.unchanged += 1;
            }
            productByKey.set(incoming.sourceKey, { product: existing, versionId });
          }

          for (const incoming of catalog.offers) {
            const book = bookByKey.get(incoming.priceBookSourceKey);
            const productInfo = productByKey.get(incoming.productSourceKey);
            // The offer is versioned AS A WHOLE: its declared commercial data
            // — name, eligibility, the ordered component list and every tier —
            // is fingerprinted, so any pricing change produces a new immutable
            // revision instead of mutating history.
            const declared = {
              name: incoming.name,
              currency: incoming.currency,
              quoteEligible: incoming.quoteEligible,
              unsupportedReason: incoming.unsupportedReason,
              productVersionId: productInfo?.versionId ?? null,
              components: incoming.components.map((component) => ({
                sourceKey: component.sourceKey,
                label: component.label,
                position: component.position,
                chargeType: component.chargeType,
                pricingModel: component.pricingModel,
                interval: component.interval,
                intervalCount: component.intervalCount,
                unitAmountCents: component.unitAmountCents,
                flatAmountCents: component.flatAmountCents,
                externalPriceId: component.externalPriceId,
                sourcePricingModel: component.sourcePricingModel,
                tiers: component.tiers.map((tier) => ({ position: tier.position, upTo: tier.upTo, unitAmountCents: tier.unitAmountCents, flatAmountCents: tier.flatAmountCents })),
              })),
            };
            const sourceFingerprint = computeDefinitionFingerprint(declared);
            const revisions = offers.listWhere({ logicalKey: incoming.sourceKey });
            const current = revisions.sort((a, b) => b.revision - a.revision)[0];
            if (current && current.sourceFingerprint === sourceFingerprint && current.active === incoming.active) {
              counts.unchanged += 1;
              if (!incoming.quoteEligible) counts.ineligibleOffers += 1;
              continue;
            }
            if (current) await offers.applyManaged(current.id, { active: false }, context);
            const revision = (current?.revision ?? 0) + 1;
            const offer = await offers.createManaged(
              {
                logicalKey: incoming.sourceKey,
                revision,
                sourceKey: `${incoming.sourceKey}:${revision}`,
                priceBookId: book.id,
                productId: productInfo.product.id,
                productVersionId: productInfo.versionId,
                name: incoming.name,
                currency: incoming.currency,
                active: incoming.active,
                quoteEligible: incoming.quoteEligible,
                unsupportedReason: incoming.unsupportedReason,
                provider: provider.name,
                providerVersion: provider.version,
                providerFingerprint: fingerprint,
                externalOfferId: incoming.externalOfferId,
                componentCount: incoming.components.length,
                sourceFingerprint,
              },
              context,
            );
            if (current) counts.offersRevised += 1;
            else counts.offersCreated += 1;
            if (!incoming.quoteEligible) counts.ineligibleOffers += 1;
            for (const component of incoming.components) {
              const created = await components.createManaged(
                {
                  offerId: offer.id,
                  sourceKey: `${offer.sourceKey}:${component.sourceKey}`,
                  componentKey: component.sourceKey,
                  label: component.label,
                  position: component.position,
                  chargeType: component.chargeType,
                  pricingModel: component.pricingModel,
                  interval: component.interval,
                  intervalCount: component.intervalCount,
                  unitAmountCents: component.unitAmountCents,
                  flatAmountCents: component.flatAmountCents,
                  currency: incoming.currency,
                  provider: provider.name,
                  externalPriceId: component.externalPriceId,
                  sourcePricingModel: component.sourcePricingModel,
                  tierCount: component.tiers.length,
                },
                context,
              );
              counts.componentsCreated += 1;
              for (const tier of component.tiers) {
                await tiers.createManaged(
                  {
                    componentId: created.id,
                    sourceKey: `${created.sourceKey}:t${tier.position}`,
                    position: tier.position,
                    upToQuantity: tier.upTo,
                    unitAmountCents: tier.unitAmountCents,
                    flatAmountCents: tier.flatAmountCents,
                  },
                  context,
                );
                counts.tiersCreated += 1;
              }
            }
          }

          // Provider-managed products missing from the payload: deactivate only
          // under the provider's explicit declared policy.
          if (provider.config?.deactivateMissing === true) {
            const sent = new Set(catalog.products.map((product) => product.sourceKey));
            for (const record of products.listWhere({ provider: provider.name, sourceKind: 'provider', active: true })) {
              if (!sent.has(record.sourceKey)) {
                await products.applyManaged(record.id, { active: false }, context);
                counts.deactivated += 1;
              }
            }
            const sentOffers = new Set(catalog.offers.map((offer) => offer.sourceKey));
            for (const record of offers.listWhere({ provider: provider.name, active: true })) {
              if (!sentOffers.has(record.logicalKey)) {
                await offers.applyManaged(record.id, { active: false }, context);
                counts.deactivated += 1;
              }
            }
          }

          const run = await service(names.syncRun).createManaged(
            {
              provider: provider.name, providerVersion: provider.version, providerFingerprint: fingerprint,
              sourceRef: catalog.sourceRef, startedAt, completedAt: nowIso(), status: 'completed',
              ...counts,
            },
            context,
          );
          steps.push({ name: 'catalog.reconcile', status: 'completed', output: counts });
          return { ok: true, runId: run.id, provider: provider.name, providerVersion: provider.version, counts };
        });
        try {
          await outbox.commit();
        } catch (error) {
          const dispatchFailure = normalizeError(error);
          steps.push({ name: 'events.dispatch', status: 'failed', error: dispatchFailure.message });
          console.error(`[agent-crm] catalog.sync run ${runId}: business writes committed but event dispatch failed: ${dispatchFailure.message}`);
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
          workflowName: 'catalog.sync',
          status: failure ? 'failed' : 'completed',
          input: { provider: providerName, actor: actor && typeof actor === 'object' ? { type: /** @type {any} */ (actor).type ?? null, id: /** @type {any} */ (actor).id ?? null } : null },
          output: failure ? null : output,
          error: failure ? failure.message : null,
          startedAt,
          steps,
        });
      } catch (traceError) {
        console.error(`[agent-crm] catalog.sync run ${runId}: failed to persist trace: ${traceError instanceof Error ? traceError.message : String(traceError)}`);
      }
    }
  };
}

export { normalizeCatalog, ValidationError };
