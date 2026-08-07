import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../packages/cli/bin/accordo.js', import.meta.url));
const partnerManifest = fileURLToPath(new URL('../examples/modules/partner.module.json', import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, ['--no-warnings', cliPath, ...args], { encoding: 'utf8' });
}

test('CLI validates the example partner manifest', () => {
  const result = runCli(['module', 'validate', partnerManifest]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.ok, true);
  assert.equal(output.manifest.name, 'partner');
  assert.equal(output.manifest.table, 'partners');
});

test('CLI reports manifest validation failures with a non-zero exit', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-manifest-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const badManifest = join(directory, 'bad.module.json');
  writeFileSync(badManifest, JSON.stringify({ name: 'partner', fields: [{ name: 'tier', type: 'enum' }] }));

  const result = runCli(['module:validate', badManifest]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /enum fields require a non-empty "values"/);
});

test('CLI migration generation is dry-run by default and writes only with --out', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const dryRun = runCli(['module', 'migration', partnerManifest, '--dry-run']);
  assert.equal(dryRun.status, 0, dryRun.stderr);
  const dryRunOutput = JSON.parse(dryRun.stdout);
  assert.equal(dryRunOutput.mode, 'dry-run');
  assert.match(dryRunOutput.sql, /CREATE TABLE IF NOT EXISTS partners/);
  assert.deepEqual(readdirSync(directory), []);

  const outPath = join(directory, 'create_partners.sql');
  const written = runCli(['module:migration', partnerManifest, '--out', outPath]);
  assert.equal(written.status, 0, written.stderr);
  assert.equal(JSON.parse(written.stdout).mode, 'written');
  assert.equal(readFileSync(outPath, 'utf8'), dryRunOutput.sql);

  const conflict = runCli(['module:migration', partnerManifest, '--out', outPath]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /pass --force to allow it/);

  const forced = runCli(['module:migration', partnerManifest, '--out', outPath, '--force']);
  assert.equal(forced.status, 0, forced.stderr);

  const explicitDryRun = runCli(['module:migration', partnerManifest, '--dry-run', '--out', join(directory, 'ignored.sql')]);
  assert.equal(explicitDryRun.status, 0, explicitDryRun.stderr);
  assert.equal(JSON.parse(explicitDryRun.stdout).mode, 'dry-run');
  assert.equal(existsSync(join(directory, 'ignored.sql')), false);
});

test('generated migration SQL is accepted by SQLite', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const migration = JSON.parse(runCli(['module', 'migration', partnerManifest]).stdout);
  const db = new DatabaseSync(':memory:');
  db.exec(migration.sql);
  const columns = db.prepare('PRAGMA table_info(partners)').all().map((row) => row.name);
  assert.deepEqual(columns, ['id', 'name', 'tier', 'territory', 'created_at', 'updated_at']);
  db.close();
});
