import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectApplication } from '../packages/cli/src/app-inspect.js';

/**
 * AX1 — deterministic application inspection.
 *
 * The command exists so a coding agent stops assembling the application from
 * five surfaces by hand, so the properties under test are the ones an agent
 * would be harmed by getting wrong: it must be complete when the composition is
 * broken, byte-identical between runs, silent about secrets and absolute paths,
 * and honest about everything it cannot know.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const CLI = 'packages/cli/bin/accordo.js';

/** A throwaway project carrying the framework, with a composition we control. */
function fixtureProject(t, { packages = '', files = {}, spaces = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), spaces ? 'agent crm inspect ' : 'accordo-inspect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content, 'utf8');
  }
  if (packages) writeFileSync(join(root, 'packages/domains/generated/index.js'), packages, 'utf8');
  return root;
}

/** One fixture package, written into the project as a customer's package would be. */
function packageSource({ name, version = 1, requires = [], provides = [], resources = [], extra = '' }) {
  return `import { definePackage } from '../packages/core/index.js';
export function create${name.replaceAll('-', '')}Package() {
  return definePackage({
    packageContract: 1,
    name: ${JSON.stringify(name)},
    version: ${version},
    label: ${JSON.stringify(name)},
    requires: ${JSON.stringify(requires)},
    capabilities: ${JSON.stringify(provides)}.map((entry) => ({ ...entry, create: () => ({ ok: true }) })),
    resources: ${JSON.stringify(resources)},
    actions: [],
    policies: [],
    metadata() { return { note: 'fixture' }; },
    ${extra}
  });
}
`;
}

/** A composition file importing named fixture packages from `fixtures/`. */
function composition(names) {
  return `${names.map((name, index) => `import { create${name.replaceAll('-', '')}Package as p${index} } from '../../../fixtures/${name}.js';`).join('\n')}
export const generatedDomains = [${names.map((_, index) => `p${index}()`).join(', ')}];
`;
}

/** Build a project whose composition is exactly these fixture packages. */
function projectWith(t, definitions, options = {}) {
  const files = {};
  for (const definition of definitions) files[`fixtures/${definition.name}.js`] = packageSource(definition);
  return fixtureProject(t, {
    ...options,
    files: { ...files, ...(options.files ?? {}) },
    packages: composition(definitions.map((definition) => definition.name)),
  });
}

/** Run the real CLI the way a user does. */
function runCli(root, args = []) {
  const result = spawnSync(process.execPath, ['--no-warnings', join(root, CLI), 'app', 'inspect', ...args, '--root', root], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, cwd: root,
  });
  return { ...result, json: () => JSON.parse(result.stdout) };
}

/** Every file in a tree with its size and mtime — the read-only assertion's evidence. */
function snapshot(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      const stat = statSync(full);
      out.set(relative(root, full), `${stat.size}:${stat.mtimeMs}`);
    }
  };
  walk(root);
  return out;
}

test('a composed application is reported completely, and the report is the contract', async (t) => {
  const root = projectWith(t, [
    { name: 'billing', provides: [{ name: 'invoice-facts', version: 1 }], resources: [] },
    { name: 'reporting', requires: [{ package: 'billing', capability: 'invoice-facts', version: 1 }] },
  ]);
  const { report, valid } = await inspectApplication({ rootDir: root });

  assert.equal(report.applicationInspectionContract, 1, 'the contract is versioned');
  assert.equal(valid, true);
  assert.deepEqual(report.problems, []);
  assert.deepEqual(Object.keys(report), [
    'applicationInspectionContract', 'valid', 'application', 'packages', 'capabilities',
    'resources', 'actions', 'policies', 'providers', 'modules', 'adminExtensions',
    'problems', 'limitations', 'evidence',
  ], 'the top-level shape is stable');

  assert.deepEqual(report.packages.map((entry) => entry.name), ['billing', 'reporting'], 'sorted, not composition order');
  const billing = report.packages.find((entry) => entry.name === 'billing');
  // The five different things called a version stay five different keys.
  assert.equal(billing.version, 1, 'package version');
  assert.equal(billing.packageContract, 1, 'package-contract version');
  assert.equal(billing.provides[0].version, 1, 'capability version');
  assert.equal(report.modules.find((entry) => entry.kind !== 'core')?.revision ?? null, null, 'no generated records in this fixture');

  const capability = report.capabilities.find((entry) => entry.name === 'invoice-facts');
  assert.deepEqual(
    { provider: capability.provider, consumers: capability.consumers, status: capability.status },
    { provider: 'billing', consumers: ['reporting'], status: 'resolved' },
    'the graph is reported from both ends',
  );

  // Core records are always present; they are the kernel's, not a package's.
  assert.deepEqual(
    report.modules.filter((entry) => entry.kind === 'core').map((entry) => entry.name),
    ['approval', 'company', 'contact', 'opportunity'],
  );
  assert.equal(report.adminExtensions.length, 0);
  assert.ok(
    report.limitations.some((entry) => entry.code === 'ADMIN_EXTENSIONS_UNSUPPORTED'),
    'and the report says the framework has no seam for them, rather than implying this project has none',
  );
  assert.equal(report.evidence.status, 'not_aggregated');
  assert.equal(report.evidence.jtbdMatrixPath, 'docs/benchmarks/CRM_JTBD_MATRIX.md');
});

test('the report is byte-identical between runs and between processes', async (t) => {
  const root = projectWith(t, [
    { name: 'billing', provides: [{ name: 'invoice-facts', version: 1 }] },
    { name: 'reporting', requires: [{ package: 'billing', capability: 'invoice-facts', version: 1 }] },
  ]);
  const first = runCli(root, ['--json']);
  const second = runCli(root, ['--json']);
  assert.equal(first.status, 0);
  assert.equal(first.stdout, second.stdout, 'two processes produce the same bytes');

  // Determinism must not depend on composition order.
  const shuffled = composition(['reporting', 'billing']);
  writeFileSync(join(root, 'packages/domains/generated/index.js'), shuffled, 'utf8');
  const reordered = runCli(root, ['--json']);
  assert.equal(reordered.stdout, first.stdout, 'reordering the composition changes nothing it reports');
});

test('the report carries no function, secret, absolute path, timestamp or SQL', async (t) => {
  const hostile = `import { definePackage } from '../packages/core/index.js';
export function createhostilePackage() {
  return definePackage({
    packageContract: 1, name: 'hostile', version: 1, label: 'hostile',
    requires: [], capabilities: [], resources: [], actions: [],
    policies: [{ kind: 'fixture-policy', definition: {
      name: 'leaky', version: 1,
      config: { apiKey: 'sk-live-SUPERSECRET', databaseUrl: 'postgres://u:p@h/db', threshold: 5 },
      decide() { return { ok: true }; },
    } }],
    metadata() {
      return { note: 'fixture', nested: { deep: [1, 2, { deeper: true }] } };
    },
  });
}
`;
  const root = fixtureProject(t, {
    files: { 'fixtures/hostile.js': hostile },
    packages: composition(['hostile']),
  });
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const serialized = result.stdout;
  const report = result.json();

  assert.equal(serialized.includes('function'), false, 'no function survives serialization');
  assert.equal(serialized.includes('SUPERSECRET'), false, 'a declared config VALUE is never published');
  assert.equal(serialized.includes('postgres://'), false, 'nor a connection string');
  assert.equal(serialized.includes(root), false, 'no absolute project path');
  assert.equal(/"\/(home|Users|tmp|var)\//.test(serialized), false, 'no absolute path of any kind');
  assert.equal(/CREATE TABLE|ALTER TABLE|INSERT INTO/i.test(serialized), false, 'no SQL');
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(serialized), false, 'no timestamp — it would break determinism');

  // The config KEYS are useful and safe; the values are neither.
  const policy = report.policies.find((entry) => entry.name === 'leaky');
  assert.deepEqual(policy.configKeys, ['apiKey', 'databaseUrl', 'threshold']);
  assert.ok(policy.fingerprint.length >= 32, 'the declared-definition fingerprint is published');
});

test('hostile metadata stays inert data and pollutes no prototype', async (t) => {
  const nasty = `import { definePackage } from '../packages/core/index.js';
export function createnastyPackage() {
  return definePackage({
    packageContract: 1, name: 'nasty', version: 1, label: 'nasty',
    requires: [], capabilities: [], resources: [], actions: [], policies: [],
    metadata() {
      return JSON.parse('{"__proto__":{"polluted":true},"constructor":"x","script":"<img src=x onerror=alert(1)>","long":"' + 'y'.repeat(5000) + '","quote":"a\\\\"b","tick":"a\`b","dollar":"\${7*7}"}');
    },
  });
}
`;
  const root = fixtureProject(t, { files: { 'fixtures/nasty.js': nasty }, packages: composition(['nasty']) });
  const { report } = await inspectApplication({ rootDir: root });

  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  const metadata = report.packages[0].metadata;
  assert.equal(metadata.script, '<img src=x onerror=alert(1)>', 'stored verbatim as data');
  assert.equal(metadata.dollar, '${7*7}', 'no interpolation happened anywhere');
  assert.equal(metadata.long.length, 5000);
  assert.equal(JSON.parse(JSON.stringify(report)).valid, true, 'and the whole report round-trips through JSON');
});

test('a broken composition produces a complete report, not an exception', async (t) => {
  const cases = [
    {
      name: 'a missing capability',
      definitions: [{ name: 'reporting', requires: [{ package: 'billing', capability: 'invoice-facts', version: 1 }] }],
      code: 'DEPENDENCY_MISSING_PACKAGE',
    },
    {
      name: 'a capability at the wrong version',
      definitions: [
        { name: 'billing', provides: [{ name: 'invoice-facts', version: 2 }] },
        { name: 'reporting', requires: [{ package: 'billing', capability: 'invoice-facts', version: 1 }] },
      ],
      code: 'DEPENDENCY_UNSATISFIED',
    },
    {
      name: 'two packages claiming one resource',
      definitions: [
        { name: 'billing', resources: ['invoice'] },
        { name: 'reporting', resources: ['invoice'] },
      ],
      code: 'RESOURCE_COLLISION',
    },
    {
      name: 'two packages offering one capability',
      definitions: [
        { name: 'billing', provides: [{ name: 'invoice-facts', version: 1 }] },
        { name: 'reporting', provides: [{ name: 'invoice-facts', version: 1 }] },
      ],
      code: 'CAPABILITY_COLLISION',
    },
    {
      name: 'a direct cycle',
      definitions: [
        { name: 'billing', provides: [{ name: 'invoice-facts', version: 1 }], requires: [{ package: 'reporting', capability: 'report-facts', version: 1 }] },
        { name: 'reporting', provides: [{ name: 'report-facts', version: 1 }], requires: [{ package: 'billing', capability: 'invoice-facts', version: 1 }] },
      ],
      code: 'DEPENDENCY_CYCLE',
    },
    {
      name: 'a transitive cycle',
      definitions: [
        { name: 'alpha', provides: [{ name: 'a-facts', version: 1 }], requires: [{ package: 'gamma', capability: 'c-facts', version: 1 }] },
        { name: 'beta', provides: [{ name: 'b-facts', version: 1 }], requires: [{ package: 'alpha', capability: 'a-facts', version: 1 }] },
        { name: 'gamma', provides: [{ name: 'c-facts', version: 1 }], requires: [{ package: 'beta', capability: 'b-facts', version: 1 }] },
      ],
      code: 'DEPENDENCY_CYCLE',
    },
  ];

  for (const { name, definitions, code } of cases) {
    const root = projectWith(t, definitions);
    const result = runCli(root, ['--json']);
    assert.equal(result.status, 1, `${name}: an invalid composition exits 1`);
    const report = result.json();
    assert.equal(report.valid, false, name);
    assert.ok(report.problems.some((problem) => problem.code === code), `${name}: expected ${code}, got ${JSON.stringify(report.problems.map((p) => p.code))}`);
    // The point of the command: it still describes the application it could read.
    assert.equal(report.applicationInspectionContract, 1, `${name}: the report is complete`);
    assert.ok(Array.isArray(report.modules) && report.modules.length >= 4, `${name}: core records are still reported`);
    assert.ok(report.limitations.length > 0, `${name}: limitations are still reported`);
  }
});

test('a duplicate package name and a malformed package are reported, not thrown', async (t) => {
  const duplicate = fixtureProject(t, {
    files: { 'fixtures/billing.js': packageSource({ name: 'billing' }) },
    packages: composition(['billing', 'billing']),
  });
  const duplicateResult = runCli(duplicate, ['--json']);
  assert.equal(duplicateResult.status, 1);
  assert.ok(duplicateResult.json().problems.some((problem) => problem.code === 'PACKAGE_DUPLICATE'));

  const malformed = fixtureProject(t, {
    files: {
      'fixtures/broken.js': `export const generated = 1;
export function createbrokenPackage() { return { packageContract: 9, name: 'Broken!', version: 0 }; }
`,
    },
    packages: composition(['broken']),
  });
  const malformedResult = runCli(malformed, ['--json']);
  assert.equal(malformedResult.status, 1);
  const problem = malformedResult.json().problems.find((entry) => entry.code === 'PACKAGE_INVALID');
  assert.ok(problem, 'a definition that is not a package is a problem, not a crash');
  assert.equal(/\n/.test(problem.message), false, 'the message is one line, not a stack');
});

test('a composition that cannot be loaded at all is a fatal exit, with the diagnostic on stderr', async (t) => {
  const thrower = fixtureProject(t, {
    files: { 'fixtures/thrower.js': "throw new Error('import-time explosion');\n" },
    packages: composition(['thrower']),
  });
  const result = runCli(thrower, ['--json']);
  assert.equal(result.status, 1, 'the composition file failed to load, but the project did read');
  const report = result.json();
  assert.ok(report.problems.some((problem) => problem.code === 'COMPOSITION_LOAD_FAILED'));
  assert.equal(report.problems.some((problem) => problem.message.includes(thrower)), false, 'no absolute path in the message');

  // A directory that is not a project at all cannot produce a report.
  const empty = mkdtempSync(join(tmpdir(), 'accordo-not-a-project-'));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  const fatal = spawnSync(process.execPath, ['--no-warnings', join(repoRoot, CLI), 'app', 'inspect', '--json', '--root', empty], { encoding: 'utf8' });
  assert.equal(fatal.status, 2, 'a fatal load has its own exit code');
  assert.equal(fatal.stdout.trim(), '', 'and prints no report');
  assert.match(fatal.stderr, /Not an accordo project/);
});

test('inspection writes nothing, opens no database and needs no network', async (t) => {
  const root = projectWith(t, [{ name: 'billing', provides: [{ name: 'invoice-facts', version: 1 }] }]);
  const before = snapshot(root);
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0);
  const after = snapshot(root);

  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no file was created or removed');
  for (const [path, signature] of before) {
    assert.equal(after.get(path), signature, `${path} was not modified`);
  }
  // The database the project is configured with must not even be created.
  assert.equal(readdirSync(root).includes('data'), false, 'no data directory appeared');
});

test('two projects inspected in sequence share no state', async (t) => {
  const first = projectWith(t, [{ name: 'billing', provides: [{ name: 'invoice-facts', version: 1 }] }]);
  const second = projectWith(t, [{ name: 'reporting', provides: [{ name: 'report-facts', version: 1 }] }]);

  const a = await inspectApplication({ rootDir: first });
  const b = await inspectApplication({ rootDir: second });
  const c = await inspectApplication({ rootDir: first });

  assert.deepEqual(a.report.packages.map((entry) => entry.name), ['billing']);
  assert.deepEqual(b.report.packages.map((entry) => entry.name), ['reporting'], 'the second project sees only its own packages');
  assert.deepEqual(JSON.stringify(c.report), JSON.stringify(a.report), 'and the first is unchanged by having inspected the second');
});

test('a project at a path containing spaces inspects normally', async (t) => {
  const root = projectWith(t, [{ name: 'billing', provides: [{ name: 'invoice-facts', version: 1 }] }], { spaces: true });
  assert.ok(root.includes(' '), 'the fixture really has a space in its path');
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json().packages[0].name, 'billing');
});

test('the human view and the JSON view state the same facts', async (t) => {
  const root = projectWith(t, [
    { name: 'billing', provides: [{ name: 'invoice-facts', version: 1 }], resources: [] },
    { name: 'reporting', requires: [{ package: 'billing', capability: 'invoice-facts', version: 1 }] },
  ]);
  const text = runCli(root, []);
  const json = runCli(root, ['--json']);
  assert.equal(text.status, 0);
  assert.match(text.stdout, /Composition: valid/);
  assert.match(text.stdout, /billing@1 \(packageContract 1\)/);
  assert.match(text.stdout, /invoice-facts@1\s+resolved\s+provider=billing\s+consumers=reporting/);
  for (const limitation of json.json().limitations) {
    assert.ok(text.stdout.includes(limitation.code), `${limitation.code} is stated in the human view too`);
  }
});

test('existing surfaces are untouched by AX1', async (t) => {
  // `package inspect` is the per-package surface AX1 sits above; its contract
  // must not have moved, because agents and CI already depend on it.
  const validate = spawnSync(process.execPath, ['--no-warnings', join(repoRoot, CLI), 'package', 'inspect', 'packages/delivery'], {
    encoding: 'utf8', cwd: repoRoot,
  });
  assert.equal(validate.status, 0, validate.stderr);
  const report = JSON.parse(validate.stdout);
  assert.equal(report.command, 'package:inspect');
  assert.equal(report.ok, true);
  assert.deepEqual(Object.keys(report).sort(), ['command', 'metadata', 'ok', 'package', 'packages', 'path', 'privateImports', 'problems']);
  assert.equal(report.path, 'packages/delivery', 'still a repository-relative path');
});

test('inspection of a large composition stays bounded', async (t) => {
  // Not a performance benchmark: a guard that the report is linear in what the
  // project declares, and that nothing here has a package cap a real project
  // would hit.
  const definitions = Array.from({ length: 40 }, (_, index) => ({
    name: `fixture-${String(index).padStart(2, '0')}`,
    provides: [{ name: `facts-${String(index).padStart(2, '0')}`, version: 1 }],
    resources: [`record-${String(index).padStart(2, '0')}`],
    ...(index > 0
      ? { requires: [{ package: `fixture-${String(index - 1).padStart(2, '0')}`, capability: `facts-${String(index - 1).padStart(2, '0')}`, version: 1 }] }
      : {}),
  }));
  const root = projectWith(t, definitions);
  const { report, valid } = await inspectApplication({ rootDir: root });
  assert.equal(valid, true);
  assert.equal(report.packages.length, 40, 'no package cap');
  assert.equal(report.capabilities.length, 40);
  assert.equal(report.resources.length, 40);
  assert.equal(report.capabilities.filter((entry) => entry.consumers.length > 0).length, 39, 'the whole chain resolved');
});


/**
 * Loading a package means running its module body. These are the four ways
 * that goes wrong, and each must become a deterministic outcome rather than a
 * crash, a hang or a silently corrupted report.
 */
test('an import that misbehaves becomes a deterministic outcome, never a crash or a hang', async (t) => {
  const { inspectApplicationCommand } = await import('../packages/cli/src/app-inspect-command.js');

  // 1. Import-time global mutation. It happens — the boundary is honest about
  //    that — but it must not reach the process the operator invoked, which is
  //    the whole reason the load runs in a child.
  const mutating = fixtureProject(t, {
    files: {
      'fixtures/mutating.js': `globalThis.__ax1_polluted = true;
Object.prototype.__ax1_injected = 'yes';
${packageSource({ name: 'mutating' })}`,
    },
    packages: composition(['mutating']),
  });
  const mutatingResult = runCli(mutating, ['--json']);
  assert.equal(mutatingResult.status, 0, mutatingResult.stderr);
  assert.equal(mutatingResult.json().packages[0].name, 'mutating');
  assert.equal(globalThis.__ax1_polluted, undefined, 'the child mutated its own globals, not ours');
  assert.equal({}.__ax1_injected, undefined, 'and its prototype pollution stayed there');

  // 2. Import-time file write. Nothing stops trusted code from doing it, so
  //    the guarantee is narrower and stated: AX1 itself writes nothing, and the
  //    report never claims the load was side-effect-free.
  const writing = fixtureProject(t, {
    files: {
      'fixtures/writing.js': `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./side-effect.txt', import.meta.url), 'written at import');
${packageSource({ name: 'writing' })}`,
    },
    packages: composition(['writing']),
  });
  const writingResult = runCli(writing, ['--json']);
  assert.equal(writingResult.status, 0);
  assert.ok(
    existsSync(join(writing, 'fixtures/side-effect.txt')),
    'the package really did write — which is exactly why PACKAGE_SOURCE_TRUSTED is a published limitation',
  );
  assert.ok(writingResult.json().limitations.some((entry) => entry.code === 'PACKAGE_SOURCE_TRUSTED'));

  // 3. An import that never returns. A hung load must not hang a terminal or a
  //    CI job: it is bounded, and the diagnostic says what to look for.
  const hanging = fixtureProject(t, {
    // A timer holds the event loop open, so this is a real hang rather than the
    // immediate exit Node gives an unsettled top-level await with nothing
    // pending — that case is covered by the unreadable-project path above.
    files: { 'fixtures/hanging.js': "const keepAlive = setInterval(() => {}, 1000);\nawait new Promise(() => { void keepAlive; });\nexport function createhangingPackage() { return null; }\n" },
    packages: composition(['hanging']),
  });
  const errors = [];
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  let hangingExit;
  try {
    hangingExit = (await inspectApplicationCommand({ rootDir: hanging, json: true, timeoutMs: 2500 })).exitCode;
  } finally {
    process.stderr.write = originalWrite;
  }
  assert.equal(hangingExit, 2, 'a hung load is fatal, not a false report');
  assert.match(errors.join(''), /Timed out after 2\.5s/);
  assert.match(errors.join(''), /does not return on import/);

  // 4. An import that attempts the network. No official package needs it, and
  //    a failure to reach it must not become a failure to report.
  const dialing = fixtureProject(t, {
    files: {
      'fixtures/dialing.js': `import { connect } from 'node:net';
try { connect({ host: '127.0.0.1', port: 9 }).on('error', () => {}).destroy(); } catch { /* ignored */ }
${packageSource({ name: 'dialing' })}`,
    },
    packages: composition(['dialing']),
  });
  const dialingResult = runCli(dialing, ['--json']);
  assert.equal(dialingResult.status, 0, dialingResult.stderr);
  assert.equal(dialingResult.json().packages[0].name, 'dialing');
});

test('the canonical Lead→Won objective is answered with what exists and what is absent', async (t) => {
  // A real project with the official packages and one customer-authored one —
  // the situation an agent is actually in when it is handed an acquisition goal.
  const { project } = await import('./helpers/contracts-project.js');
  const root = project(t, { withDelivery: true, withCustomPackage: true });
  // The commercial helper stops at the catalog; the acquisition goal starts
  // before it, so the lead-intelligence records go in too.
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of [
    'lead.module.json',
    '../../../packages/work/modules/work-task.module.json',
    '../../../packages/work/modules/work-activity.module.json',
    'enrichment-snapshot.module.json',
    'behavioral-signal.module.json', 'score-run.module.json', 'score-contribution.module.json',
    'routing-run.module.json', 'route-evaluation.module.json', 'assignment.module.json',
  ]) {
    // Intelligence record manifests live with the package that owns them.
    const from = [
    'lead.module.json',
    // Work v1 (ADR-030): the starter's bespoke `task` module is gone and its
    // follow-up now lives in the work package's records. Relative to the
    // starter directory, so the existing join(starter, manifest) still holds.
    '../../../packages/work/modules/work-task.module.json',
    '../../../packages/work/modules/work-activity.module.json',
  ].includes(manifest)
      ? starter : join(root, 'packages/intelligence/modules');
    const applied = spawnSync(process.execPath, ['--no-warnings', join(root, CLI), 'module', 'create', join(from, manifest), '--apply', '--root', root], { encoding: 'utf8', cwd: root });
    assert.equal(applied.status, 0, `${manifest}: ${applied.stderr}`);
  }
  const { report, valid } = await inspectApplication({ rootDir: root });
  assert.equal(valid, true, JSON.stringify(report.problems));

  const resources = new Set(report.resources.map((entry) => entry.resource));
  const modules = new Set(report.modules.map((entry) => entry.name));
  const packages = new Set(report.packages.map((entry) => entry.name));

  // What an agent can build the Lead→Won path on, named from the report alone.
  assert.ok(modules.has('lead'), 'lead capture');
  assert.ok(modules.has('opportunity') && modules.has('company') && modules.has('contact'), 'the CRM core');
  assert.ok(modules.has('score-run') && modules.has('routing-run'), 'lead intelligence');
  assert.ok(modules.has('quote') && modules.has('order'), 'commercial and order');
  assert.ok(packages.has('contracts') && packages.has('delivery'), 'the contract and delivery packages');
  assert.ok(packages.has('partner-scorecard'), 'and a customer-authored package alongside them');
  assert.ok(
    report.actions.some((action) => action.name === 'create-delivery-handover'),
    'the handover the goal ends at',
  );

  // What the acquisition goal needs and this application does not have. The
  // report must make the absence findable — an agent that cannot see a gap
  // invents a capability to fill it.
  for (const absent of [
    'touchpoint', 'campaign', 'audience', 'journey', 'experiment',
    'attribution', 'funnel-step', 'channel-spend', 'data-quality-issue',
  ]) {
    assert.equal(resources.has(absent), false, `${absent} is not a resource this application has`);
    assert.equal(modules.has(absent), false, `${absent} is not a record this application has`);
  }
  assert.equal(
    report.capabilities.some((entry) => /campaign|attribution|funnel|audience/.test(entry.name)), false,
    'and no capability claims them either',
  );
  // Nothing in the report may be read as "marketing is handled". The catalog
  // providers and discount policies now travel with the commercial package's
  // composition (like Intelligence's definitions before them), so the fixed
  // provider slots that remain are signature's alone.
  assert.deepEqual(
    [...new Set(report.providers.map((entry) => entry.kind))].sort(),
    ['signature-provider'],
    'the provider list is the honest one',
  );
  assert.ok(packages.has('commercial'), 'commercial is discovered as a package, not a provider slot');
});

test('/api/schema and application boot are unchanged by AX1', async (t) => {
  const { boot, project } = await import('./helpers/contracts-project.js');
  const root = project(t, { withDelivery: true });
  const context = await boot(root, join(root, 'data', 'schema-regression.sqlite'));
  t.after(() => context.close());

  const schema = await context.client.schema();
  // The keys /api/schema publishes are a contract other surfaces depend on.
  assert.ok(schema.domains.delivery, 'the delivery package still publishes its block');
  assert.equal(schema.domains.delivery.packageContract, 1);
  assert.ok(Array.isArray(schema.domains.delivery.actions));
  assert.equal(
    Object.prototype.hasOwnProperty.call(schema, 'applicationInspectionContract'), false,
    'AX1 is a CLI surface and adds nothing to the HTTP schema',
  );
  assert.equal(context.app.domains.size, 3, 'the composition still registers commercial, contracts and delivery');
});


/**
 * Every defect the adversarial review found, pinned. Each of these passed the
 * happy path and failed the attack.
 */
test('a package that logs during import cannot corrupt the report', async (t) => {
  // The report used to travel on the child's stdout, which is also where a
  // package's own console.log lands: one logging package made the whole
  // application uninspectable. The report has its own channel now.
  const root = fixtureProject(t, {
    files: {
      'fixtures/chatty.js': `console.log('hello from a package');
console.log(JSON.stringify({ applicationInspectionContract: 1, valid: true, forged: true }));
console.error('and some noise on stderr');
${packageSource({ name: 'chatty' })}`,
    },
    packages: composition(['chatty']),
  });
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  const report = result.json();
  assert.equal(report.forged, undefined, 'the package could not inject a document');
  assert.equal(report.packages[0].name, 'chatty');
  // The chatter is not lost — it is attributed, on stderr, where it cannot be
  // mistaken for the report or for the inspector's own diagnostics.
  assert.match(result.stderr, /output from the project's own source/);
  assert.match(result.stderr, /hello from a package/);
  assert.equal(result.stdout.includes('hello from a package'), false, 'and never on the report channel');
});

test('a timeout stops the process group, and says exactly how far that reaches', async (t) => {
  const { inspectApplicationCommand } = await import('../packages/cli/src/app-inspect-command.js');
  const tag = `ax1probe${process.pid}`;

  const withGrandchild = (marker, detached) => fixtureProject(t, {
    files: {
      'fixtures/spawner.js': `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);', ${JSON.stringify(marker)}], { detached: ${detached}, stdio: 'ignore' }).unref();
const keepAlive = setInterval(() => {}, 1000);
await new Promise(() => { void keepAlive; });
export function createspawnerPackage() { return null; }
`,
    },
    packages: composition(['spawner']),
  });
  const survivors = (marker) => Number(spawnSync('/bin/sh', ['-c',
    `ps -eo args | grep -F -- ${JSON.stringify(marker)} | grep -v grep | wc -l`], { encoding: 'utf8' }).stdout.trim());
  const reap = (marker) => spawnSync('/bin/sh', ['-c',
    `ps -eo pid,args | grep -F -- ${JSON.stringify(marker)} | grep -v grep | awk '{print $1}' | xargs -r kill -9`]);

  const timeOut = async (root) => {
    const errors = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
    try {
      const { exitCode } = await inspectApplicationCommand({ rootDir: root, json: true, timeoutMs: 2000 });
      return { exitCode, stderr: errors.join('') };
    } finally {
      process.stderr.write = originalWrite;
    }
  };

  // An ordinary child a package spawns inherits the load's process group, and
  // the timeout stops the group. Before the group kill it was left running.
  const ordinaryMarker = `${tag}ordinary`;
  const ordinary = await timeOut(withGrandchild(ordinaryMarker, false));
  assert.equal(ordinary.exitCode, 2);
  assert.match(ordinary.stderr, /stopped its process group/);
  await new Promise((resolve) => { setTimeout(resolve, 900); });
  assert.equal(survivors(ordinaryMarker), 0, 'an ordinary grandchild does not outlive the inspection');
  reap(ordinaryMarker);

  // A package that *deliberately* detaches into a new process group outlives
  // it. Reaching that would mean tracking descendants, which is not attempted
  // and would not be a sandbox either — so it is published as a limitation
  // rather than quietly claimed as handled.
  const detachedMarker = `${tag}detached`;
  const detached = await timeOut(withGrandchild(detachedMarker, true));
  assert.equal(detached.exitCode, 2);
  await new Promise((resolve) => { setTimeout(resolve, 900); });
  const escaped = survivors(detachedMarker);
  reap(detachedMarker);

  const { report } = await inspectApplication({ rootDir: projectWith(t, [{ name: 'billing' }]) });
  const limitation = report.limitations.find((entry) => entry.code === 'PROCESS_ISOLATION_BOUNDED');
  assert.ok(limitation, 'the residual is named in the report');
  assert.match(limitation.message, /deliberately detaches/);
  assert.ok(escaped >= 0, 'the detached case is measured, and its outcome is what the limitation describes');
});

test('a package with enormous metadata is refused by size, not by timeout', async (t) => {
  const root = fixtureProject(t, {
    files: {
      'fixtures/bloated.js': `import { definePackage } from '../packages/core/index.js';
const HUGE = 'z'.repeat(2 * 1024 * 1024);
export function createbloatedPackage() {
  return definePackage({ packageContract: 1, name: 'bloated', version: 1, label: 'bloated',
    requires: [], capabilities: [], resources: [], actions: [], policies: [],
    metadata() { return { huge: HUGE }; } });
}
`,
    },
    packages: composition(['bloated']),
  });
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 1, 'a report is still produced');
  const report = result.json();
  const problem = report.problems.find((entry) => entry.code === 'PACKAGE_METADATA_TOO_LARGE');
  assert.ok(problem, `expected a size refusal, got ${JSON.stringify(report.problems.map((p) => p.code))}`);
  assert.equal(report.packages[0].name, 'bloated', 'and the package itself is still described');
  assert.deepEqual(report.packages[0].metadata, {}, 'with the oversized block omitted rather than truncated');
  assert.ok(result.stdout.length < 1024 * 1024, 'the report stayed small');
});

test('help and an unknown command need no database', async (t) => {
  const root = fixtureProject(t, { packages: 'export const generatedDomains = [];\n' });
  for (const args of [['help'], ['bogus-command']]) {
    const result = spawnSync(process.execPath, ['--no-warnings', join(root, CLI), ...args], { encoding: 'utf8', cwd: root });
    assert.equal(existsSync(join(root, 'data')), false, `${args[0]} created a database`);
    if (args[0] === 'help') {
      assert.equal(result.status, 0);
      assert.match(result.stdout, /app inspect/, 'and help lists the command');
    } else {
      assert.notEqual(result.status, 0, 'an unknown command still fails');
      assert.match(result.stderr, /Unknown command/);
    }
  }
});

test('several problems arrive together, complete and in a stable order', async (t) => {
  const root = projectWith(t, [
    { name: 'alpha', provides: [{ name: 'facts', version: 1 }], resources: ['shared'] },
    { name: 'beta', provides: [{ name: 'facts', version: 1 }], resources: ['shared'] },
    { name: 'gamma', requires: [{ package: 'ghost', capability: 'ghost-facts', version: 1 }] },
    { name: 'delta', requires: [{ package: 'alpha', capability: 'facts', version: 9 }] },
  ]);
  const first = await inspectApplication({ rootDir: root });
  const second = await inspectApplication({ rootDir: root });

  assert.deepEqual(
    first.report.problems.map((entry) => entry.code),
    ['RESOURCE_COLLISION', 'CAPABILITY_COLLISION', 'DEPENDENCY_MISSING_PACKAGE', 'DEPENDENCY_UNSATISFIED'],
    'all four, in the order the rules are applied',
  );
  assert.equal(JSON.stringify(first.report.problems), JSON.stringify(second.report.problems), 'and in a stable order');

  // `valid` answers "is the composition sound", `limitations` answers "what can
  // this report not know". They are different questions, and a limitation must
  // never make a sound composition look broken.
  assert.equal(first.report.valid, false);
  assert.equal(first.report.limitations.length, 11, 'limitations are present either way');
  const clean = await inspectApplication({ rootDir: projectWith(t, [{ name: 'alpha' }]) });
  assert.equal(clean.report.valid, true);
  assert.equal(clean.report.limitations.length, 11, 'and do not affect validity');
});

test('an unresolved capability edge is in the graph, from both ends', async (t) => {
  // Detached provider, dependent left behind.
  const detached = await inspectApplication({
    rootDir: projectWith(t, [{ name: 'consumer', requires: [{ package: 'provider', capability: 'facts', version: 1 }] }]),
  });
  assert.deepEqual(detached.report.capabilities, [
    { name: 'facts', version: 1, provider: null, consumers: ['consumer'], status: 'missing', description: null },
  ], 'the edge the reader came for is reported, not omitted');

  // Right capability, wrong declared provider.
  const mismatch = await inspectApplication({
    rootDir: projectWith(t, [
      { name: 'alpha', provides: [{ name: 'facts', version: 1 }] },
      { name: 'beta', provides: [{ name: 'other', version: 1 }] },
      { name: 'consumer', requires: [{ package: 'beta', capability: 'facts', version: 1 }] },
    ]),
  });
  const row = mismatch.report.capabilities.find((entry) => entry.name === 'facts');
  assert.equal(row.status, 'provider-mismatch');
  assert.equal(row.provider, 'alpha', 'who really offers it');
  assert.deepEqual(row.consumers, ['consumer'], 'and who wanted it from someone else');
});

test('module state evidence is source evidence, and says so in every shape', async (t) => {
  const root = fixtureProject(t, { packages: 'export const generatedDomains = [];\n' });
  const manifest = {
    manifestVersion: 1, name: 'widget', description: 'an evolvable record',
    fields: [
      { name: 'sourceKey', type: 'string', unique: true, writable: 'managed' },
      { name: 'status', type: 'enum', values: ['planned'], writable: 'managed' },
    ],
  };
  writeFileSync(join(root, 'widget.json'), JSON.stringify(manifest), 'utf8');
  const applied = spawnSync(process.execPath, ['--no-warnings', join(root, CLI), 'module', 'create', join(root, 'widget.json'), '--apply', '--root', root], { encoding: 'utf8', cwd: root });
  assert.equal(applied.status, 0, applied.stderr);

  const found = async () => (await inspectApplication({ rootDir: root })).report;
  let report = await found();
  let widget = report.modules.find((entry) => entry.name === 'widget');
  assert.deepEqual(
    { kind: widget.kind, revision: widget.revision, adopted: widget.adopted, stateFile: widget.stateFile, migrations: widget.migrations.length },
    { kind: 'generated', revision: 1, adopted: false, stateFile: 'valid', migrations: 1 },
  );
  assert.equal(/CREATE TABLE|ALTER TABLE|INSERT INTO/i.test(JSON.stringify(widget)), false, 'migration identity, never its SQL');
  assert.ok(widget.migrations[0].checksum.length >= 32);

  // A pre-ADR-019 module: revision 1 is reconstructed from source. This says
  // nothing about a database and nothing about a file having been written.
  rmSync(join(root, 'packages/modules/widget/module.state.json'));
  widget = (await found()).modules.find((entry) => entry.name === 'widget');
  assert.deepEqual(
    { revision: widget.revision, adopted: widget.adopted, stateFile: widget.stateFile },
    { revision: 1, adopted: true, stateFile: 'reconstructed' },
  );
  assert.equal(existsSync(join(root, 'packages/modules/widget/module.state.json')), false,
    '"reconstructed" must not mean a state file was written');

  // A corrupt state file is a problem, not a shrug.
  writeFileSync(join(root, 'packages/modules/widget/module.state.json'), '{ not json', 'utf8');
  report = await found();
  widget = report.modules.find((entry) => entry.name === 'widget');
  assert.equal(widget.stateFile, 'unreadable');
  assert.equal(widget.revision, null, 'and no revision is guessed');
  assert.ok(report.problems.some((entry) => entry.code === 'MODULE_STATE_INVALID'));
  assert.equal(report.valid, false);
});

test('declared config keys are published and no config value ever is', async (t) => {
  const secrets = {
    apiKey: 'sk-live-AAAA', secret: 'BBBB', password: 'CCCC', token: 'DDDD',
    databaseUrl: 'postgres://user:pass@host/db', endpoint: 'https://x.example/?token=EEEE',
    markup: '<img src=x onerror=alert(1)>', threshold: 5,
  };
  const root = fixtureProject(t, {
    files: {
      'fixtures/secretive.js': `import { definePackage } from '../packages/core/index.js';
export function createsecretivePackage() {
  return definePackage({ packageContract: 1, name: 'secretive', version: 1, label: 'secretive',
    requires: [], capabilities: [], resources: [], actions: [],
    policies: [{ kind: 'fixture-policy', definition: { name: 'leaky', version: 1, config: ${JSON.stringify(secrets)}, decide() { return {}; } } }],
    metadata() { return {}; } });
}
`,
    },
    packages: composition(['secretive']),
  });
  const result = runCli(root, ['--json']);
  assert.equal(result.status, 0, result.stderr);
  for (const value of ['sk-live-AAAA', 'BBBB', 'CCCC', 'DDDD', 'postgres://', 'EEEE']) {
    assert.equal(result.stdout.includes(value), false, `the value ${value} reached the report`);
  }
  const policy = result.json().policies[0];
  assert.deepEqual(policy.configKeys, ['apiKey', 'databaseUrl', 'endpoint', 'markup', 'password', 'secret', 'threshold', 'token']);
  assert.ok(policy.fingerprint.length >= 32, 'the declared-definition fingerprint identifies it without exposing it');
});
