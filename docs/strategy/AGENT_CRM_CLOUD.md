# Accordo Cloud

**Status: product design and roadmap track only. Nothing in this document is implemented.** No control plane, no managed runtime, no Cloud CLI, no project MCP deployment tools exist today. This document defines what "Accordo Cloud" means so the roadmap can name it, sequence it, and gate it honestly.

## 1. What Accordo Cloud is

The optional **managed operating layer** for the open-source framework:

```text
Open-source framework   (MIT today; the code the customer owns)
+ self-hosting freedom  (Docker/VPS/Vercel recipes — always documented, always first-class)
+ optional managed Cloud (hosting, database, deploys, backups, operations — paid, optional)
```

Three commitments that shape everything below:

1. **The user always owns the application code.** A Cloud project is a GitHub repository the user controls; ejecting means deploying that same repository anywhere else using the documented self-hosting path. No Cloud-only APIs may be required for the CRM to function.
2. **Self-hosting is a permanent, documented, benchmark-tested path** — not a degraded fallback. Every Cloud capability that touches the application (migrations, smoke checks, backups) has a self-hosted equivalent in the CLI or docs.
3. **No proprietary lock-in by design.** The framework never grows features that only work on Cloud. Cloud competes on operations quality, not on withheld functionality.

Pricing is **deliberately undefined** here; it is a human decision (MASTER_PLAN §10) and nothing in this document implies a price or a tier.

## 2. Two distinct user surfaces

Cloud has two audiences that must never be conflated:

### 2.1 Cloud Control Plane (the account that manages the application)

```text
Login · Organizations · Projects · GitHub repositories · Environments
Production / Preview · Team members · Billing · Domains
Secrets and environment variables · Deployments · Plugins · Backups
```

The Control Plane is where a developer (or their coding agent, with approval) operates the *application*: connects a repo, provisions environments, deploys, reads logs, manages secrets and backups.

### 2.2 CRM Application Admin (the deployed CRM business users log into)

```text
CRM login · Users · Teams · Roles · CRM data
Pipelines · Tasks · Dashboards · Configuration
```

This is the product the framework already generates — the Admin that salespeople and ops people use daily.

**Identity rule:** Control Plane identity and CRM-user identity are conceptually distinct. A Control Plane account operates infrastructure; a CRM user operates business data. Future SSO may *link* them for convenience, but the model must never assume the same person, the same permission system, or the same lifecycle. (Today the framework's CRM "actor" headers are not authentication at all — real CRM auth is Production Spine work.)

## 3. Managed runtime track (future)

The runtime capabilities Cloud must operate, all currently unbuilt:

```text
PostgreSQL · Authentication · Tenant isolation · RBAC
Session and API-key management · Backups · Migration execution
Zero-downtime deployment · Health checks · Preview environments
Production environments · Domain and TLS management
```

**Hard gate:** the first six items are the **Production Spine** (EXECUTION_ROADMAP Phase 6). **No public managed deployment may be considered production-ready before the Production Spine exists.** The current framework is explicitly local-development-only (no auth, no tenancy, actor headers are identity claims, SQLite file storage); putting it on the public internet as-is would be negligent, and no Cloud milestone may shortcut that gate.

## 4. Agent Operations track (future)

Cloud is agent-native or it is nothing: coding agents must be able to operate a deployed CRM through stable machine-readable surfaces.

### 4.1 Cloud CLI (conceptual)

```bash
crmcloud login
crmcloud project create
crmcloud deploy
crmcloud status
crmcloud logs
crmcloud traces
crmcloud audit
crmcloud env
crmcloud plugins
crmcloud smoke
crmcloud rollback
```

Every machine-facing command supports `--json` with a stable, versioned output shape — the same discipline the framework already applies to `/api/schema` (versioned contracts, deterministic output, no timestamps/paths leaking).

### 4.2 Project MCP surface (conceptual)

An MCP server Claude Code and Codex use to operate a Cloud project:

```text
project_status · create_preview · deploy_preview · deploy_production
deployment_logs · runtime_logs · workflow_traces · audit_events
installed_plugins · install_plugin · update_plugin
environment_variables · run_smoke_test · rollback_deployment
```

### 4.3 Approval boundaries (non-negotiable)

The product's own philosophy — deterministic policy, human approval — applies to operating it. **Risky operations always require explicit human approval:**

- production deploy;
- rollback;
- secret mutation;
- destructive database action;
- plugin installation or update;
- environment deletion;
- any spend-increasing action.

Read operations (status, logs, traces, audit) are agent-autonomous. **Agents never receive plaintext production secrets**: `environment_variables` returns names and metadata, values are write-only through the secret store, and smoke tests run server-side rather than shipping credentials to the agent's context.

## 5. Plugin operations track (future)

The managed plugin experience, layered on the open-source provider/plugin package model (EXECUTION_ROADMAP Phase 7 — which stays npm-installable for self-hosters):

```text
Discover · Install · Configure · Enable · Disable · Update
Pin version · Compatibility check · Health status · Logs · Uninstall
```

Compatibility rule: a plugin is a normal package that works identically self-hosted; Cloud adds lifecycle management (health, pinning, one-click update with rollback), never a proprietary plugin format.

## 6. Zero-friction North Star journey

The Cloud extension of the North Star (`NORTH_STAR_EXPERIENCE.md` owns the canonical copy):

```text
1.  User asks Claude Code or Codex to build a CRM.
2.  The agent selects the framework.
3.  The agent creates the project.
4.  It generates modules, references, actions, Admin, and tests.
5.  It asks for permission to deploy.
6.  The user approves and supplies/authorizes credentials.
7.  The agent creates a Cloud project and environment.
8.  It provisions database and managed runtime.
9.  It deploys.
10. It reads build and runtime logs.
11. It fixes deployment errors.
12. It runs a public smoke test.
13. It returns: CRM URL · Admin URL · invitation/login status ·
    deployment status · test results · trace/audit links.
```

Steps 5–6 are approval gates, not friction to optimize away.

## 7. Cloud acceptance metrics

Additions/refinements to the metrics table (protocols must exist before any public number — see guardrails in `EXECUTION_ROADMAP.md`):

| Metric | Definition |
|---|---|
| Time to First Working CRM (TTFW) | existing — brief → local verify+smoke green |
| **Time to First Deployed CRM (TTFD)** | brief → public URL with post-deploy smoke green |
| **Successful Deployment Rate** | deploys reaching healthy status ÷ deploys attempted |
| **Post-deploy smoke rate** | deployed instances passing the scripted public smoke ÷ deploys |
| **Preview→production conversion** | preview environments later promoted ÷ previews created |
| **Agent interventions per deploy** | manual human fixes per deploy (approvals excluded, benchmark counting rules) |
| **Log-to-fix success rate** | deploy failures the agent fixes autonomously from logs ÷ deploy failures |
| **Plugin installation success** | managed plugin installs reaching healthy ÷ attempts |
| Managed-project retention | **only** once a privacy-safe measurement policy is human-approved |

Telemetry remains **off by default** until a human approves a policy (MASTER_PLAN §10 unchanged).

## 8. Benchmark integration

The full benchmark eventually tests the managed path end to end:

```text
brief → generated project → tests → managed deployment → public CRM login
→ business action → audit → trace → restart/redeploy persistence
```

Honest status: the benchmark runner is **designed but not yet automated**; local end-to-end tests already exist in-repo (verify, smoke, starters, real-Chromium checks); **public managed-deployment gates belong after the Production Spine and Cloud implementation** and must not be claimed before. Self-hosted Docker/VPS remains a permanent comparison arm so Cloud is measured against the freedom it must not erode.

## 9. Roadmap structure and dependencies

Accordo Cloud is an explicit named product track (not scattered):

```text
Production Spine (Phase 6: PostgreSQL, auth, tenancy, RBAC, sessions/API keys)
    → Accordo Cloud Control Plane   (accounts, orgs, projects, repos, environments, billing, domains, secrets)
    → Managed Runtime                 (provisioning, migrations, backups, zero-downtime deploys, health)
    → Agent Operations CLI/MCP        (crmcloud + project MCP, approval boundaries above)
    → Plugin Operations               (managed plugin lifecycle over the open package model)
    → Public benchmark deployment     (managed-path gates added to the public benchmark)
```

**The dependency that gates everything: Production Spine gates public managed deployment.** Completed milestones (0–7) are not reordered by this track; Cloud phases slot after Phase 6 and alongside Phases 9–12 (deploy/operate, distribution, launch), replacing the former vague "possible later operations layer" note.

## 10. What this document does not decide

- Prices, tiers, free-plan limits — human decisions, undefined here.
- Telemetry policy — off by default until approved.
- Infrastructure vendors, regions, compliance scope — decided at implementation with their own ADRs.
- Product name (Cloud inherits the framework's still-open naming decision).

## Agent operations and approvals, with Marketing in scope

The Marketing track sharpens what a managed deployment must get right about **agent authority**: an agent may analyze, propose, generate, prepare and recommend without asking, but sending external communication, publishing a landing page, activating a journey, changing a live audience, launching ads, creating or increasing spend, installing a provider and changing secrets each require a human approval — from a real, authenticated role. That role does not exist until the Production Spine does. Until then every approval boundary in Marketing is a local-development boundary, and Cloud must not present it as more. See `MARKETING_GROWTH_OPERATIONS.md` §6.

## AX4 — the objective-driven case in a managed deployment

The objective-driven experience (`OBJECTIVE_DRIVEN_AGENT_EXPERIENCE.md`) ends locally at "built and verified". **AX4** is what extends it through deploy, observe and fix in a managed environment — and it is gated on the Production Spine, because everything it adds (real approval roles, production deployment, live observation) needs authenticated identity that does not exist yet. Until then an objective-driven build is a local-development artifact, and Cloud must not present it as more.
