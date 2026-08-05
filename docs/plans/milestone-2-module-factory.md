# Milestone 2 — module factory: runnable CRM modules from manifests

## Goal and user-visible outcome

From a validated manifest the framework produces a complete, runnable backend module — readable service code, migration, registration, tests — with one explicit command:

```bash
npm run crm -- module plan examples/modules/partner.module.json
npm run crm -- module create examples/modules/partner.module.json          # dry-run
npm run crm -- module create examples/modules/partner.module.json --apply  # writes
```

After `--apply`, no manual step remains: the module is migrated, registered and served by `createAgentCrmApp` on next start. This is the step from "manifest → SQL" (Milestone 1) to "manifest → working module".

## Current repository context

- `packages/core/src/module-manifest.js` (Milestone 1): validation + deterministic migration SQL.
- `packages/core/src/database.js`: core DDL in a static, integer-versioned `MIGRATIONS` array; `createDatabase` applies pending versions.
- `packages/app/src/create-app.js`: **synchronous** composition; each module imported statically, constructed with `{database, audit, events}` (+ sibling services), registered in `ModuleRegistry`.
- Existing services (company/contact) define the idiom to generate: validation from `core/validation.js`, snake_case SQL, camelCase domain objects, `UNIQUE constraint failed` → `ConflictError`, audit + event after the authoritative write.
- `packages/cli/src/scaffold-module.js`: legacy name-only scaffolding (kept).

## Existing duplication

Hand-writing a module today means repeating: the field list (manifest ⇄ service ⇄ definition), the row mapper, validation per field, audit/event boilerplate, the migration, plus two manual registrations (SQL into `MIGRATIONS`, factory into `create-app.js`). The factory removes all of it for CRUD-shaped modules.

## Smallest safe architecture change

Two additions, no rewrite:

1. **Generated-module registry file** — `packages/modules/generated/index.js`, a checked-in file with static imports, initially empty. `module create --apply` regenerates it by scanning `packages/modules/*/module.manifest.json` (the manifest copy each generated module carries) sorted by module name. `create-app.js` imports it statically and registers each factory — preserving the synchronous architecture; no dynamic loader, no runtime eval.
2. **Name-keyed module migrations** — `createDatabase` gains `moduleMigrations: [{name, sql}]`, tracked in a new `module_migrations(name TEXT PRIMARY KEY, applied_at)` table, applied transactionally after core migrations. Name-keyed (not integer-versioned) so registration order never renumbers already-applied migrations; each generated migration is a self-contained idempotent `CREATE TABLE IF NOT EXISTS`.

Recorded as ADR-007.

## Generated artifacts (per module, relative to project root)

| Path | Content |
|---|---|
| `packages/modules/<name>/module.manifest.json` | normalized manifest (canonical serialization; source of truth for registry scan) |
| `packages/modules/<name>/src/migration.js` | `{ name: 'create_<table>', sql }` from Milestone 1 generation |
| `packages/modules/<name>/src/<name>-service.js` | readable service: create / get / list (safe limit) / update, per-field validation, boolean 0/1 mapping, UNIQUE→ConflictError, audit + domain events on mutations |
| `packages/modules/<name>/src/index.js` | module definition (name, version, description, entities) + `create<Pascal>Module(deps)` |
| `tests/<name>-module.test.js` | CRUD + validation + audit happy-path against `createAgentCrmApp({dbPath: ':memory:'})` |
| *(modified)* `packages/modules/generated/index.js` | regenerated registry |

Generated files carry a header stating origin and that they are editable ("this file is yours") — no timestamps, no absolute paths.

## Registration strategy

`create-app.js`: `import { generatedModules } from '../../modules/generated/index.js'`; passes `generatedModules.map(m => m.migration)` to `createDatabase` and registers each `m.createModule({database, audit, events})` after core modules. Generated services are reachable via `modules.get(name).service`; core `services`/workflows untouched.

## Migration strategy

Module migrations run after core `MIGRATIONS`, each in its own transaction, recorded by name. Order-independent: FK targets need not exist at CREATE time in SQLite, and this milestone rejects reference fields in `module create` anyway.

## CLI surface

- `module plan <manifest> [--root path] [--json]` — always read-only; returns module, table, migration name, and the exact file plan (relative path, action `create|modify`, `exists`, content sha256 + preview). `--json` is accepted; output is already machine-readable JSON (CLI convention).
- `module create <manifest.json> [--apply] [--root path]` — dry-run by default, returning the **same plan** apply will execute; `--apply` writes. A non-`.json` argument keeps the legacy name-based scaffold (`module:create partner`), preserving all Milestone 1 commands and aliases.
- Errors exit non-zero with aggregated, field-precise messages (Milestone 1 validation reused).

## Rollback / failure behavior

Apply is staged: all contents built in memory → collision check (any existing target ⇒ `ConflictError`, never silent overwrite; registry is the only `modify` target and its original content is retained) → write every file to a `.tmp-agent-crm` sibling → rename all → on any error, delete temp files and any renamed new files and restore the registry's original bytes. No partial project mutation survives a failure.

## Safety

- Deterministic: byte-identical output for the same manifest + framework version (sha256 asserted in tests; no timestamps/randomness/machine paths; `\n` endings).
- Path traversal: module name already constrained to `^[a-z][a-z0-9-]*$`; every resolved target is verified to stay under the project root.
- SQLite identifier/literal safety inherited from Milestone 1 (keyword rejection, escaped enum literals).
- Reference fields: **rejected in `module create`** with a clear message (migration-only support from Milestone 1 preserved) — generating weaker referential integrity than handwritten modules is not acceptable, and injecting sibling services is deferred scope.
- No secrets/env files generated; no MCP/API direct DB writes; no remote operations.

## Compatibility constraints

- All Milestone 0/1 behavior unchanged (existing 23 tests must pass untouched).
- `createAgentCrmApp` remains synchronous; empty registry ⇒ identical behavior to today.
- The repository itself keeps an empty registry (no permanently enabled demo module); the end-to-end proof runs in a temporary copied project.

## Validation helpers added to core

`requiredInteger`, `optionalInteger`, `optionalEnum`, `optionalEmail`, `requiredIsoDate`, `requiredBoolean` — completing the required/optional pairs the generator needs, in the same style as the existing helpers.

## End-to-end proof (Partner)

A test copies `packages/`, `package.json` and the partner manifest into a temp directory, then via the temp copy's own CLI: validate → plan (twice, byte-identical) → dry-run (no writes) → `--apply` → re-apply refused (conflict) → import the temp copy's `createAgentCrmApp`, assert Partner in `modules.list()`, create/get/list/update a record, assert audit events and domain events, run the generated test file with `node --test`, and assert regeneration in a second copy is byte-identical.

## Explicitly deferred scope

Generated Admin UI / SDK / HTTP API; manifest MCP tools; reference-field service validation; module deletion; PostgreSQL; auth/tenancy/RBAC; providers marketplace; create-app CLI; deployment; remote MCP; rename/licensing.

## Milestones

- [x] ExecPlan (this document).
- [x] Core: `moduleMigrations` in `createDatabase`; validation helpers.
- [x] Factory: plan/generate/apply with atomic writes and registry regeneration.
- [x] CLI: `module plan` / manifest-driven `module create`; help text.
- [x] App: registry wiring in `create-app.js`.
- [x] Tests: factory unit tests + Partner end-to-end proof.
- [x] Docs (`docs/MODULE_FACTORY.md`, cross-refs, skills) + ADR-007.
- [x] `npm run verify` + `npm run smoke` green.

## Progress log

- Read create-app, contact/company services, audit/event bus; confirmed synchronous composition and service idioms.
- Implemented registry + name-keyed module migrations + factory + CLI + tests.
- End-to-end Partner proof passing from a clean temporary project copy.
- Final validation: verify and smoke green; repository registry left empty.
- Adversarial review pass: migration drift detection via SHA-256 checksums (applied migrations are immutable; changed SQL fails loudly; duplicate identities rejected); data write + audit record made atomic via SAVEPOINT (nesting-safe) with domain events only after release; plan-time collision policy (reserved `generated`, core/handwritten modules case-insensitively, core tables, other generated tables); registry scan validates every existing manifest; `list` limit hardening + deterministic `created_at DESC, id` ordering; explicit `--dry-run` wins over `--apply`; symlink-resolved root confinement on apply; e2e extended to a second module (unique/boolean/integer fields), failed-mutation audit/event assertions, spaced paths.

## Decision log

- Registry-file registration chosen over filesystem discovery: keeps `createAgentCrmApp` synchronous and imports static/reviewable; the registry is regenerated from manifest copies, never hand-parsed JS.
- Name-keyed module migrations chosen over extending integer versions: alphabetical registration must never renumber applied migrations.
- Reference fields rejected in `module create` (path 2 of the two allowed): honest error now beats silently weaker integrity; migration generation for references is unchanged.
- Generated tests import the app factory (not the service directly) so they prove registration, migration and service together.

## Outcome and follow-up

Manifest → runnable module with zero manual registration. Natural next steps: reference-field service validation with injected sibling services, Admin/SDK generation from the same manifests (roadmap Phase 4), and MCP exposure of plan/create (dry-run) tools.
