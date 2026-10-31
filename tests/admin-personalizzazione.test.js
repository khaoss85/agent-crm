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

function stubClient({ catalog = UNITS, rows = [], preview = null, connectors = [], calls = null, failCatalog = null, needsBySpace = null } = {}) {
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
      if (path.includes('/api/modules/data-quality-issue/records')) return { items: [] };
      if (path.includes('/api/modules/duplicate-candidate/records')) return { items: [] };
      if (path.startsWith('/api/connectors/activity')) {
        const spaceId = new URL(path, 'http://stub.test').searchParams.get('spaceId') ?? '';
        const needsFix = needsBySpace !== null && Object.hasOwn(needsBySpace, spaceId)
          ? needsBySpace[spaceId] : 0;
        return { needsFix };
      }
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

// Voce 19c2e22a64a1 (1): the tab badge counts this space live — a space
// with attention rows lights the badge, a quiet space never wears the
// other space's count.
test('the tab badge counts the view space live — never another space', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const client = stubClient({ needsBySpace: { 'spazio-a': 4, 'spazio-b': 0 }, calls: seen });
  let space = 'spazio-a';
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId: () => space });
  await view.render();
  await flush();
  const badge = () => mount.findAll('span')
    .find((node) => (node.getAttribute('class') ?? '').split(/\s+/).includes('bo-badge'));
  assert.ok(seen.some((call) => call.path.includes('/api/connectors/activity')
    && call.path.includes('spaceId=spazio-a')), 'the badge read names its own space');
  assert.ok(badge(), 'spazio-a lights the badge');
  assert.equal(badge().textContent, '4', 'the badge carries spazio-a count');
  space = 'spazio-b';
  await view.render();
  await flush();
  assert.equal(badge(), undefined, 'spazio-b wears no badge — never spazio-a count');
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
  for (const label of ['WhatsApp', 'Instagram', 'Telegram', 'Facebook', 'TikTok', 'Email', 'Telefono', 'Form sito', 'Google Calendar', 'Stripe']) {
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
  const addMenu = mount.querySelector('.ui-conn-addmenu');
  assert.ok(addMenu, 'the Aggiungi menu renders');
  const afterOpen = addMenu.childNodes.filter((node) => node.tagName === 'BUTTON');
  const voices = afterOpen.filter((node) => node.getAttribute('role') === 'menuitem')
    .map((node) => node.findAll('span').find((span) => span.getAttribute('class') === 'ui-add-title').textContent);
  assert.deepEqual(voices, ['Crea con l\u2019AI', 'Configura manualmente'], 'Aggiungi opens the two-voice menu (spec C9)');
  const manual = afterOpen.find((node) => String(node.textContent).startsWith('Configura manualmente'));
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
  assert.equal(cards, 10, 'seven conversation channels plus three agenda cards, like the prototype');
  assert.equal(connettoriHref(CONNETTORI_SECTIONS[1].entries[1]), '#/profilo');
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
  assert.deepEqual(badges.map((node) => node.textContent), ['7', '3'], 'badges count the visible cards (spec C13-C14)');
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
  assert.equal(cardLabels().length, 10, 'Scopri shows every card');
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
  // Spec C8: the Connettori toolbar shows two icon-buttons, not selects.
  assert.equal(mount.findAll('select').length, 0, 'the Connettori toolbar uses icon-buttons, like the prototype');
  const toggleFor = (name) => mount.findAll('button')
    .find((node) => String(node.getAttribute('aria-label') ?? '').startsWith(name));
  const menuVoices = (name) => {
    const menu = mount.querySelector(`div[aria-label="${name}"]`);
    assert.ok(menu, `the ${name} menu renders`);
    return menu.childNodes.filter((node) => node.tagName === 'BUTTON');
  };
  const menuWraps = () => mount.findAll('div')
    .filter((node) => String(node.getAttribute('class') ?? '').split(/\s+/).includes('ui-conn-menuwrap'));
  const cardLabels = () => mount.findAll('strong').map((node) => node.textContent);
  const stato = toggleFor('Stato');
  const ordina = toggleFor('Ordina per');
  assert.ok(stato, 'the Stato icon-button renders');
  assert.ok(ordina, 'the Ordina per icon-button renders');
  assert.equal(stato.getAttribute('aria-label'), 'Stato: Tutti', 'the Stato toggle names its voice');
  assert.ok(stato.findAll('svg').length > 0, 'the Stato toggle shows the filter glyph, not text');
  assert.ok(ordina.findAll('svg').length > 0, 'the Ordina toggle shows the sort glyph, not text');
  stato.dispatch('click');
  assert.deepEqual(
    menuVoices('Stato').map((node) => node.textContent),
    ['Tutti', 'Attivi', 'Da attivare'],
    'the Stato voci match the prototype in order',
  );
  ordina.dispatch('click');
  const statoMenu = mount.querySelector('div[aria-label="Stato"]');
  assert.ok(String(statoMenu.getAttribute('class')).split(/\s+/).includes('hidden'), 'opening Ordina per closes Stato');
  assert.deepEqual(
    menuVoices('Ordina per').map((node) => node.textContent),
    ['Più usati', 'Nome A–Z'],
    'the Ordina voci match the prototype in order',
  );
  menuWraps()[1].dispatch('keydown', { key: 'Escape' });
  const ordinaMenu = mount.querySelector('div[aria-label="Ordina per"]');
  assert.ok(String(ordinaMenu.getAttribute('class')).split(/\s+/).includes('hidden'), 'Escape closes the menu');
  toggleFor('Stato').dispatch('click');
  menuVoices('Stato').find((node) => node.textContent === 'Attivi').dispatch('click');
  await flush();
  assert.deepEqual(cardLabels(), ['WhatsApp'], 'Attivi keeps only connected cards');
  assert.equal(toggleFor('Stato').getAttribute('aria-label'), 'Stato: Attivi', 'the Stato toggle names the picked voice');
  toggleFor('Stato').dispatch('click');
  menuVoices('Stato').find((node) => node.textContent === 'Da attivare').dispatch('click');
  await flush();
  assert.ok(!cardLabels().includes('WhatsApp'), 'Da attivare hides connected cards');
  assert.equal(cardLabels().length, 9, 'Da attivare keeps the other nine');
  toggleFor('Stato').dispatch('click');
  menuVoices('Stato').find((node) => node.textContent === 'Tutti').dispatch('click');
  await flush();
  toggleFor('Ordina per').dispatch('click');
  menuVoices('Ordina per').find((node) => node.textContent === 'Più usati').dispatch('click');
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
  const addMenu = mount.querySelector('.ui-conn-addmenu');
  assert.ok(addMenu, 'the Aggiungi menu renders');
  let menu = addMenu.childNodes.filter((node) => node.tagName === 'BUTTON');
  assert.equal(menu.length, 2, 'the menu opens with two voices');
  const wrap = mount.querySelector('.ui-conn-addwrap');
  assert.ok(wrap, 'the menu lives in its own wrap');
  wrap.dispatch('keydown', { key: 'Escape' });
  const menuBox = mount.querySelector('.ui-conn-addmenu');
  assert.ok(menuBox && String(menuBox.getAttribute('class')).split(/\s+/).includes('hidden'), 'Escape closes the menu');
  add.dispatch('click');
  const ai = mount.findAll('button').find((node) => String(node.textContent).includes('Crea con l\u2019AI'));
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

test('Personalizzazione › Connettori shows Telegram in Canali di conversazione (backlog:2a5651e1933d)', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId });
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Canali di conversazione'), 'the conversation section renders');
  const telegram = mount.findAll('article').find((node) => node.textContent.includes('Telegram'));
  assert.ok(telegram, 'the Telegram card renders');
  assert.ok(telegram.textContent.includes('TG'), 'the card carries the TG sigla');
  assert.ok(telegram.textContent.includes('Messaggi da chat e bot Telegram.'), 'the card carries the Telegram line');
  assert.ok(telegram.textContent.includes('di Telegram · ↔ bidirezionale'), 'the card carries the Telegram provider line');
  telegram.dispatch('click', {});
  assert.ok(navigated.includes('#/connettori/telegram'), 'clicking the card opens the Telegram detail');
  const plus = mount.findAll('button').find((node) => node.getAttribute('aria-label') === 'Collega Telegram');
  assert.ok(plus, 'the Telegram card has its collegamento action');
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

test('every hero slide keeps its prototype eyebrow and its own tiles', async () => {
  const { CONNETTORI_HERO } = await import('../apps/admin/public/admin-personalizzazione.js');
  assert.equal(CONNETTORI_HERO[1].eyebrow, 'Curato da Accordo', 'slide two keeps the prototype eyebrow');
  assert.deepEqual([...CONNETTORI_HERO[1].tiles], ['CAL', 'WEB', 'S'], 'slide two shows agenda tiles, not the Kit-social set');
  assert.deepEqual([...CONNETTORI_HERO[0].tiles], ['IG', 'FB', 'TT', 'WA'], 'slide one keeps the Kit-social tiles');
  assert.deepEqual([...CONNETTORI_HERO[2].tiles], [], 'slide three is mark-only, like the prototype');
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  view.test.state.hero = 1;
  await view.render();
  await flush();
  const tiles = mount.querySelector('.ui-hero-tiles');
  assert.ok(tiles, 'the hero tiles render');
  const chips = tiles.findAll('span').map((node) => node.textContent);
  assert.ok(chips.includes('CAL'), 'slide two renders its own tiles');
  assert.ok(!chips.includes('IG'), 'slide two never reuses the slide-one tiles');
});

test('the Skill toolbar never shows a blank sort after Piu usati on Connettori', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  view.test.state.sort = 'piu-usati';
  view.test.state.tab = 'skill';
  await view.render();
  await flush();
  const selects = mount.findAll('select');
  assert.ok(selects.length > 0, 'the Skill toolbar renders its own sort');
  const sort = selects.find((node) => node.getAttribute('aria-label') === 'Ordina per');
  assert.ok(sort, 'the sort select renders');
  const selected = sort.childNodes.filter((node) => node.getAttribute('selected') === 'selected');
  assert.equal(selected.length, 1, 'exactly one sort voice stays selected');
  assert.equal(selected[0].textContent, 'Ordina: nome', 'Piu usati maps to nome outside Connettori');
});

test('Enter on the in-card + button does not open the detail twice', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const navigated = [];
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: (hash) => navigated.push(hash), spaceId });
  await view.render();
  await flush();
  const card = mount.findAll('article').find((node) => node.textContent.includes('Instagram'));
  assert.ok(card, 'the card renders');
  const before = navigated.length;
  card.dispatch('keydown', { key: 'Enter', target: { closest: (selector) => (selector === 'button' ? {} : null) }, preventDefault: () => {} });
  assert.equal(navigated.length, before, 'a keypress on the + button never opens the detail on top of it');
  card.dispatch('keydown', { key: 'Enter', target: { closest: () => null }, preventDefault: () => {} });
  assert.ok(navigated.includes('#/connettori/instagram'), 'Enter on the card body still opens its detail');
});

test('a refused Skill or Pacchetti action names no channel', async () => {
  const { unitPermissionMessage } = await import('../apps/admin/public/admin-personalizzazione.js');
  assert.equal(unitPermissionMessage('skill'), 'Chiedi al titolare di gestire le skill.', 'the Skill refusal names skills');
  assert.equal(unitPermissionMessage('pacchetti'), 'Chiedi al titolare di gestire i pacchetti.', 'the Pacchetti refusal names packages');
  for (const tab of ['skill', 'pacchetti']) {
    const doc = createFakeDocument();
    const mount = createMount();
    const said = [];
    const client = {
      async request(path, options = {}) {
        if (path === '/api/space-packages/catalog') return { units: UNITS };
        if (path.startsWith('/api/modules/space-package/records')) return { items: [] };
        if (path === '/api/space-packages/activate') throw Object.assign(new Error('denied'), { code: 'FORBIDDEN', status: 403 });
        if (path.startsWith('/api/connectors?')) return { connectors: [] };
        throw new Error(`unexpected request ${path}`);
      },
    };
    const view = createPersonalizzazioneView({
      doc, mount, client, navigate: () => {}, spaceId,
      toast: (message) => said.push(message),
    });
    await view.render();
    await flush();
    view.test.state.tab = tab;
    await view.render();
    await flush();
    const add = mount.findAll('button').find((node) => node.textContent === '+');
    assert.ok(add, `the + action renders on ${tab}`);
    add.dispatch('click', {});
    await flush();
    assert.ok(!said.some((message) => message.includes('canale')), `the ${tab} refusal mentions no channel`);
    assert.ok(said.includes(unitPermissionMessage(tab)), `the ${tab} refusal names what the owner must manage`);
  }
});

test('switching tabs normalizes the shared sort so the toolbar never lies', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient({ connectors: [] });
  const view = createPersonalizzazioneView({ doc, mount, client, navigate: () => {}, spaceId });
  await view.render();
  await flush();
  const tabButton = (label) => mount.findAll('button')
    .find((node) => node.getAttribute('role') === 'tab' && node.textContent.includes(label));
  const selectedSort = () => {
    const sort = mount.findAll('button')
      .find((node) => String(node.getAttribute('aria-label') ?? '').startsWith('Ordina per'));
    assert.ok(sort, 'the sort menu renders');
    return sort.getAttribute('aria-label');
  };
  // On Pacchetti the toolbar leaves sort at 'stato'; entering Connettori,
  // which has no stato voice, must coerce it instead of displaying Nome A-Z
  // over a stato-sorted grid.
  view.test.state.tab = 'pacchetti';
  view.test.state.sort = 'stato';
  await view.render();
  await flush();
  tabButton('Connettori').dispatch('click', {});
  await flush();
  assert.equal(view.test.state.sort, 'nome', 'entering Connettori coerces stato to nome');
  assert.equal(selectedSort(), 'Ordina per: Nome A–Z', 'the Connettori toolbar shows the real sort');
  // The reverse leak: Piu usati is Connettori-only and must not survive the
  // trip back to Skill AI.
  view.test.state.sort = 'piu-usati';
  await view.render();
  await flush();
  tabButton('Skill AI').dispatch('click', {});
  await flush();
  assert.equal(view.test.state.sort, 'nome', 'leaving Connettori coerces piu-usati to nome');
  const skillSort = mount.findAll('select').find((node) => node.getAttribute('aria-label') === 'Ordina per');
  assert.ok(skillSort, 'the Skill sort select renders');
  const skillSelected = skillSort.childNodes.filter((node) => node.getAttribute('selected') === 'selected');
  assert.equal(skillSelected.length, 1, 'exactly one Skill sort voice stays selected');
  assert.equal(skillSelected[0].textContent, 'Ordina: nome', 'the Skill toolbar shows the real sort');
});

test('without permission the hero Inizia, Configura manualmente and Mostra tutto answer in Italian and stay', async () => {
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
  // The hero Inizia CTA (third slide) must answer like the card and its +.
  view.test.state.hero = 2;
  await view.render();
  await flush();
  const inizia = mount.findAll('button').find((node) => node.textContent === 'Inizia');
  assert.ok(inizia, 'the hero Inizia CTA renders');
  inizia.dispatch('click', {});
  assert.ok(said.includes('Chiedi al titolare di collegare questo canale.'), 'Inizia answers in Italian with no codes');
  assert.deepEqual(navigated, [], 'Inizia never leaves the readable page');
  // The Aggiungi voice Configura manualmente navigates: same guard.
  const toggle = mount.findAll('button').find((node) => node.textContent.includes('Aggiungi'));
  assert.ok(toggle, 'the Aggiungi toggle renders');
  toggle.dispatch('click', {});
  const manual = mount.findAll('button').find((node) => String(node.textContent).startsWith('Configura manualmente'));
  assert.ok(manual, 'the Configura manualmente voice renders');
  manual.dispatch('click', {});
  assert.equal(said.filter((message) => message === 'Chiedi al titolare di collegare questo canale.').length, 2, 'Configura manualmente answers in Italian with no codes');
  assert.deepEqual(navigated, [], 'Configura manualmente never leaves the readable page');
  // Mostra tutto leaves for the same guided flow: same guard.
  const all = mount.findAll('button').find((node) => node.textContent.includes('Mostra tutto'));
  assert.ok(all, 'Mostra tutto renders');
  all.dispatch('click', {});
  assert.equal(said.filter((message) => message === 'Chiedi al titolare di collegare questo canale.').length, 3, 'Mostra tutto answers in Italian with no codes');
  assert.deepEqual(navigated, [], 'Mostra tutto never leaves the readable page');
});
