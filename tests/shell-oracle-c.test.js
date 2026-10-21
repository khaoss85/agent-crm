// @ts-check

/**
 * Shell-oracle slice C (backlog:664d5f481a96): the command-shape cells whose
 * grouping is `functionBody` or `trap`, plus the heredoc/arithmetic cells —
 * about a third of the oracle corpus plus the delimiter cross-product the
 * other slices must not carry. Runs in its own measure piece under the same
 * 900 s lock maximum as every other piece. The corpus generator and the
 * agreement assertions are shared with the other slices in
 * tests/helpers/shell-oracle.js; this file only names its slice, so no cell
 * runs twice and none is lost (tests/shell-oracle-slices.test.js pins the
 * partition).
 *
 * Two speeds: the wiring test below always runs (imports, corpus shape,
 * counts — seconds, so the pre-push hook and the PR gate stay within
 * budget). The bash driver behind the agreement test runs only with
 * `ACCORDO_ORACLE_DRIVER=1` (a few minutes for the three slices together)
 * and, with `ACCORDO_FULL_SHELL_ORACLE=1` beside it, the complete product
 * on the scheduled main measurement. A skipped driver shows as skipped,
 * never as green.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HEREDOC_DELIMITER_SPELLINGS,
  ORACLE_BRANCHES,
  ORACLE_POSITIONS,
  SHELL_ORACLE_FULL,
  SHELL_ORACLE_HEREDOC_SPELLINGS,
  SHELL_ORACLE_REDIRECTS,
  SHELL_ORACLE_WRAPPERS,
  assertShellOracleAgreement,
  shellCorpus,
} from './helpers/shell-oracle.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SLICE_GROUPINGS = ['functionBody', 'trap'];
const SLICE_WITH_HEREDOC = true;

function sliceExpectedCells() {
  return Object.keys(ORACLE_POSITIONS).length
    * SHELL_ORACLE_WRAPPERS.length
    * SHELL_ORACLE_REDIRECTS.length
    * Object.keys(ORACLE_BRANCHES).length
    * SLICE_GROUPINGS.length;
}

function sliceMinHeredocCells() {
  return (SHELL_ORACLE_FULL ? HEREDOC_DELIMITER_SPELLINGS : SHELL_ORACLE_HEREDOC_SPELLINGS).length;
}

test('slice C is wired: its corpus builds with the expected cells and the heredoc minimum', () => {
  const corpus = shellCorpus({ groupings: SLICE_GROUPINGS, withHeredoc: SLICE_WITH_HEREDOC });
  assert.ok(
    corpus.length >= sliceExpectedCells(),
    `slice C generated ${corpus.length} texts and the axes alone are ${sliceExpectedCells()}; an axis has been dropped`,
  );
  assert.equal(
    new Set(corpus.map((entry) => entry.label)).size,
    corpus.length,
    'a cell runs twice inside slice C',
  );
  const heredocCells = corpus.filter((entry) => entry.label.startsWith('heredoc-delim/')).length;
  assert.ok(
    heredocCells >= sliceMinHeredocCells(),
    `slice C carries ${heredocCells} heredoc cells against a ${sliceMinHeredocCells()}-entry delimiter list; the heredoc wiring has been dropped`,
  );
});

const RUN_DRIVER = process.env.ACCORDO_ORACLE_DRIVER === '1';

test('the shell classifier agrees with bash over the function-body/trap slice and the heredoc cells', {
  skip: RUN_DRIVER
    ? false
    : 'the oracle driver runs on the scheduled main measurement and with ACCORDO_ORACLE_DRIVER=1 (a few minutes); the gate and the pre-push run the wiring above',
}, () => {
  assertShellOracleAgreement(
    shellCorpus({ groupings: SLICE_GROUPINGS, withHeredoc: SLICE_WITH_HEREDOC }),
    { repoRoot: REPO_ROOT, expectedCells: sliceExpectedCells(), minHeredocCells: sliceMinHeredocCells() },
  );
});
