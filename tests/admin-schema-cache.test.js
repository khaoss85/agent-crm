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
  assert.deepEqual(await cached('/api/schema'), { n: 3 }, 'read again after the ttl');
});
