// @ts-check

/**
 * `npm run tour` composes the starter application and prints what it contains. Those counts are
 * quoted on the landing page, in the launch packet, in the go-to-market plan and in the skill
 * packaging document — five places, one measurement.
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

/** Documents that quote the tour's counts in the tour's own words. */
const QUOTING_DOCUMENTS = [
  'docs/marketing/LAUNCH_PACKET.md',
  'docs/strategy/GO_TO_MARKET.md',
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

  for (const path of QUOTING_DOCUMENTS) {
    const text = readFileSync(join(process.cwd(), path), 'utf8');
    for (const label of LABELS) {
      // "packages" is an npm word as well as a composition word, so it is checked in the ledger
      // (where the sentence is unambiguous) and not swept for here.
      if (label === 'packages') continue;
      for (const match of text.matchAll(new RegExp(`(\\d+)\\s+${label}\\b`, 'g'))) {
        assert.equal(
          Number(match[1]),
          tour.counts[label],
          `${path} says "${match[0]}" and the tour composed ${tour.counts[label]} ${label}. `
          + 'Re-run npm run tour and update the sentence, or say which other composition it describes.',
        );
      }
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
