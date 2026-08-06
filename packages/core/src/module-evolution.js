// @ts-check

import { ValidationError } from './errors.js';
import { validateModuleManifest, generateModuleMigration } from './module-manifest.js';

/**
 * **Module manifest evolution** — a generic runtime capability (ADR-020).
 *
 * A generated module's migration is `CREATE TABLE IF NOT EXISTS`, and its
 * enum values are a SQL `CHECK` constraint baked into the table. Together those
 * mean a manifest cannot grow: re-applying an edited manifest silently no-ops
 * against the existing table, and the old `CHECK` keeps rejecting the new
 * values. A record that gains a lifecycle after it ships — the ordinary case —
 * had no path at all.
 *
 * This file is that path, and it names no domain: it compares two manifests for
 * the same module and produces the additional migration that takes a database
 * from the first to the second.
 *
 * **What it allows** (everything additive, nothing that can lose data):
 *
 *   - a new optional field;
 *   - a widened enum value set;
 *   - a new index on an existing field.
 *
 * **What it refuses, loudly** — because each one either destroys data or
 * changes the meaning of data already stored:
 *
 *   - removing a field, or renaming one (indistinguishable from a removal);
 *   - changing a field's type;
 *   - narrowing an enum, which would orphan rows already holding the value;
 *   - adding a required field (existing rows have no value for it);
 *   - changing `unique`, or changing a reference target or its delete rule.
 *
 * Evolution is expressed as a **new, separately named migration**, never as an
 * edit to an applied one: the checksum drift protection in `database.js` stays
 * exactly as strict as it was.
 */

/** The revision a manifest is at. Absent means revision 1, so existing manifests are unchanged. */
export function manifestRevision(manifest) {
  const revision = manifest.revision ?? 1;
  if (!Number.isSafeInteger(revision) || revision < 1 || revision > 1000) {
    throw new ValidationError(`Module "${manifest.name}": revision must be an integer between 1 and 1000`);
  }
  return revision;
}

/** @param {any[]} fields */
function byName(fields) {
  return new Map(fields.map((field) => [field.name, field]));
}

/**
 * Compare two revisions of one module's manifest and describe the change.
 * Pure: it reads no database and writes nothing.
 *
 * @param {{previous: any, next: any}} input
 */
export function planModuleEvolution({ previous, next }) {
  const before = validateModuleManifest(previous);
  const after = validateModuleManifest(next);

  if (before.name !== after.name) {
    throw new ValidationError(
      `Module evolution compares one module with itself: got "${before.name}" and "${after.name}"`,
    );
  }
  const fromRevision = manifestRevision(before);
  const toRevision = manifestRevision(after);
  if (toRevision <= fromRevision) {
    throw new ValidationError(
      `Module "${after.name}": revision must increase to evolve (${fromRevision} → ${toRevision})`,
    );
  }

  const previousFields = byName(before.fields);
  const nextFields = byName(after.fields);

  /** @type {string[]} */
  const refusals = [];
  /** @type {any[]} */
  const addedFields = [];
  /** @type {{field: string, added: string[]}[]} */
  const widenedEnums = [];
  /** @type {string[]} */
  const addedIndexes = [];

  for (const [name, field] of previousFields) {
    const updated = nextFields.get(name);
    if (!updated) {
      refusals.push(`field "${name}" was removed — removing or renaming a field would drop stored data`);
      continue;
    }
    if (updated.type !== field.type) {
      refusals.push(`field "${name}" changed type from ${field.type} to ${updated.type}`);
      continue;
    }
    if (Boolean(updated.required) !== Boolean(field.required)) {
      refusals.push(`field "${name}" changed required from ${Boolean(field.required)} to ${Boolean(updated.required)}`);
    }
    if (Boolean(updated.unique) !== Boolean(field.unique)) {
      refusals.push(`field "${name}" changed unique from ${Boolean(field.unique)} to ${Boolean(updated.unique)}`);
    }
    if (field.type === 'reference'
      && (updated.references !== field.references || (updated.onDelete ?? 'restrict') !== (field.onDelete ?? 'restrict'))) {
      refusals.push(`field "${name}" changed its reference target or delete rule`);
    }
    if (field.type === 'enum') {
      const had = new Set(field.values ?? []);
      const has = new Set(updated.values ?? []);
      const removed = [...had].filter((value) => !has.has(value));
      if (removed.length > 0) {
        refusals.push(
          `field "${name}" removed enum value(s) ${removed.map((v) => `"${v}"`).join(', ')} — rows may already hold them`,
        );
      }
      const added = [...has].filter((value) => !had.has(value));
      if (added.length > 0) widenedEnums.push({ field: name, added });
    }
    if (updated.index === true && field.index !== true) addedIndexes.push(name);
  }

  for (const [name, field] of nextFields) {
    if (previousFields.has(name)) continue;
    if (field.required) {
      refusals.push(`field "${name}" is new and required — existing rows would have no value for it`);
      continue;
    }
    if (field.unique) {
      refusals.push(`field "${name}" is new and unique — existing rows would all share NULL`);
      continue;
    }
    addedFields.push(field);
  }

  if (refusals.length > 0) {
    throw new ValidationError(
      `Module "${after.name}" cannot evolve from revision ${fromRevision} to ${toRevision}:\n`
        + refusals.map((line) => `  - ${line}`).join('\n')
        + '\nEvolution is additive only. A change that loses or reinterprets stored data needs a new module and an explicit data migration.',
    );
  }

  // Widening an enum means rebuilding the table: SQLite has no ALTER for a
  // CHECK constraint. Adding a column does not.
  const strategy = widenedEnums.length > 0 ? 'rebuild' : addedFields.length + addedIndexes.length > 0 ? 'alter' : 'none';

  return {
    module: after.name,
    table: after.table,
    fromRevision,
    toRevision,
    strategy,
    addedFields: addedFields.map((field) => field.name),
    widenedEnums,
    addedIndexes,
  };
}

/**
 * The SQL that performs the planned evolution, as a migration named for the
 * revision it produces — so `database.js` applies it exactly once and still
 * refuses any edit to an already-applied migration.
 *
 * @param {{previous: any, next: any, referencedBy?: string[]}} input
 *   `referencedBy` names other installed tables holding a foreign key into this
 *   one. A rebuild drops and recreates the table, so it is refused while any
 *   such reference exists rather than risking the constraint.
 */
export function generateModuleEvolution({ previous, next, referencedBy = [] }) {
  const plan = planModuleEvolution({ previous, next });
  const after = validateModuleManifest(next);

  if (plan.strategy === 'none') {
    throw new ValidationError(
      `Module "${plan.module}" revision ${plan.toRevision} changes nothing that needs a migration`,
    );
  }

  const migrationName = `evolve_${plan.table}_r${plan.toRevision}`;
  /** @type {string[]} */
  const statements = [];

  if (plan.strategy === 'alter') {
    for (const name of plan.addedFields) {
      const field = after.fields.find((entry) => entry.name === name);
      statements.push(`ALTER TABLE ${plan.table} ADD COLUMN ${columnSql(field)};`);
    }
    for (const name of plan.addedIndexes) {
      const field = after.fields.find((entry) => entry.name === name);
      statements.push(indexSql(plan.table, field));
    }
  } else {
    if (referencedBy.length > 0) {
      throw new ValidationError(
        `Module "${plan.module}" needs a table rebuild to widen an enum, but ${referencedBy.join(', ')} `
          + 'hold a foreign key into it. Widening an enum on a referenced table is a design decision, not an automatic migration.',
      );
    }
    // The standard SQLite rebuild, inside the migration runner's transaction:
    // build the new shape, copy every existing column by name (new columns take
    // NULL), drop the old table and rename. Indexes are recreated from the new
    // manifest, so an added index needs no separate statement.
    const fresh = generateModuleMigration({ ...after, name: after.name });
    const temporary = `${plan.table}__r${plan.toRevision}`;
    const carried = after.fields
      .filter((field) => plan.addedFields.indexOf(field.name) === -1)
      .map((field) => field.column);
    const columns = ['id', ...carried, 'created_at', 'updated_at'];

    statements.push(
      fresh.sql
        .split('\n')
        .filter((line) => !line.startsWith('CREATE INDEX'))
        .join('\n')
        .replace(`CREATE TABLE IF NOT EXISTS ${plan.table} (`, `CREATE TABLE ${temporary} (`)
        .trim(),
    );
    statements.push(
      `INSERT INTO ${temporary} (${columns.join(', ')}) SELECT ${columns.join(', ')} FROM ${plan.table};`,
    );
    statements.push(`DROP TABLE ${plan.table};`);
    statements.push(`ALTER TABLE ${temporary} RENAME TO ${plan.table};`);
    for (const line of fresh.sql.split('\n').filter((line) => line.startsWith('CREATE INDEX'))) {
      statements.push(line);
    }
  }

  return { ...plan, migrationName, sql: `${statements.join('\n')}\n` };
}

/** @param {any} field */
function columnSql(field) {
  const parts = [field.column];
  parts.push(field.type === 'integer' || field.type === 'boolean' ? 'INTEGER' : 'TEXT');
  // An added column is optional by construction, so NOT NULL and UNIQUE never
  // appear here: both were refused in the plan.
  if (field.type === 'boolean') parts.push(`CHECK(${field.column} IN (0, 1))`);
  if (field.type === 'enum' && field.values) {
    parts.push(`CHECK(${field.column} IN (${field.values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ')}))`);
  }
  if (field.type === 'reference') {
    parts.push(`REFERENCES ${field.references}(id) ON DELETE ${field.onDelete === 'cascade' ? 'CASCADE' : field.onDelete === 'set_null' ? 'SET NULL' : 'RESTRICT'}`);
  }
  return parts.join(' ');
}

/** @param {string} table @param {any} field */
function indexSql(table, field) {
  return `CREATE INDEX IF NOT EXISTS ${table}_${field.column} ON ${table}(${field.column});`;
}
