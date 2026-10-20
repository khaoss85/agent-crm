// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { requireCurrency } from './money.js';
import { validateCatalogProvider } from './registry.js';

/**
 * Stripe catalog source (BO-F2-05): a declared catalog provider that maps
 * Stripe Products/Prices into the normalized catalog `syncCatalog`
 * persists — with the Stripe identity kept as provenance (`externalId` /
 * `externalPriceId`, `sourcePricingModel: 'stripe:…'`).
 *
 * Credentials do not exist yet (owner decision MEM_ACC_DECISIONS), so the
 * client is injected: tests and development pass `createFixtureStripeCatalogClient()`
 * (deterministic Stripe-shaped data, no network); the real adapter takes its
 * place tomorrow behind the same `{ listProducts, listPrices }` edge without
 * touching the mapping or the sync. The fixture's data lives in the closure,
 * not in the fingerprinted `config` — the same honest limitation the starter
 * fixture provider already carries: a changed fixture under a frozen version
 * is drift the registry cannot see.
 *
 * Mapping (documented, tested):
 *   Stripe Product            → product (sourceKey `stripe.<name>.product.<id>`,
 *                               externalId = Stripe id, sku = metadata.sku or
 *                               the Stripe id, category = metadata.category)
 *   one price book per currency (`stripe.<name>.book.<CUR>`, "Stripe <CUR>")
 *   one offer PER PRICE (`stripe.<name>.offer.<price-id>`) so a price Stripe
 *   cannot express never poisons its siblings: metered prices
 *   (`recurring.usage_type: 'metered'`, the real Stripe marker — never a
 *   top-level flag) and non-month/year recurrences sync as
 *   `quoteEligible: false` offers with an `unsupportedReason`, everything
 *   else stays quotable.
 *   simple unit prices       → per_unit (one_time, or recurring month/year —
 *                               Stripe has no flat fee; quantity lives on the
 *                               quote line, fixed fees belong to the manual
 *                               listino or to tiers)
 *   tiers_mode volume/graduated → volume/graduated components (up_to null =
 *                               open-ended, as the tier validator requires)
 *   inactive products        → synced with active:false (the backoffice table
 *                               shows them as not active); inactive prices are
 *                               skipped (they are not sellable)
 *
 * Source keys are canonical: Stripe ids are lowercased into KEY_RE shape and
 * a case-collision between two Stripe ids is PROVIDER_INVALID, never a merge.
 */

const KEY_RE = /^[a-z][a-z0-9:._-]{0,199}$/;
const MAX_TEXT = 500;

/** @param {unknown} value @param {string} field */
function requireText(value, field, max = MAX_TEXT) {
  if (typeof value !== 'string' || value.trim() === '' || value.length > max) {
    throw new AppError(`Stripe catalog sent an invalid "${field}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field } });
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
function optionalText(value, field, max = MAX_TEXT) {
  if (value === undefined || value === null) return null;
  return requireText(value, field, max);
}

/** @param {string} id @param {string} field */
function slugifyStripeId(id, field) {
  requireText(id, field, 200);
  const slug = String(id).toLowerCase().replace(/[^a-z0-9:._-]+/g, '-');
  if (!KEY_RE.test(slug)) {
    throw new AppError(`Stripe catalog id is not usable as a source key: "${field}"`, { code: 'PROVIDER_INVALID', status: 502, details: { field } });
  }
  return slug;
}

/**
 * Deterministic fake Stripe client: Stripe-shaped Products/Prices, no network,
 * no credentials, no secrets. Covers every mapping branch: one-time and
 * recurring per-unit prices, volume and graduated tiers, a metered price
 * (unsupported), a non-month/year recurrence (unsupported), inactive rows.
 */
export function createFixtureStripeCatalogClient() {
  const products = [
    { id: 'prod_yoga', name: 'Corso Yoga', description: 'Abbonamento al corso di yoga.', active: true, metadata: { sku: 'YOGA', category: 'corsi' } },
    { id: 'prod_pilates', name: 'Pilates', description: 'Pacchetto di lezioni di pilates.', active: true, metadata: { sku: 'PILATES', category: 'corsi' } },
    { id: 'prod_sala', name: 'Sala pesi', description: 'Accesso alla sala pesi.', active: false, metadata: { sku: 'SALA', category: 'abbonamenti' } },
  ];
  const prices = [
    { id: 'price_yoga_mese', product: 'prod_yoga', active: true, currency: 'eur', unit_amount: 4900, billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1 }, nickname: 'Canone mensile' },
    { id: 'price_yoga_singola', product: 'prod_yoga', active: true, currency: 'eur', unit_amount: 1500, billing_scheme: 'per_unit', nickname: 'Lezione singola' },
    {
      id: 'price_pilates_pacchetto', product: 'prod_pilates', active: true, currency: 'eur', billing_scheme: 'tiered', tiers_mode: 'volume', nickname: 'Pacchetto 10 lezioni',
      tiers: [
        { up_to: 10, unit_amount: 1200 },
        { up_to: null, unit_amount: 1000 },
      ],
    },
    {
      id: 'price_pilates_giornaliero', product: 'prod_pilates', active: true, currency: 'eur', billing_scheme: 'tiered', tiers_mode: 'graduated', recurring: { interval: 'month', interval_count: 1 }, nickname: 'Giornaliero a scaglioni',
      tiers: [
        { up_to: 8, unit_amount: 800 },
        { up_to: null, unit_amount: 600 },
      ],
    },
    { id: 'price_yoga_misurato', product: 'prod_yoga', active: true, currency: 'eur', unit_amount: 100, billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'metered' }, nickname: 'Consumo misurato' },
    { id: 'price_yoga_settimanale', product: 'prod_yoga', active: true, currency: 'eur', unit_amount: 2000, billing_scheme: 'per_unit', recurring: { interval: 'week', interval_count: 1 }, nickname: 'Canone settimanale' },
    { id: 'price_yoga_vecchio', product: 'prod_yoga', active: false, currency: 'eur', unit_amount: 4500, billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1 }, nickname: 'Canone vecchio' },
  ];
  return {
    source: 'stripe-fixture',
    async listProducts() {
      return structuredClone(products);
    },
    async listPrices() {
      return structuredClone(prices);
    },
  };
}

/** @param {unknown} client */
function requireStripeClient(client) {
  if (!client || typeof client !== 'object') {
    throw new ValidationError('stripe catalog provider needs a Stripe client with listProducts and listPrices');
  }
  const candidate = /** @type {Record<string, unknown>} */ (client);
  if (typeof candidate.listProducts !== 'function' || typeof candidate.listPrices !== 'function') {
    throw new ValidationError('stripe catalog provider needs a Stripe client with listProducts and listPrices functions');
  }
  return /** @type {{ listProducts: () => Promise<any[]>, listPrices: () => Promise<any[]> }} */ (candidate);
}

/**
 * Map one Stripe price to its offer component, or to the unsupported marker
 * when the framework cannot price it (metered usage, non-month/year
 * recurrence). Incoherent data is PROVIDER_INVALID — the framework never
 * persists unvalidated third-party data.
 */
function mapPriceComponent(price) {
  const priceId = requireText(price?.id, 'price.id', 200);
  const label = optionalText(price?.nickname, 'price.nickname', 200)
    ?? `${requireText(price?.productName, 'price.productName', 200)} (${requireText(price?.currency, 'price.currency', 10)})`;
  const recurring = price?.recurring ?? null;
  if (recurring !== null && recurring !== undefined && (typeof recurring !== 'object' || Array.isArray(recurring))) {
    throw new AppError('Stripe catalog sent an invalid "price.recurring"', { code: 'PROVIDER_INVALID', status: 502, details: { field: 'price.recurring' } });
  }
  // Real Stripe marks metered billing as recurring.usage_type 'metered' (there
  // is no top-level metered flag): a metered price never becomes a quotable
  // per_unit component. 'licensed' usage prices normally.
  if (recurring !== null && recurring !== undefined && recurring.usage_type === 'metered') {
    return { unsupported: true, unsupportedModel: 'metered', label, priceId };
  }
  if (recurring !== null && recurring !== undefined) {
    const interval = requireText(recurring.interval, 'price.recurring.interval', 20);
    if (interval !== 'month' && interval !== 'year') {
      return { unsupported: true, unsupportedModel: 'recurring-interval', label, priceId };
    }
  }
  if (price?.tiers_mode === 'volume' || price?.tiers_mode === 'graduated') {
    const tiers = price?.tiers;
    if (!Array.isArray(tiers) || tiers.length === 0) {
      throw new AppError(`Stripe price "${priceId}" declares ${price.tiers_mode} pricing with no tiers`, { code: 'PROVIDER_INVALID', status: 502, details: { field: 'price.tiers' } });
    }
    return {
      unsupported: false,
      component: {
        chargeType: recurring ? 'recurring' : 'one_time',
        pricingModel: price.tiers_mode,
        interval: recurring ? requireText(recurring.interval, 'price.recurring.interval', 20) : null,
        intervalCount: recurring ? requireIntervalCount(recurring.interval_count) : null,
        tiers: tiers.map((tier, index) => {
          if (!tier || typeof tier !== 'object') {
            throw new AppError(`Stripe price "${priceId}" has an invalid tier ${index + 1}`, { code: 'PROVIDER_INVALID', status: 502, details: { field: 'price.tiers' } });
          }
          return {
            upTo: tier.up_to === null || tier.up_to === undefined ? null : tier.up_to,
            unitAmountCents: tier.unit_amount === null || tier.unit_amount === undefined ? null : tier.unit_amount,
            flatAmountCents: tier.flat_amount === null || tier.flat_amount === undefined ? null : tier.flat_amount,
          };
        }),
      },
      label,
      priceId,
    };
  }
  const unitAmount = price?.unit_amount;
  if (!Number.isSafeInteger(unitAmount) || unitAmount < 0) {
    throw new AppError(`Stripe price "${priceId}" needs a unit_amount in cents or a tier schedule`, { code: 'PROVIDER_INVALID', status: 502, details: { field: 'price.unit_amount' } });
  }
  return {
    unsupported: false,
    component: {
      chargeType: recurring ? 'recurring' : 'one_time',
      pricingModel: 'per_unit',
      interval: recurring ? requireText(recurring.interval, 'price.recurring.interval', 20) : null,
      intervalCount: recurring ? requireIntervalCount(recurring.interval_count) : null,
      unitAmountCents: unitAmount,
    },
    label,
    priceId,
  };
}

/** @param {unknown} value */
function requireIntervalCount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) {
    throw new AppError('Stripe catalog sent an invalid "price.recurring.interval_count"', { code: 'PROVIDER_INVALID', status: 502, details: { field: 'price.recurring.interval_count' } });
  }
  return value;
}

/**
 * Build a declared catalog provider on a Stripe client (fake until the owner
 * provides credentials). The provider definition is declared data plus the
 * `fetchCatalog` edge — validated by `validateCatalogProvider` like every
 * other provider, fingerprinted by the registry like every other provider.
 *
 * Stripe is the price source: a price that disappears from Stripe (deleted,
 * or flipped inactive so `fetchCatalog` skips it) deactivates the offer an
 * earlier sync created, so nothing stays quotable past its source. That is
 * the sync's `deactivateMissing` policy, on by default here (unlike the
 * workspace price list, where it is opt-in).
 * @param {{name: string, version: number, label?: string, stripe: unknown, deactivateMissing?: boolean}} options
 */
export function createStripeCatalogProvider({ name, version, label, stripe, deactivateMissing = true }) {
  const stripeClient = requireStripeClient(stripe);
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]{0,59}$/.test(name)) {
    throw new ValidationError('stripe catalog provider name must match /^[a-z][a-z0-9-]*$/ within 60 characters');
  }
  if (typeof deactivateMissing !== 'boolean') {
    throw new ValidationError('deactivateMissing must be a boolean when present');
  }
  const providerName = name;

  const fetchCatalog = async () => {
    const [stripeProducts, stripePrices] = await Promise.all([stripeClient.listProducts(), stripeClient.listPrices()]);
    if (!Array.isArray(stripeProducts) || !Array.isArray(stripePrices)) {
      throw new AppError('Stripe catalog client must return product and price arrays', { code: 'PROVIDER_INVALID', status: 502 });
    }

    /** @type {Map<string, any>} */
    const productByStripeId = new Map();
    /** @type {Set<string>} */
    const usedKeys = new Set();
    /** @param {string} key @param {string} what */
    const claimKey = (key, what) => {
      if (usedKeys.has(key)) {
        throw new AppError(`Stripe catalog maps two ${what} to the same source key "${key}" (Stripe ids differing only in case cannot both sync)`, { code: 'PROVIDER_INVALID', status: 502 });
      }
      usedKeys.add(key);
      return key;
    };

    const priceBooks = [];
    /** @type {Map<string, any>} */
    const bookByCurrency = new Map();
    const bookFor = (currency) => {
      const upper = requireCurrency(String(currency).toUpperCase(), 'price.currency');
      if (!bookByCurrency.has(upper)) {
        const book = {
          sourceKey: claimKey(`stripe.${providerName}.book.${upper.toLowerCase()}`, 'price books'),
          name: `Stripe ${upper}`,
          currency: upper,
          active: true,
        };
        bookByCurrency.set(upper, book);
        priceBooks.push(book);
      }
      return bookByCurrency.get(upper);
    };

    const products = [];
    for (const stripeProduct of stripeProducts) {
      const stripeId = requireText(stripeProduct?.id, 'product.id', 200);
      const slug = slugifyStripeId(stripeId, 'product.id');
      const metadata = stripeProduct?.metadata && typeof stripeProduct.metadata === 'object' ? stripeProduct.metadata : {};
      const record = {
        sourceKey: claimKey(`stripe.${providerName}.product.${slug}`, 'products'),
        externalId: stripeId,
        sku: optionalText(metadata.sku, 'product.metadata.sku', 100) ?? stripeId,
        name: requireText(stripeProduct?.name, 'product.name', 200),
        description: optionalText(stripeProduct?.description, 'product.description'),
        category: optionalText(metadata.category, 'product.metadata.category', 100),
        active: stripeProduct?.active ?? true,
      };
      if (typeof record.active !== 'boolean') {
        throw new AppError('Stripe catalog sent an invalid "product.active" (boolean required)', { code: 'PROVIDER_INVALID', status: 502, details: { field: 'product.active' } });
      }
      productByStripeId.set(stripeId, { stripe: stripeProduct, record });
      products.push(record);
    }

    const offers = [];
    for (const price of stripePrices) {
      if (price?.active === false) continue;
      const priceId = requireText(price?.id, 'price.id', 200);
      const productStripeId = requireText(price?.product, 'price.product', 200);
      const known = productByStripeId.get(productStripeId);
      if (!known) {
        throw new AppError(`Stripe price "${priceId}" references unknown product "${productStripeId}"`, { code: 'PROVIDER_INVALID', status: 502 });
      }
      const enriched = { ...price, productName: known.record.name };
      const mapped = mapPriceComponent(enriched);
      const slug = slugifyStripeId(priceId, 'price.id');
      const book = bookFor(price?.currency);
      claimKey(`stripe.${providerName}.price.${slug}`, 'prices');
      const componentBase = {
        sourceKey: slug,
        label: mapped.label,
        externalPriceId: priceId,
        sourcePricingModel: `stripe:${price?.recurring ? 'recurring' : 'one_time'}.${price?.tiers_mode ?? price?.billing_scheme ?? 'per_unit'}`,
      };
      if (mapped.unsupported) {
        // One offer per price, so an unpriceable Stripe model only closes its
        // own offer: siblings stay quotable.
        offers.push({
          sourceKey: claimKey(`stripe.${providerName}.offer.${slug}`, 'offers'),
          priceBookSourceKey: book.sourceKey,
          productSourceKey: known.record.sourceKey,
          name: `${known.record.name} — ${mapped.label}`,
          active: true,
          externalOfferId: null,
          quoteEligible: false,
          unsupportedReason: `Stripe pricing model "${mapped.unsupportedModel}" is not supported for quoting`,
          components: [{ ...componentBase, unsupportedModel: mapped.unsupportedModel }],
        });
        continue;
      }
      offers.push({
        sourceKey: claimKey(`stripe.${providerName}.offer.${slug}`, 'offers'),
        priceBookSourceKey: book.sourceKey,
        productSourceKey: known.record.sourceKey,
        name: `${known.record.name} — ${mapped.label}`,
        active: true,
        externalOfferId: null,
        components: [{ ...componentBase, ...mapped.component }],
      });
    }

    return {
      sourceRef: `stripe:${providerName}`,
      priceBooks,
      products,
      offers,
    };
  };

  const provider = {
    name: providerName,
    version,
    label: label ?? `Stripe (${providerName})`,
    config: Object.freeze({ source: 'stripe', deactivateMissing, client: stripeClient.source ?? 'injected' }),
    fetchCatalog,
  };
  validateCatalogProvider(provider);
  return Object.freeze(provider);
}
