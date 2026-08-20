# The managed Cloud edition

**Status: boundary definition. Nothing here is implemented, and this document
implements nothing.** No control plane, no managed runtime, no Cloud CLI, no
billing exists today. `docs/strategy/AGENT_CRM_CLOUD.md` and
`docs/strategy/CLOUD_JTBD.md` remain the current design records; this document
defines only which side of the repository boundary each capability lives on.

## What the managed Cloud is

The optional **managed operating layer** over the open-source framework. It is a
product that *consumes* the public framework the way any other integrator would.
It is private and proprietary.

```text
public, MIT            the framework — the code the customer owns
+ self-hosting         permanently documented and tested, never a fallback
+ private Cloud        hosting, custody, operations, metering, billing — optional, paid
```

## The dividing line

> **The public framework may emit logs, metrics and traces. The private Cloud
> stores and operates them.**

Emission is an interface, and interfaces are public so that a self-hosting
operator can point them at anything — a file, stdout, an OTLP collector, their
own stack. Custody is an operated service, and operated services are where a
managed product earns money. The same split decides every ambiguous case below:
a *secret reference interface* is public, a *secret store* is private; a
*backup/restore interface* is public, *automatic scheduled backups with retention
and point-in-time recovery* are private.

## What is private

### Control plane
Organizations, projects and environments; the account model above a single
application; the audit of Cloud-level actions.

**Note the vocabulary collision and do not let it blur.** A Cloud
*Organization* is a tenant of the platform. An Accordo **Organization** inside the
framework is the Spine's tenant record. A CRM **Company** is a customer stored
inside one tenant's data. The framework already publishes this sentence in its
schema; the Cloud must not redefine either term.

### Deployment and environments
Deployment orchestration, Git-triggered deploys, preview environments, domain
management and TLS, rollout and rollback.

### Data and custody
Managed database provisioning, connection and upgrade; **secret custody**;
automatic backup, retention and restore.

### Scale and operations
Autoscaling; log aggregation, storage and search; the metrics and trace backend;
alerting; support and operations tooling.

### Commercial
Usage metering, subscription management, billing and invoicing.

### Interfaces
The authenticated Cloud CLI and the authenticated Cloud MCP server. These are
distinct from the public project CLI and project MCP, which stay public and keep
working with no Cloud account.

## The rules that keep this honest

1. **The Cloud consumes public contracts as an external product.** It must not
   patch, fork or reach into framework internals. If the Cloud needs something,
   the answer is a public versioned contract — proposed publicly, shipped
   publicly, consumed privately. See
   [`CLOUD_INTEGRATION_CONTRACT.md`](CLOUD_INTEGRATION_CONTRACT.md).
2. **No public feature may be withheld to make the Cloud attractive.** The
   framework never grows a capability that only works on Cloud.
3. **The user owns the application.** A Cloud project is a repository the user
   controls; ejecting means deploying that same repository elsewhere by the
   documented self-hosting path.
4. **The Cloud is one deployment adapter among others.** It supplies a verified
   identity to the public identity contract exactly as a self-hosted OIDC
   adapter does. It gets no privileged path.
5. **The public limitations apply to the Cloud too.** The Cloud may not describe
   the framework as providing an isolation or a guarantee the framework itself
   publishes as unenforced.

## What the Cloud may not claim

Until the corresponding public capability exists and is proven, the Cloud may not
advertise it. Today that includes multi-tenant isolation on the CRM data plane,
which the framework publishes as **declared and not enforced**
(`TENANT_ISOLATION_NOT_ENFORCED`). A managed product may operate one instance per
tenant and say *that* — it may not describe the framework as isolating tenants it
does not isolate.
