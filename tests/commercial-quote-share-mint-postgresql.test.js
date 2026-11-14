// @ts-check

/**
 * Concurrent share-link mint on PostgreSQL (backlog:a3b394dd, P1 giro 5).
 *
 * Two share-link calls for the same approved version at the same instant must
 * leave exactly one live link row: the loser reuses the winner's link
 * (`alreadyExisted: true`, no bearer) instead of minting a second live token.
 * Sequential reuse is already covered on SQLite
 * (`tests/commercial-quote-share-link.test.js`); this file proves the
 * concurrent case where both executions overlap inside their own
 * SERIALIZABLE transactions.
 *
 * Skips cleanly without a database (the helper returns null); set
 * ACCORDO_PG_TEST_URL at a real PostgreSQL 16 to execute — CI always does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShareLinkAction } from '../packages/commercial/src/quote-share.js';

const { bootPostgresqlApp } = await import('./helpers/postgresql-application.js');

const here = dirname(fileURLToPath(import.meta.url));
const quoteShareManifest = JSON.parse(
  readFileSync(join(here, '..', 'packages', 'commercial', 'modules', 'quote-share.module.json'), 'utf8'),
);

/** Minimal quote shape: only what share-link reads (status gate + version pointer). */
function quoteStubManifest() {
  return {
    manifestVersion: 1,
    name: 'quote',
    description: 'Test stub: the approved-version pointer share-link mints for.',
    fields: [
      { name: 'status', type: 'string' },
      { name: 'currentVersionId', type: 'string' },
      { name: 'currentVersionNumber', type: 'integer' },
      { name: 'draftRevision', type: 'integer' },
    ],
  };
}

test('two concurrent share-link mints leave one live link; the loser reuses', { timeout: 120_000 }, async (t) => {
  // The portable PostgreSQL path requires a contract-2 graph; share-link ships
  // contract 1 on the sync path. The mint logic under test is identical —
  // only the envelope version differs.
  const shareLinkAction = { ...buildShareLinkAction(), actionContract: 2 };
  const booted = await bootPostgresqlApp(t, {
    selected: {
      packageContract: 2,
      packages: [],
      actions: [shareLinkAction],
      modules: [
        { name: 'quote', manifest: quoteStubManifest() },
        { name: 'quote-share', manifest: quoteShareManifest },
      ],
    },
  });
  if (!booted) return;
  const { app } = booted;
  const actor = { type: 'user', id: 'mint-race' };

  const quote = await app.modules.get('quote').service.create({
    status: 'approved',
    currentVersionId: 'v-race-1',
    currentVersionNumber: 1,
    draftRevision: 1,
  });

  const attempt = () => app.runAction({
    module: 'quote', action: 'share-link', recordId: quote.id, input: {}, actor,
  }).then((ran) => ({
    ok: true,
    alreadyExisted: ran.result.alreadyExisted,
    hasToken: ran.result.token !== null && ran.result.token !== undefined,
  })).catch((error) => ({
    ok: false, code: error.code ?? null, message: String(error.message).slice(0, 160),
  }));

  const [first, second] = await Promise.all([attempt(), attempt()]);
  const minted = [first, second].filter((row) => row.ok && !row.alreadyExisted);
  const reused = [first, second].filter((row) => row.ok && row.alreadyExisted);
  const outcomes = [first, second]
    .map((row) => `${row.ok}:${row.ok ? (row.alreadyExisted ? 'reused' : 'minted') : row.code}`)
    .sort();
  assert.deepEqual(
    outcomes,
    ['true:minted', 'true:reused'],
    `one call mints, the other reuses (got ${JSON.stringify([first, second])})`,
  );
  assert.equal(minted.length, 1);
  assert.equal(reused.length, 1, `the loser reuses instead of erroring (got ${JSON.stringify([first, second])})`);
  assert.equal(minted[0].hasToken, true, 'the minted result carries the bearer once');
  assert.equal(reused[0].hasToken, false, 'the reused link carries no second bearer');

  const rows = await app.modules.get('quote-share').service.listWhere({ quoteVersionId: 'v-race-1' });
  assert.equal(rows.length, 1, `one row per version after a concurrent mint (got ${rows.length})`);
  assert.equal(rows[0].status, 'active');
});
