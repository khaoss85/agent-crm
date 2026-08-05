// @ts-check

/**
 * Checked-in registry of code-first Lead Intelligence definitions (ADR-015):
 * enrichment providers, scoring models, routing policies and routing targets.
 * Empty in this repository — a project (or starter install) writes real
 * definitions here, mirroring packages/actions/generated and
 * packages/pipelines/generated. Static imports only: no filesystem discovery,
 * no dynamic loading, no eval.
 *
 * Scoring models and routing policies are versioned: registering
 * {name, version} persists a deterministic source fingerprint in the
 * definition_versions table, and changing a registered version's source fails
 * startup. Publish a NEW version instead (rollback = a new version derived
 * from an earlier definition).
 */

export const generatedEnrichmentProviders = [];
export const generatedScoringModels = [];
export const generatedRoutingPolicies = [];
export const generatedRoutingTargets = [];
