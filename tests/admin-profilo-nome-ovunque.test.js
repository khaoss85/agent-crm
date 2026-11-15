import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiloView } from '../apps/admin/public/admin-profilo.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

// backlog 3136d15da7bd: after Salva the saved name shows at once everywhere.
// The page title already repainted from the re-read; the sidebar footer kept
// the old name until a reload because the shell never heard about the save.
// The view reports the fresh person through onMember so app.js can push it
// into the shell.

const byClass = (mount, tag, cls) => mount.findAll(tag).filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes(cls));

test('3136d15da7bd Salva reports the fresh person through onMember', async () => {
  const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  let storedName = 'Elena Rinaldi';
  const raw = {
    async request(path, options = {}) {
      if (path === '/api/profile' && String(options.method ?? 'GET').toUpperCase() === 'PATCH') {
        const parsed = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        storedName = parsed.name;
        return { member: { name: storedName }, connections: { available: true, reason: null, items: [] } };
      }
      assert.equal(path, '/api/profile');
      return { member: { name: storedName, email: 'elena@studioaurora.it', role: 'owner' },
        connections: { available: true, reason: null, items: [] } };
    },
  };
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      return raw.request(path, options);
    },
  };
  const seen = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({
    doc,
    mount,
    client,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    onMember: (person) => seen.push(person),
  });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').value = 'Elena Presti';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  await flush(20);
  // merge lotto #908: the name is the page h1 (backlog c51dca86dc66), not h2.
  assert.equal(byClass(mount, 'h1', 'bo-profilo-name')[0].textContent, 'Elena Presti');
  assert.equal(seen.length, 1, 'one fresh person after the save');
  assert.equal(seen[0]?.name, 'Elena Presti', 'the shell footer learns the new name without a reload');
});

test('3136d15da7bd no onMember without a save, and none on a failed re-read', async () => {
  const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  let gets = 0;
  const raw = {
    async request(path, options = {}) {
      if (path === '/api/profile' && String(options.method ?? 'GET').toUpperCase() === 'PATCH') {
        return { member: { name: 'Elena Presti' }, connections: { available: true, reason: null, items: [] } };
      }
      gets += 1;
      if (gets === 1) {
        return { member: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
          connections: { available: true, reason: null, items: [] } };
      }
      return null;
    },
  };
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      return raw.request(path, options);
    },
  };
  const seen = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({
    doc,
    mount,
    client,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    onMember: (person) => seen.push(person),
  });
  await view.render();
  assert.deepEqual(seen, [], 'reading the page tells the shell nothing');
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').value = 'Elena Presti';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  await flush(20);
  assert.deepEqual(seen, [], 'a failed re-read reports nothing instead of a stale name');
});

test('3136d15da7bd a failed shell member push logs its cause and keeps the saved name', async () => {
  const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  let storedName = 'Elena Rinaldi';
  const raw = {
    async request(path, options = {}) {
      if (path === '/api/profile' && String(options.method ?? 'GET').toUpperCase() === 'PATCH') {
        const parsed = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        storedName = parsed.name;
        return { member: { name: storedName }, connections: { available: true, reason: null, items: [] } };
      }
      assert.equal(path, '/api/profile');
      return { member: { name: storedName, email: 'elena@studioaurora.it', role: 'owner' },
        connections: { available: true, reason: null, items: [] } };
    },
  };
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      return raw.request(path, options);
    },
  };
  const logged = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({
    doc,
    mount,
    client,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    log: (...args) => logged.push(args.map(String).join(' ')),
    onMember: () => { throw new TypeError('shell view gone'); },
  });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').value = 'Elena Presti';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  await flush(20);
  // merge lotto #908: the name is the page h1 (backlog c51dca86dc66), not h2.
  assert.equal(byClass(mount, 'h1', 'bo-profilo-name')[0].textContent, 'Elena Presti');
  assert.ok(logged.some((line) => /shell member push failed/.test(line) && /TypeError/.test(line)),
    'the swallowed push leaves a cause in the log');
  assert.ok(logged.every((line) => !/Elena Presti/.test(line)), 'the log names no person');
});
