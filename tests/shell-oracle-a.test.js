// @ts-check

/**
 * Shell-oracle slice A (backlog:664d5f481a96): the command-shape cells whose
 * grouping is `none` or `subshell`, about a third of the oracle corpus. Runs
 * in its own measure piece under the same 900 s lock maximum as every other
 * piece. The corpus generator and the agreement assertions are shared with
 * the other slices in tests/helpers/shell-oracle.js; this file only names
 * its slice, so no cell runs twice and none is lost.
 */

import test from 'node:test';
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
const SLICE_GROUPINGS = ['none', 'subshell'];

test('the shell classifier agrees with bash over the none/subshell slice', () => {
  const corpus = shellCorpus({ groupings: SLICE_GROUPINGS, withHeredoc: false });
  const expectedCells = Object.keys(ORACLE_POSITIONS).length
    * SHELL_ORACLE_WRAPPERS.length
    * SHELL_ORACLE_REDIRECTS.length
    * Object.keys(ORACLE_BRANCHES).length
    * SLICE_GROUPINGS.length;
  assertShellOracleAgreement(corpus, { repoRoot: REPO_ROOT, expectedCells, minHeredocCells: 0 });
});
