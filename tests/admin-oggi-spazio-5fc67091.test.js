import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import {
  OGGI_LOAD_CEILING_MS,
  createOggiView,
  loadOggiData,
  renderOggi,
} from '../apps/admin/public/admin-oggi.js';
import { rerendersOnSpaceSwitch } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * Voce 5fc6709109fa: dopo Cambia spazio Oggi mostra i dati veri dello spazio
 * nuovo senza passare da un'altra pagina. Una lettura dello schema persa o
 * scartata (console «bo-oggi schema unreadable», READ_STALE) è «non so
 * ancora»: si rilegge con backoff, si mostra «Sto caricando… / Riprova»,
 * e non si dipinge MAI «non attivo» o «hai finito per oggi». Riprova rifà
 * davvero la richiesta.
 */

const OGGI_NOW = new Date('2026-10-19T07:00:00.000Z'); // 09:00 in Rome, Monday

const staleError = () => Object.assign(new Error('stale'), { code: 'READ_STALE' });

const flushUntil = async (done, rounds = 500) => {
  for (let i = 0; i < rounds; i += 1) {
    if (done()) return;
    await new Promise((resolve) => { setImmediate(resolve); });
  }
  assert.ok(done(), 'the waited state never arrived');
};

test('a read dropped as stale is re-issued, never painted as inactive', async () => {
  let schemaCalls = 0;
  const client = {
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') {
        schemaCalls += 1;
        if (schemaCalls === 1) throw staleError();
        return { domains: { work: {}, appointments: {}, channels: {}, interactions: {} } };
      }
      if (path === '/api/profile') return null;
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/modules/')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const data = await loadOggiData(client, OGGI_NOW, { spaceId: 'spazio-b' });
  assert.equal(data.schemaUnknown, false, 'the retried schema read');
  assert.equal(data.workAvailable, true, 'a stale read is not a refused module');
  assert.equal(data.appointmentsAvailable, true, 'a stale read is not a refused module');
  assert.equal(data.channelsAvailable, true, 'a stale read is not a refused module');
  assert.equal(schemaCalls, 2, 'the stale schema read is re-issued once');
});

test('an unread schema is «not yet»: no finito, no non-attivo, Riprova redoes the request', async () => {
  let schemaCalls = 0;
  const client = {
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') {
        schemaCalls += 1;
        const error = new Error('no schema here');
        error.status = 403;
        throw error;
      }
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const data = await loadOggiData(client, OGGI_NOW, { spaceId: 'spazio-b' });
  assert.equal(data.schemaUnknown, true, 'a refused schema is unknown');
  assert.equal(data.workAvailable, false, 'no read, no composed flag');
  assert.equal(data.appointmentsAvailable, false, 'no read, no composed flag');
  assert.equal(data.channelsAvailable, false, 'no read, no composed flag');

  const doc = createFakeDocument();
  const mount = createMount();
  let retries = 0;
  renderOggi({
    doc,
    mount,
    spaceName: 'Spazio B',
    links: [],
    now: OGGI_NOW,
    home: {
      recapPending: true,
      recap: 'x',
      actions: [],
      triage: {},
      agenda: [],
      brief: null,
      missing: [],
      connections: [],
      profile: null,
      schemaUnknown: true,
      availability: { work: false, appointments: false, channels: false },
      events: { onRetrySchema: () => { retries += 1; } },
    },
  });
  const text = mount.textContent;
  assert.ok(!text.includes('Hai finito per oggi'), 'never done over an unread space');
  assert.ok(!text.includes('non sono attivi'), 'never «not active» before the schema is read');
  assert.ok(!text.includes('non è attivo'), 'never «not active» before the schema is read');
  assert.ok(!text.includes('non attivi'), 'never «not active» before the schema is read');
  assert.ok(!text.includes('non attivo'), 'never «not active» before the schema is read');
  assert.ok(text.includes('Da rispondere'), 'the inbox section stays, as «not yet»');
  assert.ok(text.includes('Riprova'), 'a way to try again');
  const retry = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'oggi-retry-schema');
  assert.ok(retry, 'the retry button renders');
  retry.dispatch('click', {});
  assert.equal(retries, 1, 'Riprova redoes the request');
  assert.equal(schemaCalls, 1, 'the load issued the schema read');
});

test('Cambia spazio drops the old load: a READ_STALE answer is retried, never paints, the new space reads fresh', async () => {
  let space = 'spazio-a';
  let schemaCalls = 0;
  let taskCalls = 0;
  let rejectOldSchema = null;
  const oldSchema = new Promise((_, reject) => { rejectOldSchema = reject; });
  // Silence the rejection until the switch drops the old round: the late
  // answer below is handled by the stale retry, never unhandled.
  oldSchema.catch(() => {});
  const fullSchema = () => ({ domains: { work: {}, appointments: {}, channels: {}, interactions: {} } });
  const client = {
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') {
        schemaCalls += 1;
        // The old-space load hangs; the new-space load reads at once.
        if (schemaCalls === 1) return oldSchema;
        // The dead old-space load retries its stale answer (re-issued,
        // never painted), then reads again on its own late answer.
        if (schemaCalls === 3) throw staleError();
        return fullSchema();
      }
      if (path.startsWith('/api/modules/work-task/records')) {
        taskCalls += 1;
        // The new-space load reads first; the dead old-space load only
        // finishes after — with the old space rows, which must be dropped.
        return taskCalls === 1
          ? { items: [{ id: 'nuova', status: 'open', title: 'Follow-up spazio B' }] }
          : { items: [{ id: 'vecchia', status: 'open', title: 'Follow-up spazio A' }] };
      }
      if (path === '/api/profile') return null;
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/modules/channel-connection/records')) {
        return { items: path.includes('filter.spaceId=spazio-b') ? [{ channel: 'whatsapp', status: 'active', spaceId: 'spazio-b' }] : [] };
      }
      if (path.startsWith('/api/modules/')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOggiView({
    doc,
    mount,
    client,
    navigate: () => {},
    spaceId: () => space,
    setTimer: () => 0,
    clearTimer: () => {},
  });
  // The old-space load is still flying when the operator switches.
  const first = view.render({ spaceName: 'Spazio A', links: [], now: OGGI_NOW });
  space = 'spazio-b';
  await view.render({ spaceName: 'Spazio B', links: [], now: OGGI_NOW });
  // The old load answers READ_STALE now: re-issued inside the dead round,
  // then dropped — the new space stays on screen.
  rejectOldSchema(staleError());
  await first;
  await flushUntil(() => taskCalls >= 2);
  const text = mount.textContent;
  assert.ok(text.includes('Spazio B'), 'the new space greets');
  assert.ok(text.includes('Follow-up spazio B'), 'the new space data paints without leaving the page');
  assert.ok(!text.includes('Follow-up spazio A'), 'the old space rows never paint over the new one');
  assert.ok(!text.includes('Hai finito per oggi'), 'never done while the new space has data');
  assert.ok(schemaCalls >= 3, 'the stale old-space read is re-issued, then dropped');
});

test('an unread space retries with backoff and stops once the space reads', async () => {
  let mode = 'down';
  let schemaCalls = 0;
  const timers = [];
  const client = {
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      if (path === '/api/schema') {
        schemaCalls += 1;
        if (mode === 'down') {
          const error = new Error('no schema yet');
          error.status = 503;
          throw error;
        }
        return { domains: { work: {}, appointments: {} } };
      }
      if (path === '/api/profile') return null;
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/modules/')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createOggiView({
    doc,
    mount,
    client,
    navigate: () => {},
    spaceId: () => 'spazio-b',
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  // The loading ceiling (10 s) also uses the clock: only the retry timers
  // below the ceiling count here.
  const retryTimers = () => timers.filter((timer) => timer.ms < OGGI_LOAD_CEILING_MS);
  await view.render({ spaceName: 'Spazio B', links: [], now: OGGI_NOW });
  assert.equal(schemaCalls, 1, 'the first read leaves once');
  assert.equal(retryTimers().length, 1, 'the unread space arms its own retry');
  assert.equal(retryTimers()[0].ms, 2000, 'first retry with backoff');

  // The manual Riprova redoes the request for the live space.
  const retry = mount.findAll('button').find((node) => node.getAttribute('data-action') === 'oggi-retry-schema');
  assert.ok(retry, 'the manual retry renders');
  retry.dispatch('click', {});
  await flushUntil(() => schemaCalls >= 2);
  assert.equal(retryTimers().length, 2, 'the manual retry rearms the backoff');
  assert.ok(mount.textContent.includes('Riprova'), 'still unread, still retryable');

  // The superseded timer dies quietly: no request, no repaint.
  const callsBefore = schemaCalls;
  await retryTimers()[0].fn();
  await flushUntil(() => schemaCalls >= callsBefore);
  assert.equal(schemaCalls, callsBefore, 'a dead round never reads again');

  // The live backoff tick redoes the request with a longer delay.
  await retryTimers()[1].fn();
  await flushUntil(() => schemaCalls >= 3 && retryTimers().length >= 3);
  assert.equal(retryTimers()[2].ms, 5000, 'the backoff grows');
  assert.ok(mount.textContent.includes('Riprova'), 'still down, still retryable');

  // Once the space reads, the retry stops and the day paints honest lines.
  mode = 'ok';
  await retryTimers()[2].fn();
  const retryGone = () => !mount.findAll('button').some((node) => node.getAttribute('data-action') === 'oggi-retry-schema');
  await flushUntil(() => schemaCalls >= 4 && retryGone() && mount.textContent.includes('Niente appuntamenti oggi.'));
  assert.equal(retryTimers().length, 3, 'a read space arms no further retry');
  assert.ok(mount.textContent.includes('Niente appuntamenti oggi.'), 'the read space paints its honest empty lines');
  const again = mount.textContent;
  assert.ok(!again.includes('non è attivo'), 'modules genuinely absent stay honest, never unknown');
});

test('Oggi re-renders on space switch, on every shell', () => {
  assert.equal(rerendersOnSpaceSwitch('dashboard', { mounted: true }), true, 'mounted Oggi re-reads the new space');
  assert.equal(rerendersOnSpaceSwitch('dashboard', { mounted: false }), true, 'Oggi re-reads even without a mount navigation');
  assert.equal(rerendersOnSpaceSwitch('dashboard'), true, 'the default shell re-reads Oggi too');
});
