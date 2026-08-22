// @ts-check

/**
 * Gives a Vercel build the git history the public-claims gate requires.
 *
 * Git-linked Vercel builds clone shallow, and `scripts/site-check.js` fails
 * closed when that checkout cannot resolve and connect measuredAgainst.sha to
 * HEAD. A shallow marker alone is not the verdict; bounded history can contain
 * the complete connecting path. The container's
 * configured remote has no credentials, so a plain `git fetch --unshallow`
 * fails; the repository is public, so a fetch addressed at the GitHub URL —
 * composed from the VERCEL_GIT_* variables every git build provides — needs
 * none. The helper reads the current ledger and exits 0 only after git reports
 * enough history to resolve that measured commit and prove it is an ancestor of
 * HEAD. Shallow state is inspected, not treated as a proxy for missing proof: a
 * bounded deepen may leave the marker while making ancestry provable. A
 * zero-exit fetch with an unmet post-condition falls through to the
 * next bounded strategy instead of masking the failure the gate would report.
 *
 * This exists as a file because vercel.json caps buildCommand at 256
 * characters; the command stays `node scripts/vercel-unshallow.js && npm run
 * site:check && …`, which keeps `site:check` literally present in
 * vercel.json — the indexing gate checks for exactly that.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * @typedef {{status: number | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null}} GitResult
 */

/**
 * Restore and prove the history needed by the public measurement ledger.
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   runGit?: (args: string[]) => GitResult,
 *   repositoryUrl?: string,
 *   out?: (message: string) => void,
 *   error?: (message: string) => void,
 * }} [options]
 */
export function restoreProvenance(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const runGit = options.runGit ?? ((args) => spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }));
  const out = options.out ?? console.log;
  const error = options.error ?? console.error;

  let measuredSha;
  try {
    const ledger = JSON.parse(readFileSync(join(cwd, 'site', 'claims.json'), 'utf8'));
    measuredSha = ledger?.measuredAgainst?.sha;
  } catch (cause) {
    error(`vercel-unshallow: cannot read site/claims.json: ${errorMessage(cause)}`);
    return 1;
  }
  if (typeof measuredSha !== 'string' || !/^[0-9a-f]{7,40}$/.test(measuredSha)) {
    error('vercel-unshallow: site/claims.json has no valid measuredAgainst.sha.');
    return 1;
  }

  const initial = verifyProvenance(runGit, measuredSha);
  if (initial.ok) {
    out(`vercel-unshallow: provenance already available for ${measuredSha}.`);
    return 0;
  }
  if (initial.notGit) {
    error('vercel-unshallow: not a git checkout; measurement provenance cannot be proved.');
    return 1;
  }

  const attempts = [['fetch', '--quiet', '--unshallow']];
  const owner = env.VERCEL_GIT_REPO_OWNER;
  const slug = env.VERCEL_GIT_REPO_SLUG;
  const publicUrl = options.repositoryUrl ?? (owner && slug ? `https://github.com/${owner}/${slug}.git` : null);
  if (publicUrl) {
    attempts.push(
      ['fetch', '--quiet', '--unshallow', publicUrl],
      ['fetch', '--quiet', '--deepen=2147483647', publicUrl, 'main'],
    );
  }

  for (const args of attempts) {
    const run = runGit(args);
    const command = `git ${args.join(' ')}`;
    if (run.status !== 0) {
      error(`vercel-unshallow: \`${command}\` failed${gitDetail(run)}; trying the next strategy.`);
      continue;
    }
    const verified = verifyProvenance(runGit, measuredSha);
    if (verified.ok) {
      out(`vercel-unshallow: provenance for ${measuredSha} verified after \`${command}\`.`);
      return 0;
    }
    error(`vercel-unshallow: \`${command}\` exited 0 but provenance is still unproved (${verified.reason}); trying the next strategy.`);
  }

  const final = verifyProvenance(runGit, measuredSha);
  error(`vercel-unshallow: unable to prove ${measuredSha} is available and an ancestor of HEAD (${final.reason}).`);
  return 1;
}

/** @param {(args: string[]) => GitResult} runGit @param {string} measuredSha */
function verifyProvenance(runGit, measuredSha) {
  const shallow = runGit(['rev-parse', '--is-shallow-repository']);
  if (shallow.status !== 0) return { ok: false, notGit: true, reason: 'git state unavailable' };
  const shallowState = String(shallow.stdout ?? '').trim();
  if (shallowState !== 'true' && shallowState !== 'false') {
    return { ok: false, notGit: false, reason: 'git returned an invalid shallow-state probe' };
  }
  const object = runGit(['cat-file', '-e', `${measuredSha}^{commit}`]);
  if (object.status !== 0) return { ok: false, notGit: false, reason: `commit ${measuredSha} is unavailable` };
  const ancestor = runGit(['merge-base', '--is-ancestor', measuredSha, 'HEAD']);
  if (ancestor.status !== 0) return { ok: false, notGit: false, reason: `${measuredSha} is not an ancestor of HEAD` };
  return { ok: true, notGit: false, reason: shallowState === 'true' ? 'verified in bounded shallow history' : 'verified' };
}

/** @param {GitResult} run */
function gitDetail(run) {
  const detail = String(run.stderr ?? '').trim().split('\n').at(-1);
  return detail ? `: ${detail}` : '';
}

/** @param {unknown} cause */
function errorMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = restoreProvenance();
}
