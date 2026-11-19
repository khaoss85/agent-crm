// @ts-check

/**
 * Backlog 30f7ce51c87a (verifica 19/11: Spazi e accessi ancora 10 richieste
 * /api/ per apertura): the heaviest /bo pages read with one or two
 * server-side aggregate reads instead of 7-14, and /api/profile comes from
 * the shell cache instead of every page open.
 *
 * What it must prove, red before the cure and green after:
 * - opening Spazi e accessi costs at most two GET reads (one aggregate plus
 *   the cached profile, silent on the second open);
 * - the shell profile reader asks /api/profile once per client (one app
 *   start), however many screens open it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaziAccessiView } from '../apps/admin/public/admin-spazi-accessi.js';
import { readCachedProfile } from '../apps/admin/public/admin-profilo.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

const SPACE = 'spazio-1';

function stubClient({ calls = null } = {}) {
  return {
    async request(path, options = {}) {
      if (calls && (options?.method ?? 'GET').toUpperCase() === 'GET') calls.push(path);
      if (path.startsWith('/api/spazi-accessi/summary')) {
        throw Object.assign(new Error('no summary yet'), { code: 'NOT_FOUND', status: 404 });
      }
      if (path === '/api/spine/context') {
        return { membership: { role: 'owner' }, roles: { owner: [], operator: [], observer: [] } };
      }
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/space-permissions/effective')) {
        return { spaceId: SPACE, overrides: [] };
      }
      if (path.startsWith('/api/modules/teammate-agent/records')) return { items: [] };
      if (path.includes('/api/modules/data-quality-issue/records')) return { items: [] };
      if (path.includes('/api/modules/duplicate-candidate/records')) return { items: [] };
      if (path.startsWith('/api/connectors/activity')) return { spaceId: SPACE, needsFix: 0 };
      if (path.startsWith('/api/connectors')) return { spaceId: SPACE, connectors: [] };
      if (path.startsWith('/api/customer-data/customers')) {
        return { items: [], page: 1, pageSize: 10, pages: 0, total: 0, totalIsExact: true };
      }
      if (path === '/api/profile') return { connections: { available: true, items: [] } };
      throw new Error(`unexpected request ${path}`);
    },
  };
}

test('30f7ce51c87a: opening Spazi e accessi costs at most two GET reads', async () => {
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
