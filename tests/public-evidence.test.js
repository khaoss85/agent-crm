// @ts-check

/**
 * The two mechanisms that keep a public number honest, held to their own standard.
 *
 * **Provenance.** `site/claims.json` publishes a measurement — a commit, a date, a test
 * count — and every public surface resolves its number from that one block. The old gate
 * asked `git cat-file -e <sha>`: does an object with this id exist. That is the wrong
 * question in both directions. It passes a commit pushed to an unrelated branch, because
 * the object is in the same store; and under `actions/checkout`'s default `fetch-depth: 1`
 * it fails every honest historical measurement, because no commit but HEAD was fetched.
 * Three pull requests were red on the second half of that.
 *
 * So the outcomes are separated here, against real repositories built for the purpose,
 * with the real `git merge-base --is-ancestor` doing the work: a commit that is missing, a
 * commit that exists but is not an ancestor, a record whose facts do not match the tree it
 * names, and a shallow clone that cannot tell those apart and says so instead of guessing.
 *
 * **The budget.** `llms-full.txt` used to keep its 40,000-character promise by dropping
 * whichever inlined section came last, and the section that came last was the claims
 * ledger's evidence — the one part of the file with no substitute. The overflow is
 * reproduced here deliberately, with a ledger too large to fit, and the generator has to
 * refuse rather than publish a file quietly missing it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectProvenance, findLooseTestCounts, PROVENANCE, gitIn } from '../scripts/measurement.js';

const repo = process.cwd();

// ---------------------------------------------------------------- a repository to reason about

/**
 * A throwaway repository with a real shape: three commits on the main line, and one commit
 * on a branch that main never absorbed. Nothing is stubbed — the assertions below are
 * whatever git actually answers.
 *
 * @param {{ cwd: string }} where
 */
function buildFixtureRepo({ cwd }) {
  const git = gitIn(cwd);
  const run = (/** @type {string[]} */ args) => {
    const result = git(args);
    assert.equal(result.status, 0, `git ${args.join(' ')} failed in the fixture`);
    return result.stdout;
  };

  run(['init', '--quiet', '--initial-branch=main']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  run(['config', 'user.name', 'Fixture']);
  run(['config', 'commit.gpgsign', 'false']);

  mkdirSync(join(cwd, 'tests'), { recursive: true });
  writeFileSync(join(cwd, 'package.json'), `${JSON.stringify({
    name: 'fixture', private: true, scripts: { check: 'true', verify: 'npm run check' },
  }, null, 2)}\n`);
  writeFileSync(join(cwd, 'tests/first.test.js'), '// first\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'first']);
  const first = run(['rev-parse', 'HEAD']);

  writeFileSync(join(cwd, 'tests/second.test.js'), '// second\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'second']);
  const measured = run(['rev-parse', 'HEAD']);

  // A commit on a line main never took. It exists in this object store and is not an
  // ancestor of HEAD, which is exactly the case `cat-file -e` waved through.
  run(['checkout', '--quiet', '-b', 'sideline']);
  writeFileSync(join(cwd, 'tests/sideline.test.js'), '// sideline\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'sideline']);
  const sideline = run(['rev-parse', 'HEAD']);
  run(['checkout', '--quiet', 'main']);

  writeFileSync(join(cwd, 'README.md'), 'third\n');
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'third']);
  const head = run(['rev-parse', 'HEAD']);

  /** A record that is true of `measured`: the corpus fingerprint git itself reports. */
  const record = {
    date: '2026-01-01',
    sha: measured.slice(0, 7),
    command: 'npm run verify',
    tests: 12,
    failures: 0,
    testFiles: 2,
    testsTree: run(['rev-parse', `${measured}:tests`]),
  };

  return { cwd, git, first, measured, sideline, head, record };
}

/** @param {string} prefix */
function scratch(prefix) {
  return mkdtempSync(join(tmpdir(), `accordo-${prefix}-`));
}

// ---------------------------------------------------------------- provenance: the outcomes

test('a measurement taken at an ancestor is accepted, and says how far back it was', (t) => {
  const root = scratch('prov-ok');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = buildFixtureRepo({ cwd: root });

  const report = inspectProvenance(fixture.record, { cwd: root });
  assert.equal(report.outcome, PROVENANCE.ANCESTOR, report.failures.join('\n'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.failures, []);
  assert.ok(
    report.notes.some((note) => note.includes('ancestor of HEAD')),
    'an accepted measurement still reports its distance from HEAD',
  );
  // The corpus moved between the measurement and HEAD only if a test file changed; here it
  // did not, so no drift note. The third commit touched README.md alone on purpose.
  assert.equal(report.notes.some((note) => note.includes('test corpus has changed')), false);
});

test('a measurement taken at HEAD is accepted and named as such', (t) => {
  const root = scratch('prov-head');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = buildFixtureRepo({ cwd: root });

  const atHead = {
    ...fixture.record,
    sha: fixture.head.slice(0, 7),
    testsTree: fixture.git(['rev-parse', `${fixture.head}:tests`]).stdout,
  };
  const report = inspectProvenance(atHead, { cwd: root });
  assert.equal(report.outcome, PROVENANCE.HEAD, report.failures.join('\n'));
  assert.ok(report.notes.some((note) => note.includes('measured against HEAD')));
});

test('outcome one: a SHA that is in no branch of this repository is reported as missing', (t) => {
  const root = scratch('prov-missing');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = buildFixtureRepo({ cwd: root });

  // A well-formed id that was never written here. `deadbee` is a commit somewhere, no doubt;
  // it is not a commit in this object store, and the message has to say precisely that.
  const report = inspectProvenance({ ...fixture.record, sha: 'deadbee' }, { cwd: root });

  assert.equal(report.outcome, PROVENANCE.MISSING, report.failures.join('\n'));
  assert.equal(report.ok, false);
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0], /provenance missing/);
  assert.match(report.failures[0], /not a commit in this repository at all/);
  assert.match(report.failures[0], /Full history is present/);
});

test('outcome two: a commit from an unrelated branch exists, and is refused as provenance', (t) => {
  const root = scratch('prov-sideline');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = buildFixtureRepo({ cwd: root });

  // The precondition that makes this test worth having: the old gate's question passes.
  assert.equal(
    fixture.git(['cat-file', '-e', `${fixture.sideline}^{commit}`]).status,
    0,
    'the sideline commit exists in this object store — object existence is the check being replaced',
  );

  const report = inspectProvenance({
    ...fixture.record,
    sha: fixture.sideline.slice(0, 7),
    testFiles: 3,
    testsTree: fixture.git(['rev-parse', `${fixture.sideline}:tests`]).stdout,
  }, { cwd: root });

  assert.equal(report.outcome, PROVENANCE.NOT_ANCESTOR, report.failures.join('\n'));
  assert.equal(report.ok, false);
  assert.match(report.failures[0], /provenance broken/);
  assert.match(report.failures[0], /is not an ancestor/);
  assert.match(report.failures[0], /Object existence is not provenance; ancestry is\./);
});

test('outcome three: a genuine ancestor whose recorded facts do not match that tree', (t) => {
  const root = scratch('prov-facts');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = buildFixtureRepo({ cwd: root });

  // The cheapest way to make a stale ledger go green is to move the SHA forward and leave
  // the numbers alone. The corpus fingerprint is what makes that fail.
  const moved = inspectProvenance({
    ...fixture.record,
    sha: fixture.first.slice(0, 7),
  }, { cwd: root });
  assert.equal(moved.outcome, PROVENANCE.FACTS_MISMATCH, moved.failures.join('\n'));
  assert.ok(moved.failures.some((failure) => /measurement facts mismatch/.test(failure)));
  assert.ok(moved.failures.some((failure) => /testsTree/.test(failure) || /test files/.test(failure)));

  // A file count typed by hand rather than counted.
  const miscounted = inspectProvenance({ ...fixture.record, testFiles: 47 }, { cwd: root });
  assert.equal(miscounted.outcome, PROVENANCE.FACTS_MISMATCH);
  assert.ok(miscounted.failures.some((failure) => /testFiles is 47, but that commit holds 2/.test(failure)));

  // A command that commit could not have run.
  const impossible = inspectProvenance({ ...fixture.record, command: 'npm run nonexistent' }, { cwd: root });
  assert.equal(impossible.outcome, PROVENANCE.FACTS_MISMATCH);
  assert.ok(impossible.failures.some((failure) => /defines no "nonexistent" script/.test(failure)));

  // A record with no fingerprint at all cannot be checked, so it is not accepted either.
  const { testsTree, testFiles, ...bare } = fixture.record;
  const unfingerprinted = inspectProvenance(bare, { cwd: root });
  assert.equal(unfingerprinted.outcome, PROVENANCE.FACTS_MISMATCH);
  assert.ok(unfingerprinted.failures.some((failure) => /missing testsTree and\/or testFiles/.test(failure)));

  // A red run is not a measurement a claims ledger may rest on.
  const red = inspectProvenance({ ...fixture.record, failures: 3 }, { cwd: root });
  assert.equal(red.outcome, PROVENANCE.FACTS_MISMATCH);
  assert.ok(red.failures.some((failure) => /rests on a green run/.test(failure)));
});

test('a measurement whose corpus has since moved is accepted, and flagged as describing that commit', (t) => {
  const root = scratch('prov-drift');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = buildFixtureRepo({ cwd: root });

  const git = gitIn(root);
  writeFileSync(join(root, 'tests/later.test.js'), '// later\n');
  assert.equal(git(['add', '-A']).status, 0);
  assert.equal(git(['commit', '--quiet', '-m', 'a fourth commit that changes tests/']).status, 0);

  const report = inspectProvenance(fixture.record, { cwd: root });
  assert.equal(report.outcome, PROVENANCE.ANCESTOR, report.failures.join('\n'));
  assert.ok(
    report.notes.some((note) => note.includes('test corpus has changed since that measurement')),
    'the record stays truthful about its own commit, and says the suite has moved since',
  );
});

// ---------------------------------------------------------------- provenance: shallow and absent

test('a shallow clone refuses to answer instead of reporting a real commit as missing', (t) => {
  const root = scratch('prov-shallow');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const origin = join(root, 'origin');
  mkdirSync(origin, { recursive: true });
  const fixture = buildFixtureRepo({ cwd: origin });

  const shallow = join(root, 'shallow');
  const cloned = spawnSync('git', ['clone', '--quiet', '--depth', '1', '--branch', 'main', `file://${origin}`, shallow], { encoding: 'utf8' });
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.equal(gitIn(shallow)(['rev-parse', '--is-shallow-repository']).stdout, 'true');
  assert.equal(
    gitIn(shallow)(['cat-file', '-e', `${fixture.measured}^{commit}`]).status !== 0,
    true,
    'the measured commit is genuinely absent from a depth-1 clone — this is the CI condition',
  );

  const report = inspectProvenance(fixture.record, { cwd: shallow });
  assert.equal(report.outcome, PROVENANCE.HISTORY_UNAVAILABLE, report.failures.join('\n'));
  assert.equal(report.ok, false, 'unprovable is a failure, not a pass');
  assert.match(report.failures[0], /provenance unprovable/);
  assert.match(report.failures[0], /shallow clone/);
  assert.match(report.failures[0], /fetch-depth: 0/);
  // The distinction the whole change turns on: this is not the "missing" sentence.
  assert.equal(/not a commit in this repository at all/.test(report.failures[0]), false);
});

test('the same clone with full history restored accepts the measurement', (t) => {
  const root = scratch('prov-unshallow');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const origin = join(root, 'origin');
  mkdirSync(origin, { recursive: true });
  const fixture = buildFixtureRepo({ cwd: origin });

  const clone = join(root, 'clone');
  assert.equal(spawnSync('git', ['clone', '--quiet', '--depth', '1', '--branch', 'main', `file://${origin}`, clone], { encoding: 'utf8' }).status, 0);
  assert.equal(inspectProvenance(fixture.record, { cwd: clone }).outcome, PROVENANCE.HISTORY_UNAVAILABLE);

  // `fetch --unshallow` is what `fetch-depth: 0` does for the workflow.
  const deepened = spawnSync('git', ['fetch', '--unshallow', '--quiet'], { cwd: clone, encoding: 'utf8' });
  assert.equal(deepened.status, 0, deepened.stderr);

  const report = inspectProvenance(fixture.record, { cwd: clone });
  assert.equal(report.outcome, PROVENANCE.ANCESTOR, report.failures.join('\n'));
  assert.equal(report.ok, true);
});

test('a tree with no git at all fails closed rather than skipping the check', (t) => {
  const root = scratch('prov-nogit');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const report = inspectProvenance({
    sha: 'abcdef0', command: 'npm run verify', tests: 1, failures: 0, testFiles: 1, testsTree: 'x',
  }, { cwd: root });

  assert.equal(report.outcome, PROVENANCE.NO_REPOSITORY);
  assert.equal(report.ok, false, 'the previous version skipped this silently, publishing unverified provenance');
  assert.match(report.failures[0], /provenance unavailable/);
});

test('a record with no usable SHA is rejected before any git runs', () => {
  for (const sha of [undefined, '', 'not-a-sha', 'HEAD~1']) {
    const report = inspectProvenance({ sha }, {
      git: () => assert.fail('git must not be consulted for a record that names no commit'),
    });
    assert.equal(report.outcome, PROVENANCE.NO_SHA);
    assert.equal(report.ok, false);
  }
});

// ---------------------------------------------------------------- the count lives in one place

test('a literal test count is found in copy, and the sanctioned token is not', () => {
  assert.deepEqual(findLooseTestCounts('**701 tests, 0 failing**, run on every push.'), [
    { line: 1, phrase: '701 tests' },
  ]);
  assert.deepEqual(findLooseTestCounts('1,024 tests passing'), [{ line: 1, phrase: '1,024 tests' }]);
  assert.deepEqual(findLooseTestCounts('1,024 passing tests'), [{ line: 1, phrase: '1,024 passing tests' }]);
  assert.deepEqual(findLooseTestCounts('runs 4 tests\nand 5 tests')
    .map((entry) => entry.line), [1, 2]);

  // The token is how a template is allowed to say it, exactly as {{brand.name}} is how it is
  // allowed to name the product. Stripping tokens first is what makes the rule usable.
  assert.deepEqual(findLooseTestCounts('{{measured.tests}} tests passing, 0 failing.'), []);

  // Not measurements: a citation with a comma in it, and a number written out.
  assert.deepEqual(findLooseTestCounts('proved by C-13, tests/package-contract.test.js'), []);
  assert.deepEqual(findLooseTestCounts('sixteen adversarial categories, and no tests quoted'), []);
});

test('a four-digit count is caught whether or not it carries a thousands separator', () => {
  // The suite is a few milestones from four digits. A rule that refuses "1,024 tests" and
  // waves through "1024 tests" refuses a typing habit, not a stale number.
  assert.deepEqual(findLooseTestCounts('1024 tests passing'), [{ line: 1, phrase: '1024 tests' }]);
  assert.deepEqual(findLooseTestCounts('**1024 tests, 0 failing**'), [{ line: 1, phrase: '1024 tests' }]);
  assert.deepEqual(findLooseTestCounts('12345 failing tests'), [{ line: 1, phrase: '12345 failing tests' }]);

  // Widening the number must not widen it into citations: the separator still cannot end a count.
  assert.deepEqual(findLooseTestCounts('proved by C-1024, tests/measurement.test.js'), []);
});

test('no public surface in this repository types a test count', () => {
  const ledger = JSON.parse(readFileSync(join(repo, 'site/claims.json'), 'utf8'));

  /** @type {Array<[string, string]>} */
  const surfaces = [['README.md', readFileSync(join(repo, 'README.md'), 'utf8')]];
  for (const name of ['answers.json', 'concepts.json', 'compare.json', 'capabilities.json', 'tools.json']) {
    const path = join(repo, 'site', name);
    if (existsSync(path)) surfaces.push([`site/${name}`, readFileSync(path, 'utf8')]);
  }
  surfaces.push(['site/claims.json prose', [
    ...ledger.claims.flatMap((/** @type {any} */ claim) => [claim.text, claim.limitation, ...(claim.evidence?.repoFacts ?? [])]),
    ...ledger.limitations.flatMap((/** @type {any} */ item) => [item.headline, item.text, ...(item.evidence?.repoFacts ?? [])]),
  ].join('\n')]);

  for (const [label, source] of surfaces) {
    assert.deepEqual(
      findLooseTestCounts(source), [],
      `${label} types a test count. The number is measured into claims.json measuredAgainst and resolved from there.`,
    );
  }

  // And the one place it does live is a record, not a bare number. What that record must
  // contain is `inspectProvenance`'s business — it is checked against the commit rather
  // than against a list of key names, and `npm run gtm:check` is where that runs over this
  // repository. Asserting the shape a second time here would only make the suite red at
  // the commit a re-measurement is being taken at, which is a circle, not a check.
  assert.equal(typeof ledger.measuredAgainst, 'object');
  assert.match(String(ledger.measuredAgainst.sha), /^[0-9a-f]{7,40}$/);
});

// ---------------------------------------------------------------- the llms-full budget

/** The inputs `scripts/generate-llms.js` reads, copied into a root it can be run against. */
function llmsFixture() {
  const root = scratch('llms');
  const distPath = join(repo, 'site/dist');
  cpSync(join(repo, 'site'), join(root, 'site'), {
    recursive: true,
    filter: (from) => from !== distPath && !from.startsWith(`${distPath}/`),
  });
  cpSync(join(repo, 'docs'), join(root, 'docs'), { recursive: true });
  for (const name of ['README.md', 'AGENTS.md', 'PRODUCT.md', 'ARCHITECTURE.md', 'DECISIONS.md']) {
    cpSync(join(repo, name), join(root, name));
  }
  return root;
}

/** @param {string} root @param {string[]} args */
function runGenerator(root, args = []) {
  return spawnSync(process.execPath, ['--no-warnings', join(repo, 'scripts/generate-llms.js'), ...args], {
    cwd: root, encoding: 'utf8',
  });
}

test('the ledger evidence is inlined ahead of anything optional, and the file is inside its budget', (t) => {
  const root = llmsFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const run = runGenerator(root);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);

  const full = readFileSync(join(root, 'site/assets/llms-full.txt'), 'utf8');
  assert.ok(full.includes('## The claims ledger: evidence for every entry'), 'the mandatory section is present');
  assert.ok(full.length <= 40000, `llms-full.txt is ${full.length} characters, over its own stated budget`);

  // Every ledger id resolves in the evidence block — that is what "no substitute" means.
  const ledger = JSON.parse(readFileSync(join(root, 'site/claims.json'), 'utf8'));
  const evidence = full.slice(full.indexOf('## The claims ledger: evidence for every entry'));
  for (const entry of [...ledger.claims, ...ledger.limitations]) {
    assert.ok(evidence.includes(`**${entry.id}**`), `${entry.id} has no evidence line in llms-full.txt`);
  }

  // Mandatory content is allocated first, so an optional document can never displace it.
  const omissions = full.slice(full.indexOf('## What this file omits'));
  assert.equal(omissions.includes('the evidence for every ledger entry'), false, 'the ledger was listed as omitted');
});

test('a ledger too large for the budget fails the generator closed instead of dropping evidence', (t) => {
  const root = llmsFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  // Deliberate overflow, with real inputs and the real 40,000-character constant: a ledger
  // wide enough that its evidence block alone cannot fit. This is the PR #44 shape, scaled
  // past the point where the old code would quietly have published a file without it.
  const path = join(root, 'site/claims.json');
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  const template = ledger.claims[0];
  for (let index = 0; index < 400; index += 1) {
    ledger.claims.push({
      ...template,
      id: `C-9${String(index).padStart(3, '0')}`,
      surfaces: [],
      evidence: { ...template.evidence, tests: ['tests/module-factory-e2e.test.js', 'tests/generated-api-e2e.test.js'] },
    });
  }
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`);

  const before = readFileSync(join(root, 'site/assets/llms-full.txt'), 'utf8');

  const written = runGenerator(root);
  assert.equal(written.status, 1, 'the generator must refuse to publish an over-budget file');
  assert.match(written.stderr, /is mandatory and overruns the 40,000-character budget/);
  assert.match(written.stderr, /compact a section above, raise FULL_BUDGET/);
  assert.equal(
    readFileSync(join(root, 'site/assets/llms-full.txt'), 'utf8'), before,
    'a failed run must not have written a truncated file over the committed one',
  );

  const checked = runGenerator(root, ['--check']);
  assert.equal(checked.status, 1, '--check must fail closed on the same condition');
  assert.match(checked.stderr, /is mandatory and overruns/);
  // Not the staleness message: the file is not stale, it is unpublishable.
  assert.equal(/Run `node scripts\/generate-llms\.js` and commit the result/.test(checked.stderr), false);
});

test('an optional inlined document that does not fit is omitted and named, not dropped in silence', (t) => {
  const root = llmsFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.equal(runGenerator(root).status, 0);
  const full = readFileSync(join(root, 'site/assets/llms-full.txt'), 'utf8');
  const omissions = full.slice(full.indexOf('## What this file omits'));

  // Whatever did not fit today, the contract is the same: it is optional, it is listed, and
  // the line says where to fetch it instead.
  for (const path of ['docs/AGENT_HARNESS_COMPATIBILITY.md', 'docs/APPLICATION_INSPECTION.md']) {
    const inlined = full.includes(`## Full text: \`${path}\``);
    if (inlined) continue;
    assert.ok(omissions.includes(path), `${path} was neither inlined nor listed as omitted`);
    assert.match(omissions, new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*over the remaining budget\\. Fetch it directly\\.`));
  }
});
