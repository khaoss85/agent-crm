// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:739c0c81f55c (production 08/11): text typed into «Fissa con una
 * frase» right after opening the Calendar vanished when the team list
 * arrived. The roster answer repaints the whole view (then the week, then
 * the labels), and each repaint replaced the focused textarea: focus and
 * caret were lost, so the next keystrokes landed on the page. The fix keeps
 * focus and caret on the repainted field; the value rides the view state.
 */

const NOW = new Date('2026-10-21T08:40:00Z');

function makeGate() {
  let release = () => {};
  const gate = new Promise((resolve) => { release = resolve; });
  return { gate, release: () => release() };
}

/** A fake document whose focus() tracks activeElement like a browser. */
function focusingDocument() {
  const doc = /** @type {any} */ (createFakeDocument());
  const create = doc.createElement;
  doc.createElement = (/** @type {string} */ tag) => {
    const node = create(tag);
    node.focus = () => {
      node.__focused = true;
      doc.activeElement = node;
    };
    return node;
  };
  doc.activeElement = null;
  return doc;
}

function rosterClient(gate) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push(path);
      if (path === '/api/spine/memberships') {
        await gate.gate;
        return { items: [{ subject: 'marco', displayName: 'Marco Ferri', role: 'owner' }] };
      }
      if (path === '/api/profile') {
        return { member: null, connections: { available: false, reason: 'PROFILE_NOT_COMPOSED', items: [] } };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        return { from: '2026-10-19T00:00:00.000Z', to: '2026-10-26T00:00:00.000Z', members: [{ teamMemberId: 'marco', appointments: [] }] };
      }
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

test('739c0c81f55c: the phrase typed before the team list arrives keeps value, focus and caret', async () => {
  const doc = focusingDocument();
  const mount = createMount();
  const gate = makeGate();
  const client = rosterClient(gate);
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: () => NOW });
  await view.render();
  const typed = mount.querySelector('textarea[name="phrase"]');
  assert.ok(typed, 'the phrase box paints at once');
  // The operator clicks into the box and types, caret at the end.
  typed.focus();
  typed.value = 'trova 45 minuti con Marco';
  typed.dispatch('input');
  typed.selectionStart = 9;
  typed.selectionEnd = 15;
  // The team list lands: the view repaints (roster, then the week).
  gate.release();
  await settle();
  assert.ok(client.calls.some((path) => path.startsWith('/api/appointments/team-week')), 'the roster loaded the week');
  const current = mount.querySelector('textarea[name="phrase"]');
  assert.ok(current, 'the phrase box is still there');
  assert.notEqual(current, typed, 'the repaint replaced the node');
  assert.equal(current.value, 'trova 45 minuti con Marco', 'the typed text stays');
  assert.equal(current.__focused, true, 'focus is back on the phrase box');
  assert.equal(doc.activeElement, current, 'the next keystroke lands in the phrase box');
  assert.equal(current.selectionStart, 9, 'the caret selection survives');
  assert.equal(current.selectionEnd, 15, 'the caret selection survives');
  // No POST was sent by the repaint.
  assert.ok(!client.calls.some((path) => path.startsWith('/api/appointments/phrase')), 'no phrase request');
});

test('739c0c81f55c: a repaint never steals focus the operator put elsewhere', async () => {
  const doc = focusingDocument();
  const mount = createMount();
  const gate = makeGate();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client: rosterClient(gate), now: () => NOW });
  await view.render();
  const typed = mount.querySelector('textarea[name="phrase"]');
  typed.value = 'trova 30 minuti';
  typed.dispatch('input');
  // Focus sits outside the calendar (the shell search, say).
  const outside = createMount();
  doc.activeElement = outside;
  gate.release();
  await settle();
  const current = mount.querySelector('textarea[name="phrase"]');
  assert.equal(current.value, 'trova 30 minuti', 'the text stays');
  assert.notEqual(current.__focused, true, 'no focus grabbed');
  assert.equal(doc.activeElement, outside, 'focus stays where the operator put it');
});
