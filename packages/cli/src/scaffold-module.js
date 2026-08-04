// @ts-check

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ConflictError, ValidationError } from '../../core/src/errors.js';

/**
 * @param {{name: string, rootDir?: string, apply?: boolean}} input
 */
export function scaffoldModule(input) {
  const name = normalizeName(input.name);
  const className = toPascalCase(name);
  const rootDir = resolve(input.rootDir ?? process.cwd());
  const moduleDir = join(rootDir, 'packages', 'modules', name);
  const files = [
    {
      path: join(moduleDir, 'src', `${name}-service.js`),
      content: serviceTemplate(name, className),
    },
    {
      path: join(moduleDir, 'src', 'index.js'),
      content: indexTemplate(name, className),
    },
    {
      path: join(rootDir, 'tests', `${name}-module.test.js`),
      content: testTemplate(name, className),
    },
  ];

  const collisions = files.filter((file) => existsSync(file.path)).map((file) => file.path);
  if (collisions.length) {
    throw new ConflictError(`Module files already exist for ${name}`, { collisions });
  }

  if (input.apply === true) {
    for (const file of files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, 'utf8');
    }
  }

  return {
    name,
    className,
    mode: input.apply === true ? 'applied' : 'dry-run',
    files: files.map((file) => ({
      path: file.path,
      preview: file.content.split('\n').slice(0, 8).join('\n'),
    })),
    nextSteps: [
      'Add the table migration or declarative schema.',
      'Register the module in packages/app/src/create-app.js.',
      'Replace generated placeholders with domain validation and audit.',
      'Run npm run verify.',
    ],
  };
}

/** @param {string} value */
function normalizeName(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError('Module name is required');
  }
  const name = value.trim().toLowerCase().replace(/[_\s]+/g, '-');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new ValidationError('Module name must use lowercase letters, numbers and hyphens');
  }
  return name;
}

/** @param {string} value */
function toPascalCase(value) {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('');
}

function serviceTemplate(name, className) {
  return `// @ts-check

import { randomUUID } from 'node:crypto';
import { requiredString } from '../../../core/src/validation.js';
import { nowIso } from '../../../core/src/time.js';

export class ${className}Service {
  constructor({ database, audit, events }) {
    this.database = database;
    this.audit = audit;
    this.events = events;
  }

  async create(input, context = {}) {
    const entity = {
      id: randomUUID(),
      name: requiredString(input.name, 'name'),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    // TODO: persist through this module's table.
    // TODO: record ${name}.created in the audit log.
    // TODO: emit ${name}.created after the authoritative write.
    return entity;
  }
}
`;
}

function indexTemplate(name, className) {
  return `// @ts-check

import { ${className}Service } from './${name}-service.js';

export const ${camelCase(name)}ModuleDefinition = Object.freeze({
  name: '${name}',
  version: '0.1.0',
  description: 'TODO: describe the ${name} domain boundary.',
  entities: [{ name: '${name}', fields: ['id', 'name', 'createdAt', 'updatedAt'] }],
});

export function create${className}Module(dependencies) {
  const service = new ${className}Service(dependencies);
  return { ...${camelCase(name)}ModuleDefinition, service };
}

export { ${className}Service };
`;
}

function testTemplate(name, className) {
  return `import test from 'node:test';
import assert from 'node:assert/strict';
import { ${className}Service } from '../packages/modules/${name}/src/${name}-service.js';

test('${name} module exposes a service', () => {
  assert.equal(typeof ${className}Service, 'function');
});
`;
}

/** @param {string} value */
function camelCase(value) {
  const pascal = toPascalCase(value);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
