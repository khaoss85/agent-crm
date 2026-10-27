// @ts-check

/**
 * **Channel origins (backlog:05225cf952a4, slice 2).** The reporting
 * dashboard's "Nuovi clienti per canale" card counts new contacts per
 * origin channel and week from the `external-identity` rows this package
 * already owns — no second identity store, no ad-hoc storage query from
 * the pilot.
 *
 * Week bucketing is a pure function (`weekStartOf`, `aggregateChannelOrigins`)
 * shared by the `customer-channel-origins@1` capability and the
 * `count-customer-channel-origins` application operation, so both surfaces
 * answer identically by construction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  aggregateChannelOrigins,
  createChannelOriginsCapability,
  weekStartOf,
} from '../packages/customer-data/src/capability-channel-origins.js';
import { boot, project } from './helpers/customer-data-project.js';

const ACTOR = { type: 'user', id: 'origins' };

async function scene(t, tag) {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

test('weekStartOf buckets to the ISO Monday, refusals stay null', () => {
  assert.equal(weekStartOf('2026-10-12T09:00:00.000Z'), '2026-10-12', 'a Monday stays');
  assert.equal(weekStartOf('2026-10-18T23:59:59.000Z'), '2026-10-12', 'a Sunday joins its Monday');
  assert.equal(weekStartOf('2026-10-19T00:00:00.000Z'), '2026-10-19', 'next Monday starts a new week');
  assert.equal(weekStartOf('2026-10-05T12:00:00.000Z'), '2026-10-05', 'the prototype week of 5 ott');
  assert.equal(weekStartOf('2026-02-30T00:00:00.000Z'), null, 'an impossible day is refused, never moved');
  assert.equal(weekStartOf('not-a-date'), null);
  assert.equal(weekStartOf(''), null);
  assert.equal(weekStartOf(null), null);
  assert.equal(weekStartOf(undefined), null);
  assert.equal(weekStartOf(1720000000000), null, 'a raw epoch is not a stored timestamp');
});

test('aggregateChannelOrigins counts per system and week, undated stay out of bars', () => {
  const { origins, undated } = aggregateChannelOrigins([
    { system: 'whatsapp', firstObservedAt: '2026-10-12T09:00:00.000Z' },
    { system: 'whatsapp', firstObservedAt: '2026-10-14T09:00:00.000Z' },
    { system: 'instagram', firstObservedAt: '2026-10-18T09:00:00.000Z' },
    { system: 'instagram', firstObservedAt: '2026-10-19T09:00:00.000Z' },
    { system: 'email', firstObservedAt: null },
    { system: '', firstObservedAt: '2026-10-12T09:00:00.000Z' },
    null,
    'not-a-row',
  ]);
  assert.deepEqual(origins, [
    { system: 'email', week: null, count: 1 },
    { system: 'instagram', week: '2026-10-12', count: 1 },
    { system: 'instagram', week: '2026-10-19', count: 1 },
    { system: 'unknown', week: '2026-10-12', count: 1 },
    { system: 'whatsapp', week: '2026-10-12', count: 2 },
  ]);
  assert.equal(undated, 1);
  assert.ok(Object.isFrozen(origins), 'the aggregate travels frozen');
});

test('a hostile system name never merges two channels into one aggregate', () => {
  const hostile = 'whatsapp\n2026-10-12\tinjected';
  const { origins } = aggregateChannelOrigins([
    { system: hostile, firstObservedAt: '2026-10-12T09:00:00.000Z' },
    { system: 'whatsapp', firstObservedAt: '2026-10-12T09:00:00.000Z' },
  ]);
  assert.equal(origins.length, 2, 'no joined-key merge');
  assert.ok(origins.some((entry) => entry.system === hostile));
  assert.ok(origins.some((entry) => entry.system === 'whatsapp' && entry.count === 1));
});

test('the capability counts identities per channel from the composed package', async (t) => {
  const { app } = await scene(t, 'channel-origins-capability');
  await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000011', email: 'luca@prestigroup.example',
    firstName: 'Luca', lastName: 'Rossi', actor: ACTOR,
  });
  await app.resolveChannelSender({
    channel: 'instagram', handle: 'luca.rossi.pg', email: 'luca@prestigroup.example', actor: ACTOR,
  });
  await app.resolveChannelSender({
    channel: 'email', handle: 'anna@prestigroup.example',
    firstName: 'Anna', lastName: 'Bianchi', actor: ACTOR,
  });

  const capability = createChannelOriginsCapability().create({ modules: app.modules });
  const { origins } = await capability.countOrigins();
  const systems = origins.map((entry) => entry.system).sort();
  assert.deepEqual(systems, ['email', 'instagram', 'whatsapp']);
  for (const entry of origins) {
    assert.equal(entry.count, 1);
    assert.match(entry.week ?? '', /^\d{4}-\d{2}-\d{2}$/, 'dated identities join a weekly bar');
  }
  assert.equal(capability.capabilityContract, 1);
});

test('the application operation answers the same aggregates the pilot route serves', async (t) => {
  const { app } = await scene(t, 'channel-origins-operation');
  await app.resolveChannelSender({
    channel: 'tiktok', handle: 'presti.clips', email: 'social@prestigroup.example',
    firstName: 'Social', lastName: 'Presti', actor: ACTOR,
  });

  assert.equal(typeof app.countCustomerChannelOrigins, 'function', 'the operation is an app method');
  const answer = await app.countCustomerChannelOrigins({});
  assert.ok(Array.isArray(answer.origins));
  assert.ok(answer.origins.some((entry) => entry.system === 'tiktok' && entry.count === 1));
  assert.ok(Object.isFrozen(answer), 'the answer travels frozen');
});

test('opening the capability without a modules view fails closed naming the edge', () => {
  assert.throws(
    () => createChannelOriginsCapability().create({}),
    /customer-channel-origins@1 requires the caller's modules view/,
  );
});
