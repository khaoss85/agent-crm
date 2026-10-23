// @ts-check

import {
  ValidationError,
  NotFoundError,
  createDefinitionVersionStore,
  computeDefinitionFingerprint,
  validateDeclaredConfig,
  CHARGE_TYPES,
  PRICING_MODELS,
  RECURRING_INTERVALS,
  MAX_QUANTITY,
} from '../../core/index.js';
import { requireCurrency, MAX_DISCOUNT_BPS } from './money.js';

/**
 * Commercial Operations registries (ADR-016): catalog providers and versioned
 * discount policies on the hardened declared-definition mechanism (ADR-015):
 * Map-backed per-app registries, fail-closed startup, strict canonical
 * fingerprints over source + declared JSON-safe config, persisted in
 * `definition_versions` inside one transaction (same-version drift stops the
 * next boot; rollback = publish a new version). Metadata is function-free.
 *
 * Future provider packages may target Stripe Products/Prices, Zuora, ERP or
 * custom catalog APIs — none ships here; the fixture provider proves the
 * contract without credentials.
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;
export const MAX_LABEL = 80;
const MAX_VERSION = 1_000_000;
/**
 * Bounds on catalog-provider migration metadata. Ten historical forms and
 * 200KB each sit orders of magnitude above any real migration (the price
 * list migrates two ~2KB forms); anything larger is a runaway generator and
 * is refused fail-closed, like every other unbounded definition input.
 */
const MAX_LEGACY_SOURCES = 10;
const MAX_LEGACY_SOURCE_CHARS = 200_000;
export const DISCOUNT_DECISIONS = Object.freeze(['auto_approve', 'approval_required', 'reject']);

/**
 * Kernel-internal seal: which catalog providers the constructor built.
 * Module-private on purpose — application code holds no reference to this
 * symbol, so no custom provider can forge the seal; only
 * `createPriceListCatalogProvider` (price-list.js) applies it, and the
 * registry's identity below honours declared history solely on sealed
 * definitions. A provider that merely declares `legacyFetchSources` without
 * the seal is unapproved history: a mismatched row refuses as genuine drift
 * instead of migrating itself (review khaoss85/agent-crm#333).
 */
const CONSTRUCTOR_BUILT = Symbol('accordo.constructorBuiltCatalogProvider');

/**
 * Seal a constructor-built catalog provider. Kernel-internal: only
 * `createPriceListCatalogProvider` may call this, before freezing the
 * definition. The seal survives the object spreads compositions use,
 * because spread copies enumerable symbol-keyed properties.
 * @param {any} provider
 */
export function sealConstructorBuiltCatalogProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new ValidationError('constructor-built catalog provider must be an object');
  }
  provider[CONSTRUCTOR_BUILT] = true;
  return provider;
}

/** @param {string} label @param {any} definition */
function assertIdentity(label, definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError(`${label} definition must be an object`);
  }
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ValidationError(`${label} "${String(definition.name)}": name must match ${NAME_RE}`);
  }
  if (!Number.isSafeInteger(definition.version) || definition.version < 1 || definition.version > MAX_VERSION) {
    throw new ValidationError(`${label} "${definition.name}": version must be a positive integer (1–${MAX_VERSION})`);
  }
  if (definition.label !== undefined && (typeof definition.label !== 'string' || definition.label.length === 0 || definition.label.length > MAX_LABEL)) {
    throw new ValidationError(`${label} "${definition.name}": label must be a non-empty string of at most ${MAX_LABEL} characters`);
  }
  validateDeclaredConfig(`${label} "${definition.name}@${definition.version}"`, definition.config);
}

/** @param {any} definition */
export function validateCatalogProvider(definition) {
  assertIdentity('catalog provider', definition);
  if (typeof definition.fetchCatalog !== 'function') {
    throw new ValidationError(`catalog provider "${definition.name}": fetchCatalog must be a function`);
  }
  // A constructor-built provider declares its behaviour in full: `codeVersion`
  // is the constructor's own version (bumped on behaviour change) and takes
  // the closure source's place in the fingerprint, so framework refactors
  // stop moving it. `legacyFetchSources` carries the historical closure
  // sources a transparent upgrade may still meet in registered databases —
  // honoured only on a sealed constructor-built definition (see identity),
  // so a custom provider can never approve its own drift as history.
  if (definition.codeVersion !== undefined
    && (!Number.isSafeInteger(definition.codeVersion) || definition.codeVersion < 1 || definition.codeVersion > MAX_VERSION)) {
    throw new ValidationError(
      `catalog provider "${definition.name}": codeVersion must be a positive integer (1–${MAX_VERSION}) when present`,
    );
  }
  if (definition.legacyFetchSources !== undefined) {
    if (!Array.isArray(definition.legacyFetchSources)
      || definition.legacyFetchSources.length === 0
      || definition.legacyFetchSources.length > MAX_LEGACY_SOURCES) {
      throw new ValidationError(
        `catalog provider "${definition.name}": legacyFetchSources must be a non-empty array of at most ${MAX_LEGACY_SOURCES} historical fetchCatalog sources when present`,
      );
    }
    definition.legacyFetchSources.forEach((source, index) => {
      if (typeof source !== 'string' || source === '' || source.length > MAX_LEGACY_SOURCE_CHARS) {
        throw new ValidationError(
          `catalog provider "${definition.name}": legacyFetchSources[${index}] must be a non-empty string of at most ${MAX_LEGACY_SOURCE_CHARS} characters`,
        );
      }
    });
  }
  return definition;
}

/**
 * The fingerprint input for one catalog provider. Constructor-built
 * providers (codeVersion present) hash `{type, name, version, codeVersion,
 * config}`: the closure reads only the declared config, so its source text
 * is not behaviour and hashing it churned every registered fingerprint on
 * each refactor. Every other provider keeps the established source-plus-
 * config form, unchanged.
 * @param {any} definition
 */
function catalogProviderFingerprint(definition) {
  if (definition.codeVersion !== undefined) {
    return computeDefinitionFingerprint({
      type: 'catalog-provider',
      name: definition.name,
      version: definition.version,
      codeVersion: definition.codeVersion,
      config: definition.config ?? null,
    });
  }
  return computeDefinitionFingerprint({
    type: 'catalog-provider',
    name: definition.name,
    version: definition.version,
    config: definition.config ?? null,
    fetchCatalog: definition.fetchCatalog,
  });
}

/**
 * A historical fetchCatalog form, revived for fingerprint comparison only.
 * The own `toString` shadows `Function.prototype.toString`, so the
 * canonicalizer hashes the pinned historical source; the function itself is
 * never executed (it throws when called).
 * @param {string} source
 */
function comparisonOnlyFetch(source) {
  const neverExecute = async () => {
    throw new ValidationError('Historical catalog fetchCatalog: fingerprint comparison only, never executed');
  };
  return Object.assign(neverExecute, { toString: () => source });
}

/**
 * The fingerprints this entry would have carried had it registered under
 * each of its historical closure sources with the current data: empty when
 * the definition declares no history.
 * @param {{definition: any, fingerprint: string}} entry
 */
function legacyCatalogFingerprints(entry) {
  const sources = entry.definition.legacyFetchSources ?? [];
  return sources.map((source) => computeDefinitionFingerprint({
    type: 'catalog-provider',
    name: entry.definition.name,
    version: entry.definition.version,
    config: entry.definition.config ?? null,
    fetchCatalog: comparisonOnlyFetch(source),
  }));
}

/** @param {any} definition */
export function validateDiscountPolicy(definition) {
  assertIdentity('discount policy', definition);
  if (typeof definition.evaluate !== 'function') {
    throw new ValidationError(`discount policy "${definition.name}@${definition.version}": evaluate must be a function`);
  }
  return definition;
}

/**
 * The closed identity the definition-version store persists: the four fields,
 * and never the definition or its config — plus, for a constructor-built
 * catalog provider that declares historical closure sources, the fingerprints
 * the old scheme would have computed over the current data. Declared history
 * on any other definition is unapproved and ignored here: the store then
 * verifies by exact match, so a mismatched row refuses as genuine drift
 * instead of letting a provider approve its own past. The store accepts and
 * moves an approved form inside its single persist-or-verify transaction
 * (and accepts it without writing on a read-only composition); anything else
 * that mismatches is genuine drift.
 * @param {string} type
 * @param {{definition: {name: string, version: number}, fingerprint: string}} entry
 */
function identity(type, entry) {
  const base = {
    type,
    name: entry.definition.name,
    version: entry.definition.version,
    fingerprint: entry.fingerprint,
  };
  if (type !== 'catalog-provider') return base;
  if (entry.definition[CONSTRUCTOR_BUILT] !== true) return base;
  const supersededFingerprints = legacyCatalogFingerprints(entry);
  if (supersededFingerprints.length === 0) return base;
  return { ...base, supersededFingerprints };
}

/**
 * Validate a discount policy's result into the bounded shape
 * `{decision, reason?, requiredApprovalKey?, matchedRule?}`. Promises and
 * out-of-contract values are refused — policies are synchronous and total.
 * @param {string} label @param {unknown} result
 */
export function normalizePolicyResult(label, result) {
  if (result instanceof Promise) {
    throw new ValidationError(`${label} must return synchronously — Promises are rejected`);
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ValidationError(`${label} must return {decision, reason?, requiredApprovalKey?, matchedRule?}`);
  }
  const value = /** @type {Record<string, unknown>} */ (result);
  if (typeof value.decision !== 'string' || !DISCOUNT_DECISIONS.includes(/** @type {any} */ (value.decision))) {
    throw new ValidationError(`${label} decision must be one of: ${DISCOUNT_DECISIONS.join(', ')}`);
  }
  const bounded = (field) => {
    const raw = value[field];
    if (raw === undefined || raw === null) return null;
    if (typeof raw !== 'string' || raw.length === 0) {
      throw new ValidationError(`${label} ${field} must be a non-empty string when present`);
    }
    return raw.slice(0, 500);
  };
  return {
    decision: /** @type {'auto_approve'|'approval_required'|'reject'} */ (value.decision),
    reason: bounded('reason'),
    requiredApprovalKey: bounded('requiredApprovalKey'),
    matchedRule: bounded('matchedRule'),
  };
}

/** Per-app commercial registries; one malformed definition stops startup. */
export class CommercialRegistries {
  /** @param {{catalogProviders?: any[], discountPolicies?: any[]}} [definitions] */
  constructor(definitions = {}) {
    /** @type {Map<string, any>} */
    this.catalogProviders = new Map();
    /** @type {Map<string, any>} */
    this.discountPolicies = new Map();

    for (const definition of definitions.catalogProviders ?? []) {
      validateCatalogProvider(definition);
      if (this.catalogProviders.has(definition.name)) {
        throw new ValidationError(`Duplicate catalog provider name: ${definition.name}`);
      }
      this.catalogProviders.set(definition.name, {
        definition,
        fingerprint: catalogProviderFingerprint(definition),
      });
    }
    for (const definition of definitions.discountPolicies ?? []) {
      validateDiscountPolicy(definition);
      const key = `${definition.name}@${definition.version}`;
      if (this.discountPolicies.has(key)) {
        throw new ValidationError(`Duplicate discount policy identity: ${key}`);
      }
      this.discountPolicies.set(key, {
        definition,
        fingerprint: computeDefinitionFingerprint({
          type: 'discount-policy',
          name: definition.name,
          version: definition.version,
          config: definition.config ?? null,
          evaluate: definition.evaluate,
        }),
      });
    }
  }

  /** @param {string} name — returns {definition, fingerprint} */
  getCatalogProvider(name) {
    const entry = this.catalogProviders.get(name);
    if (!entry) throw new NotFoundError('Catalog provider', String(name));
    return entry;
  }

  /** @param {string} name @param {number} version — returns {definition, fingerprint} */
  getDiscountPolicy(name, version) {
    const entry = this.discountPolicies.get(`${name}@${version}`);
    if (!entry) throw new NotFoundError('Discount policy', `${name}@${version}`);
    return entry;
  }

  /**
   * Persist-or-verify every identity in definition_versions, in one
   * transaction (ADR-015 semantics: drift under a registered version throws;
   * concurrent boots serialize). The kernel's definition-version store owns
   * that loop — this registry only says which identities it publishes.
   * @param {any} database
   */
  persistFingerprints(database) {
    // A row registered under a historical closure source moves to the current
    // fingerprint inside the store's single persist-or-verify transaction
    // (accepted without writing on a read-only composition); anything else
    // that mismatches is genuine drift and refuses with the established
    // message, rolling the whole batch back — including the move.
    const store = createDefinitionVersionStore(database);
    const entries = [
      ...[...this.catalogProviders.values()].map((entry) => identity('catalog-provider', entry)),
      ...[...this.discountPolicies.values()].map((entry) => identity('discount-policy', entry)),
    ];
    return store.persist(entries);
  }

  /** Serializable, function-free metadata for /api/schema. */
  metadata() {
    return {
      commercialContract: 1,
      pricingContract: 1,
      money: 'safe integers, 1/100 currency units, two decimals (not ISO-4217 exponents)',
      discounts: 'integer basis points 0-10000; discount = trunc(list*bps/10000), applied per component after tier calculation',
      chargeTypes: [...CHARGE_TYPES],
      pricingModels: [...PRICING_MODELS],
      recurringIntervals: [...RECURRING_INTERVALS],
      maxDiscountBps: MAX_DISCOUNT_BPS,
      maxQuantity: MAX_QUANTITY,
      quantitySemantics: {
        flat_fee: 'charged once per quote line; line quantity does not multiply it',
        per_unit: 'unitAmount x quantity',
        volume: 'the tier the total quantity reaches prices the entire quantity',
        graduated: 'each tier band prices the quantity that falls inside it',
      },
      totals: 'grouped: one one-time total plus one per (currency, interval, intervalCount); unlike periods are never summed and no ARR/MRR/TCV is derived',
      unsupportedModels: 'metered usage, overage, proration, ramps, minimum commitments, attribute-based pricing, taxes and FX are never approximated: such offers persist with quoteEligible=false and an unsupportedReason',
      catalogProviders: [...this.catalogProviders.values()]
        .sort((a, b) => (a.definition.name < b.definition.name ? -1 : 1))
        .map(({ definition, fingerprint }) => ({
          name: definition.name,
          version: definition.version,
          label: definition.label ?? definition.name,
          fingerprint,
        })),
      discountPolicies: [...this.discountPolicies.values()]
        .sort((a, b) => (a.definition.name === b.definition.name
          ? a.definition.version - b.definition.version
          : a.definition.name < b.definition.name ? -1 : 1))
        .map(({ definition, fingerprint }) => ({
          name: definition.name,
          version: definition.version,
          label: definition.label ?? definition.name,
          fingerprint,
        })),
    };
  }
}

export { requireCurrency };
