// @ts-check

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppError, ValidationError } from './errors.js';
import { validateModuleManifest, generateModuleMigration } from './module-manifest.js';
import {
  manifestFieldToColumn,
  renderPostgresMigration,
} from './dialect-sql.js';
import { POSTGRES_SCHEMA_NAME, mapPhysicalName, qualifyPostgresIdent, quotePostgresIdent } from './physical-name.js';

/**
 * **Module manifest evolution** — a generic runtime capability (ADR-019).
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

  // A renamed table is a different table. Left undetected it generated an
  // `ALTER TABLE <new-name>` against a table that was never created, so every
  // boot after the migration failed with "no such table".
  if (before.table !== after.table) {
    throw new ValidationError(
      `Module "${after.name}": table name changed from "${before.table}" to "${after.table}". `
        + 'Renaming a table is not an additive evolution — the existing table and its rows keep the old name. '
        + 'Keep the table name, or create a new module and migrate the data explicitly.',
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
  /** @type {string[]} */
  const removedIndexes = [];
  /** @type {string[]} */
  const metadataChanges = [];

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
    // A dropped index declaration used to be ignored on the ALTER path and
    // silently applied on the rebuild path, so the same manifest change had two
    // different outcomes. It is one change, applied either way.
    if (field.index === true && updated.index !== true) removedIndexes.push(name);
    // Changes that alter behaviour without altering storage: `writable` decides
    // whether public CRUD may set the field, `default` what a create fills in.
    // Both reach the API, the schema and the Admin through regenerated source.
    if (updated.writable !== field.writable) metadataChanges.push(`${name}.writable`);
    if (JSON.stringify(updated.default ?? null) !== JSON.stringify(field.default ?? null)) {
      metadataChanges.push(`${name}.default`);
    }
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
  // CHECK constraint. Adding or dropping a column or an index does not. A change
  // that touches no storage at all is still a change — it regenerates the
  // service, the schema block and the Admin — and is classified as such rather
  // than mistaken for "nothing happened".
  const touchesStorage = addedFields.length + addedIndexes.length + removedIndexes.length > 0;
  const strategy = widenedEnums.length > 0 ? 'rebuild'
    : touchesStorage ? 'alter'
      : metadataChanges.length > 0 ? 'metadata' : 'none';

  return {
    module: after.name,
    table: after.table,
    fromRevision,
    toRevision,
    strategy,
    addedFields: addedFields.map((field) => field.name),
    widenedEnums,
    addedIndexes,
    removedIndexes,
    metadataChanges,
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
  const before = validateModuleManifest(previous);

  if (plan.strategy === 'none') {
    throw new ValidationError(
      `Module "${plan.module}" revision ${plan.toRevision} changes nothing: neither the stored schema nor the `
        + 'generated behaviour differs from the previous revision.',
    );
  }
  if (plan.strategy === 'metadata') {
    // Real, and storage-free: the generated service, schema block and Admin
    // change; the table does not. No migration is emitted, and none is claimed.
    return { ...plan, migrationName: null, sql: '' };
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
    for (const name of plan.removedIndexes) {
      const field = before.fields.find((entry) => entry.name === name);
      statements.push(`DROP INDEX IF EXISTS ${plan.table}_${field.column};`);
    }
  } else {
    if (referencedBy.length > 0) {
      throw new ValidationError(
        `Module "${plan.module}" needs a table rebuild to widen an enum, but ${referencedBy.join(', ')} `
          + 'hold a foreign key into it. Widening an enum on a referenced table is a design decision, not an automatic migration.',
      );
    }
    // The standard SQLite rebuild, inside the migration runner's transaction:
    // build the new shape, copy every existing column **by name** (new columns
    // take NULL), verify nothing was lost, drop the old table and rename.
    // Indexes are recreated from the new manifest, so an added index needs no
    // separate statement. There is no `SELECT *` anywhere: a column list that
    // drifted from the manifest must fail, not be copied blindly.
    const fresh = generateModuleMigration({ ...after, name: after.name });
    // A rebuild-scratch name a real module cannot claim: module names are
    // `^[a-z][a-z0-9-]*$`, so no generated table contains `__evolve__`.
    const temporary = `${plan.table}__evolve__r${plan.toRevision}`;
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
    // The copy is all-or-nothing by construction: the INSERT…SELECT has no
    // filter, so it either copies every row or violates a constraint and aborts
    // the migration's transaction, leaving the original table untouched. SQLite
    // never silently drops rows on insert.
    statements.push(`DROP TABLE ${plan.table};`);
    statements.push(`ALTER TABLE ${temporary} RENAME TO ${plan.table};`);
    for (const line of fresh.sql.split('\n').filter((line) => line.startsWith('CREATE INDEX'))) {
      statements.push(line);
    }
    // Outbound references are verified after the migration runs, by the
    // migration runner's `PRAGMA foreign_key_check` — one check that protects
    // every module migration rather than only this one.
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


/** The state-file contract version written by this runtime. */
export const MODULE_STATE_VERSION = 2;
/** v1 SQLite-only history remains readable; writes emit v2. */
export const SUPPORTED_MODULE_STATE_VERSIONS = Object.freeze([1, 2]);
export const LEGACY_MODULE_STATE_REQUIRED = 'LEGACY_MODULE_STATE_REQUIRED';
export const MODULE_POSTGRES_BOOTSTRAP_REQUIRED = 'MODULE_POSTGRES_BOOTSTRAP_REQUIRED';
export const POSTGRES_BOOTSTRAP_TARGET_NONEMPTY = 'POSTGRES_BOOTSTRAP_TARGET_NONEMPTY';
export const MODULE_POSTGRES_BOOTSTRAP_MISMATCH = 'MODULE_POSTGRES_BOOTSTRAP_MISMATCH';

function sqlChecksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

/**
 * The fingerprint of a module's *normalized* definition. Canonical, so a
 * reordered manifest with the same meaning produces the same value and a
 * meaningful edit never produces the same value.
 *
 * @param {any} manifest
 */
export function moduleStateFingerprint(manifest) {
  const normalized = validateModuleManifest(manifest);
  // Deliberately excludes `revision`: the fingerprint answers "is this the same
  // schema?", so a bumped revision over an unchanged schema is detectable as
  // exactly that rather than looking like a change.
  const canonical = JSON.stringify({
    name: normalized.name,
    table: normalized.table,
    fields: [...normalized.fields]
      .map((field) => ({
        name: field.name, type: field.type, column: field.column,
        required: field.required, unique: field.unique, writable: field.writable,
        ...(field.index ? { index: true } : {}),
        ...(field.default !== undefined ? { default: field.default } : {}),
        ...(field.values ? { values: [...field.values] } : {}),
        ...(field.references ? { references: field.references, onDelete: field.onDelete } : {}),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : 1)),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * PostgreSQL CREATE for the current manifest. Used only on an empty data plane;
 * it is not a replay of SQLite revision history.
 *
 * @param {any} manifest
 */
export function generatePostgresModuleBootstrap(manifest) {
  const normalized = validateModuleManifest(manifest);
  const columns = [
    { name: 'id', affinity: 'text', primaryKey: true },
    ...normalized.fields.map((field) => manifestFieldToColumn(field)),
    { name: 'created_at', affinity: 'timestamp', notNull: true },
    { name: 'updated_at', affinity: 'timestamp', notNull: true },
  ];
  /** @type {any[]} */
  const statements = [{ kind: 'createTable', name: normalized.table, columns }];
  for (const field of normalized.fields) {
    if (field.type === 'reference' || field.index === true) {
      statements.push({
        kind: 'createIndex',
        name: `${normalized.table}_${field.column}`,
        table: normalized.table,
        columns: [field.column],
      });
    }
  }
  const rendered = renderPostgresMigration(statements);
  return {
    module: normalized.name,
    table: normalized.table,
    name: `pg_bootstrap_${normalized.table}`,
    sql: rendered.sql,
    names: rendered.names,
  };
}

/**
 * Dialect-specific PostgreSQL evolution for a later revision. Never translated
 * from the SQLite migration string.
 *
 * @param {{previous: any, next: any, referencedBy?: string[]}} input
 */
export function generatePostgresModuleEvolution(input) {
  const plan = planModuleEvolution(input);
  const after = validateModuleManifest(input.next);
  if (plan.strategy === 'none' || plan.strategy === 'metadata') {
    return { ...plan, migrationName: null, sql: '' };
  }
  const migrationName = `pg_evolve_${plan.table}_r${plan.toRevision}`;
  /** @type {any[]} */
  const statements = [];
  for (const name of plan.addedFields) {
    const field = after.fields.find((entry) => entry.name === name);
    statements.push({ kind: 'addColumn', table: plan.table, column: manifestFieldToColumn(field) });
  }
  for (const name of plan.addedIndexes) {
    const field = after.fields.find((entry) => entry.name === name);
    statements.push({
      kind: 'createIndex',
      name: `${plan.table}_${field.column}`,
      table: plan.table,
      columns: [field.column],
    });
  }
  const rendered = statements.length > 0
    ? renderPostgresMigration(statements)
    : { sql: `CREATE SCHEMA IF NOT EXISTS ${quotePostgresIdent(POSTGRES_SCHEMA_NAME)};\n` };
  const tablePhysical = mapPhysicalName(plan.table).physical;
  const tableSql = qualifyPostgresIdent(POSTGRES_SCHEMA_NAME, tablePhysical);
  /** @type {string[]} */
  const enumSql = [];
  for (const widened of plan.widenedEnums) {
    const field = after.fields.find((entry) => entry.name === widened.field);
    const constraintPhysical = mapPhysicalName(`${plan.table}_${field.column}_check`).physical;
    const columnPhysical = mapPhysicalName(field.column).physical;
    const values = field.values.map((value) => `'${String(value).replaceAll("'", "''")}'`).join(', ');
    enumSql.push(
      `ALTER TABLE ${tableSql} DROP CONSTRAINT IF EXISTS ${quotePostgresIdent(constraintPhysical)};`,
      `ALTER TABLE ${tableSql} ADD CONSTRAINT ${quotePostgresIdent(constraintPhysical)} CHECK (${quotePostgresIdent(columnPhysical)} IN (${values}));`,
    );
  }
  const sql = enumSql.length > 0 ? `${rendered.sql}\n${enumSql.join('\n')}\n` : rendered.sql;
  return { ...plan, migrationName, sql };
}

function postgresBootstrapRecord(manifest, fingerprint) {
  const bootstrap = generatePostgresModuleBootstrap(manifest);
  return {
    name: bootstrap.name,
    checksum: sqlChecksum(bootstrap.sql),
    sql: bootstrap.sql,
    provenance: {
      kind: 'v1-state-fingerprint',
      fingerprint,
    },
  };
}

/**
 * Render the checked-in state file: the last generated definition, its
 * fingerprint, and every migration generated for this module in order.
 *
 * It is data only — no executable code, no absolute path, no environment.
 * v2 adds a PostgreSQL bootstrap; v1 `{name, checksum, sql}` history is
 * preserved byte-for-byte in `migrations`.
 *
 * @param {{
 *   manifest: any,
 *   migrations: {migrationName: string, sql: string}[],
 *   postgres?: {bootstrap?: any, evolutions?: any[]} | null,
 * }} input
 */
export function renderModuleState({ manifest, migrations, postgres = null }) {
  const normalized = validateModuleManifest(manifest);
  const fingerprint = moduleStateFingerprint(normalized);
  const sqliteMigrations = migrations.map((entry) => ({
    name: entry.migrationName,
    checksum: sqlChecksum(entry.sql),
    sql: entry.sql,
  }));
  const bootstrap = postgres?.bootstrap ?? postgresBootstrapRecord(normalized, fingerprint);
  const evolutions = postgres?.evolutions ?? [];
  const state = {
    stateVersion: MODULE_STATE_VERSION,
    module: normalized.name,
    revision: normalized.revision,
    fingerprint,
    manifest: normalized,
    // The complete, ordered SQLite migration history — SQL included. An applied
    // migration is never regenerated from a newer manifest: doing so would
    // change its checksum and break every database that already ran it.
    migrations: sqliteMigrations,
    postgres: {
      bootstrap,
      evolutions,
    },
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}

/**
 * Read a module's last generated definition, or `null` when the module has
 * never been generated.
 *
 * A state file that is malformed, or that disagrees with the definition it
 * claims to describe, is a hard failure: silently trusting a hand-edited state
 * file would let the next evolution be computed against a definition that was
 * never generated.
 *
 * @param {string} rootDir @param {string} moduleName
 */
export function readModuleState(rootDir, moduleName) {
  const path = join(rootDir, 'packages', 'modules', moduleName, 'module.state.json');
  // No state file has two very different meanings: the module was never
  // generated, or it was generated before this file existed. Only the first is
  // "nothing to evolve from".
  if (!existsSync(path)) return adoptModuleState(rootDir, moduleName);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new ValidationError(`Module "${moduleName}" has an unreadable module.state.json; restore it from version control`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError(`Module "${moduleName}": module.state.json must be a JSON object`);
  }
  if (!SUPPORTED_MODULE_STATE_VERSIONS.includes(parsed.stateVersion)) {
    throw new ValidationError(
      `Module "${moduleName}": module.state.json is stateVersion ${JSON.stringify(parsed.stateVersion)}; `
        + `this version of accordo reads ${SUPPORTED_MODULE_STATE_VERSIONS.join(', ')}`,
    );
  }
  if (parsed.module !== moduleName) {
    throw new ValidationError(
      `Module "${moduleName}": module.state.json describes "${String(parsed.module).slice(0, 64)}"`,
    );
  }
  const manifest = validateModuleManifest(parsed.manifest);
  const fingerprint = moduleStateFingerprint(manifest);
  if (fingerprint !== parsed.fingerprint) {
    throw new ValidationError(
      `Module "${moduleName}": module.state.json was edited by hand — its fingerprint does not match the definition it `
        + 'contains. Restore it from version control rather than editing it: the next evolution is computed from it.',
    );
  }
  if (manifest.revision !== parsed.revision) {
    throw new ValidationError(
      `Module "${moduleName}": module.state.json revision ${parsed.revision} disagrees with its manifest revision ${manifest.revision}`,
    );
  }
  const migrations = (parsed.migrations ?? []).map((entry) => {
    if (typeof entry?.name !== 'string' || typeof entry?.sql !== 'string') {
      throw new ValidationError(`Module "${moduleName}": module.state.json has a malformed migration entry`);
    }
    const checksum = sqlChecksum(entry.sql);
    if (checksum !== entry.checksum) {
      throw new ValidationError(
        `Module "${moduleName}": migration "${entry.name}" in module.state.json was edited — its checksum does not `
          + 'match its SQL. Applied migrations are immutable; restore the file from version control.',
      );
    }
    return { migrationName: entry.name, sql: entry.sql };
  });
  const postgres = parsed.stateVersion === 1 ? null : readPostgresState(moduleName, parsed, fingerprint);
  return {
    revision: manifest.revision,
    fingerprint,
    manifest,
    adopted: false,
    stateVersion: parsed.stateVersion,
    // The whole history, in order: index 0 is the create migration.
    migrations,
    postgres,
  };
}

/**
 * @param {string} moduleName
 * @param {any} parsed
 * @param {string} fingerprint
 */
function readPostgresState(moduleName, parsed, fingerprint) {
  const postgres = parsed.postgres;
  if (!postgres || typeof postgres !== 'object' || Array.isArray(postgres) || !postgres.bootstrap) {
    throw new ValidationError(
      `Module "${moduleName}": stateVersion 2 requires postgres.bootstrap`,
    );
  }
  const bootstrap = postgres.bootstrap;
  if (typeof bootstrap.name !== 'string' || typeof bootstrap.sql !== 'string' || typeof bootstrap.checksum !== 'string') {
    throw new ValidationError(`Module "${moduleName}": postgres.bootstrap is malformed`);
  }
  if (sqlChecksum(bootstrap.sql) !== bootstrap.checksum) {
    throw new ValidationError(
      `Module "${moduleName}": postgres.bootstrap was edited — its checksum does not match its SQL`,
    );
  }
  if (bootstrap.provenance?.kind !== 'v1-state-fingerprint' || typeof bootstrap.provenance?.fingerprint !== 'string') {
    throw new ValidationError(
      `Module "${moduleName}": postgres.bootstrap provenance must point at a v1 state fingerprint`,
    );
  }
  void fingerprint;
  const evolutions = Array.isArray(postgres.evolutions) ? postgres.evolutions.map((entry) => {
    if (typeof entry?.name !== 'string' || typeof entry?.sql !== 'string' || typeof entry?.checksum !== 'string') {
      throw new ValidationError(`Module "${moduleName}": postgres.evolutions has a malformed entry`);
    }
    if (sqlChecksum(entry.sql) !== entry.checksum) {
      throw new ValidationError(
        `Module "${moduleName}": postgres evolution "${entry.name}" was edited — its checksum does not match its SQL`,
      );
    }
    return { name: entry.name, sql: entry.sql, checksum: entry.checksum };
  }) : [];
  return { bootstrap, evolutions };
}

/**
 * **Adoption** — the upgrade path for a module generated *before* module
 * evolution existed, which therefore has a `module.manifest.json` and generated
 * source but no `module.state.json`.
 *
 * Without this, every module that shipped before ADR-019 was frozen: the
 * factory saw no previous state, planned every file as a `create`, and the
 * apply refused with "module files already exist". A project could never take
 * a newer revision of a manifest it already runs — which is precisely the
 * upgrade a framework must support.
 *
 * Adoption reconstructs revision 1 from what is on disk, and it is safe because
 * it verifies rather than assumes: the manifest is only accepted as the
 * previous definition if regenerating its create migration reproduces the
 * migration the module actually generated, name and every SQL line. The
 * checksum recorded in every existing database therefore stays valid.
 *
 * It refuses, rather than guessing, when:
 *
 *   - the manifest claims a revision above 1 — the migrations of revisions 2…
 *     cannot be reconstructed from the current manifest, so the state file was
 *     lost rather than never written, and version control is the answer;
 *   - `src/migration.js` is missing — what ran against existing databases is
 *     then unknown;
 *   - the regenerated create migration does not match the generated one — the
 *     manifest was edited without being applied, and computing the next
 *     evolution from it would diff against a definition no database ever ran.
 *
 * @param {string} rootDir @param {string} moduleName
 */
function adoptModuleState(rootDir, moduleName) {
  return adoptModuleStateFromDir(join(rootDir, 'packages', 'modules', moduleName), moduleName);
}

/**
 * Reconstruct revision-1 SQLite history from a generated module directory that
 * predates `module.state.json`. Does not write files.
 *
 * @param {string} moduleDir
 * @param {string} moduleName
 */
export function adoptModuleStateFromDir(moduleDir, moduleName) {
  const manifestPath = join(moduleDir, 'module.manifest.json');
  // Genuinely never generated: there is nothing to evolve from, and the caller
  // treats this as a first generation.
  if (!existsSync(manifestPath)) return null;

  let manifest;
  try {
    manifest = validateModuleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (error) {
    throw new ValidationError(
      `Module "${moduleName}" has no module.state.json, and its module.manifest.json cannot be read as the previous `
        + `definition: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (manifest.name !== moduleName) {
    throw new ValidationError(
      `Module "${moduleName}": module.manifest.json describes "${String(manifest.name).slice(0, 64)}"`,
    );
  }
  const revision = manifestRevision(manifest);
  if (revision !== 1) {
    throw new ValidationError(
      `Module "${moduleName}" is at revision ${revision} but has no module.state.json. Only revision 1 can be `
        + 'adopted: the migrations of the revisions after the first cannot be reconstructed from the current '
        + 'manifest. Restore module.state.json from version control.',
    );
  }

  const migrationPath = join(moduleDir, 'src', 'migration.js');
  if (!existsSync(migrationPath)) {
    throw new ValidationError(
      `Module "${moduleName}" has a module.manifest.json but no src/migration.js, so what it applied to existing `
        + 'databases is unknown. Restore the module from version control.',
    );
  }
  const create = generateModuleMigration(manifest);
  const source = readFileSync(migrationPath, 'utf8');
  // Every generated migration embeds its name as a quoted literal and each SQL
  // line as a JSON string — the same in every version of the template — so
  // containment is an exact check without parsing generated source.
  const nameFound = source.includes(`'${create.migrationName}'`) || source.includes(`"${create.migrationName}"`);
  const missing = create.sql.trimEnd().split('\n').filter((line) => !source.includes(JSON.stringify(line)));
  if (!nameFound || missing.length > 0) {
    throw new ValidationError(
      `Module "${moduleName}": module.manifest.json no longer describes the migration in src/migration.js, and there `
        + 'is no module.state.json to fall back on. The manifest was edited without being applied, so the previous '
        + 'definition is unknown and no evolution can be computed from it. Restore the manifest, or restore '
        + `module.state.json, from version control.${nameFound ? ` (${missing.length} SQL line(s) differ)` : ''}`,
    );
  }

  return {
    revision: 1,
    fingerprint: moduleStateFingerprint(manifest),
    manifest,
    // Says how this state was obtained: reconstructed from source, not read
    // from a checked-in state file. The apply writes the state file, so a
    // module is adopted at most once.
    adopted: true,
    stateVersion: 1,
    postgres: null,
    migrations: [{ migrationName: create.migrationName, sql: create.sql }],
  };
}

/**
 * Authoring adoption: reconstruct SQLite history and derive the PostgreSQL
 * bootstrap from the current normalized manifest. Runtime composition must
 * not call this; it writes nothing.
 *
 * @param {string} moduleDir
 * @param {string} moduleName
 */
export function adoptLegacyModuleState(moduleDir, moduleName) {
  const adopted = adoptModuleStateFromDir(moduleDir, moduleName);
  if (!adopted) return null;
  const postgres = {
    bootstrap: postgresBootstrapRecord(adopted.manifest, adopted.fingerprint),
    evolutions: [],
  };
  const document = JSON.parse(renderModuleState({
    manifest: adopted.manifest,
    migrations: adopted.migrations,
    postgres,
  }));
  return { ...adopted, stateVersion: MODULE_STATE_VERSION, postgres, document };
}

/**
 * Runtime PostgreSQL composition refuses a generated module that still has no
 * checked-in state. It never synthesizes or writes one.
 *
 * @param {{moduleName: string, stateFileExists: boolean, state?: any}} input
 */
export function requireAdoptedModuleStateForPostgres({ moduleName, stateFileExists, state }) {
  if (!stateFileExists) {
    throw new AppError(
      `PostgreSQL composition requires a checked-in module.state.json for "${moduleName}"`,
      { code: LEGACY_MODULE_STATE_REQUIRED, status: 500, details: { module: moduleName } },
    );
  }
  if (!state?.postgres?.bootstrap) {
    throw new AppError(
      `PostgreSQL composition requires a checked-in postgres bootstrap for "${moduleName}"`,
      { code: MODULE_POSTGRES_BOOTSTRAP_REQUIRED, status: 500, details: { module: moduleName } },
    );
  }
}

/**
 * @param {{tableNames?: string[]}} input
 */
export function assertPostgresBootstrapTargetEmpty({ tableNames = [] } = {}) {
  const occupied = tableNames.filter((name) => name !== 'schema_migrations' && name !== 'module_migrations');
  if (occupied.length > 0) {
    throw new AppError('PostgreSQL module bootstrap requires an empty data plane', {
      code: POSTGRES_BOOTSTRAP_TARGET_NONEMPTY,
      status: 500,
    });
  }
}

/**
 * A bootstrap checked in for the current manifest must be reproducible from it.
 * States with later dialect-specific evolutions compare after those append.
 *
 * @param {{manifest: any, postgres: {bootstrap: {sql: string}, evolutions?: any[]}}} state
 */
export function assertPostgresBootstrapMatchesManifest(state) {
  const evolutions = state.postgres?.evolutions ?? [];
  if (evolutions.length > 0) return;
  const expected = generatePostgresModuleBootstrap(state.manifest);
  if (expected.sql !== state.postgres.bootstrap.sql) {
    throw new AppError('PostgreSQL bootstrap does not match the current module manifest', {
      code: MODULE_POSTGRES_BOOTSTRAP_MISMATCH,
      status: 500,
      details: { module: state.manifest?.name },
    });
  }
}

/**
 * Which other installed generated modules hold a foreign key into this table.
 * A rebuild drops and recreates the table, so any inbound reference blocks it.
 *
 * @param {{manifest?: any, dirName: string}[]} installed @param {any} manifest
 */
export function inboundReferences(installed, manifest) {
  const out = [];
  for (const entry of installed) {
    if (!entry.manifest || entry.dirName === manifest.name) continue;
    for (const field of entry.manifest.fields ?? []) {
      if (field.type === 'reference' && field.references === manifest.table) {
        out.push(`${entry.dirName}.${field.name}`);
      }
    }
  }
  return out.sort();
}
