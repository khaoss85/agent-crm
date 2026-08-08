import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectDoctorCommand, PROJECT_DOCTOR_CONTRACT } from '../packages/cli/src/project-doctor-command.js';
import {
  AUTHORITIES, STATUSES, discoverPackages, docsChecks, hygieneChecks, moduleChecks, skillChecks,
} from '../packages/cli/src/project-doctor-checks.js';
import { moduleStateFingerprint } from '../packages/core/src/module-evolution.js';

/**
 * `crm project doctor` — DX1.
 *
 * The command answers one question: what is structurally inconsistent or stale
 * in this project, before I edit it or pay for a full verification run? These
 * tests hold it to four standards.
 *
 * **It must be honest.** Every finding names an authority that already exists —
 * the composition, `module-evolution`, the authoring rule, AX2, git. A check
 * that cannot run is `not_applicable` with a reason, never `passed`, and a
 * `warning` never becomes a failure to look thorough.
 * **It must not be `verify`.** No test runs, no database opens, no network call
 * is made, and nothing is mutated.
 * **It must be deterministic.** Byte-identical JSON across runs, processes,
 * working directories, locales and timezones, with no absolute path.
 * **It must survive a broken project.** A project that will not compose is
 * exactly when a doctor is worth having, so every fixture below is a project
 * that is wrong in a different way.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = join(repoRoot, 'packages/cli/bin/agent-crm.js');

/** A throwaway copy of this project: the doctor must never touch the original. */
function project(t, { name = 'agent-crm-doctor-' } = {}) {
  const root = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'package.json', 'docs', 'examples']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  return root;
}

const run = (rootDir) => projectDoctorCommand({ rootDir, capture: true });
const byId = (report, id) => report.checks.find((entry) => entry.id === id);

function runCli(args, { cwd = repoRoot, env = {} } = {}) {
  try {
    return { exitCode: 0, stdout: execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', env: { ...process.env, ...env } }) };
  } catch (error) {
    return { exitCode: error.status, stdout: String(error.stdout ?? '') };
  }
}

test('a healthy project reports every category and exits 0', async (t) => {
  const root = project(t);
  const { exitCode, report } = await run(root);

  assert.equal(exitCode, 0);
  assert.equal(report.projectDoctorContract, PROJECT_DOCTOR_CONTRACT);
  assert.equal(report.counts.failed, 0, JSON.stringify(report.problems));
  assert.equal(report.project.kind, 'framework-repository');
  assert.equal(report.project.composition, 'valid');

  // Every category is represented, so a silently missing check cannot look like
  // a clean bill of health.
  for (const category of report.categories) {
    assert.ok(report.checks.some((entry) => entry.category === category), `no check ran for ${category}`);
  }
  // Every check names a real authority and a real status.
  for (const entry of report.checks) {
    assert.ok(AUTHORITIES.includes(entry.authority), `${entry.id} cites ${entry.authority}`);
    assert.ok(STATUSES.includes(entry.status), `${entry.id} is ${entry.status}`);
    if (entry.status === 'not_applicable') assert.ok(entry.reason, `${entry.id} is N/A with no reason`);
    if (entry.status === 'failed') assert.ok(entry.remediation, `${entry.id} failed with no remediation`);
  }
});

test('a warning is not a failure', async (t) => {
  const root = project(t);
  const { exitCode, report } = await run(root);
  // This repository really does carry known warnings: two Solution Plans are
  // stale against the current composition, and six skills exist in one mirror
  // only. Both are documented gaps somebody else owns. A doctor that failed the
  // build for them would be a doctor people stop running.
  assert.ok(report.counts.warning > 0, 'the fixture should still carry its known warnings');
  assert.equal(report.status, 'warning');
  assert.equal(exitCode, 0, 'warnings must never fail the run');
});

test('the report leaks no absolute path, stack, source body or timestamp', async (t) => {
  const root = project(t);
  const { report } = await run(root);
  const text = JSON.stringify(report);

  assert.doesNotMatch(text, new RegExp(root.replaceAll('\\', '\\\\')), 'the project root must not appear');
  assert.doesNotMatch(text, /\/home\/|\/Users\/|C:\\\\/, 'no absolute path');
  assert.doesNotMatch(text, /\n\s+at [A-Za-z]/, 'no stack frame');
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T\d{2}:/, 'no timestamp: it would make the report undiffable');
  assert.equal(report.project.root, undefined, 'the root is deliberately not published');
});

test('the same project produces byte-identical JSON across processes, directories, locales and timezones', () => {
  const args = ['project', 'doctor', '--root', repoRoot, '--json'];
  const first = runCli(args);
  const second = runCli(args, { cwd: tmpdir(), env: { LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8', TZ: 'Pacific/Kiritimati' } });
  assert.equal(first.stdout, second.stdout);
});

test('a project whose path contains spaces is read the same way', async (t) => {
  const plain = project(t);
  const spaced = project(t, { name: 'agent crm doctor ' });
  const a = await run(plain);
  const b = await run(spaced);
  assert.equal(a.report.fingerprint, b.report.fingerprint);
});

test('the doctor mutates nothing', async (t) => {
  const root = project(t);
  const before = execFileSync('find', [root, '-type', 'f', '-newermt', '@0'], { encoding: 'utf8' }).split('\n').sort().join('\n');
  await run(root);
  const after = execFileSync('find', [root, '-type', 'f', '-newermt', '@0'], { encoding: 'utf8' }).split('\n').sort().join('\n');
  assert.equal(after, before, 'no file may be created, moved or removed');
  assert.equal(readFileSync(join(root, 'packages/domains/generated/index.js'), 'utf8'),
    readFileSync(join(repoRoot, 'packages/domains/generated/index.js'), 'utf8'));
});

// ---------------------------------------------------------------------------
// the broken-project matrix
// ---------------------------------------------------------------------------

test('a composition that throws on import is a failure, not a crash', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'packages/domains/generated/index.js'),
    'throw new Error("this composition refuses to load");\n');

  const { exitCode, report } = await run(root);
  assert.equal(exitCode, 1);
  // `invalid`, not `readable`: AX1 answers even for a composition file that
  // throws, because reporting that failure is AX1 working. A field that said
  // "readable" about a project that cannot load would be the exact misreading
  // this command exists to prevent.
  assert.equal(report.project.composition, 'invalid');
  assert.equal(byId(report, 'composition.valid').status, 'failed');
  assert.ok(report.checks.some((entry) => entry.id.includes('composition_load_failed')),
    'the load failure must travel with AX1\'s own code');
  // And the rest of the doctor still ran: a project that will not compose is
  // exactly when the other answers are worth having.
  assert.ok(byId(report, 'docs.links'));
  assert.ok(byId(report, 'packages.source-boundary'));
  // The fixture is a copy without a .git directory, so hygiene has no authority
  // to ask and says so rather than guessing from what is on disk.
  assert.equal(byId(report, 'hygiene.tracked-artifacts').status, 'not_applicable');
  assert.equal(byId(report, 'hygiene.tracked-artifacts').reason, 'NOT_A_GIT_REPOSITORY');
});

test('a composition with a duplicate package is reported with the composition as the authority', async (t) => {
  const root = project(t);
  const composition = join(root, 'packages/domains/generated/index.js');
  writeFileSync(composition, `${readFileSync(composition, 'utf8')}
import { createServicePackage as duplicateService } from '../../service/src/index.js';
generatedDomains.push(duplicateService());
`);
  const { exitCode, report } = await run(root);
  assert.equal(exitCode, 1);
  const composed = byId(report, 'composition.valid');
  assert.equal(composed.status, 'failed');
  assert.equal(composed.authority, 'app-inspect', 'the doctor must not re-derive a collision it did not detect');
});

test('a package that reaches into private kernel source is a failure', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'packages/service/src/sneaky.js'),
    "import { something } from '../../core/src/errors.js';\nexport { something };\n");

  const { exitCode, report } = await run(root);
  assert.equal(exitCode, 1);
  const boundary = byId(report, 'packages.source-boundary');
  assert.equal(boundary.status, 'failed');
  assert.equal(boundary.authority, 'authoring-rule');
  assert.deepEqual(boundary.evidence.violations, ['packages/service/src/sneaky.js']);
});

test('kernel directories are not mistaken for domain packages', async (t) => {
  const root = project(t);
  const discovered = discoverPackages(root).map((entry) => entry.path);
  // `packages/app`, `packages/sdk`, `packages/mcp`, `packages/providers` and
  // `packages/workflows` all have a src/index.js and all import core/src,
  // because they ARE the core. An earlier draft swept them in and reported
  // eight boundary violations in a repository that has none.
  for (const kernel of ['packages/app', 'packages/sdk', 'packages/mcp', 'packages/providers', 'packages/workflows']) {
    assert.ok(!discovered.includes(kernel), `${kernel} is kernel code, not a domain package`);
  }
  assert.ok(discovered.includes('packages/service'));
  assert.ok(discovered.includes('examples/custom-packages/partner-scorecard'));
  assert.equal(byId((await run(root)).report, 'packages.source-boundary').status, 'passed');
});

test('a hand-edited module state file is a failure, and module-evolution is the authority', (t) => {
  const root = project(t);
  const dir = join(root, 'packages/modules/company');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'module.state.json'), `${JSON.stringify({
    stateVersion: 1,
    module: 'company',
    revision: 1,
    fingerprint: 'not the fingerprint of the manifest below',
    manifest: { name: 'company', table: 'company', revision: 1, fields: [{ name: 'name', type: 'string', required: true }] },
    migrations: [],
  }, null, 2)}\n`);

  const checks = moduleChecks({ rootDir: root });
  const state = checks.find((entry) => entry.id === 'modules.state');
  assert.equal(state.status, 'failed');
  assert.equal(state.authority, 'module-evolution');
  assert.equal(state.evidence.drifted.length, 1);
  assert.match(state.remediation, /version control/);
});

test('a tampered migration checksum is caught by module-evolution, not re-derived here', (t) => {
  const root = project(t);
  const dir = join(root, 'packages/modules/company');
  mkdirSync(dir, { recursive: true });
  const manifest = { name: 'company', table: 'company', revision: 1, fields: [{ name: 'name', type: 'string', required: true }] };
  // Build a state file whose own fingerprint is right, so the only thing wrong
  // is the migration checksum — otherwise this test would pass for the reason
  // the previous one already covers.
  writeFileSync(join(dir, 'module.state.json'), `${JSON.stringify({
    stateVersion: 1,
    module: 'company',
    revision: 1,
    fingerprint: moduleStateFingerprint(manifest),
    manifest,
    migrations: [{ name: '0001_create_company', checksum: 'deadbeef', sql: 'CREATE TABLE company (id TEXT PRIMARY KEY);' }],
  }, null, 2)}\n`);

  // `readModuleState` refuses this itself — it is the authority, and it throws.
  // The doctor's job is to turn that into a row, not to re-derive the checksum
  // and risk disagreeing with the runtime that actually enforces it.
  const checks = moduleChecks({ rootDir: root });
  const state = checks.find((entry) => entry.id === 'modules.state');
  assert.equal(state.status, 'failed');
  assert.equal(state.authority, 'module-evolution');
  assert.match(state.evidence.drifted[0].detail, /checksum does not match its SQL/);
  assert.match(state.evidence.drifted[0].detail, /Applied migrations are immutable/);

  // And the inventory row stays honest about having verified nothing itself.
  const history = checks.find((entry) => entry.id === 'modules.migration-history');
  assert.equal(history.status, 'not_applicable');
});

test('a module with no state file is not a failure', (t) => {
  const root = project(t);
  const checks = moduleChecks({ rootDir: root });
  assert.equal(checks.find((entry) => entry.id === 'modules.state').status, 'passed');
  // Having no state file at all is the documented "predates the file" case.
  assert.equal(checks.find((entry) => entry.id === 'modules.migration-history').status, 'not_applicable');
});

test('a stale Solution Plan is a warning and a malformed one is a failure', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'examples/solution-plans/broken.plan.json'), '{ this is not json\n');

  const { exitCode, report } = await run(root);
  const rows = report.checks.filter((entry) => entry.category === 'plans');
  const broken = rows.find((entry) => entry.subject === 'examples/solution-plans/broken.plan.json');
  assert.equal(broken.status, 'failed');
  assert.equal(broken.authority, 'solution-plan');
  assert.match(broken.remediation, /solution validate/);
  assert.equal(exitCode, 1);

  // The stale ones stay warnings: a plan written against a composition that has
  // since moved is information, not a broken project.
  assert.ok(rows.some((entry) => entry.status === 'warning'));
});

test('a project with no Solution Plans is not applicable, never a failure', async (t) => {
  const root = project(t);
  rmSync(join(root, 'examples/solution-plans'), { recursive: true, force: true });
  const { report } = await run(root);
  const plans = report.checks.filter((entry) => entry.category === 'plans');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].status, 'not_applicable');
  assert.equal(plans[0].reason, 'NO_SOLUTION_PLANS_FOUND');
});

test('skill mirrors that disagree are drift; a one-sided skill is only a warning', (t) => {
  const root = project(t);
  cpSync(join(repoRoot, '.claude'), join(root, '.claude'), { recursive: true });
  cpSync(join(repoRoot, '.agents'), join(root, '.agents'), { recursive: true });

  const clean = skillChecks({ rootDir: root });
  assert.equal(clean.find((entry) => entry.id === 'skills.mirror-drift').status, 'passed');
  // Six domain build skills live under .claude/ only. Real, documented, and
  // owned by DX2 — a warning, not a failure.
  assert.equal(clean.find((entry) => entry.id === 'skills.mirror-coverage').status, 'warning');

  const skill = join(root, '.agents/skills/create-crm-module/SKILL.md');
  writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nAn edit that exists in one mirror only.\n`);
  const drifted = skillChecks({ rootDir: root }).find((entry) => entry.id === 'skills.mirror-drift');
  assert.equal(drifted.status, 'failed');
  assert.deepEqual(drifted.evidence.drifted, ['create-crm-module']);
  assert.match(drifted.remediation, /DX2/);
});

test('a project that never declared mirrors is not applicable', (t) => {
  const root = project(t);
  cpSync(join(repoRoot, '.claude'), join(root, '.claude'), { recursive: true });
  const checks = skillChecks({ rootDir: root });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'not_applicable');
  assert.equal(checks[0].reason, 'MIRRORS_NOT_DECLARED');
});

test('a broken repository-relative documentation link is a failure; a web URL is not checked', (t) => {
  const root = project(t);
  writeFileSync(join(root, 'docs/BROKEN.md'), [
    '# Broken',
    '',
    'A [missing file](./nowhere-at-all.md).',
    'A [real file](./PACKAGE_AUTHORING.md).',
    'A [web link](https://example.invalid/never-fetched).',
    'An [anchor](#a-heading-nobody-parses).',
    'A [mailto](mailto:someone@example.com).',
  ].join('\n'));

  const links = docsChecks({ rootDir: root, docs: [join(root, 'docs/BROKEN.md')] })[0];
  assert.equal(links.status, 'failed');
  assert.equal(links.authority, 'docs-link');
  assert.deepEqual(links.evidence.broken, [{ document: 'docs/BROKEN.md', link: './nowhere-at-all.md' }]);
});

test('a tracked .env is a failure and .env.example is not', (t) => {
  const root = project(t);
  const tracked = (paths) => hygieneChecks({ rootDir: root, run: () => paths.join('\0') })[0];

  const clean = tracked(['README.md', '.env.example', 'packages/core/index.js']);
  assert.equal(clean.status, 'passed', JSON.stringify(clean.evidence));

  const dirty = tracked(['README.md', '.env', 'apps/.env.production', 'data/agent-crm.sqlite', 'debug.log', 'node_modules/x/index.js']);
  assert.equal(dirty.status, 'failed');
  assert.deepEqual(dirty.evidence.forbidden.map((entry) => entry.code).sort(),
    ['TRACKED_DATABASE', 'TRACKED_DEPENDENCIES', 'TRACKED_ENV_FILE', 'TRACKED_ENV_FILE', 'TRACKED_LOG']);
  // The path is named; the file is never opened.
  assert.match(dirty.remediation, /rotate/);
});

test('a project that is not a git repository says so rather than guessing', (t) => {
  const root = project(t);
  const check = hygieneChecks({
    rootDir: root,
    run: () => { throw Object.assign(new Error('not a git repository'), { status: 128 }); },
  })[0];
  assert.equal(check.status, 'not_applicable');
  assert.equal(check.reason, 'NOT_A_GIT_REPOSITORY');
  assert.match(check.remediation, /does not guess/);
});

test('an unreadable project root exits 2 without a report', async () => {
  const { exitCode, report } = await projectDoctorCommand({
    rootDir: join(tmpdir(), 'agent-crm-doctor-does-not-exist'), capture: true,
  });
  assert.equal(exitCode, 2);
  assert.equal(report, null);
});

test('the CLI exit codes are the contract', (t) => {
  const root = project(t);
  assert.equal(runCli(['project', 'doctor', '--root', root, '--json']).exitCode, 0);

  writeFileSync(join(root, 'packages/service/src/sneaky.js'), "import x from '../../core/src/errors.js';\nexport default x;\n");
  const failed = runCli(['project', 'doctor', '--root', root, '--json']);
  assert.equal(failed.exitCode, 1);
  assert.equal(JSON.parse(failed.stdout).status, 'failed');

  assert.equal(runCli(['project', 'doctor', '--root', join(tmpdir(), 'nope-not-here'), '--json']).exitCode, 2);
});

test('the doctor loads the composition exactly once, however many plans exist', async (t) => {
  const root = project(t);
  let loads = 0;
  await projectDoctorCommand({
    rootDir: root,
    capture: true,
    inspect: async (options) => {
      loads += 1;
      const { inspectApplicationCommand } = await import('../packages/cli/src/app-inspect-command.js');
      return inspectApplicationCommand(options);
    },
  });
  // Three plans ship with this repository. `crm solution check` would load the
  // application once per plan, which is right for one plan and is what would
  // make the doctor slower than the verification it runs before.
  assert.equal(loads, 1);
});

test('the doctor is far cheaper than the verification it runs before', async (t) => {
  const root = project(t);
  const started = process.hrtime.bigint();
  await run(root);
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Measured at ~140 ms on this repository against ~156 s for `npm run verify`.
  // The bound is deliberately loose — this asserts an order of magnitude, not a
  // benchmark, so a slow CI runner does not make it flaky.
  assert.ok(elapsedMs < 10_000, `doctor took ${Math.round(elapsedMs)} ms`);
});

test('every limitation this command claims is stated in its own output', async (t) => {
  const root = project(t);
  const { report } = await run(root);
  const codes = report.limitations.map((entry) => entry.code).sort();
  assert.deepEqual(codes, [
    'DATABASE_NOT_INSPECTED', 'DISCOVERY_IS_BY_CONVENTION', 'DOMAIN_CORRECTNESS_NOT_PROVEN',
    'GENERATED_SOURCE_DRIFT_LIMITED', 'NOT_A_SUBSTITUTE_FOR_VERIFY', 'NO_MUTATION',
    'PACKAGE_CONFORMANCE_NOT_RUN', 'PRODUCTION_READINESS_NOT_ASSESSED', 'PROVIDER_HEALTH_UNKNOWN',
    'SECRETS_NOT_INSPECTED',
  ]);
});

test('problems is the compact view a context pack could carry', async (t) => {
  const root = project(t);
  writeFileSync(join(root, 'packages/service/src/sneaky.js'), "import x from '../../core/src/errors.js';\nexport default x;\n");
  const { report } = await run(root);

  assert.equal(report.problems.length, report.counts.failed);
  for (const problem of report.problems) {
    assert.ok(problem.code && problem.authority && problem.remediation);
    // Compact on purpose: this is what a future Context Pack would include, and
    // a diagnostic that costs a page per finding is one nobody includes.
    assert.ok(JSON.stringify(problem).length < 1_000, problem.code);
  }
});
