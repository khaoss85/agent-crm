# The contracts the Cloud consumes

**Status: design. The contracts marked *shipped* exist in the public repository
today; the rest are specified and unimplemented.** Nothing here is a Cloud
implementation.

## The governing rule

> **The private Cloud must not patch OSS internals. It consumes public, stable,
> versioned contracts like any other integrator.**

Three consequences worth stating, because each is a shortcut somebody will
eventually want to take:

1. If the Cloud needs a capability, the contract is proposed **publicly**,
   shipped **publicly**, and consumed privately. There is no private extension
   point.
2. A contract exists to serve a self-hosting operator first. If a contract is
   only usable by the Cloud, it is not a contract — it is a Cloud-only API, and
   `OPEN_SOURCE_EDITION.md` forbids it.
3. Every contract is **versioned**, and a semantic change bumps the version
   deliberately, under this repository's existing versioning doctrine (ADR-036:
   a version describes a composition contract, and "additive reads never need a
   bump" is retired).

## Contracts that already ship

These exist in the public repository. **Cite them; do not invent a parallel
one.** They come from Production Spine v1 (ADR-038).

### Runtime mode — *shipped*
`ACCORDO_MODE`, one of `local-development` | `production`, with **no default**.
An unset mode is an error, never an inference: host, port, `NODE_ENV` and
interface address are deliberately not consulted. In `production` the application
**fails to start** without an identity verifier (`SPINE_VERIFIER_REQUIRED`) and a
tenant strategy (`SPINE_TENANT_STRATEGY_REQUIRED`).

*The Cloud sets `ACCORDO_MODE=production` and supplies both. It gets no third
mode.*

### Identity — *shipped*, `IDENTITY_CONTRACT = 1`
Kinds: `verified-user` · `system` · `asserted-local` · `anonymous`. A closed
evidence-method vocabulary. A **claims fingerprint**, never the claims — no
token, cookie, assertion blob or key enters the contract, the audit log, the
trace or an error.

*The Cloud is a deployment adapter: it verifies the request and supplies this
bounded identity. Exactly what a self-hosted OIDC adapter does — no privileged
path, and `asserted-local` is refused in production.*

### Authorization — *shipped*, `SPINE_CONTRACT = 1`
Eleven bounded permissions, explicit role bundles, `authorizationFingerprint()`,
and `records.write` as the floor for record actions.

*The Cloud does not carry its own permission model into the application. Cloud
roles govern Cloud resources — projects, environments, billing — and stop at the
application boundary.*

### Project and environment identity — *shipped in part*
The framework side is the Spine **Organization** (the tenant record) and
`TENANT_STRATEGY = 'database-per-tenant'` with a bounded tenant slug
(`TENANT_STORAGE_CONTRACT = 1`).

**State the limitation with the contract:** v1 *declares* the tenant boundary and
does **not enforce** isolation on the CRM data plane — the schema publishes
`tenantIsolation.crmDataPlaneEnforced: false` and leads with
`TENANT_ISOLATION_NOT_ENFORCED`. So the Cloud's supported shape today is **one
application instance per tenant**, and the Cloud may not advertise isolation the
framework says it does not enforce. Closing this is public Spine v2 work.

*Cloud-side project and environment identity is a private concept layered above,
mapping one environment to one instance to one Organization.*

## Contracts to be specified

Each is public work, on the public track, before the Cloud consumes it.

### Deployment manifest — *specified*
A declarative, versioned description of how to run one application: entrypoint,
required environment variables (including `ACCORDO_MODE`), the migration command,
the health endpoint, and the persistent paths. Committed to the user's own
repository, so it works identically for `docker compose up` and for a managed
deploy.

### Health and readiness — *specified*
Two distinct endpoints with stable semantics. **Liveness**: the process is up.
**Readiness**: migrations applied, database reachable, spine composed, mode
resolved — the application may take traffic. Readiness reports *why* it is not
ready, in stable codes rather than prose, because that answer is what a
deployment engine and a self-hosting operator both act on.

### Migration protocol — *specified*
Version discovery, an idempotent apply, and a dry run that writes nothing.
Applying twice is applying once. The protocol must state whether it is
backward-compatible with the previous application version, so a deployment engine
can decide whether it may roll back — the repository already treats an old
database upgrading with history byte-identical as a tested property.

### Observability export — *specified*
The public half of the dividing line. Logs, metrics and traces are **emitted** in
a public, versioned format (OpenTelemetry-shaped, with the existing trace and
audit vocabulary preserved), to a configurable destination. The framework never
requires a particular backend, and a self-hosting operator can point it at a file
or their own collector.

*The Cloud implements storage, indexing, search, retention and alerting
privately.*

### Backup and restore interface — *specified*
A public interface and a public CLI path: produce a consistent snapshot, verify
it, restore it into a clean instance. Restore is verifiable — a backup nobody has
restored is not a backup.

*The Cloud implements scheduling, retention, off-site custody and point-in-time
recovery privately.*

### Secret reference interface — *specified*
Configuration refers to secrets **by reference**, resolved at startup through a
provider interface. The framework holds no secret store and logs no resolved
value. A self-hosting operator implements a file or environment provider; the
Cloud implements custody privately.

### Version compatibility — *specified*
The application declares which framework version it was built against, and the
framework declares which application contract versions it accepts. A deployment
engine refuses an incompatible pair **before** deploying rather than discovering
it at runtime — the same fail-at-startup doctrine `ACCORDO_MODE` already applies.

## Contract change protocol

1. Propose publicly, with the self-hosting use case stated first.
2. Ship publicly, versioned, with tests and a published limitation.
3. Only then consume privately.

A Cloud need is never sufficient justification on its own. If a contract cannot
be justified to a self-hosting operator, it belongs in the Cloud, not in the
framework.
