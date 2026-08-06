// @ts-check

import { randomUUID } from 'node:crypto';
import { ValidationError, NotFoundError, AppError } from './errors.js';
import { computeDefinitionFingerprint, validateDeclaredConfig } from './intelligence-registry.js';

/**
 * Optional domain packages (ADR-018 addendum).
 *
 * The kernel is a platform runtime; domain behavior lives in optional
 * packages. This module is the **generic** seam that lets a package register
 * its actions and its versioned policies without the kernel knowing anything
 * about the domain: no domain name, record name or business concept appears
 * here or anywhere else in `packages/core`.
 *
 * A domain package exports one static definition:
 *
 *   {
 *     name: 'contracts',            canonical, unique
 *     domainContract: 1,
 *     label: 'Contracts',
 *     actions: [ …action definitions… ],
 *     policies: [ {kind, definition:{name, version, label, config, …handlers}} ],
 *     metadata(): {…}               function-free, additive schema block
 *   }
 *
 * Everything is validated fail-closed at startup, policy versions are
 * fingerprinted and persisted exactly like every other declared definition
 * (ADR-015), and the registry is Map-backed so a hostile or non-canonical
 * name can never resolve through the prototype chain.
 *
 * The kernel never imports a domain package: composition happens in the
 * checked-in `packages/domains/generated/index.js`, the same static-import
 * pattern used for actions, pipelines, intelligence, commercial and signature.
 */

const NAME_RE = /^[a-z][a-z0-9-]*$/;
const MAX_LABEL = 80;
const MAX_VERSION = 1_000_000;
const SUPPORTED_DOMAIN_CONTRACT = 1;

/** @param {string} label @param {any} definition */
function assertPolicyIdentity(label, definition) {
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

/** @param {any} domain */
export function validateDomainDefinition(domain) {
  if (!domain || typeof domain !== 'object') {
    throw new ValidationError('Domain package definition must be an object');
  }
  const label = typeof domain.name === 'string' ? `domain "${domain.name}"` : 'domain package';
  if (typeof domain.name !== 'string' || !NAME_RE.test(domain.name)) {
    throw new ValidationError(`${label}: name must match ${NAME_RE}`);
  }
  if (domain.domainContract !== SUPPORTED_DOMAIN_CONTRACT) {
    throw new ValidationError(`${label}: domainContract must be ${SUPPORTED_DOMAIN_CONTRACT}`);
  }
  if (domain.label !== undefined && (typeof domain.label !== 'string' || domain.label.length === 0 || domain.label.length > MAX_LABEL)) {
    throw new ValidationError(`${label}: label must be a non-empty string of at most ${MAX_LABEL} characters`);
  }
  if (domain.actions !== undefined && !Array.isArray(domain.actions)) {
    throw new ValidationError(`${label}: actions must be an array`);
  }
  if (domain.policies !== undefined && !Array.isArray(domain.policies)) {
    throw new ValidationError(`${label}: policies must be an array`);
  }
  if (domain.metadata !== undefined && typeof domain.metadata !== 'function') {
    throw new ValidationError(`${label}: metadata must be a function when present`);
  }
  for (const entry of domain.policies ?? []) {
    if (!entry || typeof entry !== 'object') {
      throw new ValidationError(`${label}: each policy entry must be an object`);
    }
    if (typeof entry.kind !== 'string' || !NAME_RE.test(entry.kind)) {
      throw new ValidationError(`${label}: policy kind must match ${NAME_RE}`);
    }
    assertPolicyIdentity(`${label} policy kind "${entry.kind}"`, entry.definition);
  }
  return domain;
}

/**
 * Per-app registry of optional domain packages. One malformed definition
 * stops startup — a half-registered domain is never served.
 */
export class DomainRegistries {
  /** @param {{domains?: any[]}} [definitions] */
  constructor(definitions = {}) {
    /** @type {Map<string, any>} */
    this.domains = new Map();
    /** @type {Map<string, {domain: string, kind: string, definition: any, fingerprint: string}>} */
    this.policies = new Map();

    for (const domain of definitions.domains ?? []) {
      validateDomainDefinition(domain);
      if (this.domains.has(domain.name)) {
        throw new ValidationError(`Duplicate domain package name: ${domain.name}`);
      }
      this.domains.set(domain.name, domain);
      for (const { kind, definition } of domain.policies ?? []) {
        const key = `${domain.name}/${kind}/${definition.name}@${definition.version}`;
        if (this.policies.has(key)) {
          throw new ValidationError(`Duplicate policy identity: ${key}`);
        }
        this.policies.set(key, {
          domain: domain.name,
          kind,
          definition,
          // The declared-definition fingerprint (ADR-015): canonical source
          // plus declared JSON-safe config. Closure-held values stay invisible
          // to it, which is why thresholds belong in `config`.
          fingerprint: computeDefinitionFingerprint({
            type: `domain-policy:${kind}`,
            domain: domain.name,
            name: definition.name,
            version: definition.version,
            config: definition.config ?? null,
            handlers: Object.keys(definition)
              .filter((property) => typeof definition[property] === 'function')
              .sort()
              .map((property) => ({ property, source: definition[property] })),
          }),
        });
      }
    }
  }

  /** Every action contributed by every registered domain, in registration order. */
  actions() {
    return [...this.domains.values()].flatMap((domain) => domain.actions ?? []);
  }

  /** @param {string} name */
  get(name) {
    const domain = this.domains.get(name);
    if (!domain) throw new NotFoundError('Domain package', String(name));
    return domain;
  }

  /** @param {string} name */
  has(name) {
    return this.domains.has(name);
  }

  /**
   * Resolve a versioned domain policy. Map-backed, so `__proto__` and friends
   * simply do not exist, and a version is always explicit — never an implicit
   * "latest".
   * @param {string} domain @param {string} kind @param {string} name @param {number} version
   */
  getPolicy(domain, kind, name, version) {
    const entry = this.policies.get(`${domain}/${kind}/${name}@${version}`);
    if (!entry) throw new NotFoundError('Domain policy', `${domain}/${kind}/${name}@${version}`);
    return entry;
  }

  /**
   * Persist-or-verify every policy identity in `definition_versions`, in one
   * transaction (ADR-015 semantics): editing a registered version's source or
   * config stops the next boot, and rollback means publishing a new version.
   * @param {any} database
   */
  persistFingerprints(database) {
    const entries = [...this.policies.values()];
    if (entries.length === 0) return;
    database.transaction(() => {
      const select = database.raw.prepare('SELECT fingerprint FROM definition_versions WHERE type = ? AND name = ? AND version = ?');
      const insert = database.raw.prepare(
        'INSERT INTO definition_versions(id, type, name, version, fingerprint, registered_at) VALUES (?, ?, ?, ?, ?, ?)',
      );
      for (const entry of entries) {
        const type = `domain-policy:${entry.domain}:${entry.kind}`;
        const { name, version } = entry.definition;
        const existing = select.get(type, name, version);
        if (existing === undefined) {
          insert.run(randomUUID(), type, name, version, entry.fingerprint, new Date().toISOString());
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
   * Serializable, function-free metadata for `/api/schema`. A domain's own
   * `metadata()` is called once and must return plain data; anything else is a
   * startup-time defect surfaced as a stable error rather than a broken
   * schema response.
   */
  metadata() {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [name, domain] of [...this.domains.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const declared = typeof domain.metadata === 'function' ? domain.metadata() : {};
      if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
        throw new AppError(`Domain package "${name}" metadata() must return a plain object`, {
          code: 'DOMAIN_METADATA_INVALID', status: 500,
        });
      }
      out[name] = {
        domainContract: SUPPORTED_DOMAIN_CONTRACT,
        label: domain.label ?? name,
        actions: (domain.actions ?? []).map((action) => `${action.module}.${action.name}`).sort(),
        policies: [...this.policies.values()]
          .filter((entry) => entry.domain === name)
          .map((entry) => ({
            kind: entry.kind,
            name: entry.definition.name,
            version: entry.definition.version,
            label: entry.definition.label ?? entry.definition.name,
            fingerprint: entry.fingerprint,
          }))
          .sort((a, b) => (a.kind === b.kind ? a.version - b.version : a.kind < b.kind ? -1 : 1)),
        ...declared,
      };
    }
    return out;
  }
}
