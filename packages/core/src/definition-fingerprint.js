// @ts-check

import { createHash } from 'node:crypto';
import { ValidationError } from './errors.js';

/**
 * Declared-definition fingerprints (ADR-015) — the horizontal mechanism every
 * versioned definition uses, in a module that names no domain.
 *
 * This code was written for Lead Intelligence and lived in that domain's
 * registry module for that reason alone. It knows nothing about enrichment,
 * scoring or routing, and by the time it moved it was already the
 * fingerprint mechanism for Commercial Operations discount policies (ADR-016),
 * Signature providers (ADR-017), package definitions (ADR-018) and delivery
 * cost policies. Six kernel modules and one package were importing an
 * Intelligence file to reach it.
 *
 * Nothing here changed in the move: same canonical form, same digests. That is
 * checkable rather than asserted — the LA0 baseline pins thirteen fingerprint
 * shapes plus the two properties every consumer depends on (key order
 * irrelevant, array order significant), and it is byte-identical across the
 * move.
 */

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
 *
 * It travels with `computeDefinitionFingerprint` because both are the same
 * canonicalizer seen from two directions: one hashes what canonicalizes, the
 * other refuses what does not. Splitting them would leave the canonical form
 * defined in one module and enforced from another.
 * @param {string} label @param {unknown} config
 */
export function validateDeclaredConfig(label, config) {
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
