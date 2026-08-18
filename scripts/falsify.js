// @ts-check

/**
 * Try to break the rules this project makes in public, and report whether the suite noticed.
 *
 *   node scripts/falsify.js            the fast set — under a minute
 *   node scripts/falsify.js --all      including the mutations whose only witness is a slow e2e
 *   node scripts/falsify.js --only <id>
 *   node scripts/falsify.js --json
 *
 * A test count says how much was written. This says what would have to go wrong for a test to
 * stay green — which is the only version of the question a sceptical reader is actually asking.
 * Each mutation below removes exactly one rule the ledger claims, and the run reports which
 * named test caught it. A mutation that survives is a hole, and it is printed as one.
 *
 * **Three outcomes, and two of them are failures.**
 *
 * - `caught` — the target suite went red, and the report names the test that did it.
 * - `survived` — the suite stayed green with the rule removed. That is a gap in the tests,
 *   not a success, and the run exits non-zero.
 * - `stale` — the code the mutation aims at is no longer there, so it proved nothing. Also a
 *   failure: a falsification kit that silently stops aiming at anything is worse than none,
 *   because it keeps printing reassurance.
 *
 * **How it edits, and why that is safe.** Mutations are applied in place and restored in a
 * `finally`, with the restoration verified byte-for-byte. Before anything is written, every target
 * file must be clean in git — so even a killed process leaves damage that `git checkout` undoes
 * completely. A scratch copy of the tree would avoid the edit entirely and cost a full copy per
 * run; the git precondition buys the same assurance for the price of one `git status`.
 *
 * **Baselines are measured, not assumed.** Every target suite is run unmutated first. A suite that
 * is already red would make every mutation look caught, which is the one way this tool could lie
 * in the flattering direction.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

/**
 * Each entry removes one rule. `find` must appear exactly `occurrences` times: if the code
 * moved, the mutation is stale and says so rather than quietly matching nothing.
 *
 * @type {{id: string, file: string, find: string, replace: string, occurrences?: number,
 *         rule: string, breaks: string, claims: string[], test: string, slow?: boolean}[]}
 */
export const MUTATIONS = [
  {
    id: 'approval-actor-guard',
    file: 'packages/workflows/src/decide-opportunity-approval.js',
    find: "actor.type !== 'user'",
    replace: 'false',
    rule: 'a commercial approval decision requires a human actor',
    breaks: 'an agent can record the human decision as if it were the human',
    claims: ['C-03'],
    test: 'tests/workflow.test.js',
  },
  {
    id: 'approval-threshold-boundary',
    file: 'packages/workflows/src/request-opportunity-stage-change.js',
    find: 'state.opportunity.valueCents >= thresholdCents',
    replace: 'state.opportunity.valueCents > thresholdCents',
    rule: 'a renewal exactly at the approval threshold requires approval',
    breaks: 'a deal worth precisely the threshold slips through unapproved',
    claims: ['C-03'],
    test: 'tests/workflow.test.js',
  },
  {
    id: 'webhook-signature-verification',
    file: 'packages/signature/src/registry.js',
    find: 'if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {',
    replace: 'if (false) {',
    rule: 'a signature webhook is rejected unless its HMAC verifies',
    breaks: 'anyone who can reach the endpoint can forge a signed-contract event',
    claims: ['C-09'],
    test: 'tests/signature-contract.test.js',
  },
  {
    id: 'definition-version-immutability',
    file: 'packages/intelligence/src/registry.js',
    find: 'if (String(existing.fingerprint) !== entry.fingerprint) {',
    replace: 'if (false) {',
    rule: 'a registered policy version cannot be edited in place',
    breaks: 'a scoring model or discount policy changes behaviour while keeping its version, so '
      + 'every historical decision that cites that version now cites something else',
    claims: ['C-08'],
    test: 'tests/intelligence-contract.test.js',
  },
  {
    id: 'managed-fields-public-write',
    file: 'packages/cli/src/module-factory.js',
    find: "manifest.fields.every((field) => field.writable === 'managed')",
    replace: 'false',
    occurrences: 3,
    rule: 'a module whose every field is managed generates no public create or update',
    breaks: 'generic CRUD can write fields only a trusted action is allowed to set',
    claims: ['C-18'],
    test: 'tests/module-factory.test.js',
  },
  {
    id: 'delivery-cost-rounding',
    file: 'packages/delivery/src/economics.js',
    find: 'const cost = Math.floor((product * 2 + 60) / 120);',
    replace: 'const cost = Math.floor(product / 60);',
    rule: 'delivery cost rounds half-up in integers, per the published rule',
    breaks: 'every cost silently rounds down, so a snapshot taken twice can disagree with the rule '
      + 'the API publishes next to it',
    claims: ['C-08'],
    test: 'tests/delivery-economics-e2e.test.js',
    slow: true,
  },
];

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const argv = process.argv.slice(2);
  const wantsJson = argv.includes('--json');
  const wantsAll = argv.includes('--all');
  const onlyIndex = argv.indexOf('--only');
  const only = onlyIndex === -1 ? null : argv[onlyIndex + 1];

  const selected = MUTATIONS.filter((mutation) => {
    if (only) return mutation.id === only;
    return wantsAll || !mutation.slow;
  });
  const skipped = MUTATIONS.filter((mutation) => !selected.includes(mutation));

  if (selected.length === 0) {
    process.stderr.write(`falsify: no mutation matches "${only}". Known ids: ${MUTATIONS.map((m) => m.id).join(', ')}\n`);
    process.exit(2);
  }

  /** Narration on stderr so --json keeps stdout clean. */
  const say = (/** @type {string} */ line = '') => { if (!wantsJson) process.stderr.write(`${line}\n`); };

  let report;
  try {
    report = runFalsification(selected, { say });
  } catch (error) {
    process.stderr.write(`falsify: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }

  // No silent caps: what was not run is printed, not omitted — with the reason it was actually
  // skipped, because "slow" printed over a `--only` run would be a lie about the fast ones.
  report.skipped = skipped.map((mutation) => ({
    id: mutation.id,
    reason: only ? `not selected by --only ${only}` : 'slow — run with --all',
    test: mutation.test,
  }));

  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    say();
    for (const result of report.results) {
      const mark = result.outcome === 'caught' ? '✓' : '✗';
      say(`  ${mark} ${result.id}`);
      say(`      removes: ${result.rule}`);
      if (result.outcome === 'caught') {
        say(`      caught by: ${result.caughtBy ?? result.test}`);
      } else if (result.outcome === 'survived') {
        say(`      SURVIVED — ${result.test} stayed green. Without this, ${result.breaks}.`);
      } else {
        say(`      STALE — "${result.find}" appears ${result.found} time(s) in ${result.file}, expected ${result.expected}.`);
        say('      The code moved. This mutation proved nothing and must be re-aimed.');
      }
      say();
    }
    for (const entry of report.skipped) {
      say(`  · ${entry.id} not run (${entry.reason})`);
    }
    if (report.skipped.length) say();
    say(`  ${report.caught} caught, ${report.survived} survived, ${report.stale} stale, in ${(report.elapsedMs / 1000).toFixed(1)}s.`);
    say(report.ok
      ? '  Every rule tested here fails loudly when removed.'
      : '  At least one rule is not actually held by a test. That is the finding.');
    say();
  }

  process.exit(report.ok ? 0 : 1);
}

/**
 * @param {typeof MUTATIONS} mutations
 * @param {{say: (line?: string) => void}} io
 */
export function runFalsification(mutations, { say }) {
  const startedAt = Date.now();

  // Damage from a killed process must be undoable with one git command, so nothing is written
  // until every target file is clean.
  const files = [...new Set(mutations.map((mutation) => mutation.file))];
  const dirty = spawnSync('git', ['-C', root, 'status', '--porcelain', '--', ...files], { encoding: 'utf8' });
  if (dirty.status !== 0) {
    throw new Error(`git status failed: ${(dirty.stderr ?? '').trim() || 'no output'}`);
  }
  if (dirty.stdout.trim().length > 0) {
    throw new Error(
      'these target files have uncommitted changes, so a failed restore could not be undone with '
      + `git checkout:\n${dirty.stdout.trimEnd()}\nCommit or stash them first.`,
    );
  }

  // A suite that is already red would make every mutation look caught.
  const suites = [...new Set(mutations.map((mutation) => mutation.test))];
  for (const suite of suites) {
    say(`  baseline ${suite} …`);
    const baseline = runSuite(suite);
    if (baseline.status !== 0) {
      throw new Error(`${suite} is already failing, so no mutation aimed at it can be judged. Fix it first.`);
    }
  }

  const results = [];
  for (const mutation of mutations) {
    say(`  mutating ${mutation.id} …`);
    results.push(applyAndRun(mutation));
  }

  const caught = results.filter((result) => result.outcome === 'caught').length;
  const survived = results.filter((result) => result.outcome === 'survived').length;
  const stale = results.filter((result) => result.outcome === 'stale').length;

  return {
    falsifyContract: 1,
    ok: survived === 0 && stale === 0,
    caught,
    survived,
    stale,
    elapsedMs: Date.now() - startedAt,
    results,
    /** @type {{id: string, reason: string, test: string}[]} */
    skipped: [],
  };
}

/**
 * @param {typeof MUTATIONS[number]} mutation
 */
function applyAndRun(mutation) {
  const path = join(root, mutation.file);
  const original = readFileSync(path, 'utf8');
  const expected = mutation.occurrences ?? 1;
  const found = original.split(mutation.find).length - 1;

  const base = {
    id: mutation.id,
    file: mutation.file,
    find: mutation.find,
    test: mutation.test,
    rule: mutation.rule,
    breaks: mutation.breaks,
    claims: mutation.claims,
    found,
    expected,
  };

  if (found !== expected) return { ...base, outcome: 'stale', caughtBy: null };

  let run;
  try {
    writeFileSync(path, original.split(mutation.find).join(mutation.replace));
    run = runSuite(mutation.test);
  } finally {
    writeFileSync(path, original);
    const restored = readFileSync(path, 'utf8');
    if (restored !== original) {
      // Loud and immediate: the working tree is now wrong and the operator must know before the
      // next line of output scrolls it away.
      throw new Error(`FAILED TO RESTORE ${mutation.file}. Run: git checkout -- ${mutation.file}`);
    }
  }

  if (run.status === 0) return { ...base, outcome: 'survived', caughtBy: null };
  return { ...base, outcome: 'caught', caughtBy: firstFailingTest(run.stdout ?? '') };
}

/** @param {string} suite */
function runSuite(suite) {
  return spawnSync(process.execPath, ['--no-warnings', '--test', suite], {
    encoding: 'utf8',
    cwd: root,
    timeout: 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The name of the first test that went red, from the TAP stream, so the report says *what* caught
 * the mutation rather than only that something did.
 *
 * @param {string} stdout
 */
export function firstFailingTest(stdout) {
  const match = /^not ok \d+ - (.+)$/m.exec(stdout);
  return match ? match[1].trim() : null;
}
