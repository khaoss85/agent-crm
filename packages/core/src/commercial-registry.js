// @ts-check

import { ValidationError, NotFoundError } from './errors.js';
import { computeDefinitionFingerprint, validateDeclaredConfig } from './definition-fingerprint.js';
import {
  requireCurrency,
  CHARGE_TYPES,
  PRICING_MODELS,
  RECURRING_INTERVALS,
  MAX_DISCOUNT_BPS,
  MAX_QUANTITY,
} from './commercial-money.js';

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
const MAX_LABEL = 80;
const MAX_VERSION = 1_000_000;
export const DISCOUNT_DECISIONS = Object.freeze(['auto_approve', 'approval_required', 'reject']);

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
  return definition;
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
        fingerprint: computeDefinitionFingerprint({
          type: 'catalog-provider',
          name: definition.name,
          version: definition.version,
          config: definition.config ?? null,
          fetchCatalog: definition.fetchCatalog,
        }),
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
   * concurrent boots serialize).
   * @param {any} database
   */
  persistFingerprints(database) {
    const entries = [
      ...[...this.catalogProviders.values()].map((entry) => ({ type: 'catalog-provider', entry })),
      ...[...this.discountPolicies.values()].map((entry) => ({ type: 'discount-policy', entry })),
    ];
    database.transaction(() => {
      const select = database.raw.prepare(
        'SELECT fingerprint FROM definition_versions WHERE type = ? AND name = ? AND version = ?',
      );
      const insert = database.raw.prepare(
        'INSERT INTO definition_versions(id, type, name, version, fingerprint, registered_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const { type, entry } of entries) {
        const { name, version } = entry.definition;
        const existing = select.get(type, name, version);
        if (existing === undefined) {
          insert.run(crypto.randomUUID(), type, name, version, entry.fingerprint, new Date().toISOString());
          continue;
        }
        if (String(existing.fingerprint) !== entry.fingerprint) {
          throw new ValidationError(
            `${type} "${name}@${version}" source changed after registration (persisted fingerprint ${String(existing.fingerprint).slice(0, 12)}…, current ${entry.fingerprint.slice(0, 12)}…). ` +
              'Registered definition versions are immutable: publish a new version instead of editing this one.',
          );
        }
      }
    });
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
