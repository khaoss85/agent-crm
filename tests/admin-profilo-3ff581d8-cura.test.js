// @ts-check

/**
 * Backlog 3ff581d8f8ce: in modifica il nome compariva due volte (titolo
 * grande e campo) e «Salva»/«Annulla» erano attaccati. Ora il titolo in
 * modifica non ripete il nome, i due bottoni stanno in riga con lo stesso
 * respiro delle altre azioni e dopo Annulla il focus torna a «Modifica».
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProfiloView } from '../apps/admin/public/admin-profilo.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

const byClass = (mount, tag, cls) => mount.findAll(tag).filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes(cls));

async function render() {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({
    doc,
    mount,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    client: { request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      return { member: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
        connections: { available: true, reason: null, items: [] } };
    } },
  });
  await view.render();
  return mount;
}

function openEdit(mount) {
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
}

test('3ff581d8f8ce: in modifica il titolo non ripete il nome, il campo sì', async () => {
  const mount = await render();
  openEdit(mount);
  assert.equal(byClass(mount, 'h1', 'bo-profilo-name')[0].textContent, 'Modifica nome');
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  assert.ok(input, 'il campo Nome c’è');
  assert.equal(input.value, 'Elena Rinaldi', 'il nome vive nel campo');
  const titles = byClass(mount, 'h1', 'bo-profilo-name').map((node) => node.textContent);
  assert.deepEqual(titles, ['Modifica nome'], 'il nome compare una volta sola, nel campo');
});

test('3ff581d8f8ce: Salva e Annulla stanno in riga con respiro, come le altre azioni', async () => {
  const mount = await render();
  openEdit(mount);
  const actions = byClass(mount, 'div', 'bo-profilo-edit-actions')[0];
  assert.ok(actions, 'i bottoni hanno la loro riga di azioni');
  const labels = actions.findAll('button').map((node) => node.textContent);
  assert.deepEqual(labels, ['Salva', 'Annulla']);
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bo-profilo-edit-actions\s*\{[^}]*display:\s*flex/, 'la riga è flex');
  assert.match(css, /\.bo-profilo-edit-actions\s*\{[^}]*gap:\s*10px/, 'stesso respiro delle altre azioni');
});

test('3ff581d8f8ce: dopo Annulla il focus torna a «Modifica»', async () => {
  const mount = await render();
  openEdit(mount);
  mount.findAll('button').find((node) => node.textContent === 'Annulla').dispatch('click');
  assert.equal(byClass(mount, 'h1', 'bo-profilo-name')[0].textContent, 'Elena Rinaldi', 'il titolo torna al nome');
  const edit = mount.findAll('button').find((node) => node.textContent === 'Modifica');
  assert.ok(edit, '«Modifica» c’è di nuovo');
  assert.equal(edit.__focused, true, 'il focus torna a «Modifica»');
});

test('3ff581d8f8ce: dopo Esc nel campo il focus torna a «Modifica»', async () => {
  const mount = await render();
  openEdit(mount);
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  input.dispatch('keydown', { key: 'Escape' });
  const edit = mount.findAll('button').find((node) => node.textContent === 'Modifica');
  assert.ok(edit, '«Modifica» c’è di nuovo');
  assert.equal(edit.__focused, true, 'il focus torna a «Modifica» anche con Esc');
});
