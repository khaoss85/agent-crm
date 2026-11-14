// @ts-check

/**
 * Backlog 4cfa30c164ca (verifica Mac 13/11 20:49Z, pilota 925e6dd con
 * agent-crm ae930cf): il pulsante «Modifica» sotto il nome era largo quanto
 * il titolo (269 px), diverso dagli altri pulsanti secondari. Ora veste gli
 * stessi panni (il componente condiviso uiButton secondary small) e siede
 * nella riga del nome a propria misura; il foglio di stile tiene la riga in
 * flex con il nome che si allarga e il pulsante fermo.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createProfiloView } from '../apps/admin/public/admin-profilo.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

async function render(answer) {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({
    doc,
    mount,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    client: { request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      assert.equal(path, '/api/profile');
      if (answer instanceof Error) throw answer;
      return answer;
    } },
  });
  await view.render();
  return mount;
}

const uiButtonClasses = (node) => (node.getAttribute('class') ?? '').split(/\s+/)
  .filter((cls) => cls.startsWith('ui-btn')).sort();

test('4cfa30c164ca: «Modifica» veste gli stessi panni degli altri pulsanti secondari, nella riga del nome', async () => {
  const mount = await render({
    member: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
    connections: { available: true, reason: null, items: [
      { connector: 'calendar', status: 'connected', account: 'elena@studioaurora.it' },
    ] },
  });
  const edit = mount.findAll('button').find((node) => node.textContent === 'Modifica');
  const scollega = mount.findAll('button').find((node) => node.textContent === 'Scollega');
  assert.ok(edit, '«Modifica» c’è');
  assert.ok(scollega, 'c’è un altro pulsante secondario con cui confrontarlo');
  assert.deepEqual(uiButtonClasses(edit), ['ui-btn', 'ui-btn-secondary', 'ui-btn-small']);
  assert.deepEqual(uiButtonClasses(edit), uiButtonClasses(scollega), 'stesse classi di sistema di «Scollega»');
  const row = edit.parentNode;
  assert.match(row?.getAttribute?.('class') ?? '', /(^|\s)bo-profilo-name-row(\s|$)/, '«Modifica» sta nella riga del nome');
  assert.equal(row?.childNodes?.[0]?.textContent, 'Elena Rinaldi', 'il nome viene prima, il pulsante gli siede accanto');
});

test('4cfa30c164ca: il foglio di stile tiene la riga del nome in flex con il pulsante a propria misura', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.bo-profilo-name-row\s*\{[^}]*display:\s*flex/, 'la riga è flex, il pulsante non va a capo sotto il nome');
  assert.match(css, /\.bo-profilo-name-row\s+\.bo-profilo-name\s*\{[^}]*flex:\s*1/, 'il nome si allarga, non il pulsante');
  assert.match(css, /button\.bo-profilo-edit-open\s*\{[^}]*flex:\s*none/, 'il pulsante resta fermo alla propria misura');
});
