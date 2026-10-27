// @ts-check

// BO-F6-01 (backlog:de14afde): the sidebar lists opt-in bundles but never
// kernel tables. The schema marks where each generated module came from, so
// the shell can filter client-side without a hardcoded name list that rots.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createAdminShellMount } from '../packages/app/src/admin-mount.js';

// One opt-in user bundle beside the kernel: the smallest shape the bundle
// contract accepts (definition + create migration), proving installability
// by booting and serving the schema — never a stubbed install.
const probeBundle = {
  name: 'sonde-kpi',
  createModule: () => ({
    name: 'sonde-kpi',
    description: 'Probe bundle: KPI sondes for the pilot.',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['list'],
    fields: [{ name: 'label', type: 'string', required: true, unique: false }],
    service: { list: async () => [] },
  }),
  migrations: [{
    name: 'create_sonde_kpi',
    sql: 'CREATE TABLE IF NOT EXISTS sonde_kpi (\n'
      + "  id TEXT PRIMARY KEY,\n"
      + "  label TEXT NOT NULL,\n"
      + "  created_at TEXT NOT NULL,\n"
      + "  updated_at TEXT NOT NULL\n"
      + ') STRICT;',
  }],
};

function readApp() {
  return createAccordoApp({ dbPath: ':memory:', bundles: [probeBundle] });
}

async function getSchema() {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const answer = await mount.handle({ method: 'GET', path: '/bo/api/schema', headers: {} });
    assert.equal(answer.status, 200);
    return JSON.parse(typeof answer.body === 'string' ? answer.body : answer.body.toString('utf8'));
  } finally {
    app.close();
  }
}

test('schema marks the bundle origin; kernel tables stay kernel', async () => {
  const body = await getSchema();
  const modules = body.generatedModules;
  assert.ok(Array.isArray(modules) && modules.length > 1, 'kernel tables plus the probe bundle');

  const byName = new Map(modules.map((module) => [module.name, module]));
  const probe = byName.get('sonde-kpi');
  assert.ok(probe, 'the probe bundle is exposed');
  assert.equal(probe.origin, 'bundle');

  // Every framework table the kernel ships is marked kernel — spot-check
  // the inbox, import and quality tables the sidebar must never list.
  for (const name of ['channel-inbox-event', 'channel-import-state', 'data-quality-issue', 'duplicate-candidate']) {
    const table = byName.get(name);
    assert.ok(table, `kernel table ${name} is exposed`);
    assert.equal(table.origin, 'kernel', `${name} is marked kernel`);
  }
  for (const module of modules) {
    assert.ok(module.origin === 'bundle' || module.origin === 'kernel', `${module.name} carries an origin`);
  }
});

test('the application remembers its bundle names', async () => {
  const app = readApp();
  try {
    assert.deepEqual(app.customModuleNames, ['sonde-kpi']);
  } finally {
    app.close();
  }
  const bare = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.deepEqual(bare.customModuleNames, []);
  } finally {
    bare.close();
  }
});
