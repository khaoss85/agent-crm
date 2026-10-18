// @ts-check

/**
 * Isolated git for tests (LEARNINGS S59).
 *
 * On 2026-10-16 `tests/apply-ci-measurement.test.js`, run by a git hook with
 * `GIT_DIR` set, ran its fixture `git init` / `git commit` against the real
 * repository instead of the scratch one: the fixture commits landed on the
 * branch being pushed and 1869 files were deleted. A bare `cwd` does not save
 * a fixture — `GIT_DIR` (and every other `GIT_*` variable) overrides both the
 * working directory and `-C`, so any git a test spawns inherits the enclosing
 * repository unless the environment is scrubbed first.
 *
 * Every test that spawns git must go through this helper, which launches git
 * with all `GIT_*` variables removed. A guard test (`tests/isolated-git.test.js`)
 * fails the suite if any other test file spawns git directly.
 *
 * The primitives live in `scripts/git-env.js` — one implementation shared
 * with the scripts the tests drive (which run under the same hooks), so a
 * fix here cannot drift from the scripts' behaviour. This module re-exports
 * them unchanged and adds only the fixture-bound `gitIn`.
 */

import { spawnGit } from '../../scripts/git-env.js';

export { execGit, isolatedGitEnv, spawnGit } from '../../scripts/git-env.js';

/**
 * A fixture git bound to one directory: `gitIn(cwd)(args)` runs real git in
 * `cwd` with an isolated environment and returns `{ status, stdout }` with
 * stdout trimmed — the same shape as `scripts/measurement.js`' `gitIn`, so
 * callers move over unchanged.
 * @param {string} cwd
 * @param {Parameters<typeof spawnGit>[1]} [options]
 * @returns {(args: string[]) => { status: number, stdout: string }}
 */
export function gitIn(cwd, options = {}) {
  return (/** @type {string[]} */ args) => {
    const run = spawnGit(args, { cwd, ...options });
    return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
  };
}
