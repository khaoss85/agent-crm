# Spine v4A — bounded runtime secrets provider

## Goal and user-visible outcome

Accordo runtime components can resolve a named secret through one versioned,
provider-neutral contract without putting the value into deployment documents,
errors, evidence, public surfaces or persisted metadata. PostgreSQL control/data
credentials and a deployment identity verifier consume the same resolver before
any database connection or listener exists. Local development has an explicit
environment provider; tests have a deterministic fixture; production supplies a
trusted repository-relative provider module and never falls back to the process
environment.

This slice does not build a managed secret store, ship a vendor adapter, expose a
new CLI/MCP command, change tenant isolation or promote a JTBD.

## Current repository context

- `packages/core/src/deployment-storage.js` owns the closed deployment envelope.
  Contract 1 currently carries PostgreSQL `password` inline.
- `packages/core/src/identity-verifier.js` owns trusted repository-relative
  provider loading and `prepareDeploymentPreconnect()`. It must still finish
  before application composition opens a database or listener.
- `packages/app/src/create-app-async.js` converts selected PostgreSQL endpoints
  to the exact inputs used by the PostgreSQL lifecycle.
- `packages/core/src/timeout.js` establishes the repository's bounded timeout,
  observed late-rejection and abandoned-late-settlement semantics.
- ADR-038 forbids credentials in identity, audit, trace and errors. Production
  Spine v2 M2F/M3 requires closed configuration, authenticated TLS, exact
  pre-connect ordering and one tenant per dedicated data plane.
- Repository Truth and final public status remain owned by the integration PR;
  this causal slice updates only its architecture decision and horizontal
  compatibility record.

## Milestones

1. Add the closed secret-provider contract, opaque disposable lease, explicit
   environment and fixture providers, production provider definition boundary,
   bounded resolution and hostile/late-settlement handling. Leave existing
   runtime behavior runnable.
2. Add deployment-storage contract 2 with secret references and an explicit
   secret-provider selection. Resolve the trusted provider and verifier in the
   pre-connect phase; production refuses environment fallback. Keep SQLite
   contract-1 compatibility, while refusing inline PostgreSQL credentials at
   the production-operations boundary.
3. Wire PostgreSQL control/data password callbacks and the identity-verifier
   factory to the resolver without exposing leases or references through app,
   health, doctor, CLI or MCP surfaces. Prove provider/refusal/ordering behavior
   with sentinel leak scans.
4. Record the decision and legacy alignment, run focused and broad gates, and
   commit cohesive conventional commits without changing measurement or final
   public truth.

## Validation

Use Node 22.16.0 through `fnm`.

- `node --test tests/spine-v4a-secrets-provider.test.js`
  - contract vocabulary and trust are closed;
  - environment use is local-development only;
  - fixture and production providers resolve through opaque disposable leases;
  - string/JSON coercion refuses;
  - timeout aborts, observes late rejection and disposes late material;
  - provider errors/results cannot inject secret values into stable diagnostics.
- `node --test tests/spine-v2-m2f-deployment-storage.test.js tests/spine-v2-m2f-verifier-preconnect.test.js tests/spine-v2-m2f-entry-wiring.test.js tests/spine-v2-m3c-postgresql-application.test.js`
  - deployment contract compatibility and pre-connect ordering remain green;
  - v2 uses references and explicit provider selection;
  - no provider/database/listener work precedes the required checks.
- `npm run check`
- `npm run repo:truth -- --check`
- `npm run verify`
- `git diff --check`

The exhaustive sentinel assertion scans thrown error fields, JSON-safe public
descriptors, app health/doctor/schema where composed, CLI/MCP output fixtures,
and the files touched by this contract; neither secret material nor inline
credential fields may appear in those runtime products.

## Progress log

- 2026-08-31: exact base `4261fa8dc1058c1360d9fd0492f1e3b0a4d86572`
  verified on clean branch `claude/spine-v4a-secrets-provider`; repository
  authorities, M2F/M3 pre-connect code and current provider/error conventions
  inspected.
- 2026-08-31: selected a kernel-internal resolver with two current boundaries:
  PostgreSQL control/data connection authentication and deployment identity
  verifier initialization. No domain package refactor is part of this slice.
- 2026-08-31: implemented provider contract, disposable/expiring lease,
  environment/fixture providers, trusted production module loading, deployment
  contract 2, PostgreSQL password callbacks and verifier-factory consumption.
- 2026-08-31: fixed review finding that provider preparation was incorrectly
  nested behind identity-verifier presence. Provider resolution is now
  independent; PostgreSQL without a verifier reaches the existing binding
  refusal with its provider prepared, and SQLite contract 2 needs no provider.
- 2026-08-31: focused V4A plus M2F/M3C/M4C/posture suites pass on Node 22.16.0;
  `npm run check`, Repository Truth check and `git diff --check` pass. Local
  PostgreSQL cases report their existing no-server skips. A broad `npm run
  verify` attempt reached the same slow shell-classifier cross-product failure
  independently present on baseline; the Lead confirmed current-main exact-head
  hosted CI green and will use exact-head CI as the broad gate.
- 2026-08-31: exact-head review tightened the deployment boundary to validate
  password references before any provider/verifier/connection work, moved trusted
  descriptor closure onto the import deadline even for never-settling modules,
  and split executable truth between the implemented bounded self-host contract
  and the still-absent managed secrets/backup/observability remainder.

## Decision log

- The returned value is an opaque, explicitly disposable lease backed by
  mutable bytes with an unrefed bounded expiry. The only plaintext escape is a
  callback/consume path for an actual runtime consumer; mutable storage is
  zeroed before that callback settles, and coercion/serialization refuse.
- Provider results must be mutable bytes (`Uint8Array` or the convenience
  `SecretMaterial`), not an arbitrary string/object. This lets the resolver
  zero late results after a timeout and reject hostile thenables/results
  without reflecting them.
- Production provider selection is a trusted repository-relative module.
  Environment lookup is a named local-development choice, never a default.
- PostgreSQL uses `pg`'s password callback boundary so a secret is resolved per
  connection and the framework does not retain it in its endpoint descriptor.
- Secret references are operational identifiers. They are accepted only at the
  internal deployment boundary and are never copied into public descriptors,
  errors, fingerprints, audit, trace, jobs, backup or telemetry.

## Outcome and follow-up

The bounded secrets contract and its three concrete runtime uses (identity
verifier, PostgreSQL control plane and PostgreSQL data plane) are implemented
with zero-leak refusal evidence. Deployment-storage contract 2 is required for
PostgreSQL and carries references only; contract-1 SQLite/`--db` compatibility
remains. No managed provider, vendor adapter, public command, domain behavior or
JTBD promotion was added.

The integration wave still owns final combined operations wording, lifecycle,
backup/observability consumers and the one exact clean measurement. Repository
Truth now publishes the bounded secret-provider fact from an executable
single-use resolution probe while leaving the combined managed
secrets/backups/observability remainder absent; no readiness or JTBD conclusion
moved.
