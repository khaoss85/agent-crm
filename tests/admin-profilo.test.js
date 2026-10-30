import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiloView, profiloInitials, PROFILO_ROUTE } from '../apps/admin/public/admin-profilo.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

// Profilo inside /bo (design pass 8): the session person and their Google
// connections, read from GET /api/profile (backlog:0994cd18347e). Collega and
// Scollega are the pilot's own routes; this screen only links and posts.

const byClass = (mount, tag, cls) => mount.findAll(tag).filter((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes(cls));

async function render(answer, member = { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }) {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({
    doc,
    mount,
    member: () => member,
    client: { request: async (path) => {
      assert.equal(path, '/api/profile');
      if (answer instanceof Error) throw answer;
      return answer;
    } },
  });
  await view.render();
  return mount;
}

test('the route is #/profilo, and deeper paths are invalid', () => {
  assert.equal(PROFILO_ROUTE, '#/profilo');
  assert.deepEqual(parseModuleRoute('#/profilo'), { view: 'profilo' });
  assert.deepEqual(parseModuleRoute('#/profilo/x'), { view: 'invalid' });
});

test('the person heads the screen: initials, name, email and the Italian role', async () => {
  const mount = await render({ member: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
    connections: { available: true, reason: null, items: [] } });
  assert.equal(byClass(mount, 'span', 'bo-profilo-avatar')[0].textContent, 'ER');
  assert.equal(byClass(mount, 'h2', 'bo-profilo-name')[0].textContent, 'Elena Rinaldi');
  assert.equal(byClass(mount, 'span', 'bo-profilo-email')[0].textContent, 'elena@studioaurora.it');
  assert.equal(byClass(mount, 'span', 'bo-profilo-pill-role')[0].textContent, 'Titolare');
});

test('a connected calendar shows the account and Scollega posts to the pilot route; gmail offers Collega', async () => {
  const mount = await render({ member: {}, connections: { available: true, reason: null, items: [
    { connector: 'calendar', status: 'connected', account: 'elena@studioaurora.it' },
    { connector: 'gmail', status: 'disconnected', account: null },
  ] } });
  const rows = byClass(mount, 'div', 'bo-profilo-conn');
  assert.deepEqual(rows.map((row) => row.getAttribute('data-connector')), ['calendar', 'gmail']);
  assert.ok(rows[0].textContent.includes('Collegato come elena@studioaurora.it'));
  const form = rows[0].findAll('form')[0];
  assert.equal(form.getAttribute('method'), 'post');
  assert.equal(form.getAttribute('action'), '../profile/scollega');
  assert.equal(form.findAll('input')[0].getAttribute('value'), 'calendar');
  const collega = rows[1].findAll('a')[0];
  assert.equal(collega.textContent, 'Collega');
  assert.equal(collega.getAttribute('href'), '../profile/collega?connector=gmail');
  assert.match(collega.getAttribute('class'), /ui-btn-cta/, 'Collega is the green accord CTA');
});

test('unreadable connections say so in Italian, offer no action and invent no state', async () => {
  for (const answer of [new Error('404'), null, { member: {}, connections: { available: false, reason: 'RUNTIME_ROLE_ROUTE_REFUSED', items: [] } }]) {
    const mount = await render(answer);
    const rows = byClass(mount, 'div', 'bo-profilo-conn');
    assert.equal(rows.length, 2, 'both connectors are still named');
    for (const row of rows) {
      assert.ok(row.textContent.includes('Non disponibile'));
      assert.deepEqual(row.findAll('a'), [], 'no Collega on an unknown state');
      assert.deepEqual(row.findAll('form'), [], 'no Scollega on an unknown state');
    }
    const note = byClass(mount, 'p', 'bo-profilo-note')[0];
    assert.match(note.textContent, /non si può leggere/);
    assert.ok(!mount.textContent.includes('RUNTIME_ROLE_ROUTE_REFUSED'), 'no code on screen');
    assert.equal(byClass(mount, 'h2', 'bo-profilo-name')[0].textContent, 'Elena Rinaldi', 'the session person stays');
  }
});

test('hostile values stay text and an unknown connector status reads as to connect', async () => {
  const mount = await render({ member: { name: '<img src=x onerror=alert(1)>' }, connections: { available: true, reason: null, items: [
    { connector: 'calendar', status: 'weird', account: '<b>x</b>' },
  ] } });
  assert.deepEqual(mount.findAll('img'), []);
  assert.equal(byClass(mount, 'h2', 'bo-profilo-name')[0].textContent, '<img src=x onerror=alert(1)>');
  const calendar = byClass(mount, 'div', 'bo-profilo-conn')[0];
  assert.ok(calendar.textContent.includes('Da collegare'));
  assert.deepEqual(mount.findAll('b'), []);
});

test('a prototype name as status reads as to connect, never Object.prototype', async () => {
  for (const status of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    const mount = await render({ member: {}, connections: { available: true, reason: null, items: [
      { connector: 'calendar', status, account: null },
    ] } });
    const calendar = byClass(mount, 'div', 'bo-profilo-conn')[0];
    assert.ok(calendar.textContent.includes('Da collegare'), status);
    assert.ok(!calendar.textContent.includes('function'), status);
    assert.equal(calendar.findAll('a')[0].textContent, 'Collega', status);
  }
});

test('initials come from the name, else from the email', () => {
  assert.equal(profiloInitials('Elena Rinaldi', 'x@y.z'), 'ER');
  assert.equal(profiloInitials('', 'marco.rossi@example.com'), 'MR');
  assert.equal(profiloInitials(null, null), '··');
});

test('a provider subject is never shown as the name or the email', async () => {
  const mount = await render({ member: { name: 'google|104938793743317800292', email: 'google|104938793743317800292', role: null },
    connections: { available: true, reason: null, items: [] } }, { name: 'google|104938793743317800292', email: null, role: 'owner' });
  assert.equal(byClass(mount, 'h2', 'bo-profilo-name')[0].textContent, 'Il tuo profilo');
  assert.equal(byClass(mount, 'span', 'bo-profilo-email').length, 0);
  assert.ok(!mount.textContent.includes('google|'));
  assert.equal(byClass(mount, 'span', 'bo-profilo-pill-role')[0].textContent, 'Titolare', 'the session role survives a null server role');
});

test('without a readable email the connected Google account names the person', async () => {
  const mount = await render({ member: { name: 'google|1049', email: 'google|1049', role: null },
    connections: { available: true, reason: null, items: [{ connector: 'calendar', status: 'connected', account: 'dan@presti.it' }] } },
  { name: 'google|1049', email: null, role: null });
  assert.equal(byClass(mount, 'h2', 'bo-profilo-name')[0].textContent, 'dan@presti.it');
  assert.equal(byClass(mount, 'span', 'bo-profilo-avatar')[0].textContent, 'DA');
});
