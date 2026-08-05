// @ts-check

import { ValidationError } from './errors.js';

/**
 * Application-level reference resolver (ADR-010). Validates that a reference
 * value points at an existing record in a target generated module, going
 * through that module's service boundary — never a direct cross-module SQL
 * query, never a static import between generated modules.
 *
 * Resolution is lazy (per call) against the live registry, so a module may
 * reference a module registered after it, itself, or in a cycle. It is built
 * per application instance and closes over that instance's registry, so no
 * mutable state leaks between apps or tests.
 *
 * @param {{ modules: Map<string, any> }} registry — the ModuleRegistry instance
 */
export function createReferenceResolver(registry) {
  /** @param {string} targetTable */
  function findGeneratedTarget(targetTable) {
    for (const module of registry.modules.values()) {
      if (module.kind === 'generated' && module.table === targetTable) return module;
    }
    return null;
  }

  return {
    /**
     * @param {string} targetTable — canonical table name from validated metadata
     * @param {unknown} id — the reference value
     * @param {string} fieldName — for error messages
     * @returns {string} the validated id
     */
    assertTarget(targetTable, id, fieldName) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new ValidationError(`${fieldName} must reference an existing record`, { field: fieldName });
      }
      const target = findGeneratedTarget(targetTable);
      if (
        !target ||
        !Array.isArray(target.capabilities) ||
        !target.capabilities.includes('get') ||
        typeof target.service?.get !== 'function'
      ) {
        // Fail closed: unknown target module, or one without a get capability.
        throw new ValidationError(`${fieldName} target module is not available`, { field: fieldName });
      }
      try {
        target.service.get(id);
      } catch {
        throw new ValidationError(
          `${fieldName} references a ${targetTable} record that does not exist`,
          { field: fieldName, value: id },
        );
      }
      return id;
    },
  };
}
