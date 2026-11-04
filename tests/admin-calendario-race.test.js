// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createOggiView } from '../apps/admin/public/admin-oggi.js';
import { createSequenzeView } from '../apps/admin/public/admin-sequenze.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Backoffice race (backlog:607f33ee): every async admin view paints into
 * the shell's shared mount. A read still in flight when the operator leaves
 * the view must die — otherwise its late response repaints the screen just
 * opened while the address bar already names the new one. The shell drops
 * those reads with view.invalidate(); these tests drive the two reported
 * crossings with a slow fake fetch.
 */

const NOW = new Date('2026-10-21T08:40:00Z');

function calendarioClient() {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        return { from: '2026-10-19T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z', members: [] };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

function gatedSequenzeClient(release) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') return { domains: { sequences: { sequencesContract: 1 } } };
      if (path.startsWith('/api/modules/sequence/records')) {
        await release.gate;
        return { items: [] };
      }
      if (path.startsWith('/api/modules/sequence-')) return { items: [] };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

function gatedOggiClient(release) {
  return {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') {
        await release.gate;
        return { domains: {} };
      }
      throw new Error(`unexpected path ${path}`);
    },
  };
}

function makeGate() {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  return { gate, release: () => release() };
}

test('Sequenze → Calendario with a slow Sequenze response keeps the Calendario', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const gate = makeGate();
  const sequenzeView = createSequenzeView({ doc, mount, client: gatedSequenzeClient(gate) });
  // The operator opens Sequenze; its records answer is still in flight.
  const pending = sequenzeView.renderSequenze();
  // The operator moves to Calendario: the router invalidates Sequenze, then
  // the calendar paints its own screen into the shared mount.
  sequenzeView.invalidate();
  const calendarioView = createCalendarioView({ doc, mount, client: calendarioClient(), now: () => NOW });
  await calendarioView.render();
  assert.ok(mount.querySelector('.cal-wrap') !== null, 'the calendar screen is up');
  // The slow Sequenze answer lands now: it must not repaint.
  gate.release();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(mount.querySelector('.cal-wrap') !== null, 'the calendar stays after the late Sequenze answer');
  assert.equal(mount.querySelector('.bo-seq'), null, 'no Sequenze repaint over the calendar');
});

test('a late Oggi answer never repaints over a deep-linked Calendario', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const gate = makeGate();
  // Right after login the home read is still in flight while the browser
  // already lands on the deep link #/calendario.
  const oggiView = createOggiView({ doc, mount, client: gatedOggiClient(gate), navigate: () => {} });
  const pending = oggiView.render({ spaceName: 'Presti', userName: 'Daniele', links: [], now: NOW });
  // The router leaves the home for the deep link: invalidate, then paint.
  oggiView.invalidate();
  const calendarioView = createCalendarioView({ doc, mount, client: calendarioClient(), now: () => NOW });
  await calendarioView.render();
  assert.ok(mount.querySelector('.cal-wrap') !== null, 'the calendar screen is up');
  gate.release();
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(mount.querySelector('.cal-wrap') !== null, 'the calendar stays after the late Oggi answer');
  assert.equal(mount.querySelector('.bo-oggi-hello'), null, 'no Oggi repaint over the calendar');
});
