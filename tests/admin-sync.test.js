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
import assert from 'node:assert/strict';
import {
  SYNC_CHANNELS,
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

const schemaOk = { domains: { channels: { metadata: { channelsContract: 1, adapters: [] } } } };

function fakeClient({ activity = activityOf(), schema = schemaOk, failActivity = null, qualityIssues = [], candidates = [], failCandidates = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
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

  const one = syncIndicator(activityOf({ connections: [entryOf({ status: 'suspended', health: 'down' })] }), NOW);
  assert.equal(one.tone, 'fix');
  assert.equal(one.title, 'Quasi tutto sincronizzato');
  assert.equal(one.count, 1);

  const two = syncIndicator(activityOf({
    connections: [
      entryOf({ connectionKey: 'a', status: 'suspended', health: 'down' }),
      entryOf({ connectionKey: 'b', status: 'revoked', health: 'down' }),
    ],
  }), NOW);
  assert.equal(two.title, 'Quasi tutto sincronizzato');
  assert.equal(two.count, 2);

  const empty = syncIndicator(activityOf({ connections: [], feed: [], lastActivityAt: null }), NOW);
  assert.equal(empty.tone, 'ok');
  assert.ok(empty.detail.includes('Nessun connettore'));

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
  assert.ok(noChannels.mount.textContent.includes('non sono composti'));

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
  // Off-prototype health never poses as Attivo: it names its verdict.
  const down = syncChannelTable(activityOf({
    connections: [entryOf({ status: 'suspended', health: 'down' })],
  }));
  assert.equal(down[0].pill.text, 'Bloccato');
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
  assert.equal(cards[0].route, '#/connettori/tiktok');
  assert.equal(cards[1].title, 'Il permesso di Instagram scade tra 3 giorni');
  assert.equal(cards[1].detail, 'Rinnovalo ora per continuare a ricevere i DM nelle schede clienti.');
  assert.equal(cards[1].route, '#/connettori/instagram');
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
  assert.ok(text.includes('2 di 9 collegati'), 'the card counts the connected nine');
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
  assert.ok(text.includes('Non disponibile'));
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
  assert.equal(mount.findAll('span').filter((node) => node.textContent === 'Non disponibile').length, 2);
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
  assert.equal(renew.getAttribute('href'), '#/connettori/instagram');
  renew.dispatch('click');
  await flush();
  assert.deepEqual(navigated, ['#/connettori/instagram']);
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
