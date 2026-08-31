// @ts-check

import { isAbsolute } from 'node:path';
import { AppError } from './errors.js';
import { RUNTIME_MODES } from './runtime-mode.js';
import { readTrustedRegularFile } from './trusted-file.js';

/**
 * Shared deployment-storage configuration loader (Production Spine v2 M2F).
 *
 * One closed document selects adapter and spine binding for every future
 * executable. This module parses and refuses; it does not open a database,
 * import an identity verifier, or talk to a TLS endpoint. File bytes come
 * from a same-fd no-follow nonblock open (see trusted-file.js).
 */

export const DEPLOYMENT_STORAGE_CONTRACT = 2;
export const LEGACY_DEPLOYMENT_STORAGE_CONTRACT = 1;
export const DEPLOYMENT_STORAGE_ENV = 'ACCORDO_DEPLOYMENT_STORAGE';
export const DEPLOYMENT_STORAGE_MAX_BYTES = 16 * 1024;

const LEGACY_ENVELOPE_KEYS = Object.freeze([
  'contract', 'adapter', 'connection', 'controlPlane', 'spine', 'identityVerifier',
]);
const ENVELOPE_KEYS = Object.freeze([
  ...LEGACY_ENVELOPE_KEYS, 'secretProvider',
]);
const ENVELOPE_REQUIRED_KEYS = Object.freeze([
  'contract', 'adapter', 'connection', 'controlPlane', 'spine',
]);
const SQLITE_ENDPOINT_KEYS = Object.freeze(['path']);
const POSTGRES_SECRET_ENDPOINT_KEYS = Object.freeze([
  'host', 'port', 'database', 'user', 'passwordSecret', 'sslmode', 'tls',
]);
const POSTGRES_SECRET_REQUIRED_ENDPOINT_KEYS = Object.freeze(['host', 'database', 'user', 'passwordSecret']);
const SECRET_PROVIDER_KEYS = Object.freeze(['kind', 'path']);
const TLS_KEYS = Object.freeze(['enabled', 'verify', 'caFile', 'servername', 'rejectUnauthorized']);
const SPINE_KEYS = Object.freeze(['mode', 'tenant']);
const TENANT_KEYS = Object.freeze(['id']);
const HOSTILE_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const WEAK_SSLMODES = Object.freeze(['disable', 'allow', 'prefer', 'require', 'verify-ca']);

/**
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @returns {never}
 */
function refuse(code, message, details = { contract: DEPLOYMENT_STORAGE_CONTRACT }) {
  throw new AppError(message, { code, status: 500, details });
}

function untrusted() {
  return refuse(
    'DEPLOYMENT_STORAGE_CONFIG_UNTRUSTED',
    'deployment-storage configuration is not a trusted regular file owned by this process with owner-only permissions',
  );
}

function invalidEnvelope() {
  return refuse(
    'DEPLOYMENT_STORAGE_ENVELOPE_INVALID',
    'deployment-storage configuration is not a closed contract document',
  );
}

function tlsRefused() {
  return refuse(
    'DEPLOYMENT_STORAGE_TLS_REFUSED',
    'deployment-storage PostgreSQL connections require authenticated TLS with certificate and hostname verification',
  );
}

/** @param {unknown} value */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** @param {object} value */
function ownNames(value) {
  return Object.getOwnPropertyNames(value);
}

/**
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {readonly string[]} [required]
 */
function closedObject(value, allowed, required = allowed) {
  if (!isPlainObject(value)) invalidEnvelope();
  const object = /** @type {Record<string, unknown>} */ (value);
  const names = ownNames(object);
  if (Object.getOwnPropertySymbols(object).length) invalidEnvelope();
  if (names.some((key) => HOSTILE_KEYS.includes(key))) invalidEnvelope();
  if (names.some((key) => !allowed.includes(key))) invalidEnvelope();
  for (const key of required) {
    if (!Object.hasOwn(object, key)) invalidEnvelope();
  }
  return object;
}

/** @param {unknown} value */
function requiredString(value) {
  return typeof value === 'string' && value !== '' && !value.includes('\0');
}

/**
 * Open a config file with no-follow / nonblock discipline and read its bytes.
 *
 * @param {string} configPath
 * @param {unknown} options
 * @returns {string}
 */
function readTrustedConfig(configPath, options) {
  /** @type {{ expectedUid?: unknown, maxBytes: number, untrusted: () => never }} */
  const trustedOptions = { maxBytes: DEPLOYMENT_STORAGE_MAX_BYTES, untrusted };
  if (isPlainObject(options) && Object.hasOwn(options, 'expectedUid')) {
    trustedOptions.expectedUid = options.expectedUid;
  }
  return readTrustedRegularFile(configPath, trustedOptions);
}

/** @param {string} source */
function parseJsonDocument(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    invalidEnvelope();
  }
  return parsed;
}

/** @param {unknown} value */
function parseIdentityVerifier(value) {
  if (!requiredString(value) || isAbsolute(/** @type {string} */ (value))) invalidEnvelope();
  return /** @type {string} */ (value);
}

/** @param {unknown} value */
function parseOptionalIdentityVerifier(value) {
  if (value === undefined || value === null) return null;
  return parseIdentityVerifier(value);
}

/** @param {unknown} value */
function parseSpine(value) {
  const spine = closedObject(value, SPINE_KEYS);
  if (typeof spine.mode !== 'string' || !RUNTIME_MODES.includes(spine.mode)) invalidEnvelope();
  const tenant = closedObject(spine.tenant, TENANT_KEYS);
  if (!requiredString(tenant.id)) invalidEnvelope();
  return Object.freeze({
    mode: /** @type {'local-development'|'production'} */ (spine.mode),
    tenant: Object.freeze({ id: tenant.id }),
  });
}

/** @param {unknown} value */
function parseSqliteEndpoint(value) {
  const endpoint = closedObject(value, SQLITE_ENDPOINT_KEYS);
  if (!requiredString(endpoint.path)) invalidEnvelope();
  return Object.freeze({ path: /** @type {string} */ (endpoint.path) });
}

/** @param {unknown} value */
function parsePostgresTls(value) {
  if (value === undefined) tlsRefused();
  const tls = closedObject(value, TLS_KEYS, []);
  if (tls.enabled !== true) tlsRefused();
  if (tls.verify !== 'full') tlsRefused();
  if (!requiredString(tls.caFile)) tlsRefused();
  if (Object.hasOwn(tls, 'rejectUnauthorized') && tls.rejectUnauthorized !== true) tlsRefused();
  if (Object.hasOwn(tls, 'servername') && !requiredString(tls.servername)) invalidEnvelope();
  return Object.freeze({
    enabled: true,
    verify: 'full',
    caFile: /** @type {string} */ (tls.caFile),
    ...(Object.hasOwn(tls, 'servername') ? { servername: /** @type {string} */ (tls.servername) } : {}),
    ...(Object.hasOwn(tls, 'rejectUnauthorized') ? { rejectUnauthorized: true } : {}),
  });
}

/** @param {unknown} value */
function parsePostgresSecretEndpoint(value) {
  const endpoint = closedObject(value, POSTGRES_SECRET_ENDPOINT_KEYS, POSTGRES_SECRET_REQUIRED_ENDPOINT_KEYS);
  if (!requiredString(endpoint.host) || !requiredString(endpoint.database)
    || !requiredString(endpoint.user) || !requiredString(endpoint.passwordSecret)) {
    invalidEnvelope();
  }
  if (Object.hasOwn(endpoint, 'port')) {
    if (!Number.isInteger(endpoint.port) || /** @type {number} */ (endpoint.port) < 1
      || /** @type {number} */ (endpoint.port) > 65535) invalidEnvelope();
  }
  if (Object.hasOwn(endpoint, 'sslmode')) {
    if (typeof endpoint.sslmode !== 'string') invalidEnvelope();
    if (WEAK_SSLMODES.includes(/** @type {string} */ (endpoint.sslmode))
      || endpoint.sslmode !== 'verify-full') tlsRefused();
  }
  const tls = parsePostgresTls(endpoint.tls);
  return Object.freeze({
    host: /** @type {string} */ (endpoint.host),
    ...(Object.hasOwn(endpoint, 'port') ? { port: /** @type {number} */ (endpoint.port) } : {}),
    database: /** @type {string} */ (endpoint.database),
    user: /** @type {string} */ (endpoint.user),
    passwordSecret: /** @type {string} */ (endpoint.passwordSecret),
    ...(Object.hasOwn(endpoint, 'sslmode') ? { sslmode: /** @type {string} */ (endpoint.sslmode) } : {}),
    tls,
  });
}

/** @param {unknown} value @param {'local-development'|'production'} mode */
function parseSecretProvider(value, mode) {
  const provider = closedObject(value, SECRET_PROVIDER_KEYS, ['kind']);
  if (provider.kind === 'environment') {
    if (mode !== 'local-development' || Object.hasOwn(provider, 'path')) {
      refuse('SECRET_PROVIDER_TRUST_REFUSED', 'production deployments cannot use the local environment secret provider');
    }
    return Object.freeze({ kind: /** @type {'environment'} */ ('environment') });
  }
  if (provider.kind !== 'module' || !requiredString(provider.path)
    || isAbsolute(/** @type {string} */ (provider.path))) invalidEnvelope();
  return Object.freeze({ kind: /** @type {'module'} */ ('module'), path: /** @type {string} */ (provider.path) });
}

/**
 * Endpoint identity is host+port+database. Schema names, URLs and credentials
 * are not identities.
 *
 * @param {{host: string, port?: number, database: string}} endpoint
 */
function endpointIdentity(endpoint) {
  const port = endpoint.port ?? 5432;
  return `${endpoint.host.toLowerCase()}|${port}|${endpoint.database}`;
}

/** @param {Record<string, unknown>} envelope */
function parseEnvelope(envelope) {
  if (envelope.contract === LEGACY_DEPLOYMENT_STORAGE_CONTRACT) {
    closedObject(envelope, LEGACY_ENVELOPE_KEYS);
    const legacySpine = parseSpine(envelope.spine);
    if (envelope.adapter === 'postgresql') {
      refuse(
        'DEPLOYMENT_STORAGE_SECRET_REFERENCE_REQUIRED',
        'PostgreSQL deployment storage requires secret references',
        { contract: DEPLOYMENT_STORAGE_CONTRACT },
      );
    }
    if (envelope.adapter !== 'sqlite' && envelope.adapter !== 'postgresql') invalidEnvelope();
    const identityVerifier = parseIdentityVerifier(envelope.identityVerifier);
    if (envelope.adapter === 'sqlite') {
      return Object.freeze({
        contract: LEGACY_DEPLOYMENT_STORAGE_CONTRACT,
        adapter: /** @type {'sqlite'} */ ('sqlite'),
        identityVerifier,
        spine: legacySpine,
        connection: parseSqliteEndpoint(envelope.connection),
        controlPlane: parseSqliteEndpoint(envelope.controlPlane),
      });
    }
    invalidEnvelope();
  }

  if (envelope.contract !== DEPLOYMENT_STORAGE_CONTRACT) {
    refuse(
      'DEPLOYMENT_STORAGE_CONTRACT_UNSUPPORTED',
      'deployment-storage contract is not supported',
    );
  }
  closedObject(envelope, ENVELOPE_KEYS, ENVELOPE_REQUIRED_KEYS);
  if (envelope.adapter !== 'sqlite' && envelope.adapter !== 'postgresql') invalidEnvelope();
  const identityVerifier = parseOptionalIdentityVerifier(envelope.identityVerifier);
  const spine = parseSpine(envelope.spine);
  const secretProvider = Object.hasOwn(envelope, 'secretProvider')
    ? parseSecretProvider(envelope.secretProvider, spine.mode)
    : null;

  if (envelope.adapter === 'sqlite') {
    return Object.freeze({
      contract: DEPLOYMENT_STORAGE_CONTRACT,
      adapter: /** @type {'sqlite'} */ ('sqlite'),
      identityVerifier,
      secretProvider,
      spine,
      connection: parseSqliteEndpoint(envelope.connection),
      controlPlane: parseSqliteEndpoint(envelope.controlPlane),
    });
  }

  if (!secretProvider) {
    refuse('SECRET_PROVIDER_REQUIRED', 'PostgreSQL deployment storage requires an explicit secret provider');
  }

  const connection = parsePostgresSecretEndpoint(envelope.connection);
  const controlPlane = parsePostgresSecretEndpoint(envelope.controlPlane);
  if (endpointIdentity(connection) === endpointIdentity(controlPlane)) {
    refuse(
      'DEPLOYMENT_STORAGE_PLANES_ALIAS',
      'PostgreSQL control and data planes must not share an endpoint identity',
    );
  }
  return Object.freeze({
    contract: DEPLOYMENT_STORAGE_CONTRACT,
    adapter: /** @type {'postgresql'} */ ('postgresql'),
    identityVerifier,
    secretProvider,
    spine,
    connection,
    controlPlane,
  });
}

/** @param {string} dbPath */
function sqliteFromDbFlag(dbPath) {
  return Object.freeze({
    contract: LEGACY_DEPLOYMENT_STORAGE_CONTRACT,
    adapter: /** @type {'sqlite'} */ ('sqlite'),
    source: /** @type {'db-flag'} */ ('db-flag'),
    identityVerifier: null,
    spine: null,
    connection: Object.freeze({ path: dbPath }),
    controlPlane: null,
  });
}

/**
 * Select deployment storage from a closed document, a documented env path, or
 * a SQLite `--db` compatibility path. Never opens a database connection.
 *
 * @param {{
 *   configPath?: unknown,
 *   dbPath?: unknown,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   expectedUid?: unknown,
 * }} [options]
 */
export function loadDeploymentStorage(options = {}) {
  if (options === undefined || options === null) options = {};
  if (!isPlainObject(options)) invalidEnvelope();

  const dbPath = requiredString(options.dbPath) ? /** @type {string} */ (options.dbPath) : null;
  const env = options.env ?? process.env;
  const envPath = env && requiredString(env[DEPLOYMENT_STORAGE_ENV])
    ? /** @type {string} */ (env[DEPLOYMENT_STORAGE_ENV])
    : null;
  const configPath = requiredString(options.configPath) ? /** @type {string} */ (options.configPath) : null;

  if (dbPath && (configPath || envPath)) {
    refuse(
      'DEPLOYMENT_STORAGE_DB_CONFLICT',
      'deployment-storage configuration and a SQLite database path cannot both be supplied',
    );
  }

  const documentPath = configPath ?? envPath;
  if (documentPath) {
    const source = configPath ? 'config' : 'env';
    const bytes = readTrustedConfig(documentPath, options);
    const parsed = parseJsonDocument(bytes);
    const selected = parseEnvelope(/** @type {Record<string, unknown>} */ (parsed));
    return Object.freeze({ ...selected, source });
  }

  if (dbPath) return sqliteFromDbFlag(dbPath);

  refuse(
    'DEPLOYMENT_STORAGE_SOURCE_REQUIRED',
    'deployment storage requires a configuration document or a SQLite database path',
  );
}

/**
 * Bounded public storage descriptor. Locators and credentials never belong here.
 *
 * @param {unknown} selection
 * @returns {{ adapter: 'sqlite' | 'postgresql', available: boolean }}
 */
export function describeDeploymentStorage(selection) {
  const adapter = isPlainObject(selection) ? selection.adapter : undefined;
  if (adapter === 'sqlite') return Object.freeze({ adapter: 'sqlite', available: true });
  if (adapter === 'postgresql') return Object.freeze({ adapter: 'postgresql', available: true });
  invalidEnvelope();
}
