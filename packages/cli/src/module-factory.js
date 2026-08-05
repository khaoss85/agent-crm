// @ts-check

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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

/**
 * @param {{manifest: unknown, rootDir?: string}} input
 */
export function planModule(input) {
  const manifest = validateModuleManifest(input.manifest);
  const rootDir = resolve(input.rootDir ?? process.cwd());

  const referenceFields = manifest.fields.filter((field) => field.type === 'reference');
  if (referenceFields.length) {
    throw new ValidationError(
      `module create does not support reference fields yet (${referenceFields
        .map((field) => `"${field.name}"`)
        .join(', ')}). Generate the migration with module:migration and write the service by ` +
        'hand so cross-module integrity matches the core modules, or remove the reference fields.',
      { fields: referenceFields.map((field) => field.name) },
    );
  }

  const names = buildNames(manifest.name);
  const migration = generateModuleMigration(manifest);
  const moduleDir = join('packages', 'modules', manifest.name);

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
      content: serviceTemplate(manifest, names),
    },
    {
      path: join(moduleDir, 'src', 'index.js'),
      action: 'create',
      content: indexTemplate(manifest, names),
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
 * Generated modules are discovered from the module.manifest.json copy each one
 * carries; the registry file is always regenerated from that scan, sorted by
 * module name, so its content is a pure function of the modules on disk.
 *
 * @param {string} rootDir @param {string} [includeName]
 */
function collectGeneratedModuleNames(rootDir, includeName) {
  const modulesDir = resolve(rootDir, 'packages', 'modules');
  /** @type {Set<string>} */
  const names = new Set();
  if (existsSync(modulesDir)) {
    for (const entry of readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(modulesDir, entry.name, 'module.manifest.json'))) {
        names.add(entry.name);
      }
    }
  }
  if (includeName) names.add(includeName);
  return [...names].sort();
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
  return `// @ts-check
${header()}

export const ${names.camel}Migration = {
  name: '${migration.migrationName}',
  sql: \`
${migration.sql.trimEnd()}
\`,
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
    const values = (field.values ?? []).map((value) => `'${value.replaceAll("'", "\\'")}'`).join(', ');
    return `${validator}(${valueExpression}, [${values}], '${field.name}')`;
  }
  return `${validator}(${valueExpression}, '${field.name}')`;
}

/** @param {import('../../core/src/module-manifest.js').NormalizedModuleManifest} manifest */
function usedValidators(manifest) {
  const used = new Set();
  for (const field of manifest.fields) {
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
function serviceTemplate(manifest, names) {
  const entity = names.camel;
  const columns = ['id', ...manifest.fields.map((field) => field.column), 'created_at', 'updated_at'];
  const placeholders = columns.map(() => '?').join(', ');

  const createAssignments = manifest.fields
    .map((field) => `      ${field.name}: ${validatorCall(field, `input.${field.name}`)},`)
    .join('\n');
  const insertValues = [
    `      ${entity}.id,`,
    ...manifest.fields.map(
      (field) => `      ${toDbExpression(field, `${entity}.${field.name}`)},`,
    ),
    `      ${entity}.createdAt,`,
    `      ${entity}.updatedAt,`,
  ].join('\n');

  const updateBranches = manifest.fields
    .map((field) =>
      [
        `    if (Object.hasOwn(input, '${field.name}')) {`,
        `      const value = ${validatorCall(field, `input.${field.name}`)};`,
        `      assignments.push('${field.column} = ?');`,
        `      params.push(${toDbExpression(field, 'value')});`,
        `      changes.${field.name} = value;`,
        '    }',
      ].join('\n'),
    )
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
import { ConflictError, NotFoundError } from '../../../core/src/errors.js';
import {
  ${usedValidators(manifest).join(',\n  ')},
} from '../../../core/src/validation.js';
import { nowIso } from '../../../core/src/time.js';

export class ${names.pascal}Service {
  /** @param {{database: any, audit: any, events: any}} dependencies */
  constructor({ database, audit, events }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
  }

  /** @param {Record<string, unknown>} input @param {{actor?: unknown}} [context] */
  async create(input, context = {}) {
    const timestamp = nowIso();
    const ${entity} = {
      id: randomUUID(),
${createAssignments}
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    try {
      this.database.raw.prepare(\`
        INSERT INTO ${manifest.table}(${columns.join(', ')})
        VALUES (${placeholders})
      \`).run(
${insertValues}
      );
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('${conflictMessage}');
      }
      throw error;
    }

    this.audit.record({
      actor: context.actor,
      action: '${manifest.name}.created',
      entityType: '${manifest.name}',
      entityId: ${entity}.id,
      data: ${entity},
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
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    return this.database.raw.prepare(\`
      SELECT * FROM ${manifest.table} ORDER BY created_at DESC LIMIT ?
    \`).all(limit).map(map${names.pascal}Row);
  }

  /** @param {string} id @param {Record<string, unknown>} input @param {{actor?: unknown}} [context] */
  async update(id, input, context = {}) {
    this.get(id);
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

    try {
      this.database.raw.prepare(
        \`UPDATE ${manifest.table} SET \${assignments.join(', ')} WHERE id = ?\`,
      ).run(...params);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new ConflictError('${conflictMessage}');
      }
      throw error;
    }

    const updated = this.get(id);
    this.audit.record({
      actor: context.actor,
      action: '${manifest.name}.updated',
      entityType: '${manifest.name}',
      entityId: id,
      data: changes,
    });
    await this.events.emit('${manifest.name}.updated', updated);
    return updated;
  }
}

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
function indexTemplate(manifest, names) {
  const fieldNames = ['id', ...manifest.fields.map((field) => field.name), 'createdAt', 'updatedAt'];
  return `// @ts-check
${header()}

import { ${names.pascal}Service } from './${manifest.name}-service.js';

export const ${names.camel}ModuleDefinition = Object.freeze({
  name: '${manifest.name}',
  version: '0.1.0',
  description: ${JSON.stringify(manifest.description ?? `Generated ${manifest.name} module.`)},
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
      return `'${(field.values ?? [''])[0]}'`;
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
      return `'${(field.values ?? ['']).at(-1)}'`;
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
