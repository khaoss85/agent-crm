// @ts-check

/**
 * Isolated git for scripts (LEARNINGS S59, backlog:848b76c6).
 *
 * On 2026-10-16 a test run by a git hook with `GIT_DIR` set ran its fixture
 * `git init` / `git commit` against the real repository instead of the
 * scratch one. The tests were fixed first (`tests/helpers/isolated-git.js`),
 * but the scripts the tests drive — and the pre-push hook runs — spawned git
 * with the inherited environment, so the same pollution diverted them: a bare
 * `cwd` (and even `git -C`) does not save a call, because `GIT_DIR` (and
 * every other `GIT_*` variable) overrides both.
 *
 * Every script that spawns git must go through this module, which launches
 * git with all `GIT_*` variables removed. A guard test
 * (`tests/isolated-git.test.js`) fails the suite if any other script — or any
 * test outside `tests/helpers/isolated-git.js` — spawns git directly.
 */

import { execFileSync, spawnSync } from 'node:child_process';

/**
 * This process's environment with every `GIT_*` variable removed, plus `extra`
 * (whose own `GIT_*` keys are likewise dropped: reaching for this helper
 * while smuggling a `GIT_*` back in is the bug it exists to prevent).
 * @param {Record<string, string | undefined>} [extra]
 * @returns {NodeJS.ProcessEnv}
 */
export function isolatedGitEnv(extra = {}) {
  /** @type {NodeJS.ProcessEnv} */
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  for (const [key, value] of Object.entries(extra)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return env;
}

/**
 * `spawnSync('git', args, ...)` with an isolated environment.
 * @param {string[]} args
 * @param {Parameters<typeof spawnSync>[2]} [options]
 */
export function spawnGit(args, options = {}) {
  const { env: extraEnv, ...rest } = options ?? {};
  return spawnSync('git', args, {
    encoding: 'utf8',
    ...rest,
    env: isolatedGitEnv(
      extraEnv == null || typeof extraEnv === 'string'
        ? {}
        : /** @type {Record<string, string | undefined>} */ (extraEnv),
    ),
  });
}

/**
 * `execFileSync('git', args, ...)` with an isolated environment.
 * @param {string[]} args
 * @param {Parameters<typeof execFileSync>[2]} [options]
 */
export function execGit(args, options = {}) {
  const { env: extraEnv, ...rest } = options ?? {};
  return execFileSync('git', args, {
    encoding: 'utf8',
    ...rest,
    env: isolatedGitEnv(
      extraEnv == null || typeof extraEnv === 'string'
        ? {}
        : /** @type {Record<string, string | undefined>} */ (extraEnv),
    ),
  });
}
