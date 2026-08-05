# Module factory

The module factory turns a validated manifest (`docs/MODULE_MANIFEST.md`) into a complete, runnable backend module: readable service code, deterministic migration, module definition, tests — and automatic registration. After an explicit apply, no manual step remains: the next `createAgentCrmApp` start migrates and serves the module.

## Commands

```bash
npm run crm -- module plan examples/modules/partner.module.json          # read-only plan
npm run crm -- module plan examples/modules/partner.module.json --json   # same (output is always JSON)

npm run crm -- module create examples/modules/partner.module.json          # dry-run
npm run crm -- module create examples/modules/partner.module.json --apply  # writes
```

- `module plan` is **always read-only**. It reports, for every file the apply would touch: relative path, action (`create`/`modify`), whether it already exists, byte size, `contentSha256` and a preview. The dry-run of `module create` returns the **same plan** that `--apply` executes.
- `module create` with a `.json` argument runs the factory; with a bare name it keeps the legacy template scaffold. Both are dry-run by default; `--apply` is required to write.
- Invalid manifests exit non-zero listing every problem; re-applying an existing module is refused (`refusing to overwrite`) — files are never silently overwritten.

## What gets generated (for `partner`)

| Path | Purpose |
|---|---|
| `packages/modules/partner/module.manifest.json` | normalized manifest — the module's source of truth |
| `packages/modules/partner/src/migration.js` | `{ name: 'create_partners', sql }` |
| `packages/modules/partner/src/partner-service.js` | create / get / list (limit-capped) / update, manifest-derived validation, UNIQUE→ConflictError, audit + domain events on every mutation |
| `packages/modules/partner/src/index.js` | module definition + `createPartnerModule(deps)` |
| `tests/partner-module.test.js` | registration + CRUD + audit test against `:memory:` |
| `packages/modules/generated/index.js` (modified) | regenerated registry, sorted by module name |

Generated files carry a header stating their origin; they are **yours to edit** — the factory never rewrites an existing module.

## How registration works

`packages/modules/generated/index.js` is a checked-in registry with static imports, regenerated on every apply from the `module.manifest.json` copies found under `packages/modules/*/`. `createAgentCrmApp` imports it, passes each module's migration to the database layer (tracked by name in the `module_migrations` table, so registration order never renumbers applied migrations) and registers each factory. The application stays synchronous; there is no dynamic loading or runtime eval. See ADR-007.

## Field support

`string`, `email`, `integer`, `boolean`, `timestamp`, `enum` (+ `required`/`unique`) generate service validation matching the core modules' idiom. **`reference` fields are rejected by `module create`** with a clear message: cross-module integrity checks (like `contact` validating its company) need injected sibling services, which is deferred; `module:migration` still generates reference DDL for hand-written services.

## Safety and determinism

- Byte-identical output for the same manifest and framework version; no timestamps, randomness or machine paths in generated files (`\n` endings).
- Apply is atomic: files are staged to temp names and renamed together; any failure rolls back created files, created directories and the registry.
- Paths are confined to the project root; module names cannot traverse.
- SQLite identifier/keyword/literal safety inherited from manifest validation.

## For coding agents (Claude Code / Codex)

1. `module validate` → fix every reported problem.
2. `module plan` → review the file list and hashes.
3. `module create` (dry-run) → confirm the plan matches intent.
4. `module create --apply` → then `npm run verify` (the generated test runs with the suite).
5. Add domain rules by editing the generated service — keep audit and events on every mutation; cross-module processes belong in workflows, not in the service.
