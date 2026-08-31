// @ts-check

import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import test from 'node:test';
import { loadDeploymentStorage } from '../packages/core/src/deployment-storage.js';
import { AppError } from '../packages/core/src/errors.js';
import { prepareDeploymentPreconnect } from '../packages/core/src/identity-verifier.js';
import {
  SECRET_PROVIDER_CONTRACT,
  SecretLease,
  createEnvironmentSecretProvider,
  createFixtureSecretProvider,
  createSecretMaterial,
  createSecretResolver,
  defineSecretProvider,
  resolveProductionSecretProvider,
  secretProviderVocabulary,
} from '../packages/core/src/secret-provider.js';
import { passwordFromEndpoint } from '../packages/app/src/create-app-async.js';

const here = dirname(fileURLToPath(import.meta.url));
const providerModule = pathToFileURL(join(here, '../packages/core/src/secret-provider.js')).href;
const errorsModule = pathToFileURL(join(here, '../packages/core/src/errors.js')).href;
const SENTINEL = 'v4a-secret-sentinel-do-not-leak';

function errorBlob(error) {
  return JSON.stringify({
    name: error?.name,
    message: error?.message,
    code: error?.code,
    status: error?.status,
    details: error?.details,
    cause: error?.cause instanceof Error ? error.cause.message : error?.cause,
  });
}

function assertRedacted(error) {
  assert.equal(errorBlob(error).includes(SENTINEL), false, errorBlob(error));
}

function assertExhaustivelyRedacted(error) {
  const serialized = [
    errorBlob(error),
    String(error),
    String(error?.stack ?? ''),
    inspect(error, { depth: 20 }),
    JSON.stringify(error),
    JSON.stringify(error?.details),
    JSON.stringify(error?.cause),
  ].join('\n');
  assert.equal(serialized.includes(SENTINEL), false, serialized);
}

function productionProvider(resolveSecret) {
  return defineSecretProvider({
    contract: SECRET_PROVIDER_CONTRACT,
    name: 'production-fixture',
    trust: 'production',
    resolveSecret,
  });
}

test('contract vocabulary is closed and built-ins require explicit matching trust', async () => {
  assert.deepEqual(secretProviderVocabulary(), {
    contract: 1,
    purposes: [
      'identity-verifier',
      'postgresql-control-password',
      'postgresql-data-password',
    ],
    providerKeys: ['contract', 'name', 'trust', 'resolveSecret'],
    resolutionContextKeys: ['contract', 'mode', 'purpose', 'tenantId', 'signal'],
  });
  assert.throws(
    () => createSecretResolver({
      provider: createEnvironmentSecretProvider({ env: { DB_PASSWORD: SENTINEL } }),
      mode: 'production',
    }),
    (error) => error?.code === 'SECRET_PROVIDER_TRUST_REFUSED' && !errorBlob(error).includes(SENTINEL),
  );
  assert.throws(
    () => defineSecretProvider({
      contract: 1,
      name: 'hostile',
      trust: 'production',
      resolveSecret() {},
      password: SENTINEL,
    }),
    (error) => error?.code === 'SECRET_PROVIDER_INVALID' && !errorBlob(error).includes(SENTINEL),
  );
  let getterInvoked = false;
  const accessorProvider = {
    contract: 1,
    trust: 'production',
    resolveSecret() { return createSecretMaterial(SENTINEL); },
  };
  Object.defineProperty(accessorProvider, 'name', {
    enumerable: true,
    get() {
      getterInvoked = true;
      throw new AppError(SENTINEL, { details: { credential: SENTINEL } });
    },
  });
  assert.throws(
    () => defineSecretProvider(accessorProvider),
    (error) => error?.code === 'SECRET_PROVIDER_INVALID' && !errorBlob(error).includes(SENTINEL),
  );
  assert.equal(getterInvoked, false);
});

test('production provider accessor is rejected without invocation or credential-bearing AppError escape', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4a-accessor-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'providers'));
  const marker = join(root, 'getter-invoked');
  const modulePath = join(root, 'providers', 'malicious.mjs');
  writeFileSync(modulePath, `import { writeFileSync } from 'node:fs';
import { AppError } from ${JSON.stringify(errorsModule)};
export const secretProviderContract = 1;
export const secretProviderTrust = 'production';
export function createSecretProvider() {
  const provider = {
    contract: 1,
    trust: 'production',
    resolveSecret() { throw new Error('must not resolve'); },
  };
  Object.defineProperty(provider, 'name', {
    enumerable: true,
    get() {
      writeFileSync(${JSON.stringify(marker)}, 'invoked');
      throw new AppError(${JSON.stringify(SENTINEL)}, {
        code: 'SECRET_PROVIDER_TIMEOUT',
        details: { credential: ${JSON.stringify(SENTINEL)} },
        cause: new Error(${JSON.stringify(SENTINEL)}),
      });
    },
  });
  return provider;
}
`);
  chmodSync(modulePath, 0o600);

  await assert.rejects(
    () => resolveProductionSecretProvider({
      relativePath: './providers/malicious.mjs',
      projectRoot: root,
      mode: 'production',
    }),
    (error) => {
      assert.equal(error?.code, 'SECRET_PROVIDER_INVALID');
      assertExhaustivelyRedacted(error);
      return true;
    },
  );
  assert.equal(existsSync(marker), false, 'provider getter was invoked during validation');
});

test('fixture and environment providers return opaque single-use disposable leases', async () => {
  for (const provider of [
    createFixtureSecretProvider({ FIXTURE_SECRET: SENTINEL }),
    createEnvironmentSecretProvider({ env: { FIXTURE_SECRET: SENTINEL } }),
  ]) {
    const resolver = createSecretResolver({ provider, mode: 'local-development' });
    const lease = await resolver.resolveSecret('FIXTURE_SECRET', {
      purpose: 'identity-verifier',
      tenantId: 'acme',
    });
    assert.ok(lease instanceof SecretLease);
    assert.equal(lease.disposed, false);
    assert.throws(() => String(lease), (error) => error?.code === 'SECRET_VALUE_COERCION_REFUSED');
    assert.throws(() => JSON.stringify(lease), (error) => error?.code === 'SECRET_VALUE_COERCION_REFUSED');
    assert.equal(await lease.use((value) => value === SENTINEL), true);
    assert.equal(lease.disposed, true);
    await assert.rejects(
      () => lease.use(() => undefined),
      (error) => error?.code === 'SECRET_VALUE_DISPOSED' && !errorBlob(error).includes(SENTINEL),
    );
  }

  const providerBytes = new TextEncoder().encode(SENTINEL);
  const production = createSecretResolver({
    provider: productionProvider(() => providerBytes),
    mode: 'production',
  });
  const lease = await production.resolveSecret('provider.bytes', {
    purpose: 'identity-verifier', tenantId: 'acme',
  });
  assert.equal(providerBytes.every((byte) => byte === 0), true);
  assert.equal(await lease.use((value) => value), SENTINEL);

  const expiringResolver = createSecretResolver({
    provider: productionProvider(() => createSecretMaterial(SENTINEL)),
    mode: 'production',
    timeoutMs: 5,
  });
  const expiring = await expiringResolver.resolveSecret('provider.expiring', {
    purpose: 'identity-verifier', tenantId: 'acme',
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(expiring.disposed, true);
});

test('hostile provider errors and invalid results collapse to credential-free refusals', async () => {
  for (const resolveSecret of [
    () => { throw new Error(SENTINEL); },
    () => { throw new AppError(SENTINEL, { code: 'SECRET_PROVIDER_TIMEOUT', details: { value: SENTINEL } }); },
    () => SENTINEL,
    () => ({ get then() { throw new Error(SENTINEL); } }),
  ]) {
    const resolver = createSecretResolver({ provider: productionProvider(resolveSecret), mode: 'production' });
    await assert.rejects(
      () => resolver.resolveSecret('provider.credential', {
        purpose: 'identity-verifier',
        tenantId: 'acme',
      }),
      (error) => {
        assertRedacted(error);
        return error?.code === 'SECRET_PROVIDER_FAILED' || error?.code === 'SECRET_PROVIDER_INVALID';
      },
    );
  }
});

test('timeout aborts, observes late settlement and disposes late mutable material', async () => {
  let aborted = false;
  const late = createSecretMaterial(SENTINEL);
  const resolver = createSecretResolver({
    provider: productionProvider((_reference, context) => new Promise((resolve) => {
      context.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      setTimeout(() => resolve(late), 30);
    })),
    mode: 'production',
    timeoutMs: 5,
  });
  await assert.rejects(
    () => resolver.resolveSecret('provider.credential', {
      purpose: 'identity-verifier',
      tenantId: 'acme',
    }),
    (error) => error?.code === 'SECRET_PROVIDER_TIMEOUT' && !errorBlob(error).includes(SENTINEL),
  );
  assert.equal(aborted, true);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const reused = createSecretResolver({
    provider: productionProvider(() => late),
    mode: 'production',
  });
  await assert.rejects(
    () => reused.resolveSecret('provider.credential', {
      purpose: 'identity-verifier',
      tenantId: 'acme',
    }),
    (error) => error?.code === 'SECRET_PROVIDER_INVALID' && !errorBlob(error).includes(SENTINEL),
  );
});

test('PostgreSQL control and data password callbacks consume references without retaining them', async () => {
  const seen = [];
  const resolver = createSecretResolver({
    provider: productionProvider((reference, context) => {
      seen.push({ reference, purpose: context.purpose, tenantId: context.tenantId });
      return createSecretMaterial(SENTINEL);
    }),
    mode: 'production',
  });
  for (const [reference, purpose] of [
    ['pg.control.password', 'postgresql-control-password'],
    ['pg.data.password', 'postgresql-data-password'],
  ]) {
    const password = passwordFromEndpoint(
      { passwordSecret: reference },
      resolver,
      purpose,
      'acme',
    );
    assert.equal(typeof password, 'function');
    assert.equal(await password(), SENTINEL);
    assert.equal(JSON.stringify({ password }).includes(SENTINEL), false);
    assert.equal(JSON.stringify({ password }).includes(reference), false);
  }
  assert.deepEqual(seen, [
    { reference: 'pg.control.password', purpose: 'postgresql-control-password', tenantId: 'acme' },
    { reference: 'pg.data.password', purpose: 'postgresql-data-password', tenantId: 'acme' },
  ]);
});

test('deployment contract 2 resolves a production provider then lets the verifier consume it pre-connect', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4a-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'providers'));
  const secretPath = join(root, 'providers', 'secret-provider.mjs');
  const verifierPath = join(root, 'providers', 'identity-verifier.mjs');
  const configPath = join(root, 'deployment.json');

  writeFileSync(secretPath, `import { defineSecretProvider, createSecretMaterial } from ${JSON.stringify(providerModule)};
export const secretProviderContract = 1;
export const secretProviderTrust = 'production';
export function createSecretProvider() {
  return defineSecretProvider({
    contract: 1,
    name: 'production-fixture',
    trust: 'production',
    resolveSecret(reference) {
      if (reference !== 'identity.verifier.token') throw new Error(${JSON.stringify(SENTINEL)});
      return createSecretMaterial(${JSON.stringify(SENTINEL)});
    },
  });
}
`);
  writeFileSync(verifierPath, `export const identityVerifierContract = 2;
export const identityVerifierTrust = 'production';
export async function createIdentityVerifier({ secrets, tenantId }) {
  const lease = await secrets.resolveSecret('identity.verifier.token', { purpose: 'identity-verifier', tenantId });
  const accepted = await lease.use((value) => value === ${JSON.stringify(SENTINEL)});
  if (!accepted) throw new Error(${JSON.stringify(SENTINEL)});
  return {
    verifyRequest() {},
    discoverControlResource() {},
    attestControlStartup() {},
    discoverDataResource() {},
    attestDataStartup() {},
  };
}
`);
  const endpoint = (database, passwordSecret) => ({
    host: 'db.invalid',
    port: 5432,
    database,
    user: 'accordo',
    passwordSecret,
    sslmode: 'verify-full',
    tls: { enabled: true, verify: 'full', caFile: './ca.pem', rejectUnauthorized: true },
  });
  writeFileSync(configPath, JSON.stringify({
    contract: 2,
    adapter: 'postgresql',
    connection: endpoint('data', 'pg.data.password'),
    controlPlane: endpoint('control', 'pg.control.password'),
    spine: { mode: 'production', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.mjs',
    secretProvider: { kind: 'module', path: './providers/secret-provider.mjs' },
  }));
  for (const path of [secretPath, verifierPath, configPath]) chmodSync(path, 0o600);

  const selected = loadDeploymentStorage({ configPath, env: {} });
  assert.equal(selected.connection.password, undefined);
  assert.equal(selected.connection.passwordSecret, 'pg.data.password');
  assert.equal(JSON.stringify(selected).includes(SENTINEL), false);

  const prepared = await prepareDeploymentPreconnect({ configPath, projectRoot: root, env: {} });
  assert.equal(prepared.secretResolver?.contract, 1);
  assert.equal(prepared.identityVerifier.contract, 2);
  assert.equal(JSON.stringify(prepared).includes(SENTINEL), false);
  assert.equal(inspect(prepared, { depth: 12 }).includes(SENTINEL), false);
  assert.equal(JSON.stringify({
    selection: { adapter: prepared.selection.adapter },
    verifier: { contract: prepared.identityVerifier.contract, trust: prepared.identityVerifier.trust },
    resolver: { contract: prepared.secretResolver?.contract },
  }).includes(SENTINEL), false);
});

test('provider preparation is independent of an identity verifier and SQLite v2 needs no provider', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4a-independent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'providers'));
  const secretPath = join(root, 'providers', 'secret-provider.mjs');
  const pgPath = join(root, 'postgresql.json');
  const sqlitePath = join(root, 'sqlite.json');
  writeFileSync(secretPath, `import { createSecretMaterial } from ${JSON.stringify(providerModule)};
export const secretProviderContract = 1;
export const secretProviderTrust = 'production';
export function createSecretProvider() {
  return {
    contract: 1,
    name: 'independent-fixture',
    trust: 'production',
    resolveSecret() { return createSecretMaterial(${JSON.stringify(SENTINEL)}); },
  };
}
`);
  const endpoint = (database, passwordSecret) => ({
    host: 'db.invalid', database, user: 'accordo', passwordSecret,
    tls: { enabled: true, verify: 'full', caFile: './ca.pem' },
  });
  writeFileSync(pgPath, JSON.stringify({
    contract: 2,
    adapter: 'postgresql',
    connection: endpoint('data', 'pg.data.password'),
    controlPlane: endpoint('control', 'pg.control.password'),
    spine: { mode: 'production', tenant: { id: 'acme' } },
    secretProvider: { kind: 'module', path: './providers/secret-provider.mjs' },
  }));
  writeFileSync(sqlitePath, JSON.stringify({
    contract: 2,
    adapter: 'sqlite',
    connection: { path: './data.sqlite' },
    controlPlane: { path: './control.sqlite' },
    spine: { mode: 'local-development', tenant: { id: 'acme' } },
  }));
  for (const path of [secretPath, pgPath, sqlitePath]) chmodSync(path, 0o600);

  const prepared = await prepareDeploymentPreconnect({ configPath: pgPath, projectRoot: root, env: {} });
  assert.equal(prepared.identityVerifier, null);
  assert.equal(prepared.secretResolver?.contract, 1);
  const lease = await prepared.secretResolver.resolveSecret('pg.data.password', {
    purpose: 'postgresql-data-password',
    tenantId: 'acme',
  });
  assert.equal(await lease.use((value) => value === SENTINEL), true);

  const sqlite = loadDeploymentStorage({ configPath: sqlitePath, env: {} });
  assert.equal(sqlite.secretProvider, null);
  const sqlitePrepared = await prepareDeploymentPreconnect({ configPath: sqlitePath, env: {} });
  assert.equal(sqlitePrepared.secretResolver, null);
  assert.equal(sqlitePrepared.identityVerifier, null);
});

test('production refuses legacy inline credentials and environment fallback without reflecting values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'accordo-v4a-refuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = {
    adapter: 'postgresql',
    connection: {
      host: 'data.invalid', database: 'data', user: 'accordo', password: SENTINEL,
      tls: { enabled: true, verify: 'full', caFile: './ca.pem' },
    },
    controlPlane: {
      host: 'control.invalid', database: 'control', user: 'accordo', password: SENTINEL,
      tls: { enabled: true, verify: 'full', caFile: './ca.pem' },
    },
    spine: { mode: 'production', tenant: { id: 'acme' } },
    identityVerifier: './providers/identity-verifier.mjs',
  };
  for (const [name, document, code] of [
    ['legacy.json', { contract: 1, ...base }, 'DEPLOYMENT_STORAGE_SECRET_REFERENCE_REQUIRED'],
    ['env.json', {
      contract: 2,
      ...base,
      connection: { ...base.connection, password: undefined, passwordSecret: 'pg.data.password' },
      controlPlane: { ...base.controlPlane, password: undefined, passwordSecret: 'pg.control.password' },
      secretProvider: { kind: 'environment' },
    }, 'SECRET_PROVIDER_TRUST_REFUSED'],
  ]) {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(document));
    chmodSync(path, 0o600);
    assert.throws(
      () => loadDeploymentStorage({ configPath: path, env: {} }),
      (error) => error?.code === code && !errorBlob(error).includes(SENTINEL),
    );
  }
});
