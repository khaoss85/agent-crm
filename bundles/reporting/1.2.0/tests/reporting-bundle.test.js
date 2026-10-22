// @ts-check
// Bundle installability proof for reporting@1.2.0 (BO-F5-01). Boots the real
// application WITH this bundle composed and proves its module migrates,
// registers and serves records with audit. If this file is red, the bundle
// does not install — no matter what any other document claims.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBundleEntries } from '../../../../packages/cli/src/bundle-manager.js';
import { createAccordoApp } from '../../../../packages/app/src/index.js';

test('bundle reporting@1.2.0 installs: migrates, registers and serves records', async (t) => {
  const rootDir = new URL('../../../..', import.meta.url).pathname;
  const entries = await createBundleEntries({ rootDir, bundles: [{ name: 'reporting', version: '1.2.0' }] });
  const app = createAccordoApp({ dbPath: ':memory:', bundles: entries });
  t.after(() => app.close());
  const actor = { type: 'human', id: 'test-user' };

  assert.ok(app.modules.list().some((module) => module.name === 'reporting'));
  const service = app.modules.get('reporting').service;

  const created = await service.create({
  metric: 'Example metric',
  period: 'Example period',
  value: 42,
  }, { actor });
  assert.ok(created.id);
  assert.deepEqual(service.get(created.id), created);
  assert.equal(service.list().length, 1);

  const auditActions = app.audit
    .list({ entityType: 'reporting' })
    .map((event) => event.action)
    .sort();
  assert.deepEqual(auditActions, ['reporting.created']);

  await assert.rejects(() => service.create({}, { actor }), /metric/);
});
