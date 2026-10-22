// @ts-check

/**
 * Backoffice BO-F4-01 Personalizzazione (backlog:7543aabbd901) — per-space
 * composition of packages and skills.
 *
 * What it must prove:
 * - activating a unit records the composition for the space (one
 *   `space-package` row per space+unit; replay is identical; spaces are
 *   isolated; deactivation marks removed and never deletes);
 * - "Prova" demonstrates a unit on a real case of the space and writes
 *   nothing (the preview names a seeded real row and the database is
 *   unchanged afterwards);
 * - the checked-in catalog drifts from neither the manifests on disk nor
 *   the skill frontmatter (every module-owning package and every shipped
 *   skill is covered; every listed module exists and is space-scoped).
 *
 * Real sqlite (`:memory:`), real manifest-built modules, real operations —
 * the same harness shape as the channels tests. No worker, no provider, no
 * secret: the kit boundary is never crossed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createDatabase } from '../packages/core/src/database.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import {
  SPACE_PACKAGE_CATALOG,
  compositionKeyFor,
  createSpacePackageOperations,
  lookupSpacePackageUnit,
} from '../packages/space-permissions/src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const SPACE_A = 'presti-group';
const SPACE_B = 'altro-spazio';
const USER = { type: 'user', id: 'owner-1' };

/** @param {string} pkg @param {string} name */
function loadManifest(pkg, name) {
  return JSON.parse(readFileSync(join(repoRoot, 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'));
}

function buildModules(manifests) {
  const database = createDatabase({ path: ':memory:' });
  for (const { sql } of recordModuleMigrations(manifests)) {
    database.raw.exec(sql);
  }
  const modules = new Map();
  for (const { name, manifest } of manifests) {
    const built = createRecordModuleFromManifest(manifest, {
      database, audit: { record: () => {} }, events: { emit: () => {}, publish: () => {} }, references: {},
    });
    modules.set(name, { service: built.service });
  }
  return { database, modules };
}

function spacePackageHarness() {
  const built = buildModules([
    { name: 'space-package', manifest: loadManifest('space-permissions', 'space-package') },
    { name: 'channel-connection', manifest: loadManifest('channels', 'channel-connection') },
  ]);
  const ops = createSpacePackageOperations({ modules: built.modules });
  return { ...built, ops };
}

/** Row counts of every table: the zero-writes proof snapshots this. */
function tableCounts(database) {
  const tables = database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
  return Object.fromEntries(
    tables.map((table) => [table, database.raw.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n]),
  );
}

async function seedConnection(modules, spaceId) {
  const service = modules.get('channel-connection').service;
  const row = await service.createManaged({
    sourceKey: `wa:${spaceId}:39206111`,
    spaceId,
    channel: 'whatsapp',
    account: '+39 206 111',
    adapter: 'fixture',
    adapterVersion: 1,
    adapterFingerprint: 'kit',
    status: 'active',
    statusReason: 'seeded',
    secretRef: 'vault://kit/wa',
    secretRotatedAt: new Date().toISOString(),
    grantExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    createdBy: 'user:owner-1',
  }, { actor: USER });
  return row;
}

test('activating a package records the composition for the space', async () => {
  const { modules, ops } = spacePackageHarness();
  const first = await ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  assert.equal(first.status, 'active');
  assert.equal(first.replayed, false);
  const rows = await modules.get('space-package').service.listWhere({ spaceId: SPACE_A });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].unit, 'channels');
  assert.equal(rows[0].kind, 'package');
  assert.equal(rows[0].status, 'active');
  assert.equal(rows[0].activatedBy, 'user:owner-1');
  assert.equal(rows[0].sourceKey, compositionKeyFor(SPACE_A, 'channels'));
});

test('repeating an activation replays the same row', async () => {
  const { modules, ops } = spacePackageHarness();
  const first = await ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  const second = await ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  assert.equal(second.replayed, true);
  assert.equal(second.id, first.id);
  const rows = await modules.get('space-package').service.listWhere({ spaceId: SPACE_A });
  assert.equal(rows.length, 1);
});

test('spaces stay isolated from each other', async () => {
  const { modules, ops } = spacePackageHarness();
  await ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  await ops.activate({ spaceId: SPACE_B, unit: 'channels', actor: USER });
  await ops.activate({ spaceId: SPACE_B, unit: 'skill:build-signature-order', actor: USER });
  const rowsA = await modules.get('space-package').service.listWhere({ spaceId: SPACE_A });
  const rowsB = await modules.get('space-package').service.listWhere({ spaceId: SPACE_B });
  assert.equal(rowsA.length, 1);
  assert.equal(rowsB.length, 2);
});

test('deactivation marks removed, never deletes; reactivation replays history', async () => {
  const { modules, ops } = spacePackageHarness();
  const first = await ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  const removed = await ops.deactivate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  assert.equal(removed.status, 'removed');
  const rows = await modules.get('space-package').service.listWhere({ spaceId: SPACE_A });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'removed');
  await assert.rejects(
    ops.deactivate({ spaceId: SPACE_A, unit: 'channels', actor: USER }),
    (error) => error.code === 'SPACE_PACKAGE_NOT_ACTIVE',
  );
  const back = await ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  assert.equal(back.reactivated, true);
  assert.equal(back.id, first.id);
});

test('unknown, malformed and anonymous activations are refused', async () => {
  const { ops } = spacePackageHarness();
  await assert.rejects(
    ops.activate({ spaceId: SPACE_A, unit: 'fax', actor: USER }),
    (error) => error.code === 'SPACE_PACKAGE_UNKNOWN',
  );
  await assert.rejects(
    ops.activate({ spaceId: SPACE_A, unit: '__proto__', actor: USER }),
    (error) => error.code === 'VALIDATION_FAILED' || /unit/i.test(error.message),
  );
  await assert.rejects(
    ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: null }),
    (error) => error.code === 'SPACE_ACTOR_REQUIRED',
  );
  await assert.rejects(
    ops.preview({ spaceId: SPACE_A, unit: 'fax' }),
    (error) => error.code === 'SPACE_PACKAGE_UNKNOWN',
  );
});

test('Prova shows a real case of the space and writes nothing', async () => {
  const { database, modules, ops } = spacePackageHarness();
  const seeded = await seedConnection(modules, SPACE_A);
  await ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  const before = tableCounts(database);
  const demo = await ops.preview({ spaceId: SPACE_A, unit: 'channels' });
  const after = tableCounts(database);
  assert.deepEqual(after, before);
  assert.equal(demo.writes, 0);
  assert.equal(demo.active, true);
  assert.ok(demo.realCase !== null);
  assert.equal(demo.realCase.module, 'channel-connection');
  assert.equal(demo.realCase.id, seeded.id);
  assert.ok(demo.counts.some((row) => row.module === 'channel-connection' && row.count === 1));
  assert.ok(demo.headline.includes('1 righe') || demo.headline.includes('1 riga'));
});

test('Prova of a unit with no rows says so and still writes nothing', async () => {
  const { database, ops } = spacePackageHarness();
  const before = tableCounts(database);
  const demo = await ops.preview({ spaceId: SPACE_B, unit: 'payments' });
  assert.deepEqual(tableCounts(database), before);
  assert.equal(demo.writes, 0);
  assert.equal(demo.active, false);
  assert.equal(demo.realCase, null);
});

test('Prova of a skill reports its contract and the active units', async () => {
  const { database, ops } = spacePackageHarness();
  await ops.activate({ spaceId: SPACE_A, unit: 'channels', actor: USER });
  const before = tableCounts(database);
  const demo = await ops.preview({ spaceId: SPACE_A, unit: 'skill:debug-crm-run' });
  assert.deepEqual(tableCounts(database), before);
  assert.equal(demo.writes, 0);
  assert.equal(demo.kind, 'skill');
  assert.equal(demo.requires.tier, 'any-project');
  assert.deepEqual(demo.activeUnits, ['channels']);
});

test('lookup resolves every catalog unit and refuses ghosts', () => {
  for (const entry of SPACE_PACKAGE_CATALOG) {
    assert.equal(lookupSpacePackageUnit(entry.name), entry);
  }
  assert.throws(() => lookupSpacePackageUnit('carrier-pigeon'), (error) => error.code === 'SPACE_PACKAGE_UNKNOWN');
});

test('catalog covers every module-owning package with real space-scoped modules', () => {
  const packageDirs = readdirSync(join(repoRoot, 'packages')).filter((name) => {
    const dir = join(repoRoot, 'packages', name, 'modules');
    try {
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  });
  const owning = packageDirs.filter((name) => {
    try {
      return readdirSync(join(repoRoot, 'packages', name, 'modules')).some((file) => file.endsWith('.module.json'));
    } catch {
      return false;
    }
  });
  const catalogPackages = SPACE_PACKAGE_CATALOG.filter((entry) => entry.kind === 'package').map((entry) => entry.name);
  assert.deepEqual([...catalogPackages].sort(), [...owning].sort());
  for (const entry of SPACE_PACKAGE_CATALOG.filter((unit) => unit.kind === 'package')) {
    for (const module of entry.modules) {
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', entry.name, 'modules', `${module}.module.json`), 'utf8'));
      assert.equal(manifest.name, module);
      assert.ok(
        manifest.fields.some((field) => field.name === 'spaceId'),
        `${entry.name}/${module} must be space-scoped: preview counts it per space`,
      );
    }
    if (entry.demo !== null) {
      assert.ok(entry.modules.includes(entry.demo), `${entry.name} demo must be one of its modules`);
    }
  }
});

test('catalog covers every shipped skill and repeats its frontmatter', () => {
  const skillDirs = readdirSync(join(repoRoot, '.claude/skills')).filter((name) => {
    try {
      return statSync(join(repoRoot, '.claude/skills', name)).isDirectory();
    } catch {
      return false;
    }
  });
  const catalogSkills = SPACE_PACKAGE_CATALOG.filter((entry) => entry.kind === 'skill').map((entry) => entry.name);
  assert.deepEqual([...catalogSkills].sort(), skillDirs.map((name) => `skill:${name}`).sort());
  for (const dir of skillDirs) {
    const frontmatter = readFileSync(join(repoRoot, '.claude/skills', dir, 'SKILL.md'), 'utf8')
      .match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
    const tier = frontmatter.match(/^\s*tier:\s*(\S+)/m)?.[1] ?? null;
    const command = frontmatter.match(/^\s*command:\s*"([^"]+)"/m)?.[1] ?? null;
    const degradesTo = frontmatter.match(/^\s*degradesTo:\s*"((?:[^"\\]|\\.)*)"/m)?.[1] ?? null;
    const entry = lookupSpacePackageUnit(`skill:${dir}`);
    assert.equal(entry.requires.tier, tier, `${dir} tier drifted from frontmatter`);
    assert.equal(entry.requires.command, command, `${dir} command drifted from frontmatter`);
    assert.equal(entry.degradesTo, degradesTo, `${dir} degradesTo drifted from frontmatter`);
    assert.ok(typeof entry.label === 'string' && entry.label !== '', `${dir} needs an Italian label`);
  }
});
