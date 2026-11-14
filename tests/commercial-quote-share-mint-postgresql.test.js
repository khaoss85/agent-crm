// @ts-check

/**
 * Concurrent share-link mint on PostgreSQL (backlog:a3b394dd, P1 giro 6).
 *
 * Two share-link mints for the same approved version run at the same instant
 * in TWO SEPARATE OS PROCESSES (not two calls in one process): each process
 * has its own in-process mint lock, so only the database gate can serialize
 * them. Exactly one mint must win; the loser reuses the winner's link
 * (`alreadyExisted: true`, no bearer) instead of minting a second live row.
 * Sequential reuse is already covered on SQLite
 * (`tests/commercial-quote-share-link.test.js`).
 *
 * Rig: both workers share the test's data plane but boot with a DIFFERENT
 * control database each. The writer lease lives in the control plane (one
 * writer per tenant), so two full writers cannot share one control database
 * — exactly like web and worker in production. The gate under test
 * (same-row quote fence + SERIALIZABLE + runtime retry) lives entirely on
 * the data plane, so the race stays real. A gate file releases both mints
 * only after both workers are booted, so boot skew cannot serialize them.
 *
 * Skips cleanly without a database; set ACCORDO_PG_TEST_URL at a real
 * PostgreSQL 16 to execute — CI always does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { openIsolatedPostgresqlPlanes } from './helpers/postgresql-application.js';
import { PG_TEST_URL } from './helpers/storage-contract-cases.js';
import { bootStubShareApp } from './helpers/quote-share-mint-app.mjs';

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, 'helpers', 'quote-share-mint-worker.mjs');

/**
 * A spare control database for one mint worker: same server, fresh lease
 * table, sharing the test's data plane. Dropped at teardown.
 */
async function openSpareControlDb(t, base) {
  const admin = new Client({ connectionString: PG_TEST_URL, connectionTimeoutMillis: 2000 });
  await admin.connect();
  const name = `am3cc${randomUUID().replace(/-/g, '').slice(0, 10)}`;
  await admin.query(`CREATE DATABASE ${name}`);
  t.after(async () => {
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [name],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    } catch {
      /* teardown is best-effort */
    } finally {
      try { await admin.end(); } catch { /* ignore */ }
    }
  });
  return { ...base, database: name };
}

/** Spawn one mint worker; resolves READY once booted, result once exited. */
function startMintWorker(params) {
  const child = spawn(process.execPath, ['--no-warnings', WORKER, JSON.stringify(params)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  let ready = false;
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { err += chunk; });
  child.on('error', () => {});
  const readyPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mint worker never READY; stderr tail: ${err.slice(-2000)}`));
    }, 120_000);
    const check = () => {
      if (out.split('\n').some((line) => line.trim() === 'READY')) {
        ready = true;
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout.on('data', check);
    child.on('close', (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(
          `mint worker exited ${code} before READY; stderr tail: ${err.slice(-2000)}; stdout tail: ${out.slice(-2000)}`,
        ));
      }
    });
  });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`mint worker timed out; stderr tail: ${err.slice(-2000)}`));
    }, 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const line = out.split('\n').find((entry) => entry.startsWith('SHARE_MINT_RESULT '));
      if (code !== 0 || !line) {
        reject(new Error(
          `mint worker exit ${code}; stderr tail: ${err.slice(-2000)}; stdout tail: ${out.slice(-2000)}`,
        ));
        return;
      }
      resolve(JSON.parse(line.slice('SHARE_MINT_RESULT '.length)));
    });
  });
  return { ready: readyPromise, result };
}

test('two share-link mints in separate processes leave one live link; the loser reuses', { timeout: 180_000 }, async (t) => {
  const planes = await openIsolatedPostgresqlPlanes(t);
  if (!planes) return;
  const tenantId = 'acme';
  const app = await bootStubShareApp({ control: planes.control, data: planes.data, tenantId });
  t.after(() => app.close());

  const quote = await app.modules.get('quote').service.create({
    status: 'approved',
    currentVersionId: 'v-race-1',
    currentVersionNumber: 1,
    draftRevision: 1,
  });

  const controlA = await openSpareControlDb(t, planes.control);
  const controlB = await openSpareControlDb(t, planes.control);
  const gateDir = mkdtempSync(join(tmpdir(), 'accordo-mint-gate-'));
  const gateFile = join(gateDir, 'release');
  t.after(() => rmSync(gateDir, { recursive: true, force: true }));

  const params = (control) => ({
    control,
    data: planes.data,
    tenantId,
    quoteId: quote.id,
    gateFile,
  });
  const workerA = startMintWorker(params(controlA));
  const workerB = startMintWorker(params(controlB));
  await Promise.all([workerA.ready, workerB.ready]);
  writeFileSync(gateFile, 'go');
  const [first, second] = await Promise.all([workerA.result, workerB.result]);
  const outcomes = [first, second]
    .map((row) => `${row.ok}:${row.ok ? (row.alreadyExisted ? 'reused' : 'minted') : row.code}`)
    .sort();
  assert.deepEqual(
    outcomes,
    ['true:minted', 'true:reused'],
    `one worker mints, the other reuses (got ${JSON.stringify([first, second])})`,
  );
  const minted = [first, second].filter((row) => row.ok && !row.alreadyExisted);
  const reused = [first, second].filter((row) => row.ok && row.alreadyExisted);
  assert.equal(minted.length, 1);
  assert.equal(reused.length, 1, `the loser reuses instead of erroring (got ${JSON.stringify([first, second])})`);
  assert.equal(minted[0].hasToken, true, 'the minted result carries the bearer once');
  assert.equal(reused[0].hasToken, false, 'the reused link carries no second bearer');

  const rows = await app.modules.get('quote-share').service.listWhere({ quoteVersionId: 'v-race-1' });
  assert.equal(rows.length, 1, `one row per version after a cross-process concurrent mint (got ${rows.length})`);
  assert.equal(rows[0].status, 'active');
});
