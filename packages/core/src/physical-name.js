// @ts-check

import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

/**
 * PostgreSQL NAMEDATALEN is 64, so the maximum identifier payload is 63 bytes.
 * The server truncates silently past that; this map never asks it to.
 */
export const POSTGRES_IDENTIFIER_MAX_BYTES = 63;
export const POSTGRES_SCHEMA_NAME = 'accordo';

const SAFE_IDENT = /^[a-z][a-z0-9_]*$/;
const DIGEST_HEX_LENGTH = 16;
const PHYSICAL_NAME_DOMAIN = 'accordo.physical-name.v1';

/**
 * @typedef {{
 *   logical: string,
 *   physical: string,
 *   mapped: boolean,
 * }} PhysicalNameMapping
 */

/**
 * @param {string} logical
 * @returns {PhysicalNameMapping}
 */
export function mapPhysicalName(logical) {
  if (typeof logical !== 'string' || logical.length === 0) {
    throw new AppError('Physical name mapping requires a non-empty logical identifier', {
      code: 'PHYSICAL_NAME_INVALID',
      status: 500,
    });
  }
  const byteLength = Buffer.byteLength(logical, 'utf8');
  if (SAFE_IDENT.test(logical) && byteLength <= POSTGRES_IDENTIFIER_MAX_BYTES) {
    return Object.freeze({ logical, physical: logical, mapped: false });
  }

  const digest = createHash('sha256')
    .update(PHYSICAL_NAME_DOMAIN)
    .update('\0')
    .update(logical)
    .digest('hex')
    .slice(0, DIGEST_HEX_LENGTH);
  const prefixBudget = POSTGRES_IDENTIFIER_MAX_BYTES - 1 - DIGEST_HEX_LENGTH;
  const prefix = boundedSafePrefix(logical, prefixBudget);
  const physical = `${prefix}_${digest}`;
  if (Buffer.byteLength(physical, 'utf8') > POSTGRES_IDENTIFIER_MAX_BYTES || !SAFE_IDENT.test(physical)) {
    throw new AppError('Physical name mapping produced an unsafe identifier', {
      code: 'PHYSICAL_NAME_INVALID',
      status: 500,
      details: { logical },
    });
  }
  return Object.freeze({ logical, physical, mapped: true });
}

/**
 * Map a complete identifier namespace and refuse collisions before DDL.
 * Duplicate logical names are allowed (one mapping); two different logical
 * names must not share a physical name.
 *
 * @param {Iterable<string>} logicalNames
 * @returns {readonly PhysicalNameMapping[]}
 */
export function mapPhysicalNamespace(logicalNames) {
  /** @type {PhysicalNameMapping[]} */
  const mappings = [];
  /** @type {Map<string, string>} */
  const physicalToLogical = new Map();
  /** @type {Set<string>} */
  const seenLogical = new Set();

  for (const logical of logicalNames) {
    if (seenLogical.has(logical)) continue;
    seenLogical.add(logical);
    const mapped = mapPhysicalName(logical);
    const owner = physicalToLogical.get(mapped.physical);
    if (owner !== undefined && owner !== logical) {
      throw new AppError('Physical identifier mapping collided before DDL', {
        code: 'PHYSICAL_NAME_COLLISION',
        status: 500,
        details: { left: owner, right: logical },
      });
    }
    physicalToLogical.set(mapped.physical, logical);
    mappings.push(mapped);
  }

  return Object.freeze(mappings);
}

/**
 * Quote a physical identifier for PostgreSQL. Callers pass already-mapped
 * physical names, never raw logical names that might exceed 63 bytes.
 *
 * @param {string} physical
 */
export function quotePostgresIdent(physical) {
  if (typeof physical !== 'string' || physical.length === 0) {
    throw new AppError('PostgreSQL identifier quoting requires a physical name', {
      code: 'PHYSICAL_NAME_INVALID',
      status: 500,
    });
  }
  if (Buffer.byteLength(physical, 'utf8') > POSTGRES_IDENTIFIER_MAX_BYTES) {
    throw new AppError('PostgreSQL identifier exceeds NAMEDATALEN-1', {
      code: 'PHYSICAL_NAME_INVALID',
      status: 500,
    });
  }
  return `"${physical.replaceAll('"', '""')}"`;
}

/**
 * @param {string} schema
 * @param {string} physical
 */
export function qualifyPostgresIdent(schema, physical) {
  return `${quotePostgresIdent(schema)}.${quotePostgresIdent(physical)}`;
}

/**
 * @param {string} logical
 * @param {number} maxBytes
 */
function boundedSafePrefix(logical, maxBytes) {
  let sanitized = '';
  for (const char of logical.toLowerCase()) {
    sanitized += /[a-z0-9_]/.test(char) ? char : '_';
  }
  sanitized = sanitized.replace(/_+/g, '_').replace(/^_+/, '').replace(/_+$/, '');
  if (!/^[a-z]/.test(sanitized)) sanitized = `n${sanitized}`;
  if (sanitized.length > maxBytes) {
    sanitized = sanitized.slice(0, maxBytes).replace(/_+$/, '');
  }
  if (!sanitized || !/^[a-z]/.test(sanitized)) sanitized = 'n';
  if (sanitized.length > maxBytes) sanitized = sanitized.slice(0, maxBytes);
  return sanitized;
}
