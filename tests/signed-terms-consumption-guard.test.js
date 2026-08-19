import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * **The guard: a new signed-term consumer cannot appear without the verifier.**
 *
 * M-1 was not a missing check in one file — it was a *class* of omission. A
 * snapshot is signed evidence only because somebody recomputed its fingerprint,
 * and the next package to read `quote-version-term` or `order-term` will be
 * written by somebody who never read this ADR. So the inventory is asserted
 * here rather than remembered: the set of files that touch a signed-term
 * record is pinned, and every one of them either verifies through
 * `commercial-quotes@2` or is on the list of files that legitimately do not.
 *
 * When this test fails, the fix is never to widen the allow-list silently. It
 * is to answer, in the PR: does this new path describe terms as signed? If yes,
 * it calls the verifier. If no, it says why in the entry it adds here.
 */

/** Records whose rows are signed-term evidence. */
const SIGNED_TERM_RECORDS = ['quote-version-term', 'order-term'];
/** Reads that mean "somebody is about to treat this as a term". */
const CONSUMPTION_MARKERS = [/versionTerm\b/, /orderTerm\b/, /signedTerm\b/, /termsFingerprint\b/];

/**
 * Files that touch signed-term evidence and do **not** call the verifier, each
 * with the reason it does not need to. Anything not listed here must verify.
 */
const EXEMPT = new Map([
  ['packages/commercial/src/terms.js',
    'the fingerprint authority itself — it computes the canonical value the verifier recomputes'],
  ['packages/commercial/src/verify-terms.js',
    'the verifier'],
  ['packages/commercial/src/capability.js',
    'the capability that exposes the verifier'],
  ['packages/commercial/src/actions.js',
    'the producer: quote.submit validates the draft and writes the snapshot, so there is nothing yet to verify'],
  ['packages/commercial/src/index.js',
    'package declaration only'],
  ['packages/signature/src/capability.js',
    'signature-orders@1 hands the order-term row to its consumer; the consumer verifies it before treating it as signed'],
  ['packages/signature/src/index.js',
    'package declaration only'],
  ['packages/contracts/src/dates.js',
    'pure date arithmetic over an already-verified snapshot'],
  ['packages/contracts/src/index.js',
    'package declaration only'],
  ['packages/contracts/src/succession.js',
    'consumes loadActivationSource, which verifies; it never reads a term record directly'],
  ['packages/contracts/src/lifecycle-capability.js',
    'derives signed: true from contract.termsSource, a column only an activation that already verified could write — '
    + 'it reads no term record, and re-verifying a copy of a decision is not the same as verifying the evidence'],
  ['apps/admin/public/admin-contracts.js',
    'renders what the verified server response already decided; the browser verifies nothing'],
  ['apps/admin/public/admin-lifecycle.js',
    'renders what the verified server response already decided; the browser verifies nothing'],
]);

/** Files that must contain a verifier call. */
const MUST_VERIFY = new Map([
  ['packages/signature/src/operations.js',
    'builds and hashes the signed document — a corrupt term must refuse before the provider is called'],
  ['packages/contracts/src/activation.js',
    'loadActivationSource is the single read every activation, lifecycle-source and M16b path shares'],
]);

const VERIFIER_CALL = /verifySignedTerms\s*\(/;

function sourceFiles(dir) {
  const found = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === 'node_modules' || name === 'generated' || name === 'modules') continue;
      found.push(...sourceFiles(path));
      continue;
    }
    if (name.endsWith('.js') && !name.endsWith('.test.js')) found.push(path);
  }
  return found;
}

test('every file that consumes signed-term evidence verifies it, or is listed with its reason', () => {
  const roots = ['packages/commercial/src', 'packages/signature/src', 'packages/contracts/src', 'packages/lifecycle/src', 'apps/admin/public'];
  /** @type {string[]} */
  const consumers = [];
  for (const root of roots) {
    for (const path of sourceFiles(join(repoRoot, root))) {
      const source = readFileSync(path, 'utf8');
      const touches = SIGNED_TERM_RECORDS.some((record) => source.includes(record))
        || CONSUMPTION_MARKERS.some((marker) => marker.test(source));
      if (touches) consumers.push(path.slice(repoRoot.length).replace(/^\//, ''));
    }
  }
  consumers.sort();

  const unaccounted = consumers.filter((file) => !EXEMPT.has(file) && !MUST_VERIFY.has(file));
  assert.deepEqual(unaccounted, [],
    'a new file consumes signed-term evidence. Either call verifySignedTerms through commercial-quotes@2, '
    + 'or add it to EXEMPT with the reason it does not need to — never silently.');

  for (const [file, why] of MUST_VERIFY) {
    assert.ok(consumers.includes(file), `${file} no longer reads signed-term evidence — update the guard (${why})`);
    assert.match(readFileSync(join(repoRoot, file), 'utf8'), VERIFIER_CALL,
      `${file} must verify signed terms: ${why}`);
  }

  // The authority is not duplicated: nobody outside Commercial recomputes a
  // term fingerprint, which is the property that keeps one answer in one place.
  for (const file of consumers) {
    if (file.startsWith('packages/commercial/')) continue;
    const source = readFileSync(join(repoRoot, file), 'utf8');
    assert.doesNotMatch(source, /signedTermFingerprint\s*\(/,
      `${file} recomputes a term fingerprint outside Commercial — the authority lives in one package`);
    assert.doesNotMatch(source, /createHash\((['"])sha256\1\)[\s\S]{0,200}?term/i,
      `${file} appears to hash term values itself — call the verifier instead`);
  }
});

test('the verifier is reached only through the declared capability, never by import', () => {
  for (const root of ['packages/signature/src', 'packages/contracts/src', 'packages/lifecycle/src']) {
    for (const path of sourceFiles(join(repoRoot, root))) {
      const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(source, /from '[^']*commercial\/src\/(terms|verify-terms)\.js'/,
        `${path.slice(repoRoot.length)} imports Commercial's private term modules; reach them through commercial-quotes@2`);
    }
  }
});
