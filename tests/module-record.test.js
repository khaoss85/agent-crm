// @ts-check

/**
 * `npm run module:record -- <path>` prints the `RECORDED` line a new
 * manifest-selected module needs in
 * `tests/module-manifest-revision-guard.test.js`.
 *
 * - On a new valid module the printed line passes the guard: revision and
 *   sqlite/pg checksums computed with the guard's own functions.
 * - On an invalid manifest (e.g. a reserved field name) the script refuses
 *   with the same message the guard records.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateModuleMigration,
  validateModuleManifest,
} from '../packages/core/src/module-manifest.js';
import {
  generatePostgresModuleBootstrap,
  manifestRevision,
} from '../packages/core/src/module-evolution.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..');
const sha = (sql) => createHash('sha256').update(sql).digest('hex');

function runModuleRecord(args) {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/module-record.js', ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      exitCode: error.status ?? -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

function writeManifest(name, fields) {
  const dir = mkdtempSync(join(tmpdir(), 'module-record-'));
  const absolute = join(dir, `${name}.module.json`);
  writeFileSync(absolute, JSON.stringify({ manifestVersion: 1, name, fields }, null, 2));
  return absolute;
}

const VALID_FIELDS = [
  { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
  { name: 'note', type: 'string', writable: 'managed' },
];

test('module:record on a new module prints the RECORDED line that passes the guard', () => {
  const absolute = writeManifest('module-record-probe', VALID_FIELDS);
  const result = runModuleRecord([absolute]);
  assert.equal(result.exitCode, 0, `module:record failed: ${result.stderr}`);

  // The guard's own computation for this manifest.
  const normalized = validateModuleManifest(JSON.parse(JSON.stringify({
    manifestVersion: 1, name: 'module-record-probe', fields: VALID_FIELDS,
  })));
  const expected =
    `"module-record-probe": { revision: ${manifestRevision(normalized)}, ` +
    `sqlite: "${sha(generateModuleMigration(normalized).sql)}", ` +
    `pg: "${sha(generatePostgresModuleBootstrap(normalized).sql)}" },`;
  assert.equal(result.stdout.trim(), expected);

  // The printed line, read back as a RECORDED entry, passes the guard's
  // per-module checks: recorded revision matches, checksums match.
  const parsed = result.stdout.trim().match(
    /^"module-record-probe": \{ revision: (\d+), sqlite: "([0-9a-f]{64})", pg: "([0-9a-f]{64})" \},$/,
  );
  assert.ok(parsed, `unexpected RECORDED line format: ${result.stdout.trim()}`);
  assert.equal(Number(parsed[1]), manifestRevision(normalized));
  assert.equal(parsed[2], sha(generateModuleMigration(normalized).sql));
  assert.equal(parsed[3], sha(generatePostgresModuleBootstrap(normalized).sql));
});

test('module:record refuses a reserved field with the same message as the guard', () => {
  const absolute = writeManifest('module-record-reserved', [
    { name: 'id', type: 'string', writable: 'managed' },
  ]);
  const result = runModuleRecord([absolute]);
  assert.notEqual(result.exitCode, 0, 'module:record must refuse a reserved field name');

  // The guard records `${relative}: invalid manifest (<validator message>)`
  // for this manifest — the script must refuse with that same message.
  let validatorMessage;
  try {
    validateModuleManifest({ manifestVersion: 1, name: 'module-record-reserved', fields: [{ name: 'id', type: 'string', writable: 'managed' }] });
    validatorMessage = null;
  } catch (error) {
    validatorMessage = error instanceof Error ? error.message : String(error);
  }
  assert.ok(validatorMessage !== null, 'the fixture must be invalid');
  assert.equal(result.stderr.trim(), `${absolute}: invalid manifest (${validatorMessage})`);
});
