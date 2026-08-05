// @ts-check

import { ValidationError } from './errors.js';

/**
 * The static contract a module definition must satisfy to be exposed through
 * the generic generated-module surface (ADR-008).
 *
 * Threat model: repository source code is trusted — this contract cannot and
 * does not defend against someone who can rewrite and execute the code. It
 * exists to fail closed on accidental, malformed, stale or hand-edited
 * registry entries, so a broken definition surfaces as a clear error (at app
 * startup) or a 404 (on the HTTP surface) instead of an undefined-function
 * crash or a partially wrong schema.
 */

export const GENERATED_MODULE_KIND = 'generated';
export const GENERATED_CAPABILITIES = Object.freeze(['create', 'get', 'list', 'update']);

const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;

/**
 * Boolean, never-throwing form used by request-time checks: anything that does
 * not fully satisfy the contract is simply not exposable.
 *
 * @param {unknown} module
 */
export function isExposableGeneratedModule(module) {
  try {
    validateGeneratedModuleDefinition(module);
    return true;
  } catch {
    return false;
  }
}

/**
 * Throwing form used at startup: a corrupted registry entry should stop the
 * application with a precise message, not serve a half-working module.
 *
 * @param {unknown} module
 */
export function validateGeneratedModuleDefinition(module) {
  if (module === null || typeof module !== 'object') {
    throw new ValidationError('Generated module definition must be an object');
  }
  const definition = /** @type {Record<string, any>} */ (module);
  const label = typeof definition.name === 'string' ? `generated module "${definition.name}"` : 'generated module';

  if (typeof definition.name !== 'string' || !MODULE_NAME_PATTERN.test(definition.name)) {
    throw new ValidationError(`${label}: name must match ${MODULE_NAME_PATTERN}`);
  }
  if (definition.kind !== GENERATED_MODULE_KIND) {
    throw new ValidationError(`${label}: kind must be exactly "${GENERATED_MODULE_KIND}"`);
  }
  if (!Number.isInteger(definition.manifestVersion) || definition.manifestVersion < 1) {
    throw new ValidationError(`${label}: manifestVersion must be a positive integer`);
  }
  if (!Array.isArray(definition.capabilities) || definition.capabilities.length === 0) {
    throw new ValidationError(`${label}: capabilities must be a non-empty array`);
  }
  const seen = new Set();
  for (const capability of definition.capabilities) {
    if (!GENERATED_CAPABILITIES.includes(capability)) {
      throw new ValidationError(
        `${label}: unsupported capability ${JSON.stringify(capability)} (supported: ${GENERATED_CAPABILITIES.join(', ')})`,
      );
    }
    if (seen.has(capability)) {
      throw new ValidationError(`${label}: duplicate capability "${capability}"`);
    }
    seen.add(capability);
    if (typeof definition.service?.[capability] !== 'function') {
      throw new ValidationError(`${label}: declared capability "${capability}" has no service function`);
    }
  }
  if (!Array.isArray(definition.fields)) {
    throw new ValidationError(`${label}: fields metadata must be an array`);
  }
  for (const field of definition.fields) {
    if (
      field === null ||
      typeof field !== 'object' ||
      typeof field.name !== 'string' ||
      !FIELD_NAME_PATTERN.test(field.name) ||
      typeof field.type !== 'string' ||
      typeof field.required !== 'boolean' ||
      typeof field.unique !== 'boolean'
    ) {
      throw new ValidationError(`${label}: malformed field metadata entry`);
    }
  }
  return /** @type {{name: string, kind: string, manifestVersion: number, capabilities: string[], fields: any[], service: Record<string, Function>}} */ (definition);
}
