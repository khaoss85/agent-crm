import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../packages/core/src/errors.js';
import {
  createWriterLeaseRenewer,
  renewalIntervalMs,
} from '../packages/core/src/writer-lease-renewer.js';

/**
 * A controllable scheduler. No real time passes in this file: a renewer tested
 * with real sleeps is a renewer whose interval nobody dares exercise, which is
 * how the branch that matters ends up never running.
 */
function fakeScheduler() {
  const pending = [];
  return {
    schedule(fn, ms) { const entry = { fn, ms }; pending.push(entry); return entry; },
    cancel(entry) { const i = pending.indexOf(entry); if (i >= 0) pending.splice(i, 1); },
    pending: () => [...pending],
    /** Fire the single armed timer and settle whatever it started. */
    async fire() {
      const entry = pending.shift();
      assert.ok(entry, 'expected a timer to be armed');
      entry.fn();
      await new Promise((resolve) => { setImmediate(resolve); });
      await new Promise((resolve) => { setImmediate(resolve); });
      return entry.ms;
    },
  };
}

function refusal(code) {
  return new AppError(code, { code, status: 409 });
}

test('the interval is derived from the lease, not chosen beside it', () => {
  assert.equal(renewalIntervalMs(60_000), 20_000);
  assert.equal(renewalIntervalMs(3_000), 1_000);
  // Two failures still fit before expiry, which is the whole reason for a third.
  assert.ok(renewalIntervalMs(60_000) * 2 < 60_000);
});

test('constructing arms nothing: a renewer runs because something started it', () => {
  const clock = fakeScheduler();
  const renewer = createWriterLeaseRenewer({
    renewOnce: async () => { throw new Error('must not be called'); },
    leaseTtlMs: 60_000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  assert.deepEqual(clock.pending(), []);
  assert.equal(renewer.status().started, false);
  assert.equal(renewer.status().renewals, 0);
});

test('a started renewer keeps renewing, and each success arms the next', async () => {
  const clock = fakeScheduler();
  let calls = 0;
  const renewer = createWriterLeaseRenewer({
    renewOnce: async () => { calls += 1; },
    leaseTtlMs: 60_000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  renewer.start();
  assert.equal(await clock.fire(), 20_000);
  assert.equal(await clock.fire(), 20_000);
  assert.equal(calls, 2);
  assert.equal(renewer.status().renewals, 2);
  assert.equal(renewer.status().lastOutcome, 'renewed');
});

/**
 * The branch that decides whether this is a renewer or a fight. Someone else
 * holds the lease now; renewing harder would be competing with the successor.
 */
test('a lost lease is surrendered, not contested', async () => {
  const clock = fakeScheduler();
  const renewer = createWriterLeaseRenewer({
    renewOnce: async () => { throw refusal('WRITER_LEASE_MISMATCH'); },
    leaseTtlMs: 60_000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  renewer.start();
  await clock.fire();

  assert.equal(renewer.status().lastOutcome, 'surrendered');
  assert.equal(renewer.status().stopped, true);
  assert.deepEqual(clock.pending(), [], 'a surrendered renewer must not arm another attempt');
  assert.throws(() => renewer.start(), (e) => e.code === 'WRITER_LEASE_RENEWER_STOPPED');
});

test('an expired lease is surrendered too: it cannot be renewed without a fresh attestation', async () => {
  const clock = fakeScheduler();
  const renewer = createWriterLeaseRenewer({
    renewOnce: async () => { throw refusal('WRITER_LEASE_EXPIRED'); },
    leaseTtlMs: 60_000, schedule: clock.schedule, cancel: clock.cancel,
  });
  renewer.start();
  await clock.fire();
  assert.equal(renewer.status().lastOutcome, 'surrendered');
  assert.deepEqual(clock.pending(), []);
});

test('a transient failure retries inside the window rather than surrendering', async () => {
  const clock = fakeScheduler();
  let calls = 0;
  const renewer = createWriterLeaseRenewer({
    renewOnce: async () => {
      calls += 1;
      if (calls === 1) throw new AppError('unreachable', { code: 'STORAGE_UNAVAILABLE', status: 503 });
    },
    leaseTtlMs: 60_000, schedule: clock.schedule, cancel: clock.cancel,
  });
  renewer.start();
  await clock.fire();
  assert.equal(renewer.status().lastOutcome, 'retrying');
  assert.equal(renewer.status().stopped, false);

  await clock.fire();
  assert.equal(renewer.status().lastOutcome, 'renewed');
  assert.equal(renewer.status().renewals, 1);
});

test('a rejecting renewal never reaches the scheduler as an unhandled rejection', async () => {
  const seen = [];
  const onUnhandled = (reason) => seen.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const clock = fakeScheduler();
    const renewer = createWriterLeaseRenewer({
      renewOnce: async () => { throw new Error('boom'); },
      leaseTtlMs: 60_000, schedule: clock.schedule, cancel: clock.cancel,
    });
    renewer.start();
    await clock.fire();
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    assert.deepEqual(seen, [], 'an async timer callback that rejects is a process exit');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('stop is bounded: it waits for a renewal in flight and arms nothing after', async () => {
  const clock = fakeScheduler();
  let release;
  const renewer = createWriterLeaseRenewer({
    renewOnce: () => new Promise((resolve) => { release = resolve; }),
    leaseTtlMs: 60_000, schedule: clock.schedule, cancel: clock.cancel,
  });
  renewer.start();
  const fired = clock.fire();
  const stopping = renewer.stop();
  release();
  await Promise.all([fired, stopping]);
  assert.equal(renewer.status().stopped, true);
  assert.deepEqual(clock.pending(), []);
});

test('the status carries counts and codes, and no identity', async () => {
  const clock = fakeScheduler();
  const renewer = createWriterLeaseRenewer({
    renewOnce: async () => {}, leaseTtlMs: 60_000, schedule: clock.schedule, cancel: clock.cancel,
  });
  renewer.start();
  await clock.fire();
  const serialised = JSON.stringify(renewer.status());
  for (const forbidden of ['tenant', 'leaseId', 'lease_id', 'postgres://']) {
    assert.equal(serialised.includes(forbidden), false, `status must not carry ${forbidden}`);
  }
  assert.equal(Object.isFrozen(renewer.status()), true);
});
