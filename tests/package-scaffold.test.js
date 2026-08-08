import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_SCAFFOLD_CONTRACT, applyPackageScaffold, checkPackageName, planPackageScaffold,
  scaffoldFiles, scaffoldPaths,
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

test('a staging directory left behind by a failed run stops the next one', (t) => {
  const root = fixtureProject(t);
  mkdirSync(join(root, 'packages/.scaffold-field-service'), { recursive: true });
  writeFileSync(join(root, 'packages/.scaffold-field-service/src.js'), 'partial\n');

  const result = applyPackageScaffold({ name: 'field-service', rootDir: root });
  assert.equal(result.ok, false);
  assert.deepEqual(result.problems.map((p) => p.code), ['SCAFFOLD_IN_PROGRESS']);
  // The half-written state is reported, not deleted: it may be an author's
  // concurrent run, and a scaffold that removes other people's files to make
  // room for its own is exactly the behaviour this refuses.
  assert.equal(readFileSync(join(root, 'packages/.scaffold-field-service/src.js'), 'utf8'), 'partial\n');
  assert.equal(existsSync(join(root, 'packages/field-service')), false);
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
    'CONFORMANCE_IS_NOT_CORRECTNESS', 'IDENTITY_UNIQUENESS_NOT_CHECKED', 'NO_COMPOSITION',
    'NO_DATABASE_OR_MIGRATION', 'NO_DOMAIN_SEMANTICS', 'NO_INSTALL_OR_PUBLISH',
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
