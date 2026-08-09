// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROJECT_BOOTSTRAP_CONTRACT, SOURCE_MANIFEST, applyProjectBootstrap, canonicalJson,
  checkProjectName, collectSource, planProjectBootstrap, resolveFrameworkSource, resolveTarget,
} from '../packages/create-accordo/src/project-bootstrap.js';
import { exitCodeFor, parseArguments, render } from '../packages/create-accordo/bin/create-accordo.js';

/**
 * `create-accordo <directory>` — the project bootstrap.
 *
 * The command exists so that "give me an Accordo project" is one deterministic,
 * offline step instead of a copy of somebody's source tree plus a guess at a
 * `package.json`. These tests hold it to four standards.
 *
 * **The output must actually work.** The spine of this file is one test that
 * creates a temporary directory, bootstraps into it, and then runs the *result*:
 * `accordo app inspect --json` must report a valid composition, `accordo project
 * doctor --json` must exit 0 with status `passed`, and the generated project's
 * own declared checks must pass — with no `npm install` and no network.
 * **It must refuse rather than guess.** Never an overwrite, never a merge into a
 * directory somebody is already using, never a silent rename of an invalid name,
 * and never a write outside the target.
 * **It must be deterministic.** Same checkout and same request, byte-identical
 * plan and fingerprint, with nothing on disk until `--apply`.
 * **It must survive hostile input.** `__proto__`, `constructor`, traversal,
 * absolute paths, separators, null bytes, markup, template substitutions,
 * newlines, Unicode separators and oversized strings, through both the project
 * name and the target directory.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const bootstrapBin = join(repoRoot, 'packages/create-accordo/bin/create-accordo.js');
const accordoBin = join(repoRoot, 'packages/cli/bin/accordo.js');

/** Every limitation code the report is allowed to publish. */
const LIMITATION_CODES = [
  'PUBLISHED_PLACEHOLDER_DOES_NOT_SCAFFOLD', 'NO_AUTHENTICATION', 'NO_TENANCY', 'NO_RBAC',
  'SQLITE_ONLY', 'LOCAL_DEVELOPMENT_ONLY', 'NO_DOMAIN_PACKAGES_COMPOSED', 'NO_NETWORK_ACCESS',
  'SOURCE_IS_A_COPY_NOT_A_DEPENDENCY', 'PROVIDERS_ARE_OFFLINE_FIXTURES', 'NO_SCHEDULER_OR_OUTBOX',
  'SOURCE_IS_TRUSTED', 'CONFORMANCE_IS_NOT_CORRECTNESS', 'FINALIZATION_REPLACES_AN_EMPTY_DIRECTORY',
];

/** Every problem code the report is allowed to publish. */
const PROBLEM_CODES = [
  'TARGET_MISSING', 'TARGET_PATH_INVALID', 'TARGET_NOT_A_DIRECTORY', 'TARGET_NOT_EMPTY',
  'TARGET_INSIDE_FRAMEWORK_SOURCE', 'PROJECT_NAME_INVALID', 'FRAMEWORK_SOURCE_UNAVAILABLE',
  'FRAMEWORK_SOURCE_INCOMPLETE', 'SOURCE_NOT_READABLE', 'TARGET_CLAIMED', 'BOOTSTRAP_NOT_WRITTEN',
];

/** A scratch directory outside the repository, removed after the test. */
function scratch(t, prefix = 'accordo-bootstrap-test-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/**
 * Run a real process: exit codes are part of the contract, not decoration.
 *
 * `NODE_TEST_CONTEXT` is stripped because this file is itself running under the
 * test runner, and a child that inherits it believes it is a test *worker* —
 * which is how the generated project's own test run first came back with exit 0
 * and no output at all.
 */
function run(command, args, { cwd = repoRoot } = {}) {
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
  try {
    const stdout = execFileSync(process.execPath, [command, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status ?? -1, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? '') };
  }
}

/** Run the bootstrap and parse its JSON report. */
function bootstrap(args, options = {}) {
  const result = run(bootstrapBin, [...args, '--json'], options);
  return { ...result, report: JSON.parse(result.stdout) };
}

// ---------------------------------------------------------------------------
// The spine: a project from nothing, that then actually runs.
// ---------------------------------------------------------------------------

test('a bootstrapped project boots, inspects, passes the doctor and passes its own checks', async (t) => {
  const workspace = scratch(t);
  const target = join(workspace, 'acme-crm');

  const { exitCode, report } = bootstrap([target, '--apply']);
  assert.equal(exitCode, 0, 'the bootstrap succeeded');
  assert.equal(report.ok, true);
  assert.equal(report.mode, 'applied');
  assert.equal(report.project.name, 'acme-crm');
  assert.equal(report.projectBootstrapContract, PROJECT_BOOTSTRAP_CONTRACT);

  // Every generated file is on disk, and so is the framework it needs to boot.
  for (const file of report.files) {
    assert.equal(existsSync(join(target, file.relativePath)), true, `${file.relativePath} was written`);
  }
  for (const marker of ['packages/core/index.js', 'packages/cli/bin/accordo.js', 'packages/app/src/index.js', 'packages/domains/generated/index.js']) {
    assert.equal(existsSync(join(target, marker)), true, `${marker} was copied`);
  }

  // No install step: the framework has no third-party runtime dependencies, so
  // a project that needed one would be a regression this test must catch.
  const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
  assert.equal(manifest.name, 'acme-crm');
  assert.equal(manifest.dependencies, undefined, 'the generated project has no dependencies to install');
  assert.equal(manifest.private, true, 'a customer application is not something to publish by accident');

  // AX1: the composition is valid, and it is *this* project.
  const inspect = run(accordoBin, ['app', 'inspect', '--json', '--root', target], { cwd: target });
  assert.equal(inspect.exitCode, 0, 'app inspect exits 0 on the generated project');
  const inspection = JSON.parse(inspect.stdout);
  assert.equal(inspection.valid, true);
  assert.deepEqual(inspection.problems, []);
  assert.equal(inspection.application.name, 'acme-crm');
  assert.equal(inspection.packages.length, 0, 'and it composes no domain package, as the report promised');

  // DX1: the project is structurally consistent, with no failures.
  const doctor = run(accordoBin, ['project', 'doctor', '--json', '--root', target], { cwd: target });
  assert.equal(doctor.exitCode, 0, 'project doctor exits 0 on the generated project');
  const health = JSON.parse(doctor.stdout);
  assert.equal(health.status, 'passed');
  assert.equal(health.counts.failed, 0);
  assert.equal(health.counts.warning, 0, 'a project delivered with a warning is a project delivered broken');
  assert.equal(health.project.composition, 'valid');

  // The project's own declared checks, run as the project declares them.
  const check = run(join(target, 'scripts/check.js'), [], { cwd: target });
  assert.equal(check.exitCode, 0, `the project parses — ${check.stderr ?? ''}`);
  assert.match(check.stdout, /Syntax check passed/);
  const tests = run('--test', ['--test-reporter=spec'], { cwd: target });
  assert.equal(tests.exitCode, 0, "the project's own tests pass");
  assert.match(tests.stdout, /pass 3/);
  assert.match(tests.stdout, /fail 0/);
  const smoke = run(join(target, 'scripts/smoke.js'), [], { cwd: target });
  assert.equal(smoke.exitCode, 0, 'the project boots and runs a workflow end to end');
  assert.equal(JSON.parse(smoke.stdout).ok, true);
});

test('the bootstrapped project can then take a package, which is the rung above it', async (t) => {
  const workspace = scratch(t);
  const target = join(workspace, 'ladder-crm');
  assert.equal(bootstrap([target, '--apply']).exitCode, 0);
  const generatedAccordoBin = join(target, 'packages/cli/bin/accordo.js');

  // DX3 inside the project the bootstrap made: the two commands are adjacent
  // rungs, and this is the proof that the lower one lands you on the higher.
  // Use the generated project's own CLI and the relative path its README gives
  // an operator; reaching back into the framework checkout would not prove the
  // vendored result is self-contained.
  const scaffold = run(generatedAccordoBin, ['package', 'scaffold', 'renewals', '--apply', '--json'], { cwd: target });
  assert.equal(scaffold.exitCode, 0);
  assert.equal(existsSync(join(target, 'packages/renewals/src/index.js')), true);

  const conformance = run(generatedAccordoBin, ['package', 'test', 'packages/renewals', '--json'], { cwd: target });
  assert.equal(conformance.exitCode, 0, 'the scaffolded package conforms inside the bootstrapped project');
  assert.equal(JSON.parse(conformance.stdout).counts.failed, 0);
});

// ---------------------------------------------------------------------------
// Determinism, and dry-run by default
// ---------------------------------------------------------------------------

test('a plan writes nothing, and says which flag decided that', (t) => {
  const workspace = scratch(t);
  const target = join(workspace, 'planned');

  const { exitCode, report } = bootstrap([target]);
  assert.equal(exitCode, 0);
  assert.equal(report.mode, 'plan');
  assert.equal(report.modeReason, 'no --apply was given, so nothing was written');
  assert.equal(report.ok, true);
  assert.equal(existsSync(target), false, 'a plan reserves nothing and creates nothing');
  assert.equal(readdirSync(workspace).length, 0, 'not even a staging directory');
});

test('two plans for the same request are byte-identical, and the fingerprint ignores where it would go', (t) => {
  const workspace = scratch(t);
  const first = planProjectBootstrap({ directory: join(workspace, 'a', 'same-name'), cwd: workspace }).report;
  const second = planProjectBootstrap({ directory: join(workspace, 'b', 'same-name'), cwd: workspace }).report;

  assert.equal(first.fingerprint, second.fingerprint, 'the fingerprint identifies the project, not the path');
  assert.equal(first.source.fingerprint, second.source.fingerprint);
  assert.equal(
    canonicalJson({ ...first, project: { ...first.project, directory: null } }),
    canonicalJson({ ...second, project: { ...second.project, directory: null } }),
    'everything except the echoed directory is identical',
  );

  const different = planProjectBootstrap({ directory: join(workspace, 'other-name'), cwd: workspace }).report;
  assert.notEqual(first.fingerprint, different.fingerprint, 'a different project is a different fingerprint');
});

test('the source inventory excludes the bootstrapper, the state and the repository’s own scaffolding', (t) => {
  const workspace = scratch(t);
  const target = join(workspace, 'excluded-crm');
  assert.equal(bootstrap([target, '--apply']).exitCode, 0);

  assert.equal(existsSync(join(target, 'packages/create-accordo')), false, 'a project is not a bootstrapper');
  for (const absent of ['node_modules', '.git', 'docs', 'site', 'benchmarks', 'ARCHITECTURE.md', 'DECISIONS.md', 'CLAUDE.md', 'TASKS.md']) {
    assert.equal(existsSync(join(target, absent)), false, `${absent} does not belong to a customer's project`);
  }
  // The project has tests — its own, written by the bootstrap, not this
  // repository's 40-odd suites copied across.
  assert.deepEqual(readdirSync(join(target, 'tests')), ['project.test.js']);
  // docs/SKILL_PACKAGING.md decides that no repository Markdown ships; what the
  // project gets instead is documentation the bootstrap wrote for it.
  assert.equal(existsSync(join(target, 'README.md')), true);
  assert.equal(existsSync(join(target, 'AGENTS.md')), true);
  assert.equal(existsSync(join(target, 'skills')), true, 'the published, tier-declared skill bundle does ship');

  const { files } = collectSource(repoRoot);
  assert.equal(files.some((file) => file.path.startsWith('packages/create-accordo/')), false);
  assert.equal(files.some((file) => file.path.includes('node_modules')), false);
  assert.deepEqual([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((file) => file.path), files.map((file) => file.path),
    'the inventory is sorted, so the fingerprint does not depend on readdir order');
  for (const entry of SOURCE_MANIFEST) {
    assert.equal(files.some((file) => file.path.startsWith(`${entry.path}/`)), true, `${entry.path} contributed files`);
  }
});

test('a symbolic link in the source is refused, never followed out of the manifest', (t) => {
  const workspace = scratch(t);
  const fake = join(workspace, 'framework');
  for (const marker of ['packages/core/index.js', 'packages/cli/bin/accordo.js', 'packages/app/src/index.js', 'packages/domains/generated/index.js']) {
    mkdirSync(join(fake, dirname(marker)), { recursive: true });
    writeFileSync(join(fake, marker), '// marker\n');
  }
  for (const directory of ['apps', 'skills', 'examples/modules']) mkdirSync(join(fake, directory), { recursive: true });
  const secret = join(workspace, 'outside.txt');
  writeFileSync(secret, 'not part of the manifest');
  symlinkSync(secret, join(fake, 'apps', 'link.txt'));

  const { files, problems } = collectSource(fake);
  assert.equal(files.some((file) => file.path.endsWith('link.txt')), false, 'the link is not copied');
  assert.equal(problems.some((problem) => problem.code === 'SOURCE_NOT_READABLE'), true, 'and it is reported rather than skipped in silence');
});

// ---------------------------------------------------------------------------
// Refusals — every boundary, with the code it publishes
// ---------------------------------------------------------------------------

test('no target directory is an environment refusal, not a crash', () => {
  const { exitCode, report } = bootstrap([]);
  assert.equal(exitCode, 2);
  assert.equal(report.ok, false);
  assert.equal(report.problems.some((problem) => problem.code === 'TARGET_MISSING'), true);
});

test('a non-empty target is refused, and nothing in it is touched', (t) => {
  const workspace = scratch(t);
  const target = join(workspace, 'occupied');
  mkdirSync(target);
  writeFileSync(join(target, 'notes.md'), 'somebody is already working here');

  const { exitCode, report } = bootstrap([target, '--apply']);
  assert.equal(exitCode, 1);
  assert.equal(report.mode, 'refused');
  assert.equal(report.problems.some((problem) => problem.code === 'TARGET_NOT_EMPTY'), true);
  assert.deepEqual(readdirSync(target), ['notes.md'], 'the directory is exactly as it was');
  assert.equal(readFileSync(join(target, 'notes.md'), 'utf8'), 'somebody is already working here');
});

test('a target that is a file, or a symlink, is refused rather than written through', (t) => {
  const workspace = scratch(t);
  const file = join(workspace, 'a-file');
  writeFileSync(file, 'content');
  const dangling = join(workspace, 'a-link');
  symlinkSync(join(workspace, 'nowhere'), dangling);

  for (const target of [file, dangling]) {
    const { exitCode, report } = bootstrap([target, '--apply']);
    assert.equal(exitCode, 1);
    assert.equal(report.problems.some((problem) => problem.code === 'TARGET_NOT_A_DIRECTORY'), true, `${target} is refused`);
  }
  assert.equal(readFileSync(file, 'utf8'), 'content', 'the file is untouched');
  assert.equal(existsSync(join(workspace, 'nowhere')), false, 'and nothing was written through the dangling link');
});

test('the framework may not be bootstrapped onto itself, in either direction', (t) => {
  const workspace = scratch(t);
  for (const target of [repoRoot, join(repoRoot, 'packages', 'nested-project'), dirname(repoRoot)]) {
    const { exitCode, report } = bootstrap([target, '--apply']);
    assert.equal(exitCode, 1, `${target} is refused`);
    assert.equal(report.problems.some((problem) => problem.code === 'TARGET_INSIDE_FRAMEWORK_SOURCE'), true);
  }
  assert.equal(existsSync(join(repoRoot, 'packages', 'nested-project')), false);
  // The check is about overlap, not about being inconvenient: an unrelated
  // directory beside the repository is still fine.
  assert.equal(planProjectBootstrap({ directory: join(workspace, 'fine'), cwd: workspace }).report.ok, true);
});

test('a symlinked target ancestor cannot bypass the framework-source boundary', (t) => {
  const workspace = scratch(t);
  const source = join(workspace, 'framework');
  for (const marker of ['packages/core/index.js', 'packages/cli/bin/accordo.js', 'packages/app/src/index.js', 'packages/domains/generated/index.js']) {
    mkdirSync(join(source, dirname(marker)), { recursive: true });
    writeFileSync(join(source, marker), '// marker\n');
  }
  for (const directory of ['skills', 'examples/modules']) {
    mkdirSync(join(source, directory), { recursive: true });
    writeFileSync(join(source, directory, 'fixture.js'), '// fixture\n');
  }

  const outside = join(workspace, 'outside');
  mkdirSync(outside);
  symlinkSync(join(source, 'packages'), join(outside, 'linked-parent'));
  const escapedTarget = join(outside, 'linked-parent', 'escaped-project');

  const plan = planProjectBootstrap({
    directory: escapedTarget,
    name: 'escaped-project',
    cwd: outside,
    sourceRoot: source,
  }).report;
  assert.equal(plan.ok, false);
  assert.equal(plan.problems.some((problem) => problem.code === 'TARGET_INSIDE_FRAMEWORK_SOURCE'), true);

  const applied = applyProjectBootstrap({
    directory: escapedTarget,
    name: 'escaped-project',
    cwd: outside,
    sourceRoot: source,
  });
  assert.equal(applied.ok, false);
  assert.equal(existsSync(join(source, 'packages', 'escaped-project')), false,
    'nothing is written inside the source through the symlinked ancestor');
});

test('a second bootstrap into the same directory is refused, because the first one is there', (t) => {
  const workspace = scratch(t);
  const target = join(workspace, 'once-only');
  assert.equal(bootstrap([target, '--apply']).exitCode, 0);
  const before = readdirSync(target).sort();

  const second = bootstrap([target, '--apply']);
  assert.equal(second.exitCode, 1);
  assert.equal(second.report.problems.some((problem) => problem.code === 'TARGET_NOT_EMPTY'), true);
  assert.deepEqual(readdirSync(target).sort(), before, 'the first project is untouched');
});

test('an unwritable parent is an environment failure that leaves nothing behind', (t) => {
  const workspace = scratch(t);
  // An ordinary file where a directory would have to be: `mkdir -p` cannot pass
  // through it, so the write fails before anything is staged.
  writeFileSync(join(workspace, 'blocked'), 'a file, not a directory');
  const { exitCode, report } = bootstrap([join(workspace, 'blocked', 'deep', 'project'), '--apply']);

  assert.equal(exitCode, 2);
  assert.equal(report.mode, 'refused');
  assert.equal(report.problems.some((problem) => problem.code === 'BOOTSTRAP_NOT_WRITTEN'), true);
  assert.deepEqual(readdirSync(workspace).sort(), ['blocked'], 'no staging directory survived');
  assert.equal(readFileSync(join(workspace, 'blocked'), 'utf8'), 'a file, not a directory');
});

test('with no framework beside it — the published placeholder’s state — it reports and exits 2', (t) => {
  const workspace = scratch(t);
  // Exactly what an empty `create-accordo` tarball looks like on disk: the
  // command, and no framework anywhere above it.
  cpSync(join(repoRoot, 'packages/create-accordo'), join(workspace, 'create-accordo'), { recursive: true });
  const isolated = join(workspace, 'create-accordo/bin/create-accordo.js');

  const result = run(isolated, [join(workspace, 'anything'), '--apply', '--json'], { cwd: workspace });
  assert.equal(result.exitCode, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.source.resolved, false);
  assert.equal(report.problems.some((problem) => problem.code === 'FRAMEWORK_SOURCE_UNAVAILABLE'), true);
  assert.match(
    report.problems.find((problem) => problem.code === 'FRAMEWORK_SOURCE_UNAVAILABLE').message,
    /empty name reservation/,
    'and it says why, in the words the registry state deserves',
  );
  assert.equal(existsSync(join(workspace, 'anything')), false);
});

test('an incomplete framework source is named, not half-copied', (t) => {
  const workspace = scratch(t);
  const fake = join(workspace, 'framework');
  for (const marker of ['packages/core/index.js', 'packages/cli/bin/accordo.js', 'packages/app/src/index.js', 'packages/domains/generated/index.js']) {
    mkdirSync(join(fake, dirname(marker)), { recursive: true });
    writeFileSync(join(fake, marker), '// marker\n');
  }
  // `apps/`, `skills/` and `examples/modules/` are missing.
  const report = applyProjectBootstrap({ directory: join(workspace, 'partial'), cwd: workspace, sourceRoot: fake });
  assert.equal(report.ok, false);
  const incomplete = report.problems.filter((problem) => problem.code === 'FRAMEWORK_SOURCE_INCOMPLETE');
  assert.equal(incomplete.length, 3, 'each missing manifest entry is its own finding');
  assert.equal(existsSync(join(workspace, 'partial')), false);
});

test('the CLI refuses a malformed invocation rather than guessing what was meant', () => {
  for (const argv of [['--nope'], ['-x'], ['a', 'b'], ['--name']]) {
    const result = run(bootstrapBin, argv, { cwd: repoRoot });
    assert.equal(result.exitCode, 2, `${argv.join(' ')} is refused`);
  }
  // A flag is never adopted as the value of `--name`.
  assert.equal(parseArguments(['dir', '--name', '--apply']).error, '--name needs a value');
  assert.equal(parseArguments(['dir', '--name=my-crm']).name, 'my-crm');
  assert.deepEqual(
    { ...parseArguments(['my-crm', '--apply', '--json']) },
    { directory: 'my-crm', name: null, apply: true, json: true, help: false, error: null },
  );
});

// ---------------------------------------------------------------------------
// Names: refused with a suggestion, never renamed
// ---------------------------------------------------------------------------

test('an invalid name is refused with a suggestion, and the suggestion is never applied', (t) => {
  const workspace = scratch(t);
  const target = join(workspace, 'My CRM');

  const { exitCode, report } = bootstrap([target, '--apply']);
  assert.equal(exitCode, 1);
  assert.equal(report.project.name, null, 'nothing was renamed on the caller’s behalf');
  const problem = report.problems.find((entry) => entry.code === 'PROJECT_NAME_INVALID');
  assert.ok(problem, 'the refusal names the rule');
  assert.match(problem.message, /uppercase/);
  assert.match(problem.message, /"my-crm"/, 'and offers the canonical form to ask for explicitly');
  assert.equal(existsSync(target), false);

  // Asking for it explicitly is the caller's act, and then it works.
  const named = bootstrap([target, '--name', 'my-crm', '--apply']);
  assert.equal(named.exitCode, 0);
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name, 'my-crm');
});

test('npm package-name rules are enforced offline, with no registry lookup', () => {
  for (const valid of ['my-crm', 'crm', 'a', 'acme.crm', 'crm_2', 'x'.repeat(214)]) {
    assert.equal(checkProjectName(valid).ok, true, `${valid.slice(0, 20)} is a valid npm name`);
  }
  for (const invalid of [
    '', ' ', 'My-CRM', '.hidden', '_leading', 'has space', 'a/b', 'a\\b', 'a..b', '-leading',
    'x'.repeat(215), 'node_modules', 'favicon.ico', 'fs', 'crypto', '__proto__', 'constructor', 'prototype',
  ]) {
    assert.equal(checkProjectName(invalid).ok, false, `${JSON.stringify(invalid.slice(0, 20))} is refused`);
  }
  // A suggestion is only offered when it is itself acceptable — the invariant
  // that matters, asserted over every refusal above rather than case by case.
  assert.equal(checkProjectName('My CRM').suggestion, 'my-crm');
  assert.equal(checkProjectName('---').suggestion, null, 'a name with nothing usable in it gets no suggestion');
  assert.equal(checkProjectName('__proto__').suggestion, 'proto');
  for (const invalid of [
    '', ' ', 'My-CRM', '.hidden', '_leading', 'has space', 'a/b', 'a\\b', 'a..b', '-leading', '..', '.',
    'x'.repeat(215), 'node_modules', 'favicon.ico', 'fs', '__proto__', 'constructor', 'prototype',
    '<script>', '${x}', '`id`', 'a b', 'ünicode', '---', '...',
  ]) {
    const { suggestion } = checkProjectName(invalid);
    if (suggestion === null) continue;
    assert.equal(checkProjectName(suggestion).ok, true,
      `the suggestion for ${JSON.stringify(invalid.slice(0, 20))} is itself a name this command accepts`);
  }
});

// ---------------------------------------------------------------------------
// Hostile input, through both the name and the target
// ---------------------------------------------------------------------------

test('hostile project names are refused, write nothing and pollute nothing', (t) => {
  const workspace = scratch(t);
  const hostile = [
    '__proto__', 'constructor', 'prototype', '../escape', '../../etc/passwd', '/absolute',
    'C:\\windows', 'a\u0000b', '<script>alert(1)</script>', '`id`', '${process.env.HOME}',
    "'; DROP TABLE companies; --", 'line\nbreak', 'sep\u2028arator', 'nbsp\u00a0space',
    'a'.repeat(300), '"quoted"', 'Ünicode', '.', '..', './relative',
  ];

  for (const [index, name] of hostile.entries()) {
    const target = join(workspace, `hostile-${index}`);
    const report = applyProjectBootstrap({ directory: target, name, cwd: workspace });
    assert.equal(report.ok, false, `${JSON.stringify(name.slice(0, 24))} is refused`);
    assert.equal(report.mode, 'refused');
    assert.equal(report.problems.some((problem) => problem.code === 'PROJECT_NAME_INVALID'), true);
    assert.equal(report.project.name, null, 'and no such name reaches the generated manifest');
    assert.equal(existsSync(target), false, 'and nothing is written');
  }

  // The names above include the three that matter for pollution. Nothing they
  // touched has been added to the prototype chain.
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  assert.equal(/** @type {any} */ (Object.prototype).polluted, undefined);
  assert.equal({}.constructor, Object);
  assert.equal(readdirSync(workspace).length, 0, 'not one hostile name created a directory');
});

test('hostile target paths are refused or contained, and never escape the target', (t) => {
  const workspace = scratch(t);

  // A null byte or a control character in the path is refused outright.
  for (const directory of ['with\u0000null', 'with\u0007bell', 'with\u001bescape', '', '   ']) {
    const report = applyProjectBootstrap({ directory, cwd: workspace });
    assert.equal(report.ok, false, `${JSON.stringify(directory)} is refused`);
    assert.equal(
      report.problems.some((problem) => ['TARGET_PATH_INVALID', 'TARGET_MISSING', 'PROJECT_NAME_INVALID'].includes(problem.code)),
      true,
    );
  }

  // A traversing relative path is legitimate — it is the caller's own machine —
  // but everything written still lands under the one resolved target, and the
  // name is still derived from the basename rather than from the traversal.
  const nested = join(workspace, 'a', 'b');
  mkdirSync(nested, { recursive: true });
  const report = applyProjectBootstrap({ directory: '../../escaped-crm', cwd: nested });
  assert.equal(report.ok, true);
  assert.equal(report.project.name, 'escaped-crm');
  assert.equal(existsSync(join(workspace, 'escaped-crm/package.json')), true, 'it resolved where the caller pointed');
  assert.equal(existsSync(join(workspace, 'a', 'escaped-crm')), false, 'and nowhere else');
  assert.equal(readdirSync(nested).length, 0, 'the directory it was run from is untouched');
});

test('a hostile but valid name is echoed exactly and never becomes markup or a template', (t) => {
  const workspace = scratch(t);
  // Every character npm permits is inert here: the name is JSON data and a
  // Markdown heading, never code and never a path.
  const name = 'a.b_c-d.2';
  const target = join(workspace, 'echoed');
  const report = applyProjectBootstrap({ directory: target, name, cwd: workspace });

  assert.equal(report.ok, true);
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name, name);
  const readme = readFileSync(join(target, 'README.md'), 'utf8');
  assert.match(readme, /^# a\.b_c-d\.2$/m);
  assert.equal(readme.includes('${'), false, 'no unresolved template substitution reached the output');
  const test = readFileSync(join(target, 'tests/project.test.js'), 'utf8');
  assert.equal(test.includes('${'), false);
  assert.match(test, /a\.b_c-d\.2-test-/);
});

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

test('the machine-readable contract is stable, and its vocabulary is closed', (t) => {
  const workspace = scratch(t);
  const { report } = bootstrap([join(workspace, 'contract-crm')]);

  assert.deepEqual(Object.keys(report).sort(), [
    'checks', 'command', 'files', 'fingerprint', 'limitations', 'mode', 'modeReason', 'nextSteps',
    'ok', 'problems', 'project', 'projectBootstrapContract', 'source',
  ]);
  assert.equal(report.projectBootstrapContract, 1);
  assert.equal(report.command, 'project:bootstrap');
  assert.deepEqual(Object.keys(report.project).sort(), [
    'composedPackages', 'databaseBackend', 'directory', 'kind', 'name', 'productionPosture',
  ]);
  assert.deepEqual(Object.keys(report.source).sort(), ['bytes', 'excluded', 'files', 'fingerprint', 'manifest', 'resolved']);
  assert.deepEqual(report.limitations.map((entry) => entry.code), LIMITATION_CODES);
  for (const limitation of report.limitations) {
    assert.equal(typeof limitation.message, 'string');
    assert.ok(limitation.message.length > 30, `${limitation.code} explains itself`);
  }

  // The two claims that must never quietly drift.
  const published = report.limitations.find((entry) => entry.code === 'PUBLISHED_PLACEHOLDER_DOES_NOT_SCAFFOLD');
  assert.match(published.message, /npm registry is an empty name reservation/);
  assert.match(published.message, /until a human publishes/);
  assert.match(report.project.productionPosture, /no authentication, tenancy or RBAC/);
  assert.deepEqual(report.project.composedPackages, []);
});

test('every problem this command can publish comes from the declared vocabulary', (t) => {
  const workspace = scratch(t);
  writeFileSync(join(workspace, 'file'), 'x');
  mkdirSync(join(workspace, 'full'));
  writeFileSync(join(workspace, 'full/x'), 'x');

  const seen = new Set();
  const runs = [
    applyProjectBootstrap({ directory: undefined, cwd: workspace }),
    applyProjectBootstrap({ directory: 'Bad Name', cwd: workspace }),
    applyProjectBootstrap({ directory: join(workspace, 'file'), cwd: workspace }),
    applyProjectBootstrap({ directory: join(workspace, 'full'), cwd: workspace }),
    applyProjectBootstrap({ directory: repoRoot, cwd: workspace }),
    applyProjectBootstrap({ directory: join(workspace, 'x'), cwd: workspace, sourceRoot: null }),
    applyProjectBootstrap({ directory: 'nul\u0000l', cwd: workspace }),
    applyProjectBootstrap({ directory: join(workspace, 'file', 'deep'), cwd: workspace }),
  ];
  for (const report of runs) {
    assert.equal(report.ok, false);
    for (const problem of report.problems) {
      assert.equal(PROBLEM_CODES.includes(problem.code), true, `${problem.code} is declared`);
      assert.equal(typeof problem.message, 'string');
      assert.equal(problem.message.includes(workspace), false, 'a refusal does not paste the operator’s temp path back');
      seen.add(problem.code);
    }
  }
  assert.deepEqual([...seen].sort(), [
    'BOOTSTRAP_NOT_WRITTEN', 'FRAMEWORK_SOURCE_UNAVAILABLE', 'PROJECT_NAME_INVALID',
    'TARGET_INSIDE_FRAMEWORK_SOURCE', 'TARGET_MISSING', 'TARGET_NOT_A_DIRECTORY',
    'TARGET_NOT_EMPTY', 'TARGET_PATH_INVALID',
  ]);
});

test('the text view leads with the refusal, not with files that were never written', (t) => {
  const workspace = scratch(t);
  writeFileSync(join(workspace, 'in-the-way'), 'x');
  const refused = applyProjectBootstrap({ directory: join(workspace, 'in-the-way'), cwd: workspace });
  const text = render(refused);

  assert.ok(
    text.indexOf('Refused — nothing was written') < text.indexOf('Files it would generate'),
    'a reader whose bootstrap was refused is told why before being shown a file list',
  );
  assert.match(text, /\[TARGET_NOT_A_DIRECTORY\]/);
  assert.equal(text.includes('Generated files'), false, 'nothing was generated, so nothing says it was');

  // And the successful plan says plainly that it wrote nothing.
  const planned = render(planProjectBootstrap({ directory: join(workspace, 'fine'), cwd: workspace }).report);
  assert.match(planned, /Files it would generate \(10\)/);
  assert.match(planned, /Re-run with --apply/);
  assert.equal(planned.includes('Refused'), false);

  // Both views end with the limitations, so the text reader gets them too.
  for (const view of [text, planned]) {
    assert.match(view, /What this project is not/);
    assert.match(view, /\[PUBLISHED_PLACEHOLDER_DOES_NOT_SCAFFOLD\]/);
  }
});

test('exit codes separate "you asked for something I refuse" from "this machine cannot answer"', () => {
  assert.equal(exitCodeFor({ ok: true, problems: [] }), 0);
  assert.equal(exitCodeFor({ ok: false, problems: [{ code: 'TARGET_NOT_EMPTY' }] }), 1);
  assert.equal(exitCodeFor({ ok: false, problems: [{ code: 'PROJECT_NAME_INVALID' }] }), 1);
  assert.equal(exitCodeFor({ ok: false, problems: [{ code: 'FRAMEWORK_SOURCE_UNAVAILABLE' }] }), 2);
  assert.equal(exitCodeFor({ ok: false, problems: [{ code: 'TARGET_MISSING' }] }), 2);
  assert.equal(exitCodeFor({ ok: false, problems: [{ code: 'TARGET_NOT_EMPTY' }, { code: 'BOOTSTRAP_NOT_WRITTEN' }] }), 2,
    'an environment failure anywhere in the report wins');
});

test('the framework source resolves from the command’s own location, and stops at the filesystem root', () => {
  assert.equal(resolveFrameworkSource(), repoRoot.replace(/\/$/, ''));
  assert.equal(resolveFrameworkSource(join(repoRoot, 'packages/create-accordo/src')), repoRoot.replace(/\/$/, ''));
  assert.equal(resolveFrameworkSource(tmpdir()), null, 'a directory with no framework above it answers null, not a guess');
});

test('a directory you created yourself and left empty is a legitimate target', (t) => {
  // `mkdir my-crm && create-accordo my-crm --apply` is an ordinary thing to do,
  // and it is the case that a non-recursive `rm` before the commit rename turned
  // into BOOTSTRAP_NOT_WRITTEN. Regression: the commit removes an *empty*
  // directory with rmdir, which refuses anything else.
  const workspace = scratch(t);
  const target = join(workspace, 'premade-crm');
  mkdirSync(target);

  const { exitCode, report } = bootstrap([target, '--apply']);
  assert.equal(exitCode, 0, `an empty pre-made directory is written into — ${JSON.stringify(report.problems)}`);
  assert.equal(report.mode, 'applied');
  assert.equal(existsSync(join(target, 'package.json')), true);
  assert.equal(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).name, 'premade-crm');
  assert.deepEqual(readdirSync(workspace), ['premade-crm'], 'and no staging directory is left beside it');
});

test('the project name is derived against the caller’s directory, not this process’s', (t) => {
  const workspace = scratch(t);
  const inner = join(workspace, 'inner-crm');
  mkdirSync(inner);

  // `.` means "the directory the caller is in", which is not the directory this
  // test process is in. Deriving the name with resolve(directory) alone read
  // process.cwd() and would have named the project after the repository.
  assert.equal(planProjectBootstrap({ directory: '.', cwd: inner }).report.project.name, 'inner-crm');
  assert.equal(planProjectBootstrap({ directory: '../inner-crm', cwd: inner }).report.project.name, 'inner-crm');
  assert.equal(planProjectBootstrap({ directory: 'deeper', cwd: inner }).report.project.name, 'deeper');
});

test('resolveTarget is the single place a target is judged', (t) => {
  const workspace = scratch(t);
  assert.equal(resolveTarget({ directory: join(workspace, 'new'), cwd: workspace, sourceRoot: repoRoot }).ok, true);
  assert.equal(resolveTarget({ directory: null, cwd: workspace, sourceRoot: repoRoot }).code, 'TARGET_MISSING');
  assert.equal(resolveTarget({ directory: 42, cwd: workspace, sourceRoot: repoRoot }).code, 'TARGET_MISSING');
  // An empty directory is a legitimate target: it has nothing to lose.
  mkdirSync(join(workspace, 'empty'));
  assert.equal(resolveTarget({ directory: join(workspace, 'empty'), cwd: workspace, sourceRoot: repoRoot }).ok, true);
});
