---
name: create-crm-module
description: Create or extend an Agent CRM domain module. Use for new CRM objects, fields, service operations, module metadata, API exposure and tests. Do not use for cross-module business processes; use create-crm-workflow instead.
---

Preferred path — module factory (manifest-driven):

1. Read `ARCHITECTURE.md`, `DECISIONS.md`, `docs/MODULE_MANIFEST.md` and `docs/MODULE_FACTORY.md`.
2. Write a manifest (see `examples/modules/partner.module.json`); validate it:
   `npm run crm -- module validate <manifest.json>`.
3. Inspect the deterministic plan (always read-only):
   `npm run crm -- module plan <manifest.json>`.
4. Generate the runnable module (dry-run first, then explicit apply):
   `npm run crm -- module create <manifest.json>` then `--apply`.
   Apply writes service, migration, module definition, tests and registers the
   module automatically — no manual MIGRATIONS or create-app edits. The module
   is then served at `/api/modules/<name>/…`, discoverable via `GET /api/schema`
   (`generatedModules`), usable via `client.module('<name>')` in the SDK, and
   shown automatically in the Admin under "Generated modules" (list/create/
   detail/edit, no page code — see `docs/ADMIN.md`).
5. Edit the generated service to add domain rules; keep validation, actor
   context, audit and events on every mutation. Reference fields are not
   supported by the factory yet — implement cross-module validation by hand
   following `packages/modules/contact/`.
6. Run `npm run verify`.

Manual path (custom shapes the factory does not cover):

1. Study one existing module under `packages/modules/`.
2. Add schema migration, module service, metadata and validation by hand.
3. Expose mutations only through the service; never execute SQL from API or MCP handlers.
4. Record actor context and audit on every mutation.
5. Add API/MCP exposure only after the service contract is tested.
6. Run `npm run verify` and update docs.
