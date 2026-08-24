// @ts-check

/**
 * `npm run tour` composes the starter application and prints what it contains. Those counts are
 * quoted in evidence-bearing launch, strategy, README, answer and concept surfaces. The human
 * landing page deliberately carries no composition counts.
 *
 * They drifted. Merging M14b2 added records and actions, and every one of those documents went on
 * saying 55 modules and 35 actions, which would have shipped a false number onto a public page
 * without a single test noticing. A claim bound to a test that never re-measures it is not bound
 * to anything.
 *
 * So this test runs the real tour and holds the prose to it. It is slow on purpose: the whole
 * point is that nothing here is transcribed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/** The labels the documents spell out, in the words they use. */
const LABELS = ['modules', 'packages', 'resources', 'actions', 'policies', 'providers'];

/**
 * Every surface that quotes the tour's counts, and which side of the label the number sits on.
 * Prose writes "61 modules"; the landing page prints a column-aligned terminal transcript, where
 * the label comes first and a count-first sweep silently reads the *previous* column.
 *
 * The landing page was the one surface the first version of this test did not sweep, and it was
 * stale — which is the argument for listing every surface rather than the ones that came to mind.
 */
const QUOTING_SURFACES = [
  { path: 'docs/marketing/LAUNCH_PACKET.md', order: 'count-first' },
  { path: 'docs/strategy/GO_TO_MARKET.md', order: 'count-first' },
  { path: 'README.md', order: 'label-first' },
  // The answer pages quote the composition in prose, and they are the pages an answer engine
  // is most likely to lift a number out of.
  { path: 'site/answers.json', order: 'count-first' },
  // And the concepts cluster, which is the surface this list did not name and which was
  // therefore stale: `concepts/customer-and-revenue-os.html` published "68 modules, 4 packages,
  // 32 resources, 52 actions, 7 policies and 10 providers" while the tour composed 70, 6, 41,
  // 56, 7 and 5. Nothing caught it, because a sweep only guards the surfaces it is told about —
  // which is the same argument this file already makes two paragraphs above.
  { path: 'site/concepts.json', order: 'count-first' },
];

const NUMERALS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen',
  'nineteen', 'twenty',
];

/** @type {any} */
let tour;

test('the tour composes a non-empty application', { timeout: 600_000 }, () => {
  const run = spawnSync(process.execPath, ['--no-warnings', join(process.cwd(), 'scripts/tour.js'), '--json'], {
    encoding: 'utf8',
    cwd: process.cwd(),
    timeout: 540_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(run.status, 0, `the tour must succeed for its counts to mean anything: ${run.stderr}`);

  tour = JSON.parse(run.stdout);
  assert.equal(tour.ok, true);
  for (const label of LABELS) {
    assert.ok(tour.counts[label] > 0, `the tour composed no ${label}, so every quoted count is wrong`);
  }
});

test('the claims ledger states the counts the tour actually produced', () => {
  assert.ok(tour, 'the tour test must run first');

  const ledger = JSON.parse(readFileSync(join(process.cwd(), 'site/claims.json'), 'utf8'));
  const claim = ledger.claims.find((/** @type {any} */ entry) => entry.text.includes('One command composes'));
  assert.ok(claim, 'the tour claim is gone from the ledger — either restore it or delete this test');

  for (const label of LABELS) {
    assert.ok(
      claim.text.includes(`${tour.counts[label]} ${label}`),
      `${claim.id} does not say "${tour.counts[label]} ${label}". The tour composed `
      + `${tour.counts[label]}; the ledger says something else, and the ledger is what the site prints.`,
    );
  }

  const limitations = tour.limitations.length;
  assert.ok(
    claim.text.includes(NUMERALS[limitations] ?? String(limitations)),
    `${claim.id} does not name the ${limitations} limitations the tour printed. `
    + 'The count of things the inspector cannot see is the honest half of this claim.',
  );
});

test('no document quotes a count the tour did not produce', () => {
  assert.ok(tour, 'the tour test must run first');

  for (const { path, order } of QUOTING_SURFACES) {
    const text = readFileSync(join(process.cwd(), path), 'utf8');
    for (const label of LABELS) {
      // "packages" is an npm word as well as a composition word, so it is checked in the ledger
      // (where the sentence is unambiguous) and not swept for here.
      if (label === 'packages') continue;
      const pattern = order === 'label-first'
        ? new RegExp(`\\b${label}\\s+(\\d+)`, 'g')
        : new RegExp(`(\\d+)\\s+${label}\\b`, 'g');
      let seen = 0;
      for (const match of text.matchAll(pattern)) {
        seen += 1;
        assert.equal(
          Number(match[1]),
          tour.counts[label],
          `${path} says "${match[0].trim()}" and the tour composed ${tour.counts[label]} ${label}. `
          + 'Re-run npm run tour and update the sentence, or say which other composition it describes.',
        );
      }
      assert.ok(
        seen > 0,
        `${path} quotes no count for "${label}". Either it stopped quoting the tour — in which `
        + 'case drop it from QUOTING_SURFACES — or the sweep is reading it with the wrong orientation '
        + 'and is now checking nothing.',
      );
    }
  }
});

test('the packaging document describes the starter it would actually find', () => {
  assert.ok(tour, 'the tour test must run first');

  const text = readFileSync(join(process.cwd(), 'docs/SKILL_PACKAGING.md'), 'utf8');
  const resolved = tour.limitations.length;

  // This document counts modules as "records", which is what a reader of a generated project sees.
  assert.ok(
    text.includes(`${tour.counts.modules} records`),
    `docs/SKILL_PACKAGING.md must say "${tour.counts.modules} records" — the tour composed that many modules`,
  );
  assert.ok(
    text.includes(`${tour.counts.actions} actions`),
    `docs/SKILL_PACKAGING.md must say "${tour.counts.actions} actions"`,
  );
  assert.ok(
    text.includes(`${NUMERALS[resolved] ?? resolved} standing limitations`),
    `docs/SKILL_PACKAGING.md must name the ${resolved} standing limitations the inspector reports`,
  );
});
