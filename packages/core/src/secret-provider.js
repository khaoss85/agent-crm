// @ts-check

import fs from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { AppError } from './errors.js';
import { RUNTIME_MODES } from './runtime-mode.js';
import {
  assertTrustedFdUnchanged,
  closeTrustedFile,
  openTrustedRegularFile,
  sameTrustedIdentity,
} from './trusted-file.js';

export const SECRET_PROVIDER_CONTRACT = 1;
export const SECRET_PROVIDER_INIT_TIMEOUT_MS = 2000;
export const SECRET_RESOLUTION_TIMEOUT_MS = 2000;
export const SECRET_PROVIDER_MAX_BYTES = 64 * 1024;
export const SECRET_REFERENCE_MAX_LENGTH = 256;
export const SECRET_PURPOSES = Object.freeze([
  'identity-verifier',
  'postgresql-control-password',
  'postgresql-data-password',
]);

const PROVIDER_KEYS = Object.freeze(['contract', 'name', 'trust', 'resolveSecret']);
const RESOLUTION_CONTEXT_KEYS = Object.freeze(['contract', 'mode', 'purpose', 'tenantId', 'signal']);
const PUBLIC_CONTEXT_KEYS = Object.freeze(['purpose', 'tenantId']);
const MODULE_EXPORTS = Object.freeze([
  'secretProviderContract',
  'secretProviderTrust',
  'createSecretProvider',
]);
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const PROVIDER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SECRET_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const materialBytes = new WeakMap();
const leaseBytes = new WeakMap();
const leaseTimers = new WeakMap();

function error(code, message, details = { contract: SECRET_PROVIDER_CONTRACT }) {
  return new AppError(message, { code, status: 500, details });
}

function invalid() {
  throw error('SECRET_PROVIDER_INVALID', 'secret provider is not a closed runtime contract');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function closedObject(value, keys) {
  if (!isPlainObject(value)) invalid();
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length || names.some((key) => HOSTILE_KEYS.includes(key))) invalid();
  if (names.length !== keys.length || names.some((key) => !keys.includes(key))) invalid();
  for (const key of keys) if (!Object.hasOwn(value, key)) invalid();
  return /** @type {Record<string, any>} */ (value);
}

function positiveTimeout(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 60_000) invalid();
  return value;
}

function disposeBytes(bytes) {
  if (bytes) bytes.fill(0);
}

function coercionRefused() {
  throw error('SECRET_VALUE_COERCION_REFUSED', 'secret values cannot be coerced or serialized');
}

/** Opaque mutable material that a provider returns to the framework. */
export class SecretMaterial {
  constructor(value) {
    let bytes;
    if (typeof value === 'string') bytes = Buffer.from(value, 'utf8');
    else if (value instanceof Uint8Array) bytes = Buffer.from(value);
    else invalid();
    if (bytes.length < 1 || bytes.length > SECRET_PROVIDER_MAX_BYTES) {
      disposeBytes(bytes);
      invalid();
    }
    materialBytes.set(this, bytes);
    Object.freeze(this);
  }

  dispose() {
    const bytes = materialBytes.get(this);
    disposeBytes(bytes);
    materialBytes.delete(this);
  }

  toString() { return coercionRefused(); }
  valueOf() { return coercionRefused(); }
  toJSON() { return coercionRefused(); }
  [Symbol.toPrimitive]() { return coercionRefused(); }
  [inspect.custom]() { return 'SecretMaterial { redacted }'; }
}

/** Opaque single-use lease returned to an actual runtime consumer. */
export class SecretLease {
  constructor(bytes, lifetimeMs = SECRET_RESOLUTION_TIMEOUT_MS) {
    leaseBytes.set(this, bytes);
    const timer = setTimeout(() => this.dispose(), lifetimeMs);
    timer.unref?.();
    leaseTimers.set(this, timer);
    Object.freeze(this);
  }

  get disposed() { return !leaseBytes.has(this); }

  async use(consumer) {
    if (typeof consumer !== 'function') invalid();
    const bytes = leaseBytes.get(this);
    if (!bytes) throw error('SECRET_VALUE_DISPOSED', 'secret value is no longer available');
    leaseBytes.delete(this);
    clearTimeout(leaseTimers.get(this));
    leaseTimers.delete(this);
    const value = bytes.toString('utf8');
    disposeBytes(bytes);
    return await consumer(value);
  }

  dispose() {
    const bytes = leaseBytes.get(this);
    disposeBytes(bytes);
    leaseBytes.delete(this);
    clearTimeout(leaseTimers.get(this));
    leaseTimers.delete(this);
  }

  toString() { return coercionRefused(); }
  valueOf() { return coercionRefused(); }
  toJSON() { return coercionRefused(); }
  [Symbol.toPrimitive]() { return coercionRefused(); }
  [inspect.custom]() { return 'SecretLease { redacted }'; }
}

export function createSecretMaterial(value) {
  return new SecretMaterial(value);
}

function takeMaterial(material) {
  if (material instanceof SecretMaterial) {
    const bytes = materialBytes.get(material);
    if (!bytes) invalid();
    materialBytes.delete(material);
    return bytes;
  }
  if (material instanceof Uint8Array) {
    if (material.byteLength < 1 || material.byteLength > SECRET_PROVIDER_MAX_BYTES) {
      material.fill(0);
      invalid();
    }
    const bytes = Buffer.from(material);
    material.fill(0);
    return bytes;
  }
  invalid();
}

function disposeProviderResult(value) {
  if (value instanceof SecretMaterial) value.dispose();
  else if (value instanceof Uint8Array) value.fill(0);
}

export function defineSecretProvider(definition) {
  const provider = closedObject(definition, PROVIDER_KEYS);
  if (provider.contract !== SECRET_PROVIDER_CONTRACT) {
    throw error('SECRET_PROVIDER_CONTRACT_UNSUPPORTED', 'secret provider contract is not supported');
  }
  if (typeof provider.name !== 'string' || !PROVIDER_NAME.test(provider.name)) invalid();
  if (typeof provider.trust !== 'string' || !RUNTIME_MODES.includes(provider.trust)) invalid();
  if (typeof provider.resolveSecret !== 'function') invalid();
  return Object.freeze({
    contract: SECRET_PROVIDER_CONTRACT,
    name: provider.name,
    trust: provider.trust,
    resolveSecret: provider.resolveSecret,
  });
}

export function createEnvironmentSecretProvider(options = {}) {
  if (!isPlainObject(options)) invalid();
  const names = Object.getOwnPropertyNames(options);
  if (Object.getOwnPropertySymbols(options).length || names.some((key) => !['env'].includes(key))) invalid();
  const env = options.env ?? process.env;
  return defineSecretProvider({
    contract: SECRET_PROVIDER_CONTRACT,
    name: 'local-environment',
    trust: 'local-development',
    resolveSecret(reference) {
      const value = env[reference];
      if (typeof value !== 'string' || value === '') {
        throw error('SECRET_NOT_FOUND', 'secret reference could not be resolved');
      }
      return createSecretMaterial(value);
    },
  });
}

export function createFixtureSecretProvider(entries) {
  if (!isPlainObject(entries)) invalid();
  const secrets = new Map();
  for (const key of Object.getOwnPropertyNames(entries)) {
    if (!validReference(key) || typeof entries[key] !== 'string' || entries[key] === '') invalid();
    secrets.set(key, entries[key]);
  }
  return defineSecretProvider({
    contract: SECRET_PROVIDER_CONTRACT,
    name: 'test-fixture',
    trust: 'local-development',
    resolveSecret(reference) {
      if (!secrets.has(reference)) throw error('SECRET_NOT_FOUND', 'secret reference could not be resolved');
      return createSecretMaterial(secrets.get(reference));
    },
  });
}

function validReference(reference) {
  return typeof reference === 'string' && reference.length <= SECRET_REFERENCE_MAX_LENGTH
    && SECRET_REFERENCE.test(reference) && !HOSTILE_KEYS.includes(reference);
}

function normalizeContext(context, mode, signal) {
  const value = closedObject(context, PUBLIC_CONTEXT_KEYS);
  if (!SECRET_PURPOSES.includes(value.purpose)) invalid();
  if (typeof value.tenantId !== 'string' || value.tenantId === '' || value.tenantId.length > 256) invalid();
  return Object.freeze({
    contract: SECRET_PROVIDER_CONTRACT,
    mode,
    purpose: value.purpose,
    tenantId: value.tenantId,
    signal,
  });
}

export function createSecretResolver(options) {
  if (!isPlainObject(options)) invalid();
  const names = Object.getOwnPropertyNames(options);
  if (Object.getOwnPropertySymbols(options).length || names.some((key) => !['provider', 'mode', 'timeoutMs'].includes(key))) invalid();
  const provider = defineSecretProvider(options.provider);
  if (!RUNTIME_MODES.includes(options.mode) || provider.trust !== options.mode) {
    throw error('SECRET_PROVIDER_TRUST_REFUSED', 'secret provider trust does not match the runtime mode');
  }
  const timeoutMs = positiveTimeout(options.timeoutMs, SECRET_RESOLUTION_TIMEOUT_MS);

  return Object.freeze({
    contract: SECRET_PROVIDER_CONTRACT,
    async resolveSecret(reference, context) {
      if (!validReference(reference)) invalid();
      const controller = new AbortController();
      const providerContext = normalizeContext(context, options.mode, controller.signal);
      let timer;
      let settled = false;
      let deadlineExpired = false;
      const pending = Promise.resolve().then(() => provider.resolveSecret(reference, providerContext));
      pending.then((late) => {
        if (settled) disposeProviderResult(late);
      }, () => {});
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          settled = true;
          deadlineExpired = true;
          controller.abort();
          reject(error('SECRET_PROVIDER_TIMEOUT', `secret resolution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      let material;
      try {
        material = await Promise.race([pending, deadline]);
      } catch (cause) {
        if (deadlineExpired && cause instanceof AppError && cause.code === 'SECRET_PROVIDER_TIMEOUT') throw cause;
        throw error('SECRET_PROVIDER_FAILED', 'secret provider failed to resolve the reference');
      } finally {
        clearTimeout(timer);
      }
      settled = true;
      try {
        return new SecretLease(takeMaterial(material), timeoutMs);
      } catch {
        disposeProviderResult(material);
        invalid();
      }
    },
  });
}

function containedInRoot(root, candidate) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate.startsWith(prefix);
}

function untrusted() {
  throw error(
    'SECRET_PROVIDER_UNTRUSTED',
    'secret provider is not a trusted repository-relative regular file owned by this process with owner-only permissions',
  );
}

function resolveContainedPath(relativePath, projectRoot) {
  if (typeof projectRoot !== 'string' || !isAbsolute(projectRoot)
    || typeof relativePath !== 'string' || relativePath === '' || isAbsolute(relativePath)) untrusted();
  let rootReal;
  try { rootReal = fs.realpathSync(projectRoot); } catch { untrusted(); }
  const candidate = resolve(rootReal, relativePath);
  const rel = relative(rootReal, candidate);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || !containedInRoot(rootReal, candidate)) untrusted();
  return { candidate, rootReal };
}

function closedModule(namespace) {
  const names = Object.getOwnPropertyNames(namespace);
  if (names.some((key) => HOSTILE_KEYS.includes(key))
    || names.length !== MODULE_EXPORTS.length || names.some((key) => !MODULE_EXPORTS.includes(key))) invalid();
  return /** @type {Record<string, any>} */ (namespace);
}

export async function resolveProductionSecretProvider(options) {
  if (!isPlainObject(options)) invalid();
  const timeoutMs = positiveTimeout(options.timeoutMs, SECRET_PROVIDER_INIT_TIMEOUT_MS);
  if (options.mode !== 'production') {
    throw error('SECRET_PROVIDER_TRUST_REFUSED', 'production secret providers require production runtime mode');
  }
  const { candidate, rootReal } = resolveContainedPath(options.relativePath, options.projectRoot);
  const controller = new AbortController();
  let opened;
  let timer;
  const pending = (async () => {
    try {
      const real = fs.realpathSync(candidate);
      if (!containedInRoot(rootReal, real)) untrusted();
      const trustedOptions = {
        maxBytes: SECRET_PROVIDER_MAX_BYTES,
        untrusted,
        ...(Object.hasOwn(options, 'expectedUid') ? { expectedUid: options.expectedUid } : {}),
      };
      opened = openTrustedRegularFile(candidate, trustedOptions);
      let namespace;
      try { namespace = await import(pathToFileURL(candidate).href); } catch { throw error('SECRET_PROVIDER_INIT_FAILED', 'secret provider failed to initialize'); }
      assertTrustedFdUnchanged(opened.fd, opened.stat, untrusted);
      const again = openTrustedRegularFile(candidate, trustedOptions);
      try { if (!sameTrustedIdentity(opened.stat, again.stat)) untrusted(); } finally { closeTrustedFile(again.fd); }
      const exports = closedModule(namespace);
      if (exports.secretProviderContract !== SECRET_PROVIDER_CONTRACT) {
        throw error('SECRET_PROVIDER_CONTRACT_UNSUPPORTED', 'secret provider contract is not supported');
      }
      if (exports.secretProviderTrust !== 'production' || typeof exports.createSecretProvider !== 'function') invalid();
      let produced;
      try {
        produced = await exports.createSecretProvider(Object.freeze({ mode: 'production', signal: controller.signal }));
      } catch {
        throw error('SECRET_PROVIDER_INIT_FAILED', 'secret provider failed to initialize');
      }
      return defineSecretProvider(produced);
    } finally {
      if (opened) closeTrustedFile(opened.fd);
    }
  })();
  pending.catch(() => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(error('SECRET_PROVIDER_TIMEOUT', `secret provider initialization timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (cause) {
    if (cause instanceof AppError) throw cause;
    throw error('SECRET_PROVIDER_INIT_FAILED', 'secret provider failed to initialize');
  } finally {
    clearTimeout(timer);
  }
}

export function secretProviderVocabulary() {
  return Object.freeze({
    contract: SECRET_PROVIDER_CONTRACT,
    purposes: SECRET_PURPOSES,
    providerKeys: PROVIDER_KEYS,
    resolutionContextKeys: RESOLUTION_CONTEXT_KEYS,
  });
}
