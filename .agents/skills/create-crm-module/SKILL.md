---
name: create-crm-module
description: Create or extend an Agent CRM domain module. Use for new CRM objects, fields, service operations, module metadata, API exposure and tests. Do not use for cross-module business processes; use create-crm-workflow instead.
---

1. Read `ARCHITECTURE.md`, `DECISIONS.md` and one existing module under `packages/modules/`.
2. Define the business boundary and state the owner of each field.
3. Use `node packages/cli/bin/agent-crm.js module:create <name> --dry-run` to inspect the proposed file layout.
4. Add schema migration, module service, metadata and validation.
5. Expose mutations only through the service; never execute SQL from API or MCP handlers.
6. Record actor context and audit on every mutation.
7. Add API/MCP exposure only after the service contract is tested.
8. Run `npm run verify` and update docs.
