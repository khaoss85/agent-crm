import test from 'node:test';
import assert from 'node:assert/strict';
import { withSchemaCache } from '../apps/admin/public/admin-schema-cache.js';

test('three schema reads at once make one request; other paths go through (production 04/11)', async () => {
  const calls = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const cached = withSchemaCache(async (path, options) => {
    calls.push({ path, method: options?.method ?? 'GET' });
    if (path === '/api/schema' && (options?.method ?? 'GET') === 'GET') await gate;
    return { path };
  });
  const reads = [cached('/api/schema'), cached('/api/schema'), cached('/api/schema', { method: 'GET' })];
  await cached('/api/profile');
  await cached('/api/schema', { method: 'POST', body: '{}' });
  release();
  const answers = await Promise.all(reads);
  assert.equal(answers[0], answers[1]);
  assert.equal(calls.filter((c) => c.path === '/api/schema' && c.method === 'GET').length, 1, 'one GET for three callers');
  assert.equal(calls.filter((c) => c.path === '/api/profile').length, 1);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1, 'a write is never cached');
});

test('a settled schema is kept for the ttl, then read again; a failure is never kept', async () => {
  let clock = 0;
  let n = 0;
  let fail = true;
  const cached = withSchemaCache(async () => {
    n += 1;
    if (fail) throw new Error('down');
    return { n };
  }, { ttlMs: 1000, now: () => clock });
  await assert.rejects(cached('/api/schema'));
  fail = false;
  assert.deepEqual(await cached('/api/schema'), { n: 2 }, 'the failed read was not kept');
  clock = 500;
  assert.deepEqual(await cached('/api/schema'), { n: 2 }, 'kept within the ttl');
  clock = 1500;
  // backlog:c048bf6f2dd3: past the ttl the copy still answers at once and
  // the renewal runs behind it; the next read sees the renewed copy.
  assert.deepEqual(await cached('/api/schema'), { n: 2 }, 'the copy answers at once after the ttl');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(n, 3, 'renewed behind the answer');
  assert.deepEqual(await cached('/api/schema'), { n: 3 }, 'the renewed copy');
});

// backlog:c048bf6f2dd3 (born in #881): screens waited for /api/schema every
// 30 s (1-3 s per read on the pilot) before their own reads.
const flush = () => new Promise((resolve) => setImmediate(resolve));
function heldServer(answer = () => ({ version: '1' })) {
  const pending = [];
  let calls = 0;
  return {
    get calls() { return calls; },
    request(path) {
      calls += 1;
      return new Promise((resolve) => { pending.push(() => resolve(answer(path, calls))); });
    },
    release() { for (const go of pending.splice(0)) go(); },
  };
}

test('c048bf6f2dd3: the very first open waits for the network; after it no read waits', async () => {
  let clock = 0;
  const server = heldServer();
  const cached = withSchemaCache((path) => server.request(path), { ttlMs: 1000, now: () => clock, space: () => 's1' });
  let first = null;
  void cached('/api/schema').then((value) => { first = value; });
  await flush();
  assert.equal(first, null, 'the very first open waits: there is nothing to show yet');
  server.release();
  await flush();
  assert.deepEqual(first, { version: '1' });
  clock = 60_000;
  let second = null;
  void cached('/api/schema').then((value) => { second = value; });
  await flush();
  assert.deepEqual(second, { version: '1' }, 'answered from the copy while the renewal is still out');
  assert.equal(server.calls, 2, 'and the renewal left');
  server.release();
});

test('c048bf6f2dd3: a renewed schema that differs repaints once; the same one never does', async () => {
  let clock = 0;
  let version = '1';
  const changes = [];
  const cached = withSchemaCache(async () => ({ version, modules: ['a'] }), {
    ttlMs: 1000, now: () => clock, space: () => 's1', onChange: (space) => changes.push(space),
  });
  await cached('/api/schema');
  clock = 2000;
  await cached('/api/schema');
  await flush();
  assert.deepEqual(changes, [], 'the same copy renewed: nothing to repaint');
  version = '2';
  clock = 4000;
  assert.deepEqual(await cached('/api/schema'), { version: '1', modules: ['a'] }, 'the old copy answers at once');
  await flush();
  assert.deepEqual(changes, ['s1'], 'the new version repaints, once');
  assert.deepEqual(await cached('/api/schema'), { version: '2', modules: ['a'] }, 'and is the copy from now on');
});

test('c048bf6f2dd3: a copy belongs to its space — never another space’s schema', async () => {
  let current = 'A';
  const server = heldServer((path, n) => ({ space: current, n }));
  const storage = new Map();
  const tab = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const cached = withSchemaCache((path) => server.request(path), { space: () => current, storage: tab });
  const a = cached('/api/schema');
  await flush();
  server.release();
  assert.deepEqual(await a, { space: 'A', n: 1 });
  current = 'B';
  let b = null;
  void cached('/api/schema').then((value) => { b = value; });
  await flush();
  assert.equal(b, null, 'space B waits for its own schema, never A’s copy');
  server.release();
  await flush();
  assert.deepEqual(b, { space: 'B', n: 2 });
  current = 'A';
  assert.deepEqual(await cached('/api/schema'), { space: 'A', n: 1 }, 'back on A, A’s copy');
  assert.deepEqual([...storage.keys()].sort(), ['bo-schema:A', 'bo-schema:B'], 'one stored copy per space');
});

test('c048bf6f2dd3: a reload of the same tab answers from the stored copy, renews, and survives a refused write', async () => {
  const tab = new Map([['bo-schema:s1', JSON.stringify({ version: '1' })]]);
  const server = heldServer(() => ({ version: '2' }));
  const changes = [];
  const cached = withSchemaCache((path) => server.request(path), {
    space: () => 's1',
    storage: { getItem: (key) => tab.get(key) ?? null, setItem: () => { throw new Error('QuotaExceededError'); } },
    onChange: (space) => changes.push(space),
  });
  let reloaded = null;
  void cached('/api/schema').then((value) => { reloaded = value; });
  await flush();
  assert.deepEqual(reloaded, { version: '1' }, 'no wait after a reload');
  assert.equal(server.calls, 1, 'a stored copy always renews');
  server.release();
  await flush();
  assert.deepEqual(changes, ['s1'], 'the renewed version repaints');
  assert.deepEqual(await cached('/api/schema'), { version: '2' }, 'a refused write never breaks the read');
});

test('c048bf6f2dd3: the shell keys the copy by mount and space and repaints on a change', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const wiring = /const schemaCachedRequest = withSchemaCache\(([\s\S]*?)\n\}\);/.exec(app);
  assert.ok(wiring, 'one cache for the shell');
  assert.match(wiring[1], /space: \(\) => `\$\{ADMIN_BASE\}\|\$\{shellActiveSpace \?\? ''\}`/);
  assert.match(wiring[1], /storage: tabSessionStorage\(\)/);
  assert.match(wiring[1], /onChange: \(\) => \{\n\s+void populateNav\(\);\n\s+void route\(\);/);
});
