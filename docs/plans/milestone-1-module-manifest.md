# Milestone 1 — declarative CRM module manifest

## Goal and user-visible outcome

A developer or coding agent can describe a CRM module in a small declarative JSON manifest and have the framework validate it with clear errors and generate deterministic SQLite migration SQL for it, through the existing CLI, dry-run by default.

Target experience:

```bash
npm run crm -- module validate examples/modules/partner.module.json
npm run crm -- module migration examples/modules/partner.module.json --dry-run
```

## Current repository context

- `packages/core/src/database.js` holds handwritten DDL for every table inside a static `MIGRATIONS` array.
- `packages/core/src/schema.js` duplicates the same entities as an agent-readable description (`CRM_SCHEMA`).
- Each module (`packages/modules/{company,contact,opportunity,approval}`) duplicates its entity field list a third time in its `index.js` module definition.
- `packages/cli/src/scaffold-module.js` scaffolds module code from a name only — it has no knowledge of fields, so generated services and migrations must be handwritten afterwards.
- Validation helpers live in `packages/core/src/validation.js`; errors in `packages/core/src/errors.js`.

Duplication identified: entity/field shape exists in three places (DDL, `CRM_SCHEMA`, module definitions), all maintained by hand. The manifest becomes the first single declarative source from which one of these (the migration DDL) is generated deterministically.

## Design

New core capability `packages/core/src/module-manifest.js`:

- `validateModuleManifest(manifest)` — returns a normalized, frozen manifest or throws `ValidationError` listing every problem found (not just the first).
- `generateModuleMigration(manifest)` — pure function of the normalized manifest; returns `{ module, table, migrationName, sql }` with byte-stable SQL output.

Manifest schema (documented in `docs/MODULE_MANIFEST.md`):

- `name` — module name, `^[a-z][a-z0-9-]*$`.
- `description` — optional string.
- `table` — optional explicit table name; defaults to a documented naive plural of `name`.
- `fields[]` — `{ name, type, required?, unique?, values?, references?, onDelete? }`.
- Field types: `string`, `email`, `integer`, `boolean`, `timestamp`, `enum` (requires `values`), `reference` (requires `references` = target table, optional `onDelete`).
- Every generated table automatically gets `id TEXT PRIMARY KEY`, `created_at`, `updated_at` — an explicit, documented convention, and those names are reserved in manifests.
- Field names are camelCase in the manifest and map deterministically to snake_case columns.
- Money remains integer cents + currency code, modeled as explicit `integer` + `string`/`enum` fields (no multi-column magic types).

CLI (existing `packages/cli`):

- `module:validate <manifest>` (also accepted as `module validate <manifest>`).
- `module:migration <manifest> [--dry-run] [--out file] [--force]` — dry-run by default; `--out` writes the SQL file and refuses to overwrite without `--force`.
- New npm script `crm` so `npm run crm -- …` works from a clean checkout.

Out of scope (later milestones): runtime loading of generated migrations into `database.js`, service/Admin/SDK generation from manifests, MCP exposure of manifest tools, rewriting Milestone 0 modules onto manifests.

## Milestones

- [x] Manifest validation and normalization with aggregated, field-precise errors.
- [x] Deterministic migration generation (same manifest → identical SQL).
- [x] CLI commands, dry-run by default, `npm run crm` script, help text.
- [x] Example manifest `examples/modules/partner.module.json`.
- [x] Unit tests (valid/invalid manifests, determinism) and CLI integration tests (dry-run does not write, `--out`/`--force` behavior).
- [x] Documentation (`docs/MODULE_MANIFEST.md`, README) and ADR-006 in `DECISIONS.md`.
- [x] Mark the completed task in `TASKS.md`.

## Validation

```bash
npm run verify
npm run smoke
npm run crm -- module validate examples/modules/partner.module.json
npm run crm -- module migration examples/modules/partner.module.json --dry-run
```

Expected behavior:

- the existing 9 tests still pass, plus new manifest tests;
- validation of the partner example succeeds and reports the normalized manifest;
- migration generation prints stable SQL and does not touch the repository or database;
- invalid manifests fail with messages naming each offending field.

## Progress log

- Inspected module architecture and identified the three-way duplication of entity shape.
- Implemented `module-manifest.js` (validation + generation) in core.
- Wired `module:validate` / `module:migration` into the CLI with dry-run default.
- Added partner example manifest, unit tests and CLI integration tests.
- Documented the manifest schema and recorded ADR-006.
- Final validation: `npm run verify` and `npm run smoke` pass.
- Adversarial review pass: rejected SQLite keyword identifiers (columns, tables, `references` targets), added an explicit `manifestVersion` (only `1` supported, newer versions fail with an upgrade hint), made validation idempotent on normalized manifests, and made `--out` writes atomic (temp file + rename).

## Decision log

- Generation is a pure, deterministic function — no timestamps, no randomness — so the same manifest always produces the same SQL (reviewable diffs, safe re-runs).
- The manifest generates migration SQL only; it does not become a runtime metaprogramming layer. Services remain handwritten explicit code (no low-code platform).
- Table naming defaults to a naive documented plural (`partner` → `partners`, `company` → `companies`); an explicit `table` field overrides it, so there is no hidden convention.
- `references` names the target table explicitly instead of deriving it from a module name, avoiding cross-manifest resolution magic in this milestone.
- CLI writes are opt-in (`--out`) and never overwrite without `--force`, consistent with ADR-004's dry-run-by-default rule.

## Outcome and follow-up

The first Milestone 1 task is complete: manifests are the declarative source for new-module DDL. Natural follow-ups: load generated migrations into the database migration list declaratively, drive `module:create` scaffolding from a manifest, and generate module metadata/Admin forms from the same source.
