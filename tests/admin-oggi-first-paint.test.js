import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { loadOggiData } from '../apps/admin/public/admin-oggi.js';

const NOW = new Date('2026-11-17T07:35:00.000Z');

/**
 * backlog:ca53e443db44 — the verifier's live measure (evidence
 * supervisor-browser 2026-11-17) passes only from the second load: at the
 * first round after login /api/profile answers in 5,9 s and «Da rispondere»
 * lands at 5,2 s, so Oggi sits on its skeleton. The day must paint its
 * essentials — and the «Da rispondere» rows — without waiting for the
 * profile: the profile only votes on the channel strip and lends the names,
 * both of which already read null as «unknown, fill in after».
 *
 * These tests gate GET /api/profile behind a manual release (the slow first
 * round) and require the essentials, then the server-view rows, while the
 * profile is still flying. Red on the code that awaits the profile inside
 * the essentials wave, green once the profile only joins the names wave.
 */
function slowProfileClient({ onRequest } = {}) {
  let releaseProfile;
  const profileGate = new Promise((resolve) => { releaseProfile = resolve; });
  const profileAnswer = {
    member: { email: 'op@palestra-esempio.it' },
    connections: { available: true, items: [] },
  };
  const repliesAnswer = {
    items: [{
      subject: { resource: 'contact', id: 'c1' },
      name: 'Guido Presti',
      awaitingChannel: 'whatsapp',
      lastAwaitingAt: '2026-11-17T07:00:00.000Z',
      awaitingText: 'Ci sono posti giovedi?',
    }],
    total: 1,
    totalIsExact: true,
    views: [],
  };
  const client = {
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      if (typeof onRequest === 'function') onRequest(path);
      if (path === '/api/profile') return profileGate.then(() => profileAnswer);
      if (path === '/api/schema') {
        return { domains: { work: {}, appointments: {}, interactions: {}, 'customer-data': {} } };
      }
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/customer-data/customers?')) return repliesAnswer;
      if (path.startsWith('/api/modules/')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    },
  };
  return { client, releaseProfile: () => releaseProfile() };
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('ca53e443db44: the essentials paint while the first-round profile is still flying', async () => {
  const { client, releaseProfile } = slowProfileClient();
  const essentials = [];
  const named = [];
  const pending = loadOggiData(client, NOW, {
    spaceId: 'spazio-test',
    onEssentials: (partial) => { essentials.push(partial); },
    onNames: (filled) => { named.push(filled); },
  });
  await sleep(100);
  assert.ok(essentials.length >= 1, 'the day paints its essentials without waiting for /api/profile');
  assert.equal(essentials[0].profile, null, 'the early paint carries no profile, never a guess');
  releaseProfile();
  const data = await pending;
  assert.ok(data.profile !== null, 'the profile still joins the load, after the paint');
});

test('ca53e443db44: the «Da rispondere» rows publish while the first-round profile is still flying', async () => {
  const { client, releaseProfile } = slowProfileClient();
  const named = [];
  const pending = loadOggiData(client, NOW, {
    spaceId: 'spazio-test',
    onEssentials: () => {},
    onNames: (filled) => { named.push(filled); },
  });
  await sleep(100);
  const withRows = named.find((filled) => filled.replies != null && Array.isArray(filled.replies.rows));
  assert.ok(withRows, 'the server-view rows publish without waiting for /api/profile');
  assert.equal(withRows.replies.rows.length, 1, 'no row lost to the early publish');
  assert.equal(withRows.replies.rows[0].name, 'Guido Presti', 'the row keeps its server name');
  releaseProfile();
  const data = await pending;
  assert.equal(data.replies.rows.length, 1, 'the rows survive the profile landing');
  assert.ok(data.profile !== null, 'the profile still joins the load, after the paint');
});
