// @ts-check

/**
 * Controlled regeneration of `docs/repository-truth.json` on `main`
 * (backlog:6a3d0316 — the parallel-PR drift of S70).
 *
 *   node scripts/realign-truth-main.js           dry run: print the decision, change nothing
 *   node scripts/realign-truth-main.js --push    commit and push the realignment (CI only)
 *
 * The `public-claims` CI job runs this as its last step, after the agreement
 * gate, the measurement re-anchor, the regeneration and `--require-current`.
 * When the merge carried advisory-only drift — added facts, regenerated
 * evidence, a restated limitation, a `sourceSha` moved by an unrelated edit,
 * and nothing else — the regenerated document is committed back to `main`,
 * so `main` returns aligned with no manual commit. When a fact value moved or
 * a fact dropped, the step refuses red: that always needs a person, and the
 * agreement gate above already failed for the same reason.
 *
 * What makes this controlled rather than a bot that rewrites history:
 *
 * - the measurement facts (`measurement.*`) are CI-owned by design — the
 *   re-anchor rewrites them on every `main` run — so they are set aside
 *   before comparing. Only author-owned drift can trigger a commit;
 * - the tree must hold exactly the two files this job produces
 *   (`site/claims.json`, `docs/repository-truth.json`). Anything else dirty
 *   refuses, so no unrelated change can ride along;
 * - the pushed commit carries `[skip ci]`: this run just verified this exact
 *   tree with `--require-current`, and the commit changes no authority
 *   source, no test and no surface — a new full `main` run would only
 *   re-measure an unchanged `tests/` tree while holding the shared lock;
 * - `--push` runs only under `GITHUB_ACTIONS`. Anywhere else it exits 2, so
 *   a local dry run can never push to `main` by accident.
 *
 * Exit codes: 0 aligned or realigned (dry run included), 1 refused or the
 * push failed, 2 unusable input or wrong environment.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { TRUTH_DOCUMENT, classifyDocumentDrift } from './repo-truth.js';

export const REALIGN_LEDGER = 'site/claims.json';
export const REALIGN_FILES = Object.freeze([REALIGN_LEDGER, TRUTH_DOCUMENT]);
export const MEASUREMENT_FACT_PREFIX = 'measurement.';

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
 * Decide what `main` needs, purely over the two documents.
 *
 * - `none`: the author-owned facts agree; the merge carried no drift. Leave
 *   the re-anchored ledger and the regenerated document uncommitted, exactly
 *   as `public-claims` always did.
 * - `commit`: advisory-only drift (`facts-added` or `metadata-only`); the
 *   regenerated document is what the merge should have carried.
 * - `refuse`: a moved or dropped value; a person regenerates deliberately.
 *
 * @param {{committed: any, disk: any}} options
 */
export function realignDecision({ committed, disk }) {
  const drift = classifyDocumentDrift(
    { ...committed, facts: stripCiOwnedFacts(committed?.facts) },
    { ...disk, facts: stripCiOwnedFacts(disk?.facts) },
  );
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
  const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim(), stderr: String(run.stderr ?? '').trim() };
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
    process.stdout.write(`realign-truth-main: ${decision.reason} Dry run: pass --push in CI to commit it.\n`);
    return;
  }
  if (process.env.GITHUB_ACTIONS !== 'true') {
    process.stderr.write('realign-truth-main: --push runs only under GITHUB_ACTIONS, so a local run can never '
      + 'push to main by accident. Nothing was changed.\n');
    process.exit(2);
  }
  const subject = 'chore(truth): realign repository truth after merge [skip ci]';
  const body = `${decision.reason}\n\nCommitted by the public-claims run that verified this exact tree\nwith --require-current (backlog:6a3d0316).`;
  const commit = git(['-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=41898282+github-actions[bot]@users.noreply.github.com',
    'commit', '-q', '-m', subject, '-m', body, '--', ...REALIGN_FILES], root);
  if (commit.status !== 0) {
    process.stderr.write(`realign-truth-main: the realign commit failed: ${commit.stderr || commit.stdout}. `
      + 'Nothing was pushed.\n');
    process.exit(1);
  }
  const pushed = git(['push', 'origin', 'HEAD:main'], root);
  if (pushed.status !== 0) {
    process.stderr.write(`realign-truth-main: the push to main failed (another merge may have landed first; `
      + `its own run realigns): ${pushed.stderr || pushed.stdout}\n`);
    process.exit(1);
  }
  process.stdout.write(`realign-truth-main: ${decision.reason} Committed and pushed.\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`realign-truth-main: ${/** @type {any} */ (error)?.stack ?? error}\n`);
    process.exit(2);
  }
}
