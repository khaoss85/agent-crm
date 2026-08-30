# Production Spine v2 M3C — PostgreSQL application composition

This ExecPlan follows `.agent/PLANS.md`. It is a living implementation record
for M3C only. M3P dual graphs are already on this branch. M4 owns idempotency
keys, leases and unknown-commit recovery. Shared-database row tenancy and
general production readiness are out of scope.

## Goal and user-visible outcome

`createAccordoAppAsync()` boots a useful complete Accordo application on
PostgreSQL when deployment storage selects that adapter. `accordo serve` keeps
the characterized synchronous SQLite path and awaits async composition on
PostgreSQL. Startup attestation runs before DDL. Control-plane bootstrap under
`pg_advisory_xact_lock` commits schema, checksum ledger and startup audit
together, then the data plane does the same. Child-process evidence is
mandatory.

Limitation in the same breath: this is per-tenant dedicated databases, not
shared-database row tenancy, and not a production-readiness claim. The
framework still authenticates nobody.
<!-- truth: spine.postgresql.implemented=implemented -->
<!-- truth: spine.tenant.isolation.mode=one_tenant_per_instance -->
<!-- truth: spine.authentication.framework_verifier=absent -->

## Current repository context

HEAD is M3P dual graphs on merged M3A+M3B.

- `loadDeploymentStorage` parses a PostgreSQL envelope then throws
  `DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED`.
- `createAccordoAppAsync` throws `STORAGE_ADAPTER_UNAVAILABLE` for PostgreSQL-
  shaped options. `createAccordoApp()` stays synchronous SQLite-only.
- Identity-verifier discover/attest names exist and refuse
  `IDENTITY_VERIFIER_OPERATION_UNSUPPORTED`.
- `createPostgresqlStorage` implements Storage Contract v1 over `pg@8.23.0`.
- Core schema intent renders PostgreSQL SQL into the fixed `accordo` schema.
- CI already runs `postgres:16` with `ACCORDO_TEST_POSTGRES=1`.
- `spine.postgresql.implemented` is `absent` because the factory still refuses.

## Approaches considered

### A. Translate remaining SQLite SQL at the PostgreSQL boundary

Rejected by the parent plan. A SQL-text translator is an incomplete parser.

### B. Convert every service to unconditional async in one change

Rejected as a single causal changeset. The synchronous factory's characterized
`get`/`list` shape must stay. PostgreSQL cannot grow a `storage.sync` facade.

### C. Shared loader + real attestation + dual-path storage consumers

Chosen. PostgreSQL selection uses the existing closed loader. The async factory
is the only portable composition path. SQLite consumers keep `storage.sync`.
PostgreSQL uses the async Storage Contract handle. Startup attestation is a
real ordered provider contract. Loopback CI uses an explicit test-harness TLS
exception; a deployment document cannot.

## Design and boundaries

### 9.1 Deployment selection

- One shared `loadDeploymentStorage` parser. PostgreSQL envelopes return a
  closed selection instead of `DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED`.
- Canonical spine/tenant and a trusted verifier path remain required fields.
- `--db` plus a document remains `DEPLOYMENT_STORAGE_DB_CONFLICT`.
- Identical control/data endpoints refuse before connect.
- `describeDeploymentStorage` publishes `{adapter, available}` only.
- `createAccordoApp()` stays SQLite-only.
- Incomplete PostgreSQL factory options refuse
  `PORTABLE_POSTGRESQL_BINDING_REQUIRED` before any connection.

### 9.2 Startup attestation

Ordered operations, not interchangeable:

`discoverControlResource` → `attestControlStartup` → `discoverDataResource`
→ `attestDataStartup`.

Challenges bind repository fingerprint, tenant, resource fingerprint,
`schema:migrate`, migration-set fingerprint, and prior control attestation
where required. Request identity cannot satisfy startup. Missing permission,
wrong operation/tenant/resource/migration set, replay, expiry and swapped
request/startup evidence all refuse before DDL. Audit stores bounded
fingerprints and reason, never credentials.

### 9.3 Control then data

Control plane first. `pg_advisory_xact_lock` inside a transaction, never a
session lock. Control DDL + checksum ledger + startup audit are all-or-none.
Then data-plane attestation and the same unit discipline. Fault injection at
each boundary.

### 9.4 Fixed schemas

Adapter owns `accordo`. Every tenant marker, ledger, domain, audit, trace and
control object is schema-qualified. Caller `search_path` is overridden and is
never an isolation input.

### 9.5 Application and serve

SQLite `--db` / SQLite documents keep the characterized v1 `createAccordoApp`
serve path. PostgreSQL selection awaits `createAccordoAppAsync`, migrations and
readiness, then listens. Startup failure: no listener, stable bounded error,
selected resources close. Unauthenticated PostgreSQL CLI mutations stay
`CLI_VERIFIED_OPERATOR_REQUIRED`.

### 9.6 Evidence

Representative domain, package, action, workflow, audit, trace and generated-
module paths against PostgreSQL. Child-process boot is mandatory. Direct
factory calls alone are not evidence.

## Validation

- `node --test tests/spine-v2-m3c-postgresql-application.test.js tests/spine-v2-m3c-child-process.test.js`
- Existing M2F loader/entry/verifier tests updated to the new PostgreSQL
  selection and attestation contracts
- `npm run repo:truth -- --check` after regenerating facts
- Targeted tests green before the report; `npm run verify` if time allows

## Progress log

- Plan written.
- Implementation follows.

## Decision log

- Two PostgreSQL databases (control and data), one adapter-owned schema name
  `accordo` in each. Identical endpoints refuse. CI test harness `CREATE
  DATABASE`s isolated names and drops them with `FORCE`.
- Loopback test-harness TLS exception is a factory option, never a document
  field.
- SQLite `storage.sync` paths stay on the sync branch; PostgreSQL uses async
  Storage Contract methods so characterized `get`/`list` remain synchronous on
  `createAccordoApp()`.

## Outcome and follow-up

Implemented. `loadDeploymentStorage` returns a PostgreSQL selection.
`createAccordoAppAsync` boots dedicated control and data databases after
ordered startup attestation. `accordo serve` awaits that path. SQLite
`createAccordoApp()` is unchanged. Child-process evidence lives in
`tests/spine-v2-m3c-postgresql-application.test.js`.
`spine.postgresql.implemented` is `implemented` for application composition,
with `POSTGRESQL_IS_APPLICATION_COMPOSITION_NOT_SHARED_TENANCY`.

Follow-up: M4 leases/idempotency; generated-module `storage.sync` dual path
for bundled package records; default `accordo serve` on the async SQLite
factory.
