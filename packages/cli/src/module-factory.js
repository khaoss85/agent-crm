// @ts-check

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { ConflictError, ValidationError } from '../../core/src/errors.js';
import {
  validateModuleManifest,
  generateModuleMigration,
} from '../../core/src/module-manifest.js';

/**
 * Module factory: turn a validated manifest into a complete runnable module —
 * migration, service, module definition, registry entry and tests.
 *
 * planModule() is pure and read-only apart from reading existing manifests for
 * the registry; applyModulePlan() stages every write and rolls back on failure,
 * so no partial project mutation survives an error.
 */

const REGISTRY_RELATIVE_PATH = join('packages', 'modules', 'generated', 'index.js');

// Tables owned by the core schema (packages/core/src/database.js) plus the
// framework's own bookkeeping tables. Generated modules must not claim them:
// their CREATE TABLE IF NOT EXISTS would silently no-op against the existing
// table and the module would run on the wrong schema.
const CORE_TABLES = new Set([
  'companies',
  'contacts',
  'opportunities',
  'approvals',
  'workflow_runs',
  'trace_spans',
  'audit_events',
  'schema_migrations',
  'module_migrations',
]);

/**
 * @param {{manifest: unknown, rootDir?: string}} input
 */
export function planModule(input) {
  const manifest = validateModuleManifest(input.manifest);
  const rootDir = resolve(input.rootDir ?? process.cwd());

  const names = buildNames(manifest.name);
  const migration = generateModuleMigration(manifest);
  const moduleDir = join('packages', 'modules', manifest.name);

  if (manifest.name === 'generated') {
    throw new ValidationError('"generated" is reserved for the module registry; choose another module name');
  }
  const existingModules = scanExistingModules(rootDir);

  // Resolve every reference field's target table to an installed generated
  // module (or this module itself, for a self-reference), before any write.
  const referenceFields = manifest.fields.filter((field) => field.type === 'reference');
  /** @type {Record<string, {targetModule: string, targetTable: string, targetDisplayField: string, required: boolean}>} */
  const referenceTargets = {};
  for (const field of referenceFields) {
    const targetTable = field.references;
    if (CORE_TABLES.has(targetTable)) {
      throw new ValidationError(
        `reference field "${field.name}" targets core table "${targetTable}"; generated-to-core references are not supported in this milestone (a future explicit adapter is required)`,
        { field: field.name, targetTable },
      );
    }
    // A required self-reference is unsatisfiable: the first record could never
    // be created because its required target must already exist. Reject it
    // (an optional self-reference is fine — the first record leaves it null).
    if (targetTable === manifest.table && field.required === true) {
      throw new ValidationError(
        `reference field "${field.name}" is a required self-reference to "${targetTable}"; the first record could never be created. Make it optional (remove "required": true), since nested/deferred writes are out of scope.`,
        { field: field.name, targetTable },
      );
    }
    const target =
      targetTable === manifest.table
        ? { dirName: manifest.name, kind: 'generated', manifest }
        : existingModules.find((entry) => entry.kind === 'generated' && entry.manifest?.table === targetTable);
    if (!target) {
      throw new ValidationError(
        `reference field "${field.name}" targets table "${targetTable}", but no installed generated module uses it; apply the target module first`,
        { field: field.name, targetTable },
      );
    }
    referenceTargets[field.name] = {
      targetModule: target.dirName,
      targetTable,
      targetDisplayField: displayFieldFor(target.manifest),
      required: field.required === true,
    };
  }
  for (const existing of existingModules) {
    const sameName = existing.dirName.toLowerCase() === manifest.name.toLowerCase();
    if (sameName && existing.kind === 'handwritten') {
      throw new ConflictError(
        `A non-generated module named "${existing.dirName}" already exists; the factory will not shadow core or handwritten modules`,
      );
    }
    if (sameName && existing.dirName !== manifest.name) {
      throw new ConflictError(
        `Module name "${manifest.name}" collides case-insensitively with existing module "${existing.dirName}" (breaks case-insensitive filesystems)`,
      );
    }
    if (existing.manifest && existing.manifest.table === manifest.table && existing.dirName !== manifest.name) {
      throw new ConflictError(
        `Table "${manifest.table}" is already used by generated module "${existing.dirName}"`,
      );
    }
  }
  if (CORE_TABLES.has(manifest.table)) {
    throw new ConflictError(
      `Table "${manifest.table}" is a core framework table; choose another module name or an explicit "table"`,
    );
  }

  const files = [
    {
      path: join(moduleDir, 'module.manifest.json'),
      action: 'create',
      content: `${JSON.stringify(manifest, null, 2)}\n`,
    },
    {
      path: join(moduleDir, 'src', 'migration.js'),
      action: 'create',
      content: migrationTemplate(names, migration),
    },
    {
      path: join(moduleDir, 'src', `${manifest.name}-service.js`),
      action: 'create',
      content: serviceTemplate(manifest, names, referenceTargets),
    },
    {
      path: join(moduleDir, 'src', 'index.js'),
      action: 'create',
      content: indexTemplate(manifest, names, referenceTargets),
    },
    {
      path: join('tests', `${manifest.name}-module.test.js`),
      action: 'create',
      content: testTemplate(manifest, names),
    },
    {
      path: REGISTRY_RELATIVE_PATH,
      action: 'modify',
      content: registryTemplate(collectGeneratedModuleNames(rootDir, manifest.name)),
    },
  ];

  for (const file of files) {
    const target = resolve(rootDir, file.path);
    if (relative(rootDir, target).startsWith('..') || !target.startsWith(rootDir + sep)) {
      throw new ValidationError(`Refusing to plan a write outside the project root: ${file.path}`);
    }
  }

  return {
    module: manifest.name,
    table: manifest.table,
    migrationName: migration.migrationName,
    // Reference dependencies are surfaced in the plan (which strips file
    // contents) so an agent/user sees each relationship before applying.
    references: manifest.fields
      .filter((field) => field.type === 'reference')
      .map((field) => ({
        field: field.name,
        column: field.column,
        targetModule: referenceTargets[field.name].targetModule,
        targetTable: referenceTargets[field.name].targetTable,
        targetKey: 'id',
        required: field.required === true,
        onDelete: 'restrict',
      })),
    rootDir,
    files: files.map((file) => ({
      path: file.path,
      action: file.action,
      exists: existsSync(resolve(rootDir, file.path)),
      bytes: Buffer.byteLength(file.content, 'utf8'),
      contentSha256: createHash('sha256').update(file.content).digest('hex'),
      preview: file.content.split('\n').slice(0, 6).join('\n'),
      content: file.content,
    })),
  };
}

/**
 * Apply a plan atomically: refuse collisions, stage temp files, rename all,
 * and undo everything (including the registry) if any step fails.
 *
 * @param {ReturnType<typeof planModule>} plan
 */
export function applyModulePlan(plan) {
  // Beyond the lexical check in planModule, resolve symlinks: the nearest
  // existing ancestor of every target must really live under the project root.
  const realRoot = realpathSync(plan.rootDir);
  for (const file of plan.files) {
    let ancestor = dirname(resolve(plan.rootDir, file.path));
    while (!existsSync(ancestor)) ancestor = dirname(ancestor);
    const realAncestor = realpathSync(ancestor);
    if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + sep)) {
      throw new ValidationError(
        `Refusing to write ${file.path}: its directory resolves outside the project root (symlink?)`,
      );
    }
  }

  const collisions = plan.files
    .filter((file) => file.action === 'create' && existsSync(resolve(plan.rootDir, file.path)))
    .map((file) => file.path);
  if (collisions.length) {
    throw new ConflictError(
      `Module files already exist for ${plan.module}; refusing to overwrite`,
      { collisions },
    );
  }

  const registryPath = resolve(plan.rootDir, REGISTRY_RELATIVE_PATH);
  const registryOriginal = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null;

  /** @type {string[]} */
  const tempPaths = [];
  /** @type {string[]} */
  const createdPaths = [];
  /** @type {string[]} */
  const createdDirs = [];
  try {
    for (const file of plan.files) {
      const target = resolve(plan.rootDir, file.path);
      const newDirRoot = firstMissingAncestor(dirname(target), plan.rootDir);
      mkdirSync(dirname(target), { recursive: true });
      if (newDirRoot) createdDirs.push(newDirRoot);
      const temp = `${target}.tmp-agent-crm`;
      writeFileSync(temp, file.content, 'utf8');
      tempPaths.push(temp);
    }
    for (const file of plan.files) {
      const target = resolve(plan.rootDir, file.path);
      renameSync(`${target}.tmp-agent-crm`, target);
      if (file.action === 'create') createdPaths.push(target);
    }
  } catch (error) {
    for (const temp of tempPaths) rmSync(temp, { force: true });
    for (const created of createdPaths) rmSync(created, { force: true });
    for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
    if (registryOriginal !== null) writeFileSync(registryPath, registryOriginal, 'utf8');
    throw error;
  }

  return {
    module: plan.module,
    table: plan.table,
    migrationName: plan.migrationName,
    files: plan.files.map(({ content: _content, ...file }) => file),
  };
}

/**
 * Topmost ancestor of `directory` (inside `rootDir`) that does not exist yet —
 * the directory mkdirSync will create first, and rollback must remove.
 *
 * @param {string} directory @param {string} rootDir
 */
function firstMissingAncestor(directory, rootDir) {
  /** @type {string | null} */
  let missing = null;
  let current = directory;
  while (current.startsWith(rootDir + sep) && !existsSync(current)) {
    missing = current;
    current = dirname(current);
  }
  return missing;
}

/**
 * Every module directory under packages/modules, classified as generated
 * (carries a module.manifest.json, which is read and validated — a malformed
 * one fails loudly here instead of producing a registry that breaks app boot)
 * or handwritten (core modules; no manifest copy).
 *
 * @param {string} rootDir
 * @returns {Array<{dirName: string, kind: 'generated' | 'handwritten', manifest: import('../../core/src/module-manifest.js').NormalizedModuleManifest | null}>}
 */
function scanExistingModules(rootDir) {
  const modulesDir = resolve(rootDir, 'packages', 'modules');
  /** @type {Array<{dirName: string, kind: 'generated' | 'handwritten', manifest: any}>} */
  const results = [];
  if (!existsSync(modulesDir)) return results;
  for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'generated') continue;
    const manifestPath = join(modulesDir, entry.name, 'module.manifest.json');
    if (!existsSync(manifestPath)) {
      results.push({ dirName: entry.name, kind: 'handwritten', manifest: null });
      continue;
    }
    let manifest;
    try {
      manifest = validateModuleManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    } catch (error) {
      throw new ValidationError(
        `Existing generated module "${entry.name}" has an invalid module.manifest.json; fix or remove it before generating new modules`,
        { module: entry.name, cause: error instanceof Error ? error.message : String(error) },
      );
    }
    if (manifest.name !== entry.name) {
      throw new ValidationError(
        `Existing generated module directory "${entry.name}" contains a manifest named "${manifest.name}"; directory and manifest names must match`,
      );
    }
    results.push({ dirName: entry.name, kind: 'generated', manifest });
  }
  return results;
}

/**
 * Registry content is a pure function of the generated modules on disk plus
 * the module being planned, sorted by name.
 *
 * @param {string} rootDir @param {string} [includeName]
 */
function collectGeneratedModuleNames(rootDir, includeName) {
  /** @type {Set<string>} */
  const names = new Set(
    scanExistingModules(rootDir)
      .filter((entry) => entry.kind === 'generated')
      .map((entry) => entry.dirName),
  );
  if (includeName) names.add(includeName);
  return [...names].sort();
}

/** @param {string} moduleName */
function sanitizeSavepoint(moduleName) {
  return moduleName.replaceAll('-', '_');
}

/**
 * Deterministic display field for a target manifest: first required string,
 * else first string, else 'id'. Matches the Admin displayTitle convention.
 * @param {import('../../core/src/module-manifest.js').NormalizedModuleManifest} manifest
 */
function displayFieldFor(manifest) {
  const fields = manifest?.fields ?? [];
  const requiredString = fields.find((field) => field.type === 'string' && field.required);
  if (requiredString) return requiredString.name;
  const anyString = fields.find((field) => field.type === 'string');
  if (anyString) return anyString.name;
  return 'id';
}

/** @param {string} moduleName */
function buildNames(moduleName) {
  const pascal = moduleName
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
  const camel = pascal.charAt(0).toLowerCase() + pascal.slice(1);
  return { module: moduleName, pascal, camel };
}

function header() {
  return [
    '// Generated by the agent-crm module factory from module.manifest.json.',
    '// This file is yours: edit it freely. Re-running module:create for the same',
    '// module refuses to overwrite existing files.',
  ].join('\n');
}

/**
 * @param {ReturnType<typeof buildNames>} names
 * @param {{migrationName: string, sql: string}} migration
 */
function migrationTemplate(names, migration) {
  // The SQL is embedded via JSON.stringify, never raw template interpolation:
  // manifest-controlled strings (enum values) must not be able to break out of
  // the generated source.
  const lines = migration.sql.trimEnd().split('\n');
  const serialized = lines.map((line, index) => {
    const suffix = index === lines.length - 1 ? '' : " + '\\n' +";
    return `  ${JSON.stringify(line)}${suffix}`;
  });
  return `// @ts-check
${header()}

export const ${names.camel}Migration = {
  name: '${migration.migrationName}',
  sql:
${serialized.join('\n')},
};
`;
}

/** @type {Record<string, {required: string, optional: string}>} */
const VALIDATORS = {
  string: { required: 'requiredString', optional: 'optionalString' },
  email: { required: 'requiredEmail', optional: 'optionalEmail' },
  integer: { required: 'requiredInteger', optional: 'optionalInteger' },
  boolean: { required: 'requiredBoolean', optional: 'optionalBoolean' },
  timestamp: { required: 'requiredIsoDate', optional: 'optionalIsoDate' },
  enum: { required: 'enumValue', optional: 'optionalEnum' },
};

/** @param {import('../../core/src/module-manifest.js').NormalizedManifestField} field */
function validatorCall(field, valueExpression) {
  const validator = VALIDATORS[field.type][field.required ? 'required' : 'optional'];
  if (field.type === 'enum') {
    // JSON.stringify, not quote-escaping: enum values are manifest-controlled
    // free text and must not be able to break out of the generated source.
    const values = (field.values ?? []).map((value) => JSON.stringify(value)).join(', ');
    return `${validator}(${valueExpression}, [${values}], '${field.name}')`;
  }
  return `${validator}(${valueExpression}, '${field.name}')`;
}

/** @param {import('../../core/src/module-manifest.js').NormalizedModuleManifest} manifest */
function usedValidators(manifest) {
  const used = new Set();
  for (const field of manifest.fields) {
    if (field.type === 'reference') continue; // validated via #reference, not an imported validator
    if (field.writable === 'managed') {
      // applyManaged validates managed fields with the "required" variant
      // (null-clearing is handled separately before validation).
      used.add(VALIDATORS[field.type].required);
      continue;
    }
    used.add(VALIDATORS[field.type][field.required ? 'required' : 'optional']);
  }
  return [...used].sort();
}

/** @param {import('../../core/src/module-manifest.js').NormalizedManifestField} field */
function toDbExpression(field, valueExpression) {
  if (field.type === 'boolean') {
    return `${valueExpression} === null ? null : ${valueExpression} ? 1 : 0`;
  }
  return valueExpression;
}

/**
 * @param {import('../../core/src/module-manifest.js').NormalizedModuleManifest} manifest
 * @param {ReturnType<typeof buildNames>} names
 */
function serviceTemplate(manifest, names, referenceTargets = {}) {
  const entity = names.camel;
  const columns = ['id', ...manifest.fields.map((field) => field.column), 'created_at', 'updated_at'];
  const placeholders = columns.map(() => '?').join(', ');
  const hasReferences = manifest.fields.some((field) => field.type === 'reference');
  const managedFields = manifest.fields.filter((field) => field.writable === 'managed');
  const publicFields = manifest.fields.filter((field) => field.writable !== 'managed');
  const hasManaged = managedFields.length > 0;
  const needsValidationError = hasReferences || hasManaged;

  /** For a field, the expression that validates the raw input value. */
  const valueExpr = (field, valueExpression) => {
    if (field.type === 'reference') {
      const target = referenceTargets[field.name];
      return `this.#reference('${field.name}', ${JSON.stringify(target.targetTable)}, ${field.required === true}, ${valueExpression})`;
    }
    return validatorCall(field, valueExpression);
  };

  // On create, managed fields take their default (or null), never input.
  const createAssignments = manifest.fields
    .map((field) => {
      if (field.writable === 'managed') {
        return `      ${field.name}: ${field.default !== undefined ? JSON.stringify(field.default) : 'null'},`;
      }
      return `      ${field.name}: ${valueExpr(field, `input.${field.name}`)},`;
    })
    .join('\n');
  const insertValues = [
    `      ${entity}.id,`,
    ...manifest.fields.map(
      (field) => `      ${toDbExpression(field, `${entity}.${field.name}`)},`,
    ),
    `      ${entity}.createdAt,`,
    `      ${entity}.updatedAt,`,
  ].join('\n');

  // Public update only touches public fields; managed fields go through applyManaged.
  const updateBranches = publicFields
    .map((field) =>
      [
        `    if (Object.hasOwn(input, '${field.name}')) {`,
        `      const value = ${valueExpr(field, `input.${field.name}`)};`,
        `      assignments.push('${field.column} = ?');`,
        `      params.push(${toDbExpression(field, 'value')});`,
        `      changes.${field.name} = value;`,
        '    }',
      ].join('\n'),
    )
    .join('\n');

  const managedNames = managedFields.map((field) => `'${field.name}'`).join(', ');
  // applyManaged branches: validate each managed field; null clears it.
  const managedBranches = managedFields
    .map((field) => {
      const validator = field.type === 'enum'
        ? `enumValue(patch.${field.name}, [${(field.values ?? []).map((v) => JSON.stringify(v)).join(', ')}], '${field.name}')`
        : `${VALIDATORS[field.type].required}(patch.${field.name}, '${field.name}')`;
      return [
        `      if (Object.hasOwn(patch, '${field.name}')) {`,
        `        const value = patch.${field.name} === null ? null : ${validator};`,
        `        assignments.push('${field.column} = ?');`,
        `        params.push(${toDbExpression(field, 'value')});`,
        `        changes.${field.name} = value;`,
        '      }',
      ].join('\n');
    })
    .join('\n');

  const rowMappings = manifest.fields
    .map((field) => {
      if (field.type === 'boolean') {
        return `    ${field.name}: row.${field.column} === null ? null : row.${field.column} === 1,`;
      }
      return `    ${field.name}: row.${field.column},`;
    })
    .join('\n');

  const uniqueFields = manifest.fields.filter((field) => field.unique);
  const conflictMessage = uniqueFields.length
    ? `A ${manifest.name} with the same ${uniqueFields.map((field) => field.name).join(' or ')} already exists`
    : `A ${manifest.name} violates a unique constraint`;

  return `// @ts-check
${header()}

import { randomUUID } from 'node:crypto';
import { ${needsValidationError ? 'ConflictError, NotFoundError, ValidationError' : 'ConflictError, NotFoundError'} } from '../../../core/src/errors.js';
${usedValidators(manifest).length ? `import {\n  ${usedValidators(manifest).join(',\n  ')},\n} from '../../../core/src/validation.js';\n` : ''}import { nowIso } from '../../../core/src/time.js';

export class ${names.pascal}Service {
  /** @param {{database: any, audit: any, events: any, references?: any}} dependencies */
  constructor({ database, audit, events, references }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
    this.references = references;
  }
${hasReferences ? `
  /**
   * Validate a reference value through the application reference resolver
   * (never a direct cross-module SQL query). Returns the validated id, or null
   * for an omitted/cleared optional reference. A bad target throws a
   * ValidationError before any write, so no audit or event is produced.
   * @param {string} field @param {string} targetTable @param {boolean} required @param {unknown} value
   */
  #reference(field, targetTable, required, value) {
    if (value === undefined || value === null || value === '') {
      if (required) throw new ValidationError(field + ' is required', { field });
      return null;
    }
    if (!this.references || typeof this.references.assertTarget !== 'function') {
      throw new ValidationError(field + ' cannot be validated: no reference resolver', { field });
    }
    return this.references.assertTarget(targetTable, value, field);
  }
` : ''}
  /**
   * Runs the data write and its audit record in one atomic unit. SAVEPOINT is
   * used instead of BEGIN so the service stays safe inside an enclosing
   * workflow transaction.
   * @template T
   * @param {() => T} fn
   */
  #mutation(fn) {
    this.database.raw.exec("SAVEPOINT ${sanitizeSavepoint(manifest.name)}_mutation;");
    try {
      const result = fn();
      this.database.raw.exec("RELEASE SAVEPOINT ${sanitizeSavepoint(manifest.name)}_mutation;");
      return result;
    } catch (error) {
      this.database.raw.exec("ROLLBACK TO SAVEPOINT ${sanitizeSavepoint(manifest.name)}_mutation;");
      this.database.raw.exec("RELEASE SAVEPOINT ${sanitizeSavepoint(manifest.name)}_mutation;");
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('${conflictMessage}');
      }
      throw error;
    }
  }

  /** @param {Record<string, unknown>} input @param {{actor?: unknown}} [context] */
  async create(input, context = {}) {
${hasManaged ? `    this.#rejectManagedInput(input);\n` : ''}    const timestamp = nowIso();
    const ${entity} = {
      id: randomUUID(),
${createAssignments}
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.#mutation(() => {
      this.database.raw.prepare(\`
        INSERT INTO ${manifest.table}(${columns.join(', ')})
        VALUES (${placeholders})
      \`).run(
${insertValues}
      );
      this.audit.record({
        actor: context.actor,
        action: '${manifest.name}.created',
        entityType: '${manifest.name}',
        entityId: ${entity}.id,
        data: ${entity},
      });
    });
    await this.events.emit('${manifest.name}.created', ${entity});
    return ${entity};
  }

  /** @param {string} id */
  get(id) {
    const row = this.database.raw.prepare('SELECT * FROM ${manifest.table} WHERE id = ?').get(id);
    if (!row) throw new NotFoundError('${names.pascal}', id);
    return map${names.pascal}Row(row);
  }

  /** @param {{limit?: number}} [filters] */
  list(filters = {}) {
    const requested = Number.isInteger(filters.limit) ? /** @type {number} */ (filters.limit) : 100;
    const limit = Math.min(Math.max(requested, 1), 500);
    return this.database.raw.prepare(\`
      SELECT * FROM ${manifest.table} ORDER BY created_at DESC, id LIMIT ?
    \`).all(limit).map(map${names.pascal}Row);
  }

  /** @param {string} id @param {Record<string, unknown>} input @param {{actor?: unknown}} [context] */
  async update(id, input, context = {}) {
${hasManaged ? `    this.#rejectManagedInput(input);\n` : ''}    this.get(id);
    /** @type {string[]} */
    const assignments = [];
    /** @type {unknown[]} */
    const params = [];
    /** @type {Record<string, unknown>} */
    const changes = {};

${updateBranches}

    if (!assignments.length) return this.get(id);
    assignments.push('updated_at = ?');
    params.push(nowIso());
    params.push(id);

    const updated = this.#mutation(() => {
      this.database.raw.prepare(
        \`UPDATE ${manifest.table} SET \${assignments.join(', ')} WHERE id = ?\`,
      ).run(...params);
      const current = this.get(id);
      this.audit.record({
        actor: context.actor,
        action: '${manifest.name}.updated',
        entityType: '${manifest.name}',
        entityId: id,
        data: changes,
      });
      return current;
    });
    await this.events.emit('${manifest.name}.updated', updated);
    return updated;
  }
${hasManaged ? `
  // Workflow-managed fields (${managedFields.map((f) => f.name).join(', ')}) are never
  // settable through public create/update — only through this internal path,
  // used by action execute() via ctx.managed. Not exposed over HTTP.
  #rejectManagedInput(input) {
    for (const name of [${managedNames}]) {
      if (input && Object.hasOwn(input, name)) {
        throw new ValidationError(name + ' is managed by a workflow action and cannot be set directly', { field: name });
      }
    }
  }

  /** @param {string} id @param {Record<string, unknown>} patch @param {{actor?: unknown}} [context] */
  async applyManaged(id, patch, context = {}) {
    this.get(id);
    /** @type {string[]} */
    const assignments = [];
    /** @type {unknown[]} */
    const params = [];
    /** @type {Record<string, unknown>} */
    const changes = {};

${managedBranches}

    if (!assignments.length) return this.get(id);
    assignments.push('updated_at = ?');
    params.push(nowIso());
    params.push(id);

    const updated = this.#mutation(() => {
      this.database.raw.prepare(
        \`UPDATE ${manifest.table} SET \${assignments.join(', ')} WHERE id = ?\`,
      ).run(...params);
      const current = this.get(id);
      this.audit.record({
        actor: context.actor,
        action: '${manifest.name}.updated',
        entityType: '${manifest.name}',
        entityId: id,
        data: changes,
      });
      return current;
    });
    await this.events.emit('${manifest.name}.updated', updated);
    return updated;
  }
` : ''}}

/** @param {any} row */
function map${names.pascal}Row(row) {
  return {
    id: row.id,
${rowMappings}
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
`;
}

/**
 * @param {import('../../core/src/module-manifest.js').NormalizedModuleManifest} manifest
 * @param {ReturnType<typeof buildNames>} names
 */
function indexTemplate(manifest, names, referenceTargets = {}) {
  const fieldNames = ['id', ...manifest.fields.map((field) => field.name), 'createdAt', 'updatedAt'];
  const fieldMetadata = manifest.fields.map((field) => {
    if (field.type === 'reference') {
      const target = referenceTargets[field.name];
      return {
        name: field.name,
        type: 'reference',
        required: field.required,
        unique: field.unique,
        writable: field.writable ?? 'public',
        references: target.targetTable,
        targetModule: target.targetModule,
        targetKey: 'id',
        targetDisplayField: target.targetDisplayField,
        targetKind: 'generated',
      };
    }
    return {
      name: field.name,
      type: field.type,
      required: field.required,
      unique: field.unique,
      // Write policy exposed to clients: 'managed' fields are set only by
      // workflow actions, never through public create/update, so the Admin
      // renders them read-only rather than as editable inputs.
      writable: field.writable ?? 'public',
      ...(field.values ? { values: field.values } : {}),
    };
  });
  const fieldMetadataLines = fieldMetadata
    .map((field) => `    ${JSON.stringify(field)},`)
    .join('\n');
  const references = manifest.fields
    .filter((field) => field.type === 'reference')
    .map((field) => ({
      field: field.name,
      column: field.column,
      targetModule: referenceTargets[field.name].targetModule,
      targetTable: referenceTargets[field.name].targetTable,
      required: field.required === true,
    }));
  return `// @ts-check
${header()}

import { ${names.pascal}Service } from './${manifest.name}-service.js';

export const ${names.camel}ModuleDefinition = Object.freeze({
  name: '${manifest.name}',
  version: '0.1.0',
  description: ${JSON.stringify(manifest.description ?? `Generated ${manifest.name} module.`)},
  // The static contract that exposes this module through the generic
  // /api/modules surface and client.module('${manifest.name}') (ADR-008).
  kind: 'generated',
  manifestVersion: ${manifest.manifestVersion},
  table: ${JSON.stringify(manifest.table)},
  capabilities: Object.freeze(['create', 'get', 'list', 'update']),
  fields: Object.freeze([
${fieldMetadataLines}
  ]),
  references: Object.freeze(${JSON.stringify(references)}),
  immutableFields: Object.freeze(['id', 'createdAt', 'updatedAt']),
  entities: [
    {
      name: '${manifest.name}',
      fields: [${fieldNames.map((name) => `'${name}'`).join(', ')}],
    },
  ],
});

/** @param {{database: any, audit: any, events: any}} dependencies */
export function create${names.pascal}Module(dependencies) {
  const service = new ${names.pascal}Service(dependencies);
  return { ...${names.camel}ModuleDefinition, service };
}

export { ${names.pascal}Service };
`;
}

/**
 * @param {import('../../core/src/module-manifest.js').NormalizedModuleManifest} manifest
 * @param {ReturnType<typeof buildNames>} names
 */
function testTemplate(manifest, names) {
  const referenceField = manifest.fields.find((field) => field.type === 'reference');
  if (referenceField) {
    // A module with references can't be created without valid target ids, which
    // this self-contained test can't synthesize generically. It proves the
    // module is registered/migrated and that a missing target is rejected; the
    // full CRUD-with-references path is covered by the reference e2e test.
    const firstRequired = manifest.fields.find((field) => field.required);
    return `${header()}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCrmApp } from '../packages/app/src/index.js';

test('${manifest.name} module is registered and validates references', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const actor = { type: 'human', id: 'test-user' };

  assert.ok(app.modules.list().some((module) => module.name === '${manifest.name}'));
  const service = app.modules.get('${manifest.name}').service;

  // A non-existent reference target is rejected with a field validation error,
  // and no record, audit or event is produced.
  await assert.rejects(
    () => service.create({ ${manifest.fields.filter((f) => f.required).map((f) => `${f.name}: ${f.type === 'reference' ? "'missing-id'" : exampleValue(f)}`).join(', ')} }, { actor }),
    /${referenceField.name}/,
  );
  assert.equal(service.list().length, 0);
  assert.equal(app.audit.list({ entityType: '${manifest.name}' }).length, 0);
${firstRequired ? `
  await assert.rejects(() => service.create({}, { actor }), /${firstRequired.name}/);` : ''}
});
`;
  }

  const requiredExamples = manifest.fields
    .filter((field) => field.required)
    .map((field) => `  ${field.name}: ${exampleValue(field)},`)
    .join('\n');
  const firstRequired = manifest.fields.find((field) => field.required);
  const firstField = manifest.fields[0];
  const updateField = manifest.fields.find((field) => field.type === 'string') ?? firstField;

  return `${header()}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCrmApp } from '../packages/app/src/index.js';

test('${manifest.name} module is registered, migrated and supports CRUD with audit', async (t) => {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const actor = { type: 'human', id: 'test-user' };

  assert.ok(app.modules.list().some((module) => module.name === '${manifest.name}'));
  const service = app.modules.get('${manifest.name}').service;

  const created = await service.create({
${requiredExamples}
  }, { actor });
  assert.ok(created.id);
  assert.deepEqual(service.get(created.id), created);
  assert.equal(service.list().length, 1);

  const updated = await service.update(created.id, { ${updateField.name}: ${exampleUpdateValue(updateField)} }, { actor });
  assert.equal(updated.${updateField.name}, ${exampleUpdateValue(updateField)});

  const auditActions = app.audit
    .list({ entityType: '${manifest.name}' })
    .map((event) => event.action)
    .sort();
  assert.deepEqual(auditActions, ['${manifest.name}.created', '${manifest.name}.updated']);
${firstRequired ? `
  await assert.rejects(() => service.create({}, { actor }), /${firstRequired.name}/);` : ''}
});
`;
}

/** @param {import('../../core/src/module-manifest.js').NormalizedManifestField} field */
function exampleValue(field) {
  switch (field.type) {
    case 'email':
      return "'someone@example.com'";
    case 'integer':
      return '42';
    case 'boolean':
      return 'true';
    case 'timestamp':
      return "'2026-01-01T00:00:00.000Z'";
    case 'enum':
      return JSON.stringify((field.values ?? [''])[0]);
    default:
      return `'Example ${field.name}'`;
  }
}

/** @param {import('../../core/src/module-manifest.js').NormalizedManifestField} field */
function exampleUpdateValue(field) {
  switch (field.type) {
    case 'email':
      return "'updated@example.com'";
    case 'integer':
      return '43';
    case 'boolean':
      return 'false';
    case 'timestamp':
      return "'2026-02-02T00:00:00.000Z'";
    case 'enum':
      return JSON.stringify((field.values ?? ['']).at(-1));
    default:
      return `'Updated ${field.name}'`;
  }
}

/** @param {string[]} moduleNames */
function registryTemplate(moduleNames) {
  if (!moduleNames.length) {
    return `// @ts-check
// Registry of manifest-generated modules. Managed by \`agent-crm module:create --apply\`,
// which regenerates this file from the module.manifest.json each generated module carries.
// You can edit it by hand, but the next apply rewrites it from the manifests on disk.

/** @type {Array<{name: string, createModule: (deps: {database: any, audit: any, events: any}) => any, migration: {name: string, sql: string}}>} */
export const generatedModules = [];
`;
  }
  const names = moduleNames.map(buildNames);
  const imports = names
    .flatMap((name) => [
      `import { create${name.pascal}Module } from '../${name.module}/src/index.js';`,
      `import { ${name.camel}Migration } from '../${name.module}/src/migration.js';`,
    ])
    .join('\n');
  const entries = names
    .map(
      (name) =>
        `  { name: '${name.module}', createModule: create${name.pascal}Module, migration: ${name.camel}Migration },`,
    )
    .join('\n');
  return `// @ts-check
// Registry of manifest-generated modules. Managed by \`agent-crm module:create --apply\`,
// which regenerates this file from the module.manifest.json each generated module carries.
// You can edit it by hand, but the next apply rewrites it from the manifests on disk.

${imports}

/** @type {Array<{name: string, createModule: (deps: {database: any, audit: any, events: any}) => any, migration: {name: string, sql: string}}>} */
export const generatedModules = [
${entries}
];
`;
}
