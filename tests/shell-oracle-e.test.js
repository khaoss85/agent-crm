// @ts-check

/**
 * Shell-oracle slice E (backlog:664d5f481a96): the command-shape cells whose
 * grouping is `functionBody`, about a sixth of the oracle corpus. Runs in
 * its own measure piece under the same 900 s lock maximum as every other
 * piece. The corpus generator and the agreement assertions are shared with
 * the other slices in tests/helpers/shell-oracle.js; this file only names
 * its slice, so no cell runs twice and none is lost
 * (tests/shell-oracle-slices.test.js pins the partition).
 *
 * Two speeds: the wiring test below always runs (imports, corpus shape,
 * counts — seconds, so the pre-push hook and the PR gate stay within
 * budget). The bash driver behind the agreement test runs in every
 * measurement (`npm run measure` forces `ACCORDO_ORACLE_DRIVER=1`, so a
 * record can never publish over skipped oracle tests); a direct
 * `node --test` run — the gate, the pre-push hook — runs only the wiring
 * above. A skipped driver shows as skipped, never as green.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ORACLE_BRANCHES,
  ORACLE_POSITIONS,
  SHELL_ORACLE_REDIRECTS,
  SHELL_ORACLE_WRAPPERS,
  assertShellOracleAgreement,
  shellCorpus,
} from './helpers/shell-oracle.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLICE_GROUPINGS = ['functionBody'];
const SLICE_WITH_HEREDOC = false;

function sliceExpectedCells() {
  return Object.keys(ORACLE_POSITIONS).length
    * SHELL_ORACLE_WRAPPERS.length
    * SHELL_ORACLE_REDIRECTS.length
    * Object.keys(ORACLE_BRANCHES).length
    * SLICE_GROUPINGS.length;
}

test('slice E is wired: its corpus builds with the expected cells and no heredoc', () => {
  const corpus = shellCorpus({ groupings: SLICE_GROUPINGS, withHeredoc: SLICE_WITH_HEREDOC });
  assert.ok(
    corpus.length >= sliceExpectedCells(),
    `slice E generated ${corpus.length} texts and the axes alone are ${sliceExpectedCells()}; an axis has been dropped`,
  );
  assert.equal(
    new Set(corpus.map((entry) => entry.label)).size,
    corpus.length,
    'a cell runs twice inside slice E',
  );
  const heredocCells = corpus.filter((entry) => entry.label.startsWith('heredoc-delim/')).length;
  assert.equal(heredocCells, 0, `slice E must carry no heredoc cells, found ${heredocCells}`);
});

const RUN_DRIVER = process.env.ACCORDO_ORACLE_DRIVER === '1';

test('the shell classifier agrees with bash over the function-body slice', {
  skip: RUN_DRIVER
    ? false
    : 'the oracle driver runs in every measurement (npm run measure forces it); the gate and the pre-push run the wiring above',
}, () => {
  assertShellOracleAgreement(
    shellCorpus({ groupings: SLICE_GROUPINGS, withHeredoc: SLICE_WITH_HEREDOC }),
    { repoRoot: REPO_ROOT, expectedCells: sliceExpectedCells(), minHeredocCells: 0 },
  );
});
