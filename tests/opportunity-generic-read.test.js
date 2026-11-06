// @ts-check

/**
 * The Pipeline detail reads the board's offer through the generic record
 * path (backlog:c202d787).
 *
 * Production 04/11: the Pipeline board lists offers from
 * `GET /bo/api/opportunities`, but `GET /bo/api/modules/opportunity/records/<id>`
 * answered 404 (`Generated module not found: opportunity`) while the same id
 * reads 200 from the dedicated `GET /bo/api/opportunities/:id` — the detail
 * only opens through the board-list fallback (agent-crm#568). These tests
 * drive the mount against a real in-memory application, so the generic
 * single-record read proves it serves the same row the board shows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createAdminShellMount } from '../packages/app/src/admin-mount.js';

/** @param {{status: number, body: unknown}} answer */
const jsonBody = (answer) => JSON.parse(typeof answer.body === 'string' ? answer.body : answer.body.toString('utf8'));

const readApp = () => createAccordoApp({ dbPath: ':memory:' });

async function boardOfferId(mount) {
  const board = await mount.handle({ method: 'GET', path: '/bo/api/opportunities?limit=100', headers: {} });
  assert.equal(board.status, 200, 'the board lists offers');
  const items = jsonBody(board).items;
  assert.ok(Array.isArray(items) && items.length > 0, 'the board shows at least one offer');
  return items[0];
}

test('an offer the board lists reads through GET /api/modules/opportunity/records/<id> (backlog:c202d787)', async () => {
  const app = readApp();
  try {
    await app.runDemo();
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const shown = await boardOfferId(mount);
    const record = await mount.handle({
      method: 'GET',
      path: `/bo/api/modules/opportunity/records/${encodeURIComponent(shown.id)}`,
      headers: {},
    });
    assert.equal(record.status, 200, 'the generic record read serves the board offer');
    const body = jsonBody(record);
    assert.equal(body.id, shown.id, 'the record is the board offer, not another row');
    assert.equal(body.name, shown.name, 'the record carries the board name');
  } finally {
    app.close();
  }
});

test('a missing offer still 404s on the generic record read, never an empty 200 (backlog:c202d787)', async () => {
  const app = readApp();
  try {
    await app.runDemo();
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const missing = await mount.handle({
      method: 'GET',
      path: '/bo/api/modules/opportunity/records/00000000-0000-0000-0000-000000000000',
      headers: {},
    });
    assert.equal(missing.status, 404, 'a truly missing offer stays not found');
    assert.equal(jsonBody(missing).error.code, 'NOT_FOUND');
  } finally {
    app.close();
  }
});

test('unknown modules still 404 on the generic record read (backlog:c202d787)', async () => {
  const app = readApp();
  try {
    await app.runDemo();
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const unknown = await mount.handle({
      method: 'GET',
      path: '/bo/api/modules/no-such-module/records/00000000-0000-0000-0000-000000000000',
      headers: {},
    });
    assert.equal(unknown.status, 404, 'unknown names fail closed as before');
  } finally {
    app.close();
  }
});

test('the generic surface still owns no opportunity write or collection read (backlog:c202d787)', async () => {
  const app = readApp();
  try {
    await app.runDemo();
    const widened = createAdminShellMount(app, { basePath: '/bo', methods: ['GET', 'HEAD', 'POST', 'PATCH'] });
    const created = await widened.handle({
      method: 'POST',
      path: '/bo/api/modules/opportunity/records',
      headers: { 'content-type': 'application/json' },
      body: {},
    });
    assert.equal(created.status, 404, 'creates stay on POST /api/opportunities, never the generic surface');
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const shown = await boardOfferId(mount);
    const patched = await widened.handle({
      method: 'PATCH',
      path: `/bo/api/modules/opportunity/records/${encodeURIComponent(shown.id)}`,
      headers: { 'content-type': 'application/json' },
      body: {},
    });
    assert.equal(patched.status, 404, 'updates stay on PATCH /api/opportunities/:id, never the generic surface');
    const collection = await mount.handle({
      method: 'GET',
      path: '/bo/api/modules/opportunity/records?limit=100',
      headers: {},
    });
    assert.equal(collection.status, 404, 'the board list stays on GET /api/opportunities, never the generic surface');
  } finally {
    app.close();
  }
});
