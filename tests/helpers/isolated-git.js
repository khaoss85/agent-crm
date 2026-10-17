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

/**
 * A fixture git bound to one directory: `gitIn(cwd)(args)` runs real git in
 * `cwd` with an isolated environment and returns `{ status, stdout }` with
 * stdout trimmed — the same shape as `scripts/measurement.js`' `gitIn`, so
 * callers move over unchanged.
 * @param {string} cwd
 * @param {Parameters<typeof spawnSync>[2]} [options]
 * @returns {(args: string[]) => { status: number, stdout: string }}
 */
export function gitIn(cwd, options = {}) {
  return (/** @type {string[]} */ args) => {
    const run = spawnGit(args, { cwd, ...options });
    return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
  };
}
