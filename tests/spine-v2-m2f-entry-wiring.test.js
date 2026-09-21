// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  APP_COMMAND_POSTGRESQL_CLASSIFICATION,
  APP_COMMANDS,
  CLI_VERIFIED_OPERATOR_REQUIRED,
  POSTGRESQL_HTTP_SPINE_REQUIRED,
} from '../packages/cli/src/commands.js';
import { MCP_PRODUCTION_SURFACE_UNAVAILABLE } from '../packages/mcp/src/production-surface.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const cli = join(repoRoot, 'packages/cli/bin/accordo.js');
const mcpBin = join(repoRoot, 'packages/mcp/bin/server.js');
const secretProviderHref = pathToFileURL(join(repoRoot, 'packages/core/src/secret-provider.js')).href;

const SENTINEL_PASSWORD = 'SUPERSECRET_SENTINEL_PASSWORD';
const SENTINEL_TOKEN = 'SENTINEL_CONFIG_BYTES_DO_NOT_ECHO';
const roots = [];

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-m2f-entry-'));
  roots.push(root);
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const VALID_VERIFIER = [
  'export const identityVerifierContract = 2;',
  "export const identityVerifierTrust = 'local-development';",
  'export function createIdentityVerifier() {',
  '  return {',
  '    verifyRequest() { return null; },',
  '    discoverControlResource() {},',
  '    attestControlStartup() {},',
  '    discoverDataResource() {},',
  '    attestDataStartup() {},',
  '  };',
  '}',
  '',
].join('\n');

const HANG_VERIFIER = [
  'export const identityVerifierContract = 2;',
  "export const identityVerifierTrust = 'local-development';",
  'export function createIdentityVerifier() {',
  '  return new Promise(() => {});',
  '}',
  '',
].join('\n');

const VALID_SECRET_PROVIDER = `import { createSecretMaterial } from ${JSON.stringify(secretProviderHref)};
export const secretProviderContract = 1;
export const secretProviderTrust = 'production';
export function createSecretProvider() {
  return {
    contract: 1,
    name: 'entry-fixture',
    trust: 'production',
    resolveSecret() { return createSecretMaterial(${JSON.stringify(SENTINEL_PASSWORD)}); },
  };
}
`;

function sqliteEnvelope(root, overrides = {}) {
  return {
    contract: 1,
    adapter: 'sqlite',
    connection: { path: join(root, 'tenant.sqlite') },
    controlPlane: { path: join(root, 'control.sqlite') },
    spine: { mode: 'local-development', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.mjs',
    ...overrides,
  };
}

function postgresTls() {
  return {
    enabled: true,
    verify: 'full',
    caFile: './tls/deployment-ca.pem',
    servername: 'db.example.test',
  };
}

function postgresEnvelope(overrides = {}) {
  return {
    contract: 2,
    adapter: 'postgresql',
    connection: {
      host: '127.0.0.1',
      port: 1,
      database: 'accordo',
      user: 'accordo',
      passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD',
      sslmode: 'verify-full',
      tls: postgresTls(),
    },
    controlPlane: {
      host: '127.0.0.1',
      port: 1,
      database: 'accordo_control',
      user: 'accordo',
      passwordSecret: 'ACCORDO_TEST_CONTROL_PASSWORD',
      sslmode: 'verify-full',
      tls: postgresTls(),
    },
    spine: { mode: 'production', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.mjs',
    secretProvider: { kind: 'module', path: './providers/secret-provider.mjs' },
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

function haystackOf(result) {
  return [
    String(result.stdout ?? ''),
    String(result.stderr ?? ''),
    String(result.status ?? ''),
  ].join('\n');
}

function assertCredentialFree(haystack, extras = []) {
  for (const token of [SENTINEL_PASSWORD, SENTINEL_TOKEN, ...extras]) {
    assert.equal(haystack.includes(token), false, `output leaked ${token}`);
  }
}

function assertNoLocator(haystack, extras = []) {
  for (const token of ['127.0.0.1', 'db.example.test', 'accordo_control', ...extras]) {
    assert.equal(haystack.includes(token), false, `output leaked locator ${token}`);
  }
}

function spawnEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CRM_DB_PATH;
  if (!Object.hasOwn(extra, 'ACCORDO_DEPLOYMENT_STORAGE')) delete env.ACCORDO_DEPLOYMENT_STORAGE;
  if (!Object.hasOwn(extra, 'ACCORDO_MODE')) delete env.ACCORDO_MODE;
  return env;
}

function runCli(args, { cwd = repoRoot, env = spawnEnv(), timeout = 30_000 } = {}) {
  return spawnSync(process.execPath, ['--no-warnings', cli, ...args], {
    cwd, encoding: 'utf8', timeout, env,
  });
}

function failureCode(result) {
  const text = `${result.stderr}\n${result.stdout}`;
  try {
    const parsed = JSON.parse((result.stderr || '').trim().split('\n').at(-1) || '{}');
    if (parsed && parsed.code) return parsed.code;
  } catch {
    /* fall through */
  }
  const match = text.match(/"code":\s*"([A-Z0-9_]+)"/);
  return match ? match[1] : text;
}

function sqliteScratch() {
  const root = scratch();
  writeModule(root, 'providers/identity-verifier.mjs', VALID_VERIFIER);
  const configPath = writeConfig(root, sqliteEnvelope(root));
  return { root, configPath };
}

test('M2-32 APP_COMMANDS is the canonical classified authority', () => {
  assert.deepEqual([...APP_COMMANDS], [
    'serve', 'seed', 'demo', 'doctor', 'db:migrate', 'workflow:list', 'trace:list',
  ]);
  assert.equal(Object.isFrozen(APP_COMMANDS), true);
  assert.equal(Object.isFrozen(APP_COMMAND_POSTGRESQL_CLASSIFICATION), true);
  for (const command of APP_COMMANDS) {
    assert.ok(
      Object.hasOwn(APP_COMMAND_POSTGRESQL_CLASSIFICATION, command),
      `unclassified APP_COMMANDS entry ${command}`,
    );
  }
  assert.deepEqual(
    Object.keys(APP_COMMAND_POSTGRESQL_CLASSIFICATION).sort(),
    [...APP_COMMANDS].sort(),
  );
  assert.equal(APP_COMMAND_POSTGRESQL_CLASSIFICATION.serve, 'READ_ONLY_SUPPORTED');
  for (const command of APP_COMMANDS.filter((name) => name !== 'serve')) {
    assert.equal(APP_COMMAND_POSTGRESQL_CLASSIFICATION[command], 'STABLE_REFUSAL_ON_POSTGRESQL');
  }
  assert.equal(CLI_VERIFIED_OPERATOR_REQUIRED, 'CLI_VERIFIED_OPERATOR_REQUIRED');
});

test('M2-32 every application command still runs on SQLite --db', () => {
  const root = scratch();
  for (const command of APP_COMMANDS.filter((name) => name !== 'serve')) {
    const dbPath = join(root, `${command.replace(':', '-')}.sqlite`);
    const args = command === 'trace:list'
      ? [command, '--db', dbPath, '--limit', '5']
      : [command, '--db', dbPath];
    const run = runCli(args);
    assert.equal(run.status, 0, `${command}: ${run.stderr}`);
    const receipt = JSON.parse(run.stdout);
    assert.equal(typeof receipt, 'object', `${command} writes one JSON object`);
    if (command === 'db:migrate') {
      assert.equal(receipt.ok, true);
      assert.equal(receipt.database, dbPath);
    }
    if (command === 'doctor') {
      assert.equal(receipt.ok, true);
      assert.equal(receipt.database, dbPath);
    }
    if (command === 'workflow:list' || command === 'trace:list') {
      assert.ok(Array.isArray(receipt.items));
    }
    assert.equal(existsSync(dbPath), true, `${command} opens SQLite`);
    assertCredentialFree(haystackOf(run));
  }
});

test('M2-17 --db plus --deployment-storage refuses before opening either surface', () => {
  const { root, configPath } = sqliteScratch();
  const dbPath = join(root, 'legacy.sqlite');
  const run = runCli(['doctor', '--db', dbPath, '--deployment-storage', configPath], {
    env: spawnEnv(), cwd: repoRoot,
  });
  assert.notEqual(run.status, 0);
  assert.equal(failureCode(run), 'DEPLOYMENT_STORAGE_DB_CONFLICT');
  assert.equal(existsSync(dbPath), false);
  assert.equal(existsSync(join(root, 'tenant.sqlite')), false);
  assertCredentialFree(haystackOf(run), [configPath, dbPath, root]);
});

test('M2-11/M2-32 PostgreSQL documents refuse before composition for every APP_COMMANDS entry', () => {
  const root = scratch();
  writeModule(root, 'providers/identity-verifier.mjs', VALID_VERIFIER.replaceAll("'local-development'", "'production'"));
  writeModule(root, 'providers/secret-provider.mjs', VALID_SECRET_PROVIDER);
  const configPath = writeConfig(root, postgresEnvelope());
  for (const command of APP_COMMANDS.filter((name) => name !== 'serve')) {
    const run = runCli([command, '--deployment-storage', configPath, '--root', root], {
      cwd: repoRoot, env: spawnEnv(), timeout: 10_000,
    });
    assert.notEqual(run.status, 0, `${command} should refuse postgresql`);
    assert.equal(failureCode(run), CLI_VERIFIED_OPERATOR_REQUIRED, command);
    assertCredentialFree(haystackOf(run), [configPath, root, SENTINEL_PASSWORD]);
    assertNoLocator(haystackOf(run), [configPath]);
  }
  assert.equal(existsSync(join(root, 'tenant.sqlite')), false);
});

test('M2-17 serve refuses a PostgreSQL document before listen', { timeout: 15_000 }, async () => {
  const root = scratch();
  writeModule(root, 'providers/identity-verifier.mjs', VALID_VERIFIER.replaceAll("'local-development'", "'production'"));
  writeModule(root, 'providers/secret-provider.mjs', VALID_SECRET_PROVIDER);
  const configPath = writeConfig(root, postgresEnvelope());
  const run = runCli(['serve', '--deployment-storage', configPath, '--root', root, '--port', '0'], {
    cwd: repoRoot, env: spawnEnv(), timeout: 8_000,
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout.includes('Accordo running at'), false);
  assert.equal(failureCode(run), POSTGRESQL_HTTP_SPINE_REQUIRED);
  assertCredentialFree(haystackOf(run), [configPath, root]);
  assertNoLocator(haystackOf(run), [configPath]);
});

test('M2-17 SQLite document doctor publishes {adapter,available} and not a path', () => {
  const { root, configPath } = sqliteScratch();
  const run = runCli(['doctor', '--deployment-storage', configPath, '--root', root]);
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.storage, { adapter: 'sqlite', available: true });
  assert.deepEqual(Object.keys(receipt.storage).sort(), ['adapter', 'available']);
  assert.equal(Object.hasOwn(receipt, 'database'), false);
  const haystack = haystackOf(run);
  assert.equal(haystack.includes(join(root, 'tenant.sqlite')), false);
  assert.equal(haystack.includes('identity-verifier.mjs'), false);
  assert.equal(existsSync(join(root, 'tenant.sqlite')), true);
  assertCredentialFree(haystack, [configPath]);
});

test('M2-17 SQLite document db:migrate omits the filesystem path', () => {
  const { root, configPath } = sqliteScratch();
  const run = runCli(['db:migrate', '--deployment-storage', configPath, '--root', root]);
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.ok, true);
  assert.deepEqual(receipt.storage, { adapter: 'sqlite', available: true });
  assert.equal(Object.hasOwn(receipt, 'database'), false);
  assert.equal(haystackOf(run).includes(join(root, 'tenant.sqlite')), false);
});

test('M2-17 env ACCORDO_DEPLOYMENT_STORAGE selects the same document', () => {
  const { root, configPath } = sqliteScratch();
  const run = runCli(['workflow:list', '--root', root], {
    env: spawnEnv({ ACCORDO_DEPLOYMENT_STORAGE: configPath }),
  });
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.ok(Array.isArray(receipt.items));
  assert.equal(existsSync(join(root, 'tenant.sqlite')), true);
});

test('M2-22 serve does not listen until the verifier contract passes', { timeout: 15_000 }, async () => {
  const root = scratch();
  writeModule(root, 'providers/identity-verifier.mjs', HANG_VERIFIER);
  const configPath = writeConfig(root, sqliteEnvelope(root));
  const dbPath = join(root, 'tenant.sqlite');
  const child = spawn(process.execPath, [
    '--no-warnings', cli, 'serve',
    '--deployment-storage', configPath,
    '--root', root,
    '--port', '0',
  ], {
    cwd: repoRoot,
    env: spawnEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`serve hang verifier did not exit: ${stderr}`));
    }, 8_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.notEqual(exitCode, 0);
  assert.equal(stdout.includes('Accordo running at'), false);
  assert.equal(existsSync(dbPath), false);
  const haystack = `${stdout}\n${stderr}`;
  assert.equal(haystack.includes('IDENTITY_VERIFIER_TIMEOUT'), true);
  assertCredentialFree(haystack, [configPath, root]);
});

test('M2-17 serve --db still discloses the ratified SQLite path and listens', { timeout: 20_000 }, async () => {
  const root = scratch();
  const dbPath = join(root, 'serve.sqlite');
  const child = spawn(process.execPath, [
    '--no-warnings', cli, 'serve', '--db', dbPath, '--port', '0',
  ], {
    cwd: repoRoot, env: spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`serve did not start: ${stderr}`));
      }, 10_000);
      child.stdout.on('data', () => {
        if (!stdout.includes('Accordo running at')) return;
        if (!stdout.includes(`Database: ${dbPath}`)) return;
        clearTimeout(timeout);
        resolve(undefined);
      });
      child.once('exit', (code) => reject(new Error(`serve exited early (${code}): ${stderr}`)));
    });
    assert.equal(stdout.includes(`Database: ${dbPath}`), true, stdout);
    const advertised = stdout.match(/Accordo running at (http:\/\/[^\s]+)/)?.[1];
    assert.ok(advertised, stdout);
    const response = await fetch(`${advertised}/api/schema`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(undefined);
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
    });
  }
});

test('M2-17 serve document-selected stdout is {adapter,available} not a path', { timeout: 20_000 }, async () => {
  const { root, configPath } = sqliteScratch();
  const dbPath = join(root, 'tenant.sqlite');
  const child = spawn(process.execPath, [
    '--no-warnings', cli, 'serve',
    '--deployment-storage', configPath,
    '--root', root,
    '--port', '0',
  ], {
    cwd: repoRoot, env: spawnEnv(), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`serve did not start: ${stderr}`));
      }, 10_000);
      child.stdout.on('data', () => {
        if (!stdout.includes('Accordo running at')) return;
        if (!stdout.includes('"adapter":"sqlite"')) return;
        clearTimeout(timeout);
        resolve(undefined);
      });
      child.once('exit', (code) => reject(new Error(`serve exited early (${code}): ${stderr}`)));
    });
    assert.equal(stdout.includes('Database:'), false, stdout);
    assert.equal(stdout.includes(dbPath), false, stdout);
    assert.equal(stdout.includes('"adapter":"sqlite"'), true, stdout);
    assert.equal(stdout.includes('"available":true'), true, stdout);
    const advertised = stdout.match(/Accordo running at (http:\/\/[^\s]+)/)?.[1];
    assert.ok(advertised, stdout);
    const response = await fetch(`${advertised}/api/schema`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(undefined);
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
    });
  }
});

test('M2-16 non-application commands do not load deployment storage', () => {
  const root = scratch();
  const configPath = writeConfig(root, postgresEnvelope());
  const samples = [
    ['help'],
    ['app', 'inspect', '--json', '--deployment-storage', configPath],
    ['project', 'doctor', '--json', '--deployment-storage', configPath],
  ];
  for (const args of samples) {
    const run = runCli(args);
    assert.equal(run.status, 0, `${args.join(' ')}: ${run.stderr}`);
    const haystack = haystackOf(run);
    assert.equal(haystack.includes('DEPLOYMENT_STORAGE_POSTGRESQL_UNSUPPORTED'), false, args.join(' '));
    assertCredentialFree(haystack, [SENTINEL_PASSWORD]);
  }
});

test('M2-16 production MCP is static-context-only and does not load a FIFO config', { timeout: 15_000 }, async () => {
  const root = scratch();
  const fifoPath = join(root, 'deployment-storage.json');
  const fifo = spawnSync('mkfifo', ['-m', '600', fifoPath], { encoding: 'utf8' });
  assert.equal(fifo.status, 0, fifo.stderr || 'mkfifo failed');
  const dbPath = join(root, 'data', 'accordo.sqlite');

  const child = spawn(process.execPath, ['--no-warnings', mcpBin], {
    cwd: root,
    env: spawnEnv({
      ACCORDO_MODE: 'production',
      ACCORDO_DEPLOYMENT_STORAGE: fifoPath,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'm2f', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'crm_list_opportunities', arguments: {} } },
    { jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} },
    { jsonrpc: '2.0', id: 5, method: 'prompts/list', params: {} },
    { jsonrpc: '2.0', id: 6, method: 'resources/read', params: { uri: 'crm://schema' } },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  child.stdin.end(input);

  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`production MCP hung on FIFO: ${stderr}`));
    }, 4_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0, stderr);
  assert.equal(existsSync(dbPath), false, 'production MCP opened SQLite');
  const responses = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(responses[0].result.serverInfo.name, 'accordo');
  assert.deepEqual(responses[1].result.tools, []);
  const call = responses[2];
  const callHaystack = JSON.stringify(call);
  assert.equal(callHaystack.includes(MCP_PRODUCTION_SURFACE_UNAVAILABLE), true, callHaystack);
  const listed = responses[3].result.resources.map((resource) => resource.uri).sort();
  assert.deepEqual(listed, ['crm://project/architecture', 'crm://project/jtbd']);
  assert.deepEqual(responses[4].result.prompts, []);
  assert.equal(JSON.stringify(responses[5]).includes(MCP_PRODUCTION_SURFACE_UNAVAILABLE), true);
  assertCredentialFree(`${stdout}\n${stderr}`, [fifoPath, SENTINEL_PASSWORD]);
});

test('M2-16 local MCP --db still composes and lists application tools', { timeout: 20_000 }, async () => {
  const root = scratch();
  const dbPath = join(root, 'mcp.sqlite');
  const child = spawn(process.execPath, [
    '--no-warnings', cli, 'mcp', '--db', dbPath,
  ], {
    cwd: repoRoot, env: spawnEnv(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/list', params: {},
  })}\n`);
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`local MCP did not exit: ${stderr}`));
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0, stderr);
  const responses = stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const names = responses[0].result.tools.map((tool) => tool.name);
  assert.equal(names.includes('crm_list_opportunities'), true);
  assert.equal(existsSync(dbPath), true);
});

test('no executable invents adapter parsing; factory stays unwired', () => {
  const surfaces = [
    'packages/cli/src/commands.js',
    'packages/mcp/src/stdio.js',
    'packages/mcp/bin/server.js',
    'packages/cli/bin/accordo.js',
    'packages/app/src/create-app.js',
  ];
  for (const relative of surfaces) {
    const source = readFileSync(join(repoRoot, relative), 'utf8');
    assert.equal(source.includes('--adapter'), false, `${relative} invented --adapter`);
    assert.equal(source.includes('--pg-url'), false, `${relative} invented --pg-url`);
    assert.equal(source.includes('DATABASE_URL'), false, `${relative} invented DATABASE_URL`);
  }

  const commands = readFileSync(join(repoRoot, 'packages/cli/src/commands.js'), 'utf8');
  assert.equal(commands.includes('prepareDeploymentPreconnect'), true);
  assert.equal(commands.includes('--deployment-storage'), true);
  const stdio = readFileSync(join(repoRoot, 'packages/mcp/src/stdio.js'), 'utf8');
  assert.equal(stdio.includes('prepareDeploymentPreconnect'), true);
  const factory = readFileSync(join(repoRoot, 'packages/app/src/create-app.js'), 'utf8');
  assert.equal(factory.includes('prepareDeploymentPreconnect'), false);
  assert.equal(factory.includes('deployment-storage'), false);

  const kernel = readFileSync(join(repoRoot, 'packages/core/index.js'), 'utf8');
  assert.equal(kernel.includes('deployment-storage'), false);
  assert.equal(kernel.includes('identity-verifier'), false);

  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, { pg: '8.23.0' });
  const extra = [
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
  for (const name of ['postgres', 'postgresql', 'pg-native']) {
    assert.equal(extra.includes(name), false, `unexpected extra production dependency ${name}`);
    assert.throws(() => require.resolve(name, { paths: [repoRoot] }), { code: 'MODULE_NOT_FOUND' });
  }
});

test('no-business-raw inventory: production packages keep raw SQLite adapter-internal', () => {
  /** @type {{ file: string, kind: 'adapter-internal' | 'comment' | 'business-consumer', detail: string }[]} */
  const hits = [];
  const skip = new Set(['node_modules']);

  /**
   * @param {string} dir
   * @param {(name: string) => boolean} [filter]
   */
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = readFileSync(full, 'utf8');
      const relative = full.slice(repoRoot.length + 1);
      if (source.includes('database.raw')) {
        const commentOnly = relative === 'packages/core/index.js';
        hits.push({
          file: relative,
          kind: commentOnly ? 'comment' : 'business-consumer',
          detail: 'database.raw',
        });
      }
      if (/\bnew DatabaseSync\b/.test(source)) {
        const adapterInternal = relative === 'packages/core/src/database.js';
        hits.push({
          file: relative,
          kind: adapterInternal ? 'adapter-internal' : 'business-consumer',
          detail: 'DatabaseSync',
        });
      }
    }
  }

  walk(join(repoRoot, 'packages'));
  walk(join(repoRoot, 'apps'));
  walk(join(repoRoot, 'api'));

  const business = hits.filter((hit) => hit.kind === 'business-consumer');
  assert.deepEqual(
    business,
    [],
    `production business consumers of raw SQLite:\n${business.map((hit) => `${hit.file} ${hit.detail}`).join('\n')}`,
  );

  const adapters = hits.filter((hit) => hit.kind === 'adapter-internal');
  assert.deepEqual(
    adapters.map((hit) => `${hit.file} ${hit.detail}`),
    ['packages/core/src/database.js DatabaseSync'],
  );
  assert.equal(
    hits.some((hit) => hit.file === 'packages/core/src/core-adapters.js'),
    false,
    'core-adapters.js is lead-conversion application logic; after M2-05 it must not reach the raw driver',
  );
});
