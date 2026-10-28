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
  SYNC_ROUTE,
  channelLabel,
  createSyncView,
  directionLabel,
  feedKindLabel,
  healthAuthority,
  healthLabel,
  healthTone,
  syncAgo,
  syncChannelRows,
  syncFeedItems,
  syncFixItems,
  syncIndicator,
  timeAgo,
} from '../apps/admin/public/admin-sync.js';
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

function fakeClient({ activity = activityOf(), schema = schemaOk, failActivity = null, qualityIssues = [] } = {}) {
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
        throw new Error(`unexpected mutation ${path}`);
      }
      if (path === '/api/schema') return schema;
      if (path.startsWith('/api/connectors/activity')) {
        if (failActivity !== null) throw failActivity;
        return activity;
      }
      if (path.startsWith('/api/modules/data-quality-issue/records')) return { items: qualityIssues };
      if (path.startsWith('/api/modules/duplicate-candidate/records')) return { items: [] };
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
  assert.ok(ok.detail.includes('10 eventi sincronizzati oggi, in entrata e in uscita.'));

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
  assert.equal(byKey.get('e:quarantena').action.route, '#/customer-data');
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
  assert.deepEqual(items[0], { at: '2026-10-25T11:30:00.000Z', arrow: '←', channel: 'WhatsApp', text: 'registrato' });
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
  assert.ok(text.includes('eventi sincronizzati oggi, in entrata e in uscita.'));
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
  // The failed import owns two row-level controls with one job: the
  // fix-item action and the table row button (the hero pull is the third
  // `Sincronizza ora` on screen, with data-action="sync-all").
  const buttons = mount.findAll('button').filter((node) => node.getAttribute('data-action') === 'sync-now');
  assert.equal(buttons.length, 2);
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
  assert.equal(rebuilt.length, 2);
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
