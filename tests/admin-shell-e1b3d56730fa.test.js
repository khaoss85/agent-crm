// backlog:e1b3d56730fa — the shell counters share one queue with the page
// waves, so the total in-flight peak stays within SHELL_MAX_IN_FLIGHT.
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import {
  SHELL_MAX_IN_FLIGHT,
  createReadGate,
  loadClientCount,
  loadFixCount,
} from '../apps/admin/public/admin-shell.js';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

test('e1b3d56730fa — shell counters share one queue: total peak within 6', async () => {
  assert.equal(SHELL_MAX_IN_FLIGHT, 6);
  let flying = 0;
  let peak = 0;
  const release = [];
  const base = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      flying += 1;
      peak = Math.max(peak, flying);
      await new Promise((done) => release.push(done));
      flying -= 1;
      if (path.includes('data-quality-issue')) return { items: [{ status: 'open' }] };
      if (path.includes('duplicate-candidate')) return { items: [{ status: 'unresolved' }] };
      if (path.includes('connectors/activity')) return { needsFix: 2 };
      if (path.includes('customer-data/customers')) return { items: [], total: 4, totalIsExact: true };
      return { items: [] };
    },
  };
  const reads = createReadGate(base);
  // Six page reads already flying, like Oggi's capped wave.
  const page = Array.from({ length: 6 }, (_, index) => reads.request(`/api/modules/work-task/records?n=${index}`));
  // Then the shell counters join the same queue: none starts early.
  let settled = false;
  const shell = Promise.all([
    loadFixCount(reads, { spaceId: 'prova' }),
    loadClientCount(reads),
  ]).then((result) => { settled = true; return result; });
  await sleep(20);
  await sleep(20);
  assert.ok(peak <= SHELL_MAX_IN_FLIGHT, `peak ${peak} within 6`);
  assert.equal(settled, false);
  for (let round = 0; round < 30 && !settled; round += 1) {
    release.splice(0).forEach((done) => done());
    await sleep(10);
  }
  assert.equal(settled, true);
  assert.ok(peak <= SHELL_MAX_IN_FLIGHT, `peak ${peak} within 6`);
  const [[fixes, clients], pageRows] = await Promise.all([shell, Promise.all(page)]);
  assert.equal(fixes, 4);
  assert.deepEqual(clients, { count: 4, exact: true });
  assert.equal(pageRows.length, 6);
});

test('e1b3d56730fa — a refused read rejects alone, the queue keeps flowing', async () => {
  const gate = createReadGate({
    async request(path) {
      if (path === '/nope') throw new Error('giu');
      return path;
    },
  }, 1);
  const first = gate.request('/nope');
  const second = gate.request('/ok');
  await assert.rejects(first);
  assert.equal(await second, '/ok');
});
