// @ts-check

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../packages/core/src/errors.js';
import { PG_REQUIRED, PG_TEST_URL } from './storage-contract-cases.js';
import { createTestVerifier } from './identity-verifier-fixture.mjs';
import { createAccordoAppAsync } from '../../packages/app/src/index.js';

const { Client } = pg;

function parseUrl(url) {
  const parsed = new URL(url);
  return {
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port || 5432),
    user: decodeURIComponent(parsed.username || 'postgres'),
    password: decodeURIComponent(parsed.password || ''),
  };
}

function safeIdent(prefix) {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`;
}

/**
 * Isolated control and data PostgreSQL databases for application tests.
 *
 * @param {import('node:test').TestContext} t
 * @param {{ dataCount?: number }} [options]
 * @returns {Promise<null | { control: object, data: object, dataPlanes: object[] }>}
 */
export async function openIsolatedPostgresqlPlanes(t, options = {}) {
  const admin = new Client({ connectionString: PG_TEST_URL, connectionTimeoutMillis: 2000 });
  try {
    await admin.connect();
  } catch (error) {
    if (PG_REQUIRED) {
      throw new AppError(
        'ACCORDO_PG_TEST_REQUIRED: PostgreSQL 16 is required for this suite.',
        { code: 'ACCORDO_PG_TEST_REQUIRED', status: 503 },
      );
    }
    t.skip('PostgreSQL 16 is not reachable locally; CI always runs this suite against postgres:16');
    return null;
  }

  const dataCount = Number.isInteger(options.dataCount) && options.dataCount > 0 ? options.dataCount : 1;
  const base = parseUrl(PG_TEST_URL);
  const controlName = safeIdent('am3cc');
  const dataNames = Array.from({ length: dataCount }, () => safeIdent('am3cd'));
  await admin.query(`CREATE DATABASE ${controlName}`);
  for (const dataName of dataNames) {
    await admin.query(`CREATE DATABASE ${dataName}`);
  }

  t.after(async () => {
    try {
      await admin.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1) AND pid <> pg_backend_pid()',
        [[controlName, ...dataNames]],
      );
      await admin.query(`DROP DATABASE IF EXISTS ${controlName}`);
      for (const dataName of dataNames) {
        await admin.query(`DROP DATABASE IF EXISTS ${dataName}`);
      }
    } catch {
      /* teardown is best-effort */
    } finally {
      try { await admin.end(); } catch { /* ignore */ }
    }
  });

  const dataPlanes = dataNames.map((database) => ({ ...base, database }));
  return {
    control: { ...base, database: controlName },
    data: dataPlanes[0],
    dataPlanes,
  };
}

export const GADGET_MIGRATION = Object.freeze({
  name: 'pg_bootstrap_gadgets',
  sql: `CREATE SCHEMA IF NOT EXISTS "accordo";
CREATE TABLE IF NOT EXISTS "accordo"."gadgets" (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
`,
});

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [overrides]
 */
export async function bootPostgresqlApp(t, overrides = {}) {
  const planes = overrides.planes ?? await openIsolatedPostgresqlPlanes(t);
  if (!planes) return null;
  const tenantId = overrides.tenantId ?? 'acme';
  const data = overrides.data ?? planes.data;
  const identityVerifier = overrides.identityVerifier ?? createTestVerifier({ tenantId });
  const app = await createAccordoAppAsync({
    adapter: 'postgresql',
    testHarness: {
      loopback: true,
      control: planes.control,
      data,
      queryDeadlineMs: overrides.queryDeadlineMs,
      leaseTtlMs: overrides.leaseTtlMs,
    },
    spine: { mode: 'local-development', tenant: { id: tenantId } },
    identityVerifier,
    selected: overrides.selected,
    moduleMigrations: overrides.moduleMigrations ?? [GADGET_MIGRATION],
    clock: overrides.clock,
    faultInject: overrides.faultInject,
    now: overrides.now,
    leaseTtlMs: overrides.leaseTtlMs,
    queryDeadlineMs: overrides.queryDeadlineMs,
    rebind: overrides.rebind,
    promoteClone: overrides.promoteClone,
    telemetry: overrides.telemetry,
    productionOperations: overrides.productionOperations,
  });
  t.after(() => app.close());
  return { app, planes, tenantId, data };
}

export function assertNoSecrets(value, extras = []) {
  const haystack = JSON.stringify(value);
  for (const token of ['s3cret', 'SUPERSECRET', 'password=', PG_TEST_URL, ...extras]) {
    if (typeof token === 'string' && token !== '' && haystack.includes(token)) {
      throw new Error(`payload leaked ${token}`);
    }
  }
}
