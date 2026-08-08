import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_SCAFFOLD_CONTRACT, applyPackageScaffold, checkPackageName, commitScaffold,
  planPackageScaffold, scaffoldFiles, scaffoldPaths, stagingName,
} from '../packages/cli/src/package-scaffold.js';
import { packageTestCommand } from '../packages/cli/src/package-test-command.js';
import { validatePackageCommand, inspectPackageCommand } from '../packages/cli/src/package-commands.js';
import { fixtureProject } from './helpers/package-test-fixtures.js';

/**
 * `crm package scaffold` — DX3.
 *
 * The command exists so that "start a new domain package" is a known-good
 * starting point rather than a copy-paste of whichever package the author
 * happened to open. These tests hold it to four standards.
 *
 * **It must conform.** Freshly scaffolded output passes `package validate`,
 * `package inspect` and `package test` with no manual edit, and passes them for
 * the honest reason: every check either passes or is `not_applicable` with a
 * reason. A scaffold whose own output fails the conformance kit is worse than
 * no scaffold.
 * **It must invent nothing.** No record, action, policy, capability, provider,
 * Admin section, Solution Plan, MCP tool, module manifest or migration. A guess
 * about a business nobody described is a guess the author must first notice and
 * then delete.
 * **It must be deterministic.** Same name, byte-identical bytes — in another
 * checkout, in a directory containing a space, on a second run.
 * **It must be safe.** Dry-run by default, never an overwrite, never a write
 * outside the project, and never a half-written package.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repoRoot, 'packages/cli/bin/agent-crm.js');

/** Run the CLI as a real process: exit codes are part of the contract. */
function runCli(args, { cwd = repoRoot } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8' });
    return { exitCode: 0, stdout };
  } catch (error) {
    return { exitCode: error.status, stdout: String(error.stdout ?? '') };
  }
}

test('a plan writes nothing and says so', (t) => {
  const root = fixtureProject(t);
  const { plan } = planPackageScaffold({ name: 'field-service', rootDir: root });

  assert.equal(plan.ok, true);
  assert.equal(plan.mode, 'plan');
  assert.equal(plan.packageScaffoldContract, PACKAGE_SCAFFOLD_CONTRACT);
  assert.equal(plan.target, 'packages/field-service');
  assert.deepEqual(plan.files.map((file) => file.relativePath), ['src/index.js', 'README.md']);
  assert.equal(existsSync(join(root, 'packages/field-service')), false);
});

test('an applied scaffold writes exactly two files and nothing else', (t) => {
  const root = fixtureProject(t);
  const before = readdirSync(join(root, 'packages')).sort();
  const result = applyPackageScaffold({ name: 'field-service', rootDir: root });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'applied');
  assert.deepEqual(result.created, ['packages/field-service/README.md', 'packages/field-service/src/index.js']);

  const landed = readdirSync(join(root, 'packages/field-service'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  assert.deepEqual(landed, ['README.md', 'index.js']);

  // The only thing that appeared under packages/ is the package itself: no
  // staging directory survived, and nothing else was touched.
  assert.deepEqual(readdirSync(join(root, 'packages')).sort(), [...before, 'field-service'].sort());
});

test('freshly scaffolded output passes validate, inspect and test with no manual edit', async (t) => {
  const root = fixtureProject(t);
  applyPackageScaffold({ name: 'field-service', rootDir: root });
  const dir = join(root, 'packages/field-service');

  const validated = await validatePackageCommand({ packagePath: dir });
  assert.equal(validated.ok, true, JSON.stringify(validated.problems));
  const inspected = await inspectPackageCommand({ packagePath: dir });
  assert.equal(inspected.ok, true, JSON.stringify(inspected.problems));

  const tested = await packageTestCommand({ packagePath: dir, rootDir: root, capture: true, json: true });
  assert.equal(tested.exitCode, 0, JSON.stringify(tested.report.checks.filter((c) => c.status === 'failed')));
  assert.equal(tested.report.counts.failed, 0);
  // "Only honestly-empty N/A rows": nothing may be skipped, and every check
  // that did not run must name the declaration it would have needed.
  assert.equal(tested.report.counts.skipped, 0);
  assert.ok(tested.report.counts.passed > 0);
  for (const check of tested.report.checks) {
    if (check.status !== 'not_applicable') continue;
    assert.ok(typeof check.reason === 'string' && check.reason.length > 0, `${check.id} is N/A with no reason`);
  }
});

test('the scaffold invents no domain semantics', (t) => {
  const root = fixtureProject(t);
  applyPackageScaffold({ name: 'field-service', rootDir: root });
  const dir = join(root, 'packages/field-service');
  const source = readFileSync(join(dir, 'src/index.js'), 'utf8');

  // Every declaration is present and empty. Present, because an author edits a
  // list they can see; empty, because the alternative is a fabricated record.
  for (const field of ['resources', 'requires', 'capabilities', 'actions', 'policies']) {
    assert.match(source, new RegExp(`${field}: \\[\\]`), `${field} should be declared empty`);
  }
  // No module manifest, so no migration and no record.
  assert.equal(existsSync(join(dir, 'modules')), false);
  // No test, no Admin page, no Solution Plan, no MCP tool, no Skill.
  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile()).map((entry) => entry.name);
  assert.deepEqual(files.sort(), ['README.md', 'index.js']);
});

test('the scaffold composes nothing and opens no database', (t) => {
  const root = fixtureProject(t);
  const composition = join(root, 'packages/domains/generated/index.js');
  const before = readFileSync(composition, 'utf8');
  applyPackageScaffold({ name: 'field-service', rootDir: root });

  assert.equal(readFileSync(composition, 'utf8'), before);
  assert.doesNotMatch(readFileSync(composition, 'utf8'), /field-service/);
  assert.equal(existsSync(join(root, 'data')), false);
});

test('the same request produces byte-identical bytes in two different projects', (t) => {
  // A directory with a space in it, because a scaffold that interpolates a path
  // into its own output would differ here and only here.
  const one = fixtureProject(t);
  const two = fixtureProject(t, { name: 'agent crm scaffold ' });

  const first = planPackageScaffold({ name: 'field-service', rootDir: one });
  const second = planPackageScaffold({ name: 'field-service', rootDir: two });
  assert.equal(first.plan.fingerprint, second.plan.fingerprint);
  assert.deepEqual(first.plan.files, second.plan.files);

  applyPackageScaffold({ name: 'field-service', rootDir: one });
  applyPackageScaffold({ name: 'field-service', rootDir: two });
  for (const file of ['src/index.js', 'README.md']) {
    assert.equal(
      readFileSync(join(one, 'packages/field-service', file), 'utf8'),
      readFileSync(join(two, 'packages/field-service', file), 'utf8'),
      `${file} differs between projects`,
    );
  }
});

test('a plan is stable across repeated calls and carries no clock or randomness', (t) => {
  const root = fixtureProject(t);
  const first = planPackageScaffold({ name: 'field-service', rootDir: root });
  const second = planPackageScaffold({ name: 'field-service', rootDir: root });
  assert.deepEqual(first.plan, second.plan);

  const rendered = JSON.stringify(first.plan);
  assert.doesNotMatch(rendered, /\d{4}-\d{2}-\d{2}T/, 'a timestamp would make the plan undiffable');
  assert.doesNotMatch(rendered, new RegExp(root.replaceAll('\\', '\\\\')), 'no absolute path may reach the plan');
});

test('--into changes the kernel import and the composition line it tells you to paste', () => {
  const nested = scaffoldPaths({ name: 'field-service', into: 'examples/custom-packages' });
  assert.equal(nested.packagePath, 'examples/custom-packages/field-service');
  assert.equal(nested.coreImport, '../../../../packages/core/index.js');

  const [source, readme] = scaffoldFiles({ name: 'field-service', into: 'examples/custom-packages' });
  assert.match(source.content, /from '\.\.\/\.\.\/\.\.\/\.\.\/packages\/core\/index\.js'/);
  assert.match(readme.content, /from '\.\.\/\.\.\/\.\.\/examples\/custom-packages\/field-service\/src\/index\.js'/);
});

test('a package scaffolded into a nested directory still conforms', async (t) => {
  const root = fixtureProject(t);
  mkdirSync(join(root, 'examples/custom-packages'), { recursive: true });
  const result = applyPackageScaffold({ name: 'field-service', rootDir: root, into: 'examples/custom-packages' });
  assert.equal(result.mode, 'applied');

  const tested = await packageTestCommand({
    packagePath: join(root, 'examples/custom-packages/field-service'), rootDir: root, capture: true, json: true,
  });
  assert.equal(tested.exitCode, 0, JSON.stringify(tested.report.checks.filter((c) => c.status === 'failed')));
});

test('an existing target is refused, never overwritten', (t) => {
  const root = fixtureProject(t);
  applyPackageScaffold({ name: 'field-service', rootDir: root });
  const source = join(root, 'packages/field-service/src/index.js');
  writeFileSync(source, '// the author has been working here\n');

  const second = applyPackageScaffold({ name: 'field-service', rootDir: root });
  assert.equal(second.ok, false);
  assert.equal(second.mode, 'refused');
  assert.deepEqual(second.problems.map((p) => p.code), ['TARGET_UNAVAILABLE']);
  assert.equal(readFileSync(source, 'utf8'), '// the author has been working here\n');
});

test('a dangling symlink at the target is refused rather than written through', (t) => {
  const root = fixtureProject(t);
  symlinkSync(join(root, 'nowhere'), join(root, 'packages/field-service'));

  const result = applyPackageScaffold({ name: 'field-service', rootDir: root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map((p) => p.code), ['TARGET_UNAVAILABLE']);
  assert.equal(existsSync(join(root, 'nowhere')), false);
});

test('a parent that leaves the project through a symlink is refused', (t) => {
  const root = fixtureProject(t);
  const outside = fixtureProject(t);
  symlinkSync(outside, join(root, 'escape'));

  const result = applyPackageScaffold({ name: 'field-service', rootDir: root, into: 'escape' });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, 'TARGET_UNAVAILABLE');
  assert.match(result.problems[0].message, /symbolic link/);
  assert.equal(existsSync(join(outside, 'field-service')), false);
});

test('an ancestor symlink is refused even when the target itself does not exist yet', (t) => {
  const root = fixtureProject(t);
  const outside = fixtureProject(t);
  symlinkSync(outside, join(root, 'escape'));

  // The leaf is absent, so a check that only resolved an *existing* parent
  // would let this through and `mkdir -p` would follow the link on the way in.
  const result = applyPackageScaffold({ name: 'field-service', rootDir: root, into: 'escape/deep' });
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, 'TARGET_UNAVAILABLE');
  assert.equal(existsSync(join(outside, 'deep')), false);
});

test('a duplicate identity is not caught here, and the limitation says so', (t) => {
  const root = fixtureProject(t);
  // `contracts` is a real composed package, but its directory is not the target,
  // so the scaffold writes. That is honest rather than clever: reading which
  // names are registered would mean importing the composition, and this command
  // runs no project code. The registry refuses the duplicate at startup.
  const result = applyPackageScaffold({ name: 'contracts', rootDir: root, into: 'examples/custom-packages' });
  assert.equal(result.ok, true);
  assert.ok(result.limitations.some((entry) => entry.code === 'IDENTITY_UNIQUENESS_NOT_CHECKED'));

  // And the directory that *is* the target is still protected.
  const sameDir = applyPackageScaffold({ name: 'contracts', rootDir: root });
  assert.equal(sameDir.ok, false);
  assert.equal(sameDir.problems[0].code, 'TARGET_UNAVAILABLE');
});

test('traversal and absolute targets are refused', (t) => {
  const root = fixtureProject(t);
  for (const into of ['../..', 'packages/../../elsewhere', '/etc']) {
    const result = applyPackageScaffold({ name: 'field-service', rootDir: root, into });
    assert.equal(result.ok, false, `${into} should be refused`);
    assert.equal(result.problems[0].code, 'TARGET_UNAVAILABLE', `${into}: ${result.problems[0].message}`);
  }
  // Nothing about a refusal may echo an absolute path back at the caller.
  const escaped = applyPackageScaffold({ name: 'field-service', rootDir: root, into: '/etc' });
  assert.doesNotMatch(JSON.stringify(escaped), /"\/etc/);
});

test('a name the framework would refuse is refused here, with a suggestion and no write', (t) => {
  const root = fixtureProject(t);
  for (const name of ['Field Service', 'field_service', '../escape', 'field-service/../..', '9lives', '']) {
    const result = applyPackageScaffold({ name, rootDir: root, into: 'packages' });
    assert.equal(result.ok, false, `${JSON.stringify(name)} should be refused`);
    assert.equal(result.problems[0].code, 'PACKAGE_NAME_INVALID');
    assert.equal(result.mode, 'refused');
  }
  assert.deepEqual(
    readdirSync(join(root, 'packages')).filter((entry) => entry.startsWith('.') || entry.includes('ield')),
    [],
  );
});

test('an invalid name is suggested, never silently renamed', () => {
  const checked = checkPackageName('Field Service');
  assert.equal(checked.ok, false);
  assert.equal(checked.suggestion, 'field-service');

  const { plan } = planPackageScaffold({ name: 'Field Service', rootDir: repoRoot });
  // The name in the document is the one that was asked for. An author who reads
  // "field-service" here would believe they got a package they never named.
  assert.equal(plan.name, 'Field Service');
  assert.equal(plan.target, null);
  assert.deepEqual(plan.files, []);
  assert.match(plan.problems[0].message, /"field-service"/);
});

test('a hostile name cannot smuggle content into the generated source', (t) => {
  const root = fixtureProject(t);
  // Every one of these is refused by the name rule before any file is rendered,
  // which is the point: the generated source interpolates the name, so the name
  // must never reach it unvalidated.
  for (const name of ["a'; process.exit(1); //", 'a`${process.env.HOME}`', '__proto__', 'a b', 'a\n*/']) {
    const result = applyPackageScaffold({ name, rootDir: root });
    assert.equal(result.ok, false, `${JSON.stringify(name)} should be refused`);
    assert.equal(result.problems[0].code, 'PACKAGE_NAME_INVALID');
  }
  assert.deepEqual(readdirSync(join(root, 'packages')).filter((entry) => entry.startsWith('.')), []);
});

test('staging left behind by a killed run never blocks the next attempt', (t) => {
  const root = fixtureProject(t);
  const corpse = join(root, 'packages/.scaffold-field-service-deadbeef');
  mkdirSync(corpse, { recursive: true });
  writeFileSync(join(corpse, 'README.md'), 'half written\n');

  // A fixed staging directory would be a lock, and a lock a dead process holds
  // is a lock somebody has to break with `rm -rf`. Staging is unique per run,
  // so the retry simply succeeds.
  const result = applyPackageScaffold({ name: 'field-service', rootDir: root });
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  assert.equal(result.mode, 'applied');
  assert.equal(existsSync(join(root, 'packages/field-service/src/index.js')), true);

  // Reported, and left alone: this command cannot tell a corpse from a live
  // writer, and an age heuristic that guesses wrong deletes somebody's work.
  assert.deepEqual(result.staleStaging, ['packages/.scaffold-field-service-deadbeef']);
  assert.equal(readFileSync(join(corpse, 'README.md'), 'utf8'), 'half written\n');
  assert.ok(result.nextSteps.some((step) => step.includes('.scaffold-field-service-deadbeef')));
});

test('staging is unique per run, so no run can be blocked by or write into another', () => {
  const first = stagingName('field-service');
  const second = stagingName('field-service');
  assert.notEqual(first, second, 'a fixed staging name is a lock a crashed process holds forever');
  for (const value of [first, second]) {
    assert.match(value, /^\.scaffold-field-service-[0-9a-f]{8}$/);
  }
});

test('the commit point refuses every occupied target, including an empty directory', (t) => {
  const root = fixtureProject(t);
  const staged = () => {
    const dir = join(root, stagingName('probe'));
    mkdirSync(dir); writeFileSync(join(dir, 'index.js'), 'x');
    return dir;
  };

  // The rename alone would REPLACE an empty directory on POSIX. The check in
  // front of it is what turns that into a refusal.
  const empty = join(root, 'target-empty');
  mkdirSync(empty);
  assert.deepEqual(commitScaffold(staged(), empty), { ok: false, code: 'TARGET_CLAIMED', error: null });
  assert.deepEqual(readdirSync(empty), [], 'the empty directory must survive untouched');

  const nonEmpty = join(root, 'target-full');
  mkdirSync(nonEmpty); writeFileSync(join(nonEmpty, 'keep.txt'), 'mine\n');
  assert.equal(commitScaffold(staged(), nonEmpty).code, 'TARGET_CLAIMED');
  assert.equal(readFileSync(join(nonEmpty, 'keep.txt'), 'utf8'), 'mine\n');

  const file = join(root, 'target-file');
  writeFileSync(file, 'mine\n');
  assert.equal(commitScaffold(staged(), file).code, 'TARGET_CLAIMED');
  assert.equal(readFileSync(file, 'utf8'), 'mine\n');

  const dangling = join(root, 'target-dangling');
  symlinkSync(join(root, 'nowhere'), dangling);
  assert.equal(commitScaffold(staged(), dangling).code, 'TARGET_CLAIMED');
  assert.equal(existsSync(join(root, 'nowhere')), false);

  // And a free target commits.
  const free = join(root, 'target-free');
  assert.deepEqual(commitScaffold(staged(), free), { ok: true, code: null, error: null });
  assert.deepEqual(readdirSync(free), ['index.js']);
});

test('a successful run leaves no staging behind', (t) => {
  const root = fixtureProject(t);
  const result = applyPackageScaffold({ name: 'field-service', rootDir: root });
  assert.equal(result.ok, true);
  assert.deepEqual(readdirSync(join(root, 'packages')).filter((entry) => entry.startsWith('.scaffold')), []);
  assert.deepEqual(result.staleStaging, []);
});

test('concurrent applies for one target produce exactly one winner and stable losers', async (t) => {
  const root = fixtureProject(t);
  const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((done) => {
    execFile(process.execPath, [cli, 'package', 'scaffold', 'field-service', '--root', root, '--apply', '--json'],
      (error, stdout) => done({ code: error?.code ?? 0, doc: JSON.parse(String(stdout)) }));
  })));

  assert.equal(runs.filter((run) => run.doc.mode === 'applied').length, 1, 'exactly one process may win');
  for (const run of runs) {
    if (run.doc.mode === 'applied') { assert.equal(run.code, 0); continue; }
    assert.equal(run.code, 1);
    // A loser must be told it lost a race, not that the filesystem broke.
    assert.ok(['TARGET_UNAVAILABLE', 'TARGET_CLAIMED'].includes(run.doc.problems[0].code), run.doc.problems[0].code);
  }
  // The winner's package is whole, and nobody left staging behind.
  assert.deepEqual(readdirSync(join(root, 'packages/field-service'), { recursive: true }).sort(),
    ['README.md', 'src', join('src', 'index.js')].sort());
  assert.deepEqual(readdirSync(join(root, 'packages')).filter((entry) => entry.startsWith('.scaffold')), []);
});

test('concurrent applies for different names in one parent all succeed', async (t) => {
  const root = fixtureProject(t);
  const names = ['alpha-domain', 'beta-domain', 'gamma-domain', 'delta-domain'];
  const modes = await Promise.all(names.map((name) => new Promise((done) => {
    execFile(process.execPath, [cli, 'package', 'scaffold', name, '--root', root, '--apply', '--json'],
      (error, stdout) => done(JSON.parse(String(stdout)).mode));
  })));
  assert.deepEqual(modes, ['applied', 'applied', 'applied', 'applied']);
  assert.deepEqual(readdirSync(join(root, 'packages')).filter((entry) => entry.startsWith('.scaffold')), []);
});

test('a target claimed mid-write is refused as a lost race, not as a broken filesystem', (t) => {
  const root = fixtureProject(t);
  applyPackageScaffold({ name: 'field-service', rootDir: root });
  const second = applyPackageScaffold({ name: 'field-service', rootDir: root });
  assert.equal(second.ok, false);
  assert.ok(['TARGET_UNAVAILABLE', 'TARGET_CLAIMED'].includes(second.problems[0].code));
  assert.deepEqual(readdirSync(join(root, 'packages')).filter((entry) => entry.startsWith('.scaffold')), []);
});

test('--apply --dry-run says which flag won, in both views', (t) => {
  const root = fixtureProject(t);
  const json = runCli(['package', 'scaffold', 'field-service', '--root', root, '--apply', '--dry-run', '--json']);
  const doc = JSON.parse(json.stdout);
  // Exit 0 and a plan look identical to exit 0 and an apply if you read only
  // the code, which is exactly how an agent concludes it wrote a package it
  // did not write.
  assert.equal(json.exitCode, 0);
  assert.equal(doc.mode, 'plan');
  assert.match(doc.modeReason, /--dry-run overrode --apply/);
  assert.equal(existsSync(join(root, 'packages/field-service')), false);

  const human = runCli(['package', 'scaffold', 'field-service', '--root', root, '--apply', '--dry-run']);
  assert.match(human.stdout, /NOTHING WAS WRITTEN/);

  // And the plain plan says its own reason rather than borrowing that one.
  const plain = JSON.parse(runCli(['package', 'scaffold', 'field-service', '--root', root, '--json']).stdout);
  assert.match(plain.modeReason, /no --apply was given/);
  assert.match(JSON.parse(runCli(['package', 'scaffold', 'field-service', '--root', root, '--apply', '--json']).stdout).modeReason,
    /--apply was given, and the package was written/);
});

test('the plan names the directories it would create, not only the files', (t) => {
  const root = fixtureProject(t);
  assert.deepEqual(planPackageScaffold({ name: 'field-service', rootDir: root, into: 'a/b/c' }).plan.parentDirectory,
    { path: 'a/b/c', operation: 'create' });
  assert.deepEqual(planPackageScaffold({ name: 'field-service', rootDir: root }).plan.parentDirectory,
    { path: 'packages', operation: 'exists' });
});

test('the fingerprint identifies content, not transient filesystem state', (t) => {
  const root = fixtureProject(t);
  const before = planPackageScaffold({ name: 'field-service', rootDir: root }).plan;
  mkdirSync(join(root, 'packages/.scaffold-field-service-cafebabe'), { recursive: true });
  const after = planPackageScaffold({ name: 'field-service', rootDir: root }).plan;
  assert.equal(before.fingerprint, after.fingerprint, 'a leftover directory is not part of the question asked');
  assert.deepEqual(after.staleStaging, ['packages/.scaffold-field-service-cafebabe']);
});

test('the same request is byte-identical under a different locale, timezone and cwd', (t) => {
  const root = fixtureProject(t);
  const args = ['package', 'scaffold', 'field-service', '--root', root, '--json'];
  const under = (env, cwd) => execFileSync(process.execPath, [cli, ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, ...env } });

  assert.equal(
    under({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC' }, repoRoot),
    under({ LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'Pacific/Kiritimati' }, tmpdir()),
    'a locale-sensitive case fold or a clock would show up here and nowhere else',
  );
});

test('the name rule is the framework validator, and invents nothing of its own', (t) => {
  const root = fixtureProject(t);
  // Whatever `validatePackageDefinition` accepts, the scaffold accepts — a
  // scaffold that refused more than the registry would be inventing a
  // restriction no authority backs, which is how a tool starts disagreeing
  // with the runtime it is supposed to serve.
  for (const name of ['constructor', 'prototype', 'src', 'a-b-c', 'a1']) {
    assert.equal(checkPackageName(name).ok, true, `${name}: the registry accepts this`);
  }
  for (const name of ['__proto__', 'Field', 'a_b', '9lives', '-a', 'a/b', 'a.b', '']) {
    assert.equal(checkPackageName(name).ok, false, `${name}: the registry refuses this`);
  }
  // And a name the registry accepts really does survive the whole chain.
  const result = applyPackageScaffold({ name: 'constructor', rootDir: root });
  assert.equal(result.ok, true);
  assert.match(readFileSync(join(root, 'packages/constructor/src/index.js'), 'utf8'), /name: 'constructor'/);
});

test('the generated package says plainly that it is an empty shell', (t) => {
  const root = fixtureProject(t);
  applyPackageScaffold({ name: 'field-service', rootDir: root });
  const dir = join(root, 'packages/field-service');
  for (const file of ['src/index.js', 'README.md']) {
    const text = readFileSync(join(dir, file), 'utf8');
    assert.match(text, /empty package shell/i, `${file} must not let a reader assume it does something`);
    assert.match(text, /zero business capabilities/i, file);
  }
  // And it points at the one command that can answer what the scaffold cannot.
  assert.match(readFileSync(join(dir, 'README.md'), 'utf8'), /app inspect/);
});

test('the CLI is a dry-run unless --apply, and --dry-run beats --apply', (t) => {
  const root = fixtureProject(t);

  const planned = runCli(['package', 'scaffold', 'field-service', '--root', root, '--json']);
  assert.equal(planned.exitCode, 0);
  assert.equal(JSON.parse(planned.stdout).mode, 'plan');
  assert.equal(existsSync(join(root, 'packages/field-service')), false);

  const both = runCli(['package', 'scaffold', 'field-service', '--root', root, '--apply', '--dry-run', '--json']);
  assert.equal(JSON.parse(both.stdout).mode, 'plan');
  assert.equal(existsSync(join(root, 'packages/field-service')), false);

  const applied = runCli(['package', 'scaffold', 'field-service', '--root', root, '--apply', '--json']);
  assert.equal(applied.exitCode, 0);
  assert.equal(JSON.parse(applied.stdout).mode, 'applied');
  assert.equal(existsSync(join(root, 'packages/field-service/src/index.js')), true);
});

test('the CLI exits 1 on a refusal and 1 with no name at all', (t) => {
  const root = fixtureProject(t);
  const named = runCli(['package', 'scaffold', 'Field Service', '--root', root, '--json']);
  assert.equal(named.exitCode, 1);
  assert.equal(JSON.parse(named.stdout).problems[0].code, 'PACKAGE_NAME_INVALID');

  const unnamed = runCli(['package', 'scaffold', '--root', root, '--json']);
  assert.equal(unnamed.exitCode, 1);
  assert.equal(JSON.parse(unnamed.stdout).problems[0].code, 'PACKAGE_NAME_MISSING');
});

test('every refusal states the limitations, so a reader never has to infer them', (t) => {
  const root = fixtureProject(t);
  const codes = (result) => result.limitations.map((entry) => entry.code).sort();
  const expected = [
    'CONFORMANCE_IS_NOT_CORRECTNESS', 'FINALIZATION_REPLACES_AN_EMPTY_DIRECTORY',
    'IDENTITY_UNIQUENESS_NOT_CHECKED', 'NO_COMPOSITION', 'NO_DATABASE_OR_MIGRATION',
    'NO_DOMAIN_SEMANTICS', 'NO_INSTALL_OR_PUBLISH', 'PLAN_IS_NOT_A_RESERVATION',
  ];
  assert.deepEqual(codes(planPackageScaffold({ name: 'field-service', rootDir: root }).plan), expected);
  assert.deepEqual(codes(applyPackageScaffold({ name: 'field-service', rootDir: root })), expected);
  assert.deepEqual(codes(applyPackageScaffold({ name: 'Field Service', rootDir: root })), expected);
});

test('the scaffolded package is removed by deleting it, and the project still boots', async (t) => {
  const root = fixtureProject(t);
  applyPackageScaffold({ name: 'field-service', rootDir: root });
  // `package test` boots the project twice — once with the package composed and
  // once without — so a green run is itself the proof that removal is clean.
  const tested = await packageTestCommand({
    packagePath: join(root, 'packages/field-service'), rootDir: root, capture: true, json: true,
  });
  const detach = tested.report.checks.find((check) => check.id === 'lifecycle.detach');
  assert.equal(detach.status, 'passed');
});
