// @ts-check

import { randomUUID } from 'node:crypto';
import { AppError, ValidationError, normalizeError } from './errors.js';
import { nowIso } from './time.js';
import { writeTrace } from './action-runtime.js';
import { withTimeout } from './intelligence-actions.js';
import { computeDefinitionFingerprint } from './intelligence-registry.js';
import { requireAmount, requireCurrency } from './commercial-money.js';

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
 * Reconciliation semantics: new identities are created; changed commercial
 * data creates a NEW immutable Product Version / Price Book Entry revision
 * (change detected by declared source fingerprints); unchanged identities
 * produce NO writes, audits or events; provider-managed products missing from
 * the payload are deactivated only when the provider declares
 * `config.deactivateMissing: true`. Historical versions/revisions — and any
 * quoted evidence — are never overwritten. Same-input re-sync is idempotent;
 * concurrent syncs serialize on the write lock with unique-key backstops.
 */

const MAX_TEXT = 500;
const KEY_RE = /^[a-z][a-z0-9:._-]{0,199}$/;
const DEFAULT_TIMEOUT_MS = 5_000;

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

/** @param {unknown} value @param {string} field — currency errors are provider-contract errors */
function providerCurrency(value, field) {
  try {
    return requireCurrency(value, field);
  } catch (error) {
    throw new AppError(error instanceof Error ? error.message : `invalid ${field}`, {
      code: 'PROVIDER_INVALID',
      status: 502,
      details: { field },
    });
  }
}

/** Validate + normalize the provider payload; anything off-contract is PROVIDER_INVALID. */
function normalizeCatalog(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppError('Catalog provider returned a non-object result', { code: 'PROVIDER_INVALID', status: 502 });
  }
  const result = /** @type {Record<string, any>} */ (raw);
  const lists = ['priceBooks', 'products', 'entries'];
  for (const list of lists) {
    if (!Array.isArray(result[list])) {
      throw new AppError(`Catalog provider result needs a "${list}" array`, { code: 'PROVIDER_INVALID', status: 502 });
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
    currency: providerCurrency(book?.currency, 'priceBook.currency'),
    active: requireBoolean(book?.active ?? true, 'priceBook.active'),
  }));
  const products = result.products.map((product) => ({
    sourceKey: unique(requireSourceKey(product?.sourceKey, 'product.sourceKey'), 'product'),
    externalId: optionalText(product?.externalId, 'product.externalId', 200),
    sku: requireText(product?.sku, 'product.sku', 100),
    name: requireText(product?.name, 'product.name', 200),
    description: optionalText(product?.description, 'product.description'),
    category: optionalText(product?.category, 'product.category', 100),
    active: requireBoolean(product?.active ?? true, 'product.active'),
  }));
  const bookByKey = new Map(priceBooks.map((book) => [book.sourceKey, book]));
  const productKeys = new Set(products.map((product) => product.sourceKey));
  const entries = result.entries.map((entry) => {
    const priceBookSourceKey = requireSourceKey(entry?.priceBookSourceKey, 'entry.priceBookSourceKey');
    const productSourceKey = requireSourceKey(entry?.productSourceKey, 'entry.productSourceKey');
    const book = bookByKey.get(priceBookSourceKey);
    if (!book) {
      throw new AppError(`Catalog entry references unknown price book "${priceBookSourceKey}"`, { code: 'PROVIDER_INVALID', status: 502 });
    }
    if (!productKeys.has(productSourceKey)) {
      throw new AppError(`Catalog entry references unknown product "${productSourceKey}"`, { code: 'PROVIDER_INVALID', status: 502 });
    }
    const pricingMode = entry?.pricingMode;
    if (pricingMode !== 'one_time' && pricingMode !== 'recurring') {
      throw new AppError('Catalog entry pricingMode must be "one_time" or "recurring"', { code: 'PROVIDER_INVALID', status: 502 });
    }
    let recurringInterval = null;
    if (pricingMode === 'recurring') {
      if (entry?.recurringInterval !== 'month' && entry?.recurringInterval !== 'year') {
        throw new AppError('Recurring catalog entries need recurringInterval "month" or "year"', { code: 'PROVIDER_INVALID', status: 502 });
      }
      recurringInterval = entry.recurringInterval;
    }
    let unitAmountCents;
    try {
      unitAmountCents = requireAmount(entry?.unitAmountCents, 'entry.unitAmountCents');
    } catch (error) {
      throw new AppError(error instanceof Error ? error.message : 'invalid unitAmountCents', { code: 'PROVIDER_INVALID', status: 502 });
    }
    const currency = providerCurrency(entry?.currency ?? book.currency, 'entry.currency');
    if (currency !== book.currency) {
      throw new AppError(`Catalog entry currency ${currency} does not match price book ${book.currency}`, { code: 'PROVIDER_INVALID', status: 502 });
    }
    return {
      sourceKey: unique(requireSourceKey(entry?.sourceKey, 'entry.sourceKey'), 'entry'),
      productSourceKey,
      priceBookSourceKey,
      unitAmountCents,
      currency,
      pricingMode,
      recurringInterval,
      active: requireBoolean(entry?.active ?? true, 'entry.active'),
    };
  });
  return {
    sourceRef: optionalText(result.sourceRef, 'sourceRef', 200),
    priceBooks,
    products,
    entries,
  };
}

/**
 * @param {{database: any, events: any, modules: any, commercial: any, config?: any, moduleNames?: Partial<{product: string, productVersion: string, priceBook: string, priceBookEntry: string, syncRun: string}>}} deps
 */
export function createCatalogSync({ database, events, modules, commercial, config = {}, moduleNames = {} }) {
  const names = {
    product: moduleNames.product ?? 'product',
    productVersion: moduleNames.productVersion ?? 'product-version',
    priceBook: moduleNames.priceBook ?? 'price-book',
    priceBookEntry: moduleNames.priceBookEntry ?? 'price-book-entry',
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

  /**
   * @param {{provider: string, input?: unknown, actor?: unknown}} params
   */
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
      steps.push({ name: 'catalog.fetch', status: 'completed', output: { provider: provider.name, priceBooks: catalog.priceBooks.length, products: catalog.products.length, entries: catalog.entries.length } });

      output = await events.buffered(async (outbox) => {
        const value = await database.transactionAsync(async () => {
          const counts = { priceBooksCreated: 0, productsCreated: 0, versionsCreated: 0, entriesCreated: 0, entriesRevised: 0, unchanged: 0, deactivated: 0 };
          const products = service(names.product);
          const versions = service(names.productVersion);
          const books = service(names.priceBook);
          const entriesService = service(names.priceBookEntry);
          const context = { actor };

          /** @type {Map<string, any>} */
          const bookIdByKey = new Map();
          for (const book of catalog.priceBooks) {
            const existing = books.listWhere({ sourceKey: book.sourceKey })[0];
            if (!existing) {
              const created = await books.createManaged(
                { sourceKey: book.sourceKey, name: book.name, currency: book.currency, sourceKind: 'provider', provider: provider.name, active: book.active },
                context,
              );
              counts.priceBooksCreated += 1;
              bookIdByKey.set(book.sourceKey, created);
              continue;
            }
            if (existing.currency !== book.currency) {
              throw new AppError(
                `Price book "${book.sourceKey}" currency is immutable (stored ${existing.currency}, provider sent ${book.currency})`,
                { code: 'SYNC_CONFLICT', status: 409 },
              );
            }
            if (existing.name !== book.name || existing.active !== book.active) {
              bookIdByKey.set(book.sourceKey, await books.applyManaged(existing.id, { name: book.name, active: book.active }, context));
            } else {
              counts.unchanged += 1;
              bookIdByKey.set(book.sourceKey, existing);
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

          for (const incoming of catalog.entries) {
            const bookRecord = bookIdByKey.get(incoming.priceBookSourceKey);
            const productInfo = productByKey.get(incoming.productSourceKey);
            const pricingData = {
              unitAmountCents: incoming.unitAmountCents,
              currency: incoming.currency,
              pricingMode: incoming.pricingMode,
              recurringInterval: incoming.recurringInterval,
              active: incoming.active,
              productVersionId: productInfo?.versionId ?? null,
            };
            const sourceFingerprint = computeDefinitionFingerprint(pricingData);
            const revisions = entriesService.listWhere({ logicalKey: incoming.sourceKey });
            const current = revisions.sort((a, b) => b.revision - a.revision)[0];
            if (!current) {
              await entriesService.createManaged(
                {
                  logicalKey: incoming.sourceKey, revision: 1, sourceKey: `${incoming.sourceKey}:1`,
                  priceBookId: bookRecord.id, productId: productInfo.product.id, productVersionId: productInfo.versionId,
                  provider: provider.name, ...pricingData, sourceFingerprint,
                },
                context,
              );
              counts.entriesCreated += 1;
              continue;
            }
            if (current.sourceFingerprint === sourceFingerprint) {
              counts.unchanged += 1;
              continue;
            }
            await entriesService.applyManaged(current.id, { active: false }, context);
            await entriesService.createManaged(
              {
                logicalKey: incoming.sourceKey, revision: current.revision + 1, sourceKey: `${incoming.sourceKey}:${current.revision + 1}`,
                priceBookId: bookRecord.id, productId: productInfo.product.id, productVersionId: productInfo.versionId,
                provider: provider.name, ...pricingData, sourceFingerprint,
              },
              context,
            );
            counts.entriesRevised += 1;
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

export { normalizeCatalog };
export { ValidationError };
