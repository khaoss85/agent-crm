// @ts-check
/**
 * Riprova del NON PASSA del verificatore su backlog:3a3e6eaff1c5
 * (2026-11-07: «non ho committato PNG bo:shots» per la schermata Stato sync).
 *
 * La schermata funzionale e coperta dai test (tests/admin-sync.test.js e
 * tests/admin-connector-detail.test.js, mappa in docs/backoffice/sync.md);
 * quello che mancava era la prova visibile: la coppia di PNG 1440x1800 e
 * 390x1600 resa con `npm run bo:shots -- --screen stato-sync`, committata in
 * docs/backoffice/verifica-2026-11-10/bo-shots/. Senza la coppia questo test
 * e rosso; con la coppia e verde.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESKTOP, PHONE, readPngSize } from '../scripts/bo-shots.js';

const shotsDir = join(
  fileURLToPath(new URL('.', import.meta.url)),
  '..',
  'docs',
  'backoffice',
  'verifica-2026-11-10',
  'bo-shots',
);

test('stato-sync carries its committed bo:shots proof pair (verifier 2026-11-07)', () => {
  for (const [viewport, floor] of [[DESKTOP, 20000], [PHONE, 10000]]) {
    const file = `stato-sync-${viewport.width}x${viewport.height}.png`;
    const shot = readPngSize(join(shotsDir, file));
    assert.equal(shot.width, viewport.width, `${file} renders at ${viewport.width}px wide`);
    assert.equal(shot.height, viewport.height, `${file} renders at ${viewport.height}px tall`);
    assert.ok(shot.bytes > floor, `${file} is a filled render (${shot.bytes}B over the ${floor}B floor)`);
  }
});
