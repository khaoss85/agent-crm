// Signature provider registry (ADR-017). Static imports only — the same
// code-first pattern as actions, pipelines, intelligence and commercial: a
// project registers its providers here, in checked-in source, and the app
// validates and fingerprints them at startup. No dynamic import, no eval.
export const generatedSignatureProviders = [];
