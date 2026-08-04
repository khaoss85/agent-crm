# Codex handover

## Repository

Target GitHub owner: `khaoss85`  
Suggested repository: `agent-crm`

## First Codex prompt

```text
Read AGENTS.md, PRODUCT.md, ARCHITECTURE.md, DECISIONS.md and TASKS.md.
Run npm run verify and npm run smoke to understand the current vertical slice.
Then create an ExecPlan for the first unchecked item in TASKS.md and implement it end-to-end.
Preserve the rule that all mutations go through module services or workflows.
Keep MCP code-generation tools dry-run by default.
Update the ExecPlan, TASKS.md and DECISIONS.md as needed, and finish with npm run verify.
```

## Expected current behavior

1. `npm run demo` creates a €20k and an €80k renewal.
2. Moving both to Proposal sends only the €80k renewal to Approval Pending.
3. Approving it moves it to Proposal.
4. The Admin, REST API, MCP tool and CLI all exercise the same services and workflows.
5. Workflow steps and audit events remain inspectable.

## Useful commands

```bash
npm run verify
npm run demo
npm run dev
npm run mcp
npm run doctor
node packages/cli/bin/agent-crm.js module:create partner --dry-run
```

## Publish target

The repository has been prepared for `khaoss85/agent-crm`. From a clone of the Git bundle or extracted ZIP:

```bash
git remote add origin https://github.com/khaoss85/agent-crm.git
git push -u origin main
```

Do not expose the local HTTP API publicly before authentication, tenant isolation and role boundaries are implemented.
