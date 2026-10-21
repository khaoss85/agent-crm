// @ts-check

/**
 * `npm run module:record -- <path/to/*.module.json>`
 *
 * Prints the `RECORDED` line a new manifest-selected module needs in
 * `tests/module-manifest-revision-guard.test.js`. The revision and the
 * sqlite/pg migration checksums are computed with the exact functions the
 * guard uses (`validateModuleManifest`, `manifestRevision`,
 * `generateModuleMigration`, `generatePostgresModuleBootstrap`), so a pasted
 * line passes the guard.
 *
 * An invalid manifest is refused with the same message the guard records
 * (`<path>: invalid manifest (...)`), exit code 1 — including reserved
 * field names (`id`, `createdAt`, `updatedAt`, generated automatically).
 *
 * Usage:
 *   npm run module:record -- packages/<pkg>/modules/<name>.module.json
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  generateModuleMigration,
  validateModuleManifest,
} from '../packages/core/src/module-manifest.js';
import {
  generatePostgresModuleBootstrap,
  manifestRevision,
} from '../packages/core/src/module-evolution.js';

const sha = (sql) => createHash('sha256').update(sql).digest('hex');

const target = process.argv[2];
if (target === undefined || target === '') {
  console.error('usage: npm run module:record -- <path/to/*.module.json>');
  process.exit(2);
}

let raw;
try {
  raw = readFileSync(target, 'utf8');
} catch (error) {
  console.error(`${target}: cannot be read (${error instanceof Error ? error.message : String(error)})`);
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch (error) {
  console.error(`${target}: cannot be read as JSON (${error instanceof Error ? error.message : String(error)})`);
  process.exit(1);
}

let normalized;
try {
  normalized = validateModuleManifest(manifest);
} catch (error) {
  console.error(`${target}: invalid manifest (${error instanceof Error ? error.message : String(error)})`);
  process.exit(1);
}

const revision = manifestRevision(normalized);
const sqlite = sha(generateModuleMigration(normalized).sql);
const pg = sha(generatePostgresModuleBootstrap(normalized).sql);
console.log(`  "${normalized.name}": { revision: ${revision}, sqlite: "${sqlite}", pg: "${pg}" },`);
