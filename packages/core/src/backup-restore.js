// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import {
  access, chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm, writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { requireActor } from './actor.js';
import { AppError } from './errors.js';
import {
  reportBackupOperation,
  requireTelemetrySink,
  telemetryDurationMs,
  telemetryErrorCode,
} from './observability-export.js';
import { DATA_ADVISORY_LOCK, DATA_RESTORE_CHILD_LOCK } from './postgresql-authority.js';
import { readTrustedRegularFile } from './trusted-file.js';

export const BACKUP_CONTRACT = 1;
const BACKUP_TOOL_TIMEOUT_CEILING_MS = 300_000;
export const BACKUP_ADAPTERS = Object.freeze(['postgresql']);
export const BACKUP_ARTIFACT_NAME = 'artifact.dump';
export const BACKUP_MANIFEST_NAME = 'manifest.json';
export const BACKUP_TOOL_MAJOR = 16;
export const BACKUP_TOOL_TIMEOUT_MS = 60_000;

const PROVIDER_KEYS = Object.freeze([
  'contract', 'name', 'adapter', 'inspectAuthority', 'createArtifact', 'prepareRestore', 'withTargetLock', 'restoreArtifact',
]);
const EVIDENCE_KEYS = Object.freeze([
  'contract', 'adapter', 'bindingUuid', 'tenantFingerprint', 'resourceFingerprint',
  'migrationSetFingerprint', 'repositoryFingerprint',
]);
const AUTHORITY_KEYS = Object.freeze([
  'bindingUuid', 'tenantFingerprint', 'resourceFingerprint',
  'migrationSetFingerprint', 'repositoryFingerprint',
]);
const EXPECTED_KEYS = Object.freeze([
  ...AUTHORITY_KEYS, 'artifactDigest', 'manifestDigest', 'targetResourceFingerprint',
]);
const MANIFEST_KEYS = Object.freeze(['contract', 'adapter', 'createdAt', 'source', 'artifact', 'provider']);
const SOURCE_KEYS = Object.freeze(AUTHORITY_KEYS);
const ARTIFACT_KEYS = Object.freeze(['algorithm', 'digest']);
const PROVIDER_MANIFEST_KEYS = Object.freeze(['contract', 'name', 'tool']);
const TOOL_KEYS = Object.freeze(['name', 'major', 'version']);
const CONNECTION_KEYS = Object.freeze(['withEnvironment', 'resourceFingerprint']);
const ENV_KEYS = Object.freeze([
  'PGHOST', 'PGHOSTADDR', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD',
  'PGSSLMODE', 'PGSSLROOTCERT', 'PGGSSENCMODE',
]);
const RESTORE_CONTROL_KEYS = Object.freeze(['contract', 'authorizeAndRecordAttempt', 'recordOutcome']);
const RESTORE_RECEIPT_KEYS = Object.freeze([
  'id', 'attempt', 'outcome', 'artifactDigest', 'manifestDigest', 'targetResourceFingerprint',
]);
const RESTORE_ATTEMPTS = Object.freeze(['new', 'existing']);
const RESTORE_OUTCOMES = Object.freeze(['succeeded', 'refused', 'possibly-partial']);
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const TOOL_VERSION = /^(?:\d+(?:\.\d+){0,3}|fixture-\d+(?:\.\d+){0,3})$/;
const OPERATION_ID = /^[a-z0-9][a-z0-9._:-]*$/i;
const frameworkErrors = new WeakSet();
const nativeLockedTargets = new WeakMap();
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);

function failure(code, message, details = { contract: BACKUP_CONTRACT }) {
  const error = new AppError(message, { code, status: 500, details });
  frameworkErrors.add(error);
  return error;
}

function refuse(code, message, details) {
  throw failure(code, message, details);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function snapshot(value, keys, code = 'BACKUP_CONTRACT_INVALID') {
  try {
    if (!isPlainObject(value)) refuse(code, 'backup input is not a closed contract');
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length || names.length !== keys.length
      || names.some((key) => HOSTILE_KEYS.includes(key) || !keys.includes(key))) {
      refuse(code, 'backup input is not a closed contract');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        refuse(code, 'backup input is not a closed contract');
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
    refuse(code, 'backup input is not a closed contract');
  }
}

function snapshotOptional(value, allowed, required, code) {
  try {
    if (!isPlainObject(value)) refuse(code, 'backup input is not a closed contract');
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length
      || names.some((key) => HOSTILE_KEYS.includes(key) || !allowed.includes(key))
      || required.some((key) => !names.includes(key))) {
      refuse(code, 'backup input is not a closed contract');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of names) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set) {
        refuse(code, 'backup input is not a closed contract');
      }
      result[key] = descriptor.value;
    }
    return result;
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
    refuse(code, 'backup input is not a closed contract');
  }
}

function exactString(value, max = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\0-\x1f\x7f]/.test(value);
}

function fingerprint(value) { return typeof value === 'string' && FINGERPRINT.test(value); }

function evidenceDocument(value) {
  const item = snapshot(value, EVIDENCE_KEYS, 'BACKUP_EVIDENCE_INVALID');
  if (item.contract !== BACKUP_CONTRACT || item.adapter !== 'postgresql'
    || !UUID.test(item.bindingUuid) || !fingerprint(item.tenantFingerprint)
    || !fingerprint(item.resourceFingerprint) || !fingerprint(item.migrationSetFingerprint)
    || !fingerprint(item.repositoryFingerprint)) {
    refuse('BACKUP_EVIDENCE_INVALID', 'backup source evidence is incomplete');
  }
  return Object.freeze(item);
}

function expectedDocument(value) {
  const item = snapshot(value, EXPECTED_KEYS, 'BACKUP_EXPECTED_INTENT_INVALID');
  if (!UUID.test(item.bindingUuid) || !fingerprint(item.tenantFingerprint)
    || !fingerprint(item.resourceFingerprint) || !fingerprint(item.migrationSetFingerprint)
    || !fingerprint(item.repositoryFingerprint) || !fingerprint(item.artifactDigest)
    || !fingerprint(item.manifestDigest) || !fingerprint(item.targetResourceFingerprint)) {
    refuse('BACKUP_EXPECTED_INTENT_INVALID', 'restore expected intent is incomplete');
  }
  return Object.freeze(item);
}

function safeConnection(value) {
  const item = snapshot(value, CONNECTION_KEYS, 'BACKUP_CONNECTION_INVALID');
  if (typeof item.withEnvironment !== 'function') {
    refuse('BACKUP_CONNECTION_INVALID', 'backup connection provider is invalid');
  }
  if (!fingerprint(item.resourceFingerprint)) {
    refuse('BACKUP_CONNECTION_INVALID', 'backup connection resource authority is invalid');
  }
  return Object.freeze(item);
}

function safeEnvironment(value) {
  try {
    if (!isPlainObject(value)) refuse('BACKUP_CONNECTION_INVALID', 'backup connection environment is invalid');
    const names = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length || names.some((key) => !ENV_KEYS.includes(key))) {
      refuse('BACKUP_CONNECTION_INVALID', 'backup connection environment is invalid');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of names) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.get || descriptor.set
        || !exactString(descriptor.value, key === 'PGPASSWORD' ? 65_536 : 512)) {
        refuse('BACKUP_CONNECTION_INVALID', 'backup connection environment is invalid');
      }
      result[key] = descriptor.value;
    }
    for (const required of ['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER']) {
      if (!Object.hasOwn(result, required)) refuse('BACKUP_CONNECTION_INVALID', 'backup connection environment is incomplete');
    }
    if (Object.hasOwn(result, 'PGGSSENCMODE') && result.PGGSSENCMODE !== 'disable') {
      refuse('BACKUP_CONNECTION_TLS_REFUSED', 'backup connections require GSS encryption negotiation to be disabled');
    }
    if (result.PGSSLMODE === 'verify-full') {
      if (!Object.hasOwn(result, 'PGSSLROOTCERT')) {
        refuse('BACKUP_CONNECTION_TLS_REFUSED', 'backup connection requires authenticated TLS verification');
      }
      if (!Object.hasOwn(result, 'PGHOSTADDR') || isIP(result.PGHOSTADDR) === 0) {
        refuse('BACKUP_CONNECTION_ENDPOINT_REFUSED', 'remote backup connections require a deployment-pinned network endpoint');
      }
    } else if (result.PGSSLMODE === 'disable') {
      if (Object.hasOwn(result, 'PGSSLROOTCERT')
        || !LOOPBACK_HOSTS.has(result.PGHOST)
        || (Object.hasOwn(result, 'PGHOSTADDR') && !LOOPBACK_HOSTS.has(result.PGHOSTADDR))) {
        refuse('BACKUP_CONNECTION_TLS_REFUSED', 'plaintext backup connections are limited to explicit loopback development or test transport');
      }
    } else {
      refuse('BACKUP_CONNECTION_TLS_REFUSED', 'backup connection requires authenticated TLS verification');
    }
    return result;
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
    refuse('BACKUP_CONNECTION_INVALID', 'backup connection environment is invalid');
  }
}

function actorDocument(value) {
  const item = snapshot(value, ['type', 'id'], 'BACKUP_RESTORE_ACTOR_INVALID');
  try {
    const actor = requireActor(item, 'actor');
    if (!exactString(actor.id, 200)) refuse('BACKUP_RESTORE_ACTOR_INVALID', 'restore actor is invalid');
    return Object.freeze(actor);
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
    refuse('BACKUP_RESTORE_ACTOR_INVALID', 'restore actor is invalid');
  }
}

function restoreControlDocument(value) {
  const item = snapshot(value, RESTORE_CONTROL_KEYS, 'BACKUP_RESTORE_CONTROL_INVALID');
  if (item.contract !== BACKUP_CONTRACT || typeof item.authorizeAndRecordAttempt !== 'function'
    || typeof item.recordOutcome !== 'function') {
    refuse('BACKUP_RESTORE_CONTROL_INVALID', 'restore control-plane receipt boundary is invalid');
  }
  return Object.freeze(item);
}

async function beginRestore(control, actor, intent, operationId) {
  const receipt = await providerCall(
    'restore-authority-attempt',
    () => control.authorizeAndRecordAttempt(Object.freeze({
      contract: BACKUP_CONTRACT,
      operationId,
      artifactDigest: intent.artifactDigest,
      manifestDigest: intent.manifestDigest,
      targetResourceFingerprint: intent.targetResourceFingerprint,
      actor,
      expected: Object.freeze(Object.fromEntries(AUTHORITY_KEYS.map((key) => [key, intent[key]]))),
    })),
  );
  const accepted = snapshot(receipt, RESTORE_RECEIPT_KEYS, 'BACKUP_RESTORE_RECEIPT_INVALID');
  if (!exactString(accepted.id, 200)
    || !RESTORE_ATTEMPTS.includes(accepted.attempt)
    || !(accepted.outcome === null || RESTORE_OUTCOMES.includes(accepted.outcome))
    || (accepted.attempt === 'new' && accepted.outcome !== null)
    || accepted.artifactDigest !== intent.artifactDigest
    || accepted.manifestDigest !== intent.manifestDigest
    || accepted.targetResourceFingerprint !== intent.targetResourceFingerprint) {
    refuse('BACKUP_RESTORE_RECEIPT_INVALID', 'restore attempt receipt is invalid');
  }
  return Object.freeze({
    ...accepted,
    operationId,
    artifactDigest: intent.artifactDigest,
    manifestDigest: intent.manifestDigest,
    targetResourceFingerprint: intent.targetResourceFingerprint,
  });
}

async function finishRestore(control, receipt, outcome) {
  if (!RESTORE_OUTCOMES.includes(outcome)) refuse('BACKUP_RESTORE_RECEIPT_INVALID', 'restore outcome is invalid');
  await providerCall(
    'restore-outcome',
    () => control.recordOutcome(Object.freeze({
      contract: BACKUP_CONTRACT,
      operationId: receipt.operationId,
      receiptId: receipt.id,
      artifactDigest: receipt.artifactDigest,
      manifestDigest: receipt.manifestDigest,
      targetResourceFingerprint: receipt.targetResourceFingerprint,
      outcome,
    })),
  );
}

async function useConnection(connection, consumer) {
  try {
    return await connection.withEnvironment(async (provided) => consumer(safeEnvironment(provided)));
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
    refuse('BACKUP_CONNECTION_FAILED', 'backup connection could not be used');
  }
}

function affineConnection(environment, resourceFingerprint) {
  let active = true;
  return Object.freeze({
    connection: Object.freeze({
      resourceFingerprint,
      async withEnvironment(consumer) {
        if (!active || typeof consumer !== 'function') {
          refuse('BACKUP_CONNECTION_AFFINITY_REFUSED', 'backup connection is outside its affine operation');
        }
        return consumer(Object.freeze({ ...environment }));
      },
    }),
    close() { active = false; },
  });
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function psqlPath(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function useAffineConnection(connection, consumer) {
  return useConnection(connection, async (environment) => {
    let pinnedDirectory = null;
    let pinnedEnvironment = environment;
    try {
      if (environment.PGSSLMODE === 'verify-full') {
        let ca;
        try {
          ca = readTrustedRegularFile(environment.PGSSLROOTCERT, {
            maxBytes: 64 * 1024,
            untrusted: () => refuse('BACKUP_CONNECTION_TLS_REFUSED', 'backup connection TLS authority is unavailable'),
          });
        } catch (error) {
          if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
          refuse('BACKUP_CONNECTION_TLS_REFUSED', 'backup connection TLS authority is unavailable');
        }
        pinnedDirectory = await mkdtemp(join(tmpdir(), '.accordo-backup-tls-'));
        const pinnedPath = join(pinnedDirectory, 'root.crt');
        await writeFile(pinnedPath, ca, { mode: 0o600, flag: 'wx' });
        await chmod(pinnedPath, 0o400);
        pinnedEnvironment = Object.freeze({ ...environment, PGSSLROOTCERT: pinnedPath });
      }
      pinnedEnvironment = Object.freeze({ ...pinnedEnvironment, PGGSSENCMODE: 'disable' });
      const affine = affineConnection(pinnedEnvironment, connection.resourceFingerprint);
      try { return await consumer(affine.connection); } finally { affine.close(); }
    } finally {
      if (pinnedDirectory) {
        try {
          await rm(pinnedDirectory, { recursive: true, force: true });
        } catch {
          refuse('BACKUP_TLS_CLEANUP_FAILED', 'backup TLS authority cleanup failed');
        }
      }
    }
  });
}

async function readBounded(handle, max, code) {
  const chunks = [];
  let total = 0;
  let position = 0;
  while (true) {
    const buffer = Buffer.allocUnsafe(Math.min(16 * 1024, max + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    total += bytesRead;
    if (total > max) refuse(code, 'backup file exceeds its bound');
    chunks.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return Buffer.concat(chunks);
}

async function copyAndDigest(handle, copyPath = null) {
  const hash = createHash('sha256');
  let output = null;
  let position = 0;
  try {
    if (copyPath) output = await open(copyPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    while (true) {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      const bytes = buffer.subarray(0, bytesRead);
      hash.update(bytes);
      if (output) await output.write(bytes);
      position += bytesRead;
    }
    if (position === 0) refuse('BACKUP_ARTIFACT_INVALID', 'backup artifact is empty');
    if (output) await output.sync();
    return hash.digest('hex');
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
    refuse('BACKUP_ARTIFACT_UNREADABLE', 'backup artifact could not be read');
  } finally { await output?.close().catch(() => {}); }
}

function canonicalManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function parseManifest(bytes) {
  if (bytes.length > 64 * 1024) refuse('BACKUP_MANIFEST_INVALID', 'backup manifest exceeds its bound');
  let decoded;
  try { decoded = JSON.parse(bytes.toString('utf8')); } catch { refuse('BACKUP_MANIFEST_INVALID', 'backup manifest is invalid'); }
  const manifest = snapshot(decoded, MANIFEST_KEYS, 'BACKUP_MANIFEST_INVALID');
  const source = snapshot(manifest.source, SOURCE_KEYS, 'BACKUP_MANIFEST_INVALID');
  const artifact = snapshot(manifest.artifact, ARTIFACT_KEYS, 'BACKUP_MANIFEST_INVALID');
  const provider = snapshot(manifest.provider, PROVIDER_MANIFEST_KEYS, 'BACKUP_MANIFEST_INVALID');
  const tool = snapshot(provider.tool, TOOL_KEYS, 'BACKUP_MANIFEST_INVALID');
  if (manifest.contract !== BACKUP_CONTRACT || manifest.adapter !== 'postgresql'
    || typeof manifest.createdAt !== 'string' || !UTC_INSTANT.test(manifest.createdAt)
    || !Number.isFinite(Date.parse(manifest.createdAt))
    || !UUID.test(source.bindingUuid) || !fingerprint(source.tenantFingerprint)
    || !fingerprint(source.resourceFingerprint) || !fingerprint(source.migrationSetFingerprint)
    || !fingerprint(source.repositoryFingerprint) || artifact.algorithm !== 'sha256'
    || !fingerprint(artifact.digest) || provider.contract !== BACKUP_CONTRACT
    || !NAME.test(provider.name) || !['pg_dump', 'fixture'].includes(tool.name)
    || tool.major !== BACKUP_TOOL_MAJOR || !TOOL_VERSION.test(tool.version)) {
    refuse('BACKUP_MANIFEST_INVALID', 'backup manifest is invalid');
  }
  return Object.freeze({
    contract: BACKUP_CONTRACT,
    adapter: 'postgresql',
    createdAt: manifest.createdAt,
    source: Object.freeze(source),
    artifact: Object.freeze(artifact),
    provider: Object.freeze({ contract: BACKUP_CONTRACT, name: provider.name, tool: Object.freeze(tool) }),
  });
}

function compareExpected(source, expected) {
  for (const key of AUTHORITY_KEYS) {
    if (source[key] !== expected[key]) {
      refuse('BACKUP_EXPECTED_INTENT_MISMATCH', 'backup does not match the independently supplied restore intent', {
        contract: BACKUP_CONTRACT,
        field: key,
      });
    }
  }
}

async function trustedBundle(bundlePath) {
  if (!exactString(bundlePath, 4096)) refuse('BACKUP_PATH_INVALID', 'backup bundle path is invalid');
  const root = resolve(bundlePath);
  let rootStat;
  try {
    rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('not directory');
    const entries = (await readdir(root)).sort();
    if (entries.length !== 2 || entries[0] !== BACKUP_ARTIFACT_NAME || entries[1] !== BACKUP_MANIFEST_NAME) throw new Error('entries');
    for (const name of entries) {
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not file');
    }
  } catch {
    refuse('BACKUP_BUNDLE_INVALID', 'backup bundle is not a closed trusted directory');
  }
  return { root, artifactPath: join(root, BACKUP_ARTIFACT_NAME), manifestPath: join(root, BACKUP_MANIFEST_NAME) };
}

async function verifyBundle(bundlePath, expected, copyPath = null) {
  const intent = expectedDocument(expected);
  const bundle = await trustedBundle(bundlePath);
  let manifestHandle;
  let artifactHandle;
  try {
    manifestHandle = await open(bundle.manifestPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    artifactHandle = await open(bundle.artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const manifestStat = await manifestHandle.stat();
    const artifactStat = await artifactHandle.stat();
    if (!manifestStat.isFile() || !artifactStat.isFile()) refuse('BACKUP_BUNDLE_INVALID', 'backup bundle files are invalid');
    const manifestBytes = await readBounded(manifestHandle, 64 * 1024, 'BACKUP_MANIFEST_INVALID');
    const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
    if (manifestDigest !== intent.manifestDigest) {
      refuse('BACKUP_EXPECTED_INTENT_MISMATCH', 'backup manifest does not match the independently supplied restore intent', {
        contract: BACKUP_CONTRACT,
        field: 'manifestDigest',
      });
    }
    const manifest = parseManifest(manifestBytes);
    compareExpected(manifest.source, intent);
    const digest = await copyAndDigest(artifactHandle, copyPath);
    if (digest !== manifest.artifact.digest) refuse('BACKUP_ARTIFACT_TAMPERED', 'backup artifact digest does not match its manifest');
    if (digest !== intent.artifactDigest) {
      refuse('BACKUP_EXPECTED_INTENT_MISMATCH', 'backup artifact does not match the independently supplied restore intent', {
        contract: BACKUP_CONTRACT,
        field: 'artifactDigest',
      });
    }
    return Object.freeze({ contract: BACKUP_CONTRACT, verified: true, manifest });
  } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
    refuse('BACKUP_BUNDLE_INVALID', 'backup bundle could not be opened safely');
  } finally {
    await artifactHandle?.close().catch(() => {});
    await manifestHandle?.close().catch(() => {});
  }
}

async function digestTrustedPath(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) refuse('BACKUP_ARTIFACT_INVALID', 'backup artifact is not a regular file');
    return await copyAndDigest(handle);
  } finally { await handle?.close().catch(() => {}); }
}

export function defineBackupProvider(definition) {
  const provider = snapshot(definition, PROVIDER_KEYS, 'BACKUP_PROVIDER_INVALID');
  if (provider.contract !== BACKUP_CONTRACT || provider.adapter !== 'postgresql' || !NAME.test(provider.name)
    || typeof provider.inspectAuthority !== 'function' || typeof provider.createArtifact !== 'function'
    || typeof provider.prepareRestore !== 'function'
    || typeof provider.withTargetLock !== 'function' || typeof provider.restoreArtifact !== 'function') {
    refuse('BACKUP_PROVIDER_INVALID', 'backup provider is not a closed runtime contract');
  }
  return Object.freeze(provider);
}

function acceptedObservedAuthority(value, code) {
  const observed = snapshot(
    value,
    ['bindingUuid', 'tenantFingerprint', 'resourceFingerprint', 'migrationSetFingerprint'],
    code,
  );
  if (!UUID.test(observed.bindingUuid) || !fingerprint(observed.tenantFingerprint)
    || !fingerprint(observed.resourceFingerprint) || !fingerprint(observed.migrationSetFingerprint)) {
    refuse(code, 'database authority evidence is incomplete');
  }
  return observed;
}

function compareLiveAuthority(observed, expected, code, message) {
  for (const key of ['bindingUuid', 'tenantFingerprint', 'resourceFingerprint', 'migrationSetFingerprint']) {
    if (observed[key] !== expected[key]) refuse(code, message, { contract: BACKUP_CONTRACT, field: key });
  }
}

async function providerCall(operation, callback) {
  try { return await callback(); } catch (error) {
    if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
    refuse('BACKUP_PROVIDER_FAILED', 'backup provider failed', { contract: BACKUP_CONTRACT, operation });
  }
}

const TARGET_LOCK_COMPLETED = Object.freeze({ completed: true });

async function runWithTargetLock(provider, connection, operation) {
  let accepting = true;
  let invalid = false;
  let completion = null;
  const callback = (state) => {
    if (!accepting || completion) {
      invalid = true;
      const rejected = Promise.reject(failure(
        'BACKUP_TARGET_LOCK_INVALID',
        'restore target lock invoked its operation outside the unique settlement',
      ));
      rejected.catch(() => {});
      return rejected;
    }
    completion = Promise.resolve().then(() => operation(state)).then(() => TARGET_LOCK_COMPLETED);
    completion.catch(() => {});
    return completion;
  };
  let providerResult;
  let providerError = null;
  try {
    providerResult = await providerCall(
      'target-lock',
      () => provider.withTargetLock({ connection }, callback),
    );
  } catch (error) {
    providerError = error;
  } finally {
    accepting = false;
  }
  let completionResult;
  if (completion) {
    try { completionResult = await completion; } catch (error) {
      if (!providerError) providerError = error;
    }
  }
  if (providerError) throw providerError;
  if (invalid || !completion || providerResult !== TARGET_LOCK_COMPLETED
    || completionResult !== TARGET_LOCK_COMPLETED) {
    refuse('BACKUP_TARGET_LOCK_INVALID', 'restore target lock did not settle its unique operation');
  }
}

export function createBackupOperations(options) {
  const configuration = snapshotOptional(
    options,
    ['adapter', 'provider', 'evidence', 'connection', 'restoreControl', 'clock', 'telemetry'],
    ['adapter', 'provider', 'evidence', 'connection', 'restoreControl'],
    'BACKUP_CONTRACT_INVALID',
  );
  if (configuration.adapter !== 'postgresql') {
    refuse('BACKUP_ADAPTER_UNSUPPORTED', 'backup and restore are supported only for PostgreSQL');
  }
  const provider = defineBackupProvider(configuration.provider);
  const evidence = evidenceDocument(configuration.evidence);
  const connection = safeConnection(configuration.connection);
  const restoreControl = restoreControlDocument(configuration.restoreControl);
  if (configuration.clock !== undefined && typeof configuration.clock !== 'function') {
    refuse('BACKUP_CLOCK_INVALID', 'backup clock is invalid');
  }
  const clock = configuration.clock ?? (() => new Date().toISOString());
  const telemetry = requireTelemetrySink(
    configuration.telemetry,
    (message) => refuse('BACKUP_TELEMETRY_INVALID', message),
  );

  /**
   * Report one backup operation (Spine v4C), observing and re-raising.
   *
   * The bundle path, the connection, the manifest, every fingerprint and the
   * native tool identity stay inside: only the operation kind, the outcome and
   * a charset-validated refusal code cross the boundary. A refusal that also
   * left the target possibly partial is reported as such rather than as a
   * clean refusal, because those are operationally different situations. The
   * clock is read defensively — `create` has its own BACKUP_CLOCK_INVALID
   * path, and telemetry must not pre-empt it.
   *
   * @param {'create'|'verify'|'restore'} operation
   * @param {(input: any) => Promise<any>} run
   */
  const instrumented = (operation, run) => {
    if (!telemetry) return run;
    const instant = () => { try { return clock(); } catch { return null; } };
    return async (input) => {
      const startedAt = instant();
      const settle = (outcome, errorCode) => reportBackupOperation(telemetry, {
        operation,
        outcome,
        durationMs: telemetryDurationMs(startedAt, instant()),
        errorCode,
      });
      try {
        const result = await run(input);
        settle('succeeded');
        return result;
      } catch (error) {
        const partial = /** @type {any} */ (error)?.details?.targetState === 'possibly-partial';
        settle(partial ? 'possibly-partial' : 'refused', telemetryErrorCode(error));
        throw error;
      }
    };
  };

  async function verify(input) {
    const request = snapshot(input, ['bundlePath', 'expected'], 'BACKUP_VERIFY_INPUT_INVALID');
    return verifyBundle(request.bundlePath, request.expected);
  }

  return Object.freeze({
    contract: BACKUP_CONTRACT,
    adapter: 'postgresql',
    create: instrumented('create', async (input) => {
      const request = snapshot(input, ['bundlePath'], 'BACKUP_CREATE_INPUT_INVALID');
      if (!exactString(request.bundlePath, 4096)) refuse('BACKUP_PATH_INVALID', 'backup bundle path is invalid');
      if (connection.resourceFingerprint !== evidence.resourceFingerprint) {
        refuse('BACKUP_SOURCE_AUTHORITY_MISMATCH', 'backup connection does not match the supplied source authority', {
          contract: BACKUP_CONTRACT,
          field: 'resourceFingerprint',
        });
      }
      const bundlePath = request.bundlePath;
      return useAffineConnection(connection, async (boundConnection) => {
        const destination = resolve(bundlePath);
        try { await access(destination); refuse('BACKUP_DESTINATION_EXISTS', 'backup destination already exists'); } catch (error) {
          if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
        }
        const observedSource = acceptedObservedAuthority(
          await providerCall('inspect-source', () => provider.inspectAuthority({ connection: boundConnection })),
          'BACKUP_SOURCE_AUTHORITY_INVALID',
        );
        compareLiveAuthority(
          observedSource,
          evidence,
          'BACKUP_SOURCE_AUTHORITY_MISMATCH',
          'backup connection does not match the supplied source authority',
        );
        await mkdir(dirname(destination), { recursive: true });
        const stage = await mkdtemp(join(dirname(destination), '.accordo-backup-'));
        try {
        const artifactPath = join(stage, BACKUP_ARTIFACT_NAME);
        const tool = await providerCall('create', () => provider.createArtifact({ artifactPath, connection: boundConnection }));
        const acceptedTool = snapshot(tool, TOOL_KEYS, 'BACKUP_TOOL_INVALID');
        if (!['pg_dump', 'fixture'].includes(acceptedTool.name) || acceptedTool.major !== BACKUP_TOOL_MAJOR
          || !TOOL_VERSION.test(acceptedTool.version)) refuse('BACKUP_TOOL_INVALID', 'backup tool identity is invalid');
        const stageEntries = (await readdir(stage)).sort();
        if (stageEntries.length !== 1 || stageEntries[0] !== BACKUP_ARTIFACT_NAME) {
          refuse('BACKUP_ARTIFACT_INVALID', 'backup provider did not create one closed artifact');
        }
        const artifactStat = await lstat(artifactPath);
        if (!artifactStat.isFile() || artifactStat.isSymbolicLink()) {
          refuse('BACKUP_ARTIFACT_INVALID', 'backup provider did not create a regular artifact');
        }
        const artifactHandle = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        let digest;
        try { digest = await copyAndDigest(artifactHandle); } finally { await artifactHandle.close(); }
        let createdAt;
        try { createdAt = clock(); } catch { refuse('BACKUP_CLOCK_INVALID', 'backup clock failed'); }
        if (typeof createdAt !== 'string' || !UTC_INSTANT.test(createdAt)
          || !Number.isFinite(Date.parse(createdAt))) refuse('BACKUP_CLOCK_INVALID', 'backup clock returned an invalid instant');
        const manifest = Object.freeze({
          contract: BACKUP_CONTRACT,
          adapter: 'postgresql',
          createdAt,
          source: Object.freeze(Object.fromEntries(AUTHORITY_KEYS.map((key) => [key, evidence[key]]))),
          artifact: Object.freeze({ algorithm: 'sha256', digest }),
          provider: Object.freeze({ contract: BACKUP_CONTRACT, name: provider.name, tool: Object.freeze(acceptedTool) }),
        });
        const manifestBytes = canonicalManifest(manifest);
        const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');
        const handle = await open(join(stage, BACKUP_MANIFEST_NAME), 'wx', 0o600);
        try { await handle.writeFile(manifestBytes, 'utf8'); await handle.sync(); } finally { await handle.close(); }
        const syncedArtifact = await open(artifactPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await syncedArtifact.sync(); } finally { await syncedArtifact.close(); }
        await rename(stage, destination);
        return Object.freeze({
          contract: BACKUP_CONTRACT,
          bundleCommitted: true,
          artifactDigest: digest,
          manifestDigest,
          manifest,
        });
        } catch (error) {
          await rm(stage, { recursive: true, force: true }).catch(() => {});
          throw error;
        }
      });
    }),
    verify: instrumented('verify', verify),
    restore: instrumented('restore', async (input) => {
      const request = snapshot(
        input,
        ['bundlePath', 'expected', 'target', 'actor', 'operationId'],
        'BACKUP_RESTORE_INPUT_INVALID',
      );
      if (!exactString(request.bundlePath, 4096)) refuse('BACKUP_PATH_INVALID', 'backup bundle path is invalid');
      if (!exactString(request.operationId, 200) || !OPERATION_ID.test(request.operationId)) {
        refuse('BACKUP_RESTORE_OPERATION_INVALID', 'restore operation identity is invalid');
      }
      const actor = actorDocument(request.actor);
      const intent = expectedDocument(request.expected);
      const scratch = await mkdtemp(join(tmpdir(), '.accordo-restore-'));
      const scratchArtifact = join(scratch, BACKUP_ARTIFACT_NAME);
      let receipt = null;
      let outcome = 'refused';
      let targetMutationStarted = false;
      try {
        const verified = await verifyBundle(request.bundlePath, request.expected, scratchArtifact);
        await chmod(scratchArtifact, 0o400);
        const targetConnection = safeConnection(request.target);
        if (targetConnection.resourceFingerprint !== intent.targetResourceFingerprint) {
          refuse('BACKUP_TARGET_AUTHORITY_MISMATCH', 'restore target does not match the independently supplied target authority', {
            contract: BACKUP_CONTRACT,
            field: 'targetResourceFingerprint',
          });
        }
        await providerCall('prepare-restore', () => provider.prepareRestore());
        receipt = await beginRestore(restoreControl, actor, intent, request.operationId);
        if (receipt.attempt === 'existing' && receipt.outcome === null) {
          receipt = null;
          throw failure(
            'BACKUP_RESTORE_RECONCILIATION_REQUIRED',
            'restore operation has an indeterminate prior attempt and requires explicit operator reconciliation',
            { contract: BACKUP_CONTRACT, targetState: 'indeterminate' },
          );
        }
        if (receipt.outcome !== null) {
          const replayedOutcome = receipt.outcome;
          receipt = null;
          if (replayedOutcome === 'succeeded') {
            return Object.freeze({
              contract: BACKUP_CONTRACT,
              restored: true,
              replayed: true,
              authority: 'normal-startup-required',
              manifest: verified.manifest,
            });
          }
          throw failure('BACKUP_RESTORE_REPLAY_REFUSED', 'restore operation already has a terminal non-success outcome', {
            contract: BACKUP_CONTRACT,
            outcome: replayedOutcome,
          });
        }
        const result = await useAffineConnection(targetConnection, async (boundConnection) => {
          let restoredResult = null;
          await runWithTargetLock(provider, boundConnection, async (state) => {
            try {
              const inspected = snapshot(
                state,
                ['empty', 'lockedTarget', 'inspectAuthority'],
                'BACKUP_TARGET_INSPECTION_INVALID',
              );
              if (typeof inspected.empty !== 'boolean' || !inspected.lockedTarget
                || (typeof inspected.lockedTarget !== 'object' && typeof inspected.lockedTarget !== 'function')
                || typeof inspected.inspectAuthority !== 'function') {
                refuse('BACKUP_TARGET_INSPECTION_INVALID', 'restore target inspection is invalid');
              }
              if (!inspected.empty) refuse('BACKUP_TARGET_NOT_EMPTY', 'restore target is not explicitly empty');
              targetMutationStarted = true;
              try {
                await providerCall('restore', () => provider.restoreArtifact({
                  artifactPath: scratchArtifact,
                  connection: boundConnection,
                  lockedTarget: inspected.lockedTarget,
                  expectedAuthority: {
                    bindingUuid: verified.manifest.source.bindingUuid,
                    tenantFingerprint: verified.manifest.source.tenantFingerprint,
                    resourceFingerprint: verified.manifest.source.resourceFingerprint,
                    migrationSetFingerprint: verified.manifest.source.migrationSetFingerprint,
                  },
                }));
              } catch {
                throw failure('BACKUP_RESTORE_PARTIAL', 'restore failed and the target must be treated as possibly partial', {
                  contract: BACKUP_CONTRACT,
                  targetState: 'possibly-partial',
                });
              }
              if (await digestTrustedPath(scratchArtifact) !== verified.manifest.artifact.digest) {
                refuse('BACKUP_ARTIFACT_CHANGED_DURING_RESTORE', 'the executed backup artifact changed during restore');
              }
              const restored = acceptedObservedAuthority(
                await providerCall('inspect-restored-locked', () => inspected.inspectAuthority()),
                'BACKUP_RESTORED_AUTHORITY_MISMATCH',
              );
              compareLiveAuthority(
                restored,
                verified.manifest.source,
                'BACKUP_RESTORED_AUTHORITY_MISMATCH',
                'restored database evidence does not match expected source authority',
              );
              restoredResult = Object.freeze({
                contract: BACKUP_CONTRACT,
                restored: true,
                replayed: false,
                authority: 'normal-startup-required',
                manifest: verified.manifest,
              });
              await finishRestore(restoreControl, receipt, 'succeeded');
              receipt = null;
            } catch (error) {
              if (targetMutationStarted && receipt) {
                await finishRestore(restoreControl, receipt, 'possibly-partial');
                receipt = null;
              }
              throw error;
            }
          });
          if (!restoredResult) refuse('BACKUP_TARGET_LOCK_INVALID', 'restore target lock completed without verified authority');
          return restoredResult;
        });
        return result;
      } catch (error) {
        if (receipt) {
          if (targetMutationStarted) throw error;
          await finishRestore(restoreControl, receipt, outcome);
          receipt = null;
        }
        throw error;
      } finally {
        await chmod(scratchArtifact, 0o600).catch(() => {});
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    }),
  });
}

async function inspectRestoredAuthority(connection, createPool) {
  return useConnection(connection, async (environment) => {
    try {
      return await withNativeClient(environment, async (client) => {
        return inspectRestoredAuthorityClient(client);
      }, createPool);
    } catch (error) {
      if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
      refuse('BACKUP_RESTORED_AUTHORITY_MISMATCH', 'restored database authority could not be verified');
    }
  });
}

async function inspectRestoredAuthorityClient(client) {
  const marker = await client.query('SELECT tenant_slug, data_plane_id FROM accordo.spine_data_plane_binding');
  const audit = await client.query(`SELECT tenant_fingerprint, resource_fingerprint, migration_set_fingerprint
    FROM accordo.startup_audit WHERE plane = 'data' ORDER BY created_at DESC, id DESC LIMIT 1`);
  if (marker.rowCount !== 1 || audit.rowCount !== 1) {
    refuse('BACKUP_RESTORED_AUTHORITY_MISMATCH', 'restored database has no singular binding authority');
  }
  return Object.freeze({
    bindingUuid: String(marker.rows[0].data_plane_id),
    tenantFingerprint: String(audit.rows[0].tenant_fingerprint),
    resourceFingerprint: String(audit.rows[0].resource_fingerprint),
    migrationSetFingerprint: String(audit.rows[0].migration_set_fingerprint),
  });
}

function clientOptions(environment) {
  let ssl = false;
  if (environment.PGSSLMODE === 'verify-full') {
    let ca;
    try {
      ca = readTrustedRegularFile(environment.PGSSLROOTCERT, {
        maxBytes: 64 * 1024,
        untrusted: () => refuse('BACKUP_CONNECTION_TLS_REFUSED', 'backup connection TLS authority is unavailable'),
      });
    } catch (error) {
      if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
      refuse('BACKUP_CONNECTION_TLS_REFUSED', 'backup connection TLS authority is unavailable');
    }
    if (!ca) refuse('BACKUP_CONNECTION_TLS_REFUSED', 'backup connection TLS authority is unavailable');
    ssl = Object.freeze({
      rejectUnauthorized: true,
      ca,
      servername: environment.PGHOST,
    });
  }
  return {
    host: environment.PGHOSTADDR ?? environment.PGHOST,
    port: Number(environment.PGPORT),
    database: environment.PGDATABASE,
    user: environment.PGUSER,
    password: environment.PGPASSWORD ?? '',
    ssl,
    acquisitionDeadlineMs: 2000,
    queryDeadlineMs: 2000,
  };
}

async function withNativeClient(environment, consumer, createPool) {
  if (typeof createPool !== 'function') {
    refuse('BACKUP_DATABASE_CLIENT_UNAVAILABLE', 'PostgreSQL backup database client is unavailable');
  }
  let pool;
  try {
    pool = createPool({ ...clientOptions(environment), max: 1 });
  } catch {
    refuse('BACKUP_DATABASE_CLIENT_UNAVAILABLE', 'PostgreSQL backup database client is unavailable');
  }
  if (!pool || typeof pool.connect !== 'function' || typeof pool.end !== 'function') {
    refuse('BACKUP_DATABASE_CLIENT_UNAVAILABLE', 'PostgreSQL backup database client is unavailable');
  }
  let client;
  try {
    client = await pool.connect();
    return await consumer(client);
  } finally {
    try { client?.release(); } catch { /* pool close remains authoritative */ }
    await pool.end().catch(() => {});
  }
}

async function inspectEmptyClient(client) {
  try {
    const result = await client.query(`WITH user_namespace AS (
        SELECT oid FROM pg_catalog.pg_namespace
        WHERE nspname NOT IN ('pg_catalog', 'information_schema')
          AND nspname NOT LIKE 'pg_toast%'
          AND nspname NOT LIKE 'pg_temp_%'
      ) SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_class c JOIN user_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p','v','m','S','f','c')
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_namespace
        WHERE nspname NOT IN ('pg_catalog', 'information_schema', 'public')
          AND nspname NOT LIKE 'pg_toast%'
          AND nspname NOT LIKE 'pg_temp_%'
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p JOIN user_namespace n ON n.oid = p.pronamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_type t JOIN user_namespace n ON n.oid = t.typnamespace
        WHERE t.typtype IN ('c','d','e','r','m')
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_extension WHERE extname <> 'plpgsql'
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_foreign_data_wrapper
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_foreign_server
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_event_trigger
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_subscription
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_language WHERE lanispl AND lanname <> 'plpgsql'
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_collation c JOIN user_namespace n ON n.oid = c.collnamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_conversion c JOIN user_namespace n ON n.oid = c.connamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_operator o JOIN user_namespace n ON n.oid = o.oprnamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_opclass o JOIN user_namespace n ON n.oid = o.opcnamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_opfamily o JOIN user_namespace n ON n.oid = o.opfnamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_ts_config t JOIN user_namespace n ON n.oid = t.cfgnamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_ts_dict t JOIN user_namespace n ON n.oid = t.dictnamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_ts_parser t JOIN user_namespace n ON n.oid = t.prsnamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_ts_template t JOIN user_namespace n ON n.oid = t.tmplnamespace
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_largeobject_metadata
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_default_acl
      ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_cast WHERE oid >= 16384
      ) AS occupied`);
    return Object.freeze({ empty: result.rows[0]?.occupied === false });
  } catch {
    refuse('BACKUP_TARGET_INSPECTION_FAILED', 'restore target could not be inspected');
  }
}

function toolCommand(value, fallback) {
  const selected = value ?? fallback;
  if (!exactString(selected, 512)) refuse('BACKUP_TOOL_INVALID', 'backup tool command is invalid');
  return selected;
}

async function runTool(command, args, environment, timeoutMs, capture = false) {
  return new Promise((resolveRun, rejectRun) => {
    let settled = false;
    let terminalError = null;
    let output = Buffer.alloc(0);
    let child;
    try {
      child = spawn(command, args, {
        env: {
          PATH: process.env.PATH ?? '',
          LANG: 'C',
          LC_ALL: 'C',
          ...environment,
        },
        detached: process.platform !== 'win32',
        shell: false,
        stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'],
      });
    } catch { rejectRun(failure('BACKUP_TOOL_UNAVAILABLE', 'required PostgreSQL backup tool is unavailable')); return; }
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun(value);
    };
    const terminateGroup = () => {
      if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
        try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* direct-child fallback below */ }
      }
      try { child.kill('SIGKILL'); } catch { /* close/error owns settlement */ }
    };
    const timer = setTimeout(() => {
      terminalError = failure('BACKUP_TOOL_TIMEOUT', 'PostgreSQL backup tool exceeded its deadline');
      terminateGroup();
    }, timeoutMs);
    timer.unref?.();
    child.on('error', () => finish(failure('BACKUP_TOOL_UNAVAILABLE', 'required PostgreSQL backup tool is unavailable')));
    child.stdout?.on('data', (chunk) => {
      if (output.length + chunk.length > 1024) {
        if (!terminalError) {
          terminalError = failure('BACKUP_TOOL_OUTPUT_INVALID', 'PostgreSQL backup tool returned invalid identity output');
          terminateGroup();
        }
      } else output = Buffer.concat([output, chunk]);
    });
    child.on('close', (code, signal) => {
      if (terminalError) finish(terminalError);
      else if (code !== 0 || signal) finish(failure('BACKUP_TOOL_FAILED', 'PostgreSQL backup tool failed'));
      else finish(null, output.toString('utf8').trim());
    });
  });
}

async function toolIdentity(command, expectedName, timeoutMs) {
  const value = await runTool(command, ['--version'], {}, timeoutMs, true);
  const match = typeof value === 'string'
    ? value.match(/^(pg_dump|pg_restore|psql) \(PostgreSQL\) (\d+(?:\.\d+){0,3})(?:\s.*)?$/)
    : null;
  if (!match || match[1] !== expectedName) refuse('BACKUP_TOOL_VERSION_REFUSED', 'PostgreSQL backup tool identity is invalid');
  const version = match[2];
  const major = Number(version.split('.')[0]);
  if (major !== BACKUP_TOOL_MAJOR) refuse('BACKUP_TOOL_VERSION_REFUSED', 'PostgreSQL backup tool major is not supported');
  return Object.freeze({ name: expectedName, major, version });
}

export function createPostgresqlNativeBackupProvider(options = {}) {
  const configuration = snapshotOptional(
    options,
    ['pgDump', 'pgRestore', 'psql', 'timeoutMs', 'createPool'],
    [],
    'BACKUP_PROVIDER_INVALID',
  );
  const dumpCommand = toolCommand(configuration.pgDump, 'pg_dump');
  const restoreCommand = toolCommand(configuration.pgRestore, 'pg_restore');
  const psqlCommand = toolCommand(configuration.psql, 'psql');
  // An out-of-range budget is refused rather than quietly clamped: a caller that
  // asked for ten minutes and silently got sixty seconds would read the timeout
  // as a database fault.
  if (Object.hasOwn(configuration, 'timeoutMs')
    && !(Number.isInteger(configuration.timeoutMs)
      && configuration.timeoutMs > 0 && configuration.timeoutMs <= BACKUP_TOOL_TIMEOUT_CEILING_MS)) {
    refuse('BACKUP_PROVIDER_INVALID', 'backup tool timeout is outside the supported range');
  }
  const timeoutMs = Object.hasOwn(configuration, 'timeoutMs')
    ? configuration.timeoutMs : BACKUP_TOOL_TIMEOUT_MS;
  return defineBackupProvider({
    contract: BACKUP_CONTRACT,
    name: 'postgresql-native',
    adapter: 'postgresql',
    async inspectAuthority({ connection }) {
      return inspectRestoredAuthority(connection, configuration.createPool);
    },
    async createArtifact({ artifactPath, connection }) {
      const tool = await toolIdentity(dumpCommand, 'pg_dump', timeoutMs);
      await useConnection(connection, (environment) => runTool(
        dumpCommand,
        ['--format=custom', '--no-password', '--schema=accordo', `--file=${artifactPath}`],
        environment,
        timeoutMs,
      ));
      return tool;
    },
    async prepareRestore() {
      await toolIdentity(restoreCommand, 'pg_restore', timeoutMs);
      await toolIdentity(psqlCommand, 'psql', timeoutMs);
    },
    async withTargetLock({ connection }, operation) {
      if (typeof operation !== 'function') refuse('BACKUP_TARGET_LOCK_INVALID', 'restore target lock operation is invalid');
      return useConnection(connection, async (environment) => {
        return withNativeClient(environment, async (client) => {
          const witness = Object.freeze({
            classId: 1094927188,
            objectId: randomBytes(4).readInt32BE(0) || 1,
          });
          const lockedTarget = Object.freeze({});
          const state = { witness, authority: null };
          nativeLockedTargets.set(lockedTarget, state);
          let admissionHeld = false;
          let witnessHeld = false;
          try {
            const lock = await client.query('SELECT pg_try_advisory_lock($1, $2) AS acquired', [
              DATA_ADVISORY_LOCK.classId, DATA_ADVISORY_LOCK.objectId,
            ]);
            if (lock.rows[0]?.acquired !== true) refuse('BACKUP_TARGET_BUSY', 'restore target authority lock is already held');
            admissionHeld = true;
            await client.query('SELECT pg_advisory_lock($1, $2)', [witness.classId, witness.objectId]);
            witnessHeld = true;
            const inspected = await inspectEmptyClient(client);
            return await operation(Object.freeze({
              empty: inspected.empty,
              lockedTarget,
              async inspectAuthority() {
                if (!state.authority) {
                  refuse('BACKUP_RESTORED_AUTHORITY_MISMATCH', 'restore child returned no committed authority');
                }
                const observed = await inspectRestoredAuthorityClient(client);
                compareLiveAuthority(
                  observed,
                  state.authority,
                  'BACKUP_RESTORED_AUTHORITY_MISMATCH',
                  'restore child and held-lock backend authority differ',
                );
                return state.authority;
              },
            }));
          } catch (error) {
            if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
            refuse('BACKUP_TARGET_LOCK_FAILED', 'restore target authority lock failed');
          } finally {
            nativeLockedTargets.delete(lockedTarget);
            if (witnessHeld) {
              await client.query('SELECT pg_advisory_unlock($1, $2)', [witness.classId, witness.objectId]).catch(() => {});
            }
            if (admissionHeld) {
              await client.query('SELECT pg_advisory_unlock($1, $2)', [DATA_ADVISORY_LOCK.classId, DATA_ADVISORY_LOCK.objectId]).catch(() => {});
            }
          }
        }, configuration.createPool);
      });
    },
    async restoreArtifact({ artifactPath, connection, lockedTarget, expectedAuthority }) {
      const locked = nativeLockedTargets.get(lockedTarget);
      if (!locked) refuse('BACKUP_TARGET_LOCK_INVALID', 'restore target fence is unavailable');
      const expected = acceptedObservedAuthority(expectedAuthority, 'BACKUP_RESTORED_AUTHORITY_MISMATCH');
      const sqlPath = `${artifactPath}.restore.sql`;
      const preludePath = `${artifactPath}.prelude.sql`;
      const postludePath = `${artifactPath}.postlude.sql`;
      const authorityPath = `${artifactPath}.authority`;
      try {
        await runTool(
          restoreCommand,
          ['--no-owner', '--no-privileges', '--schema=accordo', `--file=${sqlPath}`, artifactPath],
          {},
          timeoutMs,
        );
        // `pg_restore --schema` filters the objects inside the schema but never
        // emits the schema itself, so the child creates it — unqualified and
        // without IF NOT EXISTS, because a schema that already exists means the
        // target was not the empty one this restore was admitted for.
        await writeFile(preludePath, `\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO pg_catalog;
SELECT pg_advisory_xact_lock(${DATA_RESTORE_CHILD_LOCK.classId}, ${DATA_RESTORE_CHILD_LOCK.objectId});
CREATE SCHEMA accordo;
DO $accordo_restore_fence$
BEGIN
  IF pg_try_advisory_lock(${locked.witness.classId}, ${locked.witness.objectId}) THEN
    PERFORM pg_advisory_unlock(${locked.witness.classId}, ${locked.witness.objectId});
    RAISE EXCEPTION 'restore coordinator witness is absent' USING ERRCODE = '55000';
  END IF;
END
$accordo_restore_fence$;
`, { mode: 0o600, flag: 'wx' });
        // psql truncates this file through \o, so the coordinator owns its mode:
        // the child authority evidence must never be world- or group-readable.
        await writeFile(authorityPath, '', { mode: 0o600, flag: 'wx' });
        await writeFile(postludePath, `
DO $accordo_restore_authority$
BEGIN
  IF (SELECT count(*) FROM accordo.spine_data_plane_binding) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM accordo.spine_data_plane_binding
      WHERE data_plane_id::text = ${sqlLiteral(expected.bindingUuid)}
    )
    OR NOT EXISTS (
      SELECT 1 FROM accordo.startup_audit
      WHERE plane = 'data'
        AND tenant_fingerprint = ${sqlLiteral(expected.tenantFingerprint)}
        AND resource_fingerprint = ${sqlLiteral(expected.resourceFingerprint)}
        AND migration_set_fingerprint = ${sqlLiteral(expected.migrationSetFingerprint)}
      ORDER BY created_at DESC, id DESC LIMIT 1
    ) THEN
    RAISE EXCEPTION 'restored authority mismatch' USING ERRCODE = '55000';
  END IF;
END
$accordo_restore_authority$;
\\o ${psqlPath(authorityPath)}
SELECT concat_ws('|', 'accordo-restore-authority-v1', b.data_plane_id::text,
  a.tenant_fingerprint, a.resource_fingerprint, a.migration_set_fingerprint)
FROM accordo.spine_data_plane_binding b
CROSS JOIN LATERAL (
  SELECT tenant_fingerprint, resource_fingerprint, migration_set_fingerprint
  FROM accordo.startup_audit WHERE plane = 'data'
  ORDER BY created_at DESC, id DESC LIMIT 1
) a;
\\o
COMMIT;
`, { mode: 0o600, flag: 'wx' });
        await useConnection(connection, async (environment) => {
          const { PGDATABASE, ...toolEnvironment } = environment;
          await runTool(
            psqlCommand,
            ['-X', '--set=ON_ERROR_STOP=1', '--quiet', '--tuples-only', '--no-align', '--no-password', '--dbname=',
              `--file=${preludePath}`, `--file=${sqlPath}`, `--file=${postludePath}`],
            { ...toolEnvironment, PGDATABASE },
            timeoutMs,
          );
        });
        let evidence;
        try {
          evidence = readTrustedRegularFile(authorityPath, {
            maxBytes: 1024,
            untrusted: () => refuse('BACKUP_RESTORED_AUTHORITY_MISMATCH', 'restore child authority evidence is untrusted'),
          });
        } catch (error) {
          if (error && (typeof error === 'object' || typeof error === 'function') && frameworkErrors.has(error)) throw error;
          refuse('BACKUP_RESTORED_AUTHORITY_MISMATCH', 'restore child returned no readable authority');
        }
        const authority = evidence.trim().split('|');
        if (authority.length !== 5 || authority[0] !== 'accordo-restore-authority-v1') {
          refuse('BACKUP_RESTORED_AUTHORITY_MISMATCH', 'restore child returned invalid authority');
        }
        locked.authority = acceptedObservedAuthority({
          bindingUuid: authority[1],
          tenantFingerprint: authority[2],
          resourceFingerprint: authority[3],
          migrationSetFingerprint: authority[4],
        }, 'BACKUP_RESTORED_AUTHORITY_MISMATCH');
      } finally {
        await Promise.all([sqlPath, preludePath, postludePath, authorityPath].map(
          (path) => rm(path, { force: true }).catch(() => {}),
        ));
      }
    },
  });
}

export function backupVocabulary() {
  return Object.freeze({
    contract: BACKUP_CONTRACT,
    adapters: BACKUP_ADAPTERS,
    providerKeys: PROVIDER_KEYS,
    evidenceKeys: EVIDENCE_KEYS,
    expectedIntentKeys: EXPECTED_KEYS,
    restoreControlKeys: RESTORE_CONTROL_KEYS,
    restoreAttempts: RESTORE_ATTEMPTS,
    restoreOutcomes: RESTORE_OUTCOMES,
    bundleEntries: Object.freeze([BACKUP_ARTIFACT_NAME, BACKUP_MANIFEST_NAME]),
    nativeToolMajor: BACKUP_TOOL_MAJOR,
  });
}
