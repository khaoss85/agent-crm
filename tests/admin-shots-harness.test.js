// @ts-check
/**
 * Unit tests for `scripts/admin-shots-harness.js`: the server, stubs and
 * badge gates behind the Admin visual-baseline proof. No browser needed —
 * the capture script (`scripts/admin-shots.js`) exercises the same exports
 * under real Chromium.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  STUB_VERSION,
  countBadgeNodes,
  startRootServer,
  stateBadgeGroups,
  stripAuthority,
  stubResponse,
} from '../scripts/admin-shots-harness.js';

const root = join(import.meta.dirname, '..');
const ADMIN_CSS = join(root, 'apps/admin/public/styles.css');

/**
 * @param {string} dir
 * @returns {Promise<{ port: number, log: { method: string, path: string, status: number, bytes: number }[], close: () => void }>}
 */
function serve(dir) {
  const log = [];
  const server = startRootServer(dir, { log });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolve({ port, log, close: () => server.close() });
    });
  });
}

test('each side serves its own tree at the document root', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"></head></html>');
  writeFileSync(join(dir, 'styles.css'), '.badge { color: red; }');
  writeFileSync(join(dir, 'app.js'), 'console.log(1);');
  const { port, log, close } = await serve(dir);
  try {
    for (const [path, type, body] of [
      ['/index.html', 'text/html', '<link rel="stylesheet"'],
      ['/styles.css', 'text/css', '.badge'],
      ['/app.js', 'text/javascript', 'console.log'],
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, `${path} answers 200`);
      assert.ok(
        (response.headers.get('content-type') ?? '').startsWith(type),
        `${path} has a ${type} content type`,
      );
      assert.ok((await response.text()).includes(body), `${path} serves this side's bytes`);
    }
    // The document root resolves the absolute asset URLs the app ships.
    const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(rootResponse.status, 200, '/ serves index.html');
    assert.ok((await rootResponse.text()).includes('<link rel="stylesheet"'), '/ renders the app shell');
    const logged = log.filter((item) => item.path === '/styles.css' && item.status === 200);
    assert.ok(logged.length >= 1, 'the request log proves /styles.css was fetched with 200');
    assert.equal(logged[0].bytes, '.badge { color: red; }'.length, 'logged bytes match the served file');
  } finally {
    close();
  }
});

test('unknown paths and traversal attempts answer 404 with an empty body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  const { port, close } = await serve(dir);
  try {
    for (const path of ['/nope.css', '/api/unknown', '/%2e%2e/admin-shots-harness.js']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 404, `${path} answers 404`);
      assert.equal(await response.text(), '', `${path} has an empty body, so api() throws honestly`);
    }
  } finally {
    close();
  }
});

test('stubs answer every API the captured screens read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-test-'));
  writeFileSync(join(dir, 'index.html'), '<html></html>');
  const { port, close } = await serve(dir);
  try {
    for (const path of [
      '/health',
      '/api/admin/metrics',
      '/api/opportunities',
      '/api/approvals?status=pending',
      '/api/traces?limit=8',
      '/api/write-outcomes',
      '/api/schema',
      '/api/modules/work-task/records?limit=100',
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status, 200, `${path} is stubbed`);
      const body = await response.json();
      assert.ok(body !== null && typeof body === 'object', `${path} answers JSON, so response.json() never throws`);
    }
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/health`)).json()).ok, true);
  } finally {
    close();
  }
});

test('stub rows render badges covering every state-colour group', () => {
  const css = readFileSync(ADMIN_CSS, 'utf8');
  const groups = stateBadgeGroups(css);
  assert.ok(groups.length >= 5, `styles.css declares the state groups (found ${groups.length})`);
  // Badge classes the app paints from the stub rows: opportunity stages,
  // approval statuses, trace statuses (`badge ${value}` in app.js) and work
  // task statuses (`badge ${row.status}` in admin-work.js).
  const rendered = new Set();
  const opportunities = stubResponse('/api/opportunities');
  assert.ok(opportunities, 'opportunities are stubbed');
  for (const item of JSON.parse(opportunities.body).items) rendered.add(item.stage);
  for (const path of ['/api/approvals', '/api/traces']) {
    const stub = stubResponse(path);
    assert.ok(stub, `${path} is stubbed`);
    for (const item of JSON.parse(stub.body).items) rendered.add(item.status);
  }
  const tasks = stubResponse('/api/modules/work-task/records');
  assert.ok(tasks, 'work tasks are stubbed');
  for (const item of JSON.parse(tasks.body).items) rendered.add(item.status);
  assert.ok(rendered.size > 0, 'stubs render at least one badge class');
  for (const group of groups) {
    assert.ok(
      group.some((state) => rendered.has(state)),
      `state group ${group.join('|')} has a stubbed row — otherwise its pixels never appear in the proof`,
    );
  }
});

test('stub version is a positive integer recorded in the manifest', () => {
  assert.ok(Number.isInteger(STUB_VERSION) && STUB_VERSION >= 1, 'STUB_VERSION is versioned');
});

test('stripAuthority removes exactly the six authority rules', () => {
  const css = readFileSync(ADMIN_CSS, 'utf8');
  const stripped = stripAuthority(css);
  assert.equal((css.split('\n').length - stripped.split('\n').length), 6, 'six rules removed');
  assert.ok(!stripped.includes('[data-authority='), 'no authority selector survives');
  assert.throws(() => stripAuthority('.badge { color: red; }'), /exactly 6/, 'a stylesheet without them fails closed');
});

test('stateBadgeGroups parses the five pinned state rules', () => {
  const groups = stateBadgeGroups(readFileSync(ADMIN_CSS, 'utf8'));
  assert.equal(groups.length, 5, 'exactly five state-colour groups');
  const flat = groups.flat();
  for (const state of ['pending', 'rejected', 'proposal', 'completed', 'failed']) {
    assert.ok(flat.includes(state), `group coverage includes ${state}`);
  }
  assert.ok(!flat.some((state) => state.includes('authority')), 'attribute variants are not state groups');
});

test('countBadgeNodes counts badge elements and their state classes', () => {
  const dom = [
    '<div class="badge approval_pending">a</div>',
    '<span class="badge rejected extra">b</span>',
    '<p class="not-a-badge">c</p>',
    '<div class="badges">d</div>',
  ].join('');
  const counted = countBadgeNodes(dom);
  assert.equal(counted.total, 2, 'only badge-token elements count');
  assert.deepEqual(counted.states, ['approval_pending', 'extra', 'rejected'], 'state classes collected');
  assert.equal(countBadgeNodes('<html><body>no badges</body></html>').total, 0, 'empty shell counts zero');
});
