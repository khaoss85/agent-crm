---
name: create-crm-module
description: Create or extend an Accordo domain module. Use for new CRM objects, fields, service operations, module metadata, API exposure and tests. Do not use for cross-module business processes; use create-crm-workflow instead.
requires:
  tier: generated-project
  command: "crm app inspect"
  projectSurface: ["packages/modules/", "examples/modules/partner.module.json"]
  repositorySurface: ["ARCHITECTURE.md", "DECISIONS.md", "docs/MODULE_MANIFEST.md", "docs/MODULE_FACTORY.md", "docs/ACTIONS.md", "docs/MODULE_EVOLUTION.md", "docs/ADMIN.md"]
  degradesTo: "the module factory CLI — `crm module validate|plan|create` — which checks a manifest, prints the deterministic plan and refuses an unsafe evolution before any write, reading no document"
---

## Orient yourself first

```bash
npm run crm -- app inspect --json
```

Read `valid`, then `problems[]`, then `limitations[]`, in that order. Every problem is fixed or reported before anything is built on top of it, and **every limitation is a hard boundary on what you may claim.** Then read `packages[]`, `capabilities[]`, `resources[]`, `actions[]`, `policies[]` and `providers[]`: that list is what exists. A capability absent from the report does not exist, whatever a record name, a label or a document suggests.

If the repository documents this skill names are absent, you are in a project built from this framework rather than in the framework itself. The inspection report is then the source of truth and those documents are optional background — do not guess at their contents, and do not assume a path exists because this skill names it.

`modules[]` is where you check whether the record you are about to create already exists, which package owns it, its checked-in `revision` and its declared fields — read it before writing a manifest, not after.

Preferred path — module factory (manifest-driven):

1. Background, where they exist: `ARCHITECTURE.md`, `DECISIONS.md`, `docs/MODULE_MANIFEST.md`
   and `docs/MODULE_FACTORY.md`. The commands in the steps below carry the contract
   themselves — `module validate` refuses a manifest these documents would have
   refused — so read them for the reasoning, and proceed without them if they are
   not in this project.
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
5. Reference fields (many-to-one to another generated module) are supported:
   `{"type":"reference","references":"<target-table>"}`. Apply the target module
   first; the generated service validates the target at runtime via the
   application reference resolver (ADR-010) and the Admin renders a target
   selector. Generated-to-core references are not supported yet.
6. For a lifecycle step that is more than a field edit (qualify, close,
   approve), do **not** hand-roll it in the service: define a record action
   (`docs/ACTIONS.md`, ADR-011). Mark the fields the action owns
   `"writable": "managed"` in the manifest so generic CRUD cannot reach that
   state, and write the managed fields from `execute` via `ctx.managed`. The
   runtime supplies one atomic transaction, events released only after commit,
   and an automatic trace; it does not deduplicate, so express idempotency in
   data (a unique key), as in
   `examples/starters/b2b-lead-qualification/`.
7. Edit the generated service to add domain rules; keep validation, actor
   context, audit and events on every mutation.
8. Run `npm run verify`.

Manual path (custom shapes the factory does not cover):

1. Study one existing module under `packages/modules/`.
2. Add schema migration, module service, metadata and validation by hand.
3. Expose mutations only through the service; never execute SQL from API or MCP handlers.
4. Record actor context and audit on every mutation.
5. Add API/MCP exposure only after the service contract is tested.
6. Run `npm run verify` and update docs.

## Evolving a module that already exists (ADR-019)

1. A generated module's schema can grow, but only additively and only with an explicit `"revision"` bump — one step at a time. Edit the manifest, set `"revision": <previous + 1>`, and re-run `module create … --apply`; the factory appends one new migration and the next boot applies it.
2. **Supported:** add an optional field, widen an enum's values, add or remove a non-unique index, and change `writable` or `default` (a `metadata` evolution — the revision advances, the source is regenerated, no migration is emitted). **Refused before any write:** removing or renaming a field, changing a type, narrowing an enum, adding a required or unique field, changing `unique`, changing a reference target, **renaming the table** — and a rebuild while another table holds a foreign key into this one.
3. Never edit `packages/modules/<name>/module.state.json`. It is the checked-in source of truth for the next evolution, and a hand edit is refused by fingerprint and per-migration checksum.
4. Never edit an applied migration. The create migration keeps its identity forever; changes are appended to `migrations[]`.
5. Generated source at revision 2 with a database still at revision 1 is normal — the next boot catches up. Rolling the source back after a migration has applied is not supported; publish a forward change.
6. Enum values are bounded: printable, at most 64 characters. They end up inside a SQL `CHECK` and are re-emitted by every rebuild.

Full guide: `docs/MODULE_EVOLUTION.md`.
