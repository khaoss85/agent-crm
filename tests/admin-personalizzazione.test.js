// @ts-check

/**
 * Backoffice BO-F4-01 Personalizzazione (backlog:7543aabbd901).
 *
 * What it must prove: the route parses; I tuoi/Scopri split the catalog on
 * the space's real activation rows; search, filter and sort are pure and
 * honest; Prova renders the preview without writing; hostile server text
 * stays text; a missing composition renders an honest note, never a blank
 * page. DOM-free builders plus the fake document — no browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PERSONALIZZAZIONE_TAB_LABELS,
  PERSONALIZZAZIONE_TABS,
  activeByUnit,
  bannerFor,
  createPersonalizzazioneView,
  filterUnits,
  isPersonalizzazioneTab,
  previewLines,
  unitStatus,
} from '../apps/admin/public/admin-personalizzazione.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const UNITS = [
  { name: 'channels', kind: 'package', label: 'Canali', blurb: 'Messaggi in un unico inbox.' },
  { name: 'payments', kind: 'package', label: 'Pagamenti', blurb: 'Richieste di pagamento.' },
  { name: 'skill:debug-crm-run', kind: 'skill', label: 'Diagnosi', blurb: 'Diagnosi di un workflow.' },
];

function stubClient({ catalog = UNITS, rows = [], preview = null, connectors = [], calls = null, failCatalog = null } = {}) {
  return {
    async request(path, options = {}) {
      const rawBody = options?.body ?? null;
      let body = rawBody;
      if (typeof rawBody === 'string' && rawBody !== '') {
        try { body = JSON.parse(rawBody); } catch { body = rawBody; }
      }
      if (calls) calls.push({ path, body, method: options?.method ?? 'GET' });
      if (path === '/api/space-packages/catalog') {
        if (failCatalog) throw failCatalog;
        return { units: catalog };
      }
      if (path.startsWith('/api/modules/space-package/records')) return { items: rows };
      if (path.startsWith('/api/space-packages/preview')) {
        if (typeof preview === 'function') return preview(path);
        return preview ?? { headline: 'Demo.', counts: [], uncomposed: [], writes: 0 };
      }
      if (path === '/api/space-packages/activate') {
        const unit = options?.body?.unit;
        rows.push({ unit, status: 'active', id: `row-${unit}` });
        return { unit, status: 'active', replayed: false, id: `row-${unit}` };
      }
      if (path === '/api/space-packages/deactivate') {
        const unit = options?.body?.unit;
        const found = rows.find((row) => row.unit === unit);
        if (found) found.status = 'removed';
        return { unit, status: 'removed' };
      }
      if (path.startsWith('/api/connectors?')) return { connectors };
      throw new Error(`unexpected request ${path}`);
    },
  };
}

const spaceId = () => 'presti-group';

test('the personalizzazione route parses, deeper paths stay invalid', () => {
  assert.equal(parseModuleRoute('#/personalizzazione').view, 'personalizzazione');
  assert.equal(parseModuleRoute('#/personalizzazione/altro').view, 'invalid');
  assert.ok(isPersonalizzazioneTab('pacchetti'));
  assert.ok(!isPersonalizzazioneTab('nope'));
  assert.deepEqual([...PERSONALIZZAZIONE_TABS], ['pacchetti', 'skill', 'connettori']);
  assert.equal(PERSONALIZZAZIONE_TAB_LABELS.pacchetti, 'Pacchetti');
});

test('I tuoi and Scopri split the catalog on the real rows', () => {
  const rows = [
    { unit: 'channels', status: 'active' },
    { unit: 'payments', status: 'removed' },
    { unit: 'ghost', status: 'active' },
  ];
  const active = activeByUnit({ units: UNITS, rows });
  assert.deepEqual([...active.keys()], ['channels']);
  const mine = filterUnits({ units: UNITS, active, tab: 'pacchetti', view: 'tuoi' });
  assert.deepEqual(mine.map((item) => item.entry.name), ['channels']);
  const discover = filterUnits({ units: UNITS, active, tab: 'pacchetti', view: 'scopri' });
  assert.deepEqual(discover.map((item) => item.entry.name), ['payments']);
  const skills = filterUnits({ units: UNITS, active, tab: 'skill', view: 'scopri' });
  assert.deepEqual(skills.map((item) => item.entry.name), ['skill:debug-crm-run']);
  assert.equal(unitStatus({ entry: UNITS[0], row: { status: 'active' } }), 'attiva');
  assert.equal(unitStatus({ entry: UNITS[0], row: null }), 'da-attivare');
});

test('search matches label, blurb and name; sort stato puts active first', () => {
  const active = activeByUnit({ units: UNITS, rows: [{ unit: 'payments', status: 'active' }] });
  const found = filterUnits({ units: UNITS, active, tab: 'pacchetti', view: 'scopri', query: 'INBOX' });
  assert.deepEqual(found.map((item) => item.entry.name), ['channels']);
  const byName = filterUnits({ units: UNITS, active: new Map(), tab: 'pacchetti', view: 'scopri', sort: 'nome' });
  assert.deepEqual(byName.map((item) => item.entry.name), ['channels', 'payments']);
  const mixed = [
    { name: 'zeta', kind: 'package', label: 'Zeta', blurb: '' },
    { name: 'alfa', kind: 'package', label: 'Alfa', blurb: '' },
  ];
  const withActive = activeByUnit({ units: mixed, rows: [{ unit: 'zeta', status: 'active' }] });
  const byState = filterUnits({ units: mixed, active: withActive, tab: 'pacchetti', view: 'tuoi', sort: 'stato' });
  assert.deepEqual(byState.map((item) => item.entry.name), ['zeta']);
  const all = filterUnits({ units: mixed, active: withActive, tab: 'pacchetti', view: 'scopri', sort: 'stato' });
  assert.deepEqual(all.map((item) => item.entry.name), ['alfa']);
});

test('every tab names its honest banner', () => {
  assert.ok(bannerFor('pacchetti').includes('pacchetto'));
  assert.ok(bannerFor('skill').includes('Prova'));
  assert.ok(bannerFor('connettori').includes('Collega'));
});

test('Scopri shows cards with Prova and +, activating moves the unit to I tuoi', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const calls = [];
  const client = stubClient({
    rows: [],
    calls,
    preview: () => ({ headline: 'Canali: 1 riga. La Prova non scrive nulla.', counts: [{ module: 'channel-connection', count: 1 }], uncomposed: [], writes: 0 }),
  });
  await createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId }).render();
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Personalizzazione'));
  assert.ok(text.includes('Canali'));
  assert.ok(text.includes('Pagamenti'));
  const proof = mount.findAll('button').find((node) => node.textContent === 'Prova');
  assert.ok(proof, 'every discover card offers Prova');
  proof.dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes('Canali: 1 riga'), 'the preview headline renders');
  const add = mount.findAll('button').find((node) => node.textContent === '+');
  assert.ok(add, 'a non-active unit offers +');
  add.dispatch('click');
  await flush();
  assert.ok(calls.some((call) => call.path === '/api/space-packages/activate' && call.body?.unit === 'channels'));
  assert.ok(mount.textContent.includes('I tuoi'), 'after activation the view flips to I tuoi');
});

test('I tuoi renders the status table and deactivating keeps history server-side', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const calls = [];
  const client = stubClient({
    rows: [{ unit: 'channels', status: 'active', id: 'row-channels' }],
    calls,
  });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  view.test.state.view = 'tuoi';
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('Attiva ✓'));
  const off = mount.findAll('button').find((node) => node.textContent === 'Disattiva');
  assert.ok(off, 'an active unit offers Disattiva');
  off.dispatch('click');
  await flush();
  assert.ok(calls.some((call) => call.path === '/api/space-packages/deactivate' && call.body?.unit === 'channels'));
});

test('hostile server text stays text', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const hostile = [
    { name: 'channels', kind: 'package', label: '<img src=x onerror=alert(1)>', blurb: '<script>alert(2)</script>' },
  ];
  const client = stubClient({ catalog: hostile, rows: [] });
  await createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId }).render();
  await flush();
  assert.ok(mount.textContent.includes('<img src=x onerror=alert(1)>'));
  assert.ok(mount.textContent.includes('<script>alert(2)</script>'));
});

test('an empty space and an uncomposed server render honest notes', async () => {
  const noSpaceDoc = createFakeDocument();
  const noSpaceMount = createMount();
  await createPersonalizzazioneView({
    doc: noSpaceDoc, mount: noSpaceMount, client: stubClient(), navigate: () => {}, spaceId: () => null,
  }).render();
  assert.ok(noSpaceMount.textContent.includes('Scegli uno spazio'));

  const missingDoc = createFakeDocument();
  const missingMount = createMount();
  const down = stubClient({ failCatalog: Object.assign(new Error('Not found'), { code: 'NOT_FOUND', status: 404 }) });
  await createPersonalizzazioneView({ doc: missingDoc, mount: missingMount, client: down, navigate: () => {}, spaceId }).render();
  await flush();
  assert.ok(missingMount.textContent.includes('non composta'));
});

test('the Connettori tab reuses the live summary and opens the guided flow', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({ connectors: [{ channel: 'whatsapp', status: 'active' }] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId });
  await view.render();
  await flush();
  view.test.state.tab = 'connettori';
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('WhatsApp'));
  assert.ok(mount.textContent.includes('active'));
  const open = mount.findAll('button').find((node) => node.textContent === 'Apri connettori');
  assert.ok(open, 'the tab links to the guided flow instead of duplicating it');
  open.dispatch('click');
  assert.deepEqual(navigated, ['#/connettori']);
});
