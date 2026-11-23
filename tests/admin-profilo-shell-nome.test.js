import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiloView } from '../apps/admin/public/admin-profilo.js';
import { createShellView } from '../apps/admin/public/admin-shell.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

// backlog 3136d15da7bd (ritorno verifica 19/11, EVIDENCE_LINE_NOT_PASS):
// dopo Salva il nome nuovo si vedeva nel titolo ma il piede della barra
// laterale restava il vecchio fino alla ricarica. La cura (#909) spinge la
// persona fresca nello shell con onMember; qui la prova attraversa le due
// viste vere, cablate come app.js, e legge il piede dipinto.
const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

function profileClient(seed) {
  let storedName = seed;
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
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      return raw.request(path, options);
    },
  };
}

function renderWiredShell() {
  const doc = createFakeDocument();
  const sidebar = createMount();
  const topbar = createMount();
  const shellUser = { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' };
  const shellView = createShellView({
    doc,
    sidebar,
    topbar,
    spaces: [{ id: 'aurora', name: 'Studio Aurora', initials: 'SA' }],
    user: shellUser,
    navigate: () => {},
    notify: () => {},
  });
  return { doc, sidebar, shellUser, shellView };
}

test('3136d15da7bd Salva repaints the shell footer with the new name at once', async () => {
  const { doc, sidebar, shellUser, shellView } = renderWiredShell();
  assert.ok(sidebar.textContent.includes('Elena Rinaldi'), 'the footer starts with the old name');
  const mount = createMount();
  const view = createProfiloView({
    doc,
    mount,
    client: profileClient('Elena Rinaldi'),
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    // The same wiring as app.js: the fresh person reaches the shell at once.
    onMember: (person) => {
      if (!person || typeof person !== 'object') return;
      for (const key of ['name', 'email', 'role']) {
        if (typeof person[key] === 'string' && person[key] !== '') shellUser[key] = person[key];
      }
      shellView?.update({ user: { ...shellUser } });
    },
  });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').value = 'Elena Presti';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  await flush(20);
  assert.ok(sidebar.textContent.includes('Elena Presti'), 'the footer wears the new name without a reload');
  assert.ok(!sidebar.textContent.includes('Elena Rinaldi'), 'the old name is gone from the footer');
});

test('3136d15da7bd without the shell push the footer keeps the old name', async () => {
  // The verifier's NON PASSA shape: the page saves, the shell never hears.
  const { doc, sidebar } = renderWiredShell();
  const mount = createMount();
  const view = createProfiloView({
    doc,
    mount,
    client: profileClient('Elena Rinaldi'),
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    onMember: () => {},
  });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').value = 'Elena Presti';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  await flush(20);
  assert.ok(sidebar.textContent.includes('Elena Rinaldi'), 'an unwired shell keeps the old footer');
});
