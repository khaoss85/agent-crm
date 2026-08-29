# Evolving a generated module

How a record that already exists — with rows in it — gains a field, a status or
an index, without losing data and without editing a migration something has
already run.

Decision: ADR-019. Plan: `docs/plans/platform-module-evolution-v1.md`.

## The short version

```bash
# 1. edit the manifest and bump its revision
#    "revision": 2
# 2. see exactly what would change
npm run crm -- module create packages/<name>/modules/<record>.module.json
# 3. apply it
npm run crm -- module create packages/<name>/modules/<record>.module.json --apply
```

The factory notices the module already exists, compares your manifest with the
last generated definition, and appends **one new migration** for the difference.
The next application boot runs it.

## Why a revision is required

Before this existed, editing an applied manifest did nothing useful: the create
migration is `CREATE TABLE IF NOT EXISTS`, so the table stayed as it was, and
enum values are a SQL `CHECK` baked into that table, which SQLite cannot alter.
Re-applying a widened manifest did not even fail quietly — it failed on an index
for a column the table never gained.

So the change has to be explicit:

| Situation | What happens |
|---|---|
| identical manifest, same revision | idempotent no-op — and the original overwrite refusal still protects a hand-edited generated module |
| changed schema, same revision | refused: *"the schema changed but revision is still 1. Set `"revision": 2`"* |
| identical schema, bumped revision | refused: a revision marks a schema change |
| revision 1 → 3 | refused: one step at a time, so each has its own reviewable migration |
| revision decreased | refused |
| changed schema, revision + 1 | a new migration is generated |

## What v1 can do

| Change | Strategy | How |
|---|---|---|
| add an optional field (`string`, `integer`, `boolean`, `enum`, `reference`) | `alter` | `ALTER TABLE … ADD COLUMN` |
| widen an enum — `planned` → `planned \| in_progress \| completed` | `rebuild` | a controlled table rebuild |
| add a non-unique index to an existing field | `alter` | `CREATE INDEX IF NOT EXISTS` |
| **remove** an index declaration | `alter` | `DROP INDEX IF EXISTS` — so the declared and actual schema agree, whichever strategy runs |
| change `writable`, or a field's `default` | `metadata` | **no migration at all.** These change the generated service, the `/api/schema` block and the Admin, and nothing in the table. The revision still advances, and the source is regenerated |

A `reference` column added by `ALTER TABLE` **is** enforced — `PRAGMA foreign_key_list` records it and a dangling value is refused. That was verified rather than assumed.

## What v1 refuses, and why

Everything that could lose or silently reinterpret data already stored. Each
refusal happens **before any file or database write**, and names the field:

- **removing or renaming a field** — a rename is indistinguishable from a
  removal, and both drop a column;
- **changing a type** — the stored values were written under the old one;
- **narrowing an enum** — rows may already hold the value you are removing;
- **adding a required or unique field** — existing rows have no value, or all
  share NULL;
- **changing `unique`**, or a **reference target or delete rule**;
- **renaming the table** — the existing table and its rows keep the old name, so a rename would generate `ALTER TABLE <new-name>` against a table that was never created, and every boot after it would fail;
- **a rebuild while another table holds a foreign key into this one** — the
  refusal names the blocking reference. Widening an enum on a referenced table
  is a design decision, not an automatic migration.

There is no data transformation, no default backfill, no arbitrary SQL hook, no
field split or merge and no table rename. If you need one of those, you need a
new module and an explicit data migration you write and review yourself.

## The rebuild, in detail

Widening an enum means SQLite must rebuild the table. Inside the migration's
single transaction:

```text
create the new shape under a scratch name no module can claim
copy every column BY NAME (never SELECT *; new columns take NULL)
drop the old table
rename the replacement
recreate every index from the new manifest
```

The copy is all-or-nothing: the `INSERT…SELECT` has no filter, so it copies
every row or violates a constraint and aborts, leaving the original table
untouched.

Afterwards the migration runner verifies referential integrity — for **every**
module migration, not only rebuilds. It compares `PRAGMA foreign_key_check`
before and after, and fails only on violations *this migration introduced*. An
unrelated violation the database already carried is a real problem, but blocking
every future migration on it would mean such a database could never be upgraded,
which is the worse outcome.

Preserved by the rebuild, and asserted in tests: every row, its id, its
`created_at`/`updated_at`, all `NOT NULL`, `UNIQUE` and `CHECK` constraints,
outbound foreign keys, and the indexes.

## `module.state.json` — do not edit it

Each generated module carries the last definition that was generated from it:

```json
{
  "stateVersion": 2,
  "module": "widget",
  "revision": 2,
  "fingerprint": "…",
  "manifest": { "…normalized…" },
  "migrations": [
    { "name": "create_widgets",    "checksum": "…", "sql": "…" },
    { "name": "evolve_widgets_r2", "checksum": "…", "sql": "…" }
  ],
  "postgres": {
    "bootstrap": {
      "name": "pg_bootstrap_widgets",
      "checksum": "…",
      "sql": "…",
      "provenance": { "kind": "v1-state-fingerprint", "fingerprint": "…" }
    },
    "evolutions": []
  }
}
```

`stateVersion` 1 remains readable: its `{name, checksum, sql}` SQLite history
is byte-for-byte authority. Writes emit version 2 with a PostgreSQL bootstrap
from the current normalized manifest, used only on an empty PostgreSQL data
plane. Runtime PostgreSQL composition refuses `LEGACY_MODULE_STATE_REQUIRED`
until that file is checked in; it never synthesizes one at deployment time.
<!-- truth: spine.postgresql.implemented=absent -->

It is the **source of truth** for the next evolution, and it is checked in
deliberately: it travels with the source, is reviewable in a diff, exists before
any database does, and is identical in every environment. Introspecting SQLite
would be worse — the schema knows a column is `TEXT` with a `CHECK`, but not
that the field was declared an enum, which `writable` mode it has, or whether an
index was declared. It would also make the answer depend on which database you
point at.

A hand-edited state file is refused: its fingerprint and every migration
checksum must match what they describe. Restore it from version control rather
than editing it.

## Source revision is not database revision

```text
edit manifest + bump revision → apply → generated source is at r2
                                        ↓
                             next app boot → the database catches up
```

Generated source at revision 2 with a database still at revision 1 is a normal
state, not an error. The boot applies what is missing, in one transaction each.
If a migration fails, the database stays at revision 1 with the source at
revision 2, and the next boot retries — nothing is half-applied.

**Rolling the source back after a migration has applied is not supported.** The
database has already moved; publish a forward change instead.

## Migrations are append-only

A module exports its whole history:

```js
export const widgetMigrations = [
  { name: 'create_widgets',    sql: '…' },
  { name: 'evolve_widgets_r2', sql: '…' },
];
```

The create migration keeps its original identity forever and is **never**
regenerated from a newer manifest — its checksum is recorded in every database
that ran it, and an edited applied migration stops the next boot. The registry
carries the list; a project generated before this contract, exporting a single
`migration`, still boots unchanged.

## Upgrading a module generated before this existed

A module generated before `module.state.json` existed has a manifest and
generated source and no state file. It is **adopted** on the first evolution:
revision 1 is reconstructed from what is on disk, the state file is written by
the apply, and everything after that is ordinary evolution. You do nothing —
bump `revision` in the manifest and apply it, exactly as for any other module.

Adoption verifies rather than assumes. The manifest is accepted as the previous
definition only if regenerating its create migration reproduces the migration
the module really generated, name and every SQL line, so the checksum every
existing database recorded stays valid.

Three cases are refused instead of guessed:

| What you see | What it means |
|---|---|
| `module.manifest.json no longer describes the migration in src/migration.js` | the manifest was edited and never applied. Restore the manifest, or the state file, from version control |
| `has a module.manifest.json but no src/migration.js` | what ran against existing databases is unknown. Restore the module from version control |
| `Only revision 1 can be adopted` | the module is past revision 1 and its state file was lost. The later migrations cannot be reconstructed from the current manifest |

The generated registry reads each module's migrations through a namespace
import, so applying one module never breaks the ones that did not change,
whichever shape their `src/migration.js` exports.

## Package-owned modules

Identical in every respect. The mechanism does not know whether a module belongs
to a package, and `examples/custom-packages/` evolves the same way a project
module does. See `docs/PACKAGE_AUTHORING.md`.

## Related

`docs/MODULE_FACTORY.md` · `docs/plans/platform-module-evolution-v1.md` ·
ADR-019 in `DECISIONS.md` · `.claude/skills/create-crm-module/SKILL.md`
