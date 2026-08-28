// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAccordoApp } from '../packages/app/src/index.js';
import {
  DEPLOYMENT_STORAGE_CONTRACT,
  loadDeploymentStorage,
} from '../packages/core/src/deployment-storage.js';
import {
  IDENTITY_VERIFIER_CONTRACT,
  IDENTITY_VERIFIER_FACTORY,
  IDENTITY_VERIFIER_INIT_TIMEOUT_MS,
  IDENTITY_VERIFIER_OPERATIONS,
  prepareDeploymentPreconnect,
  resolveIdentityVerifier,
} from '../packages/core/src/identity-verifier.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const resolverHref = pathToFileURL(join(repoRoot, 'packages/core/src/identity-verifier.js')).href;

const SENTINEL_PASSWORD = 'SUPERSECRET_SENTINEL_PASSWORD';
const SENTINEL_TOKEN = 'SENTINEL_CONFIG_BYTES_DO_NOT_ECHO';
const roots = [];

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-verifier-preconnect-'));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function sqliteEnvelope(overrides = {}) {
  return {
    contract: 1,
    adapter: 'sqlite',
    connection: { path: './data/tenant.sqlite' },
    controlPlane: { path: './data/control.sqlite' },
    spine: { mode: 'production', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.mjs',
    ...overrides,
  };
}

function writeConfig(root, body, { mode = 0o600, name = 'deployment-storage.json' } = {}) {
  const filePath = join(root, name);
  const contents = typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`;
  writeFileSync(filePath, contents);
  chmodSync(filePath, mode);
  return filePath;
}

function writeModule(root, relativePath, source, { mode = 0o600 } = {}) {
  const filePath = join(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, source);
  chmodSync(filePath, mode);
  return filePath;
}

function leakHaystack(error) {
  const details = error && typeof error === 'object' ? /** @type {any} */ (error).details : undefined;
  return [
    String(error?.message ?? ''),
    String(error?.stack ?? ''),
    JSON.stringify(error),
    JSON.stringify(details),
    String(error),
  ].join('\n');
}

function assertCredentialFree(error, extras = []) {
  const haystack = leakHaystack(error);
  for (const token of [SENTINEL_PASSWORD, SENTINEL_TOKEN, ...extras]) {
    assert.equal(haystack.includes(token), false, `diagnostic leaked ${token}`);
  }
}

function assertCode(fn, code, extras = []) {
  let caught;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${code}`);
  assert.equal(/** @type {any} */ (caught).code, code);
  assertCredentialFree(caught, extras);
  return caught;
}

async function assertCodeAsync(fn, code, extras = []) {
  let caught;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught, `expected ${code}`);
  assert.equal(/** @type {any} */ (caught).code, code);
  assertCredentialFree(caught, extras);
  return caught;
}

const VALID_VERIFIER = [
  'export const identityVerifierContract = 2;',
  "export const identityVerifierTrust = 'production';",
  'export function createIdentityVerifier({ mode, signal } = {}) {',
  "  if (mode !== 'production') throw new Error('mode leaked into a fixture throw');",
  '  if (signal && signal.aborted) throw new Error(\'aborted\');',
  '  return {',
  "    verifyRequest() { throw new Error('verifyRequest is not invoked at pre-connect'); },",
  "    discoverControlResource() { throw new Error('provider-discover-must-not-run'); },",
  "    attestControlStartup() { throw new Error('provider-attest-must-not-run'); },",
  "    discoverDataResource() { throw new Error('provider-discover-must-not-run'); },",
  "    attestDataStartup() { throw new Error('provider-attest-must-not-run'); },",
  '  };',
  '}',
  '',
].join('\n');

const LOCAL_VERIFIER = VALID_VERIFIER.replaceAll("'production'", "'local-development'");

function countTcpServers() {
  const info = typeof process.getActiveResourcesInfo === 'function'
    ? process.getActiveResourcesInfo()
    : [];
  return info.filter((name) => name === 'TCPSERVERWRAP').length;
}

function mkfifo(filePath, mode = 0o600) {
  const result = spawnSync('mkfifo', ['-m', mode.toString(8), filePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'mkfifo failed');
}

test('M2-22 publishes a closed pre-connect contract and does not export it from the kernel', () => {
  assert.equal(IDENTITY_VERIFIER_CONTRACT, 2);
  assert.equal(IDENTITY_VERIFIER_FACTORY, 'createIdentityVerifier');
  assert.deepEqual([...IDENTITY_VERIFIER_OPERATIONS], [
    'verifyRequest',
    'discoverControlResource',
    'attestControlStartup',
    'discoverDataResource',
    'attestDataStartup',
  ]);
  assert.equal(IDENTITY_VERIFIER_INIT_TIMEOUT_MS, 2000);
  assert.equal(Object.isFrozen(IDENTITY_VERIFIER_OPERATIONS), true);

  const kernel = readFileSync(join(repoRoot, 'packages/core/index.js'), 'utf8');
  assert.equal(kernel.includes('identity-verifier'), false);
  assert.equal(kernel.includes('deployment-storage'), false);
  assert.equal(kernel.includes('trusted-file'), false);

  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.ok(app.modules);
  } finally {
    app.close();
  }
});

test('M2-22 loads a valid verifier before any database or listener exists', async () => {
  const root = scratch();
  writeModule(root, 'providers/identity-verifier.mjs', VALID_VERIFIER);
  const configPath = writeConfig(root, sqliteEnvelope());
  const serversBefore = countTcpServers();
  const started = Date.now();

  const prepared = await prepareDeploymentPreconnect({
    configPath,
    env: {},
    projectRoot: root,
  });

  assert.ok(Date.now() - started < 1000);
  assert.equal(prepared.selection.contract, DEPLOYMENT_STORAGE_CONTRACT);
  assert.equal(prepared.selection.adapter, 'sqlite');
  assert.equal(prepared.identityVerifier.contract, 2);
  assert.equal(prepared.identityVerifier.trust, 'production');
  assert.equal(typeof prepared.identityVerifier.operations.verifyRequest, 'function');
  assert.equal(countTcpServers(), serversBefore);
  assert.deepEqual(Object.keys(prepared.identityVerifier.operations).sort(), [...IDENTITY_VERIFIER_OPERATIONS].sort());
  assert.equal(Object.isFrozen(prepared.identityVerifier), true);
  assert.equal(Object.isFrozen(prepared.identityVerifier.operations), true);

  const resolvedHaystack = JSON.stringify(prepared.identityVerifier);
  assert.equal(resolvedHaystack.includes(root), false);
  assert.equal(resolvedHaystack.includes('identity-verifier.mjs'), false);

  const discoverError = assertCode(
    () => prepared.identityVerifier.operations.discoverControlResource(),
    'IDENTITY_VERIFIER_OPERATION_UNSUPPORTED',
    [root, SENTINEL_PASSWORD, 'provider-discover-must-not-run', 'provider-attest-must-not-run'],
  );
  assert.equal(leakHaystack(discoverError).includes(root), false);
  assertCode(
    () => prepared.identityVerifier.operations.attestControlStartup(),
    'IDENTITY_VERIFIER_OPERATION_UNSUPPORTED',
    [root, 'provider-attest-must-not-run'],
  );
  assertCode(
    () => prepared.identityVerifier.operations.discoverDataResource(),
    'IDENTITY_VERIFIER_OPERATION_UNSUPPORTED',
    [root, 'provider-discover-must-not-run'],
  );
  assertCode(
    () => prepared.identityVerifier.operations.attestDataStartup(),
    'IDENTITY_VERIFIER_OPERATION_UNSUPPORTED',
    [root, 'provider-attest-must-not-run'],
  );
});

test('M2-22 --db compatibility still does not resolve a verifier and does not connect', async () => {
  const prepared = await prepareDeploymentPreconnect({ dbPath: ':memory:', env: {} });
  assert.equal(prepared.selection.adapter, 'sqlite');
  assert.equal(prepared.selection.identityVerifier, null);
  assert.equal(prepared.identityVerifier, null);
});

test('M2-22 missing export, extra export, default v1 function and missing method refuse', async () => {
  const root = scratch();
  const extras = [root, SENTINEL_PASSWORD];

  writeModule(root, 'missing-export.mjs', [
    'export const identityVerifierContract = 2;',
    "export const identityVerifierTrust = 'production';",
    '',
  ].join('\n'));
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './missing-export.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_INVALID', extras);

  writeModule(root, 'extra-export.mjs', `${VALID_VERIFIER}\nexport const extra = true;\n`);
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './extra-export.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_INVALID', extras);

  writeModule(root, 'v1-default.mjs', [
    'export const identityVerifierContract = 2;',
    "export const identityVerifierTrust = 'production';",
    'export default function verifyRequest() { return null; }',
    'export function createIdentityVerifier() {',
    '  return {',
    '    verifyRequest() {},',
    '    discoverControlResource() {},',
    '    attestControlStartup() {},',
    '    discoverDataResource() {},',
    '    attestDataStartup() {},',
    '  };',
    '}',
    '',
  ].join('\n'));
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './v1-default.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_INVALID', extras);

  writeModule(root, 'missing-method.mjs', [
    'export const identityVerifierContract = 2;',
    "export const identityVerifierTrust = 'production';",
    'export function createIdentityVerifier() {',
    '  return {',
    '    verifyRequest() {},',
    '    discoverControlResource() {},',
    '    attestControlStartup() {},',
    '    discoverDataResource() {},',
    '  };',
    '}',
    '',
  ].join('\n'));
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './missing-method.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_INVALID', extras);

  writeModule(root, 'extra-method.mjs', [
    'export const identityVerifierContract = 2;',
    "export const identityVerifierTrust = 'production';",
    'export function createIdentityVerifier() {',
    '  return {',
    '    verifyRequest() {},',
    '    discoverControlResource() {},',
    '    attestControlStartup() {},',
    '    discoverDataResource() {},',
    '    attestDataStartup() {},',
    "    connect() { throw new Error('must-not-connect'); },",
    '  };',
    '}',
    '',
  ].join('\n'));
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './extra-method.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_INVALID', [...extras, 'must-not-connect']);
});

test('M2-22 wrong contract version refuses before the factory runs', async () => {
  const root = scratch();
  writeModule(root, 'wrong-version.mjs', [
    'export const identityVerifierContract = 1;',
    "export const identityVerifierTrust = 'production';",
    'export function createIdentityVerifier() {',
    "  throw new Error('factory-must-not-run');",
    '}',
    '',
  ].join('\n'));
  const error = await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './wrong-version.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_CONTRACT_UNSUPPORTED', [root, 'factory-must-not-run', SENTINEL_PASSWORD]);
  assert.equal(leakHaystack(error).includes('wrong-version'), false);
});

test('M2-22 production and local verifiers are not interchangeable', async () => {
  const root = scratch();
  writeModule(root, 'production.mjs', VALID_VERIFIER);
  writeModule(root, 'local.mjs', LOCAL_VERIFIER);

  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './production.mjs',
    projectRoot: root,
    mode: 'local-development',
  }), 'IDENTITY_VERIFIER_INVALID', [root]);

  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './local.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_INVALID', [root]);
});

test('M2-22 throwing import and throwing factory refuse without echoing the thrown text', async () => {
  const root = scratch();
  writeModule(root, 'throw-import.mjs', `throw new Error('${SENTINEL_PASSWORD}');\n`);
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './throw-import.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_INIT_FAILED', [root, SENTINEL_PASSWORD, 'throw-import.mjs']);

  writeModule(root, 'throw-factory.mjs', [
    'export const identityVerifierContract = 2;',
    "export const identityVerifierTrust = 'production';",
    'export function createIdentityVerifier() {',
    `  throw new Error('${SENTINEL_TOKEN}');`,
    '}',
    '',
  ].join('\n'));
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './throw-factory.mjs',
    projectRoot: root,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_INIT_FAILED', [root, SENTINEL_TOKEN, 'throw-factory.mjs']);
});

test('M2-22 symlink, traversal, absolute, NUL, FIFO and world-readable files refuse', async () => {
  const root = scratch();
  const projectRoot = join(root, 'project');
  mkdirSync(projectRoot);
  const extras = [root, projectRoot, SENTINEL_PASSWORD];
  writeModule(projectRoot, 'providers/identity-verifier.mjs', VALID_VERIFIER);
  writeModule(root, 'outside.mjs', VALID_VERIFIER);

  const linked = join(projectRoot, 'providers', 'link.mjs');
  symlinkSync(join(projectRoot, 'providers/identity-verifier.mjs'), linked);
  extras.push(linked);
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './providers/link.mjs',
    projectRoot,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_UNTRUSTED', extras);

  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: '../outside.mjs',
    projectRoot,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_UNTRUSTED', extras);

  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: join(projectRoot, 'providers/identity-verifier.mjs'),
    projectRoot,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_UNTRUSTED', extras);

  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './has\0nul.mjs',
    projectRoot,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_UNTRUSTED', extras);

  const fifoPath = join(projectRoot, 'providers', 'fifo.mjs');
  mkfifo(fifoPath, 0o600);
  const started = Date.now();
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './providers/fifo.mjs',
    projectRoot,
    mode: 'production',
    timeoutMs: 250,
  }), 'IDENTITY_VERIFIER_UNTRUSTED', [...extras, fifoPath]);
  assert.ok(Date.now() - started < 500, 'verifier FIFO open hung');

  writeModule(projectRoot, 'providers/world.mjs', VALID_VERIFIER, { mode: 0o644 });
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './providers/world.mjs',
    projectRoot,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_UNTRUSTED', extras);

  symlinkSync(root, join(projectRoot, 'providers', 'escape-dir'));
  await assertCodeAsync(() => resolveIdentityVerifier({
    relativePath: './providers/escape-dir/outside.mjs',
    projectRoot,
    mode: 'production',
  }), 'IDENTITY_VERIFIER_UNTRUSTED', extras);
});

function writeHangRunner(root, relativePath, timeoutMs) {
  const runner = join(root, 'run-hang.mjs');
  writeFileSync(runner, [
    `import { resolveIdentityVerifier } from ${JSON.stringify(resolverHref)};`,
    `const started = Date.now();`,
    `const watchdog = setTimeout(() => {`,
    `  console.log(JSON.stringify({ ok: false, code: 'WATCHDOG', ms: Date.now() - started }));`,
    `  process.exit(2);`,
    `}, ${timeoutMs + 500});`,
    `try {`,
    `  await resolveIdentityVerifier({`,
    `    relativePath: ${JSON.stringify(relativePath)},`,
    `    projectRoot: ${JSON.stringify(root)},`,
    `    mode: 'production',`,
    `    timeoutMs: ${timeoutMs},`,
    `  });`,
    `  clearTimeout(watchdog);`,
    `  console.log(JSON.stringify({ ok: true, ms: Date.now() - started }));`,
    `  process.exit(0);`,
    `} catch (error) {`,
    `  clearTimeout(watchdog);`,
    `  console.log(JSON.stringify({`,
    `    ok: false,`,
    `    code: error && error.code,`,
    `    ms: Date.now() - started,`,
    `    message: String(error && error.message || ''),`,
    `  }));`,
    `  process.exit(1);`,
    `}`,
    '',
  ].join('\n'));
  return runner;
}

function runHangChild(root, relativePath, timeoutMs = 150) {
  const runner = writeHangRunner(root, relativePath, timeoutMs);
  const started = Date.now();
  const child = spawnSync(process.execPath, ['--no-warnings', runner], {
    encoding: 'utf8',
    timeout: timeoutMs + 2000,
    cwd: root,
    env: { ...process.env, ACCORDO_HANG_SENTINEL: SENTINEL_PASSWORD },
  });
  const elapsed = Date.now() - started;
  assert.notEqual(child.status, 0, child.stdout + child.stderr);
  assert.ok(elapsed < timeoutMs + 1000, `hang child lived ${elapsed}ms`);
  const parsed = JSON.parse((child.stdout || '').trim().split('\n').at(-1) || '{}');
  assert.equal(parsed.code, 'IDENTITY_VERIFIER_TIMEOUT');
  assert.notEqual(parsed.code, 'WATCHDOG');
  const haystack = `${child.stdout}\n${child.stderr}\n${JSON.stringify(parsed)}`;
  for (const token of [SENTINEL_PASSWORD, SENTINEL_TOKEN, root]) {
    assert.equal(haystack.includes(token), false, `hang diagnostic leaked ${token}`);
  }
  return parsed;
}

test('M2-22 hanging factory times out without a listener or credential echo', { timeout: 5000 }, () => {
  const root = scratch();
  writeModule(root, 'hang-factory.mjs', [
    'export const identityVerifierContract = 2;',
    "export const identityVerifierTrust = 'production';",
    'export function createIdentityVerifier() {',
    '  return new Promise(() => {});',
    '}',
    '',
  ].join('\n'));
  runHangChild(root, './hang-factory.mjs');
});

test('M2-22 top-level await that never settles times out in a child process', { timeout: 5000 }, () => {
  const root = scratch();
  writeModule(root, 'hang-toplevel.mjs', 'await new Promise(() => {});\n');
  runHangChild(root, './hang-toplevel.mjs');
});

test('M2-22 parser still does not import the verifier; resolution lives in the sibling module', () => {
  const parser = readFileSync(join(repoRoot, 'packages/core/src/deployment-storage.js'), 'utf8');
  assert.equal(/import\(/.test(parser), false);
  assert.equal(/pathToFileURL/.test(parser), false);
  assert.equal(parser.includes('identity-verifier.js'), false);

  const resolver = readFileSync(join(repoRoot, 'packages/core/src/identity-verifier.js'), 'utf8');
  assert.equal(/import\(/.test(resolver), true);
  assert.equal(/pathToFileURL/.test(resolver), true);
  assert.equal(/net\.connect|tls\.connect|createConnection|createServer/.test(resolver), false);
  assert.equal(resolver.includes('node:sqlite'), false);
  assert.equal(resolver.includes("from './database.js'"), false);
  assert.equal(resolver.includes('using '), false);
});

test('M2-22 does not wire CLI, serve or MCP and does not depend on a PostgreSQL driver', () => {
  const surfaces = [
    'packages/app/src/create-app.js',
    'packages/cli/src/commands.js',
    'packages/mcp/src/stdio.js',
  ];
  for (const relative of surfaces) {
    const source = readFileSync(join(repoRoot, relative), 'utf8');
    assert.equal(source.includes('deployment-storage'), false, `${relative} imported the loader`);
    assert.equal(source.includes('identity-verifier'), false, `${relative} imported the resolver`);
    assert.equal(source.includes('prepareDeploymentPreconnect'), false, `${relative} wired preconnect`);
    assert.equal(source.includes('--deployment-storage'), false, `${relative} grew a flag`);
  }

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const names = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
  for (const name of ['pg', 'postgres', 'postgresql', 'pg-native']) {
    assert.equal(names.includes(name), false, `unexpected production dependency ${name}`);
    assert.throws(() => require.resolve(name, { paths: [repoRoot] }), { code: 'MODULE_NOT_FOUND' });
  }
});
