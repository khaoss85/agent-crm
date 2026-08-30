# ExecPlan: Production Spine v2 M4B — control-plane leases, tenant binding, readiness

## Goal

Shared PostgreSQL control plane is the authority for tenant→data-plane binding.
First claim records `{canonicalTenant, bindingUuid}` under an exclusive
provisioning lease (`pg_advisory_xact_lock`) before exposing an application
handle. Writer leases carry a generation; clones and expiry do not auto-promote
a writer. Readiness is derived from startup completion and an unexpired writer
lease. Liveness ≠ readiness.

Not in scope: M4A idempotency/unknown-commit, M4C HTTP/SDK/Admin/CLI e2e,
Spine v3/v4/Cloud, shared-database tenancy, production-readiness claims,
measurement, `accordo-platform`.

## Current context

- M3C boots a complete PostgreSQL application (`postgresql-bootstrap.js`,
  `createAccordoAppAsync`, portable facade).
- Data-plane marker and control `spine_tenant_bindings` exist, but claim runs
  after DDL and there is no writer lease or lease-driven readiness.

## Milestones

1. Claim the data-plane marker before remaining domain DDL; persist the inverse
   `{canonicalTenant, bindingUuid}` under a tenant-keyed exclusive provisioning
   lock on the control plane.
2. Writer lease with generation, compare-and-set, clone/rebind refusals, close
   expires the holder lease without deleting history.
3. Portable health: `ok` liveness vs `ready` from unexpired writer lease.
4. PostgreSQL tests against `accordo-pg-test`.

## Validation

```
ACCORDO_TEST_POSTGRES=1 ACCORDO_PG_TEST_URL=postgres://postgres@127.0.0.1:55432/accordo_test \
  node --test tests/spine-v2-m4b-leases-tenant-authority.test.js tests/spine-v2-m3c-postgresql-application.test.js
```

## Progress log

- Implementing M4B against merged M3C (`7190869`).
- Claim now inspects the data-plane marker before remaining domain DDL.
- Control-plane `{canonicalTenant, bindingUuid}` is recorded under a tenant-keyed `pg_advisory_xact_lock`.
- Writer leases carry generation and compare-and-set; clones and rebind refuse; close expires the holder lease.
- Portable `health()` is liveness (`ok`) plus unexpired writer lease (`ready`).
- Tests against `accordo-pg-test` prove isolation, races, clone fencing, black-hole recovery and credential-free envelopes.

## Outcome

M4B is executable on this branch. Remaining M4 work is M4A (idempotency / unknown-commit) and M4C (HTTP/SDK/Admin/CLI e2e). This is not shared-database tenancy and not a production-readiness claim.
