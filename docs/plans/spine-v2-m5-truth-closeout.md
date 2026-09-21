# Spine v2 M5 — truth closeout

Executable evidence for dedicated-database PostgreSQL, dual graphs, write-outcome
keys, leases and HTTP/SDK/Admin/CLI transport already exists on `main`. This PR
updates public documents and limitations to match that evidence.

Ratified scope:

- PostgreSQL per tenant, one tenant per application instance / data plane
- shared-database row tenancy deferred
- Cloud absent
- Spine v3 absent
- Spine v4 absent
- general production-readiness claim absent
- no JTBD promotion from infrastructure

Measurement of current main is a separate measurement-only PR after this merges.
