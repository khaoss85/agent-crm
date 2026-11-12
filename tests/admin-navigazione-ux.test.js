// Giro UX 11/11 (punti 28, 37, 40): the Sequenze voice in the sidebar, the
// assistant panel's Esc / bubbles / footer, and a failed write logged as a
// write with its code and message.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildShellNav, createShellView } from '../apps/admin/public/admin-shell.js';
import { createAssistantPanel } from '../apps/admin/public/admin-assistant.js';
import { humanReadError, humanWriteError, tagRequestFailure } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

// ---- backlog:b368bbf992ce: Sequenze in the sidebar when composed ----------

function sidebarFor(input) {
  const doc = createFakeDocument();
  const sidebar = createMount();
  const topbar = createMount();
  const seen = [];
  const view = createShellView({ doc, sidebar, topbar, navigate: (hash) => seen.push(hash), win: null });
  view.update({ items: buildShellNav(input), activeScreenId: 'sequenze', screenLabel: 'Sequenze' });
  return { sidebar, seen };
}

test('Sequenze has a sidebar voice when the sequences module is composed', () => {
  const { sidebar, seen } = sidebarFor({ sequencesAvailable: true, agentsAvailable: true });
  const link = sidebar.findAll('a').find((node) => node.getAttribute('href') === '#/sequenze');
  assert.ok(link, 'the sidebar links #/sequenze');
  assert.ok(link.textContent.includes('Sequenze'));
  assert.ok(sidebar.findAll('a').some((node) => node.getAttribute('href') === '#/agenti'), 'Agenti stays');
  assert.equal(link.getAttribute('aria-current'), 'page', 'the open Sequenze screen lights its voice');
  link.dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(seen, ['#/sequenze']);
});

test('without the sequences module there is no Sequenze voice (never a dead link)', () => {
  const { sidebar } = sidebarFor({ sequencesAvailable: false });
  assert.ok(!sidebar.textContent.includes('Sequenze'));
});

// ---- backlog:1968c3320cd3: the assistant panel ----------------------------

function panelWith({ status = { mode: 'dry-run' }, role = null } = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const listeners = {};
  const win = { addEventListener: (type, handler) => { (listeners[type] ??= []).push(handler); } };
  const navigated = [];
  const client = {
    async request(path) {
      if (path === '/api/assistant/status') {
        if (status instanceof Error) throw status;
        return status;
      }
      const error = new Error('no');
      Object.assign(error, { status: 404, code: 'MODULE_NOT_FOUND' });
      throw error;
    },
  };
  const panel = createAssistantPanel({ doc, mount, client, win, role: () => role, navigate: (href) => navigated.push(href) });
  const esc = (extra = {}) => {
    const event = { key: 'Escape', defaultPrevented: false, ...extra };
    for (const handler of listeners.keydown ?? []) handler(event);
  };
  return { doc, mount, panel, esc, navigated };
}

test('Esc closes the assistant panel', async () => {
  const { panel, mount, esc } = panelWith();
  await panel.open('oggi');
  assert.equal(panel.getState().open, true);
  esc();
  assert.equal(panel.getState().open, false);
  assert.equal(mount.childNodes.length, 0);
});

test('an Esc another overlay already handled leaves the panel open', async () => {
  const { panel, esc } = panelWith();
  await panel.open('oggi');
  esc({ defaultPrevented: true });
  assert.equal(panel.getState().open, true);
});

test('Esc while typing in a field outside the panel leaves the panel open; in the panel it closes', async () => {
  const { panel, doc, mount, esc } = panelWith();
  await panel.open('oggi');
  doc.activeElement = createMount();
  esc();
  assert.equal(panel.getState().open, true, 'the composer or form owns that Esc');
  doc.activeElement = mount.findAll('button')[0];
  esc();
  assert.equal(panel.getState().open, false);
});

test('the system reply sits in its own bubble, not inside the user question', async () => {
  const { panel, mount } = panelWith();
  await panel.open('clienti', undefined, undefined, 'meteo a Milano');
  const divs = mount.findAll('div');
  const asked = divs.find((node) => String(node.getAttribute('class')).includes('bo-assistant-asked'));
  assert.ok(asked, 'the question bubble is there');
  assert.ok(asked.textContent.includes('«meteo a Milano»'));
  assert.ok(!asked.textContent.includes('Le domande libere'), 'the system line is not inside the user bubble');
  const reply = mount.findAll('p').find((node) => String(node.getAttribute('class')).includes('bo-assistant-reply'));
  assert.ok(reply, 'the system line has its own bubble');
  assert.ok(reply.textContent.includes('Le domande libere non sono ancora attive'));
  assert.equal(asked.contains(reply), false);
});

test('the footer never tells the titolare to ask the titolare', async () => {
  const off = Object.assign(new Error('off'), { code: 'LLM_SPACE_DISABLED', status: 403 });
  const owner = panelWith({ status: off, role: 'owner' });
  await owner.panel.open('oggi');
  const ownerText = owner.mount.textContent;
  assert.ok(!ownerText.includes('chiedi al titolare'), ownerText);
  assert.ok(ownerText.includes('Spazi e accessi'), 'the owner is told where to turn it on');
  const link = owner.mount.findAll('a').find((node) => node.getAttribute('href') === '#/spazi-accessi');
  assert.ok(link, 'and gets a link there');
  link.dispatch('click', { preventDefault: () => {} });
  assert.deepEqual(owner.navigated, ['#/spazi-accessi']);

  const operator = panelWith({ status: off, role: 'operator' });
  await operator.panel.open('oggi');
  assert.ok(operator.mount.textContent.includes('chiedi al titolare'), 'an operator still asks the titolare');
});

// ---- backlog:e7bdcbcc6864: a failed write logs as a write ----------------

function capture(fn) {
  const logged = [];
  fn((message, cause) => logged.push([message, cause]));
  return logged;
}

test('a failed POST read through humanReadError logs «scrittura fallita» with method, path, code and message', () => {
  const error = tagRequestFailure(
    Object.assign(new Error('Numero non valido'), { status: 400, code: 'VALIDATION_FAILED' }),
    'POST', '/api/customer-hub/phone',
  );
  const logged = capture((log) => humanReadError(error, { failed: 'x', log }));
  assert.equal(logged.length, 1);
  const [message, cause] = logged[0];
  assert.ok(message.startsWith('[bo] scrittura fallita'), message);
  assert.ok(!message.includes('lettura'), message);
  for (const part of ['POST /api/customer-hub/phone', '400', 'VALIDATION_FAILED', 'Numero non valido']) {
    assert.ok(message.includes(part), `${part} in «${message}»`);
  }
  assert.equal(cause.code, 'VALIDATION_FAILED');
  assert.equal(cause.method, 'POST');
});

test('a failed GET still logs «lettura fallita», now with its code and message in the text', () => {
  const error = tagRequestFailure(
    Object.assign(new Error('boom'), { status: 500, code: 'INTERNAL' }),
    'GET', '/api/customer-data/customers?q=Ada%20Rossi',
  );
  const [[message, cause]] = capture((log) => humanReadError(error, { failed: 'x', log }));
  assert.ok(message.startsWith('[bo] lettura fallita'), message);
  assert.ok(message.includes('GET /api/customer-data/customers') && message.includes('500 INTERNAL: boom'), message);
  assert.ok(!message.includes('Ada'), 'the query string (customer words) stays out of the log');
  assert.equal(cause.message, 'boom');
});

test('humanWriteError logs the same «scrittura fallita» line', () => {
  const error = tagRequestFailure(Object.assign(new Error('Conflitto'), { status: 409, code: 'CONFLICT' }), 'PATCH', '/api/x');
  const [[message]] = capture((log) => humanWriteError(error, { failed: 'x', log }));
  assert.ok(message.startsWith('[bo] scrittura fallita PATCH /api/x · 409 CONFLICT: Conflitto'), message);
});

test('tagRequestFailure keeps a method/path already on the error and never throws on primitives', () => {
  const error = tagRequestFailure(Object.assign(new Error('a'), { method: 'DELETE', path: '/api/y' }), 'GET', '/api/z');
  assert.equal(error.method, 'DELETE');
  assert.equal(error.path, '/api/y');
  assert.equal(tagRequestFailure('plain', 'POST', '/api/x'), 'plain');
});

// ---- backlog:c6759700e359: Nuova sequenza, every field with its label ----

import { createSequenzeView } from '../apps/admin/public/admin-sequenze.js';

async function settle() {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

async function manualPanel() {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path) {
      if (path === '/api/schema') return { domains: { sequences: { sequencesContract: 1 } } };
      if (path.startsWith('/api/modules/')) return { items: [] };
      throw new Error(`unexpected ${path}`);
    },
  };
  const view = createSequenzeView({ doc, mount, client });
  await view.renderSequenze();
  await settle();
  mount.querySelector('button[data-action="new-manual"]').dispatch('click', {});
  await settle();
  return mount;
}

test('Nuova sequenza: every field has its own label above it, tied by for/id', async () => {
  const mount = await manualPanel();
  const panel = mount.querySelector('.bo-seq-panel');
  assert.ok(panel, 'the manual panel is open');
  const labels = panel.findAll('label');
  const byText = (text) => labels.find((node) => node.textContent.trim() === text);
  const controls = [
    ['Nome', panel.querySelector('input[name="seq-name"]')],
    ['Quando parte', panel.querySelector('select[name="seq-trigger"]')],
    ['Canale', panel.querySelector('select[name="seq-step-0-channel"]')],
    ['Attesa (giorni)', panel.querySelector('input[name="seq-step-0-wait"]')],
    ['Messaggio', panel.querySelector('input[name="seq-step-0-template"]')],
  ];
  for (const [text, control] of controls) {
    assert.ok(control, `the ${text} control is there`);
    const label = byText(text);
    assert.ok(label, `«${text}» has a label with just its name (labels: ${labels.map((node) => node.textContent).join(' | ')})`);
    assert.ok(control.getAttribute('id'), `${text} has an id`);
    assert.equal(label.getAttribute('for'), control.getAttribute('id'), `«${text}» points at its own control`);
    assert.equal(label.contains(control), false, `«${text}» sits above its control, not beside it inside the label`);
    const row = label.parentNode;
    assert.ok(String(row.getAttribute('class')).split(/\s+/).includes('ui-field-row'), `«${text}» and its control share a ui-field-row`);
    assert.ok(row.contains(control));
  }
  assert.ok(panel.findAll('p').some((node) => node.textContent === 'Passo 1'), 'each step is named once, above its fields');
});

test('Nuova sequenza: a second step gets its own ids and labels', async () => {
  const mount = await manualPanel();
  mount.querySelector('button[data-action="step-add"]').dispatch('click', {});
  await settle();
  const first = mount.querySelector('input[name="seq-step-0-template"]');
  const second = mount.querySelector('input[name="seq-step-1-template"]');
  assert.ok(second);
  assert.notEqual(first.getAttribute('id'), second.getAttribute('id'));
  const panel = mount.querySelector('.bo-seq-panel');
  assert.ok(panel.findAll('label').some((node) => node.getAttribute('for') === second.getAttribute('id')));
  assert.ok(panel.findAll('p').some((node) => node.textContent === 'Passo 2'));
});

test('the phone save path: a 400 through the mutation wrapper logs «scrittura fallita POST /api/customer-hub/phone»', async () => {
  const { bindAdminMutations } = await import('../apps/admin/public/admin-submission.js');
  const { apiFailure } = await import('../apps/admin/public/admin-core.js');
  const { phoneRefusalText } = await import('../apps/admin/public/admin-customer-card.js');
  // The inner client tags like app.js moduleClient.request does.
  const inner = {
    async request(path, options = {}) {
      throw tagRequestFailure(apiFailure(400, { error: { code: 'VALIDATION_FAILED', message: 'Numero non valido' } }), options.method ?? 'GET', path);
    },
  };
  const memory = new Map();
  const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, String(v)), removeItem: (k) => memory.delete(k) };
  const { client } = bindAdminMutations(inner, { storage });
  let caught = null;
  try {
    await client.request('/api/customer-hub/phone', { method: 'POST', body: JSON.stringify({ phone: '123' }) });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, 'the POST is refused');
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    phoneRefusalText(caught);
  } finally {
    console.error = original;
  }
  const line = String(logged[0]?.[0] ?? '');
  assert.ok(line.startsWith('[bo] scrittura fallita POST /api/customer-hub/phone · 400 VALIDATION_FAILED'), line);
  assert.ok(!logged.some((args) => String(args[0]).includes('lettura fallita')));
});
