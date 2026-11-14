import test from 'node:test';
import assert from 'node:assert/strict';
import { createProfiloView, profiloInitials, PROFILO_ROUTE } from '../apps/admin/public/admin-profilo.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

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

// Meta rows (backlog:92f993586110): WhatsApp, Instagram and Messenger connect
// through the pilot's Meta consent, on the same /api/profile answer.
test('an answer without connections.meta shows no Meta rows at all', async () => {
  const mount = await render({ member: {}, connections: { available: true, reason: null, items: [] } });
  const ids = byClass(mount, 'div', 'bo-profilo-conn').map((row) => row.getAttribute('data-connector'));
  assert.deepEqual(ids, ['calendar', 'gmail']);
  assert.ok(!mount.textContent.includes('Canali Meta'));
});

test('Meta configured: WhatsApp, Instagram and Messenger offer Collega and Scollega on the pilot routes', async () => {
  const mount = await render({ member: {}, connections: { available: true, reason: null, meta: { configured: true }, items: [
    { connector: 'calendar', status: 'connected', account: 'elena@studioaurora.it' },
    { connector: 'whatsapp', status: 'connected', account: '+39 333 0000000' },
    { connector: 'instagram', status: 'disconnected', account: null },
  ] } });
  const rows = byClass(mount, 'div', 'bo-profilo-conn');
  assert.deepEqual(rows.map((row) => row.getAttribute('data-connector')),
    ['calendar', 'gmail', 'whatsapp', 'instagram', 'messenger']);
  assert.equal(byClass(mount, 'p', 'bo-profilo-group')[0].textContent, 'Canali Meta');
  const wa = rows[2];
  assert.ok(wa.textContent.includes('Collegato come +39 333 0000000'));
  const form = wa.findAll('form')[0];
  assert.equal(form.getAttribute('action'), '../profile/scollega');
  assert.equal(form.findAll('input')[0].getAttribute('value'), 'whatsapp');
  for (const [index, connector] of [[3, 'instagram'], [4, 'messenger']]) {
    const link = rows[index].findAll('a')[0];
    assert.equal(link.textContent, 'Collega');
    assert.equal(link.getAttribute('href'), `../profile/collega?connector=${connector}`);
  }
  assert.ok(!mount.textContent.includes('non è ancora attivo'));
});

test('Meta reported but not configured: rows named, «Non ancora attivo», no action', async () => {
  const mount = await render({ member: {}, connections: { available: true, reason: null, meta: { configured: false }, items: [
    { connector: 'whatsapp', status: 'connected', account: '+39 333 0000000' },
  ] } });
  assert.ok(!mount.textContent.includes('Collegato come +39'), 'an inactive Meta never claims a connection');
  const metaRows = byClass(mount, 'div', 'bo-profilo-conn').filter((row) =>
    ['whatsapp', 'instagram', 'messenger'].includes(row.getAttribute('data-connector')));
  assert.equal(metaRows.length, 3);
  for (const row of metaRows) {
    assert.ok(row.textContent.includes('Non ancora attivo'));
    assert.deepEqual(row.findAll('a'), []);
    assert.deepEqual(row.findAll('form'), []);
  }
  assert.match(mount.textContent, /Meta non è ancora attivo per questo spazio/);
});

test('a connected Meta account never stands in for the person email', async () => {
  const mount = await render({ member: {}, connections: { available: true, reason: null, meta: { configured: true }, items: [
    { connector: 'whatsapp', status: 'connected', account: 'Studio Presti' },
  ] } }, { name: 'Dan', email: 'google|123', role: 'owner' });
  assert.deepEqual(byClass(mount, 'span', 'bo-profilo-email'), [], 'no email shown from a Meta account');
});

// backlog:1cfc68175ab7 (VERIFIER_BACK 2026-11-12: the name was a static h2,
// no write existed): the profile name is editable in place through
// PATCH /api/profile, via the submission controller.
test('backlog:1cfc68175ab7 the profile name is editable: Modifica opens a form, Salva PATCHes and repaints', async () => {
  const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  let storedName = 'Elena Rinaldi';
  const calls = [];
  const raw = {
    async request(path, options = {}) {
      calls.push({ path, method: String(options.method ?? 'GET').toUpperCase(), body: options.body });
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
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({ doc, mount, client, member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }) });
  await view.render();
  const edit = mount.findAll('button').find((node) => node.textContent === 'Modifica');
  assert.ok(edit, 'a Modifica button sits beside the static name');
  edit.dispatch('click');
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  assert.ok(input, 'the edit form offers a Nome field');
  input.value = 'Elena Presti';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  await flush(20);
  const patch = calls.find((call) => call.method === 'PATCH');
  assert.ok(patch, 'Salva sends a write, never only a re-read');
  assert.equal(patch.path, '/api/profile');
  const sent = typeof patch.body === 'string' ? JSON.parse(patch.body) : patch.body;
  assert.deepEqual(sent, { name: 'Elena Presti' });
  assert.equal(byClass(mount, 'h2', 'bo-profilo-name')[0].textContent, 'Elena Presti');
});

test('backlog:1cfc68175ab7 a provider-subject name gets the invalid-name error, not the too-long one', async () => {
  const calls = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({ doc, mount,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    client: { request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: String(options.method ?? 'GET').toUpperCase() });
      return { member: { name: 'Elena Rinaldi' }, connections: { available: true, reason: null, items: [] } };
    } },
  });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  input.value = 'google|123';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  assert.ok(!calls.some((call) => call.method !== 'GET'), 'no write on an invalid name');
  assert.match(mount.textContent, /senza codici/);
  assert.ok(!mount.textContent.includes('troppo lungo'), 'no length error for a short invalid name');
});

test('backlog:1cfc68175ab7 an over-length name gets the too-long error with the draft kept', async () => {
  const calls = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({ doc, mount,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    client: { request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: String(options.method ?? 'GET').toUpperCase() });
      return { member: { name: 'Elena Rinaldi' }, connections: { available: true, reason: null, items: [] } };
    } },
  });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  const longName = `${'a'.repeat(121)}`;
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  input.value = longName;
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  assert.ok(!calls.some((call) => call.method !== 'GET'), 'no write on an over-length name');
  assert.match(mount.textContent, /troppo lungo/);
  const again = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  assert.equal(again.value, longName, 'the draft survives the length error');
});

test('backlog:1cfc68175ab7 PATCH success then GET null keeps editing open with the draft', async () => {
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
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({ doc, mount, client, member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }) });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').value = 'Elena Presti';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  await flush(20);
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  assert.ok(input, 'editing stays open when the re-read fails');
  assert.equal(input.value, 'Elena Presti', 'the draft survives the failed re-read');
  assert.match(mount.textContent, /rilettura non è riuscita/);
  assert.equal(mount.findAll('button').filter((node) => node.textContent === 'Modifica').length, 0, 'editing stays open instead of closing');
});

test('backlog:1cfc68175ab7 an empty name never leaves the browser', async () => {
  const calls = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({ doc, mount,
    member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }),
    client: { request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: String(options.method ?? 'GET').toUpperCase() });
      return { member: { name: 'Elena Rinaldi' }, connections: { available: true, reason: null, items: [] } };
    } },
  });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  const input = mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name');
  input.value = '   ';
  mount.findAll('button').find((node) => node.textContent === 'Salva').dispatch('click');
  assert.ok(!calls.some((call) => call.method !== 'GET'), 'no write on an empty name');
  assert.match(mount.textContent, /Scrivi un nome prima di salvare/);
});

// main rossa 60c5fc51 (tests/admin-cta-busy.test.js): Salva of the profile
// name shows the /bo write wait — «Salvo…», disabled, Annulla off — while
// the PATCH is in flight, like every other write button (#775, #831).
test('backlog:1cfc68175ab7 Salva shows «Salvo…» and locks the form while the name is written', async () => {
  const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  let releasePatch;
  const patches = [];
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (String(options.method ?? 'GET').toUpperCase() === 'PATCH') {
        patches.push(path);
        await new Promise((resolve) => { releasePatch = resolve; });
        return { member: { name: 'Elena Presti' } };
      }
      return { member: { name: patches.length > 0 ? 'Elena Presti' : 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
        connections: { available: true, reason: null, items: [] } };
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({ doc, mount, client, member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }) });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').value = 'Elena Presti';
  const save = mount.findAll('button').find((node) => node.textContent === 'Salva');
  save.dispatch('click');
  await flush();
  assert.equal(save.textContent, 'Salvo…', 'the button says it is saving');
  assert.equal(save.disabled, true, 'no second click on a write in flight');
  assert.equal(save.getAttribute('aria-busy'), 'true');
  assert.equal(mount.findAll('button').find((node) => node.textContent === 'Annulla').disabled, true, 'Annulla waits too');
  save.dispatch('click');
  await flush();
  assert.equal(patches.length, 1, 'one write, whatever the clicks');
  releasePatch();
  await flush(20);
  assert.equal(byClass(mount, 'h2', 'bo-profilo-name')[0].textContent, 'Elena Presti', 'the new name paints');
});

// Muse P2 on #849: after the PATCH succeeds the reread is still in flight;
// a click on Salva then must not start a second write.
test('backlog:1cfc68175ab7 a click or Enter during the reread after Salva writes nothing more', async () => {
  const flush = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
  let releaseRead = null;
  const patches = [];
  let gets = 0;
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (String(options.method ?? 'GET').toUpperCase() === 'PATCH') {
        patches.push(path);
        return { member: { name: 'Elena Presti' } };
      }
      gets += 1;
      if (patches.length > 0) await new Promise((resolve) => { releaseRead = resolve; });
      return { member: { name: patches.length > 0 ? 'Elena Presti' : 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
        connections: { available: true, reason: null, items: [] } };
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createProfiloView({ doc, mount, client, member: () => ({ name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' }) });
  await view.render();
  mount.findAll('button').find((node) => node.textContent === 'Modifica').dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').value = 'Elena Presti';
  const save = mount.findAll('button').find((node) => node.textContent === 'Salva');
  save.dispatch('click');
  await flush();
  assert.ok(releaseRead, 'the reread is in flight');
  save.dispatch('click');
  mount.findAll('input').find((node) => node.getAttribute('name') === 'profile-name').dispatch('keydown', { key: 'Enter' });
  await flush();
  assert.equal(patches.length, 1, 'no second write while the reread runs');
  releaseRead();
  await flush(20);
  assert.equal(byClass(mount, 'h2', 'bo-profilo-name')[0].textContent, 'Elena Presti', 'the new name paints');
});

// PROFILO item 34f7fb85ad8b: opening Modifica hands the Nome field over ready
// to type — focused with the current name selected — and the field wears the
// same measure, spacing and label as the other Impostazioni fields
// (ui-field-row + ui-label + ui-field, tied by for/id, like the sequenze and
// agenti forms and the shared uiSecretField).
test('PROFILO 34f7fb85ad8b Modifica focuses Nome with the text selected, styled like the other settings fields', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  // The fake DOM has no select(): attach the spy the way a real browser runs it.
  const selected = [];
  const rawCreate = doc.createElement.bind(doc);
  doc.createElement = (tag) => {
    const node = rawCreate(tag);
    if (String(tag).toLowerCase() === 'input') {
      node.select = () => { selected.push(node.getAttribute('name')); };
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
  assert.match(input.getAttribute('class') ?? '', /(^|\s)ui-field(\s|$)/, 'the input wears the settings field measure');
  assert.match(input.parentNode?.getAttribute?.('class') ?? '', /(^|\s)ui-field-row(\s|$)/, 'the row keeps the settings spacing');
  const label = mount.findAll('label').find((node) => node.textContent === 'Nome');
  assert.ok(label, 'the field has a visible Nome label');
  assert.match(label.getAttribute('class') ?? '', /(^|\s)ui-label(\s|$)/, 'the label reads like the other settings labels');
  assert.ok(input.getAttribute('id'), 'the field carries an id');
  assert.equal(label.getAttribute('for'), input.getAttribute('id'), 'the label points at the field');
  assert.equal(input.__focused, true, 'the Nome field takes focus on open');
  assert.deepEqual(selected, ['profile-name'], 'the current name is selected, ready to be replaced');
});

// backlog:f7d2f7f362cf: at rest «Modifica» was a bordered button as wide as
// the name, sitting between the name and the email like an empty field. It
// now sits beside the name in one row, at its own text measure.
test('backlog:f7d2f7f362cf Modifica sits beside the name at its own measure, never like a field', async () => {
  const mount = await render({ member: { name: 'Elena Rinaldi', email: 'elena@studioaurora.it', role: 'owner' },
    connections: { available: true, reason: null, items: [] } });
  const edit = mount.findAll('button').find((node) => node.textContent === 'Modifica');
  assert.ok(edit, 'Modifica is still a button');
  assert.match(edit.getAttribute('class') ?? '', /(^|\s)bo-profilo-edit-open(\s|$)/, 'the button wears its own-measure class');
  const row = edit.parentNode;
  assert.match(row?.getAttribute?.('class') ?? '', /(^|\s)bo-profilo-name-row(\s|$)/, 'Modifica shares a row with the name');
  const kids = row?.childNodes ?? [];
  assert.equal(kids[0]?.textContent, 'Elena Rinaldi', 'the name comes first in the row');
  assert.equal(kids[1], edit, 'Modifica sits beside the name, not between the name and the email');
  const words = row?.parentNode;
  assert.match(words?.getAttribute?.('class') ?? '', /(^|\s)bo-profilo-words(\s|$)/);
  const order = (words?.childNodes ?? []).map((node) => node.getAttribute?.('class') ?? '');
  const rowAt = order.findIndex((cls) => cls.split(/\s+/).includes('bo-profilo-name-row'));
  const emailAt = order.findIndex((cls) => cls.split(/\s+/).includes('bo-profilo-meta'));
  assert.ok(rowAt >= 0 && emailAt >= 0 && rowAt < emailAt, 'the name row stays above the email line');
});
