// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startPortableSqliteApp } from '../packages/app/src/portable-app.js';
import {
  createDefinitionVersionStore,
  isDefinitionVersionDrift,
} from '../packages/core/index.js';
import { ValidationError } from '../packages/core/src/errors.js';

/**
 * Workspace-scoped definition drift (backlog 4170bcf43e5b).
 *
 * On 2026-10-22 a single workspace's `catalog-provider "<name>@1"` drift
 * reached a shared worker as a bare `ValidationError`, which the host could
 * not tell apart from any other startup failure; the composition escaped as
 * an unhandled exception and the process restarted, taking every healthy
 * workspace with it. The composition now names the drift after the workspace
 * (`workspace unavailable <id> DEFINITION_VERSION_DRIFT`) so a host composing
 * several workspaces in one process refuses one and keeps serving the rest.
 */

const probePackage = (fingerprint) => ({
  packageContract: 2,
  name: 'drift-probe',
  version: 1,
  label: 'drift-probe',
  actions: [],
  operations: [],
  capabilities: [],
  persistFingerprints(database) {
    createDefinitionVersionStore(database).persist([{
      type: 'catalog-provider',
      name: 'probe-catalog',
      version: 1,
      fingerprint,
    }]);
  },
});

const selected = (fingerprint) => ({
  packageContract: 2,
  packages: [probePackage(fingerprint)],
  actions: [],
  modules: [],
});

const V1 = 'a'.repeat(64);
const V2 = 'b'.repeat(64);

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-workspace-drift-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    path: (name) => join(root, `${name}.sqlite`),
  };
}

test('a drifted definition in one workspace refuses that workspace with a named code', async (t) => {
  const ws = workspace(t);
  const first = await startPortableSqliteApp({ dbPath: ws.path('a'), tenantId: 'workspace-a', selected: selected(V1) });
  await first.close();

  const failure = await startPortableSqliteApp({
    dbPath: ws.path('a'), tenantId: 'workspace-a', selected: selected(V2),
  }).then(
    () => null,
    (error) => error,
  );
  assert.notEqual(failure, null, 'the drifted composition must reject');
  assert.equal(failure.code, 'DEFINITION_VERSION_DRIFT');
  assert.equal(failure.status, 503);
  assert.match(
    failure.message,
    /^workspace unavailable workspace-a DEFINITION_VERSION_DRIFT: /,
    'the refusal names the workspace first',
  );
  assert.match(
    failure.message,
    /catalog-provider "probe-catalog@1" source changed after registration/,
    'the store refusal text is preserved after the workspace prefix',
  );
  assert.deepEqual(
    { workspaceId: failure.details?.workspaceId, type: failure.details?.type, name: failure.details?.name, version: failure.details?.version },
    { workspaceId: 'workspace-a', type: 'catalog-provider', name: 'probe-catalog', version: 1 },
    'the refusal carries the workspace and the definition identity for matching',
  );
  assert.equal(isDefinitionVersionDrift(failure), true, 'one predicate matches the workspace refusal');
  // The process is still alive: the test itself keeps running and asserting.
  assert.equal(typeof process.pid, 'number');
});

test('a second healthy workspace in the same capacity keeps composing while the first is refused', async (t) => {
  const ws = workspace(t);
  const first = await startPortableSqliteApp({ dbPath: ws.path('a'), tenantId: 'workspace-a', selected: selected(V1) });
  await first.close();

  await assert.rejects(
    startPortableSqliteApp({ dbPath: ws.path('a'), tenantId: 'workspace-a', selected: selected(V2) }),
    (error) => error?.code === 'DEFINITION_VERSION_DRIFT',
    'the drifted workspace is refused',
  );

  const healthy = await startPortableSqliteApp({ dbPath: ws.path('b'), tenantId: 'workspace-b', selected: selected(V2) });
  t.after(() => healthy.close());
  assert.equal(healthy.health().ok, true, 'the healthy workspace composes in the same process');
  assert.equal(healthy.health().ready, true);

  // The drifted workspace still verifies against its own registered version.
  const unchanged = await startPortableSqliteApp({ dbPath: ws.path('a'), tenantId: 'workspace-a', selected: selected(V1) });
  await unchanged.close();
});

test('no unhandled rejection escapes the workspace composition path', async (t) => {
  const ws = workspace(t);
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.removeListener('unhandledRejection', onUnhandled));

  const first = await startPortableSqliteApp({ dbPath: ws.path('a'), tenantId: 'workspace-a', selected: selected(V1) });
  await first.close();
  await assert.rejects(
    startPortableSqliteApp({ dbPath: ws.path('a'), tenantId: 'workspace-a', selected: selected(V2) }),
    (error) => error?.code === 'DEFINITION_VERSION_DRIFT',
  );
  const healthy = await startPortableSqliteApp({ dbPath: ws.path('b'), tenantId: 'workspace-b', selected: selected(V2) });
  await healthy.close();

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unhandled, [], 'every composition failure was an ordinary rejection');
});

test('drift without a workspace to name keeps the store refusal unchanged', async (t) => {
  const ws = workspace(t);
  const first = await startPortableSqliteApp({ dbPath: ws.path('a'), selected: selected(V1) });
  await first.close();

  await assert.rejects(
    startPortableSqliteApp({ dbPath: ws.path('a'), selected: selected(V2) }),
    (error) => {
      assert.equal(error.code, 'VALIDATION_ERROR');
      assert.equal(error.status, 400);
      assert.match(error.message, /catalog-provider "probe-catalog@1" source changed after registration/);
      assert.equal(isDefinitionVersionDrift(error), true, 'the predicate also matches the unnamed refusal');
      return true;
    },
    'the unnamed path refuses exactly as before',
  );

  assert.equal(isDefinitionVersionDrift(new Error('boom')), false);
  assert.equal(isDefinitionVersionDrift(new ValidationError('other', { index: 0 })), false);
  assert.equal(
    isDefinitionVersionDrift(new ValidationError('catalog-provider "x@1" source changed after registration')),
    false,
    'prose alone never matches: only the store marker or the workspace code does',
  );
});
