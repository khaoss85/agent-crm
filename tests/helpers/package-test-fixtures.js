import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Throwaway projects and deliberately broken packages for the `crm package test`
 * suite.
 *
 * Every fixture here is a package that should NOT conform, or should conform in
 * an awkward way. They live in a temporary project rather than in the
 * repository because a package that hangs on import, floods a stream or calls
 * `process.exit` is not something the repository should carry — and because a
 * fixture inside `packages/` would be picked up by the composition scanners of
 * every other suite.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The variables `os.tmpdir()` consults, in the order it consults them. */
const TEMP_VARS = Object.freeze(['TMPDIR', 'TMP', 'TEMP']);

/**
 * A temporary directory this test alone owns, installed as the process's temp
 * directory for the duration of the test.
 *
 * It exists so a test can assert on scratch directories *it* created rather
 * than on the machine's. `mkdtemp` names are unique but the directory holding
 * them is shared: the OS temp directory also carries the live scratch of every
 * other Accordo process on the box — a second test runner, a parallel CI job,
 * an agent working in another checkout — so a test that lists it is reading
 * state it does not own and fails for work it never did.
 *
 * `os.tmpdir()` re-reads these variables on every call and a child process
 * inherits them, so pointing them here moves the scratch of this process *and*
 * of everything it spawns into a directory with exactly one author. Nothing
 * outside that directory is ever listed or removed.
 *
 * The previous values are restored afterwards, so the redirection cannot leak
 * into a sibling test.
 *
 * @param {import('node:test').TestContext} t
 */
export function ownedTempRoot(t) {
  const previous = TEMP_VARS.map((name) => /** @type {const} */ ([name, process.env[name]]));
  const root = mkdtempSync(join(tmpdir(), 'accordo-owned-tmp-'));
  for (const name of TEMP_VARS) process.env[name] = root;
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

/**
 * A minimal project: the framework, its apps and the manifest. The checked-in
 * composition files come with `packages/` and stay at their empty defaults,
 * which is exactly what `crm package test` expects to find.
 *
 * @param {import('node:test').TestContext} t
 */
export function fixtureProject(t, { name = 'accordo-package-fixture-' } = {}) {
  const root = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  return root;
}

/**
 * Write a package into a project.
 *
 * @param {string} root @param {string} packageName @param {string} source
 * @param {{modules?: Record<string, unknown>}} [extras]
 */
export function writeFixturePackage(root, packageName, source, extras = {}) {
  const dir = join(root, 'packages', packageName);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'index.js'), source);
  if (extras.modules) {
    mkdirSync(join(dir, 'modules'), { recursive: true });
    for (const [file, manifest] of Object.entries(extras.modules)) {
      writeFileSync(join(dir, 'modules', file), `${JSON.stringify(manifest, null, 2)}\n`);
    }
  }
  return dir;
}

/** The import specifier a fixture package uses to reach the public kernel. */
export const KERNEL = "'../../core/index.js'";

/** A package that is entirely well-formed — the control for every other case. */
export const WELL_FORMED = `// @ts-check
import { definePackage } from ${KERNEL};
export function createFixturePackage() {
  return definePackage({
    packageContract: 1,
    name: 'fixture-ok',
    label: 'Fixture',
    version: 1,
    resources: [],
    actions: [],
    metadata() { return { fixtureContract: 1 }; },
  });
}
`;

/** Each entry is [directory name, source, what it is meant to prove]. */
export const HOSTILE_PACKAGES = Object.freeze([
  ['fixture-no-definition', `// @ts-check
export const notAPackage = { hello: 'world' };
`, 'a module that exports no package definition at all'],

  ['fixture-throws-on-import', `// @ts-check
throw new Error('this package explodes at /home/somebody/secret/path on import');
`, 'a module body that throws while being imported'],

  ['fixture-bad-contract', `// @ts-check
export const fixturePackage = {
  packageContract: 99,
  name: 'fixture-bad-contract',
  label: 'Fixture',
  version: 1,
  resources: [],
};
`, 'a package declaring a contract version the framework does not support'],

  ['fixture-bad-name', `// @ts-check
export const fixturePackage = {
  packageContract: 1,
  name: 'Fixture Bad Name',
  label: 'Fixture',
  version: 1,
  resources: [],
};
`, 'a package name that is not a canonical identifier'],

  ['fixture-private-import', `// @ts-check
import { definePackage } from ${KERNEL};
import { canonicalJson } from "../../core/src/solution-plan.js";
export function createFixturePackage() {
  void canonicalJson;
  return definePackage({
    packageContract: 1, name: 'fixture-private-import', label: 'Fixture', version: 1, resources: [],
  });
}
`, 'a package reaching into a private kernel path — with a double-quoted specifier'],

  ['fixture-eval', `// @ts-check
import { definePackage } from ${KERNEL};
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-eval', label: 'Fixture', version: 1, resources: [],
    metadata() { return { computed: eval('1 + 1') }; },
  });
}
`, 'a package that builds behaviour at runtime'],

  ['fixture-missing-dependency', `// @ts-check
import { definePackage } from ${KERNEL};
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-missing-dependency', label: 'Fixture', version: 1,
    resources: [],
    requires: [{ package: 'no-such-package', capability: 'nothing', version: 1 }],
  });
}
`, 'a declared dependency on a package this project does not have'],

  ['fixture-unstable-metadata', `// @ts-check
import { definePackage } from ${KERNEL};
let calls = 0;
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-unstable-metadata', label: 'Fixture', version: 1,
    resources: [],
    metadata() { calls += 1; return { renderedTimes: calls }; },
  });
}
`, 'metadata that renders differently every time it is asked'],

  ['fixture-noisy', `// @ts-check
import { definePackage } from ${KERNEL};
for (let index = 0; index < 4000; index += 1) {
  console.log('fixture noise line ' + index + ' '.repeat(64));
  console.error('fixture stderr line ' + index);
}
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-noisy', label: 'Fixture', version: 1, resources: [],
  });
}
`, 'a package that floods stdout and stderr while importing'],

  ['fixture-exits', `// @ts-check
import { definePackage } from ${KERNEL};
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-exits', label: 'Fixture', version: 1, resources: [],
  });
}
if (process.env.ACCORDO_FIXTURE_BOOT !== 'no-exit') process.exit(7);
`, 'a package that calls process.exit while importing'],
]);

/** A package whose module body never returns — its own test, with a short timeout. */
export const HANGS = `// @ts-check
import { definePackage } from ${KERNEL};
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-hangs', label: 'Fixture', version: 1, resources: [],
  });
}
await new Promise(() => {});
`;

/** A package that owns a record and offers a capability — the provider in a graph. */
export const provider = (name, { capability = 'thing', version = 1, resources = [`${name}-record`] } = {}) => `// @ts-check
import { definePackage } from ${KERNEL};
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: '${name}', label: '${name}', version: 1,
    resources: ${JSON.stringify(resources)},
    capabilities: [{ name: '${capability}', version: ${version}, create: () => ({ read: () => [] }) }],
  });
}
`;

/** A consumer with an arbitrary declared dependency list and action targets. */
export const consumer = (name, { requires = [], targets = [], resources = [] } = {}) => `// @ts-check
import { definePackage } from ${KERNEL};
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: '${name}', label: '${name}', version: 1,
    resources: ${JSON.stringify(resources)},
    requires: ${JSON.stringify(requires)},
    actions: ${JSON.stringify(targets)}.map((module) => ({
      module, name: 'touch', label: 'Touch', actionContract: 1, input: [],
      execute: async () => ({ ok: true }),
    })),
  });
}
`;

/** A minimal module manifest for a record a fixture package owns. */
export const manifestFor = (record) => ({
  manifestVersion: 1,
  name: record,
  fields: [{ name: 'label', type: 'string', required: true }],
});

/** Packages that probe what the harness can and cannot promise about isolation. */
export const SCRATCH_PROBES = Object.freeze([
  ['fixture-reads-env', `// @ts-check
import { definePackage } from ${KERNEL};
const marker = process.env.ACCORDO_SCRATCH_MARKER ?? 'absent';
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-reads-env', label: 'Fixture', version: 1, resources: [],
    metadata() { return { sawMarker: marker }; },
  });
}
`, 'a package that reads the environment while importing'],

  ['fixture-writes-beside-source', `// @ts-check
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { definePackage } from ${KERNEL};
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'wrote-beside-source.txt'), 'here');
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-writes-beside-source', label: 'Fixture', version: 1, resources: [],
  });
}
`, 'a package that writes next to its own source while importing'],

  ['fixture-spawns-child', `// @ts-check
import { spawn } from 'node:child_process';
import { definePackage } from ${KERNEL};
spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-spawns-child', label: 'Fixture', version: 1, resources: [],
  });
}
`, 'a package that spawns an ordinary short-lived child while importing'],
]);

/**
 * A package that spawns a child which outlives the import.
 *
 * This is the timeout path, and it is the honest one: the reporting process
 * cannot exit while it holds a live child handle, so the run is stopped by the
 * timeout and the whole process group — grandchild included — goes with it.
 */
export const SPAWNS_LONG_LIVED_CHILD = `// @ts-check
import { spawn } from 'node:child_process';
import { definePackage } from ${KERNEL};
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600000)'], { stdio: 'ignore' });
export function createFixturePackage() {
  return definePackage({
    packageContract: 1, name: 'fixture-long-child', label: 'Fixture', version: 1, resources: [],
  });
}
`;
