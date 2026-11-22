// backlog:e1b3d56730fa Codex P2 on #1062 — the app gate sits beneath the
// schema cache: a renewal behind an expired copy still takes a queue slot,
// so the network peak never passes SHELL_MAX_IN_FLIGHT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SHELL_MAX_IN_FLIGHT, createReadGate } from '../apps/admin/public/admin-shell.js';
import { withSchemaCache } from '../apps/admin/public/admin-schema-cache.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('e1b3d56730fa Codex P2 #1062: an expired-copy renewal queues behind the gate', async () => {
  assert.equal(SHELL_MAX_IN_FLIGHT, 6);
  let flying = 0;
  let peak = 0;
  let schemaFetches = 0;
  const release = [];
  const network = async (path) => {
    flying += 1;
    peak = Math.max(peak, flying);
    await new Promise((done) => release.push(done));
    flying -= 1;
    if (path === '/api/schema') {
      schemaFetches += 1;
      return { version: schemaFetches };
    }
    return { ok: true };
  };
  // The app wiring (app.js): the cache answers reads, the gate guards
  // every network fetch behind it — first reads and background renewals.
  const gate = createReadGate({ request: network });
  let clock = 0;
  const cached = withSchemaCache((path, options) => gate.request(path, options), {
    ttlMs: 30_000,
    now: () => clock,
    space: () => 'presti',
  });
  // First read: a miss, one fetch, copy kept.
  const first = cached('/api/schema');
  await sleep(10);
  release.splice(0).forEach((done) => done());
  assert.deepEqual(await first, { version: 1 });
  assert.equal(schemaFetches, 1);
  // Six ordinary reads fill every queue slot.
  const blocked = Array.from({ length: 6 }, (_, index) => gate.request(`/api/work-task?n=${index}`));
  for (let round = 0; round < 50 && flying < 6; round += 1) await sleep(10);
  assert.equal(flying, 6, 'all six slots are held');
  // The copy expires: the answer still comes from memory, while the
  // renewal queues instead of adding a seventh fetch.
  clock = 60_000;
  const stale = await cached('/api/schema');
  assert.deepEqual(stale, { version: 1 }, 'the expired copy answers at once');
  await sleep(30);
  assert.equal(flying, 6, 'no renewal fetch starts past the bound');
  assert.equal(schemaFetches, 1, 'the renewal waits for a free slot');
  assert.ok(peak <= 6, `peak ${peak} stays within 6`);
  // A slot frees: the renewal runs, the next read sees the new copy.
  release.splice(0, 1).forEach((done) => done());
  for (let round = 0; round < 100 && schemaFetches < 2; round += 1) {
    await sleep(10);
    if (release.length > 0 && schemaFetches < 2) release.splice(0).forEach((done) => done());
  }
  assert.equal(schemaFetches, 2, 'the renewal fetched once a slot freed');
  assert.ok(peak <= 6, `peak ${peak} stays within 6`);
  release.splice(0).forEach((done) => done());
  await Promise.all(blocked);
  clock = 61_000;
  assert.deepEqual(await cached('/api/schema'), { version: 2 }, 'the renewed copy serves next');
});
