# Module manifests

A module manifest is a small declarative JSON file that describes one CRM module entity. The framework validates it with precise errors and generates deterministic SQLite migration SQL from it. The same manifest always produces byte-identical output.

Manifests do not execute anything and do not touch the database: they are input to explicit, dry-run-by-default CLI commands.

## Example

`examples/modules/partner.module.json`:

```json
{
  "manifestVersion": 1,
  "name": "partner",
  "description": "Channel partners that resell or refer the product.",
  "fields": [
    { "name": "name", "type": "string", "required": true },
    { "name": "tier", "type": "enum", "values": ["silver", "gold", "platinum"] },
    { "name": "territory", "type": "string" }
  ]
}
```

## Manifest schema

| Property | Required | Meaning |
|---|---|---|
| `manifestVersion` | no | Manifest format version. Defaults to `1`, the only supported value; a manifest written for a newer format fails with an explicit "unsupported manifestVersion" error instead of being misinterpreted. |
| `name` | yes | Module name, `^[a-z][a-z0-9-]*$` (example: `partner`, `partner-contract`). |
| `description` | no | Human/agent-readable description. |
| `table` | no | Explicit table name (`^[a-z][a-z0-9_]*$`). Defaults to the naive plural below. |
| `fields` | yes | Non-empty array of field objects. |

Unknown properties are rejected so typos fail loudly.

### Fields

| Property | Required | Meaning |
|---|---|---|
| `name` | yes | camelCase, `^[a-z][a-zA-Z0-9]*$`. Maps to a snake_case column (`valueCents` → `value_cents`). |
| `type` | yes | One of `string`, `email`, `integer`, `boolean`, `timestamp`, `enum`, `reference`. |
| `required` | no | Default `false`. Generates `NOT NULL`. |
| `unique` | no | Default `false`. Generates `UNIQUE`. |
| `values` | enum only | Non-empty array of unique strings; generates a `CHECK(col IN (...))`. |
| `references` | reference only | Target **table** name (example: `"companies"`); generates `REFERENCES <table>(id)` and an index on the column. |
| `onDelete` | reference only | `restrict` (default), `cascade` or `set_null`. `set_null` conflicts with `required: true`. |

### Explicit conventions (no hidden magic)

- Every generated table gets `id TEXT PRIMARY KEY`, `created_at TEXT NOT NULL` and `updated_at TEXT NOT NULL` automatically. `id`, `createdAt` and `updatedAt` are therefore reserved field names.
- Default table name is a documented naive plural of `name`: trailing consonant + `y` → `ies` (`company` → `companies`), trailing `s` → `es` (`business` → `businesses`), otherwise append `s` (`partner` → `partners`). Hyphens become underscores. Use `table` to override.
- Column types: `integer` and `boolean` → `INTEGER` (`boolean` adds `CHECK(col IN (0, 1))`); everything else → `TEXT`. Tables are `STRICT`.
- Money is modeled explicitly as an `integer` cents field plus a `string`/`enum` currency field, per repository conventions. There is no composite money type.
- Field order in the manifest is preserved in the generated SQL.
- Generated identifiers are unquoted, so table names, column names and `references` targets must not be SQLite keywords (for example `order`, `values`, `select`); validation rejects them with a clear error asking for a rename or an explicit `table`.

## CLI usage

```bash
npm run crm -- module validate examples/modules/partner.module.json
npm run crm -- module migration examples/modules/partner.module.json --dry-run
npm run crm -- module migration examples/modules/partner.module.json --out migrations/create_partners.sql
```

`module:validate` / `module:migration` and the space-separated aliases are equivalent.

- Migration generation is a **dry-run by default**: it prints `{ mode: "dry-run", sql }` and writes nothing.
- Writing requires an explicit `--out <file>`; an existing file is never overwritten unless `--force` is passed.
- An explicit `--dry-run` flag always wins over `--out`.
- Validation failures exit non-zero and list every problem, naming the offending field.

## How coding agents should use this

1. Write the manifest under `examples/modules/` or the module's own directory.
2. Run `module validate` and fix every reported error.
3. For a complete runnable module (service, migration, registration, tests), use the **module factory**: `module plan` then `module create --apply` — see `docs/MODULE_FACTORY.md`. No manual `MIGRATIONS` or `create-app.js` edit is needed.
4. For hand-written services (e.g. modules with reference fields), run `module migration --dry-run`, review the SQL, and add it as a migration yourself.
5. Business logic stays explicit code — manifests generate infrastructure. Mutations still go through module services and workflows with validation, audit and trace.
6. Finish with `npm run verify`.

## Reference fields (Milestone 5)

A `reference` field links a record to another generated record (many-to-one). `references` names the **target table**; the framework derives the target module from installed-module metadata.

```json
{ "name": "partnerId", "type": "reference", "references": "partners", "required": true }
```

- The target generated module must already be applied; `module plan`/`create` reports each reference's `targetModule`/`targetTable` and rejects a missing target ("apply the target module first").
- `required` → non-null foreign key; optional → nullable, and an optional reference is cleared by submitting `null`.
- Generated-to-**core** references (e.g. `companies`) are rejected in this milestone.
- Self-references and cross-module cycles are supported (resolution is lazy at request time).
- A missing target at create/update is a `VALIDATION_ERROR` tied to the field — no write, audit or event. The SQLite foreign key (`ON DELETE RESTRICT`) enforces integrity as defense in depth. See `docs/MODULE_FACTORY.md` and ADR-010.
