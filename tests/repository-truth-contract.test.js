import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeResidual, disposable, removeForProbe, scratchClass, scratchRoot } from './helpers/scratch.js';
import { runConcurrencyProbe } from './helpers/scratch-concurrency-probe.js';

import {
  AUTHORITY_KINDS,
  AUTHORITY_SOURCES,
  BENCHMARK_PANEL,
  BOUND_SURFACES,
  FACT_SCOPES,
  FACT_STATUSES,
  FACT_VALUES,
  REPOSITORY_TRUTH_CONTRACT,
  RETIRED_CLAIMS,
  RETIRED_CODES,
  TRUTH_DOCUMENT,
  buildFacts,
  buildTruthDocument,
  canonical,
  checkCitations,
  checkRepository,
  diffDocuments,
  findMalformedDirectives,
  findRetiredClaims,
  findUnknownCodes,
  harvestCodeVocabulary,
  parseCitations,
  readAuthorities,
  readBenchmarkReceipt,
  readMeasurement,
  repositoryBasenames,
  resolveSurfacePath,
  serialize,
} from '../scripts/repo-truth.js';

/**
 * ADR-039 — the Repository Truth Contract.
 *
 * **Every rule here is driven by the mutation that must fail it.** A truth gate
 * that has only ever been run against a repository already in agreement proves
 * that the repository agrees with itself, which is exactly the property that was
 * true on the day this contract was written and exactly the property that was
 * worthless: `PROJECT_STATUS`, the JTBD matrix, the claims ledger and the
 * scenario limitation metadata were all mutually consistent, all stale, and
 * every gate was green.
 *
 * So each negative test breaks one thing on purpose — in memory over the
 * authority bundle, or on disk in a throwaway copy of the framework — and
 * asserts the specific problem code, that the failure is not silent, and (where
 * it matters most) that the fact is *withdrawn* rather than defaulted.
 *
 * The canonical regression has its own test: PR #102 fixed a scenario that went
 * on publishing `TENANT_ISOLATION_NOT_ENFORCED` after ADR-038 Amendment 2 closed
 * the gap by binding, and nothing caught it. Two tests below would have.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/** The authority bundle, read once — every mutation test clones it. */
let cachedBundle = null;
async function bundle() {
  if (!cachedBundle) cachedBundle = await readAuthorities({ rootDir: repoRoot });
  return structuredClone(cachedBundle);
}

/** Problem codes in a result, deduplicated and sorted, for readable assertions. */
function codes(problems) {
  return [...new Set(problems.map((problem) => problem.code))].sort();
}

/** The problem whose message names `needle`, or a helpful failure. */
function problemNaming(problems, needle) {
  const found = problems.find((problem) => problem.message.includes(needle));
  assert.ok(found, `expected a problem naming "${needle}", got:\n${problems.map((p) => `${p.code}: ${p.message}`).join('\n') || '(none)'}`);
  return found;
}

/**
 * Git in a throwaway repository, with the background daemons turned off.
 *
 * `gc.auto=0` and `maintenance.auto=false` are not tuning. After a commit, git
 * may fork a **detached** `git gc --auto`, which goes on writing inside `.git`
 * after `spawnSync` has returned. The fixture's cleanup then races it and the
 * run dies in teardown with `ENOTEMPTY: rmdir '<fixture>/.git'` — which is what
 * happened on CI for `82976f1`: the same commit passed on one runner and failed
 * on the other, in the `t.after` of a test whose assertions had all passed.
 * A gate whose own suite is red half the time is a gate people re-run instead
 * of read, which is the habit this whole contract exists to break.
 */
const git = (cwd, args) => spawnSync('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], { cwd, encoding: 'utf8' });

/**
 * A temporary directory that removes itself, warns rather than failing when it
 * cannot, and **registers what it left** for the run-level gate.
 *
 * Both halves live in `tests/helpers/scratch.js` now, because the first half
 * alone was only half a policy. Retrying and warning is the right answer to a
 * transient race on a loaded runner — every assertion in the test has already
 * passed, and failing there reports a defect that is not there. It is the wrong
 * answer to a *permanent* leak, which it made invisible: importing the helper
 * also arms a run-level gate that retries once more after every test in this
 * file and then fails deterministically on anything still standing.
 *
 * The helper also gives this run a scratch root of its own, so its sweep can
 * name nothing outside what this process created — two runs in flight cannot
 * reach each other's directories, which `tests/helpers/scratch-concurrency-probe.js`
 * proves rather than asserts in prose.
 *
 * Imported at the top of this file; named here because this is where it is read.
 */

/**
 * A throwaway git repository carrying only what one rule needs.
 *
 * `readMeasurement` asks git three questions — is this shallow, is the recorded
 * commit an ancestor, has `tests/` moved — so the cheapest honest way to drive
 * it is a real repository with a real history, which costs milliseconds.
 */
function measurementRepo(t, { files = {}, commits = [] } = {}) {
  const root = disposable(t, 'accordo-truth-measure-');
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'first.test.js'), '// first\n');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  const base = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  for (const commit of commits) {
    commit(root);
    git(root, ['add', '-A']);
    git(root, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'next']);
  }
  return { root, base };
}

/** A `site/claims.json` carrying nothing but the measured record. */
const ledger = (record) => JSON.stringify({ claimsContract: 2, measuredAgainst: record }, null, 2);

/**
 * A throwaway copy of the framework, so a *source* mutation can be observed
 * end to end.
 *
 * Every authority is re-imported from this root, and an ES module is cached by
 * URL — so a fresh directory is the only way to make a mutated source file
 * actually load. Which is also why each such test gets its own copy.
 */
function frameworkFixture(t) {
  const root = disposable(t, 'accordo-truth-fixture-');
  cpSync(join(repoRoot, 'packages'), join(root, 'packages'), { recursive: true });
  cpSync(join(repoRoot, 'package.json'), join(root, 'package.json'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'scripts/repo-truth.js'), join(root, 'scripts/repo-truth.js'));
  for (const path of [BENCHMARK_PANEL.aggregate, BENCHMARK_PANEL.protocol]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repoRoot, path), join(root, path));
  }
  mkdirSync(join(root, 'tests'), { recursive: true });
  writeFileSync(join(root, 'tests', 'placeholder.test.js'), '// placeholder\n');
  mkdirSync(join(root, 'site'), { recursive: true });
  // A stand-in JTBD portfolio. `jtbd.portfolio` is a source authority, and an unreadable
  // source authority refuses the whole document — correctly, and that is what a fixture
  // missing these files was doing. Copying the real 4.6 MB catalogue into every fixture would
  // make this file minutes slower for no extra coverage: what a fixture has to exercise is
  // that the counts are *counted*, not what they count to here.
  for (const directory of ['docs/jtbd/catalog', 'docs/jtbd/coverage', 'docs/jtbd/roadmap']) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  writeFileSync(join(root, 'docs/jtbd/catalog/jtbd.jsonl'),
    `${JSON.stringify({ jtbd_id: 'ACC-JTBD-FIXTURE-001' })}\n`);
  writeFileSync(join(root, 'docs/jtbd/coverage/coverage.overlay.jsonl'),
    `${JSON.stringify({ jtbdId: 'ACC-JTBD-FIXTURE-001', coverageStatus: 'not supported', evidence: [] })}\n`);
  writeFileSync(join(root, 'docs/jtbd/roadmap/roadmap.overlay.jsonl'),
    `${JSON.stringify({ jtbdId: 'ACC-JTBD-FIXTURE-001', ownerStatus: 'unassigned' })}\n`);
  writeFileSync(join(root, 'docs/jtbd/coverage/matrix_crosswalk.json'), `${JSON.stringify({ rows: [] })}\n`);

  return {
    root,
    /** Rewrite one file, and fail loudly if the anchor is not there any more. */
    patch(path, from, to) {
      const full = join(root, path);
      const before = readFileSync(full, 'utf8');
      assert.ok(before.includes(from), `fixture patch anchor missing in ${path}: ${from}`);
      writeFileSync(full, before.replace(from, to));
    },
    write(path, content) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    },
    copyFrom(path) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      cpSync(join(repoRoot, path), join(root, path));
    },
    /** Commit everything and point the ledger at that commit, so git can prove it. */
    seal() {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['add', '-A']);
      git(root, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'fixture']);
      const head = git(root, ['rev-parse', 'HEAD']).stdout.trim();
      writeFileSync(join(root, 'site/claims.json'), ledger({ sha: head.slice(0, 7), tests: 1, testFiles: 1 }));
    },
  };
}

// ─────────────────────────────────────────── the committed document is honest

/**
 * Whether this checkout can prove anything about its own history.
 *
 * CI runs `npm run verify` at `actions/checkout`'s default `fetch-depth: 1`, so
 * this test file has to work in a shallow clone — and *asserting the refusal* is
 * the only honest way to do that. Skipping would leave the strongest test in the
 * file silently absent from the job that runs on every push.
 */
const fullHistory = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: repoRoot, encoding: 'utf8' })
  .stdout?.trim() === 'false';

test('the committed truth document is a fresh generation of its own authorities', async () => {
  const report = await checkRepository({ rootDir: repoRoot });
  const detail = report.problems.map((p) => `${p.code}: ${p.message}`).join('\n');
  if (fullHistory) {
    assert.deepEqual(report.problems, [], `repo:truth --check failed:\n${detail}`);
    assert.equal(report.ok, true);
  } else {
    // A shallow clone cannot prove the measured commit, so the measurement facts
    // read `unknown` and the document no longer matches the committed one. Both
    // are refusals, and both are asserted rather than tolerated.
    assert.deepEqual(codes(report.problems), ['TRUTH_DOCUMENT_STALE', 'TRUTH_MEASUREMENT_UNPROVABLE'], detail);
  }
  // Either way the git-free half of the contract ran in full, which is the half
  // `npm run verify` exists to cover.
  const sourceFailures = ['TRUTH_AUTHORITY_UNAVAILABLE', 'TRUTH_AUTHORITIES_CONTRADICT', 'TRUTH_CITATION_MALFORMED',
    'TRUTH_CODE_UNKNOWN', 'TRUTH_FACT_UNKNOWN', 'TRUTH_FACT_VALUE_STALE'];
  assert.deepEqual(codes(report.problems).filter((code) => sourceFailures.includes(code)), [], detail);
  assert.ok(report.counts.facts >= 30, `expected a meaningful fact inventory, got ${report.counts.facts}`);
  // A citation check over zero citations passes vacuously, which is the way a
  // gate like this rots. The count is asserted so the gate cannot go quiet.
  assert.ok(report.counts.citations >= 40, `expected the bound surfaces to carry citations, got ${report.counts.citations}`);
  assert.ok(report.counts.surfaces >= 10);
});

test('every fact obeys the closed vocabularies, and every authority is declared', async () => {
  const { document } = await buildTruthDocument({ rootDir: repoRoot });
  const shapes = [/^[0-9a-f]{7,40}$/, /^\d+$/];
  const declared = new Set(document.authorities.map((authority) => authority.id));
  assert.equal(document.repositoryTruthContract, REPOSITORY_TRUTH_CONTRACT);
  for (const authority of document.authorities) {
    assert.ok(AUTHORITY_KINDS.includes(authority.kind), `${authority.id} has kind ${authority.kind}`);
    assert.ok(authority.reads.length > 0);
  }
  // All three kinds are present and labelled — the split is the contract, not a
  // comment about it.
  assert.deepEqual([...new Set(document.authorities.map((a) => a.kind))].sort(), ['measurement', 'receipt', 'source']);
  for (const fact of document.facts) {
    assert.ok(/^[a-z][a-z0-9_.]*$/.test(fact.id), `fact id ${fact.id}`);
    assert.ok(
      FACT_VALUES.includes(String(fact.value)) || shapes.some((shape) => shape.test(String(fact.value))),
      `${fact.id} has value ${JSON.stringify(fact.value)}, outside every vocabulary and bounded shape`,
    );
    assert.ok(FACT_SCOPES.includes(fact.scope), `${fact.id} scope ${fact.scope}`);
    assert.ok(FACT_STATUSES.includes(fact.status), `${fact.id} status ${fact.status}`);
    assert.ok(declared.has(fact.authority), `${fact.id} names undeclared authority ${fact.authority}`);
    assert.ok(fact.evidence.length > 0, `${fact.id} carries no evidence`);
    for (const value of Object.values(fact)) assert.notEqual(typeof value, 'function');
  }
  const ids = document.facts.map((fact) => fact.id);
  assert.deepEqual(ids, [...ids].sort(), 'facts are not sorted by id');
  assert.equal(new Set(ids).size, ids.length, 'two facts share one id, so a citation would resolve to whichever won');
});

test('the explainer publishes every limitation the document does', async () => {
  // v1 shipped eleven codes in `limitations[]` and ten rows in the table, and
  // the PR that shipped it said "all eleven boundaries are published". A
  // contract whose own published inventory disagrees with its contents is the
  // failure it exists to catch, one level up.
  const { document } = await buildTruthDocument({ rootDir: repoRoot });
  const explainer = readFileSync(join(repoRoot, 'docs/REPOSITORY_TRUTH.md'), 'utf8');
  const rows = new Set(
    [...explainer.matchAll(/^\| `([A-Z][A-Z0-9_]+)` \|/gm)].map((match) => match[1]),
  );
  assert.deepEqual(
    document.limitations.map((limitation) => limitation.code).sort(),
    [...rows].sort(),
    'docs/REPOSITORY_TRUTH.md and limitations[] publish different sets of codes',
  );
});

test('the document carries no timestamp, no secret and no absolute path', async () => {
  const { document } = await buildTruthDocument({ rootDir: repoRoot });
  const text = serialize(document);
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'an ISO timestamp would make two identical checkouts differ');
  assert.doesNotMatch(text, /"\//, 'an absolute path leaks the machine it was generated on');
  assert.ok(!text.includes(repoRoot), 'the generating directory must not appear anywhere in the document');
  assert.doesNotMatch(text, /api[_-]?key|password|bearer |BEGIN [A-Z ]*PRIVATE KEY/i);
  // The only opaque blobs in the document are its own two digests. Anything
  // else long and random-looking would be a value nobody chose to publish.
  const blobs = [...text.matchAll(/[0-9a-f]{32,}/g)].map((match) => match[0]);
  assert.deepEqual(blobs.sort(), [document.fingerprint, document.sourceSha].sort());
});

test('two generations of the same checkout are byte-identical', async () => {
  const first = await buildTruthDocument({ rootDir: repoRoot });
  const second = await buildTruthDocument({ rootDir: repoRoot });
  assert.equal(serialize(first.document), serialize(second.document));
  assert.equal(first.document.fingerprint, second.document.fingerprint);
});

test('the fingerprint covers the semantic body and moves when a value moves', async () => {
  const bundleOne = await bundle();
  const before = buildFacts(bundleOne);
  const bundleTwo = await bundle();
  bundleTwo.tenantStrategy = 'shared-database';
  const after = buildFacts(bundleTwo);
  const body = (built) => canonical({
    repositoryTruthContract: REPOSITORY_TRUTH_CONTRACT,
    authorities: built.authorities,
    facts: built.facts,
  });
  assert.notEqual(body(before), body(after));
  assert.equal(
    after.facts.find((fact) => fact.id === 'spine.tenant.isolation.mode').value,
    'unknown',
    'an unrecognised strategy must read `unknown`, never the token the old code produced',
  );
});

// ────────────────────────────────── negative: a doc cites something that moved

test('a doc citing an unknown fact fails with TRUTH_FACT_UNKNOWN', async () => {
  const { document } = await buildTruthDocument({ rootDir: repoRoot });
  const index = new Map(document.facts.map((fact) => [fact.id, fact]));
  const problems = checkCitations(
    parseCitations('- SQLite only.\n  <!-- truth: spine.mysql.implemented=absent -->\n'),
    index,
    'README.md',
  );
  assert.deepEqual(codes(problems), ['TRUTH_FACT_UNKNOWN']);
  assert.match(problems[0].message, /README\.md:2/);
  problemNaming(problems, 'spine.mysql.implemented');
});

test('a doc that reverses a fact polarity fails with TRUTH_FACT_VALUE_STALE', async () => {
  const { document } = await buildTruthDocument({ rootDir: repoRoot });
  const index = new Map(document.facts.map((fact) => [fact.id, fact]));
  const real = index.get('spine.tenant.crm_data_plane_enforced');
  assert.equal(real.value, 'enforced_by_binding');
  const problems = checkCitations(
    parseCitations(`<!-- truth: spine.tenant.crm_data_plane_enforced=declared_not_enforced -->\n`),
    index,
    'docs/PROJECT_STATUS.md',
  );
  assert.deepEqual(codes(problems), ['TRUTH_FACT_VALUE_STALE']);
  problemNaming(problems, 'enforced_by_binding');
});

test('a JSON facts array is checked by the same grammar as a Markdown comment', async () => {
  const { document } = await buildTruthDocument({ rootDir: repoRoot });
  const index = new Map(document.facts.map((fact) => [fact.id, fact]));
  const source = '{\n  "facts": [\n    "rail.app_inspect.implemented=absent"\n  ]\n}\n';
  const citations = parseCitations(source);
  assert.equal(citations.length, 1);
  assert.equal(citations[0].line, 3);
  assert.deepEqual(codes(checkCitations(citations, index, 'site/claims.json')), ['TRUTH_FACT_VALUE_STALE']);
});

test('the app inspect posture sentence is bound — the PR #101 regression', async () => {
  // The first of the two failures ADR-039 names: `productionPosture` published
  // "no authentication, tenancy or RBAC exists" in the same report whose
  // PRODUCTION_SPINE_ABSENT message described identity, tenancy and
  // authorization, and a person found it. v1 of this contract bound twenty
  // documents and left that sentence out of every one of them, so restoring the
  // false posture in a throwaway copy left `--check` green.
  assert.ok(BOUND_SURFACES.includes('packages/cli/src/app-inspect.js'), 'the posture sentence is not bound');
  const source = readFileSync(join(repoRoot, 'packages/cli/src/app-inspect.js'), 'utf8');
  const citations = parseCitations(source, { javascript: true });
  const cited = new Set(citations.map((citation) => citation.id));
  for (const required of ['spine.authentication.framework_verifier', 'spine.authorization.enforced',
    'spine.tenant.isolation.mode', 'spine.postgresql.implemented']) {
    assert.ok(cited.has(required), `the posture sentence does not cite ${required}`);
  }
  const { document } = await buildTruthDocument({ rootDir: repoRoot });
  const index = new Map(document.facts.map((fact) => [fact.id, fact]));
  assert.deepEqual(checkCitations(citations, index, 'packages/cli/src/app-inspect.js'), []);
  // Reversing one of them is the mutation that must fail.
  const reversed = parseCitations(source.replace('// truth: spine.authorization.enforced=enforced',
    '// truth: spine.authorization.enforced=absent'), { javascript: true });
  assert.deepEqual(codes(checkCitations(reversed, index, 'packages/cli/src/app-inspect.js')), ['TRUTH_FACT_VALUE_STALE']);
});

test('the JavaScript comment grammar is applied to source surfaces only', () => {
  // `// truth: …` inside a fenced example in a Markdown document is an example,
  // not a citation, so the grammar is opt-in per surface rather than global.
  const line = '// truth: spine.authorization.enforced=absent\n';
  assert.deepEqual(parseCitations(line), []);
  assert.deepEqual(parseCitations(line, { javascript: true }),
    [{ line: 1, id: 'spine.authorization.enforced', value: 'absent' }]);
});

// ───────────────────── negative: the `.js` grammar is bounded and path-scoped

test('the bound .js set is exactly one canonical generator, and nothing globs into it', () => {
  // The whole reason a source file may carry a citation is that `productionPosture`
  // is a product claim written as a string. That is a per-file argument, made in
  // review; it is not a rule a pattern could widen.
  assert.deepEqual(BOUND_SURFACES.filter((surface) => surface.endsWith('.js')),
    ['packages/cli/src/app-inspect.js']);
  for (const surface of [...BOUND_SURFACES, ...AUTHORITY_SOURCES]) {
    assert.ok(!surface.startsWith('/') && !surface.split('/').includes('..'),
      `${surface} is not a repository-relative path without a ".." segment`);
  }
});

test('a declared path that traverses is refused before anything reads it', () => {
  for (const traversal of ['../outside.js', '/etc/passwd', 'packages/../../x.js']) {
    const resolved = resolveSurfacePath(repoRoot, traversal);
    assert.equal(resolved.ok, false, `${traversal} was accepted`);
    assert.match(/** @type {any} */ (resolved).reason, /repository-relative/);
  }
  assert.equal(resolveSurfacePath(repoRoot, 'packages/cli/src/app-inspect.js').ok, true);
});

test('a symlink at a bound path is refused, not followed — at the file and at a parent', async (t) => {
  // Measured on this branch, and it is the reason the allowlist needed a guard
  // at all: `BOUND_SURFACES` is a frozen literal list, so nothing in the script
  // can traverse, but the filesystem can. Pointing the bound source surface at a
  // citation-free file dropped its citations from 95 to 88 and left `--check`
  // GREEN with the retired posture standing in the symlink's target.
  const root = disposable(t, 'accordo-truth-symlink-');
  mkdirSync(join(root, 'packages/cli/src'), { recursive: true });
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  writeFileSync(join(root, 'elsewhere', 'decoy.js'), '// truth: made.up.fact=nonsense\n');

  const bound = join(root, 'packages/cli/src/app-inspect.js');
  symlinkSync(join(root, 'elsewhere', 'decoy.js'), bound);
  const atFile = resolveSurfacePath(root, 'packages/cli/src/app-inspect.js');
  assert.equal(atFile.ok, false);
  assert.match(/** @type {any} */ (atFile).reason, /symbolic link/);
  assert.match(/** @type {any} */ (atFile).reason, /app-inspect\.js/);

  // A parent component is the same hole wearing a different hat.
  rmSync(bound);
  writeFileSync(bound, '// truth: spine.authorization.enforced=enforced\n');
  rmSync(join(root, 'packages/cli/src'), { recursive: true, force: true });
  symlinkSync(join(root, 'elsewhere'), join(root, 'packages/cli/src'));
  const atParent = resolveSurfacePath(root, 'packages/cli/src/app-inspect.js');
  assert.equal(atParent.ok, false);
  assert.match(/** @type {any} */ (atParent).reason, /symbolic link/);
  assert.match(/** @type {any} */ (atParent).reason, /packages\/cli\/src/);

  // A path that simply is not there is still the caller's `existsSync` case, not
  // a traversal — refusing it here would turn "not present" into a failure.
  assert.equal(resolveSurfacePath(root, 'docs/never-existed.md').ok, true);
});

test('an unsafe generator path is reported instead of followed by the identity check', async (t) => {
  const { root } = frameworkFixture(t);
  const generator = join(root, 'scripts/repo-truth.js');
  rmSync(generator);
  mkdirSync(join(root, 'elsewhere'), { recursive: true });
  symlinkSync(join(root, 'elsewhere'), generator);

  const result = await readAuthorities({ rootDir: root });
  assert.ok(result.problems.some((problem) => problem.code === 'TRUTH_SURFACE_UNSAFE'));
});

test('a string literal that quotes the grammar is not a citation', () => {
  // `CITATION_JS` matched anywhere on a line, so this line inside the one bound
  // `.js` surface produced TRUTH_FACT_UNKNOWN for a citation nobody wrote. A
  // grammar that reads its own examples is not bounded.
  const literal = "const example = '// truth: made.up.fact=nonsense';\n";
  assert.deepEqual(parseCitations(literal, { javascript: true }), []);
  // The real form, on its own line, still parses — indented or not.
  assert.deepEqual(parseCitations('      // truth: billing.implemented=absent\n', { javascript: true }),
    [{ line: 1, id: 'billing.implemented', value: 'absent' }]);
});

test('a truth: directive no rule reads is refused rather than ignored', () => {
  // A typo used to turn a load-bearing citation off with no signal at all:
  // `-> ` matches no pattern, so the line was neither a citation nor an error.
  assert.deepEqual(findMalformedDirectives('// truth: spine.authorization.enforced -> enforced\n',
    { javascript: true }), [{ line: 1, body: 'spine.authorization.enforced -> enforced' }]);
  assert.deepEqual(findMalformedDirectives('<!-- truth: this is not a citation -->\n'),
    [{ line: 1, body: 'this is not a citation' }]);
  // The three legal forms are legal.
  assert.deepEqual(findMalformedDirectives('// truth: billing.implemented=absent\n', { javascript: true }), []);
  assert.deepEqual(findMalformedDirectives(`<!-- truth: retired-code ${RETIRED_CODES[0]} — history -->\n`), []);
  assert.deepEqual(findMalformedDirectives(`<!-- truth: retired-claim ${RETIRED_CLAIMS[0]} — history -->\n`), []);
  // A document quoting the grammar inside a table cell or a sentence is a
  // document. The rule reads own-line directives only, which is why widening it
  // to Markdown did not redden `docs/QUALITY_GATES.md` §6.1.
  assert.deepEqual(findMalformedDirectives('| cites a fact | `<!-- truth: <factId>=<value> -->` | fails |\n'), []);
  assert.deepEqual(findMalformedDirectives('written `// truth: <id>=<value>` in a bound file.\n',
    { javascript: true }), []);
});

// ───────── negative: the retired posture, which citations alone did not catch

test('restoring the retired posture fails, and citations alone never did — PR #101, again', async () => {
  // ADR-039 Amendment 1 records that binding `productionPosture` closed the first
  // of the two failures. It did not. A citation binds a VALUE: reversing one of
  // the nine `// truth:` lines fails, and that is all they prove. Pasting the
  // recorded falsehood into the sentence beneath them and touching nothing else
  // exited 0 — measured on this branch, not reasoned about.
  const source = readFileSync(join(repoRoot, 'packages/cli/src/app-inspect.js'), 'utf8');
  const posture = /productionPosture: '([^']*)'/.exec(source);
  assert.ok(posture, 'productionPosture is no longer a single-quoted string');

  const falsified = source.replace(posture[0], `productionPosture: '${RETIRED_CLAIMS[0]}'`);
  const hits = findRetiredClaims(falsified, { javascript: true });
  assert.equal(hits.length, 1, 'the retired posture in the published string was not caught');
  assert.equal(hits[0].claim, RETIRED_CLAIMS[0]);

  // The citations are untouched by that mutation, which is exactly the point.
  const { document } = await buildTruthDocument({ rootDir: repoRoot });
  const index = new Map(document.facts.map((fact) => [fact.id, fact]));
  assert.deepEqual(checkCitations(parseCitations(falsified, { javascript: true }), index, 'x'), []);

  // A re-wrap and a capitalised sentence start are the same claim.
  assert.equal(findRetiredClaims(`x = 'No authentication,   tenancy or RBAC exists here';\n`,
    { javascript: true }).length, 1);

  // A wording change that keeps the bounded meaning is not this rule's business.
  const reworded = source.replace(posture[0], "productionPosture: 'not a readiness claim: this framework "
    + "verifies no identity itself, and owns and enforces authorization and one-tenant-per-instance tenancy'");
  assert.deepEqual(findRetiredClaims(reworded, { javascript: true }), []);
  assert.deepEqual(checkCitations(parseCitations(reworded, { javascript: true }), index, 'x'), []);
});

test('a retired-claim declaration excuses a comment, never a published string', () => {
  // The retired posture and the paragraph explaining it live in the same file.
  // A file-scoped declaration excused both, so restoring the falsehood went back
  // to passing — the escape has to be narrower than the file it is written in.
  const declaration = `// truth: retired-claim ${RETIRED_CLAIMS[0]} — named as history\n`;
  assert.deepEqual(findRetiredClaims(`${declaration}// once said "${RETIRED_CLAIMS[0]}" (PR #101)\n`,
    { javascript: true }), []);
  const published = findRetiredClaims(`${declaration}  posture: '${RETIRED_CLAIMS[0]}',\n`, { javascript: true });
  assert.equal(published.length, 1);
  assert.equal(published[0].line, 2);
  // Markdown and JSON are prose and data end to end, so there the declaration is
  // file-scoped — the same shape as a retired code's.
  assert.deepEqual(findRetiredClaims(`<!-- truth: retired-claim ${RETIRED_CLAIMS[0]} — history -->\n`
    + `it read "${RETIRED_CLAIMS[0]}" in the same report (PR #101).\n`), []);
  // An undeclared mention in a bound Markdown surface still fails.
  assert.equal(findRetiredClaims(`The framework: ${RETIRED_CLAIMS[0]}.\n`).length, 1);
});

test('a retired claim re-wrapped across a line break is the same claim', () => {
  // Prose re-wraps. A rule whose whole point is to survive re-typing cannot be
  // escaped by a newline, so the claim is read over each line and over each line
  // joined to its successor.
  const wrapped = 'it once said "no authentication, tenancy\nor RBAC exists" in that report.\n';
  assert.deepEqual(findRetiredClaims(wrapped), [{ line: 1, claim: RETIRED_CLAIMS[0] }]);
  assert.deepEqual(findRetiredClaims(`<!-- truth: retired-claim ${RETIRED_CLAIMS[0]} — history -->\n${wrapped}`), []);
});

test('a quoted word=word that is not in a facts array is prose, not a citation', () => {
  // v1 read the JSON form off any line, so an ordinary string in a bound JSON
  // file became a citation nothing could resolve: adding `"note":
  // "mode=production"` to site/claims.json produced TRUTH_FACT_UNKNOWN telling
  // the author to "cite a generated fact or drop the citation" for a string
  // that was never one. The published grammar says `facts` array; so does the
  // parser now.
  assert.deepEqual(parseCitations('{\n  "note": "mode=production"\n}\n'), []);
  assert.deepEqual(parseCitations('{\n  "docs": ["rail.app_inspect.implemented=absent"]\n}\n'), []);
  // A Markdown document carries citations as comments; a quoted a=b in a
  // sentence is a sentence.
  assert.deepEqual(parseCitations('Run it with `"mode=production"` set.\n'), []);
  // The real thing still parses, nested at any depth.
  assert.deepEqual(
    parseCitations('{\n  "a": { "b": [ { "facts": [\n    "billing.implemented=absent"\n  ] } ] }\n}\n'),
    [{ line: 3, id: 'billing.implemented', value: 'absent' }],
  );
});

// ───────────────────────── negative: the canonical regression, written as a rule

test('a retired limitation code standing in a current document fails — the PR #102 regression', () => {
  const vocabulary = harvestCodeVocabulary(repoRoot);
  const basenames = repositoryBasenames(repoRoot);
  assert.deepEqual(RETIRED_CODES, ['TENANT_ISOLATION_NOT_ENFORCED']);
  // The code is *named* in this repository — in the generator, in the ADR, in
  // this very test — and a lexical harvest would happily re-admit it. It must
  // not be in the vocabulary regardless.
  assert.equal(vocabulary.has('TENANT_ISOLATION_NOT_ENFORCED'), false);
  const stale = 'The framework does NOT enforce tenant isolation: TENANT_ISOLATION_NOT_ENFORCED.\n';
  const found = findUnknownCodes(stale, vocabulary, basenames);
  assert.deepEqual(found, [{ line: 1, code: 'TENANT_ISOLATION_NOT_ENFORCED' }]);
});

test('a document may name a retired code only by declaring it, and the declaration does not travel', () => {
  const vocabulary = harvestCodeVocabulary(repoRoot);
  const basenames = repositoryBasenames(repoRoot);
  const declared = '<!-- truth: retired-code TENANT_ISOLATION_NOT_ENFORCED — history, not an assertion -->\n'
    + 'PR #102 removed TENANT_ISOLATION_NOT_ENFORCED.\n';
  assert.deepEqual(findUnknownCodes(declared, vocabulary, basenames), []);
  // The same sentence in a file that did not declare it still fails, which is
  // what makes the escape a per-file, reviewable edit rather than a global one.
  assert.equal(findUnknownCodes('PR #102 removed TENANT_ISOLATION_NOT_ENFORCED.\n', vocabulary, basenames).length, 1);
});

test('a code deleted from the source fails every document still naming it', () => {
  const vocabulary = harvestCodeVocabulary(repoRoot);
  const basenames = repositoryBasenames(repoRoot);
  assert.ok(vocabulary.has('SPINE_VERIFIER_REQUIRED'), 'the fixture code must start out declared');
  const text = 'Production refuses to start: SPINE_VERIFIER_REQUIRED.\n';
  assert.deepEqual(findUnknownCodes(text, vocabulary, basenames), []);
  vocabulary.delete('SPINE_VERIFIER_REQUIRED');
  assert.deepEqual(findUnknownCodes(text, vocabulary, basenames), [{ line: 1, code: 'SPINE_VERIFIER_REQUIRED' }]);
});

test('a file basename is not a machine code, and an undeclared name is one', () => {
  const vocabulary = harvestCodeVocabulary(repoRoot);
  const basenames = repositoryBasenames(repoRoot);
  assert.deepEqual(findUnknownCodes('See docs/QUALITY_GATES.md and PROJECT_STATUS.md.\n', vocabulary, basenames), []);
  // `<ERROR_CODE>` is legal in a bound document because `ERROR_CODE` is declared
  // in source, not because angle brackets excuse anything. Asserting the reason
  // is the point: the v1 version of this line passed with or without the
  // angle-bracket strip, which is how the hole below went unnoticed.
  assert.equal(vocabulary.has('ERROR_CODE'), true);
  assert.deepEqual(findUnknownCodes('The command exits with <ERROR_CODE>.\n', vocabulary, basenames), []);
  assert.deepEqual(
    findUnknownCodes('It exits with NOT_A_REAL_CODE_AT_ALL.\n', vocabulary, basenames),
    [{ line: 1, code: 'NOT_A_REAL_CODE_AT_ALL' }],
  );
});

test('angle brackets do not hide a code — the retired one least of all', () => {
  const vocabulary = harvestCodeVocabulary(repoRoot);
  const basenames = repositoryBasenames(repoRoot);
  // v1 stripped `<[A-Z][A-Z0-9_]*>` before looking for codes, so both of these
  // passed `--check` in README.md and in site/assets/llms.txt, where angle
  // brackets render literally. RETIRED_CODES promises to hold "wherever the
  // mention appears"; four characters must not be able to break that promise.
  assert.deepEqual(
    findUnknownCodes('Tenancy: <TENANT_ISOLATION_NOT_ENFORCED> applies.\n', vocabulary, basenames),
    [{ line: 1, code: 'TENANT_ISOLATION_NOT_ENFORCED' }],
  );
  assert.deepEqual(
    findUnknownCodes('It exits with <SOME_INVENTED_CODE>.\n', vocabulary, basenames),
    [{ line: 1, code: 'SOME_INVENTED_CODE' }],
  );
});

// ─────────────────────────── negative: the generated document itself goes stale

test('a moved fact makes the committed document stale, and the message names what moved', async () => {
  const fresh = await bundle();
  const committed = buildFacts(fresh);
  const moved = await bundle();
  moved.anonymousAllowed = true;
  const regenerated = buildFacts(moved);
  const problems = diffDocuments({ facts: committed.facts }, { facts: regenerated.facts });
  assert.deepEqual(codes(problems), ['TRUTH_DOCUMENT_STALE']);
  problemNaming(problems, 'spine.authorization.enforced: "enforced" → "unknown"');
});

test('a document that dropped a fact is stale too, and says so differently', async () => {
  const built = buildFacts(await bundle());
  const problems = diffDocuments(
    { facts: built.facts },
    { facts: built.facts.filter((fact) => fact.id !== 'rail.scenario_run.implemented') },
  );
  assert.deepEqual(codes(problems), ['TRUTH_DOCUMENT_STALE']);
  problemNaming(problems, 'Facts that no longer exist: rail.scenario_run.implemented');
});

test('a change with no moved value is still stale, and says which kind of change it was', async () => {
  const built = buildFacts(await bundle());
  const evidenceOnly = structuredClone(built);
  evidenceOnly.facts[0].evidence = [...evidenceOnly.facts[0].evidence, 'invented:pointer'];
  const problems = diffDocuments({ facts: built.facts }, { facts: evidenceOnly.facts });
  assert.deepEqual(codes(problems), ['TRUTH_DOCUMENT_STALE']);
  problemNaming(problems, 'No fact value moved');
});

test('a sourceSha-only change says it was sourceSha, and does not blame the evidence', async () => {
  // A comment-only edit to any of the 20 authority sources moves `sourceSha`
  // and nothing else — no fact, no evidence pointer, no limitation, not even
  // the semantic fingerprint. v1 reported "the evidence, the authority list or
  // a limitation did", naming three things that had not moved. Confirmed by
  // appending a comment to packages/core/src/identity.js in a throwaway copy.
  const built = buildFacts(await bundle());
  const body = { facts: built.facts, authorities: built.authorities, sourceSha: 'a'.repeat(64) };
  const problems = diffDocuments(body, { ...body, sourceSha: 'b'.repeat(64) });
  assert.deepEqual(codes(problems), ['TRUTH_DOCUMENT_STALE']);
  problemNaming(problems, 'only sourceSha did');
  assert.doesNotMatch(problems[0].message, /the evidence, the authority list or a limitation/);
});

// ───────────────── negative: absence is never silently turned into a false fact

test('a declared-absence fact whose declaration is gone is refused, never defaulted to absent', async () => {
  const mutated = await bundle();
  mutated.spineNotModeled = [];
  const { facts, problems } = buildFacts(mutated);
  assert.deepEqual(codes(problems), ['TRUTH_AUTHORITY_UNAVAILABLE']);
  for (const id of ['spine.postgresql.implemented', 'spine.durable_jobs.implemented', 'spine.secrets_backups.implemented']) {
    assert.equal(facts.some((fact) => fact.id === id), false, `${id} was published from an absent declaration`);
    problemNaming(problems, id);
  }
});

test('a missing authority source refuses the whole document rather than emitting unknown facts', async (t) => {
  const fixture = frameworkFixture(t);
  fixture.seal();
  rmSync(join(fixture.root, AUTHORITY_SOURCES.find((path) => path.endsWith('identity.js'))));
  const { document, problems } = await buildTruthDocument({ rootDir: fixture.root });
  assert.deepEqual(codes(problems), ['TRUTH_AUTHORITY_UNAVAILABLE']);
  assert.deepEqual(document.facts, [], 'a document was published from an authority set that could not be read');
  problemNaming(problems, 'packages/core/src/identity.js');
});

test('the generator refuses to write when it could not derive the document', async (t) => {
  const fixture = frameworkFixture(t);
  fixture.seal();
  rmSync(join(fixture.root, 'packages/core/src/tenant-storage.js'));
  const run = spawnSync(process.execPath, [join(repoRoot, 'scripts/repo-truth.js')], { cwd: fixture.root, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /TRUTH_AUTHORITY_UNAVAILABLE/);
  assert.match(run.stderr, /refused to write a document it could not derive/);
  assert.equal(existsSync(join(fixture.root, TRUTH_DOCUMENT)), false, 'a document was written despite an unreadable authority');
});

test('a value outside the closed vocabulary is refused rather than published', async () => {
  const mutated = await bundle();
  mutated.identityContract = 'version one';
  const { facts, problems } = buildFacts(mutated);
  assert.ok(codes(problems).includes('TRUTH_AUTHORITY_UNAVAILABLE'));
  assert.equal(facts.some((fact) => fact.id === 'spine.identity.contract'), false);
  problemNaming(problems, 'bounded "contract" literal shape');
});

// ──────────────────────────────── negative: two authorities that cannot agree

test('a rail the dispatcher names but no handler exports publishes neither answer', async () => {
  const mutated = await bundle();
  mutated.rails['rail.app_inspect.implemented'].handler = false;
  const { facts, problems } = buildFacts(mutated);
  assert.deepEqual(codes(problems), ['TRUTH_AUTHORITIES_CONTRADICT']);
  assert.equal(facts.some((fact) => fact.id === 'rail.app_inspect.implemented'), false);
  problemNaming(problems, 'Two authorities');
});

test('a rail whose dispatch line is deleted contradicts its handler, end to end', async (t) => {
  const fixture = frameworkFixture(t);
  fixture.patch('packages/cli/src/commands.js', "command === 'project:doctor'", "command === 'project:doctor-disabled'");
  fixture.seal();
  const { document, problems } = await buildTruthDocument({ rootDir: fixture.root });
  assert.ok(codes(problems).includes('TRUTH_AUTHORITIES_CONTRADICT'));
  assert.equal(document.facts.some((fact) => fact.id === 'rail.project_doctor.implemented'), false);
  problemNaming(problems, 'project-doctor-command.js');
});

test('building the thing SPINE_NOT_MODELED says is absent contradicts the sentence', async () => {
  // The half of the declared-absence rule that v1 did not have. Deleting the
  // sentence already refused the fact; shipping a scheduler and leaving the
  // sentence standing moved nothing at all — a claim outliving the code it
  // describes, which is the failure this contract exists to close.
  for (const [id, resource] of [
    ['spine.durable_jobs.implemented', 'job-run'],
    ['spine.secrets_backups.implemented', 'secret-binding'],
  ]) {
    const mutated = await bundle();
    mutated.composition.resources = [...mutated.composition.resources, resource];
    const { facts, problems } = buildFacts(mutated);
    assert.ok(codes(problems).includes('TRUTH_AUTHORITIES_CONTRADICT'), `${id} published an answer anyway`);
    assert.equal(facts.some((fact) => fact.id === id), false, `${id} stood while its authorities disagreed`);
    problemNaming(problems, resource);
  }
  // And the boundary the fact actually states still holds: follow-up tasks and
  // work tasks exist, a person moves every one of them, and neither is a job.
  const clean = buildFacts(await bundle());
  assert.equal(clean.facts.find((fact) => fact.id === 'spine.durable_jobs.implemented').value, 'absent');
});

test('a package the composition no longer holds contradicts its own factory', async () => {
  const mutated = await bundle();
  mutated.composition.packages = mutated.composition.packages.filter((entry) => entry.name !== 'work');
  const { facts, problems } = buildFacts(mutated);
  assert.deepEqual(codes(problems), ['TRUTH_AUTHORITIES_CONTRADICT']);
  assert.equal(facts.some((fact) => fact.id === 'domain.work.package_native'), false);
  problemNaming(problems, 'packages/work/src/index.js exports a factory');
});

test('a package that stops being package-native reads unknown, not package_native', async () => {
  const mutated = await bundle();
  mutated.composition.packages.find((entry) => entry.name === 'service').packageContract = 99;
  const { facts } = buildFacts(mutated);
  assert.equal(facts.find((fact) => fact.id === 'domain.service.package_native').value, 'unknown');
});

test('a broken composition publishes no package fact and runs no namespace probe', async () => {
  const mutated = await bundle();
  mutated.composition.problems = [{ code: 'PACKAGE_CAPABILITY_MISSING', message: 'a required capability is not provided' }];
  const { facts, problems } = buildFacts(mutated);
  assert.ok(codes(problems).includes('TRUTH_AUTHORITY_UNAVAILABLE'));
  assert.equal(facts.some((fact) => fact.id.startsWith('domain.')), false);
  // A probe over a composition that did not resolve would report every product
  // area absent, so no fact may carry probe evidence at all. `marketing_runtime`
  // has no second authority and disappears entirely; `billing` survives only on
  // its declared journey code, which is a declaration rather than a silence.
  assert.equal(facts.some((fact) => fact.id === 'marketing_runtime.implemented'), false);
  assert.equal(facts.some((fact) => fact.evidence.some((entry) => String(entry).startsWith('namespace-probe:'))), false);
  const billing = facts.find((fact) => fact.id === 'billing.implemented');
  assert.ok(billing.evidence.includes('journey-code:NOTHING_WAS_BILLED_OR_NOTIFIED'));
});

test('the namespace probe can produce the other answer, and a second authority then contradicts it', async () => {
  const mutated = await bundle();
  mutated.composition.resources = [...mutated.composition.resources, 'invoice-run'].sort();
  const { facts, problems } = buildFacts(mutated);
  // The probe itself flipped — a fact that could only ever take one value proves
  // nothing — and the frozen journey registry still declares the boundary, so
  // the two authorities disagree and neither answer stands.
  assert.deepEqual(codes(problems), ['TRUTH_AUTHORITIES_CONTRADICT']);
  problemNaming(problems, 'the reference composition says "implemented"');
  assert.equal(facts.some((fact) => fact.id === 'billing.implemented'), false);
});

test('a journey limitation code that is retired refuses the fact resting on it', async () => {
  const mutated = await bundle();
  mutated.journeyCodes = mutated.journeyCodes.filter((code) => code !== 'THE_PROFILE_IS_A_PROJECTION_NOT_A_TIMELINE');
  const { facts, problems } = buildFacts(mutated);
  assert.ok(codes(problems).includes('TRUTH_AUTHORITY_UNAVAILABLE'));
  assert.equal(facts.some((fact) => fact.id === 'customer_timeline.complete'), false);
  problemNaming(problems, 'THE_PROFILE_IS_A_PROJECTION_NOT_A_TIMELINE');
});

test('a production dependency contradicts the declared PostgreSQL absence', async () => {
  const mutated = await bundle();
  mutated.productionDependencies = ['pg'];
  const { facts, problems } = buildFacts(mutated);
  assert.deepEqual(codes(problems), ['TRUTH_AUTHORITIES_CONTRADICT']);
  assert.equal(facts.some((fact) => fact.id === 'spine.postgresql.implemented'), false);
  problemNaming(problems, 'production dependencies (pg)');
});

// ──────────────────────────── negative: a receipt is verified, never trusted

test('a receipt whose fingerprints do not match its protocol is refused', (t) => {
  const root = disposable(t, 'accordo-truth-receipt-');
  for (const path of [BENCHMARK_PANEL.aggregate, BENCHMARK_PANEL.protocol]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repoRoot, path), join(root, path));
  }
  const honest = [];
  assert.ok(readBenchmarkReceipt(root, honest), 'the unmutated panel must read cleanly');
  assert.deepEqual(honest, []);

  const aggregatePath = join(root, BENCHMARK_PANEL.aggregate);
  const aggregate = JSON.parse(readFileSync(aggregatePath, 'utf8'));
  aggregate.admission.protocolFingerprint = 'f'.repeat(64);
  writeFileSync(aggregatePath, JSON.stringify(aggregate, null, 2));

  const problems = [];
  assert.equal(readBenchmarkReceipt(root, problems), null, 'nothing may be read from a receipt of a different apparatus');
  assert.deepEqual(codes(problems), ['TRUTH_AUTHORITIES_CONTRADICT']);
  problemNaming(problems, 'protocolFingerprint');
});

test('a missing receipt refuses the fact rather than defaulting it', (t) => {
  const root = disposable(t, 'accordo-truth-noreceipt-');
  const problems = [];
  assert.equal(readBenchmarkReceipt(root, problems), null);
  assert.deepEqual(codes(problems), ['TRUTH_AUTHORITY_UNAVAILABLE']);
});

test('a refused receipt publishes no benchmark fact at all', async () => {
  const mutated = await bundle();
  mutated.benchmark = null;
  const { facts } = buildFacts(mutated);
  assert.equal(facts.some((fact) => fact.id.startsWith('benchmark.')), false);
});

// ────────────────────────────── negative: measurement provenance is proven

test('a measured commit that is not an ancestor of HEAD fails TRUTH_MEASUREMENT_NOT_ANCESTOR', (t) => {
  const { root } = measurementRepo(t, { files: { 'site/claims.json': ledger({ sha: '0123456', tests: 1480, testFiles: 131 }) } });
  const problems = [];
  const measurement = readMeasurement(root, problems);
  assert.deepEqual(codes(problems), ['TRUTH_MEASUREMENT_NOT_ANCESTOR']);
  assert.equal(measurement.ancestor, 'false');
  problemNaming(problems, 'Object existence is not provenance');
});

test('a measured commit whose tests tree has moved reads test_tree_current=false and marks the counts stale', (t) => {
  const { root, base } = measurementRepo(t, {
    files: { 'site/claims.json': ledger({ sha: 'placeholder', tests: 1480, testFiles: 131 }) },
    commits: [(dir) => writeFileSync(join(dir, 'tests', 'second.test.js'), '// the corpus moved\n')],
  });
  writeFileSync(join(root, 'site/claims.json'), ledger({ sha: base, tests: 1480, testFiles: 131 }));
  const problems = [];
  const measurement = readMeasurement(root, problems);
  assert.deepEqual(problems, [], 'a truthful record of an older tree is not a failure — it is a stale status');
  assert.equal(measurement.ancestor, 'true');
  assert.equal(measurement.treeCurrent, 'false');

  const built = buildFacts({ ...structuredClone(BLANK_BUNDLE), measurement });
  const facts = new Map(built.facts.map((fact) => [fact.id, fact]));
  assert.equal(facts.get('measurement.test_tree_current').value, 'false');
  assert.equal(facts.get('measurement.source_is_ancestor').value, 'true');
  assert.equal(facts.get('measurement.test_count').status, 'stale');
  assert.equal(facts.get('measurement.source_sha').status, 'stale');
});

test('an unmoved tests tree reads test_tree_current=true and the counts read current', (t) => {
  const { root, base } = measurementRepo(t, { files: { 'site/claims.json': ledger({ sha: 'placeholder', tests: 7, testFiles: 1 }) } });
  writeFileSync(join(root, 'site/claims.json'), ledger({ sha: base, tests: 7, testFiles: 1 }));
  const measurement = readMeasurement(root, []);
  assert.equal(measurement.treeCurrent, 'true');
  const built = buildFacts({ ...structuredClone(BLANK_BUNDLE), measurement });
  const facts = new Map(built.facts.map((fact) => [fact.id, fact]));
  assert.equal(facts.get('measurement.test_tree_current').value, 'true');
  assert.equal(facts.get('measurement.test_count').status, 'current');
  assert.equal(facts.get('measurement.test_count').value, 7);
});

test('a commit that only moves the tests tree does not restate the document', async () => {
  // Found by running the gate on its own branch: `HEAD:tests` was published as
  // evidence, so the commit adding this very file made the committed document
  // stale with no fact value moved. A gate that fails on every green PR gets
  // regenerated without being read, which is a slower way to lose the same
  // truth. The verdict is a fact; the transient hash behind it is not evidence.
  const before = await bundle();
  before.measurement = {
    sha: 'abc1234', tests: 7, testFiles: 1, ancestor: 'true', treeCurrent: 'false',
    measuredTree: 'a'.repeat(40), headTree: 'b'.repeat(40),
  };
  const after = structuredClone(before);
  after.measurement.headTree = 'c'.repeat(40);
  assert.equal(canonical(buildFacts(before).facts), canonical(buildFacts(after).facts));
  assert.deepEqual(diffDocuments({ facts: buildFacts(before).facts }, { facts: buildFacts(after).facts }), []);

  // And the verdict itself is still a fact that can move.
  const moved = structuredClone(before);
  moved.measurement.treeCurrent = 'true';
  assert.notEqual(canonical(buildFacts(before).facts), canonical(buildFacts(moved).facts));
});

test('a tree git cannot speak for refuses the measurement instead of guessing', (t) => {
  const root = disposable(t, 'accordo-truth-nogit-');
  mkdirSync(join(root, 'site'), { recursive: true });
  writeFileSync(join(root, 'site/claims.json'), ledger({ sha: 'e30216c', tests: 1480, testFiles: 131 }));
  // A temporary directory can sit inside somebody's checkout, so the search is
  // stopped at its parent. Without this the test would pass for the wrong
  // reason on one machine and prove nothing on another.
  const ceiling = process.env.GIT_CEILING_DIRECTORIES;
  process.env.GIT_CEILING_DIRECTORIES = dirname(root);
  t.after(() => {
    if (ceiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
    else process.env.GIT_CEILING_DIRECTORIES = ceiling;
  });

  const problems = [];
  const measurement = readMeasurement(root, problems);
  assert.deepEqual(codes(problems), ['TRUTH_MEASUREMENT_UNPROVABLE']);
  assert.equal(measurement.ancestor, 'unknown', 'ancestry was asserted by a tree that cannot prove it');
  assert.equal(measurement.treeCurrent, 'unknown');
  // The counts are carried through untouched, and never promoted to facts a
  // reader could mistake for proven ones.
  assert.equal(measurement.tests, 1480);
  problemNaming(problems, 'A measurement fact that cannot be traced is not a fact');
});

test('a shallow clone refuses the measurement facts rather than flaking on them', (t) => {
  const { root, base } = measurementRepo(t, { files: { 'site/claims.json': ledger({ sha: 'placeholder', tests: 7, testFiles: 1 }) } });
  writeFileSync(join(root, 'site/claims.json'), ledger({ sha: base, tests: 7, testFiles: 1 }));
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'ledger']);

  const shallowParent = disposable(t, 'accordo-truth-shallow-');
  const shallow = join(shallowParent, 'clone');
  // Through the same hardened config as every other git call in this file: a
  // clone forks the auto-gc too, and this directory is removed in `t.after`.
  const cloned = git(shallowParent, ['clone', '-q', '--depth', '1', `file://${root}`, shallow]);
  assert.equal(cloned.status, 0, `git clone --depth 1 failed: ${cloned.stderr}`);
  assert.equal(git(shallow, ['rev-parse', '--is-shallow-repository']).stdout.trim(), 'true');

  const problems = [];
  const measurement = readMeasurement(shallow, problems);
  assert.deepEqual(codes(problems), ['TRUTH_MEASUREMENT_UNPROVABLE']);
  assert.equal(measurement.ancestor, 'unknown');
  assert.equal(measurement.treeCurrent, 'unknown');
  problemNaming(problems, 'fetch-depth: 0');
});

// ─────────────── the whole pipeline: source moves, the documents do not follow

test('a source regression makes the committed document stale AND fails every doc that cited it', async (t) => {
  const fixture = frameworkFixture(t);
  // The exact regression ADR-038 Amendment 2 closed: put `databasePathFor` back
  // on the handle the application holds, so a second tenant is nameable again.
  fixture.patch(
    'packages/core/src/tenant-storage.js',
    '    boundTenantId,\n    root: storage.root,\n    dataPlanePath,',
    '    boundTenantId,\n    root: storage.root,\n    databasePathFor: storage.databasePathFor,\n    dataPlanePath,',
  );
  fixture.copyFrom(TRUTH_DOCUMENT);
  fixture.write('README.md', [
    '# Accordo',
    '',
    '- One tenant per application instance, enforced by the storage binding.',
    '  <!-- truth: spine.tenant.crm_data_plane_enforced=enforced_by_binding -->',
    '',
  ].join('\n'));
  fixture.seal();

  const report = await checkRepository({ rootDir: fixture.root });
  assert.equal(report.ok, false);
  const seen = codes(report.problems);
  assert.ok(seen.includes('TRUTH_DOCUMENT_STALE'), `expected TRUTH_DOCUMENT_STALE, saw ${seen.join(', ')}`);
  assert.ok(seen.includes('TRUTH_FACT_VALUE_STALE'), `expected TRUTH_FACT_VALUE_STALE, saw ${seen.join(', ')}`);
  problemNaming(report.problems, 'spine.tenant.crm_data_plane_enforced: "enforced_by_binding" → "declared_not_enforced"');
  problemNaming(report.problems, 'README.md:4');
  assert.equal(
    report.document.facts.find((fact) => fact.id === 'spine.tenant.crm_data_plane_enforced').value,
    'declared_not_enforced',
    'the generator must be able to produce the value the old code produced, or the fact proves nothing',
  );
});

test('--check exits non-zero and --json reports the problems machine-readably', async (t) => {
  const fixture = frameworkFixture(t);
  fixture.copyFrom(TRUTH_DOCUMENT);
  fixture.write('PRODUCT.md', '<!-- truth: spine.postgresql.implemented=implemented -->\n');
  fixture.seal();
  const run = spawnSync(process.execPath, [join(repoRoot, 'scripts/repo-truth.js'), '--check', '--json'], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout);
  assert.equal(report.repositoryTruthContract, REPOSITORY_TRUTH_CONTRACT);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => problem.code === 'TRUTH_FACT_VALUE_STALE'));
  assert.ok(report.problems.every((problem) => typeof problem.message === 'string' && problem.message.length > 0));
});

test('an unknown flag is refused rather than silently ignored', () => {
  const run = spawnSync(process.execPath, [join(repoRoot, 'scripts/repo-truth.js'), '--apply'], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unknown flag --apply/);
});

// ───────────────────────────────────────── the bound surface set is honest

test('the bound surfaces are current documents, and history is excluded by path', () => {
  const historical = [/^DECISIONS\.md$/, /^docs\/plans\//, /^benchmarks\//, /^docs\/transcripts\//, /^site\/blog\//, /^docs\/editions\//];
  for (const surface of BOUND_SURFACES) {
    for (const rule of historical) {
      assert.doesNotMatch(surface, rule, `${surface} is historical material and must not be bound`);
    }
  }
  // The surfaces the failure actually happened on are bound, with no marker
  // required of the two files this branch is not allowed to edit.
  for (const required of ['README.md', 'PRODUCT.md', 'TASKS.md', 'docs/PROJECT_STATUS.md', 'site/claims.json',
    'docs/benchmarks/CRM_JTBD_MATRIX.md']) {
    assert.ok(BOUND_SURFACES.includes(required), `${required} is not bound`);
  }
  assert.ok(BOUND_SURFACES.some((surface) => surface.startsWith('examples/scenarios/')), 'no scenario document is bound');
});

// ─────────────────────────────── the residual policy over this file's own scratch

test('every throwaway directory is created inside the run-owned scratch root', (t) => {
  // The gate's licence to delete a whole tree is that the tree is one this
  // process made inside a root it owns. If a fixture were made anywhere else,
  // the sweep would either miss it — a leak the gate cannot see — or it would
  // have to match a pattern over os.tmpdir(), which is what makes a sweep
  // reach a concurrent run.
  const root = scratchRoot();
  const fixture = disposable(t, 'accordo-truth-selftest-');
  assert.ok(fixture.startsWith(root + sep), `${scratchClass(fixture)} was created outside the run scratch root`);
  assert.equal(scratchClass(fixture), 'accordo-truth-selftest-');
});

test('the sweep refuses any path outside the run-owned scratch root', () => {
  const root = scratchRoot();
  for (const outside of [tmpdir(), join(tmpdir(), 'accordo-someone-elses-run'), repoRoot, root]) {
    assert.throws(() => removeForProbe(outside), /not inside this run's scratch root/,
      `the guard accepted ${outside === root ? 'the run root itself' : 'a path outside the run root'}`);
  }
});

test('the residual report names classes, never an absolute path', () => {
  const report = describeResidual({
    directories: ['accordo-truth-fixture-'],
    warned: ['accordo-truth-fixture-'],
    programs: ['git'],
  });
  assert.match(report, /accordo-truth-fixture-/);
  assert.match(report, /program classes still inside the run scratch: git/);
  // A CI log is machine-facing and public. The run's absolute path carries the
  // runner's user and directory layout, and tells a reader nothing they needed.
  assert.doesNotMatch(report, /\//, 'the residual report contains a path separator');
  assert.ok(!report.includes(tmpdir()), 'the residual report names the temporary directory');
  assert.ok(!report.includes(scratchRoot()), 'the residual report names the run scratch root');
});

test('two concurrent runs cannot sweep each other — driven, not argued', async () => {
  // `tests/helpers/scratch-concurrency-probe.js`: two processes, each building
  // scratch the way every test here does, each running a FULL sweep of its own
  // while the other is standing, in both orders. A `/tmp` glob passes the
  // "my own scratch is gone" half and fails this one.
  const results = await runConcurrencyProbe();
  for (const result of results) {
    assert.equal(result.code, 0, `concurrency worker ${result.name} failed:\n${result.out}${result.err}`);
    assert.match(result.out, /both rounds clean/);
  }
});

/**
 * A bundle with every source authority already read, used by the measurement
 * tests so they can build the measurement facts without a framework copy.
 */
const BLANK_BUNDLE = Object.freeze({
  sourceSha: '0'.repeat(64),
  problems: [],
  identityContract: 1,
  identityKinds: ['anonymous'],
  spineContract: 2,
  spineNotModeled: [],
  permissions: [],
  roles: [],
  modeEnv: 'ACCORDO_MODE',
  runtimeModes: [],
  tenantStrategy: 'one-tenant-per-instance',
  tenantStorageContract: 1,
  tenantLimitationCodes: [],
  tenantProbe: {},
  verifierRefusal: null,
  anonymousAllowed: false,
  composition: { problems: [{ code: 'PACKAGE_NOT_COMPOSED', message: 'no composition in this bundle' }], packages: [], resources: [], capabilities: [], policies: [] },
  rails: {},
  journeyCodes: [],
  productionDependencies: [],
  benchmark: null,
  measurement: null,
});
