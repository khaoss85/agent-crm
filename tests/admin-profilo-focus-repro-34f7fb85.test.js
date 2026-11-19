import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiloView } from '../apps/admin/public/admin-profilo.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

// backlog:34f7fb85ad8b repro (VERIFIER_BACK 2026-11-17): opening Modifica must
// hand the Nome field real focus with the text selected. The old code called
// input.focus() while the form was still detached (words -> head not yet on
// the page in mount), so a real browser keeps document.activeElement on BODY.
// This fake focus only lands when the node is connected to the mount, like a
// real browser.
function isConnected(node, root) {
  let current = node;
  while (current) {
    if (current === root) return true;
    current = current.parentNode ?? null;
  }
  return false;
}

test('34f7fb85ad8b repro: Modifica moves document.activeElement to Nome with the text selected', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let active = null;
  const selected = [];
  const rawCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const node = rawCreate(tag);
    if (String(tag).toLowerCase() === 'input') {
      node.focus = () => {
        if (isConnected(node, mount)) active = node;
      };
      node.select = () => {
        if (active === node) selected.push(node.getAttribute('name'));
      };
    }
    return node;
  };
  const view = createProfiloView({ doc, mount,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    client: { request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      return { member: { name: 'Elena Rinaldi' }, connections: { available: true, reason: null, items: [] } };
    } },
  });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  assert.ok(input, 'the edit form offers a Nome field');
  assert.equal(active, input, 'focus lands on the Nome field (document.activeElement)');
  assert.deepEqual(selected, ['profile-name'], 'the current name is selected, ready to be replaced');
});
