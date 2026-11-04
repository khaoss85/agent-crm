import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_SUBMISSION_REQUIRED } from '../apps/admin/public/admin-submission.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * Scritture del /bo sotto il controller (voce 5a553cb3).
 *
 * Produzione 04/11: le 6 scritture della scheda cliente erano morte dal
 * 31/10 senza nessuna richiesta di rete. La scheda usava il client grezzo,
 * che rifiuta ogni scrittura senza Idempotency-Key prima del fetch
 * (requireSubmissionContext), mentre le altre schermate erano passate a
 * bindAdminMutations (#567, #581). Un finto client permissivo nasconde una
 * scrittura morta: i finti di tests/admin-*.test.js rifiutano la scrittura
 * senza chiave (helpers/admin-strict-client.js).
 *
 * Questa guardia elenca le schermate con client.request di scrittura e
 * fallisce se una non passa dal controller: o lega lei stessa
 * (bindAdminMutations, o il suo controller come catalog/modules/assistant),
 * o ogni suo importatore di produzione lega (sezioni service, lifecycle,
 * delivery, contracts, custom-fields sotto le schermate che legano).
 * Togliere il bind da una schermata che scrive fa fallire questa guardia
 * e arrossa i test di quella schermata sotto il finto severo.
 */

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps/admin/public');

const sources = () => {
  const files = readdirSync(PUBLIC_DIR).filter((name) => /^admin-.*\.js$/.test(name));
  return new Map(files.map((name) => [name, readFileSync(join(PUBLIC_DIR, name), 'utf8')]));
};

const HAS_WRITE = /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/;
const HAS_REQUEST = /\.request\s*\(/;
const BINDS_ITSELF = /bindAdminMutations\(|submissions\.submit\(|issueAdminKey\(/;

const importersOf = (files, name) => {
  const found = [];
  for (const [other, src] of files) {
    if (other === name) continue;
    if (src.includes(`from './${name.replace(/\.js$/, '')}.js'`) || src.includes(`from "./${name.replace(/\.js$/, '')}.js"`)) found.push(other);
  }
  return found;
};

const writes = (src) => HAS_WRITE.test(src) && HAS_REQUEST.test(src);

/** A file is covered when it binds itself, or every production importer is covered. */
const covered = (files, name, trail = []) => {
  const src = files.get(name);
  if (src === undefined) return { ok: false, why: `${name} not found` };
  if (BINDS_ITSELF.test(src)) return { ok: true, via: name };
  if (trail.includes(name)) return { ok: false, why: `import cycle: ${[...trail, name].join(' -> ')}` };
  const importers = importersOf(files, name);
  if (importers.length === 0) return { ok: false, why: `${name} writes but binds nothing and no screen imports it` };
  for (const parent of importers) {
    const up = covered(files, parent, [...trail, name]);
    if (!up.ok) return { ok: false, why: `${name} rides ${parent}, which is not covered (${up.why})` };
  }
  return { ok: true, via: importers.join(', ') };
};

test('every /bo screen that writes goes through the submission controller', () => {
  const files = sources();
  const writing = [...files].filter(([, src]) => writes(src)).map(([name]) => name);
  assert.ok(writing.length > 0, 'the guard sees writing screens');
  const uncovered = [];
  for (const name of writing) {
    const result = covered(files, name);
    if (!result.ok) uncovered.push(result.why);
  }
  assert.deepEqual(uncovered, [], `writing screens outside the controller:\n${uncovered.join('\n')}\n(writing screens: ${writing.join(', ')})`);
});

test('the strict fake refuses an unkeyed write with the real client code', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(
      () => enforceAdminWriteGate('/api/x', { method }),
      (error) => error.code === ADMIN_SUBMISSION_REQUIRED,
      `${method} without a key throws ${ADMIN_SUBMISSION_REQUIRED}`,
    );
    assert.throws(
      () => enforceAdminWriteGate('/api/x', { method, idempotencyKey: 'v1.20261104.abc', headers: { 'Idempotency-Key': 'other' } }),
      (error) => error.code === ADMIN_SUBMISSION_REQUIRED,
      `${method} with a diverged header throws ${ADMIN_SUBMISSION_REQUIRED}`,
    );
  }
  assert.doesNotThrow(() => enforceAdminWriteGate('/api/x'), 'reads stay open without a key');
  assert.doesNotThrow(
    () => enforceAdminWriteGate('/api/x', { method: 'POST', idempotencyKey: 'k', headers: { 'Idempotency-Key': 'k' } }),
    'a keyed write travels with its header unchanged',
  );
});
