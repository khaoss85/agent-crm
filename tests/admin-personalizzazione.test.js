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
  assert.deepEqual([...PERSONALIZZAZIONE_TABS], ['skill', 'connettori', 'pacchetti']);
  assert.equal(PERSONALIZZAZIONE_TAB_LABELS.skill, 'Skill AI');
  assert.equal(PERSONALIZZAZIONE_TAB_LABELS.connettori, 'Connettori');
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
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  view.test.state.tab = 'pacchetti';
  await view.render();
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
  view.test.state.tab = 'pacchetti';
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
  const hostileView = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  hostileView.test.state.tab = 'pacchetti';
  await hostileView.render();
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
  const missingView = createPersonalizzazioneView({ doc: missingDoc, mount: missingMount, client: down, navigate: () => {}, spaceId });
  missingView.test.state.tab = 'pacchetti';
  await missingView.render();
  await flush();
  assert.ok(missingMount.textContent.includes('non composta'));
});

test('the pacchetti tab shows a loading note while the catalog is still flying', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let releaseCatalog = null;
  const client = {
    async request(path) {
      if (path === '/api/space-packages/catalog') {
        await new Promise((resolve) => { releaseCatalog = resolve; });
        return { units: UNITS };
      }
      if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
      throw new Error(`unexpected request ${path}`);
    },
  };
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  view.test.state.tab = 'pacchetti';
  const pending = view.render();
  await flush(1);
  assert.ok(
    mount.textContent.includes('Lettura della personalizzazione…'),
    'loading copy renders instead of the empty-results copy',
  );
  assert.ok(!mount.textContent.includes('Nessun risultato'), 'no empty-results flash while loading');
  releaseCatalog();
  await pending;
  await flush();
  assert.ok(mount.textContent.includes('Canali'), 'the catalog renders once it arrives');
});

test('the Connettori tab renders the prototype hero and the two card sections', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({ connectors: [{ channel: 'whatsapp', connectionKey: 'wa-1', status: 'active' }] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId });
  await view.render();
  await flush();
  view.test.state.tab = 'connettori';
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Kit social'), 'the hero names the Kit social');
  assert.ok(text.includes('CURATO DA ACCORDO'), 'the hero keeps the prototype eyebrow');
  assert.ok(text.includes('Canali di conversazione'), 'the first section renders');
  assert.ok(text.includes('Agenda, lead e pagamenti'), 'the second section renders');
  for (const label of ['WhatsApp', 'Instagram', 'Facebook', 'TikTok', 'Email', 'Telefono', 'Form sito', 'Google Calendar', 'Stripe']) {
    assert.ok(text.includes(label), `the ${label} card renders`);
  }
  const buttons = mount.findAll('button');
  const whatsapp = buttons.find((node) => node.textContent.includes('✓'));
  assert.ok(!whatsapp, 'the ✓ state is a badge, never a button');
  const collegato = mount.querySelector('span[title="Collegato"]');
  assert.ok(collegato && collegato.textContent.includes('✓'), 'the live-connected channel shows the ✓ badge');
  const facebook = buttons.find((node) => node.getAttribute('aria-label') === 'Collega Facebook');
  assert.ok(facebook, 'a not-connected channel offers +');
  facebook.dispatch('click');
  assert.deepEqual(navigated, ['#/connettori/facebook'], 'the card opens the guided detail');
  const all = buttons.find((node) => node.textContent === 'Mostra tutto →');
  assert.ok(all, 'each section links the full list');
  all.dispatch('click');
  assert.ok(navigated.includes('#/connettori'), 'Mostra tutto opens the wizard hub');
  const add = buttons.find((node) => node.textContent === 'Aggiungi ▾');
  assert.ok(add, 'the green CTA renders on the Connettori tab');
  assert.ok(add.getAttribute('class').split(/\s+/).includes('ui-btn-cta'), 'Aggiungi stays the green accord CTA');
  add.dispatch('click');
  assert.ok(navigated.includes('#/connettori'), 'Aggiungi opens the wizard hub');
  for (const control of [...mount.findAll('button'), ...mount.findAll('select'), ...mount.findAll('input')]) {
    const classes = String(control.getAttribute('class') ?? '').split(/\s+/);
    assert.ok(classes.some((cls) => cls.startsWith('ui-')), `control ${control.textContent} carries a ui-* class`);
  }
});

test('the Connettori sections reuse the catalog channels with honest destinations', async () => {
  const { CONNECTOR_CATALOG } = await import('../apps/admin/public/admin-connectors.js');
  const { UI_CHANNELS } = await import('../apps/admin/public/admin-ui.js');
  const { CONNETTORI_SECTIONS, connettoriCardState, connettoriHref } = await import(
    '../apps/admin/public/admin-personalizzazione.js'
  );
  const catalog = new Set(CONNECTOR_CATALOG.map((entry) => entry.channel));
  let cards = 0;
  const seen = new Set();
  for (const section of CONNETTORI_SECTIONS) {
    for (const entry of section.entries) {
      cards += 1;
      assert.ok(!seen.has(entry.key), `no duplicate card ${entry.key}`);
      seen.add(entry.key);
      assert.ok(UI_CHANNELS.includes(entry.chip), `${entry.key} reuses a system channel tint`);
      if (entry.channel !== null) {
        assert.ok(catalog.has(entry.channel), `${entry.key} reuses a catalog channel`);
        assert.equal(connettoriHref(entry), `#/connettori/${entry.channel}`);
      }
    }
  }
  assert.equal(cards, 9, 'six conversation channels plus three agenda cards, like the prototype');
  assert.equal(connettoriHref(CONNETTORI_SECTIONS[1].entries[1]), '#/calendario');
  assert.equal(connettoriHref(CONNETTORI_SECTIONS[1].entries[2]), '#/quotes');
  assert.equal(connettoriHref({}), '#/connettori', 'an entry with no destination falls back to the hub');
  const live = [
    { channel: 'whatsapp', connectionKey: 'wa-1', status: 'active' },
    { channel: 'instagram', connectionKey: 'ig-1', status: 'pending' },
  ];
  assert.equal(connettoriCardState({ channel: 'whatsapp' }, live), 'collegato');
  assert.equal(connettoriCardState({ channel: 'instagram' }, live), 'da-collegare');
  assert.equal(connettoriCardState({ channel: null }, live), 'da-collegare');
});

test('Connettori opens by default with the prototype copy, filtered badges and an Italian empty state', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  assert.equal(view.test.state.tab, 'connettori', 'the default tab is Connettori (spec C7)');
  await view.render();
  await flush();
  const search = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Cerca');
  assert.ok(search, 'the search field renders');
  assert.equal(search.getAttribute('placeholder'), 'Cerca', 'the placeholder is the prototype verbatim (spec C8)');
  const badges = mount.findAll('span').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('ui-conn-count'));
  assert.deepEqual(badges.map((node) => node.textContent), ['6', '3'], 'badges count the visible cards (spec C13-C14)');
  view.test.state.query = 'stripe';
  await view.render();
  await flush();
  const filtered = mount.findAll('span').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('ui-conn-count'));
  assert.deepEqual(filtered.map((node) => node.textContent), ['1'], 'the badge follows the filtered cards, not the section total');
  view.test.state.query = 'zzz-no-such-channel';
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('Nessun risultato per questa ricerca.'), 'the empty state is the prototype verbatim (spec C21)');
  assert.ok(!mount.textContent.includes('NOT_FOUND'), 'no technical codes leak (spec C25)');
});

test('a connectors outage renders the Italian error with Riprova', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let fail = true;
  const client = {
    async request(path) {
      if (path === '/api/space-packages/catalog') return { units: UNITS };
      if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
      if (path.startsWith('/api/connectors?')) {
        if (fail) throw Object.assign(new Error('boom'), { code: 'UPSTREAM_DOWN' });
        return { connectors: [] };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('Non riesco a caricare i connettori. Riprova.'), 'the error is Italian (spec Stati)');
  const retry = mount.findAll('button').find((node) => node.textContent === 'Riprova');
  assert.ok(retry, 'the error offers Riprova');
  fail = false;
  retry.dispatch('click');
  await flush();
  await flush();
  assert.ok(mount.textContent.includes('Kit social'), 'Riprova reloads the sections');
});

test('the Connettori search and stato sort filter the prototype cards', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ connectors: [{ channel: 'whatsapp', connectionKey: 'wa-1', status: 'active' }] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  view.test.state.tab = 'connettori';
  view.test.state.query = 'stripe';
  await view.render();
  await flush();
  // Card labels only: the hero copy always names WhatsApp.
  const cardLabels = () => mount.findAll('strong').map((node) => node.textContent);
  assert.ok(cardLabels().includes('Stripe'), 'the query keeps the matching card');
  assert.ok(!cardLabels().includes('WhatsApp'), 'the query hides the other cards');
  view.test.state.query = '';
  view.test.state.sort = 'stato';
  await view.render();
  await flush();
  const labels = mount.findAll('strong').map((node) => node.textContent);
  assert.ok(labels.includes('WhatsApp'), 'the connected card still renders under stato sort');
  assert.equal(labels[0], 'WhatsApp', 'stato sorts the connected channel first');
});
