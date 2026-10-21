// @ts-check

/**
 * The slicing contract (backlog:664d5f481a96): the three oracle slices
 * partition the corpus — no cell runs twice, none is lost. The measure
 * combine pins the union of *files*, not of cells, so a slice that quietly
 * dropped cells (or two slices covering the same grouping) would still
 * join green while measuring less. This test builds every slice corpus
 * through the shared generator (milliseconds, no bash) and compares label
 * sets against the whole corpus, so it runs everywhere the slices run,
 * including the PR gate.
 *
 * The slices are read as text, never imported: importing a test file
 * registers its tests in this run. Fail-loud anchors (same discipline as
 * tests/agent-tool-selection-heredoc-guard.test.js): a slice that moves
 * its spec reddens here instead of passing vacuously.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ORACLE_GROUPINGS, shellCorpus } from './helpers/shell-oracle.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLICES = ['tests/shell-oracle-a.test.js', 'tests/shell-oracle-b.test.js', 'tests/shell-oracle-c.test.js'];

/**
 * Read a slice's declared spec from its text.
 *
 * @param {string} relative repository-relative slice path
 * @returns {{ groupings: string[], withHeredoc: boolean }}
 */
function sliceSpec(relative) {
  const source = readFileSync(join(REPO_ROOT, relative), 'utf8');
  const groupingsAnchor = 'const SLICE_GROUPINGS = [';
  const groupingsStart = source.indexOf(groupingsAnchor);
  assert.ok(groupingsStart !== -1, `${relative} no longer declares ${groupingsAnchor.trim()}: update this test, do not delete it`);
  const groupingsEnd = source.indexOf('];', groupingsStart);
  assert.ok(groupingsEnd !== -1, `could not find the end of SLICE_GROUPINGS in ${relative}: update this test`);
  const groupings = [];
  for (const match of source.slice(groupingsStart, groupingsEnd).matchAll(/'([^']+)'/g)) {
    groupings.push(match[1]);
  }
  assert.ok(groupings.length > 0, `parsed zero groupings out of ${relative}: the extractor is stale, fix it`);
  const heredocAnchor = 'const SLICE_WITH_HEREDOC = ';
  const heredocStart = source.indexOf(heredocAnchor);
  assert.ok(heredocStart !== -1, `${relative} no longer declares ${heredocAnchor.trim()}: update this test, do not delete it`);
  const heredocValue = source.slice(heredocStart + heredocAnchor.length, heredocStart + heredocAnchor.length + 5);
  assert.ok(
    heredocValue.startsWith('true') || heredocValue.startsWith('false'),
    `could not read SLICE_WITH_HEREDOC in ${relative}: update this test`,
  );
  return { groupings, withHeredoc: heredocValue.startsWith('true') };
}

test('the three oracle slices partition the corpus: no cell twice, none lost', () => {
  const full = new Map(shellCorpus().map((entry) => [entry.label, entry]));
  const seen = new Map();
  const groupingOwners = new Map();
  let heredocSlices = 0;
  for (const relative of SLICES) {
    const { groupings, withHeredoc } = sliceSpec(relative);
    if (withHeredoc) heredocSlices += 1;
    for (const grouping of groupings) {
      assert.ok(
        Object.hasOwn(ORACLE_GROUPINGS, grouping),
        `${relative} slices an unknown grouping ${JSON.stringify(grouping)}: a renamed value must fail here`,
      );
      assert.ok(!groupingOwners.has(grouping), `grouping ${grouping} runs in two slices (${groupingOwners.get(grouping)} and ${relative})`);
      groupingOwners.set(grouping, relative);
    }
    for (const entry of shellCorpus({ groupings, withHeredoc })) {
      assert.ok(full.has(entry.label), `${relative} generates a cell outside the full corpus: ${entry.label}`);
      assert.ok(!seen.has(entry.label), `${entry.label} runs in two slices (${seen.get(entry.label)} and ${relative})`);
      seen.set(entry.label, relative);
    }
  }
  assert.deepEqual(
    [...groupingOwners.keys()].sort(),
    Object.keys(ORACLE_GROUPINGS).sort(),
    'the slices do not cover every grouping: a grouping runs in no slice',
  );
  assert.equal(seen.size, full.size, `${full.size - seen.size} corpus cells run in no slice`);
  assert.equal(heredocSlices, 1, `exactly one slice must carry the heredoc cells, found ${heredocSlices}`);
});
