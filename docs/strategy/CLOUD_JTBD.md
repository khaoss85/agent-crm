# Cloud jobs to be done

Operator and builder jobs for the optional managed layer. `AGENT_CRM_CLOUD.md`
describes *what* Accordo Cloud is; this file states *what someone is trying to
get done* and what would have to be true to claim it.

**Every job below is `not supported`.** No control plane, no deployment code, no
account system, no billing exists — Cloud is design only and is gated on the
Production Spine (Phase 6). Self-hosting stays first-class forever, and every
job here must have a self-host equivalent or an export path.

Two actors recur, and conflating them is the main design risk:

- **Operator** — owns the account, the deployment and the plugins (a developer, an agency, an internal platform owner).
- **CRM user** — logs into the deployed CRM to do sales work. They never see the control plane.

## The jobs

| ID | Job | Actor | Trigger | Outcome | Required capability | Acceptance scenario | Approval boundary |
|---|---|---|---|---|---|---|---|
| CL-01 | Create an account and an organization | Operator | first use | an org that can own projects and members | account system, org model, tenancy | sign up, create org, invite a second operator, both see the same org | human accepts terms; no agent creates accounts |
| CL-02 | Connect a GitHub repository | Operator | after CL-01 | the org can read a repo and react to pushes | OAuth app, repo permissions, webhook intake | connect a repo, see its branches, revoke and lose access immediately | human authorizes the OAuth grant |
| CL-03 | Create a project from a repository | Operator | after CL-02 | a named project with an environment and a database | project model, managed runtime, provisioning | create a project, see it build, reach its Admin | human confirms provisioning |
| CL-04 | Deploy a preview for a branch or PR | Operator | push to a branch | an isolated URL running that branch with its own data | preview environments, ephemeral databases, migrations | open a PR, get a preview URL, confirm production data is untouched | automatic for previews; production is separate (CL-07) |
| CL-05 | Inspect build logs | Operator | a build fails | the failing step and its output | build log storage and streaming | break a migration, find the exact failing step | none — read-only |
| CL-06 | Diagnose a runtime failure | Operator | an action fails in production | the failed workflow run, its spans and the error, without personal payloads | trace/audit exposure, log retention, redaction | fail an action, find its run, see spans and the normalized error, and no PII | none; redaction is enforced, not optional |
| CL-07 | Deploy to production | Operator | a release decision | the production environment runs the chosen commit, migrations applied | production environment, migration gate, health check | promote a green preview; a failing migration blocks the deploy | **human approval required** — an agent may prepare, never promote |
| CL-08 | Roll back a bad deployment | Operator | production is broken | the previous version serving again, with a stated data policy | versioned deployments, rollback, migration reversibility policy | deploy a break, roll back, service restored; irreversible migrations are refused with a clear reason | **human approval required** |
| CL-09 | Invite a CRM user | Operator | a colleague needs access | that person can sign in to the CRM Admin | authentication, user model, invitations | invite, accept, sign in, appear in the audit trail as themselves | human invites; agents never provision identities |
| CL-10 | Assign a role | Operator | access must be scoped | the user's permissions change | RBAC, permission matrix | grant read-only, prove a write is refused and audited | **human approval required** |
| CL-11 | Set a secret for a provider | Operator | connecting a real provider | the runtime resolves the credential without exposing it | secret store, reference indirection, rotation | set a secret, use it, and never find it in logs, traces, schema or the database | **human approval required**; agents never read secrets |
| CL-12 | Add a custom domain | Operator | going live | the CRM serves on the operator's domain with TLS | domain verification, certificates, routing | add a domain, verify it, serve HTTPS | human owns the DNS change |
| CL-13 | Install, update or disable a plugin | Operator | extending the CRM | the plugin's modules, providers and actions become available, or stop being | plugin registry, versioning, compatibility checks, safe disable | install a provider plugin, upgrade it, disable it and see its surfaces disappear cleanly | **human approval required** — a plugin is executable code |
| CL-14 | Restore from a backup | Operator | data loss | the project at a known-good point, with a stated data-loss window | automated backups, restore, rehearsal | restore into a scratch environment and verify a known record | **human approval required** — destructive |
| CL-15 | Export or self-host | Operator | leaving Cloud, or wanting to | the repository, the data and the runbook, sufficient to run it elsewhere | export, documented self-host path, no proprietary runtime dependency | export a project and run it locally to a green smoke | none — this must never require permission |

## What "supported" would require

CL-01/09/10 need authentication, tenancy and RBAC — the Production Spine, and
nothing before it. CL-11 needs secret management (`INTEGRATION_RUNTIME.md`).
CL-06 needs trace and audit exposure **with redaction**, which touches
`DATA_GOVERNANCE.md`. CL-14 needs the backup rehearsal listed in
`docs/QUALITY_GATES.md` §4. CL-04/07/08 need a managed runtime that does not
exist in any form.

## Non-negotiables

1. **No lock-in.** CL-15 is a first-class job, not a concession, and it must never require approval.
2. **The two surfaces stay separate.** A CRM user never reaches the control plane; an operator's deployment rights are not CRM permissions.
3. **Consequential actions stay human.** Production deploys, rollbacks, role grants, secrets, plugin installs and restores are human decisions; an agent may prepare and explain them.
4. **Nothing here is a commitment.** Pricing, packaging, availability and timing are open human decisions (`MASTER_PLAN.md` §10).
