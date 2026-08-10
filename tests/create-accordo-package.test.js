// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PACKAGE_ASSEMBLY_CONTRACT, applyPackageAssembly, collectAssemblyFiles,
  parseArguments, planPackageAssembly, publicationManifest,
} from '../scripts/assemble-create-accordo.js';

const repoRoot = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const assemblyBin = join(repoRoot, 'scripts/assemble-create-accordo.js');

function scratch(t, prefix = 'accordo-package-test-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(command, args, { cwd = repoRoot } = {}) {
  const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
  try {
    const stdout = execFileSync(command, args, {
      cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    return {
      exitCode: error.status ?? -1,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? ''),
    };
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

test('the publication plan is deterministic, bounded and read-only', (t) => {
  const workspace = scratch(t);
  const firstTarget = join(workspace, 'first');
  const secondTarget = join(workspace, 'second');
  const first = planPackageAssembly({ directory: firstTarget, cwd: workspace }).report;
  const second = planPackageAssembly({ directory: secondTarget, cwd: workspace }).report;

  assert.equal(first.packageAssemblyContract, PACKAGE_ASSEMBLY_CONTRACT);
  assert.equal(first.ok, true);
  assert.equal(first.mode, 'plan');
  assert.equal(first.package.name, 'create-accordo');
  assert.equal(first.package.version, '0.1.0');
  assert.equal(first.package.files > 190, true, 'the package carries the declared framework rather than only the bin');
  assert.equal(first.package.fingerprint, second.package.fingerprint);
  assert.equal(first.package.frameworkFingerprint, second.package.frameworkFingerprint);
  assert.equal(existsSync(firstTarget), false);
  assert.equal(existsSync(secondTarget), false);
  assert.deepEqual(first.problems, []);
  assert.deepEqual(first.problemCodes, [
    'TARGET_MISSING', 'TARGET_PATH_INVALID', 'TARGET_NOT_A_DIRECTORY', 'TARGET_NOT_EMPTY',
    'TARGET_INSIDE_SOURCE', 'SOURCE_INVALID', 'ASSEMBLY_NOT_WRITTEN', 'TARGET_CLAIMED',
  ]);
  assert.deepEqual(first.limitations.map((item) => item.code), [
    'NOT_PUBLISHED', 'PROVENANCE_NOT_CREATED', 'TRUSTED_PUBLISHER_NOT_INSPECTED',
    'SOURCE_IS_A_COPY', 'GENERATED_PROJECT_IS_LOCAL_ONLY',
  ]);
});

test('the private source manifest and public publication manifest cannot be confused', () => {
  const source = JSON.parse(readFileSync(join(repoRoot, 'packages/create-accordo/package.json'), 'utf8'));
  const candidate = publicationManifest(source.version);

  assert.equal(source.private, true, 'publishing directly from the repository stays impossible');
  assert.equal(candidate.private, undefined, 'the assembled candidate alone is publishable');
  assert.equal(candidate.name, source.name);
  assert.equal(candidate.version, source.version);
  assert.equal(candidate.dependencies, undefined);
  assert.equal(candidate.scripts, undefined, 'installing the package executes no lifecycle script');
  assert.deepEqual(candidate.bin, { 'create-accordo': 'bin/create-accordo.js' },
    'the publication manifest uses npm canonical bin syntax without publish-time correction');
  assert.equal(candidate.repository.url, 'git+https://github.com/khaoss85/agent-crm.git');
  assert.deepEqual(candidate.publishConfig, { access: 'public', provenance: true });

  const assembly = collectAssemblyFiles();
  assert.equal(assembly.files.some((file) => file.relativePath === 'framework/packages/create-accordo/package.json'), false);
  assert.equal(assembly.files.some((file) => file.relativePath === 'README.md'), true);
  assert.equal(assembly.files.some((file) => file.relativePath === 'LICENSE'), true);
  assert.equal(assembly.files.some((file) => file.relativePath.startsWith('framework/site/')), false);
  assert.equal(assembly.files.some((file) => file.relativePath.startsWith('framework/docs/')), false);
});

test('the release workflow redirects JSON-only assembly output', (t) => {
  const workflow = readFileSync(join(repoRoot, '.github/workflows/stage-create-accordo.yml'), 'utf8');
  const invocations = workflow.match(/npm run --silent distribution:assemble-create --[^\n]+--json\s*>/g) ?? [];
  assert.equal(invocations.length, 2, 'both redirected assembly receipts must suppress the npm banner');

  const workspace = scratch(t, 'accordo-package-workflow-json-');
  const target = join(workspace, 'candidate');
  const assembled = run('npm', [
    'run', '--silent', 'distribution:assemble-create', '--', target, '--apply', '--json',
  ]);
  assert.equal(assembled.exitCode, 0, assembled.stderr);
  const report = JSON.parse(assembled.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.package.name, 'create-accordo');
  assert.equal(report.package.version, '0.1.0');
});

test('public copy distinguishes the verified candidate from the live npm placeholder', () => {
  const brand = JSON.parse(readFileSync(join(repoRoot, 'site/brand.json'), 'utf8'));
  assert.equal(brand.npm.sourceScaffolds, true);
  assert.equal(brand.npm.status, 'names-reserved');

  const surfaces = Object.fromEntries([
    'site/templates/index.html',
    'docs/marketing/PENDING_HUMAN_SUBMISSION.md',
    'docs/marketing/LAUNCH_PACKET.md',
    'docs/strategy/DISTRIBUTION_SUBMISSIONS.md',
    'docs/strategy/GO_TO_MARKET.md',
    'docs/strategy/RECOMMENDATION_MAP.md',
    'docs/strategy/AGENT_RECOMMENDATION.md',
  ].map((path) => [path, readFileSync(join(repoRoot, path), 'utf8')]));

  for (const [path, source] of Object.entries(surfaces)) {
    assert.match(source, /candidate/i, `${path} omits the verified publication candidate`);
    assert.match(source, /(not (?:on the registry|published)|placeholder|registry unchanged)/i,
      `${path} lets a candidate read as a live npm release`);
    assert.doesNotMatch(source, /there is no create-project CLI|\bno create-command\b/i,
      `${path} says the source bootstrap does not exist`);
  }

  const site = surfaces['site/templates/index.html'];
  const ownershipCopy = `${site}\n${readFileSync(join(repoRoot, 'docs/marketing/OBJECTIONS.md'), 'utf8')}`;
  assert.doesNotMatch(ownershipCopy, /dependency you could delete|delete and still ship/i,
    'ownership means keeping vendored source, not deleting the framework');
  assert.match(site, /deleting the copied framework\s+breaks the application/i);
});

test('two assemblies pack byte-identically, install offline and create a working project', async (t) => {
  const workspace = scratch(t);
  const first = join(workspace, 'assembly-a');
  const second = join(workspace, 'assembly-b');
  const firstReport = applyPackageAssembly({ directory: first, cwd: workspace });
  const secondReport = applyPackageAssembly({ directory: second, cwd: workspace });
  assert.equal(firstReport.ok, true);
  assert.equal(secondReport.ok, true);
  assert.equal(firstReport.package.fingerprint, secondReport.package.fingerprint);

  const firstPackDir = join(workspace, 'pack-a');
  const secondPackDir = join(workspace, 'pack-b');
  mkdirSync(firstPackDir);
  mkdirSync(secondPackDir);
  const packA = JSON.parse(run('npm', ['pack', first, '--json', '--pack-destination', firstPackDir]).stdout)[0];
  const packB = JSON.parse(run('npm', ['pack', second, '--json', '--pack-destination', secondPackDir]).stdout)[0];
  const tarA = join(firstPackDir, packA.filename);
  const tarB = join(secondPackDir, packB.filename);

  assert.equal(sha256(tarA), sha256(tarB), 'npm pack output is byte-identical from identical assemblies');
  assert.equal(packA.name, 'create-accordo');
  assert.equal(packA.version, '0.1.0');
  assert.equal(packA.files.some((file) => file.path === 'framework/packages/core/index.js'), true);
  assert.equal(packA.files.some((file) => file.path === 'framework/packages/create-accordo/package.json'), false);
  assert.equal(packA.files.some((file) => file.path.startsWith('framework/site/')), false);
  assert.equal(packA.files.some((file) => file.path.startsWith('framework/docs/')), false);

  const consumer = join(workspace, 'consumer');
  // The directory is created through the package manifest write so npm has a
  // clean project and no registry package to resolve. `--offline` makes the
  // no-network claim an enforced npm mode rather than an observation.
  mkdirSync(consumer);
  writeFileSync(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  const install = run('npm', [
    'install', tarA, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
  ], { cwd: consumer });
  assert.equal(install.exitCode, 0, install.stderr);

  const installedBin = join(consumer, 'node_modules/create-accordo/bin/create-accordo.js');
  assert.equal(existsSync(installedBin), true);
  const installedShim = join(consumer, 'node_modules/.bin/create-accordo');
  assert.equal(existsSync(installedShim), true,
    'npm exposes the installed create command through its executable shim');
  const project = join(workspace, 'acme-crm');
  const created = run(installedShim, [project, '--apply', '--json'], { cwd: consumer });
  assert.equal(created.exitCode, 0, created.stderr);
  const report = JSON.parse(created.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.source.files > 190, true);
  assert.equal(report.limitations.some((item) => item.code === 'SOURCE_ORIGIN_NOT_VERIFIED'), true);
  assert.equal(report.limitations.some((item) => item.code === 'PUBLISHED_PLACEHOLDER_DOES_NOT_SCAFFOLD'), false);

  const generatedBin = join(project, 'packages/cli/bin/accordo.js');
  const inspect = run(process.execPath, [generatedBin, 'app', 'inspect', '--json', '--root', project], { cwd: project });
  assert.equal(inspect.exitCode, 0, inspect.stderr);
  assert.equal(JSON.parse(inspect.stdout).valid, true);
  const doctor = run(process.execPath, [generatedBin, 'project', 'doctor', '--json', '--root', project], { cwd: project });
  assert.equal(doctor.exitCode, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).status, 'passed');
  const tests = run('npm', ['test'], { cwd: project });
  assert.equal(tests.exitCode, 0, tests.stderr);
  assert.match(tests.stdout, /pass 3/);
  assert.match(tests.stdout, /fail 0/);
  const smoke = run('npm', ['run', 'smoke'], { cwd: project });
  assert.equal(smoke.exitCode, 0, smoke.stderr);
  assert.match(smoke.stdout, /"ok": true/);
});

test('assembly refuses malformed invocations and never overwrites output', (t) => {
  const workspace = scratch(t);
  const occupied = join(workspace, 'occupied');
  mkdirSync(occupied);
  writeFileSync(join(occupied, 'keep.txt'), 'keep');

  const refused = applyPackageAssembly({ directory: occupied, cwd: workspace });
  assert.equal(refused.ok, false);
  assert.equal(refused.mode, 'refused');
  assert.equal(refused.problems.some((problem) => problem.code === 'TARGET_NOT_EMPTY'), true);
  assert.deepEqual(readdirSync(occupied), ['keep.txt']);
  assert.equal(readFileSync(join(occupied, 'keep.txt'), 'utf8'), 'keep');

  const inside = planPackageAssembly({ directory: join(repoRoot, 'dist-candidate') }).report;
  assert.equal(inside.ok, false);
  assert.equal(inside.problems.some((problem) => problem.code === 'TARGET_INSIDE_SOURCE'), true);
  assert.equal(existsSync(join(repoRoot, 'dist-candidate')), false);

  assert.deepEqual(parseArguments(['out', '--apply', '--json']), { directory: 'out', apply: true, json: true, help: false });
  assert.throws(() => parseArguments(['a', 'b']), /only one output/);
  assert.throws(() => parseArguments(['--wat']), /unknown option/);

  const cliTarget = join(workspace, 'cli-plan');
  const plan = run(process.execPath, [assemblyBin, cliTarget, '--json'], { cwd: workspace });
  assert.equal(plan.exitCode, 0);
  assert.equal(JSON.parse(plan.stdout).mode, 'plan');
  assert.equal(existsSync(cliTarget), false);
});

test('assembly never follows a publication-file symlink outside the repository', (t) => {
  const workspace = scratch(t, 'accordo-package-symlink-');
  const fakeRoot = join(workspace, 'source');
  mkdirSync(fakeRoot);
  for (const entry of ['LICENSE', 'packages', 'apps', 'skills', 'examples']) {
    cpSync(join(repoRoot, entry), join(fakeRoot, entry), { recursive: true });
  }
  const outside = join(workspace, 'outside.txt');
  writeFileSync(outside, 'must never enter a signed tarball');
  const readme = join(fakeRoot, 'packages/create-accordo/README.package.md');
  rmSync(readme);
  symlinkSync(outside, readme);

  assert.throws(
    () => collectAssemblyFiles(fakeRoot),
    /README\.package\.md must be a regular file; publication assembly never follows symbolic links/,
  );
});

test('a parent symlink cannot disguise an output inside the source tree', (t) => {
  const workspace = scratch(t, 'accordo-package-target-symlink-');
  const alias = join(workspace, 'source-alias');
  symlinkSync(repoRoot, alias);
  const disguised = join(alias, 'unsigned-candidate');

  const report = planPackageAssembly({ directory: disguised }).report;
  assert.equal(report.ok, false);
  assert.equal(report.problems.some((problem) => problem.code === 'TARGET_INSIDE_SOURCE'), true);
  assert.equal(existsSync(join(repoRoot, 'unsigned-candidate')), false);
});
