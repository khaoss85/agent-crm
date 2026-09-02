// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync as realFstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import { mock } from 'node:test';
import { createAccordoApp } from '../packages/app/src/index.js';
import {
  DEPLOYMENT_STORAGE_CONTRACT,
  DEPLOYMENT_STORAGE_ENV,
  describeDeploymentStorage,
  loadDeploymentStorage,
} from '../packages/core/src/deployment-storage.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const SENTINEL_PASSWORD = 'SUPERSECRET_SENTINEL_PASSWORD';
const SENTINEL_TOKEN = 'SENTINEL_CONFIG_BYTES_DO_NOT_ECHO';
const roots = [];

function scratch() {
  const root = mkdtempSync(join(tmpdir(), 'accordo-deploy-storage-'));
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
    spine: { mode: 'local-development', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.js',
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
    identityVerifier: './providers/identity-verifier.js',
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

test('M2-17 publishes a versioned loader and SQLite --db compatibility', () => {
  assert.equal(DEPLOYMENT_STORAGE_CONTRACT, 2);
  assert.equal(DEPLOYMENT_STORAGE_ENV, 'ACCORDO_DEPLOYMENT_STORAGE');

  const selected = loadDeploymentStorage({ dbPath: ':memory:', env: {} });
  assert.equal(selected.contract, 1);
  assert.equal(selected.adapter, 'sqlite');
  assert.equal(selected.source, 'db-flag');
  assert.deepEqual(describeDeploymentStorage(selected), { adapter: 'sqlite', available: true });
  assert.deepEqual(Object.keys(describeDeploymentStorage(selected)).sort(), ['adapter', 'available']);
  assert.equal(Object.isFrozen(describeDeploymentStorage(selected)), true);

  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.ok(app.modules);
  } finally {
    app.close();
  }
});

test('M2-17 loads a trusted SQLite document and keeps connection off the descriptor', () => {
  const root = scratch();
  const configPath = writeConfig(root, sqliteEnvelope());
  const selected = loadDeploymentStorage({ configPath, env: {} });
  assert.equal(selected.adapter, 'sqlite');
  assert.equal(selected.source, 'config');
  assert.equal(selected.identityVerifier, './providers/identity-verifier.js');
  assert.equal(selected.spine.mode, 'local-development');
  assert.equal(selected.spine.tenant.id, 'acme');
  assert.equal(selected.connection.path, './data/tenant.sqlite');
  assert.equal(selected.controlPlane.path, './data/control.sqlite');
  const descriptor = describeDeploymentStorage(selected);
  assert.deepEqual(descriptor, { adapter: 'sqlite', available: true });
  assert.equal(JSON.stringify(descriptor).includes('tenant.sqlite'), false);
  assert.equal(JSON.stringify(descriptor).includes('identity-verifier'), false);
});

test('M2-17 explicit config path wins over the documented env var', () => {
  const root = scratch();
  const winner = writeConfig(root, sqliteEnvelope({
    connection: { path: './winner.sqlite' },
    controlPlane: { path: './winner-control.sqlite' },
  }), { name: 'winner.json' });
  const loser = writeConfig(root, sqliteEnvelope({
    connection: { path: './loser.sqlite' },
    controlPlane: { path: './loser-control.sqlite' },
  }), { name: 'loser.json' });
  const selected = loadDeploymentStorage({
    configPath: winner,
    env: { [DEPLOYMENT_STORAGE_ENV]: loser },
  });
  assert.equal(selected.source, 'config');
  assert.equal(selected.connection.path, './winner.sqlite');
});

test('M2-17 env path is used when no explicit config path is supplied', () => {
  const root = scratch();
  const configPath = writeConfig(root, sqliteEnvelope({
    connection: { path: './env.sqlite' },
    controlPlane: { path: './env-control.sqlite' },
  }));
  const selected = loadDeploymentStorage({
    env: { [DEPLOYMENT_STORAGE_ENV]: configPath },
  });
  assert.equal(selected.source, 'env');
  assert.equal(selected.connection.path, './env.sqlite');
});

test('M2-17 refuses config together with --db before opening either surface', () => {
  const root = scratch();
  const configPath = writeConfig(root, sqliteEnvelope(), { mode: 0o644 });
  const extras = [configPath, root];
  assertCode(() => loadDeploymentStorage({
    configPath,
    dbPath: ':memory:',
    env: {},
  }), 'DEPLOYMENT_STORAGE_DB_CONFLICT', extras);
  assertCode(() => loadDeploymentStorage({
    dbPath: '/tmp/accordo.sqlite',
    env: { [DEPLOYMENT_STORAGE_ENV]: configPath },
  }), 'DEPLOYMENT_STORAGE_DB_CONFLICT', extras);
});

test('M2-17 refuses an empty selection rather than inventing a path', () => {
  assertCode(() => loadDeploymentStorage({ env: {} }), 'DEPLOYMENT_STORAGE_SOURCE_REQUIRED');
});

test('M2-17 extra envelope keys, prototypes and unknown adapters refuse', () => {
  const root = scratch();
  const extras = [root];
  const cases = [
    { extra: true },
    { adapter: 'mysql' },
    { adapter: 'SQLite' },
    { identityVerifier: { factory: 'eval' } },
    { identityVerifier: '/abs/verifier.js' },
    { identityVerifier: '' },
    { identityVerifier: 'has\0nul.js' },
    { connection: { path: './data/tenant.sqlite', tls: { enabled: false } } },
    { spine: { mode: 'production', tenant: { id: 'acme' }, extra: 1 } },
    { spine: { mode: 'staging', tenant: { id: 'acme' } } },
    { spine: { mode: 'local-development', tenant: 'acme' } },
    { spine: { mode: 'local-development', tenant: { id: 1 } } },
  ];
  for (const patch of cases) {
    const body = sqliteEnvelope(patch);
    const configPath = writeConfig(root, body, { name: `bad-${cases.indexOf(patch)}.json` });
    extras.push(configPath);
    assertCode(() => loadDeploymentStorage({ configPath, env: {} }), 'DEPLOYMENT_STORAGE_ENVELOPE_INVALID', extras);
  }

  const protoPath = writeConfig(root, [
    '{',
    '  "contract": 1,',
    '  "adapter": "sqlite",',
    '  "connection": { "path": "./data/tenant.sqlite" },',
    '  "controlPlane": { "path": "./data/control.sqlite" },',
    '  "spine": { "mode": "local-development", "tenant": { "id": "acme" } },',
    '  "identityVerifier": "./providers/identity-verifier.js",',
    '  "__proto__": { "adapter": "postgresql" }',
    '}',
  ].join('\n'), { name: 'proto.json' });
  assertCode(() => loadDeploymentStorage({ configPath: protoPath, env: {} }), 'DEPLOYMENT_STORAGE_ENVELOPE_INVALID', [protoPath]);

  const inherited = Object.assign(Object.create({ adapter: 'sqlite' }), sqliteEnvelope());
  delete inherited.adapter;
  const inheritedPath = writeConfig(root, JSON.stringify(inherited), { name: 'inherited.json' });
  assertCode(() => loadDeploymentStorage({ configPath: inheritedPath, env: {} }), 'DEPLOYMENT_STORAGE_ENVELOPE_INVALID', [inheritedPath]);
});

test('M2-17 unsupported contract versions refuse without echoing bytes', () => {
  const root = scratch();
  const configPath = writeConfig(root, sqliteEnvelope({ contract: 3 }));
  assertCode(() => loadDeploymentStorage({ configPath, env: {} }), 'DEPLOYMENT_STORAGE_CONTRACT_UNSUPPORTED', [configPath]);
});

test('M2-17 malformed JSON refuses without echoing file bytes', () => {
  const root = scratch();
  const configPath = writeConfig(root, `{ "adapter": "${SENTINEL_TOKEN}"\n`, { name: 'truncated.json' });
  assertCode(() => loadDeploymentStorage({ configPath, env: {} }), 'DEPLOYMENT_STORAGE_ENVELOPE_INVALID', [configPath]);
});

test('M2-20 no-follow ownership and mode discipline uses one pre-parse code', () => {
  const root = scratch();
  const extras = [root];

  const missing = join(root, 'missing.json');
  extras.push(missing);
  assertCode(() => loadDeploymentStorage({ configPath: missing, env: {} }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);

  const directory = join(root, 'dir.json');
  mkdirSync(directory);
  extras.push(directory);
  assertCode(() => loadDeploymentStorage({ configPath: directory, env: {} }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);

  const trusted = writeConfig(root, sqliteEnvelope(), { name: 'target.json' });
  const linked = join(root, 'link.json');
  symlinkSync(trusted, linked);
  extras.push(linked, trusted);
  assertCode(() => loadDeploymentStorage({ configPath: linked, env: {} }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);

  const mode644 = writeConfig(root, sqliteEnvelope(), { mode: 0o644, name: 'world.json' });
  extras.push(mode644);
  assertCode(() => loadDeploymentStorage({ configPath: mode644, env: {} }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);

  const mode640 = writeConfig(root, sqliteEnvelope(), { mode: 0o640, name: 'group.json' });
  extras.push(mode640);
  assertCode(() => loadDeploymentStorage({ configPath: mode640, env: {} }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);

  const owned = writeConfig(root, sqliteEnvelope(), { name: 'owned.json' });
  extras.push(owned);
  assertCode(() => loadDeploymentStorage({
    configPath: owned,
    env: {},
    expectedUid: (typeof process.getuid === 'function' ? process.getuid() : 0) + 1,
  }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);

  const unprovable = writeConfig(root, sqliteEnvelope(), { name: 'unprovable.json' });
  extras.push(unprovable);
  assertCode(() => loadDeploymentStorage({
    configPath: unprovable,
    env: {},
    expectedUid: null,
  }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);

  const oversized = join(root, 'huge.json');
  const fd = openSync(oversized, 'w', 0o600);
  try {
    writeFileSync(fd, `${'{"contract":1,'.padEnd(16 * 1024 + 8, 'x')}`);
  } finally {
    closeSync(fd);
  }
  chmodSync(oversized, 0o600);
  extras.push(oversized);
  assertCode(() => loadDeploymentStorage({ configPath: oversized, env: {} }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);
});

test('M2-20 diagnostics never contain the path or the file bytes', () => {
  const root = scratch();
  const configPath = writeConfig(root, `{ "password": "${SENTINEL_TOKEN}" }`, { mode: 0o644, name: 'leaky.json' });
  const error = assertCode(
    () => loadDeploymentStorage({ configPath, env: {} }),
    'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED',
    [configPath, root, 'leaky.json'],
  );
  assert.equal(leakHaystack(error).includes('leaky.json'), false);
});

function mkfifo(filePath, mode = 0o600) {
  const result = spawnSync('mkfifo', ['-m', mode.toString(8), filePath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || 'mkfifo failed');
}

test('M2-20 FIFO does not hang and refuses stably', { timeout: 2000 }, () => {
  const root = scratch();
  const fifoPath = join(root, 'config.fifo');
  mkfifo(fifoPath, 0o600);
  const started = Date.now();
  const error = assertCode(
    () => loadDeploymentStorage({ configPath: fifoPath, env: {} }),
    'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED',
    [fifoPath, root, SENTINEL_TOKEN, SENTINEL_PASSWORD],
  );
  assert.ok(Date.now() - started < 500, 'FIFO open hung the loader');
  assert.equal(leakHaystack(error).includes('fifo'), false);
});

test('M2-20 directory, socket and character device refuse as non-regular', async () => {
  const root = scratch();
  const extras = [root, SENTINEL_TOKEN];

  const directory = join(root, 'dir.json');
  mkdirSync(directory);
  extras.push(directory);
  assertCode(() => loadDeploymentStorage({ configPath: directory, env: {} }), 'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED', extras);

  const socketPath = join(root, 'device.sock');
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  try {
    extras.push(socketPath);
    const started = Date.now();
    assertCode(
      () => loadDeploymentStorage({ configPath: socketPath, env: {} }),
      'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED',
      extras,
    );
    assert.ok(Date.now() - started < 500, 'socket open hung the loader');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const startedNull = Date.now();
  const error = assertCode(
    () => loadDeploymentStorage({ configPath: '/dev/null', env: {} }),
    'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED',
    ['/dev/null', 'dev/null'],
  );
  assert.ok(Date.now() - startedNull < 500, '/dev/null hung the loader');
  assert.equal(leakHaystack(error).includes('/dev/null'), false);
});

test('M2-20 same-fd open/fstat/read refuses a replacement that changes the inode bytes', () => {
  const root = scratch();
  const configPath = writeConfig(root, sqliteEnvelope());
  const original = readFileSync(configPath);
  const evil = Buffer.from(`${JSON.stringify(sqliteEnvelope({ extra: true }), null, 2)}\n`);

  let flipped = false;
  const mocked = mock.method(fs, 'fstatSync', function mockedFstat(fd, options) {
    const stat = arguments.length > 1 ? realFstatSync(fd, options) : realFstatSync(fd);
    if (!flipped && stat.isFile() && stat.size === original.length) {
      flipped = true;
      rmSync(configPath);
      writeFileSync(configPath, evil);
      chmodSync(configPath, 0o600);
    }
    return stat;
  });
  try {
    const selected = loadDeploymentStorage({ configPath, env: {} });
    assert.equal(flipped, true, 'fstat hook did not run; same-fd contract is untested');
    assert.equal(selected.adapter, 'sqlite');
    assert.equal(selected.connection.path, './data/tenant.sqlite');
  } finally {
    mocked.mock.restore();
  }
});

test('M2-20 truncating the opened inode between fstat and read cannot bypass trust', () => {
  const root = scratch();
  const configPath = writeConfig(root, sqliteEnvelope());
  const originalSize = readFileSync(configPath).length;

  let flipped = false;
  const mocked = mock.method(fs, 'fstatSync', function mockedFstat(fd, options) {
    const stat = arguments.length > 1 ? realFstatSync(fd, options) : realFstatSync(fd);
    if (!flipped && stat.isFile() && stat.size === originalSize) {
      flipped = true;
      // Truncate through a second writable handle. ftruncate on the O_RDONLY
      // loader fd fails with EBADF/EINVAL and would make this test green even
      // if the post-read identity checks were deleted.
      const writable = openSync(configPath, 'r+');
      try {
        fs.ftruncateSync(writable, 0);
      } finally {
        closeSync(writable);
      }
    }
    return stat;
  });
  try {
    assertCode(
      () => loadDeploymentStorage({ configPath, env: {} }),
      'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED',
      [configPath, root],
    );
    assert.equal(flipped, true, 'fstat hook did not run; truncate contract is untested');
  } finally {
    mocked.mock.restore();
  }
});

test('M2-20 trusted-file open uses O_RDONLY|O_NOFOLLOW|O_NONBLOCK on the same fd', () => {
  const source = readFileSync(join(repoRoot, 'packages/core/src/trusted-file.js'), 'utf8');
  assert.equal(source.includes('O_NONBLOCK'), true);
  assert.equal(source.includes('O_NOFOLLOW'), true);
  assert.equal(source.includes('O_RDONLY'), true);
  assert.equal(/\bstatSync\b/.test(source), false);
  assert.equal(/\blstatSync\b/.test(source), false);
  assert.equal(/\breadFileSync\b/.test(source), false);
  assert.equal(source.includes('using '), false);
});

test('M2-18 parser refuses plaintext, weak sslmode, verification-disabled and missing TLS', () => {
  const root = scratch();
  const extras = [root, SENTINEL_PASSWORD];

  const patches = [
    {
      name: 'missing-tls.json',
      body: postgresEnvelope({
        connection: {
          host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD', sslmode: 'verify-full',
        },
      }),
    },
    {
      name: 'plaintext.json',
      body: postgresEnvelope({
        connection: {
          host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD', sslmode: 'verify-full',
          tls: { enabled: false, verify: 'full', caFile: './tls/deployment-ca.pem' },
        },
      }),
    },
    {
      name: 'sslmode-disable.json',
      body: postgresEnvelope({
        connection: {
          host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD', sslmode: 'disable',
          tls: postgresTls(),
        },
      }),
    },
    {
      name: 'sslmode-allow.json',
      body: postgresEnvelope({
        connection: {
          host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD', sslmode: 'allow',
          tls: postgresTls(),
        },
      }),
    },
    {
      name: 'sslmode-prefer.json',
      body: postgresEnvelope({
        connection: {
          host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD', sslmode: 'prefer',
          tls: postgresTls(),
        },
      }),
    },
    {
      name: 'sslmode-require.json',
      body: postgresEnvelope({
        connection: {
          host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD', sslmode: 'require',
          tls: postgresTls(),
        },
      }),
    },
    {
      name: 'verify-none.json',
      body: postgresEnvelope({
        connection: {
          host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD', sslmode: 'verify-full',
          tls: { enabled: true, verify: 'none', caFile: './tls/deployment-ca.pem' },
        },
      }),
    },
    {
      name: 'reject-unauthorized-false.json',
      body: postgresEnvelope({
        connection: {
          host: '127.0.0.1', port: 1, database: 'accordo', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_DATA_PASSWORD', sslmode: 'verify-full',
          tls: {
            enabled: true, verify: 'full', caFile: './tls/deployment-ca.pem',
            rejectUnauthorized: false,
          },
        },
      }),
    },
    {
      name: 'control-plane-plaintext.json',
      body: postgresEnvelope({
        controlPlane: {
          host: '127.0.0.1', port: 1, database: 'accordo_control', user: 'accordo',
          passwordSecret: 'ACCORDO_TEST_CONTROL_PASSWORD', sslmode: 'verify-full',
          tls: { enabled: false, verify: 'full', caFile: './tls/deployment-ca.pem' },
        },
      }),
    },
  ];

  for (const fixture of patches) {
    const configPath = writeConfig(root, fixture.body, { name: fixture.name });
    extras.push(configPath);
    assertCode(() => loadDeploymentStorage({ configPath, env: {} }), 'DEPLOYMENT_STORAGE_TLS_REFUSED', extras);
  }
});

test('M2-17 PostgreSQL selection returns a closed descriptor before opening a connection', () => {
  const root = scratch();
  const configPath = writeConfig(root, postgresEnvelope());
  const started = Date.now();
  const selected = loadDeploymentStorage({ configPath, env: {} });
  assert.ok(Date.now() - started < 250, 'postgresql selection opened a connection');
  assert.equal(selected.adapter, 'postgresql');
  assert.deepEqual(describeDeploymentStorage(selected), {
    adapter: 'postgresql',
    available: true,
  });
  assert.equal(JSON.stringify(describeDeploymentStorage(selected)).includes(SENTINEL_PASSWORD), false);
});

test('M2-17 loader still does not import a PostgreSQL driver', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies, { pg: '8.23.0' });
  const extra = [
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ];
  for (const name of ['postgres', 'postgresql', 'pg-native']) {
    assert.equal(extra.includes(name), false, `unexpected extra production dependency ${name}`);
    assert.equal(Object.hasOwn(pkg.dependencies ?? {}, name), false, `unexpected production dependency ${name}`);
    assert.throws(() => require.resolve(name, { paths: [repoRoot] }), { code: 'MODULE_NOT_FOUND' });
  }
  const source = readFileSync(join(repoRoot, 'packages/core/src/deployment-storage.js'), 'utf8');
  assert.equal(/\bfrom ['"]pg['"]/.test(source), false);
  assert.equal(/\brequire\(['"]pg['"]\)/.test(source), false);
  assert.equal(/net\.connect|tls\.connect|createConnection/.test(source), false);
});

test('M2-17 parser and factory stay unwired; flag mapping is not invented here', () => {
  const factory = readFileSync(join(repoRoot, 'packages/app/src/create-app.js'), 'utf8');
  assert.equal(factory.includes('deployment-storage'), false, 'create-app imported the loader');
  assert.equal(factory.includes('DEPLOYMENT_STORAGE'), false, 'create-app named the contract');
  assert.equal(factory.includes('--deployment-storage'), false, 'create-app grew a flag');
  assert.equal(factory.includes('prepareDeploymentPreconnect'), false);

  const parser = readFileSync(join(repoRoot, 'packages/core/src/deployment-storage.js'), 'utf8');
  assert.equal(parser.includes('--deployment-storage'), false, 'parser grew a CLI flag');
  assert.equal(parser.includes('--adapter'), false);
  assert.equal(parser.includes('--pg-url'), false);

  const help = readFileSync(join(repoRoot, 'packages/cli/src/commands.js'), 'utf8');
  assert.equal(help.includes('accordo serve [--port 4000] [--db ./data/accordo.sqlite] [--deployment-storage path]'), true);
});

test('M2-17 loading the same trusted document twice is identical', () => {
  const root = scratch();
  const configPath = writeConfig(root, sqliteEnvelope());
  const first = loadDeploymentStorage({ configPath, env: {} });
  const second = loadDeploymentStorage({ configPath, env: {} });
  assert.equal(first.source, 'config');
  assert.deepEqual(first, second);
  assert.deepEqual(describeDeploymentStorage(first), describeDeploymentStorage(second));
});

test('M2-22 parser still stores an opaque relative path and does not import it', () => {
  const root = scratch();
  const configPath = writeConfig(root, sqliteEnvelope({
    identityVerifier: './does-not-exist-and-must-not-be-imported.js',
  }));
  const selected = loadDeploymentStorage({ configPath, env: {} });
  assert.equal(selected.identityVerifier, './does-not-exist-and-must-not-be-imported.js');
  const source = readFileSync(join(repoRoot, 'packages/core/src/deployment-storage.js'), 'utf8');
  assert.equal(/import\(/.test(source), false);
  assert.equal(/pathToFileURL/.test(source), false);
  assert.equal(pathToFileURL(configPath).href.startsWith('file:'), true);
});

/**
 * The read-only deployment document.
 *
 * A reviewer found this section's predecessor claiming a read-only composition
 * was reachable "through both channels", and proved otherwise: the only
 * producer of `deployment.selection` validates against a closed key set that
 * knew neither `access` nor `pinnedBindingUuid`, and required `controlPlane`.
 * So the composition the framework routed to could not be described by any
 * document an operator could write, and existed only for the test harness —
 * which is exactly the defect that section warned about.
 *
 * These tests exist because the routing code passing is not the same fact as
 * the document being loadable.
 */

test('a read-only deployment document loads, and names no control plane', (t) => {
  const root = scratch();
  const configPath = writeConfig(root, JSON.stringify(postgresEnvelope({
    access: 'read-only',
    controlPlane: undefined,
    identityVerifier: undefined,
    pinnedBindingUuid: '4c8a2b1e-9d3f-4a6b-8c1d-2e5f7a9b0c3d',
  })));
  const selected = loadDeploymentStorage({ configPath, env: {} });

  assert.equal(selected.adapter, 'postgresql');
  assert.equal(selected.access, 'read-only');
  assert.equal(selected.pinnedBindingUuid, '4c8a2b1e-9d3f-4a6b-8c1d-2e5f7a9b0c3d');
  assert.equal(selected.controlPlane, undefined);
  assert.equal(selected.identityVerifier, null);
});

test('an ordinary deployment document still requires a control plane', (t) => {
  const root = scratch();
  const configPath = writeConfig(root, JSON.stringify(postgresEnvelope({ controlPlane: undefined })));
  assertCode(() => loadDeploymentStorage({ configPath, env: {} }), 'DEPLOYMENT_STORAGE_ENVELOPE_INVALID', [configPath]);
});

test('a read-only document that names a control plane or a verifier is refused, not trimmed', (t) => {
  for (const key of ['controlPlane', 'identityVerifier']) {
    const root = scratch();
    const overrides = { access: 'read-only', controlPlane: undefined, identityVerifier: undefined };
    if (key === 'controlPlane') overrides.controlPlane = postgresEnvelope().controlPlane;
    else overrides.identityVerifier = './providers/identity-verifier.js';
    const configPath = writeConfig(root, JSON.stringify(postgresEnvelope(overrides)));
    assertCode(
      () => loadDeploymentStorage({ configPath, env: {} }),
      'DEPLOYMENT_STORAGE_READ_ONLY_REFUSED',
      [configPath],
    );
  }
});

test('access is a closed vocabulary of one, so a typo composes nothing', (t) => {
  for (const access of ['readonly', 'read_only', 'READ-ONLY', 'writer', true, 1]) {
    const root = scratch();
    const configPath = writeConfig(root, JSON.stringify(postgresEnvelope({ access })));
    assertCode(
      () => loadDeploymentStorage({ configPath, env: {} }),
      'DEPLOYMENT_STORAGE_ACCESS_UNSUPPORTED',
      [configPath],
    );
  }
});

/**
 * A field nothing reads is indistinguishable from a field that works, which is
 * the failure this whole section is a correction for.
 */
test('a pinned binding uuid outside a read-only document is refused rather than ignored', (t) => {
  const root = scratch();
  const configPath = writeConfig(root, JSON.stringify(postgresEnvelope({
    pinnedBindingUuid: '4c8a2b1e-9d3f-4a6b-8c1d-2e5f7a9b0c3d',
  })));
  assertCode(
    () => loadDeploymentStorage({ configPath, env: {} }),
    'DEPLOYMENT_STORAGE_READ_ONLY_REFUSED',
    [configPath],
  );
});

/**
 * The end of the chain, and the only step that makes the four tests above mean
 * anything: a document an operator can write, loaded by the only producer of a
 * selection, **routed by the factory to the read-only composition**.
 *
 * Proved by how far it gets. The endpoint is unreachable on purpose, so success
 * here is a *connection* failure: reaching the connection means the factory
 * accepted the selection, refused none of its inputs, and built the reader. A
 * composition refusal — `PORTABLE_POSTGRESQL_BINDING_REQUIRED` or
 * `READ_ONLY_COMPOSITION_REFUSED` — would mean the document still cannot reach
 * the thing it describes, which was the finding.
 */
test('a loaded read-only document reaches the reader composition, not a refusal', async (t) => {
  const root = scratch();
  fs.mkdirSync(join(root, 'tls'), { recursive: true });
  fs.writeFileSync(join(root, 'tls/deployment-ca.pem'),
    '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n', { mode: 0o600 });
  const configPath = writeConfig(root, JSON.stringify(postgresEnvelope({
    access: 'read-only',
    controlPlane: undefined,
    identityVerifier: undefined,
    spine: { mode: 'local-development', tenant: { id: 'acme' } },
    secretProvider: { kind: 'environment' },
    pinnedBindingUuid: '4c8a2b1e-9d3f-4a6b-8c1d-2e5f7a9b0c3d',
  })));

  const { prepareDeploymentPreconnect } = await import('../packages/core/src/identity-verifier.js');
  const prepared = await prepareDeploymentPreconnect({
    configPath,
    projectRoot: root,
    env: { ACCORDO_TEST_DATA_PASSWORD: 'not-a-real-password' },
  });
  assert.equal(prepared.selection.access, 'read-only');
  assert.equal(prepared.identityVerifier, null, 'a reader resolves no signing identity');

  const { createAccordoAppAsync } = await import('../packages/app/src/index.js');
  // Asserted **positively**, on the one code this path produces, and not as a
  // denylist of the two codes that would mean failure. The first draft of this
  // test excluded two codes and returned true, so it accepted every other
  // outcome — a reviewer showed it staying green under two mutations that each
  // violate its own stated criterion: a reader that refuses before creating any
  // pool, and a read-only document that composes the *writer* and dies signing
  // a startup attestation. Deducing the right answer by excluding two wrong
  // ones accepts everything nobody thought to name.
  //
  // What this proves: the document loaded, the factory accepted the selection,
  // refused none of its inputs, and got as far as opening a data-plane pool.
  // What it does not prove: that a reader composed and read a row — that needs
  // a PostgreSQL serving the TLS this document requires, which the local test
  // instance does not. `tests/read-only-composition-postgresql.test.js` proves
  // the composition itself over the harness channel; this proves the document
  // reaches it.
  await assert.rejects(
    () => createAccordoAppAsync({
      deployment: prepared,
      projectRoot: root,
      acquisitionDeadlineMs: 250,
    }),
    (error) => error.code === 'STORAGE_UNAVAILABLE',
  );
});

/**
 * The wiring, at the level the defect lives.
 *
 * A reviewer measured that discarding the document's `pinnedBindingUuid` left
 * the whole suite green: the harness tests take the other side of every ternary
 * in that block, and the document test dies at a connection that by
 * construction never succeeds — while `pinnedBindingUuid` and `tenantId` are
 * both read only *after* the connection. So the two values the reader needs
 * from an operator's document reached it through a line no test exercised.
 *
 * This needs no database and no TLS: it asks what the document turns into.
 */
test('the document’s pinned binding and tenant reach the reader’s arguments', async (t) => {
  const root = scratch();
  fs.mkdirSync(join(root, 'tls'), { recursive: true });
  fs.writeFileSync(join(root, 'tls/deployment-ca.pem'),
    '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n', { mode: 0o600 });
  const pin = '4c8a2b1e-9d3f-4a6b-8c1d-2e5f7a9b0c3d';
  const configPath = writeConfig(root, JSON.stringify(postgresEnvelope({
    access: 'read-only',
    controlPlane: undefined,
    identityVerifier: undefined,
    spine: { mode: 'local-development', tenant: { id: 'northwind' } },
    secretProvider: { kind: 'environment' },
    pinnedBindingUuid: pin,
  })));

  const { prepareDeploymentPreconnect } = await import('../packages/core/src/identity-verifier.js');
  const prepared = await prepareDeploymentPreconnect({
    configPath,
    projectRoot: root,
    env: { ACCORDO_TEST_DATA_PASSWORD: 'not-a-real-password' },
  });

  const { readerArgumentsFrom } = await import('../packages/app/src/create-app-async.js');
  const args = readerArgumentsFrom(
    { deployment: prepared, projectRoot: root },
    { selected: undefined, listenMode: 'local-development' },
  );

  assert.equal(args.pinnedBindingUuid, pin,
    'the pin is the one term of the binding cross-check a reader can carry; dropping it is silent');
  assert.equal(args.tenantId, 'northwind');
  assert.equal(args.data.host, '127.0.0.1');
  assert.equal(typeof args.data.password, 'function', 'the credential stays a resolver, never a value');
});
