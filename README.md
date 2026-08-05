# Agent CRM

A small, working proof of concept for the **“MedusaJS of agent-native CRM development.”**

You describe a commercial process to Codex or Claude Code. The coding agent understands the project through `AGENTS.md`, repository skills and MCP resources; it changes modules and workflows, runs tests, starts the app, inspects traces and iterates through the CLI.

```text
Business request
      ↓
Codex / Claude Code
      ↓
AGENTS.md + Skills + MCP + CLI
      ↓
CRM modules + deterministic workflows
      ↓
API + Admin + trace + audit
```

## What is already working

- CRM modules: Company, Contact, Opportunity and Approval.
- A deterministic renewal workflow.
- Human approval when a renewal above €50,000 moves to Proposal.
- REST API and a zero-build Admin UI.
- SQLite persistence using Node's built-in database adapter.
- Workflow runs, step-level traces and audit events.
- CLI for serve, seed, doctor, demo and module scaffolding.
- Declarative module manifests with validation and deterministic SQLite migration generation (see `docs/MODULE_MANIFEST.md`):

  ```bash
  npm run crm -- module validate examples/modules/partner.module.json
  npm run crm -- module migration examples/modules/partner.module.json --dry-run
  ```
- MCP server over stdio with tools and project resources.
- Codex/Claude repository skills and handover documentation.
- Automated tests with Node's built-in test runner.

## Run it

Requires Node.js 22.16 or newer. There are no third-party runtime dependencies.

```bash
npm run verify
npm run demo
npm run dev
```

Open `http://localhost:4000`.

The demo creates two renewals:

- €20,000 → moves directly to Proposal.
- €80,000 → stops in Approval Pending until a manager approves it.

## Use it from Codex

Open the repository in Codex and use:

```text
Read AGENTS.md, PRODUCT.md, ARCHITECTURE.md and TASKS.md.
Run npm run verify.
Then implement the first unchecked task in TASKS.md using an ExecPlan.
Do not change the deterministic approval policy without recording the decision.
```

Codex automatically reads `AGENTS.md` and the checked-in `.codex/config.toml` connects the local MCP server in trusted projects. Claude Code reads `CLAUDE.md`, `.mcp.json` and the mirrored skills under `.claude/skills`.

## Connect the MCP server

The stdio command is:

```bash
node --no-warnings packages/mcp/bin/server.js
```

Example Codex MCP configuration:

```toml
[mcp_servers.agent_crm]
command = "node"
args = ["--no-warnings", "/absolute/path/to/agent-crm/packages/mcp/bin/server.js"]
env = { CRM_DB_PATH = "/absolute/path/to/agent-crm/data/agent-crm.sqlite" }
```

The MCP server exposes tools to inspect the project, list opportunities, request stage changes, decide approvals, read traces and scaffold a module. Write-oriented scaffolding defaults to dry-run.

## The five folders to understand

```text
packages/modules/     CRM domain primitives
packages/workflows/   deterministic business processes
packages/mcp/         tools and context exposed to AI coding agents
packages/cli/         local operations, diagnostics and scaffolding
apps/                  API server and Admin UI
```

Everything else supports those five pieces.

## First vertical slice

```text
Create renewal
   ↓
Request “Proposal” stage
   ↓
Policy evaluates contract value
   ├─ below €50k → Proposal
   └─ €50k or above → Approval Pending
                           ↓
                     Manager approves
                           ↓
                        Proposal
```

The AI agent does not write directly to database tables. It invokes service methods and workflows, which preserve validation, policy, trace and audit.

## Milestone 0 safety boundary

This repository is a local development proof of concept. The HTTP API intentionally has no production authentication or tenant isolation yet. Do not expose it publicly; remote write tools belong after the tenancy and role milestone in `TASKS.md`.

## Project documents

- `PRODUCT.md`: product boundary and target user.
- `ARCHITECTURE.md`: technical model and extension rules.
- `docs/JTBD.md`: Medusa-style use cases translated to CRM.
- `docs/HANDOVER_CODEX.md`: exact Codex handover.
- `TASKS.md`: next implementation tasks.
- `DECISIONS.md`: architectural decisions.
