import test from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../packages/core/src/event-bus.js';

test('emit dispatches immediately when no outbox is active (backward compatible)', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe('thing.created', ({ payload }) => seen.push(payload));
  await bus.emit('thing.created', { id: 1 });
  assert.deepEqual(seen, [{ id: 1 }]);
});

test('buffered queues events and flushes them only on commit, in order', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe('*', ({ event }) => seen.push(event));

  const result = await bus.buffered(async (outbox) => {
    await bus.emit('a', {});
    await bus.emit('b', {});
    // Nothing dispatched yet: the events are still in the outbox.
    assert.deepEqual(seen, []);
    await outbox.commit();
    // Now they are visible, in emit order.
    assert.deepEqual(seen, ['a', 'b']);
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(seen, ['a', 'b']);
});

test('discard drops queued events; nothing is dispatched', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe('*', ({ event }) => seen.push(event));
  await bus.buffered(async (outbox) => {
    await bus.emit('a', {});
    outbox.discard();
  });
  assert.deepEqual(seen, []);
});

test('a throw inside buffered drops queued events automatically', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe('*', ({ event }) => seen.push(event));
  await assert.rejects(
    () => bus.buffered(async () => {
      await bus.emit('a', {});
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(seen, [], 'events emitted before the throw are never dispatched');
});

test('concurrent buffered scopes never share a queue', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe('*', ({ event }) => seen.push(event));

  // Two overlapping buffered runs; each must flush only its own events.
  const first = bus.buffered(async (outbox) => {
    await bus.emit('first-1', {});
    await new Promise((resolve) => setTimeout(resolve, 10));
    await bus.emit('first-2', {});
    await outbox.commit();
    return 'first';
  });
  const second = bus.buffered(async (outbox) => {
    await bus.emit('second-1', {});
    await outbox.commit();
    return 'second';
  });

  await Promise.all([first, second]);
  // second commits first (no delay), then first.
  assert.deepEqual(seen, ['second-1', 'first-1', 'first-2']);
});

test('nested buffered scopes fail closed with a clear error', async () => {
  const bus = new EventBus();
  await assert.rejects(
    () => bus.buffered(async () => {
      await bus.buffered(async () => {});
    }),
    (error) => error.code === 'NESTED_ACTION' && /not supported/.test(error.message),
  );
});

test('flush failure policy: later events still dispatch, errors are aggregated after commit', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe('a', () => { throw new Error('handler A exploded'); });
  bus.subscribe('a', () => seen.push('a-second')); // skipped: dispatch of "a" stops at the failure
  bus.subscribe('b', () => seen.push('b'));        // still dispatched: later events continue
  bus.subscribe('c', async () => { throw new Error('handler C rejected'); }); // async rejection also collected

  let commitError = null;
  await bus.buffered(async (outbox) => {
    await bus.emit('a', {});
    await bus.emit('b', {});
    await bus.emit('c', {});
    try {
      await outbox.commit();
    } catch (error) {
      commitError = error;
    }
  });
  assert.deepEqual(seen, ['b'], 'the failing event stops its own handlers; later events still dispatch');
  assert.ok(commitError, 'commit surfaces the aggregated failure');
  assert.equal(commitError.code, 'EVENT_DISPATCH_FAILED');
  assert.equal(commitError.details.failures.length, 2);
  assert.match(commitError.details.failures[0], /handler A exploded/);
  assert.match(commitError.details.failures[1], /handler C rejected/);
});

test('a handler that emits during flush does not re-queue into the closed outbox', async () => {
  const bus = new EventBus();
  const seen = [];
  bus.subscribe('trigger', async () => {
    // Emitting from within a handler, during commit flush, must dispatch
    // immediately (outbox already exited), not vanish into a stale queue.
    await bus.emit('cascade', {});
  });
  bus.subscribe('cascade', () => seen.push('cascade'));

  await bus.buffered(async (outbox) => {
    await bus.emit('trigger', {});
    await outbox.commit();
  });
  assert.deepEqual(seen, ['cascade']);
});
