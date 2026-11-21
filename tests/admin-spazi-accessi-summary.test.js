// @ts-check

/**
 * Backlog 30f7ce51c87a (verifica 19/11: Spazi e accessi ancora 10 richieste
 * /api/ per apertura, scheda cliente 11-12, Impostazioni 7): the heaviest
 * /bo pages read with one or two server-side aggregate reads instead of
 * 7-14, and /api/profile comes from the shell cache instead of every page
 * open.
 *
 * What it must prove, red before the cure and green after:
 * - opening Spazi e accessi costs at most two GET reads (one aggregate plus
 *   the cached profile, silent on the second open);
 * - the shell profile reader asks /api/profile once per app start, however
 *   many screens open it;
 * - a failed profile read is never kept: the next open asks again (review
 *   on #1088 P1: a transient 429/500 once stuck every screen on null);
 * - dropping the kept answer (after a PATCH save or a Collega/Scollega
 *   round trip) makes the next open read again.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaziAccessiView } from '../apps/admin/public/admin-spazi-accessi.js';
import { forgetCachedProfile, readCachedProfile, watchOAuthReturn } from '../apps/admin/public/admin-profilo.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const SPACE = 'spazio-1';

// The profile answer is kept once per app start, so every test starts from
// an empty cache — otherwise one test's answer would leak into the next.
const freshProfileCache = () => { forgetCachedProfile(null); };

function stubClient({ calls = null } = {}) {
  // Same shapes the server summary route answers: one payload carries the
  // seven single reads the screen used to fly on its own. Any single read
  // the screen still flies throws here, so the request count below proves
  // the aggregate path, not a silent mix.
  const summary = {
    spaceId: SPACE,
    context: {
      identity: { subject: 'persona-1' },
      actor: { type: 'user', id: 'persona-1' },
      membership: { subject: 'persona-1', role: 'owner' },
      roles: { owner: [], operator: [], observer: [] },
    },
    memberships: { items: [] },
    agents: { items: [] },
    switches: { spaceId: SPACE, overrides: [] },
    connectors: { spaceId: SPACE, connectors: [] },
    customers: { items: [], page: 1, pageSize: 10, pages: 0, total: 0, totalIsExact: true },
    fix: { issues: [], candidates: [], needsFix: 0 },
  };
  return {
    async request(path, options = {}) {
      if (calls && (options?.method ?? 'GET').toUpperCase() === 'GET') calls.push(path);
      if (path.startsWith('/api/spazi-accessi/summary')) return summary;
      if (path === '/api/profile') return { connections: { available: true, items: [] } };
      throw new Error(`unexpected single request ${path}`);
    },
  };
}

test('30f7ce51c87a: opening Spazi e accessi costs at most two GET reads', async () => {
  freshProfileCache();
  const calls = [];
  const doc = createFakeDocument();
  const mount = createMount();
  const view = createSpaziAccessiView({
    doc,
    mount,
    client: stubClient({ calls }),
    navigate: () => {},
    spaces: () => [{ id: SPACE, name: 'Negozio', initials: 'NE' }],
    activeSpaceId: () => SPACE,
    onPickSpace: () => {},
    toast: () => {},
  });
  await view.render();
  await flush();
  const distinct = [...new Set(calls)];
  assert.ok(
    distinct.length <= 2,
    `one open reads once or twice, not ${distinct.length}: ${distinct.join(', ')}`,
  );
});

test('30f7ce51c87a: the shell reads /api/profile once, however many screens open it', async () => {
  freshProfileCache();
  const calls = [];
  const client = stubClient({ calls });
  const first = await readCachedProfile(client);
  const second = await readCachedProfile(client);
  const third = await readCachedProfile(client);
  assert.deepEqual(first, { connections: { available: true, items: [] } });
  assert.deepEqual(second, first);
  assert.deepEqual(third, first);
  const profileReads = calls.filter((path) => path === '/api/profile');
  assert.equal(profileReads.length, 1, `one /api/profile read per app start, not ${profileReads.length}`);
});

test('30f7ce51c87a: a failed profile read is never kept, the next open asks again', async () => {
  freshProfileCache();
  const calls = [];
  let attempts = 0;
  const flaky = {
    async request(path) {
      if (path === '/api/profile') {
        attempts += 1;
        calls.push(path);
        if (attempts === 1) throw Object.assign(new Error('too many requests'), { status: 429 });
        return { connections: { available: true, items: [] } };
      }
      throw new Error(`unexpected request ${path}`);
    },
  };
  const first = await readCachedProfile(flaky, () => {});
  assert.equal(first, null, 'the transient failure reads as null, never invented');
  const second = await readCachedProfile(flaky, () => {});
  assert.deepEqual(second, { connections: { available: true, items: [] } }, 'the next open re-reads and heals');
  assert.equal(calls.length, 2, `a failed read is asked again, not kept: ${calls.length} requests`);
  const third = await readCachedProfile(flaky, () => {});
  assert.deepEqual(third, second, 'the healed answer is kept again');
  assert.equal(calls.length, 2, 'no third request once the answer is kept');
});

test('30f7ce51c87a: dropping the kept profile makes the next open read again', async () => {
  freshProfileCache();
  const calls = [];
  const client = stubClient({ calls });
  await readCachedProfile(client);
  await readCachedProfile(client);
  assert.equal(calls.filter((path) => path === '/api/profile').length, 1, 'kept while nobody writes');
  // A PATCH save or a Collega/Scollega round trip drops the kept answer.
  forgetCachedProfile(client);
  await readCachedProfile(client);
  assert.equal(calls.filter((path) => path === '/api/profile').length, 2, 'the next open reads again after the drop');
});

test('30f7ce51c87a: a restored page drops the kept profile, never the pre-link state', async () => {
  freshProfileCache();
  const client = stubClient({});
  await readCachedProfile(client);
  const seen = [];
  const doc = { defaultView: { addEventListener: (name, handler) => { seen.push({ name, handler }); } } };
  watchOAuthReturn(doc, client);
  assert.equal(seen.length, 1, 'the connections card watches the return');
  assert.equal(seen[0].name, 'pageshow', 'restored pages are observed');
  // A normal load is not a restore: the kept answer stays.
  seen[0].handler({ persisted: false });
  let reads = 0;
  const counting = { async request(path) { if (path === '/api/profile') reads += 1; return client.request(path); } };
  await readCachedProfile(counting);
  assert.equal(reads, 0, 'a normal pageshow keeps the answer');
  // A back-forward-cache restore drops it: the rows repaint the new links.
  seen[0].handler({ persisted: true });
  await readCachedProfile(counting);
  assert.equal(reads, 1, 'a restored page reads the profile again');
});
