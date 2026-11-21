// @ts-check

/**
 * Mixed CSV import on the portable path (backlog:5bbf8bc9).
 *
 * The Mac validation of 20/11 found «rifiutata» with 400 on a 20-row CSV
 * with 3 bad rows, while 19 rows had been written anyway. On the portable
 * composition production serves /bo from, applying ANY row carrying a
 * companyName crashed the whole run: `findCompaniesByNormalizedName`
 * passed an array-mapping function as the per-row mapper of `storageMany`,
 * so the company lookup at write time threw `rows.filter is not a function`
 * (sender.js:318) and the apply died instead of writing the valid rows.
 * The preview never reaches that lookup when every row already carries an
 * external id and an email, so it answered while the apply crashed.
 *
 * What it must prove, on the production-shaped portable app (no `database`
 * handle, real sqlite): a preview of 17 valid + 3 bad rows answers 20
 * receipts with a reason each and records nothing (the apply right after
 * is not a replay); the apply writes the 17 valid rows, names the skipped
 * ones with their reason, and never refuses after writing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoAppAsync } from '../packages/app/src/index.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const customerData = await import(join(repoRoot, 'packages/customer-data/src/index.js'));

const ACTOR = { type: 'user', id: 'test-import-misto' };

function recordManifests(packageName) {
  return readdirSync(join(repoRoot, 'packages', packageName, 'modules'))
    .filter((file) => file.endsWith('.module.json'))
    .map((file) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, 'packages', packageName, 'modules', file), 'utf8'));
      return { name: manifest.name, manifest };
    });
}

async function portableApp(t) {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-import-misto-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const app = await createAccordoAppAsync({
    dbPath: join(directory, 'misto.sqlite'),
    selected: {
      packageContract: 2,
      packages: [customerData.createCustomerDataPackageV2()],
      actions: [],
      modules: recordManifests('customer-data'),
    },
  });
  t.after(() => app.close());
  return app;
}

/** 20 rows like the Mac file: 17 valid colleagues, 3 bad rows. */
function macRows() {
  const rows = [];
  for (let i = 1; i <= 17; i += 1) {
    rows.push({
      externalId: `E2E-${i}`,
      email: `prova.e2e.${i}@esempio.it`,
      firstName: 'Prova',
      lastName: `E2E ${i}`,
      companyName: 'Prova E2E',
      domain: 'esempio.it',
    });
  }
  rows.push({ externalId: 'E2E-BAD1', email: 'non-una-mail', firstName: 'Riga', lastName: 'Sbagliata' });
  rows.push({ firstName: 'SenzaIdentita' });
  rows.push({ externalId: 'E2E-BAD3', email: 'ok3@esempio.it', firstName: 'Brutto\0Nome', lastName: 'X' });
  return rows;
}

const BAD_CODES = ['INVALID_EMAIL', 'MISSING_REQUIRED_IDENTITY', 'UNSAFE_VALUE'];

test('a mixed preview answers row by row and records nothing', async (t) => {
  const app = await portableApp(t);
  const preview = await app.operations.run('preview-customer-import', {
    system: 'csv-prova', rows: macRows(), acceptance: 'partial', actor: ACTOR,
  });

  assert.equal(preview.mode, 'preview');
  assert.match(preview.writes, /neither business data nor an import run/);
  assert.deepEqual(preview.counts, { rows: 20, accepted: 17, rejected: 3, skipped: 0 });
  assert.equal(preview.receipts.length, 20, 'one receipt per input row, always');
  for (const [index, receipt] of preview.receipts.entries()) {
    assert.equal(receipt.index, index);
    assert.ok(receipt.outcome === 'accepted' || receipt.outcome === 'rejected' || receipt.outcome === 'skipped');
    assert.ok(typeof receipt.reasonCode === 'string' && receipt.reasonCode !== '');
    assert.ok(typeof receipt.reason === 'string' && receipt.reason !== '', `row ${index} says why`);
  }
  assert.deepEqual(
    preview.receipts.slice(17).map((receipt) => receipt.reasonCode),
    BAD_CODES,
    'the three bad rows are named with their reason, in file order',
  );
});

test('the apply after a preview is no replay: it writes the valid rows and names the skipped ones', async (t) => {
  const app = await portableApp(t);
  await app.operations.run('preview-customer-import', {
    system: 'csv-prova', rows: macRows(), acceptance: 'partial', actor: ACTOR,
  });

  // Never a refusal after writing: partial apply answers 200-shaped, never throws.
  const applied = await app.operations.run('apply-customer-import', {
    system: 'csv-prova', rows: macRows(), acceptance: 'partial', actor: ACTOR,
  });

  assert.equal(applied.replayed ?? false, false, 'the preview recorded nothing, so this apply is fresh work');
  assert.ok(applied.runId != null, 'the run is recorded');
  assert.deepEqual(applied.counts, { rows: 20, accepted: 17, rejected: 3, skipped: 0 });
  const created = applied.receipts.filter((receipt) => receipt.outcome === 'accepted');
  assert.equal(created.length, 17);
  for (const receipt of created) {
    assert.ok(receipt.subject?.id != null, `accepted row ${receipt.index} names the record it wrote`);
  }
  assert.deepEqual(
    applied.receipts.filter((receipt) => receipt.outcome !== 'accepted').map((receipt) => [receipt.index, receipt.reasonCode]),
    [[17, 'INVALID_EMAIL'], [18, 'MISSING_REQUIRED_IDENTITY'], [19, 'UNSAFE_VALUE']],
    'the summary names WHICH rows were skipped and why',
  );
});

test('a second preview after the apply finds the written rows', async (t) => {
  const app = await portableApp(t);
  await app.operations.run('apply-customer-import', {
    system: 'csv-prova', rows: macRows(), acceptance: 'partial', actor: ACTOR,
  });
  const again = await app.operations.run('preview-customer-import', {
    system: 'csv-prova', rows: macRows(), acceptance: 'partial', actor: ACTOR,
  });

  assert.deepEqual(again.counts, { rows: 20, accepted: 17, rejected: 3, skipped: 0 });
  assert.ok(
    again.receipts.slice(0, 17).every((receipt) => receipt.reasonCode === 'MATCHED_EXISTING'),
    'the 17 written rows now match existing records: the apply really wrote them',
  );
  assert.deepEqual(
    again.receipts.slice(17).map((receipt) => receipt.reasonCode),
    BAD_CODES,
  );
});
