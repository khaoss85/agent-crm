// @ts-check

/**
 * The measurement record, and the two rules that keep it honest.
 *
 * `site/claims.json` carries one `measuredAgainst` block: the commit a real
 * `npm run verify` was run at, the date, and the numbers it produced. Every
 * public surface that wants to state how much is tested resolves to that block,
 * so there is exactly one number in the project and exactly one place to change it.
 *
 * Two things can rot, and this module holds both:
 *
 *   1. **Provenance.** The recorded commit has to be a commit this checkout
 *      descends from. The previous gate tested `git cat-file -e <sha>` — object
 *      *existence*. That is not provenance: a commit pushed to an unrelated branch
 *      exists in the same object store and would have passed. It also failed for
 *      the wrong reason under `actions/checkout` defaults, where `fetch-depth: 1`
 *      leaves no commit but HEAD, so every historical measurement looked fabricated.
 *      `inspectProvenance` separates the three outcomes that were collapsed into
 *      one message — missing, not an ancestor, and facts that do not match the
 *      tree — and refuses to answer at all when the checkout cannot know.
 *
 *   2. **Location.** A count typed into prose drifts at the next merge; four
 *      surfaces were advertising 373, 701 and 793 tests at the same time. Authored
 *      public copy may state a count only as the `{{measured.tests}}` token, which
 *      `scripts/site-build.js` resolves from the record. `findLooseTestCounts`
 *      finds the literals, and `scripts/site-check.js` fails on them.
 *
 * Neither rule is weakened by a shallow clone: a checkout that cannot prove
 * provenance fails with "history unavailable" rather than passing quietly.
 */

import { spawnSync } from 'node:child_process';

/**
 * What a provenance check concluded. Every value except `head` and `ancestor`
 * is a failure; the three the brief names are `missing`, `not-ancestor` and
 * `facts-mismatch`.
 */
export const PROVENANCE = /** @type {const} */ ({
  HEAD: 'head',
  ANCESTOR: 'ancestor',
  MISSING: 'missing',
  NOT_ANCESTOR: 'not-ancestor',
  FACTS_MISMATCH: 'facts-mismatch',
  HISTORY_UNAVAILABLE: 'history-unavailable',
  NO_REPOSITORY: 'no-repository',
  NO_SHA: 'no-sha',
});

const HOW_TO_GET_HISTORY = 'Give the job full history — `actions/checkout` with `fetch-depth: 0`, '
  + 'or `git fetch --unshallow` — and run it again.';

/**
 * @typedef {object} ProvenanceReport
 * @property {string} outcome one of {@link PROVENANCE}
 * @property {boolean} ok true only when the record is provable and its facts hold
 * @property {string[]} failures reasons the gate must fail, each naming which outcome it is
 * @property {string[]} notes advisory observations that do not fail a build
 */

/**
 * @typedef {object} GitResult
 * @property {number} status
 * @property {string} stdout
 */

/**
 * Runs git in a directory. Exposed so tests can drive the logic against a fixture
 * repository — or a stub — without a second implementation of the rules.
 * @param {string} cwd
 * @returns {(args: string[]) => GitResult}
 */
export function gitIn(cwd) {
  return (args) => {
    const run = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: run.status ?? 1, stdout: String(run.stdout ?? '').trim() };
  };
}

/**
 * Decides whether this checkout can prove the measurement record, and whether the
 * record's own facts survive being checked against the commit it names.
 *
 * @param {Record<string, any> | undefined} measuredAgainst the ledger's block
 * @param {{ cwd?: string, git?: (args: string[]) => GitResult }} [options]
 * @returns {ProvenanceReport}
 */
export function inspectProvenance(measuredAgainst, options = {}) {
  const git = options.git ?? gitIn(options.cwd ?? process.cwd());
  /** @type {string[]} */
  const failures = [];
  /** @type {string[]} */
  const notes = [];
  const done = (/** @type {string} */ outcome) => ({ outcome, ok: failures.length === 0, failures, notes });

  const sha = String(measuredAgainst?.sha ?? '');
  if (!/^[0-9a-f]{7,40}$/.test(sha)) {
    failures.push('claims.json measuredAgainst.sha is not a commit SHA, so there is nothing to check the public numbers against.');
    return done(PROVENANCE.NO_SHA);
  }

  const head = git(['rev-parse', 'HEAD']);
  if (head.status !== 0 || !head.stdout) {
    // Fails closed on purpose. The old code skipped the whole section when git said
    // nothing, so an export with no .git directory published unverified provenance.
    failures.push(
      `provenance unavailable: \`git rev-parse HEAD\` did not answer, so this tree is not a git checkout `
      + `and nothing here can confirm that ${sha} is a commit this code descends from. Run the gate from a `
      + 'git checkout; a published claim whose measurement cannot be traced is not a checked claim.',
    );
    return done(PROVENANCE.NO_REPOSITORY);
  }
  const headSha = head.stdout;

  // `--is-shallow-repository` is the difference between "that commit was never here"
  // and "this clone was not given enough history to say", which are opposite reports
  // to a reader and were previously the same sentence.
  const shallowProbe = git(['rev-parse', '--is-shallow-repository']);
  const shallow = shallowProbe.status === 0 && shallowProbe.stdout === 'true';

  if (headSha.startsWith(sha)) {
    notes.push('The ledger was measured against HEAD.');
    checkFacts(git, sha, measuredAgainst ?? {}, failures);
    return done(failures.length ? PROVENANCE.FACTS_MISMATCH : PROVENANCE.HEAD);
  }

  const present = git(['cat-file', '-e', `${sha}^{commit}`]).status === 0;
  if (!present) {
    if (shallow) {
      failures.push(
        `provenance unprovable: claims.json measuredAgainst.sha ${sha} is not in this checkout, but this is a `
        + `shallow clone — history was truncated, so the commit may be perfectly real and simply not fetched. `
        + `This gate refuses to pass a claim it cannot trace. ${HOW_TO_GET_HISTORY}`,
      );
      return done(PROVENANCE.HISTORY_UNAVAILABLE);
    }
    failures.push(
      `provenance missing: claims.json measuredAgainst.sha ${sha} is not a commit in this repository at all. `
      + 'Full history is present and no object with that id exists, so the public numbers were measured '
      + 'somewhere this code cannot see.',
    );
    return done(PROVENANCE.MISSING);
  }

  const ancestor = git(['merge-base', '--is-ancestor', sha, 'HEAD']);
  if (ancestor.status !== 0) {
    if (shallow) {
      failures.push(
        `provenance unprovable: claims.json measuredAgainst.sha ${sha} is present but cannot be shown to be an `
        + 'ancestor of HEAD, and this is a shallow clone — a truncated commit graph cannot distinguish '
        + `"unrelated branch" from "the connecting commits were not fetched". ${HOW_TO_GET_HISTORY}`,
      );
      return done(PROVENANCE.HISTORY_UNAVAILABLE);
    }
    failures.push(
      `provenance broken: claims.json measuredAgainst.sha ${sha} exists in this repository but is not an ancestor `
      + `of HEAD (${headSha.slice(0, 7)}). It sits on a line of development this code does not descend from, so the `
      + 'numbers were measured against a different tree than the one about to ship. Object existence is not '
      + 'provenance; ancestry is.',
    );
    return done(PROVENANCE.NOT_ANCESTOR);
  }

  const behind = git(['rev-list', '--count', `${sha}..HEAD`]).stdout || '?';
  notes.push(`The ledger was measured ${behind} commit(s) ago at ${sha}, which is an ancestor of HEAD.`);

  checkFacts(git, sha, measuredAgainst ?? {}, failures);
  if (failures.length) return done(PROVENANCE.FACTS_MISMATCH);

  // Advisory, not fatal: a record that names its own commit and proves it is truthful
  // even when the suite has moved since. What would be untruthful is a *sentence*
  // quoting that number as current, which is why `findLooseTestCounts` exists.
  const measuredTree = git(['rev-parse', `${sha}:tests`]).stdout;
  const headTree = git(['rev-parse', `${headSha}:tests`]).stdout;
  if (measuredTree && headTree && measuredTree !== headTree) {
    notes.push(
      'The test corpus has changed since that measurement, so the recorded count describes '
      + `${sha}, not HEAD. Re-run \`npm run verify\` and update measuredAgainst before publishing anything.`,
    );
  }

  return done(PROVENANCE.ANCESTOR);
}

/**
 * The third outcome: the commit is genuinely an ancestor, but the record's facts do
 * not match the tree it names.
 *
 * What is checkable without re-running a three-minute suite at an old commit is the
 * corpus the run was taken over, and that is checkable exactly. `tests/` at that
 * commit has a git tree id; any edit to any test file changes it. So a record cannot
 * be re-pointed at a newer commit — the cheap way to make this gate go green — without
 * the fingerprint disagreeing. The file count is recorded beside it because a tree id
 * is unreadable, and a human reviewing the diff should be able to see the corpus move.
 *
 * @param {(args: string[]) => GitResult} git
 * @param {string} sha
 * @param {Record<string, any>} record
 * @param {string[]} failures
 */
function checkFacts(git, sha, record, failures) {
  const where = `measurement facts mismatch at ${sha}:`;

  if (!Number.isInteger(record.tests) || record.tests <= 0) {
    failures.push(`${where} measuredAgainst.tests is not a positive whole number, so no run produced it.`);
  }
  if (record.failures !== 0) {
    failures.push(`${where} measuredAgainst.failures is ${JSON.stringify(record.failures)}. A claims ledger rests on a green run.`);
  }

  const command = String(record.command ?? '');
  const script = /^npm run ([\w:-]+)$/.exec(command)?.[1];
  if (!script) {
    failures.push(`${where} measuredAgainst.command ${JSON.stringify(command)} is not an \`npm run <script>\` invocation, so it cannot be checked against that commit.`);
  } else {
    const manifest = git(['show', `${sha}:package.json`]);
    if (manifest.status !== 0) {
      failures.push(`${where} package.json cannot be read at that commit, so measuredAgainst.command cannot be confirmed.`);
    } else {
      let scripts = {};
      try {
        scripts = JSON.parse(manifest.stdout).scripts ?? {};
      } catch {
        failures.push(`${where} package.json at that commit is not valid JSON.`);
      }
      if (!(script in scripts)) {
        failures.push(`${where} measuredAgainst.command is "${command}", but package.json at that commit defines no "${script}" script. That run could not have happened there.`);
      }
    }
  }

  const recordedTree = String(record.testsTree ?? '');
  const recordedFiles = record.testFiles;
  if (!recordedTree || typeof recordedFiles !== 'number') {
    failures.push(
      `${where} measuredAgainst is missing testsTree and/or testFiles. Without a fingerprint of the corpus the `
      + 'run was taken over, the numbers cannot be checked mechanically at all — record them with '
      + '`node scripts/measure-suite.js`.',
    );
    return;
  }

  const actualTree = git(['rev-parse', `${sha}:tests`]);
  if (actualTree.status !== 0 || !actualTree.stdout) {
    failures.push(`${where} that commit has no tests/ tree, so measuredAgainst.testsTree describes nothing.`);
    return;
  }
  if (actualTree.stdout !== recordedTree) {
    failures.push(
      `${where} measuredAgainst.testsTree is ${recordedTree}, but tests/ at that commit is ${actualTree.stdout}. `
      + 'The recorded numbers were not taken at the commit the ledger names — most likely the SHA was moved '
      + 'forward without re-running the suite.',
    );
    return;
  }

  const listed = git(['ls-tree', '-r', '--name-only', sha, 'tests/']);
  if (listed.status === 0) {
    const actualFiles = listed.stdout.split('\n').filter((path) => path.endsWith('.test.js')).length;
    if (actualFiles !== recordedFiles) {
      failures.push(`${where} measuredAgainst.testFiles is ${recordedFiles}, but that commit holds ${actualFiles} \`*.test.js\` files.`);
    } else if (Number.isInteger(record.tests) && record.tests < actualFiles) {
      failures.push(`${where} measuredAgainst.tests is ${record.tests} across ${actualFiles} test files, which is fewer tests than files.`);
    }
  }
}

/**
 * Literal test counts in authored public copy.
 *
 * The convention this borrows is the brand one: a template may not type the product
 * name either, it writes `{{brand.name}}`. Same rule, same reason. A line's tokens are
 * stripped before the scan, so `{{measured.tests}} tests passing` is allowed and
 * `701 tests passing` is not — and prose that cannot carry a token (a README, a JSON
 * answer served raw) simply states what the gate proves instead of how many.
 *
 * Spelled-out numbers are deliberately not matched: "sixteen adversarial categories"
 * is a fact about a checked-in list, not a measurement that moves every merge. Grouped
 * thousands are, so "1,024 tests" is caught — but a trailing comma is not part of the
 * number, or every "`C-13`, tests/foo.test.js" citation would read as a count. An
 * ungrouped "1024 tests" is caught too: this suite is a few milestones from four digits,
 * and a gate that only refuses the separator someone happened to type is not a gate.
 *
 * Two prefixes are excluded, and they are the reason widening this scan to `docs/` was
 * possible at all. `\b` alone matches inside a hyphenated identifier and after a currency
 * symbol, so "the ADR-018 test for what core owns" read as "018 test" and "a €500 test on
 * conversion" read as "500 test" — two false positives in the first two documents the wider
 * scan touched. A measured count is never written immediately after a hyphen or a currency
 * symbol, so refusing those two prefixes costs the gate nothing and buys it a whole
 * directory. Both are pinned in `tests/repository-truth.test.js`.
 *
 * @param {string} source
 * @returns {Array<{ line: number, phrase: string }>} the offending phrases, in order
 */
export function findLooseTestCounts(source) {
  /** @type {Array<{ line: number, phrase: string }>} */
  const found = [];
  const lines = String(source).split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const stripped = lines[index].replace(/\{\{[^}]+\}\}/g, '');
    // Grouped form first so "1,024" is taken whole; the plain alternative then covers any
    // length. Neither can end on a separator, so a "`C-13`, tests/…" citation is not a count.
    for (const match of stripped.matchAll(/(?<![\w\-€$£¥])(?:\d{1,3}(?:,\d{3})+|\d+)\s+(?:passing\s+|failing\s+)?tests?\b/gi)) {
      found.push({ line: index + 1, phrase: match[0] });
    }
  }
  return found;
}

/**
 * Where the measured commit may be repeated, and where a count may not.
 *
 * `site/claims.json` is the one measurement record. `docs/PROJECT_STATUS.md` is the one
 * narrative status file, and `AGENTS.md` §12 *orders* every agent to trust it — which makes
 * it the most expensive file in the repository to leave stale. It carried a second SHA and a
 * second test count of its own for months, both hand-typed, both wrong, and a test pinned
 * them in place so no gate could notice.
 *
 * The fix is not a second provenance mechanism. The status file states no count and *cites*
 * the ledger's commit, and this binds the two strings so they cannot drift apart quietly. It
 * is deliberately a literal comparison of one table row: no natural-language inference, and
 * no opinion about whether the prose around it is true.
 *
 * @param {string} statusSource contents of docs/PROJECT_STATUS.md
 * @param {Record<string, any> | undefined} measuredAgainst the ledger's block
 * @returns {string[]} reasons the gate must fail
 */
export function inspectStatusMeasurement(statusSource, measuredAgainst) {
  /** @type {string[]} */
  const failures = [];
  const recorded = String(measuredAgainst?.sha ?? '');
  const source = String(statusSource ?? '');

  if (!/^[0-9a-f]{7,40}$/.test(recorded)) {
    failures.push(
      'docs/PROJECT_STATUS.md cannot be bound to a measurement: claims.json measuredAgainst.sha is not a commit '
      + 'SHA. Run `node scripts/measure-suite.js --apply` on a clean tree.',
    );
    return failures;
  }

  const rows = [...source.matchAll(/^\|\s*Measured at\s*\|\s*`([0-9a-f]{7,40})`/gm)];
  if (rows.length === 0) {
    failures.push(
      'docs/PROJECT_STATUS.md has no `| Measured at | `<sha>` |` row. AGENTS.md tells every agent to trust that '
      + 'file for what is true today, so it has to name the commit the public numbers were measured at — '
      + `${recorded}, from site/claims.json measuredAgainst.`,
    );
    return failures;
  }
  if (rows.length > 1) {
    failures.push(
      `docs/PROJECT_STATUS.md states ${rows.length} "Measured at" rows. Two measurements in one status file is the `
      + 'drift this binding exists to stop; keep one.',
    );
  }

  for (const row of rows) {
    if (row[1] !== recorded) {
      failures.push(
        `docs/PROJECT_STATUS.md says it was measured at ${row[1]}, but site/claims.json measuredAgainst.sha is `
        + `${recorded}. The status file measures nothing of its own — it cites the ledger. Re-run `
        + '`node scripts/measure-suite.js --apply` and copy the recorded sha into the row, or fix the row.',
      );
    }
  }

  return failures;
}

/**
 * Documents whose test counts are dated history rather than a current claim.
 *
 * Widening the loose-count scan from `site/` to `docs/` is the point — `docs/PROJECT_STATUS.md`
 * typed a count for months with no gate over it. But `docs/` also holds records of runs that
 * happened, and rewriting those would be falsifying history to satisfy a linter. Each entry
 * below holds numbers that are *stamped*, not *claimed*, and each says why.
 *
 * The list is deliberately short. A new document is scanned by default; adding to this list is
 * a reviewable edit with an argument attached, exactly like raising a surface ceiling.
 */
export const DATED_HISTORY = [
  // An ExecPlan records what a run measured while the work was in progress, at a commit the
  // plan names. It is this project's laboratory notebook and is never read as current status.
  'docs/plans/',
  // A dated rename experiment. "388 tests, 387 pass, 1 fail" is that trial's observed result,
  // and the whole document is the trial's record.
  'docs/RENAME_SURFACE.md',
  // Both open with "Written against `HEAD` on <date> with N tests passing" — a provenance stamp
  // that tells a reader how old the analysis is. Removing the number removes the stamp.
  'docs/strategy/AGENT_RECOMMENDATION.md',
  'docs/strategy/GO_TO_MARKET.md',
];

/**
 * Whether a repository-relative path is scanned for typed test counts.
 * A directory entry matches by prefix; a file entry matches exactly, so a neighbouring
 * filename cannot inherit an exemption.
 * @param {string} path repository-relative, POSIX separators
 */
export function scansForLooseCounts(path) {
  return !DATED_HISTORY.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}
