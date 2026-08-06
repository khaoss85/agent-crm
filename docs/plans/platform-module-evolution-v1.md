# ExecPlan — Module Evolution v1

**Status: implemented.** Guide: `docs/MODULE_EVOLUTION.md`. Decision: ADR-019.

Split out of the Milestone 14 branch (`claude/m14-wip-add289b-preserved`)
because the capability is kernel-level, generic and independently reviewable.
It names no domain, and M14 is not built on this branch.

## The problem, stated exactly

A generated module could not grow. Two facts combine:

1. its migration is `CREATE TABLE IF NOT EXISTS`, so re-applying an edited
   manifest leaves the existing table untouched;
2. its enum values are a SQL `CHECK` constraint baked into that table, and
   SQLite has no `ALTER` for a constraint.

So a record that gains a lifecycle after it ships — the ordinary case, and
exactly what Milestone 14 needs for delivery projects — had no upgrade path at
all. Worse than a silent no-op: the re-apply *fails*, on an index for a column
the table never gained. Both halves are reproduced in
`tests/module-evolution.test.js`.

## Three architectures compared

**1. Edit or replace the original generated migration.** The obvious move, and
it destroys the one guarantee the migration runner has: applied migrations are
immutable, checked by SHA-256, and an edited one stops the next boot. Every
database that already ran the create migration would fail its drift check, and
"just delete the row" is not a migration story. **Rejected.**

**2. Infer the evolution from the live SQLite schema.** Attractive because it
needs no bookkeeping: read `sqlite_master`, diff against the manifest, generate
the delta. It fails on semantics. The schema knows a column is `TEXT` with a
`CHECK`; it does not know the field was declared an `enum` rather than a string,
which `writable` mode it has, whether an index was declared or incidental, or
what the manifest *meant*. It also makes the answer depend on which database
you happen to point at — so a fresh project and an upgraded one can diverge, and
generation before any database exists is impossible. **Rejected.**

**3. Explicit manifest revision, a checked-in applied-definition snapshot, and
append-only named migrations (chosen).** The manifest carries `revision`. Each
generated module carries `module.state.json`: the last generated *normalized*
manifest, its schema fingerprint, and the full ordered migration history with
SQL. An evolution is a new, separately named migration appended to that history.
Nothing applied is ever edited, regenerated or renumbered.

## The questions this plan had to answer

**Where does the previous manifest state come from?** `module.state.json`,
checked in beside the module. It travels with the source, is reviewable in a
diff, exists before any database does, is identical for every environment, and
works the same for a package-owned module as for a project-owned one. Database
introspection may *verify*, but is never the semantic source.

**How is a changed manifest distinguished from an unapplied edit?** By the
schema fingerprint in the state file — a canonical hash of the normalized
definition, deliberately excluding `revision` so "same schema, bumped revision"
is detectable as exactly that. Fingerprint equal and revision equal is an
idempotent no-op. Fingerprint different and revision equal is a refusal naming
the revision to set.

**When must revision increase?** On any change to the normalized schema, by
exactly one. A jump is refused so every step has its own reviewable migration; a
decrease is refused; a bump with no schema change is refused as unnecessary.

**Fresh database versus existing database.** A fresh database runs the whole
migration list; an existing one runs only what it has not recorded. The test
that matters asserts they converge: same columns, same constraints, same
indexes.

**Package-owned modules.** Identical path. The state file lives beside the
manifest wherever the manifest lives, and nothing in the mechanism knows whether
a module belongs to a package.

**Multiple migrations per module.** A generated module exports `migrations[]`,
ordered, append-only. The registry carries the list; `create-app` still honours
a lone `migration` so a project generated before this contract boots unchanged.

**Recoverability.** Filesystem writes stage to temp files and roll back
together, including the state file and the registry, so a failed apply leaves
the previous revision intact. The runtime apply is a separate step: generated
source at revision 2 with a database still at revision 1 is a normal, expected
state that the next boot resolves.

**What v1 supports and rejects.** Below.

## What ships

**Supported, and tested:** adding an optional field (`string`, `integer`,
`boolean`, `enum`, `reference`), widening an enum's value set, and adding a
non-unique index to an existing field.

Adding columns is an `ALTER TABLE … ADD COLUMN`. Widening an enum is the
standard SQLite table rebuild — create the new shape under a scratch name no
module can claim, copy every column **by name** (never `SELECT *`), drop, rename,
recreate the indexes — inside the migration runner's single transaction.

**Rejected before any write:** removing or renaming a field, changing a type,
narrowing an enum, adding a required or unique field, changing `unique`,
changing a reference target or its delete rule. Each refusal names the field and
the reason. A rebuild is additionally refused while another table holds a
foreign key into this one — widening an enum on a referenced table is a design
decision, not an automatic migration.

## Deviations worth naming

| Expected | Shipped | Why |
|---|---|---|
| row-count assertion in SQL | none | `RAISE` works only inside a trigger. The copy is all-or-nothing by construction: the `INSERT…SELECT` has no filter, so it copies every row or aborts the transaction |
| FK verification inside the evolution SQL | in the migration runner | `PRAGMA foreign_key_check` after every module migration protects all of them, not just rebuilds |
| unbounded enum values | bounded to printable, ≤64 chars | they are interpolated into a `CHECK` and re-emitted by every rebuild. A NUL byte produced unparseable DDL. All 148 existing values already comply |

## Explicitly out of scope

Data transformation, default backfill, arbitrary SQL hooks, field split or
merge, table rename, primary-key or system-field changes, dependent-table
migration for inbound foreign keys, and any general ORM or auto-diff claim.
This is a narrow, additive upgrade path, not a schema-management product.

## Definition of done

Met: the evolution planner and generator, the state file and its drift
refusals, `migrations[]` with legacy compatibility, factory integration with the
overwrite guard preserved, the enum bound, runner-level integrity verification,
the guide and ADR-019, and the test suites — including fresh-versus-upgraded
schema equivalence and a package-owned characterization fixture. Still to run
per `docs/QUALITY_GATES.md` §5: the adversarial review, then a human merge.
