// @ts-check
/**
 * Backoffice BO-F1-03 — Stato sync: the indicator, the fix list and the
 * channel table (backlog:63af493dea0a).
 *
 * What it must prove: the indicator is always visible and honest (ok with a
 * count versus N things to fix, unknown never posing as ok); the channel
 * table carries the last outcome per channel read from the real activity
 * payload; a broken channel names what to do (a real route or the pull
 * button), never just that it is broken; hostile server text stays text;
 * Sincronizza ora pulls once per click through the idempotent submission
 * path and reloads; the view degrades honestly without a space, without the
 * channels package, or on a failed read.
 */
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import assert from 'node:assert/strict';
import {
  SYNC_CHANNELS,
  syncConnectRoute,
  SYNC_GRANT_EXPIRING_DAYS,
  SYNC_ROUTE,
  cataloguedChannel,
  channelLabel,
  createSyncView,
  directionLabel,
  feedClockTime,
  feedKindLabel,
  grantDaysLeft,
  grantExpiring,
  grantExpiryWording,
  healthAuthority,
  healthLabel,
  healthTone,
  syncAgo,
  syncChannelRows,
  syncChannelTable,
  syncFeedItems,
  syncFixItems,
  syncGrantCards,
  syncIdentityCards,
  syncIndicator,
  timeAgo,
} from '../apps/admin/public/admin-sync.js';
import { CLIENTI_IMPORT_ROUTE } from '../apps/admin/public/admin-clienti.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { SETTINGS_AREAS, loadFixCount } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const NOW = Date.parse('2026-10-25T12:00:00.000Z');

const inboxOf = (over = {}) => ({
  received: 10, applied: 9, quarantined: 0, ignored: 0, duplicate: 1, pending: 0,
  lastReceivedAt: '2026-10-25T11:30:00.000Z', ...over,
});

const entryOf = (over = {}) => ({
  connectionKey: 'wa-1',
  channel: 'whatsapp',
  account: '+39 333 1234567',
  adapter: 'whatsapp',
  adapterVersion: 1,
  status: 'active',
  importable: true,
  sync: null,
  inbox: inboxOf(),
  outbox: { openDeadLetters: 0, lastFailedAt: null },
  direction: 'both',
  health: 'ok',
  needsFix: 0,
  ...over,
});

const activityOf = (over = {}) => ({
  spaceId: 'prova',
  connections: [entryOf()],
  feed: [
    { direction: 'in', connectionKey: 'wa-1', channel: 'whatsapp', at: '2026-10-25T11:30:00.000Z', kind: 'applied' },
  ],
  needsFix: 0,
  lastActivityAt: '2026-10-25T11:30:00.000Z',
  ...over,
});

// A composition whose guided channels each have an adapter: every catalog
// channel can connect here (backlog:e381c48581fa — the Collega follows
// the shared channel state, which needs a composed adapter).
const COMPOSED_ADAPTERS = ['whatsapp', 'instagram', 'telegram', 'facebook', 'tiktok', 'sms', 'email', 'voice', 'site-form']
  .map((channel) => ({ channel, name: `${channel}-adapter`, version: 1 }));
const schemaOk = { domains: { channels: { metadata: { channelsContract: 1, adapters: COMPOSED_ADAPTERS } } } };
/** The production pilot: channels composed, no channel adapter at all. */
const schemaNoAdapters = { domains: { channels: { metadata: { channelsContract: 1, adapters: [] } } } };

function fakeClient({ activity = activityOf(), schema = schemaOk, failActivity = null, qualityIssues = [], candidates = [], failCandidates = null, profile = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, options });
      if (String(options.method ?? 'GET').toUpperCase() !== 'GET') {
        if (path === '/api/connectors/sync-now') {
          const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
          if (body?.connectionKey === 'boom') throw new Error('pull esploso');
          return { pulled: 1 };
        }
        if (path.includes('/actions/dismiss-duplicate-candidate')) return { candidate: { id: 'c-1', status: 'dismissed' } };
        throw new Error(`unexpected mutation ${path}`);
      }
      if (path === '/api/schema') return schema;
      if (path.startsWith('/api/connectors/activity')) {
        if (failActivity !== null) throw failActivity;
        return activity;
      }
      if (path === '/api/profile') {
        if (profile === null) throw new Error('profile not served');
        return profile;
      }
      if (path.startsWith('/api/modules/data-quality-issue/records')) return { items: qualityIssues };
      if (path.startsWith('/api/modules/duplicate-candidate/records')) {
        if (failCandidates !== null) throw failCandidates;
        return { items: candidates };
      }
      throw new Error(`unexpected GET ${path}`);
    },
  };
}

const storageOf = (spaceId = 'prova') => ({ getItem: () => spaceId, setItem: () => {}, removeItem: () => {} });

function renderView(over = {}) {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = fakeClient(over.client ?? {});
  const toasts = [];
  const navigated = [];
  const view = createSyncView({
    doc,
    mount,
    client,
    storage: storageOf(over.spaceId),
    navigate: (hash) => navigated.push(hash),
    toast: (message, isError = false) => toasts.push({ message, isError }),
  });
  return { doc, mount, client, toasts, navigated, view };
}

test('Stato sync owns its route and the settings entry points at it', () => {
  assert.equal(SYNC_ROUTE, '#/stato-sync');
  assert.deepEqual(parseModuleRoute('#/stato-sync'), { view: 'sync' });
  assert.deepEqual(parseModuleRoute('#/stato-sync/'), { view: 'sync' });
  assert.equal(parseModuleRoute('#/stato-sync/extra').view, 'invalid');
  const area = SETTINGS_AREAS.find((row) => row.id === 'stato-sync');
  assert.equal(area.route, '#/stato-sync');
  assert.equal(area.story, 'BO-F1-03');
});

test('indicator is ok with a count and fix with N things to fix', () => {
  const ok = syncIndicator(activityOf(), NOW);
  assert.equal(ok.tone, 'ok');
  assert.equal(ok.title, 'Tutto sincronizzato');
  assert.ok(ok.detail.includes('Ultimo aggiornamento 30 min fa'));
  assert.ok(ok.detail.includes('10 eventi ricevuti in tutto.'));

  // Review #680 P2-2: a suspended binding alone is not linked — something
  // to fix, never «quasi tutto sincronizzato» beside «0 di 9».
  const one = syncIndicator(activityOf({ connections: [entryOf({ status: 'suspended', health: 'down' })] }), NOW);
  assert.equal(one.tone, 'fix');
  assert.equal(one.title, 'Nessun canale attivo');
  assert.equal(one.count, 1);

  const two = syncIndicator(activityOf({
    connections: [
      entryOf({ connectionKey: 'a', status: 'suspended', health: 'down' }),
      entryOf({ connectionKey: 'b', status: 'revoked', health: 'down' }),
    ],
  }), NOW);
  assert.equal(two.title, 'Nessun canale attivo');
  assert.equal(two.count, 2);
  const mixed = syncIndicator(activityOf({
    connections: [entryOf({ connectionKey: 'a' }), entryOf({ connectionKey: 'b', channel: 'instagram', status: 'revoked', health: 'down' })],
  }), NOW);
  assert.equal(mixed.title, 'Quasi tutto sincronizzato', 'one active binding plus one to fix');

  // Voce 3a3e6eaf: nothing linked is never "all synced".
  const empty = syncIndicator(activityOf({ connections: [], feed: [], lastActivityAt: null }), NOW);
  assert.equal(empty.tone, 'empty');
  assert.equal(empty.title, 'Nessun canale collegato');
  assert.ok(empty.detail.includes('Collega il primo canale'));

  const unknown = syncIndicator(null, NOW);
  assert.equal(unknown.tone, 'wait');
  assert.ok(!unknown.title.includes('Tutto sincronizzato'));
});

test('syncAgo reads seconds, then minutes, then the longer wording', () => {
  assert.equal(syncAgo('2026-10-25T11:59:58.000Z', NOW), 'adesso');
  assert.equal(syncAgo('2026-10-25T11:59:38.000Z', NOW), '22 s fa');
  assert.equal(syncAgo('2026-10-25T11:58:00.000Z', NOW), '2 min fa');
  assert.equal(syncAgo('2026-10-25T11:30:00.000Z', NOW), '30 min fa');
  assert.equal(syncAgo('2026-10-25T10:00:00.000Z', NOW), timeAgo('2026-10-25T10:00:00.000Z', NOW));
  assert.equal(syncAgo(null, NOW), '—');
  assert.equal(syncAgo('not-a-date', NOW), '—');
});

test('syncing keeps the count and reads as in corso', () => {
  const running = syncIndicator(activityOf({ connections: [entryOf({ status: 'suspended', health: 'down' })] }), NOW, { syncing: true });
  assert.equal(running.tone, 'syncing');
  assert.equal(running.title, 'Sincronizzazione in corso');
  assert.ok(running.detail.includes('in corso…'));
  assert.equal(running.count, 1);
});

test('a broken channel says what to do, with a real destination', () => {
  const items = syncFixItems(activityOf({
    connections: [
      entryOf({ connectionKey: 'a', channel: 'whatsapp', account: '+39 1', status: 'suspended', health: 'down' }),
      entryOf({ connectionKey: 'b', channel: 'instagram', account: 'palestra', status: 'revoked', health: 'down' }),
      entryOf({ connectionKey: 'c', channel: 'email', account: 'info@x.it', status: 'pending', health: 'idle' }),
      entryOf({
        connectionKey: 'd', channel: 'facebook', account: 'Pagina',
        sync: { status: 'failed', lastErrorCode: 'IMPORT_PROVIDER_FAILED' }, health: 'attention',
      }),
      entryOf({
        connectionKey: 'e', channel: 'sms', account: '+39 2',
        inbox: inboxOf({ quarantined: 2 }), health: 'attention', needsFix: 2,
      }),
      entryOf({
        connectionKey: 'f', channel: 'tiktok', account: 'palestra',
        outbox: { openDeadLetters: 1, lastFailedAt: '2026-10-25T10:00:00.000Z' }, health: 'attention', needsFix: 1,
      }),
      entryOf({ connectionKey: 'g', channel: 'voice', account: '+39 02', health: 'idle', inbox: inboxOf({ received: 0, lastReceivedAt: null }) }),
    ],
  }));
  const byKey = new Map(items.map((item) => [item.key, item]));
  assert.equal(items.length, 6);
  assert.equal(byKey.get('a').action.route, '#/connettori');
  assert.ok(byKey.get('a').title.includes('sospeso'));
  assert.equal(byKey.get('b').action.route, '#/connettori');
  assert.ok(byKey.get('b').title.includes('scollegato'));
  assert.equal(byKey.get('c').action.route, '#/connettori');
  assert.deepEqual(byKey.get('d').action, { kind: 'sync-now', label: 'Sincronizza ora', connectionKey: 'd' });
  assert.ok(byKey.get('d').title.includes('si è fermata'));
  assert.ok(!byKey.get('d').title.includes('IMPORT_PROVIDER_FAILED'));
  assert.equal(byKey.get('e:quarantena').action.route, CLIENTI_IMPORT_ROUTE);
  assert.ok(byKey.get('f:invii').action.route.startsWith('#/connettori/'));
  // The merely waiting voice connection is not broken: no item.
  assert.ok(!items.some((item) => item.key === 'g'));
});

test('channel table carries the last outcome per channel', () => {
  const rows = syncChannelRows(activityOf({
    connections: [
      entryOf({ connectionKey: 'a', inbox: inboxOf({ lastReceivedAt: '2026-10-25T11:00:00.000Z' }), outbox: { openDeadLetters: 0, lastFailedAt: null } }),
      entryOf({
        connectionKey: 'b', channel: 'email', account: '',
        inbox: inboxOf({ lastReceivedAt: '2026-10-25T09:00:00.000Z' }),
        outbox: { openDeadLetters: 1, lastFailedAt: '2026-10-25T10:00:00.000Z' }, health: 'attention', needsFix: 1,
      }),
      entryOf({
        connectionKey: 'c', channel: 'sms', account: null,
        inbox: inboxOf({ received: 0, lastReceivedAt: null }),
        outbox: { openDeadLetters: 0, lastFailedAt: null }, direction: null, health: 'idle', importable: false,
      }),
    ],
  }));
  assert.equal(rows.length, 3);
  assert.equal(rows[0].label, 'WhatsApp');
  assert.deepEqual(rows[0].last, { kind: 'arrivo', at: '2026-10-25T11:00:00.000Z' });
  assert.equal(rows[0].canSyncNow, true);
  // The newer failed send wins over the older arrival.
  assert.deepEqual(rows[1].last, { kind: 'invio fallito', at: '2026-10-25T10:00:00.000Z' });
  assert.equal(rows[1].account, '—');
  assert.equal(rows[2].last, null);
  assert.equal(rows[2].direction, '—');
  assert.equal(rows[2].canSyncNow, false);
});

test('labels stay Italian and honest on unknown values', () => {
  assert.equal(healthLabel('ok'), 'A posto');
  assert.equal(healthLabel('idle'), 'In attesa');
  assert.equal(healthLabel('attention'), 'Da sistemare');
  assert.equal(healthLabel('down'), 'Bloccato');
  assert.equal(healthTone('down'), 'down');
  assert.equal(healthTone('attention'), 'fix');
  assert.equal(healthAuthority('down'), 'fault');
  assert.equal(healthAuthority('attention'), 'human');
  assert.equal(healthAuthority('idle'), 'policy');
  assert.equal(healthAuthority('ok'), 'accord');
  assert.equal(directionLabel('in'), '← entra');
  assert.equal(directionLabel('out'), '→ esce');
  assert.equal(directionLabel('both'), '↔ entrambi');
  assert.equal(directionLabel(null), '—');
  assert.equal(channelLabel('whatsapp'), 'WhatsApp');
  assert.equal(channelLabel('sconosciuto'), 'sconosciuto');
  assert.equal(channelLabel(''), 'Canale');
  assert.equal(feedKindLabel('applied'), 'registrato');
  assert.equal(feedKindLabel('quarantined'), 'in attesa di decisione');
  assert.equal(feedKindLabel('dead-letter', 'CHANNEL_SEND_FAILED'), 'invio fermo');
  assert.equal(timeAgo('2026-10-25T11:59:30.000Z', NOW), 'adesso');
  assert.equal(timeAgo('2026-10-25T11:30:00.000Z', NOW), '30 minuti fa');
  assert.equal(timeAgo('2026-10-25T09:00:00.000Z', NOW), '3 ore fa');
  assert.equal(timeAgo('non-una-data', NOW), '—');
  assert.equal(timeAgo(null, NOW), '—');
});

test('feed lists newest-first events without payload or provider wording', () => {
  const items = syncFeedItems(activityOf({
    feed: [
      { direction: 'in', connectionKey: 'wa-1', channel: 'whatsapp', at: '2026-10-25T11:30:00.000Z', kind: 'applied' },
      { direction: 'out', connectionKey: 'wa-1', channel: 'whatsapp', at: '2026-10-25T11:00:00.000Z', kind: 'dead-letter', code: 'CHANNEL_SEND_FAILED' },
      { direction: 'in', connectionKey: 'x', channel: 'x', at: null, kind: 'applied' },
    ],
  }));
  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    at: '2026-10-25T11:30:00.000Z', clock: '12:30:00', arrow: '←', channel: 'WhatsApp', text: 'registrato',
  });
  assert.equal(items[1].text, 'invio fermo');
  assert.deepEqual(syncFeedItems(null), []);
});

test('the screen renders indicator, fixes, table and feed from live activity', async () => {
  const { mount, view, toasts } = renderView({
    client: {
      activity: activityOf({
        connections: [
          entryOf({ status: 'suspended', health: 'down', needsFix: 0 }),
          entryOf({ connectionKey: 'ig-1', channel: 'instagram', account: 'palestra.esempio' }),
        ],
        needsFix: 1,
      }),
    },
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.equal(toasts.length, 0);
  for (const expected of ['IMPOSTAZIONI', 'Personalizzazione', 'Catalogo prodotti', 'Stato sync', 'Spazi e accessi', 'Quasi tutto sincronizzato', 'Da sistemare 1', 'sospeso', 'Riattiva da Connettori', 'Canali', 'WhatsApp', 'Instagram', 'Sincronizza ora', 'In tempo reale', '← entra']) {
    assert.ok(text.includes(expected), `screen shows ${expected}`);
  }
  // The Stato sync tab is the open one and carries the fix count.
  const tabs = mount.findAll('button').filter((node) => node.getAttribute('data-tab') !== null);
  assert.deepEqual(tabs.map((node) => node.textContent), ['Personalizzazione', 'Catalogo prodotti', 'Stato sync1', 'Spazi e accessi']);
  assert.equal(tabs.find((node) => node.getAttribute('data-tab') === 'stato-sync').getAttribute('aria-selected'), 'true');
});

test('the ok screen says nothing is broken and still shows the table', async () => {
  const { mount, view } = renderView();
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Tutto sincronizzato'));
  assert.ok(text.includes('✓ Niente da sistemare. Se qualcosa si blocca, ti avviso io.'));
  assert.ok(text.includes('Ultimo aggiornamento'));
  assert.ok(text.includes('eventi ricevuti in tutto.'));
  assert.ok(text.includes('WhatsApp'));
  assert.equal(mount.findAll('table').length, 1);
  // No badge on the Stato sync tab while there is nothing to fix.
  const tab = mount.findAll('button').find((node) => node.getAttribute('data-tab') === 'stato-sync');
  assert.ok(!tab.textContent.includes('da sistemare'));
});

test('every control on the screen carries the visual-system classes', async () => {
  for (const activity of [
    activityOf(),
    activityOf({ connections: [entryOf({ status: 'suspended', health: 'down' })] }),
  ]) {
    const { mount, view } = renderView({ client: { activity } });
    await view.render();
    await flush();
    const controls = [
      ...mount.findAll('button'),
      ...mount.findAll('select'),
      ...mount.findAll('input'),
      ...mount.findAll('textarea'),
    ];
    assert.ok(controls.length > 0, 'the screen renders controls');
    for (const control of controls) {
      const classes = (control.getAttribute('class') ?? '').split(/\s+/);
      assert.ok(classes.some((cls) => cls === 'ui' || cls.startsWith('ui-')), `control keeps a ui-* class: ${control.textContent}`);
    }
  }
});

test('the hero pull updates every syncable connection with one toast', async () => {
  const { mount, client, view, toasts } = renderView({
    client: {
      activity: activityOf({
        connections: [
          entryOf(),
          entryOf({ connectionKey: 'ig-1', channel: 'instagram', account: 'palestra.esempio' }),
        ],
      }),
    },
  });
  await view.render();
  await flush();
  const hero = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'sync-all');
  assert.equal(hero.textContent, 'Sincronizza ora');
  // A double click on the global pull is a single pass, like the row guard.
  hero.dispatch('click');
  hero.dispatch('click');
  await flush(12);
  const pulls = client.calls.filter((call) => call.path === '/api/connectors/sync-now');
  assert.equal(pulls.length, 2);
  assert.deepEqual(pulls.map((pull) => JSON.parse(pull.options.body).connectionKey).sort(), ['ig-1', 'wa-1']);
  assert.equal(toasts.filter((toast) => !toast.isError).length, 1);
  // After the pass the hero button is back and enabled.
  const rebuilt = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'sync-all');
  assert.equal(rebuilt.textContent, 'Sincronizza ora');
  assert.equal(rebuilt.getAttribute('disabled'), null);
});

test('a lot started in one space finishes in that space after a mid-lot switch', async () => {
  // backlog:0e848a46e53a: il lotto cattura lo spazio alla partenza — un
  // cambio spazio a lotto in corso non sposta le pull restanti (con le chiavi
  // dello spazio vecchio) nello spazio nuovo.
  let space = 'prova';
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  let pulls = 0;
  const switching = {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, options });
      if (String(options.method ?? 'GET').toUpperCase() !== 'GET') {
        if (path === '/api/connectors/sync-now') {
          pulls += 1;
          if (pulls === 1) await firstGate;
          return { pulled: 1 };
        }
        throw new Error(`unexpected mutation ${path}`);
      }
      if (path === '/api/schema') return schemaOk;
      if (path.startsWith('/api/connectors/activity')) {
        return activityOf({
          connections: [
            entryOf(),
            entryOf({ connectionKey: 'ig-1', channel: 'instagram', account: 'palestra.esempio' }),
          ],
        });
      }
      if (path === '/api/profile') throw new Error('profile not served');
      if (path.startsWith('/api/modules/duplicate-candidate/records')) return { items: [] };
      throw new Error(`unexpected GET ${path}`);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const seen = [];
  const view = createSyncView({
    doc,
    mount,
    client: switching,
    storage: { getItem: () => space, setItem: () => {}, removeItem: () => {} },
    navigate: () => {},
    toast: (message, isError) => { seen.push({ message, isError }); },
  });
  await view.render();
  await flush();
  const hero = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'sync-all');
  hero.dispatch('click');
  await flush(3);
  assert.equal(calls.filter((call) => call.path === '/api/connectors/sync-now').length, 1);
  // L'operatore cambia spazio a lotto in corso: l'host ri-renderizza, come onPickSpace.
  space = 'nuova';
  await view.render();
  await flush();
  releaseFirst();
  await flush(15);
  const lotto = calls.filter((call) => call.path === '/api/connectors/sync-now');
  assert.equal(lotto.length, 2);
  for (const pull of lotto) {
    assert.equal(JSON.parse(pull.options.body).spaceId, 'prova');
  }
  // A lotto finito la vista segue lo spazio nuovo.
  const reads = calls.filter((call) => call.path.startsWith('/api/connectors/activity'));
  assert.ok(reads[reads.length - 1].path.includes('spaceId=nuova'));
  // Ma il successo non è senza qualifica: il lotto ha tirato 'prova' e
  // dipinge 'nuova' — il toast lo dice, senza fingere 'nuova' sincronizzata.
  assert.ok(!seen.some((toast) => toast.message === 'Sincronizzazione aggiornata.'));
  assert.ok(seen.some((toast) => toast.message.includes('spazio di partenza')));
});

test('hostile server text stays text, never markup', async () => {
  const hostile = '<script>alert(1)</script>';
  const { mount, view } = renderView({
    client: {
      activity: activityOf({
        connections: [entryOf({ channel: hostile, account: hostile, connectionKey: 'h-1' })],
        feed: [{ direction: 'in', connectionKey: 'h-1', channel: hostile, at: '2026-10-25T11:30:00.000Z', kind: hostile }],
      }),
    },
  });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes(hostile));
  assert.equal(mount.findAll('script').length, 0);
});

test('Sincronizza ora pulls once per click and reloads the screen', async () => {
  const { mount, client, view } = renderView({
    client: { activity: activityOf({ connections: [entryOf({ sync: { status: 'failed', lastErrorCode: 'X' }, health: 'attention', needsFix: 0 })] }) },
  });
  await view.render();
  await flush();
  // The failed import owns one row-level control (the fix-item action):
  // the prototype pulls globally from the hero, never per row, so the
  // table carries no pull buttons (the hero pull is the other
  // `Sincronizza ora` on screen, with data-action="sync-all").
  const buttons = mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'sync-now');
  assert.equal(buttons.length, 1);
  // A double click on the same control joins the pending pull: one request.
  buttons[0].dispatch('click');
  buttons[0].dispatch('click');
  await flush(12);
  const pulls = client.calls.filter((call) => call.path === '/api/connectors/sync-now');
  assert.equal(pulls.length, 1);
  assert.equal(JSON.parse(pulls[0].options.body).connectionKey, 'wa-1');
  assert.equal(JSON.parse(pulls[0].options.body).spaceId, 'prova');
});

test('a failed pull toasts the cause and leaves the button usable', async () => {
  const { mount, view, toasts } = renderView({
    client: { activity: activityOf({ connections: [entryOf({ connectionKey: 'boom', sync: { status: 'failed', lastErrorCode: 'X' }, health: 'attention', needsFix: 0 })] }) },
  });
  await view.render();
  await flush();
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'sync-now').dispatch('click');
  await flush(12);
  assert.equal(toasts.filter((toast) => toast.isError).length, 1);
  assert.ok(mount.findAll('button').some((node) => node.textContent === 'Sincronizza ora'));
});

test('a successful pull releases the guard so the next click pulls again', async () => {
  const { mount, client, view } = renderView({
    client: { activity: activityOf({ connections: [entryOf({ sync: { status: 'failed', lastErrorCode: 'X' }, health: 'attention', needsFix: 0 })] }) },
  });
  await view.render();
  await flush();
  const pulls = () => client.calls.filter((call) => call.path === '/api/connectors/sync-now');
  mount.findAll('button').find((node) => node.getAttribute('data-action') === 'sync-now').dispatch('click');
  await flush(12);
  assert.equal(pulls().length, 1);
  // The rebuilt controls after a successful pull are enabled: a second
  // click performs a second pull instead of staying disabled for the
  // session.
  const rebuilt = mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'sync-now');
  assert.equal(rebuilt.length, 1);
  rebuilt[0].dispatch('click');
  await flush(12);
  assert.equal(pulls().length, 2);
});

test('the view follows a space switch instead of keeping the old activity', async () => {
  let space = 'prova';
  const doc = createFakeDocument();
  const mount = createMount();
  const client = fakeClient();
  const view = createSyncView({
    doc,
    mount,
    client,
    storage: { getItem: () => space, setItem: () => {}, removeItem: () => {} },
    navigate: () => {},
    toast: () => {},
  });
  await view.render();
  await flush();
  const reads = () => client.calls.filter((call) => call.path.startsWith('/api/connectors/activity'));
  assert.equal(reads().length, 1);
  assert.ok(reads()[0].path.includes('spaceId=prova'));
  // The host re-renders this screen on a space change (app.js onPickSpace):
  // the view re-reads the storage and never submits for the old space.
  space = 'nuova';
  await view.render();
  await flush();
  assert.equal(reads().length, 2);
  assert.ok(reads()[1].path.includes('spaceId=nuova'));
});

test('the live session space drives the view when storage is empty', async () => {
  // Under a space mount the session names the space; the stored local pick
  // is empty on a fresh browser, and the screen must still show the current
  // space's state instead of asking to choose one (backlog:e5fec544).
  const doc = createFakeDocument();
  const mount = createMount();
  const client = fakeClient();
  const view = createSyncView({
    doc,
    mount,
    client,
    storage: { getItem: () => '', setItem: () => {}, removeItem: () => {} },
    spaceId: () => 'spazio-sessione',
    navigate: () => {},
    toast: () => {},
  });
  await view.render();
  await flush();
  const reads = () => client.calls.filter((call) => call.path.startsWith('/api/connectors/activity'));
  assert.equal(reads().length, 1);
  assert.ok(reads()[0].path.includes('spaceId=spazio-sessione'));
  assert.ok(mount.textContent.includes('Tutto sincronizzato'));
  assert.ok(!mount.textContent.includes('Scegli uno spazio'));
});

test('an explicit live space wins over a stale stored one', async () => {
  // The live session space wins (admin-shell resolveBadgeSpaceId counts the
  // badge the same way): a stored pick from another identity never steers
  // this screen.
  const doc = createFakeDocument();
  const mount = createMount();
  const client = fakeClient();
  const view = createSyncView({
    doc,
    mount,
    client,
    storage: { getItem: () => 'vecchio', setItem: () => {}, removeItem: () => {} },
    spaceId: () => 'sessione',
    navigate: () => {},
    toast: () => {},
  });
  await view.render();
  await flush();
  const reads = () => client.calls.filter((call) => call.path.startsWith('/api/connectors/activity'));
  assert.equal(reads().length, 1);
  assert.ok(reads()[0].path.includes('spaceId=sessione'));
});

test('the view degrades honestly: no space, no channels, failed read', async () => {
  const noSpace = renderView({ spaceId: '' });
  await noSpace.view.render();
  await flush();
  assert.ok(noSpace.mount.textContent.includes('Scegli uno spazio'));

  const noChannels = renderView({ client: { schema: { domains: {} } } });
  await noChannels.view.render();
  await flush();
  assert.ok(noChannels.mount.textContent.includes('non è attiva in questo spazio'));

  // The shared hosting composes the read-only Reader Channels domain, with
  // no channelsContract: the activity is still read (production, 04/11).
  const reader = renderView({ client: { schema: { domains: { channels: { packageContract: 2, version: 1, label: 'Reader Channels' } } } } });
  await reader.view.render();
  await flush();
  assert.ok(!reader.mount.textContent.includes('non è attiva'), 'reader channels read the activity');
  assert.ok(reader.client.calls.some((call) => call.path.startsWith('/api/connectors/activity')), 'the activity is requested');

  const failed = renderView({ client: { failActivity: new Error('giù') } });
  await failed.view.render();
  await flush();
  assert.ok(failed.mount.textContent.includes('non è riuscita'));
  assert.ok(!failed.mount.textContent.includes('giù'));
  assert.equal(failed.toasts.filter((toast) => toast.isError).length, 1);
  assert.ok(!failed.mount.textContent.includes('Tutto sincronizzato'));
  // The tabs stay on screen even in the honest edge states.
  assert.ok(failed.mount.textContent.includes('IMPOSTAZIONI'));
});

test('badge count adds the sync attention rows when a space is selected', async () => {
  const client = fakeClient();
  assert.equal(await loadFixCount(client), 0);
  assert.equal(await loadFixCount(client, { spaceId: 'prova' }), 0);

  // Quality rows and sync rows add up: 2 open issues + 3 sync attention rows.
  const withFix = fakeClient({
    activity: activityOf({ needsFix: 3 }),
    qualityIssues: [{ status: 'open' }, { status: 'open' }, { status: 'closed' }],
  });
  assert.equal(await loadFixCount(withFix, { spaceId: 'prova' }), 5);

  // A failed sync read keeps the quality count instead of failing the badge.
  const syncDown = fakeClient({ failActivity: new Error('giù') });
  assert.equal(await loadFixCount(syncDown, { spaceId: 'prova' }), 0);
});

test('the Canali card lists the nine fixed prototype channels', () => {
  assert.equal(SYNC_CHANNELS.length, 9);
  assert.deepEqual(SYNC_CHANNELS.map((row) => row.id), [
    'whatsapp', 'instagram', 'facebook', 'tiktok', 'email', 'voice', 'site-form', 'calendar', 'stripe',
  ]);
  const byId = new Map(SYNC_CHANNELS.map((row) => [row.id, row]));
  assert.equal(byId.get('whatsapp').name, 'WhatsApp');
  assert.equal(byId.get('voice').name, 'Telefono');
  assert.equal(byId.get('site-form').name, 'Form sito');
  assert.equal(byId.get('calendar').name, 'Google Calendar');
  assert.deepEqual(SYNC_CHANNELS.map((row) => row.mark), ['WA', 'IG', 'FB', 'TT', '@', 'TEL', 'WEB', 'CAL', 'S']);
  assert.equal(byId.get('tiktok').direction, '← in entrata');
  assert.equal(byId.get('site-form').direction, '← in entrata');
  assert.equal(byId.get('stripe').direction, '↔ pagamenti e link');
  assert.equal(byId.get('whatsapp').direction, '↔ bidirezionale');
});

test('grant expiry reads whole days and the pill window', () => {
  assert.equal(SYNC_GRANT_EXPIRING_DAYS, 7);
  assert.equal(grantDaysLeft('2026-10-28T12:00:00.000Z', NOW), 3);
  assert.equal(grantDaysLeft('2026-10-18T12:00:00.000Z', NOW), -7);
  assert.equal(grantDaysLeft(null, NOW), null);
  assert.equal(grantDaysLeft('not-a-date', NOW), null);
  assert.equal(grantExpiring('2026-10-28T12:00:00.000Z', NOW), true);
  assert.equal(grantExpiring('2026-11-01T12:00:00.000Z', NOW), true);
  assert.equal(grantExpiring('2026-11-02T12:00:00.000Z', NOW), false);
  assert.equal(grantExpiring(null, NOW), false);
});

test('the channel table aggregates one row per fixed channel', () => {
  const rows = syncChannelTable(activityOf({
    connections: [
      entryOf(),
      entryOf({
        connectionKey: 'ig-1', channel: 'instagram', inbox: inboxOf({ received: 4, lastReceivedAt: '2026-10-25T11:45:00.000Z' }),
      }),
      entryOf({
        connectionKey: 'sms-1', channel: 'sms', inbox: inboxOf({ received: 1, lastReceivedAt: '2026-10-25T10:00:00.000Z' }),
      }),
    ],
  }));
  // Nine fixed rows plus the connected outsider, never in their place.
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.slice(0, 9).map((row) => row.channel), SYNC_CHANNELS.map((row) => row.id));
  assert.equal(rows[9].channel, 'sms');
  const wa = rows[0];
  assert.equal(wa.label, 'WhatsApp');
  assert.equal(wa.mark, 'WA');
  assert.equal(wa.direction, '↔ bidirezionale');
  assert.equal(wa.connected, true);
  assert.equal(wa.received, 10);
  assert.equal(wa.lastAt, '2026-10-25T11:30:00.000Z');
  assert.deepEqual(wa.pill, { text: 'Attivo', tone: 'attivo' });
  assert.deepEqual(wa.keys, ['wa-1']);
  const email = rows.find((row) => row.channel === 'email');
  assert.equal(email.connected, false);
  assert.equal(email.pill, null);
  assert.equal(email.direction, '↔ bidirezionale');
  assert.deepEqual(email.keys, []);
  // Two bindings of one channel aggregate: events sum, latest wins.
  const merged = syncChannelTable(activityOf({
    connections: [
      entryOf({ inbox: inboxOf({ received: 10, lastReceivedAt: '2026-10-25T09:00:00.000Z' }) }),
      entryOf({ connectionKey: 'wa-2', inbox: inboxOf({ received: 5, lastReceivedAt: '2026-10-25T11:00:00.000Z' }) }),
    ],
  }));
  assert.equal(merged[0].received, 15);
  assert.equal(merged[0].lastAt, '2026-10-25T11:00:00.000Z');
  assert.deepEqual(merged[0].keys.sort(), ['wa-1', 'wa-2']);
  // No connections: nine unconnected rows, zero invented.
  const empty = syncChannelTable(activityOf({ connections: [] }));
  assert.equal(empty.length, 9);
  assert.ok(empty.every((row) => row.connected === false && row.pill === null));
  assert.deepEqual(syncChannelTable(null).length, 9);
});

test('the channel pill names expiry and import before the calm Attivo', () => {
  const expiring = syncChannelTable(activityOf({
    connections: [entryOf({ channel: 'instagram', connectionKey: 'ig-1', grantExpiresAt: '2026-10-28T12:00:00.000Z' })],
  }));
  assert.deepEqual(expiring.find((row) => row.channel === 'instagram').pill, { text: 'Permesso in scadenza', tone: 'permesso' });
  // A far-future expiry stays calm.
  const calm = syncChannelTable(activityOf({
    connections: [entryOf({ grantExpiresAt: '2026-12-25T12:00:00.000Z' })],
  }));
  assert.deepEqual(calm[0].pill, { text: 'Attivo', tone: 'attivo' });
  // A running import reads Importazione even without an expiry.
  const importing = syncChannelTable(activityOf({
    connections: [entryOf({ sync: { status: 'running' }, health: 'ok' })],
  }));
  assert.deepEqual(importing[0].pill, { text: 'Importazione', tone: 'importazione' });
  // Broken health never poses as Attivo: the closest word the spec
  // vocabulary allows is the section that fixes it (08/11, C20).
  const down = syncChannelTable(activityOf({
    connections: [entryOf({ status: 'suspended', health: 'down' })],
  }));
  assert.equal(down[0].pill.text, 'Da sistemare');
  assert.equal(down[0].pill.tone, 'altro');
});

test('the yellow grant cards use the prototype wording, soonest first', () => {
  const cards = syncGrantCards(activityOf({
    connections: [
      entryOf({ connectionKey: 'ig-1', channel: 'instagram', grantExpiresAt: '2026-10-28T12:00:00.000Z' }),
      entryOf({ connectionKey: 'tt-1', channel: 'tiktok', grantExpiresAt: '2026-10-26T12:00:00.000Z' }),
      entryOf({ status: 'pending', health: 'idle' }),
      entryOf({ connectionKey: 'wa-far', grantExpiresAt: '2026-12-25T12:00:00.000Z' }),
    ],
  }), NOW);
  // Only active bindings inside the window: the far-future grant, the
  // expiry-less whatsapp and the pending row stay out.
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, 'Il permesso di TikTok scade domani');
  assert.equal(cards[0].route, '#/connettori/tiktok?binding=tt-1');
  assert.equal(cards[1].title, 'Il permesso di Instagram scade tra 3 giorni');
  assert.equal(cards[1].detail, 'Rinnovalo ora per continuare a ricevere i DM nelle schede clienti.');
  assert.equal(cards[1].route, '#/connettori/instagram?binding=ig-1');
  const others = syncGrantCards(activityOf({
    connections: [entryOf({ connectionKey: 'wa-1', grantExpiresAt: '2026-10-25T18:00:00.000Z' })],
  }), NOW);
  assert.equal(others[0].title, 'Il permesso di WhatsApp scade oggi');
  assert.equal(others[0].detail, 'Rinnovalo ora per non perdere i nuovi arrivi nelle schede clienti.');
  const past = syncGrantCards(activityOf({
    connections: [entryOf({ connectionKey: 'wa-1', grantExpiresAt: '2026-10-20T12:00:00.000Z' })],
  }), NOW);
  assert.equal(past[0].title, 'Il permesso di WhatsApp è scaduto');
  assert.deepEqual(syncGrantCards(null, NOW), []);
});

test('the yellow grant card names its binding, so the detail renews that row', () => {
  const key = 'ch-conn/presti/whatsapp/+390200000002';
  const cards = syncGrantCards(activityOf({
    connections: [entryOf({ connectionKey: key, grantExpiresAt: '2026-10-28T12:00:00.000Z' })],
  }), NOW);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].route, `#/connettori/whatsapp?binding=${encodeURIComponent(key)}`);
  assert.ok(!cards[0].route.includes(' '), 'no raw spaces in the route');
  assert.ok(!cards[0].route.includes('+3902'), 'the account travels encoded, never raw');
});

test('the purple identity cards name people, never record codes', () => {
  const cards = syncIdentityCards([
    { id: 'c-1', status: 'unresolved', leftLabel: 'Paolo Esposito', rightLabel: 'Paolo Esposito' },
    { id: 'c-2', status: 'unresolved', leftLabel: 'Paolo Esposito', rightLabel: '+39 333 0000000' },
    { id: 'c-3', status: 'dismissed', leftLabel: 'X', rightLabel: 'Y' },
    { id: 'c-4', status: 'unresolved', leftId: 'contatto-1' },
    { status: 'unresolved' },
    null,
  ]);
  assert.equal(cards.length, 3);
  assert.equal(cards[0].title, 'Paolo Esposito potrebbe avere due schede');
  assert.equal(cards[1].title, 'Paolo Esposito e +39 333 0000000 potrebbero essere la stessa persona');
  assert.equal(cards[2].title, 'contatto-1 potrebbe avere una seconda scheda');
  for (const card of cards) {
    assert.ok(!card.title.includes('duplicate-candidate'));
    assert.ok(!card.title.includes('task-'));
  }
  assert.deepEqual(syncIdentityCards(null), []);
});

test('the live feed reads the Rome clock, never UTC', () => {
  assert.equal(feedClockTime('2026-07-15T10:30:00.000Z'), '12:30:00');
  assert.equal(feedClockTime('not-a-date'), '—');
  assert.equal(feedClockTime(null), '—');
  assert.equal(feedClockTime(''), '—');
});

test('the indicator counts candidates and grants with the channel fixes', () => {
  const withCandidates = syncIndicator(activityOf(), NOW, { extraCount: 2 });
  assert.equal(withCandidates.tone, 'fix');
  assert.equal(withCandidates.title, 'Quasi tutto sincronizzato');
  assert.equal(withCandidates.count, 2);
  // An expiring grant alone turns the hero even with no other fix.
  const grantOnly = syncIndicator(activityOf({
    connections: [entryOf({ grantExpiresAt: '2026-10-28T12:00:00.000Z' })],
  }), NOW);
  assert.equal(grantOnly.tone, 'fix');
  assert.equal(grantOnly.count, 1);
});

test('the table renders nine rows with the count, agg and pills', async () => {
  const { mount, view } = renderView({
    client: {
      activity: activityOf({
        connections: [
          entryOf(),
          entryOf({ connectionKey: 'ig-1', channel: 'instagram', grantExpiresAt: new Date(Date.now() + 3.5 * 86400000).toISOString() }),
        ],
      }),
    },
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  // The spec count: «di 9», like the nine rows (C16).
  assert.ok(text.includes('2 di 9 collegati'), 'the card counts the nine');
  for (const name of ['WhatsApp', 'Instagram', 'Facebook', 'TikTok', 'Email', 'Telefono', 'Form sito', 'Google Calendar', 'Stripe']) {
    assert.ok(text.includes(name), `the table names ${name}`);
  }
  assert.ok(text.includes('↔ bidirezionale'));
  assert.ok(text.includes('↔ pagamenti e link'));
  assert.ok(text.includes('← in entrata'));
  assert.ok(text.includes('10 eventi ricevuti'));
  assert.ok(text.includes('Permesso in scadenza'));
  assert.ok(text.includes('Attivo'));
  // Every unconnected catalogued channel offers the guided flow; the fixed
  // rows no catalog can connect (Google Calendar, Stripe) read `Non
  // disponibile` instead of a `Collega` link to a dead end.
  const collega = mount.findAll('a').filter((node) => node.textContent === 'Collega');
  assert.equal(collega.length, 5);
  assert.deepEqual(collega.map((node) => node.getAttribute('href')).sort(), [
    '#/connettori/email', '#/connettori/facebook',
    '#/connettori/site-form', '#/connettori/tiktok', '#/connettori/voice',
  ]);
  assert.ok(!text.includes('Non disponibile'), 'C19: an unlinked row says non collegato');
  // No per-row pull: the table carries no sync-now buttons.
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'sync-now').length, 0);
});

test('the empty space still lists nine connectable rows', async () => {
  const { mount, view } = renderView({
    client: { activity: activityOf({ connections: [], feed: [], lastActivityAt: null }) },
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('0 di 9 collegati'));
  assert.equal(mount.findAll('a').filter((node) => node.textContent === 'Collega').length, 7);
  assert.equal(mount.findAll('span').filter((node) => node.textContent === 'non collegato').length, 2,
    'Google Calendar and Stripe, which nothing here connects without the profile, read non collegato');
});

test('a failed read offers Riprova and retries on click', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = fakeClient({ failActivity: new Error('giù') });
  const view = createSyncView({
    doc, mount, client, storage: { getItem: () => 'prova', setItem: () => {}, removeItem: () => {} },
    navigate: () => {}, toast: () => {},
  });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('non è riuscita'));
  assert.ok(!mount.textContent.includes('giù'));
  const retry = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'retry');
  assert.equal(retry.textContent, 'Riprova');
  retry.dispatch('click');
  await flush(12);
  assert.ok(client.calls.filter((call) => call.path.startsWith('/api/connectors/activity')).length >= 2);
});

test('the observer watches without touching', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const toasts = [];
  const client = fakeClient({
    activity: activityOf({
      connections: [entryOf({ sync: { status: 'failed', lastErrorCode: 'X' }, health: 'attention', needsFix: 0 })],
    }),
    candidates: [{ id: 'c-1', status: 'unresolved', leftLabel: 'Paolo Esposito', rightLabel: 'Paolo Esposito' }],
  });
  const view = createSyncView({
    doc, mount, client, role: () => 'observer',
    storage: { getItem: () => 'prova', setItem: () => {}, removeItem: () => {} },
    navigate: () => {}, toast: (message, isError = false) => toasts.push({ message, isError }),
  });
  await view.render();
  await flush();
  const text = mount.textContent;
  // Data stays visible; the purple card keeps its honest title.
  assert.ok(text.includes('Paolo Esposito potrebbe avere due schede'));
  assert.ok(text.includes('Decido io'));
  assert.ok(text.includes('Sola lettura (Osservatore)'));
  // Every write control hides: hero pull, fix pull, keep-both, Collega.
  assert.ok(mount.findAll('button').every((node) => node.textContent !== 'Sincronizza ora' || node.getAttribute('hidden') !== null));
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'sync-now').length, 0);
  assert.equal(mount.findAll('button').filter((node) => node.textContent === 'Sì, tienili entrambi').length, 0);
  assert.equal(mount.findAll('a').filter((node) => node.textContent === 'Collega').length, 0);
});

test('keep-both dismisses through the record action, decide routes to quality', async () => {
  const { mount, client, view, toasts } = renderView({
    client: {
      candidates: [{ id: 'c-1', status: 'unresolved', leftLabel: 'Paolo Esposito', rightLabel: 'Paolo Esposito' }],
    },
  });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('Da sistemare 1'));
  assert.ok(mount.textContent.includes('Paolo Esposito potrebbe avere due schede'));
  const keep = mount.findAll('button').find((node) => node.textContent === 'Sì, tienili entrambi');
  assert.ok(keep);
  keep.dispatch('click');
  await flush(12);
  const dismissed = client.calls.filter((call) => call.path.includes('/actions/dismiss-duplicate-candidate'));
  assert.equal(dismissed.length, 1);
  assert.ok(dismissed[0].path.includes('/api/modules/duplicate-candidate/records/c-1/'));
  assert.ok(!toasts.some((toast) => toast.isError));
  const decide = mount.findAll('a').find((node) => node.textContent === 'Decido io');
  assert.equal(decide.getAttribute('href'), CLIENTI_IMPORT_ROUTE);
});

test('the yellow card renews through the connector detail', async () => {
  const { mount, view, navigated } = renderView({
    client: {
      activity: activityOf({
        connections: [entryOf({
          connectionKey: 'ig-1', channel: 'instagram', account: 'palestra.esempio',
          grantExpiresAt: new Date(Date.now() + 3.5 * 86400000).toISOString(),
        })],
      }),
    },
  });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('Il permesso di Instagram scade tra 3 giorni'));
  assert.ok(mount.textContent.includes('Rinnovalo ora per continuare a ricevere i DM nelle schede clienti.'));
  const renew = mount.findAll('a').find((node) => node.textContent === 'Rinnova in un clic');
  assert.equal(renew.getAttribute('href'), '#/connettori/instagram?binding=ig-1');
  renew.dispatch('click');
  await flush();
  assert.deepEqual(navigated, ['#/connettori/instagram?binding=ig-1']);
});

test('the candidates read narrows to unresolved on the server', async () => {
  const { mount, client, view } = renderView({
    client: {
      candidates: [{ id: 'c-1', status: 'unresolved', leftLabel: 'Paolo Esposito', rightLabel: 'Paolo Esposito' }],
    },
  });
  await view.render();
  await flush();
  const reads = client.calls.filter((call) => call.path.startsWith('/api/modules/duplicate-candidate/records'));
  assert.equal(reads.length, 1);
  assert.ok(reads[0].path.includes('filter.status=unresolved'), 'a resolved history beyond the page bound cannot hide a decision');
  assert.ok(mount.textContent.includes('Paolo Esposito potrebbe avere due schede'));
});

test('a failed candidates read stays honest: no quiet banner, one diagnostic', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const { mount, view } = renderView({
      client: { failCandidates: { code: 'UPSTREAM_BOOM', status: 502, message: 'giù' } },
    });
    await view.render();
    await flush();
    const text = mount.textContent;
    assert.ok(!text.includes('Niente da sistemare'), 'never claims all fixed while identity decisions are unread');
    assert.ok(text.includes('non si sono potute leggere'), 'the section names what it could not read');
    assert.ok(!text.includes('giù') && !text.includes('UPSTREAM_BOOM'), 'no technical detail in the DOM');
    assert.equal(warnings.length, 1, 'one diagnostic: neither silence nor a screen');
    const flat = warnings[0].map(String).join(' ');
    assert.ok(flat.includes('bo-sync'), 'the log is scoped to the sync screen');
    assert.ok(flat.includes('UPSTREAM_BOOM'), 'the sanitized code travels');
    assert.ok(flat.includes('prova'), 'the active space travels');
  } finally {
    console.warn = originalWarn;
  }
});

test('only catalogued channels have a detail flow', () => {
  assert.ok(cataloguedChannel('whatsapp'));
  assert.ok(cataloguedChannel('site-form'));
  assert.ok(!cataloguedChannel('calendar'));
  assert.ok(!cataloguedChannel('stripe'));
  assert.ok(!cataloguedChannel('nope'));
  assert.ok(!cataloguedChannel(null));
  assert.ok(!cataloguedChannel('__proto__'));
  // The fixed rows without a catalog entry never route to a dead end.
  const rows = syncChannelTable(activityOf());
  for (const channel of ['calendar', 'stripe']) {
    const row = rows.find((item) => item.channel === channel);
    assert.equal(row.detailRoute, '#/connettori');
    assert.equal(row.catalogued, false);
  }
  const wa = rows.find((item) => item.channel === 'whatsapp');
  assert.equal(wa.detailRoute, '#/connettori/whatsapp');
  assert.equal(wa.catalogued, true);
});

test('the grant wording names one shared deadline', () => {
  assert.equal(grantExpiryWording('2026-10-20T12:00:00.000Z', NOW), 'è scaduto');
  assert.equal(grantExpiryWording('2026-10-25T18:00:00.000Z', NOW), 'scade oggi');
  assert.equal(grantExpiryWording('2026-10-26T12:00:00.000Z', NOW), 'scade domani');
  assert.equal(grantExpiryWording('2026-10-28T12:00:00.000Z', NOW), 'scade tra 3 giorni');
  assert.equal(grantExpiryWording('nope', NOW), 'con scadenza sconosciuta');
  assert.equal(grantExpiryWording(null, NOW), 'con scadenza sconosciuta');
  // A fix row without a catalog entry falls back to the list, never a dead end.
  const cards = syncGrantCards(activityOf({
    connections: [entryOf({ connectionKey: 'cal-1', channel: 'calendar', grantExpiresAt: '2026-10-28T12:00:00.000Z' })],
  }), NOW);
  assert.equal(cards[0].route, '#/connettori');
});

test('an uncomposed candidates module stays silent with zero cards', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args); };
  try {
    const { mount, view } = renderView({
      client: { failCandidates: { status: 404, code: 'NOT_FOUND', message: 'no such module' } },
    });
    await view.render();
    await flush();
    assert.ok(mount.textContent.includes('Niente da sistemare'));
    assert.equal(warnings.length, 0, 'an expected absence is not a fault');
  } finally {
    console.warn = originalWarn;
  }
});

// Voce 3a3e6eaf: honest headline. With no channel linked the screen never
// claims all is synced next to «0 di 9 collegati»: it names the state and
// offers Collega where the global pull would be.
const NOTHING_LINKED = { activity: activityOf({ connections: [], feed: [], lastActivityAt: null }) };

test('3a3e6eaf: nothing linked says so, offers Collega and never claims all synced', async () => {
  const { mount, navigated, view } = renderView({ client: NOTHING_LINKED });
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Nessun canale collegato'), 'the headline names the state');
  assert.ok(text.includes('0 di 9 collegati'), 'the count stays');
  assert.ok(!text.includes('Tutto sincronizzato'), 'never all synced with nothing linked');
  assert.ok(!text.includes('Sincronizza ora'), 'no pull with nothing to pull');
  const connect = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '').includes('bo-sync-hero-connect'));
  assert.equal(connect?.textContent, 'Collega un canale');
  connect.dispatch('click', { preventDefault() {} });
  assert.deepEqual(navigated, ['#/connettori'], 'the call to action opens the connectors');
  // C27: every one of the nine rows shows Collega or the honest fallback.
  const rows = mount.findAll('tr').slice(1);
  assert.equal(rows.length, 9);
  for (const row of rows) {
    assert.equal(row.getAttribute('class'), 'bo-sync-row-off', 'an unlinked row reads dimmed');
    assert.ok(/Collega|non collegato/.test(row.textContent), row.textContent);
  }
});

test('3a3e6eaf: an observer with nothing linked sees the state but no action', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSyncView({
    doc, mount, client: fakeClient(NOTHING_LINKED), role: () => 'observer',
    storage: storageOf(), navigate: () => {}, toast: () => {},
  });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('Nessun canale collegato'));
  // Review #647 P1: an author `display` beats the `hidden` attribute, so an
  // observer gets no anchor at all — nothing a stylesheet could repaint.
  const connect = mount.findAll('a').find((node) => (node.getAttribute('class') ?? '').includes('bo-sync-hero-connect'));
  assert.equal(connect, undefined, 'read-only renders no call to action');
  assert.ok(!mount.textContent.includes('Collega un canale'), 'no Collega text for an observer');
  assert.ok(mount.textContent.includes('Sola lettura (Osservatore)'), 'the read-only note stays');
});

// Review #647 P1: every hero control that hides through `hidden` must not
// carry an author `display` the attribute cannot beat.
test('#647: the stylesheet never lets a hidden hero control show', () => {
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  for (const selector of ['.bo-sync-hero-pull', '.bo-sync-hero-connect']) {
    const escaped = selector.replace(/[.]/g, '\\.');
    const shows = new RegExp(`${escaped}\\s*\\{[^}]*display\\s*:\\s*(?!none)`).test(css);
    if (!shows) continue;
    assert.ok(new RegExp(`${escaped}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`).test(css),
      `${selector} sets display, so ${selector}[hidden] must set display:none`);
  }
});

// Review #647 P2: a channel outside the fixed nine (SMS, Telegram) is a
// linked row; the hero and the card count must tell the same story.
for (const channel of ['sms', 'telegram']) {
  test(`#647: only ${channel} linked — the hero and the count agree`, async () => {
    const only = { activity: activityOf({
      connections: [entryOf({ connectionKey: `${channel}-1`, channel, adapter: channel, account: null })],
    }) };
    const indicator = syncIndicator(only.activity, NOW);
    const { mount, view } = renderView({ client: only });
    await view.render();
    await flush();
    const text = mount.textContent;
    const count = /(\d+) di (\d+) collegati/.exec(text);
    assert.ok(count, 'the card shows a count');
    assert.equal(Number(count[1]) > 0, indicator.tone !== 'empty',
      `hero «${indicator.title}» and «${count[0]}» tell the same story`);
    assert.equal(count[0], '1 di 10 collegati', 'the extra linked row counts, and so does its place');
    assert.ok(!text.includes('Nessun canale collegato'), 'a linked row is never «nessun canale»');
  });
}

test('3a3e6eaf C15-C16: all clear hides the section, the count sits beside Canali', async () => {
  const { mount, view } = renderView();
  await view.render();
  await flush();
  assert.ok(!mount.findAll('h3').some((node) => node.textContent.startsWith('Da sistemare')),
    'with nothing to fix the Da sistemare section hides (banner only)');
  assert.ok(mount.textContent.includes('✓ Niente da sistemare. Se qualcosa si blocca, ti avviso io.'));
  const head = mount.findAll('div').find((node) => (node.getAttribute('class') ?? '') === 'bo-sync-cardhead'
    && node.textContent.startsWith('Canali'));
  assert.ok(head, 'Canali has a card head');
  assert.equal(head.childNodes[1].textContent, '1 di 9 collegati', 'the count sits in the head row');
});

test('3a3e6eaf C18-C20: a linked row shows agg., events and a coloured pill; no English, no ids', async () => {
  const { mount, view } = renderView();
  await view.render();
  await flush();
  const row = mount.findAll('tr').find((node) => node.textContent.includes('WhatsApp'));
  assert.equal(row.getAttribute('class'), null, 'a linked row is not dimmed');
  assert.match(row.childNodes[1].textContent, /^agg\. /, 'the update column reads agg. <tempo>');
  assert.match(row.childNodes[2].textContent, /^\d+ eventi ricevuti$/);
  const pill = row.findAll('span').find((node) => (node.getAttribute('class') ?? '') === 'bo-sync-pill');
  assert.equal(pill.textContent, 'Attivo');
  assert.equal(pill.getAttribute('data-pill'), 'attivo');
  const text = mount.textContent;
  assert.ok(!text.includes('wa-1') && !text.includes('+39 333 1234567'), 'no binding key nor account handle');
  for (const word of ['Sync now', 'Connect', 'Active', 'Loading', 'Error', 'undefined', 'null']) {
    assert.ok(!text.includes(word), `no English or empty value: ${word}`);
  }
});

test('3a3e6eaf C18-C26: the stylesheet shows the update column and stacks rows on a phone', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../apps/admin/public/styles.css', import.meta.url), 'utf8');
  assert.ok(!/\.bo-sync-channels \.bo-sync-table td:nth-child\(2\) \{ position: absolute;/.test(css),
    'the update column (agg. / non collegato) is never clipped away');
  for (const tone of ['attivo', 'permesso', 'importazione', 'attesa']) {
    assert.ok(css.includes(`.bo-sync-pill[data-pill="${tone}"]`), `the ${tone} pill is coloured`);
  }
  const phone = css.slice(css.indexOf('@media (max-width: 700px) {\n  .bo-sync-hero-title'));
  assert.match(phone, /\.bo-sync-channels \.bo-sync-table tr \{ display: grid; grid-template-columns: minmax\(0, 1fr\) auto;/,
    'on a phone each row stacks: name and state, then agg. and events');
  assert.match(phone, /\.bo-sync-channels \.bo-sync-table td \{ display: block;[^}]*white-space: normal;/,
    'nothing is forced onto one line wider than the screen');
});

// backlog:cf365ada15b9 — Stato sync and Oggi print one count, Calendar
// connects where the product connects it, and a stopped import offers
// Sincronizza ora only where the pull exists.
const GOOGLE_PROFILE = {
  connections: {
    available: true,
    items: [
      { connector: 'gmail', status: 'connected', account: 'op@palestra.it' },
      { connector: 'calendar', status: 'connected', account: 'op@palestra.it' },
    ],
  },
};

test('cf365ada15b9: Stato sync counts the profile links like Oggi does', async () => {
  const { countConnectedNine } = await import('../apps/admin/public/admin-oggi.js');
  const { mount, view } = renderView({
    client: { activity: activityOf({ connections: [], feed: [], lastActivityAt: null }), profile: GOOGLE_PROFILE },
  });
  await view.render();
  await flush();
  const count = /(\d+) di (\d+) collegati/.exec(mount.textContent);
  assert.ok(count, 'the card shows a count');
  assert.equal(count[0], '2 di 9 collegati', 'Gmail and Calendar count on Stato sync too');
  assert.equal(Number(count[1]), countConnectedNine([], GOOGLE_PROFILE), 'the same number Oggi prints');
  assert.ok(!mount.textContent.includes('Nessun canale collegato'), 'the hero agrees with the count');
});

test('cf365ada15b9: Google Calendar offers Collega on Profilo when the product can connect it; Stripe stays honest', async () => {
  const offered = {
    connections: {
      available: true,
      items: [
        { connector: 'gmail', status: 'not_connected' },
        { connector: 'calendar', status: 'not_connected' },
      ],
    },
  };
  const { mount, view } = renderView({
    client: { activity: activityOf({ connections: [], feed: [], lastActivityAt: null }), profile: offered },
  });
  await view.render();
  await flush();
  const collega = mount.findAll('a').filter((node) => node.textContent === 'Collega');
  const calendar = collega.find((node) => node.getAttribute('data-channel') === 'calendar');
  assert.ok(calendar, 'Google Calendar offers Collega');
  assert.equal(calendar.getAttribute('href'), '#/profilo', 'it lands where its Collega lives');
  assert.equal(collega.find((node) => node.getAttribute('data-channel') === 'stripe'), undefined, 'Stripe has no connect screen');
  const stripeRow = mount.findAll('tr').find((row) => row.textContent.includes('Stripe'));
  assert.equal(stripeRow.findAll('a').length, 0, 'Stripe offers no Collega');
  assert.equal(mount.findAll('span').filter((node) => node.textContent === 'non collegato').length, 1, 'only Stripe reads non collegato in the state cell');
  assert.equal(syncConnectRoute('calendar', null), null, 'without the profile there is nothing to offer');
  assert.equal(syncConnectRoute('whatsapp', null), '#/connettori/whatsapp');
});

test('cf365ada15b9: a stopped import offers Sincronizza ora only where the pull exists', async () => {
  const stopped = entryOf({
    connectionKey: 'profile:gmail', channel: 'email', importable: false, health: 'attention',
    sync: { status: 'done', lastErrorCode: 'GOOGLE_GRANT_REFUSED', lastErrorReason: 'Google ha rifiutato il permesso: ricollega l\u2019account dal Profilo.' },
  });
  const [item] = syncFixItems(activityOf({ connections: [stopped] }));
  assert.equal(item.action.kind, 'route', 'no pull where none exists');
  assert.equal(item.action.route, '#/connettori/email');
  assert.equal(item.detail, 'Google ha rifiutato il permesso: ricollega l\u2019account dal Profilo.', 'the round says what to do');
  const { mount, view } = renderView({ client: { activity: activityOf({ connections: [stopped] }) } });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('si è fermata'), 'the card is there');
  assert.equal(mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'sync-now').length, 0,
    'no Sincronizza ora button on the card');
  const [pullable] = syncFixItems(activityOf({ connections: [entryOf({ sync: { status: 'done', lastErrorCode: 'X' } })] }));
  assert.equal(pullable.action.kind, 'sync-now', 'an importable binding keeps its pull');
});

// Review #680 round 1 — the table, the hero and the shared count must tell
// one story. Voce 1a3a0ba236c0 (C18) narrows P2-1: profile links stay
// counted as connected, but with no update and no events they wait for
// the first event like any other quiet row (DECISION to be confirmed:
// «senza aggiornamento né eventi» covers profile-merged rows too).
test('#680 P2-1: profile links counted as connected wait for the first event', async () => {
  const { mount, view } = renderView({
    client: { activity: activityOf({ connections: [], feed: [], lastActivityAt: null }), profile: GOOGLE_PROFILE },
  });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('2 di 9 collegati'));
  const pills = mount.findAll('span').filter((node) => (node.getAttribute('class') ?? '').includes('bo-sync-pill'));
  assert.deepEqual(pills.map((node) => node.textContent), ['in attesa del primo evento', 'in attesa del primo evento'], 'quiet Email and Google Calendar wait');
});

test('#680 P2-2: a suspended row alone is not connected — table, hero and count agree', async () => {
  const only = activityOf({ connections: [entryOf({ status: 'suspended', health: 'down' })] });
  const row = syncChannelTable(only).find((entry) => entry.channel === 'whatsapp');
  assert.equal(row.connected, false, 'a suspended binding is not «collegato»');
  assert.ok(row.pill !== null, 'its pill still names the problem');
  const indicator = syncIndicator(only, NOW);
  assert.equal(indicator.title, 'Nessun canale attivo', 'never «sincronizzato» with nothing connected');
  const { mount, view } = renderView({ client: { activity: only } });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('0 di 9 collegati'));
  assert.ok(!mount.textContent.includes('Tutto sincronizzato'), 'the hero agrees with the count');
  const pills = mount.findAll('span').filter((node) => (node.getAttribute('class') ?? '').includes('bo-sync-pill'));
  assert.equal(pills.length, 1, 'the suspended row keeps its pill');
});

// Voce 1a3a0ba236c0 (C18, verification 09/11): a linked row with no
// update and no events reads `in attesa del primo evento`, never
// `Attivo`, and the hero must not call it synced. Supersedes the
// production-08/11 rule (3a3e6eaff1c5 C9) that read `Attivo` there.
test('1a3a0ba236c0 C18: a quiet linked row waits for the first event', async () => {
  const quiet = activityOf({ connections: [entryOf({ health: 'idle', inbox: null })], lastActivityAt: null });
  assert.deepEqual(syncChannelTable(quiet).find((row) => row.channel === 'whatsapp').pill,
    { text: 'in attesa del primo evento', tone: 'attesa' }, 'no update and no events waits');
  // backlog:e381c48581fa: waiting is not a fix — grey «In attesa del primo
  // evento», never the yellow «Quasi tutto sincronizzato» over «Niente da
  // sistemare».
  assert.equal(syncIndicator(quiet, NOW).title, 'In attesa del primo evento', 'a waiting row is not «Tutto sincronizzato»');
  assert.equal(syncIndicator(quiet, NOW).tone, 'wait');
  // C10: the subtitle keeps the prototype pattern «<aggiornamento> · <n> eventi … in tutto».
  assert.match(syncIndicator(quiet, NOW).detail, / · 0 eventi ricevuti in tutto\.$/);
  // A linked row that broke without a fix card (health only) reads Da sistemare, and the hero says so.
  const broken = activityOf({ connections: [entryOf({ health: 'attention' })] });
  assert.equal(syncChannelTable(broken)[0].pill.text, 'Da sistemare');
  const indicator = syncIndicator(broken, NOW);
  assert.equal(indicator.title, 'Quasi tutto sincronizzato');
  assert.equal(indicator.count, 0, 'not a fix card: the settings badge stays clean');
  const { mount, view } = renderView({ client: { activity: broken } });
  await view.render();
  await flush();
  assert.ok(!mount.textContent.includes('Tutto sincronizzato'));
  assert.ok(mount.textContent.includes('Quasi tutto sincronizzato'));
  assert.ok(!mount.textContent.includes('Niente da sistemare'), 'a row to fix never sits beside «Niente da sistemare»');
  assert.ok(mount.textContent.includes('Un canale va controllato'));
});

// backlog:e381c48581fa (giro UX 11/11, punto 32): Stato sync read «Quasi
// tutto sincronizzato» with a yellow dot and «Niente da sistemare» together,
// and its Collega was dark grey (it looked disabled) where Profilo's is green.
test('e381c48581fa: a waiting space never pairs a yellow hero with «Niente da sistemare», Collega is green', async () => {
  const quiet = activityOf({ connections: [entryOf({ health: 'idle', inbox: null })], lastActivityAt: null });
  const { mount, view } = renderView({ client: { activity: quiet } });
  await view.render();
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('In attesa del primo evento'));
  assert.ok(!text.includes('Quasi tutto sincronizzato'), 'nothing to fix: not the yellow headline');
  assert.ok(text.includes('Niente da sistemare'));
  const dot = mount.findAll('span').find((node) => (node.getAttribute('class') ?? '').includes('bo-sync-hero-dot'));
  assert.match(dot.getAttribute('class'), /bo-sync-hero-dot-wait/, 'grey dot, not yellow');
  const collega = mount.findAll('a').filter((node) => node.getAttribute('data-action') === 'collega');
  assert.ok(collega.length > 0, 'unlinked rows offer Collega');
  for (const link of collega) {
    assert.match(link.getAttribute('class') ?? '', /\bui-btn-cta\b/, 'the green Collega of every screen');
  }
});

// Production 08/11 (3a3e6eaff1c5 C11): in Presti «Sincronizza ora» stayed
// on screen disabled with no reason, because nothing there can be pulled.
// No possible action: no button.
test('3a3e6eaf C11: with nothing to pull the hero shows no Sincronizza ora', async () => {
  const unpullable = activityOf({ connections: [entryOf({ importable: false })] });
  const { mount, view } = renderView({ client: { activity: unpullable } });
  await view.render();
  await flush();
  const pull = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'sync-all');
  assert.equal(pull, undefined, 'no disabled button without an action');
  const pullable = renderView();
  await pullable.view.render();
  await flush();
  const live = pullable.mount.findAll('button').find((node) => node.getAttribute('data-action') === 'sync-all');
  assert.ok(live, 'an importable binding keeps the pull');
  assert.equal(live.getAttribute('disabled'), null);
});

// Production 08/11 after #687 (3a3e6eaff1c5 / 9c7d1477a8d4): the spec wants
// «<n> di 9 collegati» like the nine rows (C16/C20/C27), the C20 pills, the
// singular «1 evento», and no 12 s wait on «Carico Stato sync…».
test('3a3e6eaf C16/C27: the count is always «di 9», Stripe included', async () => {
  const { mount, view } = renderView({ client: { activity: activityOf({ connections: [], feed: [], lastActivityAt: null }) } });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('0 di 9 collegati'), 'nine fixed rows, nine in the count');
});

test('3a3e6eaf C19/C20: connected rows read only the spec pills, unconnected rows «non collegato»', async () => {
  const activity = activityOf({
    connections: [
      entryOf({ connectionKey: 'wa', health: 'idle', inbox: null }),
      entryOf({ connectionKey: 'ig', channel: 'instagram', health: 'ok' }),
    ],
  });
  const { mount, view } = renderView({ client: { activity } });
  await view.render();
  await flush();
  const pills = mount.findAll('span').filter((node) => (node.getAttribute('class') ?? '').includes('bo-sync-pill'));
  assert.deepEqual(pills.map((node) => node.textContent), ['in attesa del primo evento', 'Attivo'], 'a linked row with no traffic yet waits; one with traffic stays Attivo');
  for (const pill of pills) assert.ok(['Attivo', 'Permesso in scadenza', 'Importazione', 'Da sistemare', 'in attesa del primo evento'].includes(pill.textContent));
  assert.equal(mount.findAll('span').filter((node) => node.textContent === 'Non disponibile').length, 0, 'no «Non disponibile» outside the spec');
  const stripe = mount.findAll('tr').find((row) => row.textContent.includes('Stripe'));
  assert.ok(stripe.textContent.includes('non collegato'), 'Stripe reads non collegato');
  assert.equal(stripe.findAll('a').length, 0, 'and offers no Collega it cannot keep');
});

test('3a3e6eaf: one event reads «1 evento ricevuto», in the hero and in the row', async () => {
  const one = activityOf({ connections: [entryOf({ inbox: inboxOf({ received: 1 }) })] });
  assert.match(syncIndicator(one, NOW).detail, / · 1 evento ricevuto in tutto\.$/);
  const { mount, view } = renderView({ client: { activity: one } });
  await view.render();
  await flush();
  assert.ok(mount.textContent.includes('1 evento ricevuto'), 'the row says it in the singular');
  assert.ok(!mount.textContent.includes('1 eventi'), 'never «1 eventi»');
});

test('3a3e6eaf: Stato sync starts its reads together and paints with schema and activity', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const started = [];
  /** @type {Array<() => void>} */
  const held = [];
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      started.push(path);
      if (path === '/api/schema') return schemaOk;
      if (path.startsWith('/api/connectors/activity')) return activityOf();
      // The slow ones: profile and candidates answer only when released.
      await new Promise((resolve) => { held.push(resolve); });
      if (path === '/api/profile') throw new Error('no profile');
      return { items: [] };
    },
  };
  const view = createSyncView({ doc, mount, client, storage: storageOf(), navigate: () => {}, toast: () => {} });
  const done = view.render();
  await flush();
  assert.ok(started.includes('/api/profile'), 'the profile read started without waiting');
  assert.ok(started.some((path) => path.startsWith('/api/modules/duplicate-candidate')), 'the candidates read started too');
  assert.ok(mount.textContent.includes('1 di 9 collegati'), 'the screen paints before the slow reads answer');
  for (const release of held.splice(0)) release();
  await done;
  assert.ok(mount.textContent.includes('1 di 9 collegati'));
});

// Review #692 P2: «Attivo» only on an active binding. A suspended, pending
// or revoked binding never reads Attivo, whatever its health says.
test('#692 P2: a binding that is not active never reads Attivo', () => {
  for (const status of ['suspended', 'pending', 'revoked']) {
    for (const health of ['ok', 'idle']) {
      const rows = syncChannelTable(activityOf({ connections: [entryOf({ status, health })] }));
      const row = rows.find((entry) => entry.channel === 'whatsapp');
      assert.equal(row.connected, false, `${status}/${health} is not connected`);
      assert.notEqual(row.pill.text, 'Attivo', `${status}/${health} never reads Attivo`);
      assert.equal(row.pill.text, 'Da sistemare', `${status}/${health} reads Da sistemare`);
    }
  }
  const extra = syncChannelTable(activityOf({ connections: [entryOf({ channel: 'sms', status: 'pending', health: 'ok' })] }))
    .find((entry) => entry.channel === 'sms');
  assert.equal(extra.pill.text, 'Da sistemare', 'an extra row follows the same rule');
  // Voce 1a3a0ba236c0 (C18): zero traffic on an active binding now waits
  // for the first event instead of reading Attivo.
  const active = syncChannelTable(activityOf({ connections: [entryOf({ health: 'idle', inbox: inboxOf({ received: 0, lastReceivedAt: null }) })] }))[0];
  assert.equal(active.pill.text, 'in attesa del primo evento', 'an active binding with no traffic yet waits');
  const live = syncChannelTable(activityOf({ connections: [entryOf({ health: 'idle' })] }))[0];
  assert.equal(live.pill.text, 'Attivo', 'traffic keeps the Attivo pill');
});

// backlog:e381c48581fa (verifica pilota 51ab9ca): TikTok, Telefono e Form
// read «Non ancora disponibile» in Connettori but offered «Collega» in
// Stato sync. The production shape: no adapter composed, raw activity rows,
// the profile apart. Every row offers Collega exactly where Connettori does.
test('e381c48581fa: with no adapter Stato sync offers Collega only where Connettori does', async () => {
  const profile = {
    member: {},
    connections: {
      available: true,
      reason: null,
      items: [
        { connector: 'whatsapp', status: 'disconnected', account: null },
        { connector: 'gmail', status: 'disconnected', account: null },
        { connector: 'calendar', status: 'disconnected', account: null },
      ],
      meta: { configured: true },
    },
  };
  const { CONNECTOR_CATALOG, connectorStatus } = await import('../apps/admin/public/admin-connectors.js');
  const empty = activityOf({ connections: [] });
  const { mount, view } = renderView({ client: { activity: empty, schema: schemaNoAdapters, profile } });
  await view.render();
  await flush();
  const collega = Object.fromEntries(mount.findAll('a')
    .filter((node) => node.getAttribute('data-action') === 'collega')
    .map((node) => [node.getAttribute('data-channel'), node.getAttribute('href')]));
  for (const channel of ['tiktok', 'voice', 'site-form', 'instagram', 'facebook', 'stripe']) {
    assert.equal(collega[channel], undefined, `${channel}: nothing connects it, no Collega`);
  }
  assert.equal(collega.whatsapp, '#/profilo', 'WhatsApp connects on Profilo (Meta app configured)');
  assert.equal(collega.email, '#/profilo', 'Email connects on Profilo (Gmail)');
  assert.equal(collega.calendar, '#/profilo');
  // The same answer as the Connettori list for every catalog channel.
  for (const entry of CONNECTOR_CATALOG) {
    if (!['whatsapp', 'instagram', 'facebook', 'tiktok', 'email', 'voice', 'site-form'].includes(entry.channel)) continue;
    const listed = connectorStatus({ entry, adapters: [], connections: [], profile });
    const offered = listed.status === 'da-collegare' || listed.status === 'da-completare';
    assert.equal(collega[entry.channel] !== undefined, offered, `${entry.channel}: one answer on both screens`);
  }
});
