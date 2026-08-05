// @ts-check

import { ValidationError } from './errors.js';

/**
 * Declarative CRM module manifest: validation and deterministic migration generation.
 *
 * A manifest describes one module entity. Every generated table also gets the
 * framework columns `id`, `created_at` and `updated_at`; those names are
 * reserved. Field names are camelCase and map to snake_case columns.
 * See docs/MODULE_MANIFEST.md for the full schema.
 */

export const MANIFEST_FIELD_TYPES = Object.freeze([
  'string',
  'email',
  'integer',
  'boolean',
  'timestamp',
  'enum',
  'reference',
]);

export const REFERENCE_ON_DELETE = Object.freeze(['restrict', 'cascade', 'set_null']);

export const SUPPORTED_MANIFEST_VERSION = 1;

const RESERVED_FIELD_NAMES = Object.freeze(['id', 'createdAt', 'created_at', 'updatedAt', 'updated_at']);

// Generated identifiers are intentionally unquoted, so they must not be SQLite
// keywords (https://sqlite.org/lang_keywords.html).
const SQLITE_KEYWORDS = new Set(
  (
    'abort action add after all alter always analyze and as asc attach autoincrement before begin ' +
    'between by cascade case cast check collate column commit conflict constraint create cross ' +
    'current current_date current_time current_timestamp database default deferrable deferred delete ' +
    'desc detach distinct do drop each else end escape except exclude exclusive exists explain fail ' +
    'filter first following for foreign from full generated glob group groups having if ignore ' +
    'immediate in index indexed initially inner insert instead intersect into is isnull join key ' +
    'last left like limit materialized natural no not nothing notnull null nulls of offset on or ' +
    'order others outer over partition plan pragma preceding primary query raise range recursive ' +
    'references regexp reindex release rename replace restrict returning right rollback row rows ' +
    'savepoint select set table temp temporary then ties to transaction trigger unbounded union ' +
    'unique update using vacuum values view virtual when where window with without'
  ).split(' '),
);

const MODULE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const FIELD_NAME_PATTERN = /^[a-z][a-zA-Z0-9]*$/;
const TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * @typedef {{
 *   name: string,
 *   type: string,
 *   required: boolean,
 *   unique: boolean,
 *   column: string,
 *   values?: string[],
 *   references?: string,
 *   onDelete?: string,
 * }} NormalizedManifestField
 *
 * @typedef {{
 *   manifestVersion: number,
 *   name: string,
 *   description: string | null,
 *   table: string,
 *   fields: NormalizedManifestField[],
 * }} NormalizedModuleManifest
 */

/**
 * Validate a module manifest and return its normalized, frozen form.
 * Aggregates every problem into one ValidationError instead of failing on the first.
 *
 * @param {unknown} manifest
 * @returns {NormalizedModuleManifest}
 */
export function validateModuleManifest(manifest) {
  /** @type {string[]} */
  const errors = [];

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ValidationError('Module manifest must be a JSON object', { errors: ['manifest must be an object'] });
  }

  const input = /** @type {Record<string, unknown>} */ (manifest);

  for (const key of Object.keys(input)) {
    if (!['manifestVersion', 'name', 'description', 'table', 'fields'].includes(key)) {
      errors.push(`unknown manifest property "${key}" (allowed: manifestVersion, name, description, table, fields)`);
    }
  }

  if (input.manifestVersion !== undefined && input.manifestVersion !== SUPPORTED_MANIFEST_VERSION) {
    throw new ValidationError(
      `Unsupported manifestVersion: ${JSON.stringify(input.manifestVersion)}. This version of agent-crm supports manifest version ${SUPPORTED_MANIFEST_VERSION}; upgrade agent-crm or lower the manifest version.`,
      { manifestVersion: input.manifestVersion, supported: SUPPORTED_MANIFEST_VERSION },
    );
  }

  let name = '';
  if (typeof input.name !== 'string' || !MODULE_NAME_PATTERN.test(input.name)) {
    errors.push('name is required and must match ^[a-z][a-z0-9-]*$ (example: "partner")');
  } else {
    name = input.name;
  }

  let description = null;
  if (input.description !== undefined && input.description !== null) {
    if (typeof input.description !== 'string') {
      errors.push('description must be a string when present');
    } else {
      description = input.description.trim() || null;
    }
  }

  let table = name ? pluralizeTableName(name) : '';
  if (input.table !== undefined) {
    if (typeof input.table !== 'string' || !TABLE_NAME_PATTERN.test(input.table)) {
      errors.push('table must match ^[a-z][a-z0-9_]*$ when present');
      table = '';
    } else {
      table = input.table;
    }
  }
  if (table && SQLITE_KEYWORDS.has(table)) {
    errors.push(
      input.table !== undefined
        ? `table "${table}" is a SQLite keyword; choose a different table name`
        : `default table name "${table}" (derived from "${name}") is a SQLite keyword; set an explicit non-keyword "table"`,
    );
  }

  /** @type {NormalizedManifestField[]} */
  const fields = [];
  if (!Array.isArray(input.fields) || input.fields.length === 0) {
    errors.push('fields is required and must be a non-empty array');
  } else {
    const seen = new Set();
    input.fields.forEach((rawField, index) => {
      const field = normalizeField(rawField, index, errors);
      if (!field) return;
      if (seen.has(field.name)) {
        errors.push(`fields[${index}] "${field.name}": duplicate field name`);
        return;
      }
      seen.add(field.name);
      fields.push(field);
    });
  }

  if (errors.length) {
    throw new ValidationError(
      `Invalid module manifest${name ? ` "${name}"` : ''}:\n- ${errors.join('\n- ')}`,
      { errors },
    );
  }

  return Object.freeze({
    manifestVersion: SUPPORTED_MANIFEST_VERSION,
    name,
    description,
    table,
    fields: Object.freeze(fields.map((field) => Object.freeze(field))),
  });
}

/**
 * @param {unknown} rawField
 * @param {number} index
 * @param {string[]} errors
 * @returns {NormalizedManifestField | null}
 */
function normalizeField(rawField, index, errors) {
  if (rawField === null || typeof rawField !== 'object' || Array.isArray(rawField)) {
    errors.push(`fields[${index}] must be an object`);
    return null;
  }
  const field = /** @type {Record<string, unknown>} */ (rawField);
  const label = typeof field.name === 'string' ? `fields[${index}] "${field.name}"` : `fields[${index}]`;

  for (const key of Object.keys(field)) {
    if (!['name', 'type', 'required', 'unique', 'values', 'references', 'onDelete', 'column', 'writable', 'default'].includes(key)) {
      errors.push(`${label}: unknown property "${key}"`);
    }
  }

  let valid = true;
  let column = '';

  if (typeof field.name !== 'string' || !FIELD_NAME_PATTERN.test(field.name)) {
    errors.push(`fields[${index}]: field name is required and must be camelCase matching ^[a-z][a-zA-Z0-9]*$`);
    valid = false;
  } else if (RESERVED_FIELD_NAMES.includes(field.name)) {
    errors.push(`${label}: "${field.name}" is reserved; id, createdAt and updatedAt are generated automatically`);
    valid = false;
  } else {
    column = toSnakeCase(field.name);
    if (SQLITE_KEYWORDS.has(column)) {
      errors.push(`${label}: column "${column}" would be a SQLite keyword; rename the field`);
      valid = false;
    }
  }

  // "column" appears in normalized manifests; accept it so validation is
  // idempotent, but never let it diverge from the derived column name.
  if (field.column !== undefined && column && field.column !== column) {
    errors.push(`${label}: "column" is derived from the field name (expected "${column}"); remove or correct it`);
    valid = false;
  }

  if (typeof field.type !== 'string' || !MANIFEST_FIELD_TYPES.includes(field.type)) {
    errors.push(`${label}: type must be one of: ${MANIFEST_FIELD_TYPES.join(', ')}`);
    valid = false;
  }

  for (const flag of ['required', 'unique']) {
    if (field[flag] !== undefined && typeof field[flag] !== 'boolean') {
      errors.push(`${label}: ${flag} must be a boolean when present`);
      valid = false;
    }
  }

  /** @type {string[] | undefined} */
  let values;
  if (field.type === 'enum') {
    if (
      !Array.isArray(field.values) ||
      field.values.length === 0 ||
      field.values.some((value) => typeof value !== 'string' || value === '')
    ) {
      errors.push(`${label}: enum fields require a non-empty "values" array of strings`);
      valid = false;
    } else if (new Set(field.values).size !== field.values.length) {
      errors.push(`${label}: enum values must be unique`);
      valid = false;
    } else {
      values = /** @type {string[]} */ (field.values.slice());
    }
  } else if (field.values !== undefined) {
    errors.push(`${label}: "values" is only allowed on enum fields`);
    valid = false;
  }

  /** @type {string | undefined} */
  let references;
  /** @type {string | undefined} */
  let onDelete;
  if (field.type === 'reference') {
    if (typeof field.references !== 'string' || !TABLE_NAME_PATTERN.test(field.references)) {
      errors.push(`${label}: reference fields require "references" naming the target table (example: "companies")`);
      valid = false;
    } else if (SQLITE_KEYWORDS.has(field.references)) {
      errors.push(`${label}: references target "${field.references}" is a SQLite keyword`);
      valid = false;
    } else {
      references = field.references;
    }
    if (field.onDelete !== undefined) {
      if (typeof field.onDelete !== 'string' || !REFERENCE_ON_DELETE.includes(field.onDelete)) {
        errors.push(`${label}: onDelete must be one of: ${REFERENCE_ON_DELETE.join(', ')}`);
        valid = false;
      } else {
        onDelete = field.onDelete;
      }
    } else {
      onDelete = 'restrict';
    }
    if (field.onDelete === 'set_null' && field.required === true) {
      errors.push(`${label}: onDelete "set_null" conflicts with required: true`);
      valid = false;
    }
  } else if (field.references !== undefined || field.onDelete !== undefined) {
    errors.push(`${label}: "references" and "onDelete" are only allowed on reference fields`);
    valid = false;
  }

  // Field write policy (Milestone 6): 'public' (default) or 'managed'. A managed
  // field can only be set by an action through the service's applyManaged path,
  // never by public create/update.
  let writable = 'public';
  if (field.writable !== undefined) {
    if (field.writable !== 'public' && field.writable !== 'managed') {
      errors.push(`${label}: writable must be "public" or "managed"`);
      valid = false;
    } else {
      writable = field.writable;
    }
  }
  if (field.type === 'reference' && writable === 'managed') {
    errors.push(`${label}: reference fields cannot be managed`);
    valid = false;
  }

  // Optional default value, used to initialise the field on create (mainly for
  // managed fields, e.g. a status enum defaulting to "new").
  let defaultValue;
  if (field.default !== undefined) {
    if (field.type === 'enum') {
      if (typeof field.default !== 'string' || !(Array.isArray(field.values) ? field.values : []).includes(field.default)) {
        errors.push(`${label}: default must be one of the enum values`);
        valid = false;
      } else {
        defaultValue = field.default;
      }
    } else if (field.type === 'string') {
      if (typeof field.default !== 'string') {
        errors.push(`${label}: default must be a string`);
        valid = false;
      } else {
        defaultValue = field.default;
      }
    } else {
      errors.push(`${label}: default is only supported on string and enum fields`);
      valid = false;
    }
  }

  if (!valid) return null;

  return {
    name: /** @type {string} */ (field.name),
    type: /** @type {string} */ (field.type),
    required: field.required === true,
    unique: field.unique === true,
    column: toSnakeCase(/** @type {string} */ (field.name)),
    writable,
    ...(defaultValue !== undefined ? { default: defaultValue } : {}),
    ...(values ? { values } : {}),
    ...(references ? { references, onDelete } : {}),
  };
}

/**
 * Generate deterministic SQLite migration SQL for a manifest.
 * Pure function: the same manifest always produces byte-identical output.
 *
 * @param {unknown} manifest — raw or already-normalized manifest
 * @returns {{module: string, table: string, migrationName: string, sql: string}}
 */
export function generateModuleMigration(manifest) {
  const normalized = validateModuleManifest(manifest);
  const columns = [
    '  id TEXT PRIMARY KEY',
    ...normalized.fields.map((field) => `  ${columnDefinition(field)}`),
    '  created_at TEXT NOT NULL',
    '  updated_at TEXT NOT NULL',
  ];

  const indexes = normalized.fields
    .filter((field) => field.type === 'reference')
    .map(
      (field) =>
        `CREATE INDEX IF NOT EXISTS ${normalized.table}_${field.column} ON ${normalized.table}(${field.column});`,
    );

  const sql = [
    `CREATE TABLE IF NOT EXISTS ${normalized.table} (`,
    columns.join(',\n'),
    ') STRICT;',
    ...indexes,
    '',
  ].join('\n');

  return {
    module: normalized.name,
    table: normalized.table,
    migrationName: `create_${normalized.table}`,
    sql,
  };
}

/** @param {NormalizedManifestField} field */
function columnDefinition(field) {
  const parts = [field.column];
  switch (field.type) {
    case 'integer':
      parts.push('INTEGER');
      break;
    case 'boolean':
      parts.push('INTEGER');
      break;
    default:
      parts.push('TEXT');
  }
  if (field.required) parts.push('NOT NULL');
  if (field.unique) parts.push('UNIQUE');
  if (field.type === 'boolean') {
    parts.push(`CHECK(${field.column} IN (0, 1))`);
  }
  if (field.type === 'enum' && field.values) {
    parts.push(`CHECK(${field.column} IN (${field.values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ')}))`);
  }
  if (field.type === 'reference' && field.references) {
    parts.push(`REFERENCES ${field.references}(id) ON DELETE ${sqlOnDelete(field.onDelete ?? 'restrict')}`);
  }
  return parts.join(' ');
}

/** @param {string} onDelete */
function sqlOnDelete(onDelete) {
  if (onDelete === 'cascade') return 'CASCADE';
  if (onDelete === 'set_null') return 'SET NULL';
  return 'RESTRICT';
}

/**
 * Documented naive plural used for default table names: trailing consonant+y
 * becomes "ies", otherwise append "s". Hyphens become underscores.
 * @param {string} moduleName
 */
export function pluralizeTableName(moduleName) {
  const base = moduleName.replaceAll('-', '_');
  if (/[^aeiou]y$/.test(base)) return `${base.slice(0, -1)}ies`;
  if (/s$/.test(base)) return `${base}es`;
  return `${base}s`;
}

/** @param {string} value */
function toSnakeCase(value) {
  return value.replaceAll(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
