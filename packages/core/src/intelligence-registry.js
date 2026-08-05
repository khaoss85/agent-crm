// @ts-check

import { createHash, randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError } from './errors.js';
import { nowIso } from './time.js';

/**
 * Lead Intelligence registries (ADR-015): bounded code-first contracts for
 * enrichment providers, scoring models, routing policies and routing targets.
 *
 * Same discipline as the action/pipeline registries (ADR-011/014): plain
 * checked-in definitions validated fail-closed at startup, Map-backed lookups
 * (no prototype-property resolution), deterministic order, per-app instances,
 * metadata free of executable code. Source is trusted; validation guards
 * against accidental or stale definitions, not malicious edits.
 *
 * Versioned-definition integrity: scoring models and routing policies carry a
 * deterministic SHA-256 fingerprint computed from their canonicalized source
 * (functions via toString). `persistFingerprints` records each
 * {type, name, version, fingerprint} in the `definition_versions` table at
 * startup; the same identity re-registering with a DIFFERENT fingerprint
 * throws — definitions are never edited in place after registration. Rollback
 * means publishing a NEW version derived from an earlier definition.
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const KEY_RE = /^[a-z][a-z0-9-]*$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
const LANGUAGE_RE = /^[a-z]{2}$/;
const MAX_LABEL = 80;
const MAX_VERSION = 1_000_000;
export const ENRICHMENT_CAPABILITIES = Object.freeze(['company']);
export const ROUTING_TARGET_KINDS = Object.freeze(['user', 'team', 'queue', 'fallback']);

/**
 * Deterministic **declared-definition fingerprint**: canonical serialization
 * (objects with sorted keys, function source via toString, CRLF normalized to
 * LF) hashed with SHA-256. The same checked-in source always produces the same
 * fingerprint; any change to declared rules, weights, labels, config or
 * handler source changes it.
 *
 * Honest limitation (documented in ADR-015): this fingerprints what a
 * definition DECLARES — its own source and its declared `config`. A handler
 * closing over a mutable outer variable or calling an out-of-file helper is
 * not captured: `toString()` serializes the identifier, not the value. That is
 * why semantic thresholds and tunables MUST live in the declared `config` (or
 * as literals in the handler body); closure analysis is deliberately not
 * attempted.
 *
 * Unsupported values (Date, Map, Set, RegExp, class instances, BigInt,
 * symbols, non-finite numbers, undefined, cycles) FAIL loudly instead of
 * silently disappearing from the fingerprint.
 * @param {unknown} value
 */
export function computeDefinitionFingerprint(value) {
  return createHash('sha256').update(canonicalize(value, new Set(), '$')).digest('hex');
}

/** @param {unknown} value @param {Set<unknown>} seen @param {string} path @returns {string} */
function canonicalize(value, seen, path) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string') return JSON.stringify(value);
  if (type === 'boolean') return value ? 'true' : 'false';
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`Cannot fingerprint a non-finite number at ${path}`);
    }
    return JSON.stringify(value);
  }
  if (type === 'function') {
    return JSON.stringify(`[fn]${/** @type {Function} */ (value).toString().replaceAll('\r\n', '\n')}`);
  }
  if (type === 'undefined' || type === 'bigint' || type === 'symbol') {
    throw new ValidationError(`Cannot fingerprint a value of type ${type} at ${path} — use plain JSON-safe data`);
  }
  if (seen.has(value)) {
    throw new ValidationError(`Cannot fingerprint a cyclic structure at ${path}`);
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item, index) => canonicalize(item, seen, `${path}[${index}]`)).join(',')}]`;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new ValidationError(
        `Cannot fingerprint a non-plain object at ${path} (Date, Map, Set, RegExp and class instances are unsupported — use plain JSON-safe data)`,
      );
    }
    const entries = Object.keys(/** @type {Record<string, unknown>} */ (value))
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(/** @type {any} */ (value)[key], seen, `${path}.${key}`)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

/**
 * Validate a definition's optional declared `config`: the plain JSON-safe data
 * its handlers read (thresholds, code lists, tunables). It is included in the
 * fingerprint and handed frozen to every evaluation — the sanctioned home for
 * anything a closure would otherwise hide from the fingerprint.
 * @param {string} label @param {unknown} config
 */
function validateDeclaredConfig(label, config) {
  if (config === undefined) return;
  try {
    canonicalize(config, new Set(), 'config');
  } catch (error) {
    throw new ValidationError(`${label}: config must be plain JSON-safe data (${error instanceof Error ? error.message : String(error)})`);
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config) || typeof config === 'function') {
    throw new ValidationError(`${label}: config must be a plain object when present`);
  }
}

/** @param {string} label @param {unknown} value @param {string} what */
function assertCanonicalName(label, value, what = 'name') {
  if (typeof value !== 'string' || !NAME_RE.test(value)) {
    throw new ValidationError(`${label}: ${what} must match ${NAME_RE}`);
  }
}

/** @param {string} label @param {unknown} value */
function assertVersion(label, value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 1 || /** @type {number} */ (value) > MAX_VERSION) {
    throw new ValidationError(`${label}: version must be a positive integer (1–${MAX_VERSION})`);
  }
}

/** @param {string} label @param {unknown} value @param {string} what */
function assertBoundedLabel(label, value, what = 'label') {
  if (value !== undefined && (typeof value !== 'string' || value.length === 0 || value.length > MAX_LABEL)) {
    throw new ValidationError(`${label}: ${what} must be a non-empty string of at most ${MAX_LABEL} characters`);
  }
}

/** @param {string} label @param {unknown} values @param {RegExp} re @param {string} what */
function normalizeCodeList(label, values, re, what) {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.some((v) => typeof v !== 'string' || !re.test(v))) {
    throw new ValidationError(`${label}: ${what} must be an array of codes matching ${re}`);
  }
  if (new Set(values).size !== values.length) {
    throw new ValidationError(`${label}: ${what} must not contain duplicates`);
  }
  return values.slice();
}

/**
 * Validate an enrichment provider definition.
 * @param {any} definition
 */
export function validateEnrichmentProvider(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('Enrichment provider definition must be an object');
  }
  const label = `enrichment provider "${String(definition.name)}"`;
  assertCanonicalName(label, definition.name);
  assertVersion(label, definition.version);
  assertBoundedLabel(label, definition.label);
  if (
    !Array.isArray(definition.capabilities) ||
    definition.capabilities.length === 0 ||
    definition.capabilities.some((c) => !ENRICHMENT_CAPABILITIES.includes(c)) ||
    new Set(definition.capabilities).size !== definition.capabilities.length
  ) {
    throw new ValidationError(`${label}: capabilities must be a unique subset of: ${ENRICHMENT_CAPABILITIES.join(', ')}`);
  }
  if (definition.capabilities.includes('company') && typeof definition.enrichCompany !== 'function') {
    throw new ValidationError(`${label}: capability "company" requires an enrichCompany function`);
  }
  validateDeclaredConfig(label, definition.config);
  return definition;
}

/**
 * Validate a scoring model definition (code-first, explainable).
 * @param {any} definition
 */
export function validateScoringModel(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('Scoring model definition must be an object');
  }
  const label = `scoring model "${String(definition.name)}@${String(definition.version)}"`;
  assertCanonicalName(label, definition.name);
  assertVersion(label, definition.version);
  assertBoundedLabel(label, definition.label);
  if (!Array.isArray(definition.rules) || definition.rules.length === 0) {
    throw new ValidationError(`${label}: rules must be a non-empty array`);
  }
  const seen = new Set();
  for (const rule of definition.rules) {
    if (!rule || typeof rule !== 'object') throw new ValidationError(`${label}: each rule must be an object`);
    if (typeof rule.key !== 'string' || !KEY_RE.test(rule.key)) {
      throw new ValidationError(`${label}: rule key must match ${KEY_RE}`);
    }
    if (seen.has(rule.key)) throw new ValidationError(`${label}: duplicate rule key "${rule.key}"`);
    seen.add(rule.key);
    assertBoundedLabel(`${label} rule "${rule.key}"`, rule.label);
    if (!Number.isSafeInteger(rule.weight) || rule.weight === 0) {
      throw new ValidationError(`${label}: rule "${rule.key}" weight must be a non-zero integer`);
    }
    if (typeof rule.evaluate !== 'function') {
      throw new ValidationError(`${label}: rule "${rule.key}" evaluate must be a function`);
    }
  }
  for (const bound of ['minScore', 'maxScore']) {
    if (definition[bound] !== undefined && !Number.isSafeInteger(definition[bound])) {
      throw new ValidationError(`${label}: ${bound} must be an integer when present`);
    }
  }
  if (
    definition.minScore !== undefined &&
    definition.maxScore !== undefined &&
    definition.minScore >= definition.maxScore
  ) {
    throw new ValidationError(`${label}: minScore must be below maxScore`);
  }
  validateDeclaredConfig(label, definition.config);
  return definition;
}

/**
 * Validate a routing policy definition.
 * @param {any} definition
 */
export function validateRoutingPolicy(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('Routing policy definition must be an object');
  }
  const label = `routing policy "${String(definition.name)}@${String(definition.version)}"`;
  assertCanonicalName(label, definition.name);
  assertVersion(label, definition.version);
  assertBoundedLabel(label, definition.label);
  if (typeof definition.route !== 'function') {
    throw new ValidationError(`${label}: route must be a function`);
  }
  validateDeclaredConfig(label, definition.config);
  return definition;
}

/**
 * Validate a routing target definition. Targets are trusted application
 * identifiers for this local milestone — NOT authenticated users.
 * @param {any} definition
 */
export function validateRoutingTarget(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('Routing target definition must be an object');
  }
  const label = `routing target "${String(definition.key)}"`;
  if (typeof definition.key !== 'string' || !KEY_RE.test(definition.key)) {
    throw new ValidationError(`${label}: key must match ${KEY_RE}`);
  }
  assertBoundedLabel(label, definition.label);
  if (!ROUTING_TARGET_KINDS.includes(definition.kind)) {
    throw new ValidationError(`${label}: kind must be one of: ${ROUTING_TARGET_KINDS.join(', ')}`);
  }
  if (typeof definition.active !== 'boolean') {
    throw new ValidationError(`${label}: active must be a boolean`);
  }
  normalizeCodeList(label, definition.countries, COUNTRY_RE, 'countries');
  normalizeCodeList(label, definition.languages, LANGUAGE_RE, 'languages');
  normalizeCodeList(label, definition.skills, KEY_RE, 'skills');
  if (definition.capacity !== undefined && definition.capacity !== null) {
    if (!Number.isSafeInteger(definition.capacity) || definition.capacity < 0) {
      throw new ValidationError(`${label}: capacity must be a non-negative integer or null (unlimited)`);
    }
  }
  if (definition.priority !== undefined && !Number.isSafeInteger(definition.priority)) {
    throw new ValidationError(`${label}: priority must be an integer when present`);
  }
  for (const bound of ['scoreMin', 'scoreMax']) {
    if (definition[bound] !== undefined && !Number.isSafeInteger(definition[bound])) {
      throw new ValidationError(`${label}: ${bound} must be an integer when present`);
    }
  }
  if (
    definition.scoreMin !== undefined &&
    definition.scoreMax !== undefined &&
    definition.scoreMin > definition.scoreMax
  ) {
    throw new ValidationError(`${label}: scoreMin must not exceed scoreMax`);
  }
  return definition;
}

/**
 * Deterministic target ranking used for documented tie-breaking: higher
 * priority first, then lower current load, then lexicographic key. Never
 * random.
 * @param {Array<{key: string, priority?: number, currentLoad?: number}>} targets
 */
export function rankRoutingTargets(targets) {
  return targets.slice().sort((a, b) => {
    const priority = (b.priority ?? 0) - (a.priority ?? 0);
    if (priority !== 0) return priority;
    const load = (a.currentLoad ?? 0) - (b.currentLoad ?? 0);
    if (load !== 0) return load;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/**
 * Per-app registries for the four intelligence contracts. Fail-closed
 * construction: one malformed definition throws and stops app startup.
 */
export class IntelligenceRegistries {
  /**
   * @param {{
   *   enrichmentProviders?: any[],
   *   scoringModels?: any[],
   *   routingPolicies?: any[],
   *   routingTargets?: any[],
   * }} [definitions]
   */
  constructor(definitions = {}) {
    /** @type {Map<string, any>} */
    this.providers = new Map();
    /** @type {Map<string, any>} */
    this.scoringModels = new Map();
    /** @type {Map<string, any>} */
    this.routingPolicies = new Map();
    /** @type {Map<string, any>} */
    this.routingTargets = new Map();

    for (const definition of definitions.enrichmentProviders ?? []) {
      validateEnrichmentProvider(definition);
      if (this.providers.has(definition.name)) {
        throw new ValidationError(`Duplicate enrichment provider name: ${definition.name}`);
      }
      this.providers.set(definition.name, {
        definition,
        fingerprint: computeDefinitionFingerprint(pickFingerprintable('enrichment-provider', definition)),
      });
    }
    for (const definition of definitions.scoringModels ?? []) {
      validateScoringModel(definition);
      const key = `${definition.name}@${definition.version}`;
      if (this.scoringModels.has(key)) {
        throw new ValidationError(`Duplicate scoring model identity: ${key}`);
      }
      this.scoringModels.set(key, { definition, fingerprint: computeDefinitionFingerprint(pickFingerprintable('scoring-model', definition)) });
    }
    for (const definition of definitions.routingPolicies ?? []) {
      validateRoutingPolicy(definition);
      const key = `${definition.name}@${definition.version}`;
      if (this.routingPolicies.has(key)) {
        throw new ValidationError(`Duplicate routing policy identity: ${key}`);
      }
      this.routingPolicies.set(key, { definition, fingerprint: computeDefinitionFingerprint(pickFingerprintable('routing-policy', definition)) });
    }
    let fallbacks = 0;
    for (const definition of definitions.routingTargets ?? []) {
      validateRoutingTarget(definition);
      if (this.routingTargets.has(definition.key)) {
        throw new ValidationError(`Duplicate routing target key: ${definition.key}`);
      }
      if (definition.kind === 'fallback') fallbacks += 1;
      this.routingTargets.set(definition.key, definition);
    }
    if (fallbacks > 1) {
      throw new ValidationError('At most one routing target may have kind "fallback"');
    }
  }

  /** @param {string} name — returns {definition, fingerprint} */
  getProvider(name) {
    const entry = this.providers.get(name);
    if (!entry) throw new NotFoundError('Enrichment provider', String(name));
    return entry;
  }

  /** @param {string} name @param {number} version */
  getScoringModel(name, version) {
    const entry = this.scoringModels.get(`${name}@${version}`);
    if (!entry) throw new NotFoundError('Scoring model', `${name}@${version}`);
    return entry;
  }

  /** @param {string} name @param {number} version */
  getRoutingPolicy(name, version) {
    const entry = this.routingPolicies.get(`${name}@${version}`);
    if (!entry) throw new NotFoundError('Routing policy', `${name}@${version}`);
    return entry;
  }

  /** Deterministic active + fallback target list (declared data only). */
  listTargets() {
    return [...this.routingTargets.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** The single declared fallback target, or null. */
  fallbackTarget() {
    return this.listTargets().find((target) => target.kind === 'fallback') ?? null;
  }

  /**
   * Record (or verify) the persisted identity of every enrichment provider,
   * scoring model and routing policy version. The same {type, name, version}
   * with a different fingerprint fails loudly: applied definitions are
   * immutable — publish a new version instead (rollback = a new version
   * derived from an earlier definition).
   *
   * Runs inside ONE `BEGIN IMMEDIATE` transaction, so registration is
   * all-or-nothing and two app instances booting concurrently serialize: the
   * loser re-reads committed rows and verifies instead of racing to a raw
   * UNIQUE violation. A busy database surfaces as the framework's stable
   * retryable CONFLICT, never a raw SQLITE error.
   * @param {any} database
   */
  persistFingerprints(database) {
    const entries = [
      ...[...this.providers.values()].map((entry) => ({ type: 'enrichment-provider', entry })),
      ...[...this.scoringModels.values()].map((entry) => ({ type: 'scoring-model', entry })),
      ...[...this.routingPolicies.values()].map((entry) => ({ type: 'routing-policy', entry })),
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
          insert.run(randomUUID(), type, name, version, entry.fingerprint, nowIso());
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

  /**
   * The declared-definition fingerprint of the ENTIRE routing target set
   * (sorted by key). Recorded on every RoutingRun so target drift (capacity,
   * priority, country, active edits) is visible per run — target sets are
   * explicitly versioned per run rather than boot-failing, because target
   * data legitimately changes between runs.
   */
  targetsFingerprint() {
    return computeDefinitionFingerprint(
      this.listTargets().map((target) => ({
        key: target.key,
        label: target.label ?? target.key,
        kind: target.kind,
        active: target.active,
        countries: (target.countries ?? []).slice(),
        languages: (target.languages ?? []).slice(),
        skills: (target.skills ?? []).slice(),
        capacity: target.capacity ?? null,
        priority: target.priority ?? 0,
        scoreMin: target.scoreMin ?? null,
        scoreMax: target.scoreMax ?? null,
      })),
    );
  }

  /** Serializable, function-free metadata for /api/schema and the Admin. */
  metadata() {
    return {
      enrichmentProviders: [...this.providers.values()]
        .sort((a, b) => (a.definition.name < b.definition.name ? -1 : 1))
        .map(({ definition, fingerprint }) => ({
          name: definition.name,
          version: definition.version,
          label: definition.label ?? definition.name,
          capabilities: definition.capabilities.slice().sort(),
          fingerprint,
        })),
      scoringModels: [...this.scoringModels.values()]
        .sort((a, b) => sortByNameVersion(a.definition, b.definition))
        .map(({ definition, fingerprint }) => ({
          name: definition.name,
          version: definition.version,
          label: definition.label ?? definition.name,
          fingerprint,
          rules: definition.rules.map((rule) => ({ key: rule.key, label: rule.label ?? rule.key, weight: rule.weight })),
          ...(definition.minScore !== undefined ? { minScore: definition.minScore } : {}),
          ...(definition.maxScore !== undefined ? { maxScore: definition.maxScore } : {}),
        })),
      routingPolicies: [...this.routingPolicies.values()]
        .sort((a, b) => sortByNameVersion(a.definition, b.definition))
        .map(({ definition, fingerprint }) => ({
          name: definition.name,
          version: definition.version,
          label: definition.label ?? definition.name,
          fingerprint,
        })),
      routingTargets: this.listTargets().map((target) => ({
        key: target.key,
        label: target.label ?? target.key,
        kind: target.kind,
        active: target.active,
        countries: (target.countries ?? []).slice(),
        languages: (target.languages ?? []).slice(),
        skills: (target.skills ?? []).slice(),
        capacity: target.capacity ?? null,
        priority: target.priority ?? 0,
        ...(target.scoreMin !== undefined ? { scoreMin: target.scoreMin } : {}),
        ...(target.scoreMax !== undefined ? { scoreMax: target.scoreMax } : {}),
      })),
      routingTargetsFingerprint: this.targetsFingerprint(),
    };
  }
}

/** @param {any} a @param {any} b */
function sortByNameVersion(a, b) {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.version - b.version;
}

/**
 * The fingerprintable projection of a definition: its declared identity and
 * behavior (rules/handlers included via toString), independent of property
 * order in source.
 * @param {string} type @param {any} definition
 */
function pickFingerprintable(type, definition) {
  if (type === 'scoring-model') {
    return {
      type,
      name: definition.name,
      version: definition.version,
      minScore: definition.minScore ?? null,
      maxScore: definition.maxScore ?? null,
      config: definition.config ?? null,
      rules: definition.rules.map((rule) => ({
        key: rule.key,
        label: rule.label ?? rule.key,
        weight: rule.weight,
        evaluate: rule.evaluate,
      })),
    };
  }
  if (type === 'enrichment-provider') {
    return {
      type,
      name: definition.name,
      version: definition.version,
      capabilities: definition.capabilities.slice().sort(),
      config: definition.config ?? null,
      enrichCompany: definition.enrichCompany ?? null,
    };
  }
  return {
    type,
    name: definition.name,
    version: definition.version,
    config: definition.config ?? null,
    route: definition.route,
  };
}
