// @ts-check

/**
 * Shell-oracle slice C (backlog:664d5f481a96): the command-shape cells whose
 * grouping is `functionBody` or `trap`, plus the heredoc/arithmetic cells —
 * about a third of the oracle corpus plus the delimiter cross-product the
 * other slices must not carry. Runs in its own measure piece under the same
 * 900 s lock maximum as every other piece. The corpus generator and the
 * agreement assertions are shared with the other slices in
 * tests/helpers/shell-oracle.js; this file only names its slice, so no cell
 * runs twice and none is lost.
 */

import test from 'node:test';
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

test('the shell classifier agrees with bash over the function-body/trap slice and the heredoc cells', () => {
  const corpus = shellCorpus({ groupings: SLICE_GROUPINGS, withHeredoc: true });
  const expectedCells = Object.keys(ORACLE_POSITIONS).length
    * SHELL_ORACLE_WRAPPERS.length
    * SHELL_ORACLE_REDIRECTS.length
    * Object.keys(ORACLE_BRANCHES).length
    * SLICE_GROUPINGS.length;
  const minHeredocCells = (SHELL_ORACLE_FULL ? HEREDOC_DELIMITER_SPELLINGS : SHELL_ORACLE_HEREDOC_SPELLINGS).length;
  assertShellOracleAgreement(corpus, { repoRoot: REPO_ROOT, expectedCells, minHeredocCells });
});
