// @ts-check

/**
 * Checked-in registry of code-first Commercial Operations definitions
 * (ADR-016): catalog providers and versioned discount policies. Empty in this
 * repository — a project (or starter install) writes real definitions here,
 * mirroring actions/pipelines/intelligence. Static imports only: no
 * filesystem discovery, no dynamic loading, no eval.
 *
 * Catalog providers and discount policies are versioned with declared-
 * definition fingerprints persisted in `definition_versions` (ADR-015
 * mechanism): editing a registered version's source or config stops the next
 * boot. Rollback = publish a NEW version derived from an earlier definition.
 *
 * Future provider packages may target Stripe Products/Prices, Zuora, ERP or
 * custom CPQ/catalog APIs; none ships in this repository.
 */

export const generatedCatalogProviders = [];
export const generatedDiscountPolicies = [];
