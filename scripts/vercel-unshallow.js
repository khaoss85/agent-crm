// @ts-check

/**
 * Gives a Vercel build the git history the public-claims gate requires.
 *
 * Git-linked Vercel builds clone shallow, and `scripts/site-check.js` fails
 * closed on a shallow checkout — correctly: measuredAgainst.sha cannot be
 * proven an ancestor of HEAD without the connecting commits. The container's
 * configured remote has no credentials, so a plain `git fetch --unshallow`
 * fails; the repository is public, so a fetch addressed at the GitHub URL —
 * composed from the VERCEL_GIT_* variables every git build provides — needs
 * none. Exit is always 0 when the tree is already complete, and non-zero only
 * when the tree is shallow and no fetch could repair it, so the gate that runs
 * next reports the truthful failure instead of this script masking it.
 *
 * This exists as a file because vercel.json caps buildCommand at 256
 * characters; the command stays `node scripts/vercel-unshallow.js && npm run
 * site:check && …`, which keeps `site:check` literally present in
 * vercel.json — the indexing gate checks for exactly that.
 */

import { spawnSync } from 'node:child_process';

const git = (/** @type {string[]} */ args) => spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const probe = git(['rev-parse', '--is-shallow-repository']);
if (probe.status !== 0) {
  console.log('vercel-unshallow: not a git checkout; nothing to do.');
  process.exit(0);
}
if (probe.stdout.trim() !== 'true') {
  console.log('vercel-unshallow: history already complete.');
  process.exit(0);
}

const attempts = [['fetch', '--quiet', '--unshallow']];
const owner = process.env.VERCEL_GIT_REPO_OWNER;
const slug = process.env.VERCEL_GIT_REPO_SLUG;
if (owner && slug) {
  attempts.push(['fetch', '--quiet', '--unshallow', `https://github.com/${owner}/${slug}.git`]);
}

for (const args of attempts) {
  const run = git(args);
  if (run.status === 0) {
    console.log(`vercel-unshallow: history restored via \`git ${args.join(' ')}\`.`);
    process.exit(0);
  }
}

console.error('vercel-unshallow: the clone is shallow and no fetch could restore history; site:check will refuse provenance next, which is the correct failure.');
process.exit(1);
