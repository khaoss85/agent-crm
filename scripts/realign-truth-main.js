// @ts-check

/**
 * Controlled regeneration of `docs/repository-truth.json` on `main`
 * (backlog:6a3d0316 — the parallel-PR drift of S70).
 *
 *   node scripts/realign-truth-main.js           dry run: print the decision, change nothing
 *   node scripts/realign-truth-main.js --push    open or update the realign PR (CI only)
 *
 * The scheduled `verify` flow runs this as its last step, after the agreement
 * gate, the measurement re-anchor, the regeneration and `--require-current`.
 * When the merge carried advisory-only drift — added facts, regenerated
 * evidence, a restated limitation, a `sourceSha` moved by an unrelated edit,
 * and nothing else — the regenerated files go onto ONE fixed branch behind
 * ONE pull request titled `chore(truth): realign main`, which follows the
 * normal gate like any other PR, so `main` returns aligned with no manual
 * commit. When a fact value moved or a fact dropped, the step refuses red:
 * that always needs a person, and the agreement gate above already failed
 * for the same reason.
 *
 * What makes this controlled rather than a bot that rewrites history:
 *
 * - CI never writes to `main` directly: no `git push origin HEAD:main`
 *   anywhere here. A branch push plus a PR keeps every change under the
 *   merge gate (reviews, checks, one-rotation rule) instead of beside it;
 * - the measurement facts (`measurement.*`) are CI-owned by design — the
 *   re-anchor rewrites them on every `main` run — so they are set aside
 *   before comparing, alongside the derived `fingerprint` they move. Only
 *   author-owned drift can open the PR;
 * - the tree must hold exactly the two files this job produces
 *   (`site/claims.json`, `docs/repository-truth.json`). Anything else dirty
 *   refuses. The ledger rides along only inside the PR diff, where the gate
 *   and a reader see all of it — never in an unreviewed push;
 * - two runs racing each other fold, never force: a losing push merges the
 *   branch with `-s ours` (the fresh regeneration wins) and retries once;
 *   a second loss warns and exits 0 — the other run owns the branch, and
 *   the next `main` run retries. Any other push failure (auth, hook
 *   decline) stays red. No `--force`, ever;
 * - `--push` runs only under `GITHUB_ACTIONS`. Anywhere else it exits 2, so
 *   a local dry run can never push by accident.
 *
 * Exit codes: 0 aligned, realigned, or out-raced with a warning (dry run
 * included), 1 refused or a step that must not go quiet failed, 2 unusable
 * input or wrong environment.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { spawnGit } from './git-env.js';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TRUTH_DOCUMENT, classifyDocumentDrift } from './repo-truth.js';

export const REALIGN_LEDGER = 'site/claims.json';
export const REALIGN_FILES = Object.freeze([REALIGN_LEDGER, TRUTH_DOCUMENT]);
export const MEASUREMENT_FACT_PREFIX = 'measurement.';
/** The one fixed branch the realign PR lives on — opened or updated, never recreated. */
export const REALIGN_BRANCH = 'chore/truth-realign-main';
/** The one title the realign PR carries, so runs and readers find it. */
export const REALIGN_PR_TITLE = 'chore(truth): realign main';

/**
 * The comparison this step decides on: the committed and regenerated
 * documents with the CI-owned measurement facts set aside. The re-anchor
 * rewrites those on every `main` run, so they can never be evidence that the
 * merge drifted.
 *
 * @param {Array<any>} facts
 */
export function stripCiOwnedFacts(facts) {
  return (facts ?? []).filter((fact) => !String(fact?.id ?? '').startsWith(MEASUREMENT_FACT_PREFIX));
}

/**
 * The comparison this step decides on, with everything CI-derived set aside:
 * the measurement facts (rewritten by the re-anchor on every `main` run)
 * and the `fingerprint`, which is `sha256` over the canonical body including
 * every fact — stripping the facts without nulling it misclassifies every
 * re-anchor as committable metadata drift. `sourceSha` stays: the ledger is
 * not an authority source, so the re-anchor never moves it, and a moved
 * `sourceSha` is genuine advisory drift the PR carries visibly.
 *
 * @param {any} document
 */
export function forRealignComparison(document) {
  return { ...document, facts: stripCiOwnedFacts(document?.facts), fingerprint: null };
}

/**
 * Decide what `main` needs, purely over the two documents.
 *
 * - `none`: the author-owned facts agree; the merge carried no drift. Leave
 *   the re-anchored ledger and the regenerated document uncommitted, exactly
 *   as the `main` flow always did.
 * - `commit`: advisory-only drift (`facts-added` or `metadata-only`); the
 *   regenerated files belong on the realign PR, which follows the normal gate.
 * - `refuse`: a moved or dropped value; a person regenerates deliberately.
 *
 * @param {{committed: any, disk: any}} options
 */
export function realignDecision({ committed, disk }) {
  const drift = classifyDocumentDrift(forRealignComparison(committed), forRealignComparison(disk));
  if (drift.inSync) {
    return { action: 'none', drift, reason: 'the author-owned facts agree; nothing to realign' };
  }
  if (drift.blocking) {
    const moved = drift.moved.length ? `moved: ${drift.moved.join(', ')}` : null;
    const dropped = drift.dropped.length ? `dropped: ${drift.dropped.join(', ')}` : null;
    return {
      action: 'refuse',
      drift,
      reason: `a fact value ${[moved, dropped].filter(Boolean).join('; ')} outside the CI-owned measurement facts. `
        + 'Regenerate deliberately and commit it in a PR, not here.',
    };
  }
  return {
    action: 'commit',
    drift,
    reason: `advisory-only drift (${drift.kind}`
      + `${drift.added.length ? `, added: ${drift.added.join(', ')}` : ''}): `
      + 'the regenerated document is what the merge should have carried.',
  };
}

const git = (args, cwd) => {
  const run = spawnGit(args, { cwd });
  return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim(), stderr: String(run.stderr ?? '').trim() };
};

const gh = (args, cwd) => {
  const run = spawnSync('gh', args, { cwd, encoding: 'utf8' });
  return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim(), stderr: String(run.stderr ?? '').trim() };
};

const BOT_NAME = 'github-actions[bot]';
const BOT_EMAIL = '41898282+github-actions[bot]@users.noreply.github.com';

/** A GitHub workflow annotation is a single line: escape the reserved characters. */
const warnAnnotation = (message) => {
  const singleLine = String(message).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  process.stdout.write(`::warning::${singleLine}\n`);
};

function main() {
  const args = process.argv.slice(2);
  const wantsPush = args.includes('--push');
  for (const flag of args) {
    if (flag !== '--push') {
      process.stderr.write(`realign-truth-main: unknown flag ${flag}. Usage: node scripts/realign-truth-main.js [--push]\n`);
      process.exit(2);
    }
  }
  const root = process.cwd();

  const head = git(['rev-parse', 'HEAD'], root);
  if (head.status !== 0 || !head.stdout) {
    process.stderr.write('realign-truth-main: this is not a git checkout. Nothing was changed.\n');
    process.exit(2);
  }
  const dirty = git(['status', '--porcelain'], root);
  if (dirty.status !== 0) {
    process.stderr.write('realign-truth-main: git status failed. Nothing was changed.\n');
    process.exit(2);
  }
  // Porcelain v1 is two status columns, a space, then the path: drop the
  // columns first and trim after, so a leading status space never eats into
  // the path itself.
  const changed = dirty.stdout.split('\n').filter((line) => line.trim())
    .map((line) => line.slice(2).trim());
  const unexpected = changed.filter((path) => !REALIGN_FILES.includes(path));
  if (unexpected.length) {
    process.stderr.write(`realign-truth-main: refusing: the tree holds changes outside ${REALIGN_FILES.join(' and ')}: `
      + `${unexpected.join(', ')}. Nothing was changed.\n`);
    process.exit(1);
  }

  let committed;
  try {
    const shown = git(['show', `HEAD:${TRUTH_DOCUMENT}`], root);
    if (shown.status !== 0) throw new Error(`HEAD:${TRUTH_DOCUMENT} is not readable`);
    committed = JSON.parse(shown.stdout);
  } catch (error) {
    process.stderr.write(`realign-truth-main: refusing: the committed document cannot be read: `
      + `${/** @type {any} */ (error)?.message ?? error}. Nothing was changed.\n`);
    process.exit(1);
  }
  let disk;
  try {
    disk = JSON.parse(readFileSync(join(root, TRUTH_DOCUMENT), 'utf8'));
  } catch (error) {
    process.stderr.write(`realign-truth-main: refusing: the regenerated document cannot be read: `
      + `${/** @type {any} */ (error)?.message ?? error}. Nothing was changed.\n`);
    process.exit(1);
  }

  const decision = realignDecision({ committed, disk });
  if (decision.action === 'none') {
    process.stdout.write(`realign-truth-main: ${decision.reason}. Nothing was changed.\n`);
    return;
  }
  if (decision.action === 'refuse') {
    process.stderr.write(`realign-truth-main: refusing: ${decision.reason} Nothing was changed.\n`);
    process.exit(1);
  }

  if (!wantsPush) {
    process.stdout.write(`realign-truth-main: ${decision.reason} Dry run: pass --push in CI to move branch `
      + `${REALIGN_BRANCH} to this tree and open (or update) "${REALIGN_PR_TITLE}".\n`);
    return;
  }
  if (process.env.GITHUB_ACTIONS !== 'true') {
    process.stderr.write('realign-truth-main: --push runs only under GITHUB_ACTIONS, so a local run can never '
      + 'push by accident. Nothing was changed.\n');
    process.exit(2);
  }
  // `gh` must exist before anything is mutated: a pushed branch without its
  // PR is half the change, and the failure below would land on `main`'s run.
  if (gh(['--version'], root).status !== 0) {
    process.stderr.write('realign-truth-main: refusing: `gh` is not available, so the realign PR cannot be '
      + 'opened or found. Install it on the runner. Nothing was changed.\n');
    process.exit(1);
  }
  const checkout = git(['checkout', '-B', REALIGN_BRANCH], root);
  if (checkout.status !== 0) {
    process.stderr.write(`realign-truth-main: the branch ${REALIGN_BRANCH} could not be moved here: `
      + `${checkout.stderr || checkout.stdout}. Nothing was changed.\n`);
    process.exit(1);
  }
  const subject = 'chore(truth): realign repository truth after merge';
  const body = `${decision.reason}\n\nCommitted by the scheduled verify run that verified this exact tree\nwith --require-current (backlog:6a3d0316). Merges through the normal gate.`;
  const commit = git(['-c', `user.name=${BOT_NAME}`,
    '-c', `user.email=${BOT_EMAIL}`,
    'commit', '-q', '-m', subject, '-m', body, '--', ...REALIGN_FILES], root);
  if (commit.status !== 0) {
    process.stderr.write(`realign-truth-main: the realign commit failed: ${commit.stderr || commit.stdout}. `
      + 'Nothing was pushed.\n');
    process.exit(1);
  }
  // Two runs racing each other fold, never force: the loser merges the
  // branch with `-s ours` — this fresh regeneration wins over the older one —
  // and retries once. No `--force`, ever. Only a lost race warns: any other
  // push failure (auth, hook decline) stays red, or a broken runner would
  // look like a busy one.
  const remoteBranch = `origin/${REALIGN_BRANCH}`;
  const lostRace = (result) => /non-fast-forward|tip of your current branch is behind/.test(
    `${result.stderr || ''}\n${result.stdout || ''}`);
  let pushed = git(['push', 'origin', REALIGN_BRANCH], root);
  if (pushed.status !== 0 && lostRace(pushed)) {
    git(['fetch', '--no-tags', 'origin', REALIGN_BRANCH], root);
    if (git(['rev-parse', '--verify', remoteBranch], root).status === 0) {
      const folded = git(['-c', `user.name=${BOT_NAME}`,
        '-c', `user.email=${BOT_EMAIL}`,
        'merge', '-s', 'ours', '-m', `chore(truth): fold concurrent realign into ${REALIGN_BRANCH}`,
        remoteBranch], root);
      if (folded.status === 0) pushed = git(['push', 'origin', REALIGN_BRANCH], root);
    }
  }
  if (pushed.status !== 0) {
    const pushDetail = ((pushed.stderr || pushed.stdout).split('\n')[0]) || 'no detail';
    if (lostRace(pushed)) {
      // Another run owns the branch right now; the next `main` run retries.
      // Red here would be terminal noise, not a defect in this tree.
      const message = `realign-truth-main: the branch ${REALIGN_BRANCH} could not be pushed `
        + `(${pushDetail}); another run owns it and the next main run retries.`;
      if (process.env.GITHUB_ACTIONS === 'true') warnAnnotation(message);
      process.stdout.write(`${message}\n`);
      return;
    }
    process.stderr.write(`realign-truth-main: the branch ${REALIGN_BRANCH} could not be pushed `
      + `(${pushDetail}). Nothing further was changed.\n`);
    process.exit(1);
  }
  const listed = gh(['pr', 'list', '--head', REALIGN_BRANCH, '--state', 'open', '--json', 'number'], root);
  let open = -1;
  try {
    open = JSON.parse(listed.stdout || '[]').length;
  } catch {
    open = -1;
  }
  if (listed.status !== 0 || open < 0) {
    process.stderr.write(`realign-truth-main: the branch is pushed, but open PRs cannot be listed: `
      + `${listed.stderr || listed.stdout}. Open "${REALIGN_PR_TITLE}" by hand.\n`);
    process.exit(1);
  }
  if (open === 0) {
    const prBody = `${decision.reason}\n\nOpened by the scheduled verify run that verified this exact tree `
      + 'with --require-current. This PR follows the normal merge gate; merging it realigns main '
      + '(backlog:6a3d0316).';
    const created = gh(['pr', 'create', '--base', 'main', '--head', REALIGN_BRANCH,
      '--title', REALIGN_PR_TITLE, '--body', prBody], root);
    if (created.status !== 0) {
      process.stderr.write(`realign-truth-main: the branch is pushed, but the PR cannot be opened: `
        + `${created.stderr || created.stdout}. Open "${REALIGN_PR_TITLE}" by hand.\n`);
      process.exit(1);
    }
    process.stdout.write(`realign-truth-main: ${decision.reason} Branch pushed and PR opened.\n`);
  } else {
    process.stdout.write(`realign-truth-main: ${decision.reason} Branch pushed; the open realign PR picks it up.\n`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`realign-truth-main: ${/** @type {any} */ (error)?.stack ?? error}\n`);
    process.exit(2);
  }
}
