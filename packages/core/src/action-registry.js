// @ts-check

import { NotFoundError, ValidationError } from './errors.js';
import { PERMISSIONS } from './authorization.js';

export const SUPPORTED_ACTION_CONTRACT = 1;
const NAME_RE = /^[a-z][a-z0-9-]*$/;
// `json` is bounded structured input (a signer list, ADR-017): the runtime
// normalizes it to plain JSON-safe data, drops dangerous keys and bounds its
// serialized size; the action still validates the domain shape itself.
const INPUT_TYPES = new Set(['string', 'timestamp', 'enum', 'integer', 'boolean', 'json']);

/**
 * @typedef {{
 *   module: string,
 *   name: string,
 *   label?: string,
 *   description?: string,
 *   actionContract: 1,
 *   input?: Array<{name: string, type: 'string' | 'timestamp' | 'enum' | 'integer', required?: boolean, values?: string[]}>,
 *   fromStates?: string[],
 *   stateField?: string,
 *   confirm?: boolean,
 *   execute: (ctx: any) => unknown | Promise<unknown>
 * }} ActionDefinition
 */

/**
 * Validate a code-first action definition (ADR-011). Fail closed: a malformed
 * definition throws, which stops app startup rather than exposing partial
 * behavior. Source code is trusted; this guards against accidental/stale
 * definitions, not malicious edits.
 *
 * @param {any} definition
 * @param {{moduleExists: (name: string) => boolean}} deps
 */
export function validateActionDefinition(definition, deps) {
  if (!definition || typeof definition !== 'object') {
    throw new ValidationError('Action definition must be an object');
  }
  const label = typeof definition.name === 'string' ? `action "${definition.module}.${definition.name}"` : 'action';
  if (typeof definition.module !== 'string' || !NAME_RE.test(definition.module)) {
    throw new ValidationError(`${label}: module must match ${NAME_RE}`);
  }
  if (typeof definition.name !== 'string' || !NAME_RE.test(definition.name)) {
    throw new ValidationError(`${label}: name must match ${NAME_RE}`);
  }
  if (definition.actionContract !== SUPPORTED_ACTION_CONTRACT) {
    throw new ValidationError(`${label}: actionContract must be ${SUPPORTED_ACTION_CONTRACT}`);
  }
  // ADR-038. `requiredPermission` is contractual, so it is checked where every
  // other contractual field is checked: at registration, not at the first
  // request. An unknown key would otherwise fail closed at request time — which
  // is fail-closed but not fail-fast, and this repository's own rule is that a
  // process boots correctly configured or does not boot.
  //
  // The floor matters more than the spelling. Every record action mutates a
  // record, which is exactly why the default is `records.write`; a declaration
  // is there to ask for something *stronger*, never to drop below it. Without
  // this check a package could declare `records.read` on a mutating action and
  // silently hand every viewer a write.
  if (definition.requiredPermission !== undefined) {
    if (typeof definition.requiredPermission !== 'string' || !PERMISSIONS.includes(definition.requiredPermission)) {
      throw new ValidationError(
        `${label}: requiredPermission must be one of ${PERMISSIONS.join(', ')}`,
      );
    }
    if (definition.requiredPermission === 'records.read') {
      throw new ValidationError(
        `${label}: a record action mutates a record, so it may not require only "records.read" — `
        + 'declare a stronger permission or none at all',
      );
    }
  }
  if (!deps.moduleExists(definition.module)) {
    throw new ValidationError(`${label}: target module "${definition.module}" is not a generated module`);
  }
  // Ordinary actions declare one `execute` that runs inside one transaction.
  // External-operation actions (ADR-017) instead declare the phases the
  // external-operation runner sequences around a remote call: they need two
  // local write transactions, which a single `execute` cannot express
  // honestly. Exactly one of the two shapes must be present.
  if (definition.externalOperation !== undefined) {
    if (definition.externalOperation !== SUPPORTED_ACTION_CONTRACT) {
      throw new ValidationError(`${label}: externalOperation must be ${SUPPORTED_ACTION_CONTRACT}`);
    }
    if (typeof definition.execute === 'function') {
      throw new ValidationError(`${label}: an external-operation action declares intent/external/finalize phases, not execute`);
    }
    if (typeof definition.intent !== 'function') {
      throw new ValidationError(`${label}: intent must be a function`);
    }
    for (const phase of ['external', 'finalize', 'compensate']) {
      if (definition[phase] !== undefined && typeof definition[phase] !== 'function') {
        throw new ValidationError(`${label}: ${phase} must be a function when present`);
      }
    }
    if (typeof definition.prepare === 'function') {
      throw new ValidationError(`${label}: an external-operation action cannot also declare a prepare phase`);
    }
  } else if (typeof definition.execute !== 'function') {
    throw new ValidationError(`${label}: execute must be a function`);
  }
  if (definition.input !== undefined) {
    if (!Array.isArray(definition.input)) throw new ValidationError(`${label}: input must be an array`);
    const seen = new Set();
    for (const field of definition.input) {
      if (!field || typeof field.name !== 'string' || !/^[a-z][a-zA-Z0-9]*$/.test(field.name)) {
        throw new ValidationError(`${label}: each input needs a camelCase name`);
      }
      if (seen.has(field.name)) throw new ValidationError(`${label}: duplicate input "${field.name}"`);
      seen.add(field.name);
      if (!INPUT_TYPES.has(field.type)) {
        throw new ValidationError(`${label}: input "${field.name}" type must be one of: ${[...INPUT_TYPES].join(', ')}`);
      }
      if (field.type === 'enum' && (!Array.isArray(field.values) || field.values.length === 0)) {
        throw new ValidationError(`${label}: enum input "${field.name}" needs values`);
      }
      if (field.hint !== undefined && (typeof field.hint !== 'string' || field.hint.length > 200)) {
        throw new ValidationError(`${label}: input "${field.name}" hint must be a string of at most 200 characters`);
      }
    }
  }
  if (definition.fromStates !== undefined && !Array.isArray(definition.fromStates)) {
    throw new ValidationError(`${label}: fromStates must be an array`);
  }
  // Optional prepare phase (ADR-015): runs before the write transaction for
  // external-style side effects. Additive to actionContract 1.
  if (definition.prepare !== undefined && typeof definition.prepare !== 'function') {
    throw new ValidationError(`${label}: prepare must be a function when present`);
  }
  return definition;
}

/**
 * Registry of code-first actions, keyed by `${module}${name}` in a Map
 * (never a plain object, so `__proto__`/`constructor` names cannot resolve to
 * inherited properties). Deterministic order by module then name.
 */
export class ActionRegistry {
  /** @param {{moduleExists: (name: string) => boolean}} deps */
  constructor(deps) {
    this.deps = deps;
    /** @type {Map<string, any>} */
    this.actions = new Map();
  }

  /** @param {any} definition */
  register(definition) {
    validateActionDefinition(definition, this.deps);
    const key = `${definition.module}${definition.name}`;
    if (this.actions.has(key)) {
      throw new ValidationError(`Duplicate action identity: ${definition.module}.${definition.name}`);
    }
    this.actions.set(key, definition);
    return definition;
  }

  /** @param {string} module @param {string} name */
  get(module, name) {
    const action = this.actions.get(`${module}${name}`);
    if (!action) throw new NotFoundError('Action', `${module}.${name}`);
    return action;
  }

  /** @param {string} module — metadata for one module's actions, sorted by name */
  listForModule(module) {
    return [...this.actions.values()]
      .filter((action) => action.module === module)
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((action) => actionMetadata(action));
  }
}

/** @param {any} action */
export function actionMetadata(action) {
  return {
    name: action.name,
    label: action.label ?? action.name,
    description: action.description ?? null,
    actionContract: SUPPORTED_ACTION_CONTRACT,
    input: (action.input ?? []).map((field) => ({
      name: field.name,
      type: field.type,
      required: field.required === true,
      ...(field.values ? { values: field.values.slice() } : {}),
      // Free-text guidance rendered under the control (as text, never HTML) —
      // e.g. making an integer-minor-units money field unmistakable.
      ...(typeof field.hint === 'string' ? { hint: field.hint } : {}),
    })),
    fromStates: Array.isArray(action.fromStates) ? action.fromStates.slice() : null,
    stateField: typeof action.stateField === 'string' ? action.stateField : 'status',
    confirm: action.confirm === true,
    path: `/api/modules/${action.module}/records/:id/actions/${action.name}`,
  };
}
