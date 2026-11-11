// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  bootPostgresqlApp,
  openIsolatedPostgresqlPlanes,
} from './helpers/postgresql-application.js';

/**
 * The defect, reproduced with a real kill. (backlog:f08d335e)
 *
 * On Render the shared worker can die without a signal — SIGKILL, crash —
 * and release nothing. The writer lease of a space must then have a short
 * expiry so another worker takes the space over after the short expiry, not
 * after the ~4 minutes the old fuse needed at every deploy.
 *
 * A holder process boots on isolated planes and is killed with SIGKILL the
 * moment it reports READY. The successor must first be refused with
 * WRITER_LEASE_HELD (the dead process still owns the lease) and then compose
 * and write inside the short expiry — 15 s here, asserted under 60 s, an
 * order below the old blackout.
 */

const HOLDER_TTL_MS = 15_000;
const READY_DEADLINE_MS = 60_000;
const TAKEOVER_DEADLINE_MS = 90_000;
const TAKEOVER_ASSERT_MS = 60_000;
const ACTOR = { type: 'user', id: 'lease-takeover' };

test('a SIGKILLed holder loses its space to a successor inside the short lease expiry', { timeout: 150_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;

  const holderPath = new URL('./helpers/postgresql-lease-holder-child.mjs', import.meta.url);
  const holder = spawn(process.execPath, [holderPath.pathname], {
    env: {
      ...process.env,
      ACCORDO_LEASE_HOLDER_CONFIG: JSON.stringify({
        control: planes.control,
        data: planes.data,
        tenantId: 'acme',
        leaseTtlMs: HOLDER_TTL_MS,
      }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (holder.exitCode === null && holder.signalCode === null) {
      try { holder.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  let holderStderr = '';
  holder.stderr.on('data', (chunk) => { holderStderr += String(chunk); });
  const ready = await new Promise((resolve) => {
    const deadline = setTimeout(() => resolve(false), READY_DEADLINE_MS);
    holder.stdout.on('data', (chunk) => {
      if (String(chunk).includes('READY')) {
        clearTimeout(deadline);
        resolve(true);
      }
    });
    holder.on('exit', () => {
      clearTimeout(deadline);
      resolve(false);
    });
  });
  assert.equal(ready, true, `the holder never reported READY (stderr: ${holderStderr})`);

  holder.kill('SIGKILL');
  await new Promise((resolve) => { holder.on('exit', resolve); });
  const killTime = Date.now();

  // The dead holder still owns the lease: a successor right now is refused,
  // which is what makes the takeover below a lease expiry and not a free row.
  await assert.rejects(
    () => bootPostgresqlApp(t, { planes, leaseTtlMs: HOLDER_TTL_MS }),
    (error) => error?.code === 'WRITER_LEASE_HELD',
    'a successor before the short expiry must be refused with WRITER_LEASE_HELD',
  );

  let successor = null;
  let lastError = null;
  while (Date.now() - killTime < TAKEOVER_DEADLINE_MS) {
    try {
      successor = await bootPostgresqlApp(t, { planes, leaseTtlMs: HOLDER_TTL_MS });
      break;
    } catch (error) {
      if (error?.code !== 'WRITER_LEASE_HELD') throw error;
      lastError = error;
      await sleep(500);
    }
  }
  assert.ok(successor, `no takeover within ${TAKEOVER_DEADLINE_MS} ms (last: ${lastError?.code ?? lastError})`);
  const takeoverMs = Date.now() - killTime;
  assert.ok(
    takeoverMs < TAKEOVER_ASSERT_MS,
    `takeover took ${takeoverMs} ms, past the short-expiry bound of ${TAKEOVER_ASSERT_MS} ms`,
  );

  const created = await successor.app.services.companies.create({ name: 'Lease Takeover Co' }, { actor: ACTOR });
  assert.equal(created.name, 'Lease Takeover Co');
  const listed = await successor.app.services.companies.list();
  assert.ok(
    listed.some((company) => company.id === created.id),
    'the successor writes on the space, not only composes',
  );
});
