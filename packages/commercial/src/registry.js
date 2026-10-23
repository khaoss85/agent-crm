// @ts-check

import { createHash } from 'node:crypto';
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
 * next boot; rollback = publish a new version). The one exception is the
 * price-list provider the constructor builds: its fingerprint covers the
 * pinned constructor version instead of closure text, and the single
 * recognition predicate below binds that privilege to the live source.
 * Metadata is function-free.
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
 * Constructor version of the workspace price-list catalog provider.
 *
 * The registry fingerprint of a price-list provider covers `{type, name,
 * version, codeVersion, renderHash, tieredRenderHash, config}` and
 * deliberately NOT the `fetchCatalog` closure source: the closure reads only
 * the declared `config` (same reference, frozen), so a pure refactor of the
 * constructor file — renames, comments, formatting — leaves every registered
 * fingerprint unchanged. A behaviour change to the catalog the closure
 * renders moves the fingerprint twice over: the render pins below must move
 * with it (or the render characterization fails), and the pins are
 * fingerprint inputs, so even a pin update without a version bump still moves
 * every registered fingerprint instead of syncing different keys silently.
 * Bumping this version on top stays mandatory: it names the behaviour change
 * the pins only hash.
 */
export const PRICE_LIST_CATALOG_CODE_VERSION = 1;

/**
 * Pinned template of the constructor-built `fetchCatalog` (review
 * khaoss85/agent-crm#333): the registry fingerprint deliberately excludes
 * closure text, so the executed code is bound here instead — every provider
 * the constructor builds carries a `fetchCatalog` whose SHA-256 must match
 * `sourceHash`, or composition refuses. The `renderHash` pins are the second
 * half of that binding: the definition fingerprints of the catalogs the
 * constructor renders for the two characterization fixtures (gym and tiered,
 * see `tests/commercial-price-list.test.js`), so a behaviour change to the
 * closure cannot land by updating fixtures and pins while leaving the version
 * alone — the updated pins move the fingerprint on their own, and spaces
 * registered under the old bytes refuse as drift instead of composing.
 *
 * Never edit `sourceHash` except together with the closure it pins; never
 * edit a render pin except together with the rendered bytes it pins (a pure
 * refactor leaves both render pins unchanged); and bump `codeVersion` (above
 * and here) exactly when the rendered catalog changes. The render pins are
 * definition fingerprints of the JSON round-tripped catalog bytes — the same
 * canonical form the render characterization asserts — so every checkout
 * agrees on them, with no line-ending dependence (rendered catalogs carry no
 * source text).
 */
export const PRICE_LIST_CATALOG_TEMPLATE = Object.freeze({
  codeVersion: PRICE_LIST_CATALOG_CODE_VERSION,
  sourceHash: '2f93d1464a2bff40f9fb5fb2a2ec4197551ebd90862a6077f951e79a07e1234a',
  renderHash: '7c3f922253fda68fc7fc5da60d16204d78ba198fa0b7f0c6295f4e20159d830d',
  tieredRenderHash: '5ef8b5e8e813ab05157b0c215c2a2cac38bb31e68d5eade0c6f0775978542c72',
});

/**
 * Refuse a `fetchCatalog` source that drifted from the pinned template.
 * Fail-closed at composition, in the framework's own words: an unbumped
 * edit to the constructor stops the boot the way a fingerprint mismatch
 * used to, instead of syncing different keys under an unchanged fingerprint.
 * @param {unknown} sourceText — the live `fetchCatalog.toString()`
 */
export function validatePriceListConstructorTemplate(sourceText) {
  // Line endings are not behaviour: a CRLF checkout renders the identical
  // catalog, so the pin hashes the LF form — the same normalization the
  // definition fingerprint canonicalizer applies (definition-fingerprint.js).
  const live = createHash('sha256').update(String(sourceText).replaceAll('\r\n', '\n'), 'utf8').digest('hex');
  if (live !== PRICE_LIST_CATALOG_TEMPLATE.sourceHash) {
    throw new ValidationError(
      'price-list catalog constructor source changed without a constructor update: '
      + 'a behaviour change must bump PRICE_LIST_CATALOG_CODE_VERSION and update the render pins '
      + '(the pins move the fingerprint on their own), '
      + 'a pure refactor must update PRICE_LIST_CATALOG_TEMPLATE.sourceHash only '
      + '(see the render characterization in tests/commercial-price-list.test.js)',
    );
  }
}

/**
 * The single source of truth for the constructor-built privilege (review
 * khaoss85/agent-crm#333, rounds 1–3): every decision below — the
 * source-free fingerprint scheme, the approved historical forms, and the
 * refusal of forged constructor fields — reads this predicate, so a new
 * decision point cannot silently bypass the others again. The earlier cure
 * scattered the privilege (fingerprint branched on `codeVersion` alone,
 * identity on a forgeable exported seal, template checked only at
 * construction); each round patched one point while another leaked.
 *
 * A catalog provider is constructor-built only when it carries the pinned
 * constructor version AND its live `fetchCatalog` source hashes to the
 * pinned template. The version alone proves nothing — any object can declare
 * it — and there is no seal left to forge: a post-construction swap
 * (`{...p, fetchCatalog: evil}`) simply stops being constructor-built
 * instead of verifying under a stale pin, and a custom provider declaring
 * `codeVersion`/`legacyFetchSources` is a stranger to the template.
 * @param {any} definition
 */
function isConstructorBuiltCatalogProvider(definition) {
  if (!definition || typeof definition !== 'object') return false;
  if (definition.codeVersion !== PRICE_LIST_CATALOG_CODE_VERSION) return false;
  if (typeof definition.fetchCatalog !== 'function') return false;
  try {
    validatePriceListConstructorTemplate(String(definition.fetchCatalog));
  } catch {
    return false;
  }
  return true;
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
  // honoured only on a recognized constructor-built definition (see
  // isConstructorBuiltCatalogProvider and identity), so a custom provider
  // can never approve its own drift as history.
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
  // Constructor-reserved fields (review khaoss85/agent-crm#333): the
  // versioned scheme and the declared history belong to providers the
  // price-list constructor built — recognized by the single predicate,
  // which re-validates the live fetchCatalog source on this path, so a
  // post-construction swap refuses here instead of verifying under a stale
  // pin, and a custom provider cannot opt out of source drift detection by
  // merely declaring a version. There is no seal to forge: recognition is
  // the live source plus the pinned version, nothing an importer can stamp.
  if (definition.codeVersion !== undefined || definition.legacyFetchSources !== undefined) {
    if (!isConstructorBuiltCatalogProvider(definition)) {
      throw new ValidationError(
        `catalog provider "${definition.name}": codeVersion and legacyFetchSources are reserved `
        + 'for providers built by createPriceListCatalogProvider — the live fetchCatalog source '
        + 'does not match the pinned constructor template (a behaviour change must bump '
        + 'PRICE_LIST_CATALOG_CODE_VERSION with the pin; a custom provider must not declare these fields)',
      );
    }
  }
  return definition;
}

/**
 * The fingerprint input for one catalog provider. Recognized
 * constructor-built providers (see isConstructorBuiltCatalogProvider) hash
 * `{type, name, version, codeVersion, renderHash, tieredRenderHash, config}`:
 * the closure reads only the declared config, so its source text is not
 * behaviour and hashing it churned every registered fingerprint on each
 * refactor — but the rendered bytes ARE behaviour, so the pinned render
 * digests stand in for them (review khaoss85/agent-crm#333, round 6: hashing
 * only `codeVersion` let a behaviour change ship under an unchanged
 * fingerprint when fixtures and pins moved without a bump). Every other
 * provider — including one that merely declares a `codeVersion` — keeps the
 * established source-plus-config form, so a rewritten closure still moves
 * the fingerprint instead of silently opting out of drift detection.
 * @param {any} definition
 */
function catalogProviderFingerprint(definition) {
  if (isConstructorBuiltCatalogProvider(definition)) {
    return computeDefinitionFingerprint({
      type: 'catalog-provider',
      name: definition.name,
      version: definition.version,
      codeVersion: definition.codeVersion,
      renderHash: PRICE_LIST_CATALOG_TEMPLATE.renderHash,
      tieredRenderHash: PRICE_LIST_CATALOG_TEMPLATE.tieredRenderHash,
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
 * and never the definition or its config — plus, for a recognized
 * constructor-built catalog provider that declares historical closure
 * sources, the fingerprints the old scheme would have computed over the
 * current data. Declared history on any other definition is unapproved and
 * ignored here: the store then verifies by exact match, so a mismatched row
 * refuses as genuine drift instead of letting a provider approve its own
 * past. The store accepts and moves an approved form inside its single
 * persist-or-verify transaction (and accepts it without writing on a
 * read-only composition); anything else that mismatches is genuine drift.
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
  if (!isConstructorBuiltCatalogProvider(entry.definition)) return base;
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
      // Validation re-runs the constructor-template check on this path via
      // the recognition predicate, so a post-construction fetchCatalog swap
      // refuses here — the pin is enforced at every composition, not only
      // where the provider was built.
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
