import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { m2Units, inspectCoverage, fingerprintOf, render } from '../scripts/spine-v2-m2-map.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const plan = read('docs', 'plans', 'production-spine-v2-postgresql.md');
const data = JSON.parse(read('docs', 'plans', 'spine-v2-m2-requirements.json'));

/**
 * Two shapes, because the holes have two shapes. A sentence arrives inside an
 * existing paragraph — which is the only way a missing terminator can merge it
 * into its neighbour — while a heading or a table row arrives between
 * paragraphs, as it would in any real edit. Inserting a heading *inside* a
 * paragraph would re-tokenize the prose around it and prove nothing about the
 * hole under test.
 */
const ANCHOR = 'Delete the compatibility path only after a repository guard';
const insertSentence = (line) => {
  assert.ok(plan.includes(ANCHOR), 'mid-section anchor moved; fix this fixture, not the plan');
  return plan.replace(ANCHOR, `${line} ${ANCHOR}`);
};
const BLOCK_ANCHOR = '#### Production binding and idempotency details';
const insertBlock = (line) => {
  // Inserted at an existing paragraph boundary. Dropping a block into the
  // middle of the numbered list would re-tokenize the list around it, and the
  // extra units that produced would be an artefact of the fixture rather than
  // the hole under test.
  assert.ok(plan.includes(BLOCK_ANCHOR), 'block anchor moved; fix this fixture, not the plan');
  return plan.replace(BLOCK_ANCHOR, `${line}\n\n${BLOCK_ANCHOR}`);
};

test('every M2 requirement unit is classified exactly once', () => {
  assert.deepEqual(inspectCoverage(m2Units(plan), data), []);
});

/**
 * **The only way this gate can lie is by dropping text before it counts it.**
 *
 * A unit the extractor discards is never counted, so it can never be reported
 * unclassified — the map stays green while the ratified plan grew a requirement
 * nobody read. Every case below was a live hole in the first cut of this file,
 * found by review rather than by me, and each is asserted as *surfaced and
 * unclassified*, never merely as "some failure occurred".
 */
test('no requirement can disappear before it is counted', () => {
  const cases = [
    ['question terminator', 'Must every unaudited write be refused?', insertSentence],
    ['exclamation terminator', 'Refuse every unaudited write!', insertSentence],
    ['short requirement', 'Encrypt every write.', insertSentence],
    ['requirement-bearing heading', '#### Refuse all writes in production', insertBlock],
    ['table row with an empty first cell', '|  | Every production write must carry a durable audit. |', insertBlock],
  ];
  for (const [label, line, insert] of cases) {
    const grown = insert(line);
    const units = m2Units(grown);
    // Compared on normalized whitespace, because that is what the extractor
    // stores and what the fingerprint is taken over.
    const expected = line.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
    const surfaced = units.find((unit) => unit.text === expected);
    assert.ok(surfaced, `${label}: the extractor dropped it, so nothing could ever report it`);
    const failures = inspectCoverage(units, data);
    assert.equal(failures.length, 1, `${label}: expected exactly the one new requirement to be unclassified`);
    assert.match(failures[0], new RegExp(`^unclassified ${surfaced.fingerprint}`), label);
  }
});

/**
 * **Positions are not identities, and this is the case that proved it.**
 *
 * Under numeric claims, inserting mid-section retargeted every later index: the
 * gate named only the old last unit, and assigning it turned the gate green
 * while the inserted requirement silently inherited someone else's
 * classification. Content fingerprints make the inserted text the only thing
 * reported, wherever it lands.
 */
test('an insertion is reported where it happened, not at the end', () => {
  const units = m2Units(insertSentence('Every renewal must be attested afresh.'));
  const failures = inspectCoverage(units, data);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /Every renewal must be attested afresh/);
  const last = m2Units(plan).at(-1);
  assert.doesNotMatch(failures[0], new RegExp(last.fingerprint), 'the final unit must not absorb an insertion elsewhere');
});

/** Editing a requirement orphans its claim *and* surfaces the new text; neither may pass alone. */
test('an edited requirement is reported twice over', () => {
  const edited = plan.replace('Existing `--db` remains', 'Existing `--db` stays');
  assert.notEqual(edited, plan, 'edit anchor moved; fix this fixture, not the plan');
  const failures = inspectCoverage(m2Units(edited), data);
  assert.ok(failures.some((f) => /no longer states/.test(f)), 'the old claim must be reported orphaned');
  assert.ok(failures.some((f) => /^unclassified/.test(f)), 'the new text must be reported unclassified');
});

/**
 * **The fix for positions reintroduced the omission it removed.** Two
 * verbatim-identical requirements share a fingerprint, so a single claim would
 * report both classified while one occurrence had no owner. Refused loudly, and
 * watched refusing: the plan states no duplicate today, so this is the only way
 * to know the rule works.
 */
test('a repeated requirement cannot be covered by one claim', () => {
  const units = m2Units(plan);
  assert.equal(new Set(units.map((u) => u.fingerprint)).size, units.length, 'the plan states no duplicate today');

  const repeated = insertSentence('Package validation rejects any mixed graph (for example package/action v2 exposing capability/operation v1) and declared capability requirements select an explicit async-capable version before application startup.');
  const grown = m2Units(repeated);
  assert.equal(grown.length, units.length + 1, 'the duplicate must be counted, not collapsed');
  const failures = inspectCoverage(grown, data);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /appears 2 times/);
});

test('the map refuses malformed classification', () => {
  const invented = { groups: data.groups.map((g) => (g.id === 'G01' ? { ...g, classification: 'DONE_TRUST_ME' } : g)) };
  assert.ok(inspectCoverage(m2Units(plan), invented).some((f) => /unknown classification/.test(f)));

  const homeless = {
    groups: data.groups.map((g) => (g.classification === 'DEFERRED_OUTSIDE_M2' ? { ...g, provedIn: undefined } : g)),
  };
  assert.ok(inspectCoverage(m2Units(plan), homeless).some((f) => /deferred without naming where it is proved/.test(f)));

  const overlapping = {
    groups: [...data.groups, { id: 'GXX', classification: 'CURRENT_CAMPAIGN', claims: [m2Units(plan)[0].fingerprint] }],
  };
  assert.ok(inspectCoverage(m2Units(plan), overlapping).some((f) => /claimed by both/.test(f)));
});

/** A generated document that nobody regenerates is a document that quietly disagrees with its source. */
test('the published map matches what the classification authority renders', () => {
  assert.equal(read('docs', 'plans', 'spine-v2-m2-requirement-map.md'), render(m2Units(plan), data));
});

test('no deferral is a dead end', () => {
  for (const group of data.groups.filter((g) => g.classification === 'DEFERRED_OUTSIDE_M2')) {
    assert.match(group.provedIn, /^M[345]$/, `${group.id} must name the milestone that proves it`);
    assert.ok(String(group.reason ?? '').length > 40, `${group.id} must say why it cannot be proved at M2-complete`);
  }
});

/** Fingerprints are content identity: same text same id, whitespace-insensitive, different text different id. */
test('fingerprints identify content', () => {
  assert.equal(fingerprintOf('Refuse every  unaudited write.'), fingerprintOf('Refuse every unaudited write.'));
  assert.notEqual(fingerprintOf('Refuse every unaudited write.'), fingerprintOf('Refuse every audited write.'));
});
