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

test('renewing does not weaken the single writer: a second composition is still refused', async (t) => {
  const booted = await bootPostgresqlApp(t, { leaseTtlMs: SHORT_TTL_MS });
  if (!booted) return;
  booted.app.leaseRenewer.start();
  t.after(() => booted.app.leaseRenewer.stop());

  await assert.rejects(
    () => bootPostgresqlApp(t, { planes: booted.planes, leaseTtlMs: SHORT_TTL_MS }),
    (error) => error.code === 'WRITER_LEASE_HELD',
    'a renewed lease must still exclude a second writer',
  );
});
