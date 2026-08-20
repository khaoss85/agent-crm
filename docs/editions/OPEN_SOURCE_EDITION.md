# The open-source edition

**Status: boundary definition. This document moves nothing and changes no
licence.** It states what the public repository contains, and — more usefully —
what it must always be able to *do*.

## The test this edition is defined by

> **Someone who clones only the public repository must be able to run the
> product for one organization.**

Apply it literally. It is not a slogan: it is the acceptance criterion for every
line below, and it is the reason the classification in
[`REPOSITORY_BOUNDARY.md`](REPOSITORY_BOUNDARY.md) puts some things public that a
commercially-minded reading would put private. If a capability listed here would
break that test, the capability is misclassified and the classification is
wrong, not the test.

Two consequences follow that are easy to state and expensive to honour:

- **No Cloud-only API may ever be required for the CRM to function.** A feature
  that only works when the managed Cloud is present is a feature that broke the
  test the day it shipped.
- **Self-hosting is a first-class, documented, tested path, not a degraded
  fallback.** Every managed capability that touches the application — migrations,
  health checks, backups, observability — has a self-hosted equivalent in the CLI
  or the docs, or it does not ship.

## What is public

### Runtime and package system

The CRM runtime, the module factory, the package system, the action and workflow
runtimes, the policy and capability machinery, audit and trace. Everything a
module or package needs to exist, compose, and be verified.

### Interfaces a person operates

The CLI (`accordo`), the generated Admin, the HTTP API, the SDK, and the project
MCP server. These are how a self-hosting operator does the work; withholding any
of them would break the test above on day one.

### Identity, tenancy and authorization contracts

The Production Spine contracts are **public** — the framework owns the decision,
and a framework whose authorization model is proprietary cannot be audited by the
people relying on it. Concretely (ADR-038, `packages/core`, `packages/app`):

| Contract | Public constant | Meaning |
|---|---|---|
| Runtime mode | `ACCORDO_MODE` — `local-development` \| `production`, **no default** | An unset mode is an error, never a guess |
| Identity | `IDENTITY_CONTRACT = 1` | Kinds `verified-user` \| `system` \| `asserted-local` \| `anonymous`; closed evidence-method vocabulary; a claims **fingerprint**, never the claims |
| Authorization | `SPINE_CONTRACT = 1` | 11 bounded permissions, explicit role bundles, `authorizationFingerprint()`, `records.write` as the record-action floor |
| Tenant storage | `TENANT_STORAGE_CONTRACT = 1`, `TENANT_STRATEGY = 'database-per-tenant'` | A tenant id is a bounded slug; one database file per tenant |

**The framework authenticates nobody, and that is deliberate.** A deployment
adapter verifies the request and supplies a bounded, versioned identity; the
framework owns everything after that — the contract, the tenant, membership, the
decision, the evidence, and a fail-closed boundary. This is what makes the same
code honest whether it runs self-hosted or under the managed Cloud: the Cloud is
just one more deployment adapter.

### One-tenant-per-instance deployment — stated as it actually is

The public edition's supported deployment shape is **one application instance
per organization**. Two facts belong in the same breath, because the second is
what makes the first a discipline rather than a guarantee:

- v1 **declares** a versioned TenantStorage boundary of one database per tenant;
- v1 does **not enforce** tenant isolation on the CRM data plane. The schema
  publishes `tenantIsolation.crmDataPlaneEnforced: false` and leads its
  limitations with `TENANT_ISOLATION_NOT_ENFORCED`.

So a self-hosting operator running one organization is served correctly today,
and an operator who puts two organizations in one instance is not isolated by the
runtime and is told so by the runtime. Closing that gap — binding an instance to
one tenant, or scoping every read by organization — is public Spine v2 work, not
Cloud work. **This limitation stays public.** Relocating it would be the exact
failure the boundary exists to refuse.

### Deferred public capabilities

These are public when they ship, and they are on the public track:

- the **PostgreSQL adapter** and per-tenant PostgreSQL storage (Spine v2);
- **durable jobs, the outbox and the scheduler** (Spine v3);
- **secret-provider interfaces** — the interface is public; a hosted secret
  *store* is not;
- **backup and restore interfaces** — the interface and the CLI path are public;
  automatic managed backups are not;
- **observability export** — the framework emits logs, metrics and traces in a
  public, versioned format.

### The dividing line, in one sentence

> **The public framework may emit logs, metrics and traces. The private Cloud
> stores, indexes, searches, alerts on and operates them.**

The same sentence generalises: the public repository owns *interfaces and
emission*; the managed Cloud owns *custody and operation*. An interface that can
only be implemented by the Cloud is a boundary violation.

### Documentation, agents and evidence

- Docker and self-host guides.
- Public Skills and the agent instruction surface (`AGENTS.md`, `CLAUDE.md`,
  `GEMINI.md`, `skills/`) — an agent that cannot read the instructions cannot
  drive the framework.
- **Public technical evidence and the claims ledger**: `site/claims.json`,
  `docs/QUALITY_GATES.md`, `docs/IMPLEMENTATION_EVIDENCE.md`,
  `docs/SCENARIO_EVIDENCE.md`, `docs/FALSIFY.md`, the JTBD matrix, the benchmark
  protocols and their recorded pilot runs, and `docs/marketing/CORRECTIONS.md`.

That last group is the one under standing pressure, so the rule is written down:

> **Public quality evidence never moves private because it reveals a
> limitation.** The published blind spots are the argument. A repository that
> relocated its own corrections log, its unfavourable pilot results or its
> `NOT_ENFORCED` limitations in order to look better would have destroyed the
> only thing that made its favourable claims worth believing.

## What is not public

Named here only so the boundary reads from one side as well as the other; the
detail is in [`MANAGED_CLOUD_EDITION.md`](MANAGED_CLOUD_EDITION.md) and the
GTM section of [`REPOSITORY_BOUNDARY.md`](REPOSITORY_BOUNDARY.md).

The control plane · deployment orchestration · preview environments · domain
management · managed database provisioning · secret custody · automatic backup
and restore · autoscaling · log/metric/trace **storage**, search and alerting ·
usage metering · subscription and billing · support and operations tooling · the
authenticated Cloud CLI and MCP · and all internal go-to-market material.

## How this edition stays honest

1. `npm run verify`, `npm run smoke` and the scenario suite run entirely from the
   public repository. A gate that needed a private input would mean the public
   repository could no longer prove itself.
2. `site/claims.json` is measured against the public tree — every claim
   references a file that exists publicly, or `npm run site:check` fails.
3. `accordo app inspect --json` publishes the composed application's real
   capabilities *and its limitations*, from the public code.
4. The future `public-surface-check` gate (specified in
   [`PUBLIC_ARTIFACT_POLICY.md`](PUBLIC_ARTIFACT_POLICY.md)) refuses private
   artefacts and links to inaccessible private paths.
