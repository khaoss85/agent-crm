// @ts-check

/**
 * Identity-verifier pre-connect resolver (Production Spine v2 M2-22).
 *
 * Resolves a repository-relative ESM provider before any database connection
 * or listener exists. Discover/attest names exist and refuse; live resource
 * attestation is M3.
 */

import fs from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from './errors.js';
import { loadDeploymentStorage } from './deployment-storage.js';
import { RUNTIME_MODES } from './runtime-mode.js';
import {
  assertTrustedFdUnchanged,
  closeTrustedFile,
  openTrustedRegularFile,
  sameTrustedIdentity,
} from './trusted-file.js';

export const IDENTITY_VERIFIER_CONTRACT = 2;
export const IDENTITY_VERIFIER_FACTORY = 'createIdentityVerifier';
export const IDENTITY_VERIFIER_INIT_TIMEOUT_MS = 2000;
export const IDENTITY_VERIFIER_MAX_BYTES = 64 * 1024;
export const IDENTITY_VERIFIER_OPERATIONS = Object.freeze([
  'verifyRequest',
  'discoverControlResource',
  'attestControlStartup',
  'discoverDataResource',
  'attestDataStartup',
]);

const MODULE_EXPORTS = Object.freeze([
  'identityVerifierContract',
  'identityVerifierTrust',
  IDENTITY_VERIFIER_FACTORY,
]);
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const ATTEST_OPERATIONS = Object.freeze([
  'discoverControlResource',
  'attestControlStartup',
  'discoverDataResource',
  'attestDataStartup',
]);

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function refuse(code, message, details = { contract: IDENTITY_VERIFIER_CONTRACT }) {
  throw new AppError(message, { code, status: 500, details });
}

function untrusted() {
  return refuse(
    'IDENTITY_VERIFIER_UNTRUSTED',
    'identity verifier is not a trusted repository-relative regular file owned by this process with owner-only permissions',
  );
}

function invalid() {
  return refuse(
    'IDENTITY_VERIFIER_INVALID',
    'identity verifier is not a closed pre-connect provider contract',
  );
}

function initFailed() {
  return refuse(
    'IDENTITY_VERIFIER_INIT_FAILED',
    'identity verifier failed to initialize',
  );
}

function timedOut(ms) {
  return refuse(
    'IDENTITY_VERIFIER_TIMEOUT',
    `identity verifier initialization timed out after ${ms}ms`,
    { contract: IDENTITY_VERIFIER_CONTRACT },
  );
}

/** @param {unknown} value */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {unknown} value */
function requiredString(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\0');
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 */
function closedPlainObject(value, allowed) {
  if (!isPlainObject(value)) invalid();
  const object = /** @type {Record<string, unknown>} */ (value);
  const names = Object.getOwnPropertyNames(object);
  if (Object.getOwnPropertySymbols(object).length) invalid();
  if (names.some((key) => HOSTILE_KEYS.includes(key))) invalid();
  if (names.length !== allowed.length || names.some((key) => !allowed.includes(key))) invalid();
  for (const key of allowed) {
    if (!Object.hasOwn(object, key)) invalid();
  }
  return object;
}

/**
 * @param {string} root
 * @param {string} candidate
 */
function containedInRoot(root, candidate) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

/**
 * @param {unknown} timeoutMs
 * @returns {number}
 */
function resolveTimeout(timeoutMs) {
  if (timeoutMs === undefined) return IDENTITY_VERIFIER_INIT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || /** @type {number} */ (timeoutMs) < 1
    || /** @type {number} */ (timeoutMs) > 60_000) {
    invalid();
  }
  return /** @type {number} */ (timeoutMs);
}

/**
 * @param {() => Promise<any>} work
 * @param {number} ms
 * @param {AbortController} controller
 */
async function withInitDeadline(work, ms, controller) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const timed = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      try { timedOut(ms); } catch (error) { reject(error); }
    }, ms);
  });
  const pending = Promise.resolve().then(work);
  pending.catch(() => {});
  try {
    return await Promise.race([pending, timed]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} relativePath
 * @param {string} projectRoot
 * @returns {string}
 */
function resolveContainedPath(relativePath, projectRoot) {
  if (!requiredString(projectRoot) || !isAbsolute(projectRoot)) untrusted();
  if (!requiredString(relativePath) || isAbsolute(relativePath)) untrusted();

  let rootReal;
  try {
    rootReal = fs.realpathSync(projectRoot);
  } catch {
    untrusted();
  }

  const candidate = resolve(rootReal, relativePath);
  const rel = relative(rootReal, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) untrusted();
  if (!containedInRoot(rootReal, candidate)) untrusted();
  return candidate;
}

/**
 * @param {string} candidate
 * @param {string} projectRoot
 */
function assertRealpathContained(candidate, projectRoot) {
  let fileReal;
  let rootReal;
  try {
    rootReal = fs.realpathSync(projectRoot);
    fileReal = fs.realpathSync(candidate);
  } catch {
    untrusted();
  }
  if (!containedInRoot(rootReal, fileReal)) untrusted();
}

/**
 * Module namespace objects are not plain objects and carry Symbol.toStringTag.
 * Only the string export names are closed.
 *
 * @param {object} namespace
 */
function closedModuleExports(namespace) {
  const names = Object.getOwnPropertyNames(namespace);
  if (names.some((key) => HOSTILE_KEYS.includes(key))) invalid();
  if (names.length !== MODULE_EXPORTS.length || names.some((key) => !MODULE_EXPORTS.includes(key))) {
    invalid();
  }
  for (const key of MODULE_EXPORTS) {
    if (!Object.hasOwn(namespace, key)) invalid();
  }
  return /** @type {Record<string, unknown>} */ (namespace);
}

/**
 * @param {object} namespace
 * @param {'local-development'|'production'} mode
 * @param {AbortSignal} signal
 */
async function instantiateVerifier(namespace, mode, signal) {
  const exports = closedModuleExports(namespace);

  if (exports.identityVerifierContract !== IDENTITY_VERIFIER_CONTRACT) {
    refuse(
      'IDENTITY_VERIFIER_CONTRACT_UNSUPPORTED',
      'identity verifier contract is not supported',
    );
  }
  if (typeof exports.identityVerifierTrust !== 'string'
    || !RUNTIME_MODES.includes(/** @type {'local-development'|'production'} */ (exports.identityVerifierTrust))) {
    invalid();
  }
  if (exports.identityVerifierTrust !== mode) invalid();
  if (typeof exports[IDENTITY_VERIFIER_FACTORY] !== 'function') invalid();

  const factory = /** @type {(config: { mode: string, signal: AbortSignal }) => unknown} */ (
    exports[IDENTITY_VERIFIER_FACTORY]
  );
  let produced;
  try {
    produced = await factory(Object.freeze({ mode, signal }));
  } catch (error) {
    if (error instanceof AppError && error.code === 'IDENTITY_VERIFIER_TIMEOUT') throw error;
    initFailed();
  }

  const operations = closedPlainObject(produced, IDENTITY_VERIFIER_OPERATIONS);
  for (const name of IDENTITY_VERIFIER_OPERATIONS) {
    if (typeof operations[name] !== 'function') invalid();
  }

  const verifyRequest = /** @type {(...args: unknown[]) => unknown} */ (operations.verifyRequest);
  /** @type {Record<string, (...args: unknown[]) => unknown>} */
  const wrapped = {
    verifyRequest: async function wrappedVerifyRequest(evidence) {
      if (!isPlainObject(evidence)) {
        refuse(
          'IDENTITY_VERIFIER_EVIDENCE_INVALID',
          'request evidence cannot satisfy startup attestation',
          { contract: IDENTITY_VERIFIER_CONTRACT, operation: 'verifyRequest' },
        );
      }
      try {
        return await verifyRequest.call(operations, evidence);
      } catch (error) {
        if (error instanceof AppError) throw error;
        refuse(
          'IDENTITY_VERIFIER_REQUEST_REFUSED',
          'identity verifier refused the request',
          { contract: IDENTITY_VERIFIER_CONTRACT, operation: 'verifyRequest' },
        );
      }
    },
  };
  for (const name of ATTEST_OPERATIONS) {
    const original = /** @type {(...args: unknown[]) => unknown} */ (operations[name]);
    wrapped[name] = async function wrappedAttest(input) {
      if (name.startsWith('discover')) {
        if (!isPlainObject(input) || typeof input.plane !== 'string' || input.resourceClass !== 'postgresql') {
          refuse(
            'IDENTITY_VERIFIER_CHALLENGE_INVALID',
            'startup discovery requires a closed opaque handle',
            { contract: IDENTITY_VERIFIER_CONTRACT, operation: name },
          );
        }
      } else if (!isPlainObject(input) || input.operation !== name) {
        refuse(
          'IDENTITY_VERIFIER_CHALLENGE_INVALID',
          'startup attestation requires a closed challenge bound to this operation',
          { contract: IDENTITY_VERIFIER_CONTRACT, operation: name },
        );
      }
      try {
        return await original.call(operations, input);
      } catch (error) {
        if (error instanceof AppError) throw error;
        refuse(
          'IDENTITY_VERIFIER_ATTESTATION_REFUSED',
          'identity verifier refused startup attestation',
          { contract: IDENTITY_VERIFIER_CONTRACT, operation: name },
        );
      }
    };
  }
  return Object.freeze({
    contract: IDENTITY_VERIFIER_CONTRACT,
    trust: exports.identityVerifierTrust,
    operations: Object.freeze(wrapped),
  });
}

/**
 * Resolve a repository-relative identity verifier before any database
 * connection or listener is created.
 *
 * @param {{
 *   relativePath?: unknown,
 *   projectRoot?: unknown,
 *   mode?: unknown,
 *   expectedUid?: unknown,
 *   timeoutMs?: unknown,
 * }} [options]
 */
export async function resolveIdentityVerifier(options = {}) {
  if (!isPlainObject(options)) invalid();
  const timeoutMs = resolveTimeout(options.timeoutMs);
  if (typeof options.mode !== 'string'
    || !RUNTIME_MODES.includes(/** @type {'local-development'|'production'} */ (options.mode))) {
    invalid();
  }
  const mode = /** @type {'local-development'|'production'} */ (options.mode);
  if (!requiredString(options.relativePath) || !requiredString(options.projectRoot)) untrusted();

  const candidate = resolveContainedPath(
    /** @type {string} */ (options.relativePath),
    /** @type {string} */ (options.projectRoot),
  );

  const controller = new AbortController();
  /** @type {{ expectedUid?: unknown, maxBytes: number, untrusted: () => never }} */
  const trustedOptions = { maxBytes: IDENTITY_VERIFIER_MAX_BYTES, untrusted };
  if (Object.hasOwn(options, 'expectedUid')) trustedOptions.expectedUid = options.expectedUid;

  return withInitDeadline(async () => {
    /** @type {{ fd: number, stat: import('node:fs').Stats } | undefined} */
    let opened;
    try {
      assertRealpathContained(candidate, /** @type {string} */ (options.projectRoot));
      opened = openTrustedRegularFile(candidate, trustedOptions);
      const href = pathToFileURL(candidate).href;
      let namespace;
      try {
        namespace = await import(href);
      } catch (error) {
        if (error instanceof AppError && error.code === 'IDENTITY_VERIFIER_TIMEOUT') throw error;
        initFailed();
      }
      assertTrustedFdUnchanged(opened.fd, opened.stat, untrusted);
      const again = openTrustedRegularFile(candidate, trustedOptions);
      try {
        if (!sameTrustedIdentity(opened.stat, again.stat)) untrusted();
      } finally {
        closeTrustedFile(again.fd);
      }
      return await instantiateVerifier(namespace, mode, controller.signal);
    } finally {
      if (opened) closeTrustedFile(opened.fd);
    }
  }, timeoutMs, controller);
}

/**
 * Load the closed deployment-storage document and resolve its verifier
 * without opening a database or a listener.
 *
 * @param {{
 *   configPath?: unknown,
 *   dbPath?: unknown,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   expectedUid?: unknown,
 *   projectRoot?: unknown,
 *   timeoutMs?: unknown,
 * }} [options]
 */
export async function prepareDeploymentPreconnect(options = {}) {
  const selection = loadDeploymentStorage(options);
  if (!requiredString(selection.identityVerifier)) {
    return Object.freeze({ selection, identityVerifier: null });
  }
  if (!requiredString(options.projectRoot)) untrusted();
  const identityVerifier = await resolveIdentityVerifier({
    relativePath: selection.identityVerifier,
    projectRoot: options.projectRoot,
    mode: selection.spine?.mode,
    timeoutMs: options.timeoutMs,
    ...(isPlainObject(options) && Object.hasOwn(options, 'expectedUid')
      ? { expectedUid: options.expectedUid }
      : {}),
  });
  return Object.freeze({ selection, identityVerifier });
}
