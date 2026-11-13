// @ts-check

/**
 * A lease holder that can be killed. (backlog:f08d335e)
 *
 * Boots a PostgreSQL application on planes another process created, prints
 * READY once the writer lease is acquired, then sleeps until it is killed.
 * The renewer is deliberately never started: this is the process that dies
 * without releasing anything — SIGKILL, crash, power loss — so the test
 * proves the successor takes over on the short lease expiry, not on a
 * four-minute fuse.
 *
 * Config arrives as JSON on `ACCORDO_LEASE_HOLDER_CONFIG`:
 * `{ control, data, tenantId, leaseTtlMs }`, the same planes the parent test
 * opened with `openIsolatedPostgresqlPlanes`.
 */

import { bootPostgresqlApp } from './postgresql-application.js';

const raw = process.env.ACCORDO_LEASE_HOLDER_CONFIG;
if (!raw) {
  console.error('ACCORDO_LEASE_HOLDER_CONFIG is required');
  process.exit(2);
}

const config = JSON.parse(raw);

/** No test runner here: the parent owns every database this touches. */
const noTestContext = {
  skip() {},
  after() {},
};

try {
  const booted = await bootPostgresqlApp(noTestContext, {
    planes: { control: config.control, data: config.data },
    tenantId: config.tenantId,
    leaseTtlMs: config.leaseTtlMs,
  });
  if (!booted) {
    console.error('no database: the parent skips this shape, a holder cannot');
    process.exit(3);
  }
  process.stdout.write('READY\n');
  await new Promise(() => {});
} catch (error) {
  console.error(`holder boot failed: ${error?.code ?? error?.name ?? error}`);
  process.exit(1);
}
