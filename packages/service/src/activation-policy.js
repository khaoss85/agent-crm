// @ts-check

import { ValidationError } from '../../core/index.js';

/**
 * The Service Activation Policy contract (ADR-015 shape).
 *
 * A policy decides, deterministically and from declared inputs only, what one
 * pending service obligation entitles a customer to: a support tier, which case
 * categories and priorities are covered, and the two elapsed-time targets. It
 * may also say it **cannot** decide, which is how an ambiguous obligation
 * becomes a human decision instead of a guess.
 *
 * It is code-first, versioned and fingerprinted like every other declared
 * definition here: same version + different content is refused at startup, so a
 * stored `policyFingerprint` on a coverage always identifies the exact rules
 * that produced it.
 *
 * What a handler may not do, enforced by the frozen context it receives: read
 * the network, read the database, read a clock, read a random source, or return
 * a function. It gets the obligation and the contract snapshot, and returns a
 * plain object.
 *
 * This is deliberately **not** a general entitlement DSL. It is one decision
 * with a bounded output, because a DSL is a language nobody can version.
 */

export const SERVICE_POLICY_KIND = 'service-activation-policy';

export const CASE_PRIORITIES = Object.freeze(['low', 'normal', 'high', 'urgent']);
/** Ambiguity is an outcome, not an exception: a human resolves it with a reason. */
export const AMBIGUOUS = 'ambiguous';

const NAME_RE = /^[a-z][a-z0-9-]{2,63}$/;
const CATEGORY_RE = /^[a-z][a-z0-9-]{1,39}$/;
const MAX_CATEGORIES = 20;
const MAX_LABEL = 200;
/** Ten years of minutes: past this a "target" is not a target. */
const MAX_TARGET_MINUTES = 5_256_000;

/**
 * Validate and freeze a policy definition.
 * @param {any} definition
 */
export function defineServiceActivationPolicy(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('A service activation policy must be an object', { field: 'policy' });
  }
  const { name, version, label, decide } = definition;
  if (typeof name !== 'string' || !NAME_RE.test(name)) {
    throw new ValidationError('A service activation policy needs a lowercase kebab-case name', { field: 'name' });
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new ValidationError('A service activation policy needs an integer version of at least 1', { field: 'version' });
  }
  if (typeof decide !== 'function') {
    throw new ValidationError('A service activation policy needs a synchronous decide(context) handler', { field: 'decide' });
  }
  if (decide.constructor?.name === 'AsyncFunction') {
    // An async handler could await anything — a fetch, a query, a timer — and
    // the determinism this whole contract rests on would be unprovable.
    throw new ValidationError('A service activation policy handler must be synchronous', { field: 'decide' });
  }
  const config = definition.config === undefined ? {} : definition.config;
  assertJsonSafe(config, 'config');
  return Object.freeze({
    kind: SERVICE_POLICY_KIND,
    name,
    version,
    label: typeof label === 'string' && label !== '' ? label.slice(0, MAX_LABEL) : name,
    config: deepFreeze(structuredClone(config)),
    decide,
  });
}

/**
 * Run a policy against one obligation and normalize what it said.
 *
 * The handler receives a **deep-frozen** context, so a policy that tries to
 * mutate its inputs fails loudly here rather than corrupting the activation
 * halfway through.
 *
 * @param {any} policy @param {{obligation: any, contract: any}} input
 */
export function decideEntitlement(policy, input) {
  const context = deepFreeze({
    config: policy.config,
    obligation: structuredClone(input.obligation),
    contract: structuredClone(input.contract),
    priorities: [...CASE_PRIORITIES],
  });
  const raw = policy.decide(context);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`Service activation policy "${policy.name}@${policy.version}" returned no decision`, { field: 'decide' });
  }
  if (raw.outcome === AMBIGUOUS) {
    return Object.freeze({
      outcome: AMBIGUOUS,
      reason: boundedText(raw.reason, 'reason', MAX_LABEL)
        ?? 'the policy could not decide what this obligation entitles the customer to',
    });
  }
  const supportTier = boundedText(raw.supportTier, 'supportTier', 60);
  if (!supportTier) {
    throw new ValidationError(`Service activation policy "${policy.name}@${policy.version}" returned no supportTier`, { field: 'supportTier' });
  }
  return Object.freeze({
    outcome: 'entitled',
    supportTier,
    categories: enumeratedList(raw.categories, 'categories', CATEGORY_RE),
    priorities: subsetOf(raw.priorities, CASE_PRIORITIES, 'priorities'),
    firstResponseTargetMinutes: targetMinutes(raw.firstResponseTargetMinutes, 'firstResponseTargetMinutes'),
    resolutionTargetMinutes: targetMinutes(raw.resolutionTargetMinutes, 'resolutionTargetMinutes'),
    maxOpenCases: optionalCount(raw.maxOpenCases, 'maxOpenCases'),
    reason: boundedText(raw.reason, 'reason', MAX_LABEL),
  });
}

/** Function-free metadata for the schema and for `app inspect`. */
export function servicePolicyMetadata(policies) {
  return (policies ?? []).map(({ definition }) => Object.freeze({
    kind: SERVICE_POLICY_KIND,
    name: definition.name,
    version: definition.version,
    label: definition.label,
  }));
}

function targetMinutes(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`${field} must be a positive whole number of minutes`, { field });
  }
  if (value > MAX_TARGET_MINUTES) {
    throw new ValidationError(`${field} exceeds the supported range for an elapsed-time target`, { field });
  }
  return value;
}

function optionalCount(value, field) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1) {
    throw new ValidationError(`${field} must be a whole number of at least 1`, { field });
  }
  return value;
}

function enumeratedList(value, field, pattern) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty array`, { field });
  }
  if (value.length > MAX_CATEGORIES) {
    throw new ValidationError(`${field} must contain at most ${MAX_CATEGORIES} entries`, { field });
  }
  const seen = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !pattern.test(entry)) {
      throw new ValidationError(`${field} entries must be lowercase kebab-case labels`, { field });
    }
    if (!seen.includes(entry)) seen.push(entry);
  }
  return seen.sort();
}

function subsetOf(value, allowed, field) {
  if (value === undefined || value === null) return [...allowed];
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty array`, { field });
  }
  const seen = [];
  for (const entry of value) {
    if (!allowed.includes(entry)) {
      throw new ValidationError(`${field} must be a subset of ${allowed.join(', ')}`, { field });
    }
    if (!seen.includes(entry)) seen.push(entry);
  }
  return allowed.filter((entry) => seen.includes(entry));
}

function boundedText(value, field, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, { field });
  return value.trim().slice(0, max);
}

/** JSON-safe: a config that carries a function cannot be fingerprinted. */
function assertJsonSafe(value, field) {
  const seen = new WeakSet();
  const walk = (node, path) => {
    if (node === null) return;
    const type = typeof node;
    if (type === 'string' || type === 'boolean') return;
    if (type === 'number') {
      if (!Number.isFinite(node)) throw new ValidationError(`${path} must be a finite number`, { field });
      return;
    }
    if (type !== 'object') throw new ValidationError(`${path} must be JSON-safe`, { field });
    if (seen.has(node)) throw new ValidationError(`${path} must not be circular`, { field });
    seen.add(node);
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new ValidationError(`${path}.${key} is not an allowed key`, { field });
      }
      walk(node[key], `${path}.${key}`);
    }
  };
  walk(value, field);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}
