// @ts-check

/**
 * The falsification kit has to be trustworthy in the direction that flatters us, so these tests
 * are about the ways it could report a tick it did not earn.
 *
 * They do not run the mutations — `node scripts/falsify.js` does that, in about two seconds, and
 * running it inside `npm test` would mean the suite edits its own source while it runs. What is
 * checked here is that every mutation still aims at code that exists, that its named defender
 * exists, and that the reporting cannot silently turn a miss into a hit.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MUTATIONS, firstFailingTest } from '../scripts/falsify.js';

test('every mutation still aims at code that is actually there', () => {
  for (const mutation of MUTATIONS) {
    const path = join(process.cwd(), mutation.file);
    assert.ok(existsSync(path), `${mutation.id} targets ${mutation.file}, which does not exist`);

    const source = readFileSync(path, 'utf8');
    const found = source.split(mutation.find).length - 1;
    assert.equal(
      found,
      mutation.occurrences ?? 1,
      `${mutation.id} expects to find "${mutation.find}" ${mutation.occurrences ?? 1} time(s) in `
      + `${mutation.file} and found it ${found}. The code moved: re-aim the mutation. A kit that `
      + 'silently stops aiming at anything keeps printing reassurance it has not earned.',
    );
  }
});

test('a mutation actually changes the source it targets', () => {
  for (const mutation of MUTATIONS) {
    assert.notEqual(
      mutation.find,
      mutation.replace,
      `${mutation.id} replaces its target with itself, so it removes no rule`,
    );
    const source = readFileSync(join(process.cwd(), mutation.file), 'utf8');
    assert.notEqual(
      source.split(mutation.find).join(mutation.replace),
      source,
      `${mutation.id} produces an identical file`,
    );
  }
});

test('every mutation names a defending suite that exists', () => {
  for (const mutation of MUTATIONS) {
    assert.ok(
      existsSync(join(process.cwd(), mutation.test)),
      `${mutation.id} claims to be defended by ${mutation.test}, which does not exist`,
    );
  }
});

test('every mutation says what it removes, what that would cost, and which claims it defends', () => {
  const seen = new Set();
  for (const mutation of MUTATIONS) {
    assert.ok(!seen.has(mutation.id), `duplicate mutation id "${mutation.id}"`);
    seen.add(mutation.id);

    assert.ok(mutation.rule?.length > 10, `${mutation.id} does not say what rule it removes`);
    assert.ok(mutation.breaks?.length > 10, `${mutation.id} does not say what breaking it would mean`);
    assert.ok(
      Array.isArray(mutation.claims) && mutation.claims.length > 0,
      `${mutation.id} names no ledger claim, so nothing connects it to a public sentence`,
    );
  }
});

test('every claim a mutation defends is in the ledger', () => {
  const ledger = JSON.parse(readFileSync(join(process.cwd(), 'site/claims.json'), 'utf8'));
  const ids = new Set(ledger.claims.map((/** @type {any} */ claim) => claim.id));
  for (const mutation of MUTATIONS) {
    for (const claim of mutation.claims) {
      assert.ok(ids.has(claim), `${mutation.id} defends ${claim}, which is not in site/claims.json`);
    }
  }
});

test('the failing-test reader names the first failure and stays silent when there is none', () => {
  const tap = [
    'TAP version 13',
    'ok 1 - something fine',
    'not ok 2 - approval workflow rejects an agent pretending to make the human decision',
    'not ok 3 - a later failure',
  ].join('\n');
  assert.equal(firstFailingTest(tap), 'approval workflow rejects an agent pretending to make the human decision');

  // A green stream must not yield a name: "caught by" is only ever printed for a real failure.
  assert.equal(firstFailingTest('TAP version 13\nok 1 - all good\n'), null);
  assert.equal(firstFailingTest(''), null);
  // "not ok" inside a test *title* is not a failure line, because the anchor is the line start.
  assert.equal(firstFailingTest('ok 1 - it is not ok to skip this\n'), null);
});

test('the documented mutation table matches the mutations that exist', () => {
  const doc = readFileSync(join(process.cwd(), 'docs/FALSIFY.md'), 'utf8');
  for (const mutation of MUTATIONS) {
    assert.ok(doc.includes(`\`${mutation.id}\``), `docs/FALSIFY.md does not document ${mutation.id}`);
    assert.ok(doc.includes(mutation.test), `docs/FALSIFY.md does not name ${mutation.test} as a defender`);
  }
});
