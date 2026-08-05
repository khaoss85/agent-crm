// @ts-check
// Registry of code-first record actions (ADR-011). Each entry is a checked-in
// action definition validated at app startup: canonical module/name, contract
// version, target module existence, input schema and an `execute` function.
//
// This repository ships no product actions of its own; the Lead Qualification
// starter (examples/starters/b2b-lead-qualification) copies its qualify and
// disqualify definitions in here when applied into a project. Keeping the base
// registry empty means the framework has no product-specific behavior baked in.

/**
 * @typedef {import('../../core/src/action-registry.js').ActionDefinition} ActionDefinition
 */

/** @type {ActionDefinition[]} */
export const generatedActions = [];
