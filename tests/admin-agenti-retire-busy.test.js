// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { createAgentiView } from '../apps/admin/public/admin-agenti.js';

/**
 * Main rossa after #879 (backlog:7d169a3b1dd2): «Ritira» / «Riattiva» and
 * «Conferma» on a hand-written agent show their wait from the press, like
 * Affida and Crea l'agente (#861) — «Ritiro…» / «Riattivo…» — and a press
 * that only opens the in-line Conferma gives the button back.
 */

const NOW = '2026-11-13T10:00:00.000Z';
const agent = (status) => ({
  id: 2, sourceKey: 'custom-agent:spazio-prova:v1.20261113.mano', spaceId: 'spazio-prova',
  name: 'Mano', role: 'Fa cose a mano', instructions: 'Guarda e propone.', status,
});

async function flush() {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** The /bo double; the set-status write waits for `release()`. */
function heldClient(status) {
  const rows = [agent(status)];
  const posts = [];
  let open = () => {};
  const gate = new Promise((resolve) => { open = resolve; });
  return {
    posts,
    release: () => open(),
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      if (path.startsWith('/api/agents/catalog')) return { agents: [] };
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: rows.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: [] };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: [] };
      if (path === '/api/agents/set-status' && method === 'POST') {
        const body = JSON.parse(String(options.body));
        posts.push(body);
        await gate;
        rows[0].status = body.status;
        return { agent: { ...rows[0] }, duplicate: false };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
}

async function painted(status) {
  const mount = createMount();
  const client = heldClient(status);
  const view = createAgentiView({
    doc: createFakeDocument(), mount, client, spaceId: () => 'spazio-prova',
    now: () => NOW, setTimer: () => null, clearTimer: () => {},
  });
  await view.render();
  await flush();
  return { mount, client };
}

const button = (mount, action) => mount.querySelector(`button[data-action="${action}"]`);

for (const [status, label, waiting, target] of [
  ['active', 'Ritira', 'Ritiro…', 'paused'],
  ['paused', 'Riattiva', 'Riattivo…', 'active'],
]) {
  test(`7d169a3b1dd2: «${label}» shows «${waiting}» from the press and comes back when it only opens Conferma`, async () => {
    const { mount, client } = await painted(status);
    const pressed = button(mount, 'retire-agent');
    assert.equal(pressed.textContent, label);
    pressed.dispatch('click', {});
    assert.equal(pressed.getAttribute('aria-busy'), 'true', 'the press shows it is working');
    assert.equal(pressed.textContent, waiting);
    assert.ok(button(mount, 'confirm-retire-agent'), 'the in-line Conferma is open');
    await flush();
    assert.equal(pressed.getAttribute('aria-busy'), null, 'nothing was written: the button comes back');
    assert.equal(pressed.textContent, label);
    assert.equal(pressed.disabled, false);
    assert.equal(client.posts.length, 0);
  });

  test(`7d169a3b1dd2: «Conferma» for «${label}» shows «${waiting}» while the write runs`, async () => {
    const { mount, client } = await painted(status);
    button(mount, 'retire-agent').dispatch('click', {});
    await flush();
    const confirm = button(mount, 'confirm-retire-agent');
    confirm.dispatch('click', {});
    assert.equal(confirm.getAttribute('aria-busy'), 'true', 'the press shows it is working');
    assert.equal(confirm.textContent, waiting);
    await flush();
    assert.deepEqual(client.posts.map((body) => body.status), [target], 'one write');
    assert.ok(mount.textContent.includes(waiting), 'the box keeps saying it while the write runs');
    assert.equal(button(mount, 'confirm-retire-agent'), null, 'no second Conferma while it runs');
    client.release();
    await flush();
    assert.ok(!mount.textContent.includes(waiting), 'done: the wait is gone');
    assert.equal(client.posts.length, 1);
  });
}
