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
  assert.ok(text.includes('Curato da Accordo'), 'the hero keeps the prototype eyebrow verbatim (spec C10)');
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
  const afterOpen = mount.findAll('button');
  const voices = afterOpen.filter((node) => node.getAttribute('role') === 'menuitem').map((node) => node.textContent);
  assert.deepEqual(voices, ['Crea con l\u2019AI', 'Configura manualmente'], 'Aggiungi opens the two-voice menu (spec C9)');
  const manual = afterOpen.find((node) => node.textContent === 'Configura manualmente');
  manual.dispatch('click');
  assert.ok(navigated.includes('#/connettori'), 'Configura manualmente opens the wizard hub');
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

test('the Connettori toggle splits connected and discoverable cards (spec C7)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ connectors: [{ channel: 'whatsapp', connectionKey: 'wa-1', status: 'active' }] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  assert.equal(view.test.state.view, 'scopri', 'Scopri is active by default (spec C7)');
  const seg = mount.findAll('button').filter((node) => node.getAttribute('data-seg'));
  assert.deepEqual(seg.map((node) => node.textContent), ['I tuoi', 'Scopri'], 'the toggle shows both views');
  const cardLabels = () => mount.findAll('strong').map((node) => node.textContent);
  assert.equal(cardLabels().length, 9, 'Scopri shows every card');
  const mine = mount.findAll('button').find((node) => node.getAttribute('data-seg') === 'tuoi');
  assert.ok(mine, 'the I tuoi voice renders');
  mine.dispatch('click');
  await flush();
  assert.deepEqual(cardLabels(), ['WhatsApp'], 'I tuoi keeps only the connected card');
  const badges = mount.findAll('span').filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('ui-conn-count'));
  assert.deepEqual(badges.map((node) => node.textContent), ['1'], 'badges count the visible cards after the toggle');
});

test('the Stato and Ordina menus list the prototype voci in order (spec C22-C23)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ connectors: [{ channel: 'whatsapp', connectionKey: 'wa-1', status: 'active' }] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  const selects = mount.findAll('select');
  const byLabel = (name) => selects.find((node) => node.getAttribute('aria-label') === name);
  const stato = byLabel('Stato');
  const ordina = byLabel('Ordina per');
  assert.ok(stato, 'the Stato menu renders');
  assert.ok(ordina, 'the Ordina per menu renders');
  assert.deepEqual(
    stato.childNodes.map((node) => node.textContent),
    ['Tutti', 'Attivi', 'Da attivare'],
    'the Stato voci match the prototype in order',
  );
  assert.deepEqual(
    ordina.childNodes.map((node) => node.textContent),
    ['Più usati', 'Nome A–Z'],
    'the Ordina voci match the prototype in order',
  );
  const cardLabels = () => mount.findAll('strong').map((node) => node.textContent);
  view.test.state.stato = 'attivi';
  await view.render();
  await flush();
  assert.deepEqual(cardLabels(), ['WhatsApp'], 'Attivi keeps only connected cards');
  view.test.state.stato = 'da-attivare';
  await view.render();
  await flush();
  assert.ok(!cardLabels().includes('WhatsApp'), 'Da attivare hides connected cards');
  assert.equal(cardLabels().length, 8, 'Da attivare keeps the other eight');
  view.test.state.stato = 'tutti';
  view.test.state.sort = 'piu-usati';
  await view.render();
  await flush();
  assert.equal(cardLabels()[0], 'WhatsApp', 'Più usati keeps the prototype order');
});

test('the Aggiungi menu closes with Escape and explains the AI voice honestly (spec C9)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const said = [];
  const navigated = [];
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({
    doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId,
    toast: (message) => said.push(message),
  });
  await view.render();
  await flush();
  const add = mount.findAll('button').find((node) => node.textContent === 'Aggiungi ▾');
  add.dispatch('click');
  let menu = mount.findAll('button').filter((node) => node.getAttribute('role') === 'menuitem');
  assert.equal(menu.length, 2, 'the menu opens with two voices');
  const wrap = mount.querySelector('.ui-conn-addwrap');
  assert.ok(wrap, 'the menu lives in its own wrap');
  wrap.dispatch('keydown', { key: 'Escape' });
  const menuBox = mount.querySelector('.ui-conn-addmenu');
  assert.ok(menuBox && String(menuBox.getAttribute('class')).split(/\s+/).includes('hidden'), 'Escape closes the menu');
  add.dispatch('click');
  const ai = mount.findAll('button').find((node) => node.textContent === 'Crea con l\u2019AI');
  ai.dispatch('click');
  assert.ok(said.some((message) => message.includes('non \u00e8 ancora disponibile')), 'the AI voice says what is missing, in Italian');
  assert.deepEqual(navigated, [], 'the AI voice navigates nowhere');
});

test('the hero carousel walks three prototype slides with arrows and dots (spec C10-C12)', async () => {
  const { CONNETTORI_HERO, heroStep } = await import('../apps/admin/public/admin-personalizzazione.js');
  assert.equal(CONNETTORI_HERO.length, 3, 'three product slides, like the prototype');
  assert.equal(heroStep(0, -1), 2, 'Precedente wraps around');
  assert.equal(heroStep(2, 1), 0, 'Successiva wraps around');
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId });
  await view.render();
  await flush();
  const text = () => mount.textContent;
  assert.ok(text().includes('Kit social'), 'slide one shows the Kit social hero');
  assert.ok(text().includes('Instagram, Facebook, TikTok e WhatsApp'), 'slide one keeps the prototype description');
  const next = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Successiva');
  const prev = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Precedente');
  assert.ok(next && prev, 'both arrows render');
  next.dispatch('click');
  await flush();
  assert.ok(text().includes('Agenda, lead e pagamenti'), 'Successiva moves to slide two');
  assert.ok(text().includes('Appuntamenti condivisi'), 'slide two keeps the prototype copy');
  const dots = mount.findAll('button').filter((node) => String(node.getAttribute('aria-label') ?? '').startsWith('Vai alla slide'));
  assert.equal(dots.length, 3, 'three clickable dots under the panel');
  dots[2].dispatch('click');
  await flush();
  assert.ok(text().includes('Configura con l\u2019AI'), 'the third dot opens the Accordo AI slide');
  const start = mount.findAll('button').find((node) => node.textContent === 'Inizia');
  assert.ok(start, 'the third slide offers Inizia');
  start.dispatch('click');
  assert.ok(navigated.includes('#/connettori'), 'Inizia opens the guided flow');
  const back = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Precedente');
  back.dispatch('click');
  await flush();
  assert.ok(text().includes('Agenda, lead e pagamenti'), 'Precedente walks back one slide');
});

test('a card click opens its detail and + opens the collegamento (spec C19)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({ connectors: [{ channel: 'whatsapp', connectionKey: 'wa-1', status: 'active' }] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId });
  await view.render();
  await flush();
  const articles = mount.findAll('article');
  assert.ok(articles.length > 0, 'cards render as articles');
  const instagram = articles.find((node) => node.textContent.includes('Instagram'));
  instagram.dispatch('click', {});
  assert.ok(navigated.includes('#/connettori/instagram'), 'clicking the card opens its detail');
  const plus = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Collega Instagram');
  plus.dispatch('click', {});
  assert.ok(navigated.includes('#/connettori/instagram'), 'clicking + opens the collegamento without errors');
  const card = articles.find((node) => node.textContent.includes('Instagram'));
  assert.equal(card.getAttribute('tabindex'), '0', 'the card is focusable');
  assert.equal(card.getAttribute('role'), 'link', 'the card exposes its detail destination');
  card.dispatch('keydown', { key: 'Enter' });
  assert.ok(navigated.filter((hash) => hash === '#/connettori/instagram').length >= 2, 'Enter on the card opens its detail');
});

test('a refused card answers like its + action and never leaves the readable page', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const said = [];
  const navigated = [];
  const client = {
    async request(path) {
      if (path === '/api/space-packages/catalog') return { units: [] };
      if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
      if (path.startsWith('/api/connectors?')) throw Object.assign(new Error('denied'), { code: 'FORBIDDEN', status: 403 });
      throw new Error(`unexpected request ${path}`);
    },
  };
  const view = createPersonalizzazioneView({
    doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId,
    toast: (message) => said.push(message),
  });
  await view.render();
  await flush();
  const card = mount.findAll('article').find((node) => node.textContent.includes('WhatsApp'));
  assert.ok(card, 'the refused card still renders');
  card.dispatch('click', {});
  assert.ok(said.includes('Chiedi al titolare di collegare questo canale.'), 'the card answers in Italian with no codes');
  assert.deepEqual(navigated, [], 'the refused card never leaves the readable directory');
});

test('without permission the page stays readable and + explains in Italian', async () => {
  const { isPermissionFailure, previewTitleFor } = await import('../apps/admin/public/admin-personalizzazione.js');
  assert.ok(isPermissionFailure({ code: 'FORBIDDEN' }), 'FORBIDDEN is a permission case');
  assert.ok(isPermissionFailure({ status: 403 }), '403 is a permission case');
  assert.ok(!isPermissionFailure({ code: 'UPSTREAM_DOWN' }), 'an outage is not a permission case');
  assert.equal(previewTitleFor('follow-up · task-1', [{ name: 'follow-up · task-1', label: 'Promemoria' }]), 'Prova · Promemoria', 'the Prova title shows the label, never the raw unit name');
  assert.equal(previewTitleFor('follow-up · task-1', []), 'Prova', 'an unknown unit falls back to bare Prova, never the raw name');
  const doc = createFakeDocument();
  const mount = createMount();
  const said = [];
  const navigated = [];
  const client = {
    async request(path) {
      if (path === '/api/space-packages/catalog') return { units: [] };
      if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
      if (path.startsWith('/api/connectors?')) throw Object.assign(new Error('denied'), { code: 'FORBIDDEN', status: 403 });
      throw new Error(`unexpected request ${path}`);
    },
  };
  const view = createPersonalizzazioneView({
    doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId,
    toast: (message) => said.push(message),
  });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('WhatsApp'), 'the directory still renders without permission');
  const plus = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Collega WhatsApp');
  assert.ok(plus, 'the + action stays visible');
  plus.dispatch('click', {});
  assert.ok(said.includes('Chiedi al titolare di collegare questo canale.'), 'the action answers in Italian with no codes');
  assert.deepEqual(navigated, [], 'the refused action navigates nowhere');
});

test('typing in Cerca filters without reloading (spec C20)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const calls = [];
  const client = stubClient({ connectors: [], calls });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  const before = calls.length;
  const search = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Cerca');
  assert.ok(search, 'the search field renders');
  search.value = 'stripe';
  search.dispatch('input');
  assert.equal(calls.length, before, 'filtering issues no new request');
  const cardLabels = mount.findAll('strong').map((node) => node.textContent);
  assert.deepEqual(cardLabels, ['Stripe'], 'the list filters to the matching card');
});

test('I miei shows an honest empty state when nothing is connected', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  view.test.state.view = 'tuoi';
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('Nessun canale collegato in questo spazio.'), 'the empty I tuoi names what is missing');
  assert.ok(!mount.textContent.includes('NOT_FOUND'), 'no technical codes leak (spec C25)');
});
