// @ts-check

/**
 * Checked-in registry of optional domain packages (ADR-018 addendum).
 *
 * A domain package owns its records, actions and versioned policies and is
 * registered here by static import — the same code-first pattern used for
 * actions, pipelines, intelligence, commercial and signature. Empty in this
 * repository: a project (or a starter install) writes the imports it wants.
 *
 * The kernel never imports a domain package; composition happens only here.
 * Removing a line here removes the whole domain, and the application must
 * keep working without it.
 *
 * Example:
 *
 *   import { createContractsDomain } from '../../contracts/src/index.js';
 *   export const generatedDomains = [createContractsDomain()];
 */

export const generatedDomains = [];
