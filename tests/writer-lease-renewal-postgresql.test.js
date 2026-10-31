import test from 'node:test';
import assert from 'node:assert/strict';

import { bootPostgresqlApp } from './helpers/postgresql-application.js';

/**
 * The defect, reproduced against a real database and then closed.
 *
 * `renewWriterLease` existed from the beginning and had no caller anywhere in
 * this repository. `WRITER_LEASE_TTL_MS` is sixty seconds and `assertWriter()`
 * guards `maybeOne` and `many` as well as `execute`, so a PostgreSQL
 * application stopped being able to **read** one minute after it started.
 *
 * Nothing caught it because every PostgreSQL test here is shorter than a
 * minute. These two use a two-second lease so the expiry is inside a test, and
 * they are deliberately the pair: one proves the renewer works, the other
 * proves the guard still bites without it. A single test of the first kind
 * would pass just as well against a guard that had been removed.
 */

const SHORT_TTL_MS = 2_000;
const PAST_EXPIRY_MS = 2_600;

test('an application whose renewer is running still reads after the lease would have expired', async (t) => {
  const booted = await bootPostgresqlApp(t, { leaseTtlMs: SHORT_TTL_MS });
  if (!booted) return;
  const { app } = booted;

  assert.notEqual(app.leaseRenewer, undefined, 'the application must be able to reach its renewer');
  assert.equal(app.leaseRenewer.status().started, false, 'constructing it must start nothing');

  app.leaseRenewer.start();
  await new Promise((resolve) => { setTimeout(resolve, PAST_EXPIRY_MS); });

  const health = await app.health();
  assert.equal(health.ready, true, `still ready past the TTL, got ${JSON.stringify(health)}`);
  await app.services.companies.list();

  const status = app.leaseRenewer.status();
  assert.ok(status.renewals >= 1, `expected at least one renewal, saw ${status.renewals}`);
  assert.equal(status.lastOutcome, 'renewed');
  await app.leaseRenewer.stop();
});

test('the same application without its renewer stops being able to read, which is the defect', async (t) => {
  const booted = await bootPostgresqlApp(t, { leaseTtlMs: SHORT_TTL_MS });
  if (!booted) return;
  const { app } = booted;

  await app.services.companies.list();
  await new Promise((resolve) => { setTimeout(resolve, PAST_EXPIRY_MS); });

  const health = await app.health();
  assert.equal(health.ready, false);
  assert.equal(health.reason, 'WRITER_LEASE_EXPIRED');
  // Reads, not only writes. This is the half that made a sixty-second fuse
  // fatal rather than merely inconvenient.
  await assert.rejects(
    () => app.services.companies.list(),
    (error) => error.code === 'WRITER_LEASE_EXPIRED',
  );
});

test('renewing does not weaken the single writer: a second composition is still refused', { timeout: 90_000 }, async (t) => {
  const booted = await bootPostgresqlApp(t, { leaseTtlMs: SHORT_TTL_MS });
  if (!booted) return;
  booted.app.leaseRenewer.start();
  t.after(() => booted.app.leaseRenewer.stop());

  // The refusal below is only meaningful after a renewal has happened: an
  // unexpired initial lease refuses a second writer even with the renewer
  // dead. Wait for the steady state first, bounded so a dead renewer fails
  // here instead of weakening the assertion.
  const renewalDeadline = Date.now() + 20_000;
  while (booted.app.leaseRenewer.status().renewals < 1) {
    if (Date.now() >= renewalDeadline) {
      assert.fail(
        `the renewer never renewed within 20 s, saw ${JSON.stringify(booted.app.leaseRenewer.status())}`,
      );
    }
    await new Promise((resolve) => { setTimeout(resolve, 100); });
  }

  // One probe is timing-sensitive under a loaded CI: a transient transport
  // failure (a killed socket, a saturated pool) is not a verdict on the
  // single-writer property. Only two outcomes are decisive: HELD (the
  // property holds) and a successful second composition (it is violated).
  // Anything else is retried until the deadline, then fails with the last
  // error attached. A broken guard still fails fast: the intruder composes
  // and the test refuses below without another attempt.
  const attemptDeadline = Date.now() + 45_000;
  let lastError = null;
  for (;;) {
    let intruder = null;
    try {
      intruder = await bootPostgresqlApp(t, { planes: booted.planes, leaseTtlMs: SHORT_TTL_MS });
    } catch (error) {
      if (error?.code === 'WRITER_LEASE_HELD') return;
      lastError = error;
      if (Date.now() >= attemptDeadline) break;
      await new Promise((resolve) => { setTimeout(resolve, 500); });
      continue;
    }
    if (intruder) {
      try { await intruder.app.close(); } catch { /* the test already failed */ }
    }
    assert.fail('a renewed lease must still exclude a second writer: the second composition unexpectedly succeeded');
  }
  assert.fail(
    `no decisive verdict within 45 s: the second composition was never refused with `
    + `WRITER_LEASE_HELD (last: ${lastError?.code ?? lastError?.name ?? lastError})`,
  );
});
