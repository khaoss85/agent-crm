// @ts-check

import { isAbsolute, resolve } from 'node:path';
import { AppError } from '../../core/src/errors.js';
import { readTrustedRegularFile } from '../../core/src/trusted-file.js';
import {
  startPortablePostgresqlApp,
  startPortablePostgresqlReaderApp,
  startPortableSqliteApp,
} from './portable-app.js';

/**
 * Public portable async factory. It composes kernel Company, Contact,
 * Opportunity and Approval over the source-private SQLite lifecycle, or a
 * complete PostgreSQL application when deployment storage / test harness
 * selects that adapter. The default selected graph is an explicit
 * packageContract 2 with empty package, action and module lists. Bundled and
 * generated v1 registries are never the default. This module does not import
 * or wrap the synchronous v1 factory.
 */

const DEFAULT_SELECTED_GRAPH = Object.freeze({
  packageContract: 2,
  packages: Object.freeze([]),
  actions: Object.freeze([]),
  modules: Object.freeze([]),
});

const POSTGRES_KEYS = Object.freeze([
  'connection',
  'connectionString',
  'url',
  'databaseUrl',
  'postgres',
  'postgresql',
  'controlPlane',
]);

const UNSUPPORTED_KEYS = Object.freeze([
  'authorize',
  'security',
  'openDatabase',
  'listen',
  'providers',
]);

const LOOPBACK = Object.freeze(new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']));

function optionUnsupported(option) {
  return new AppError(
    `createAccordoAppAsync does not support "${option}"`,
    {
      code: 'PORTABLE_OPTION_UNSUPPORTED',
      status: 400,
      details: { option },
    },
  );
}

function bindingRequired() {
  return new AppError(
    'PostgreSQL composition requires a canonical tenant, spine binding and trusted identity verifier',
    {
      code: 'PORTABLE_POSTGRESQL_BINDING_REQUIRED',
      status: 400,
      details: { adapter: 'postgresql' },
    },
  );
}

function looksLikePostgres(options) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) return false;
  try {
    if (options.adapter != null && options.adapter !== 'sqlite') return true;
  } catch {
    return true;
  }
  for (const key of POSTGRES_KEYS) {
    try {
      if (options[key] != null) return true;
    } catch {
      return true;
    }
  }
  try {
    if (typeof options.dbPath === 'string' && /^postgres(ql)?:\/\//i.test(options.dbPath)) return true;
  } catch {
    return true;
  }
  try {
    if (options.deployment?.selection?.adapter === 'postgresql') return true;
  } catch {
    return true;
  }
  try {
    if (options.testHarness != null) return true;
  } catch {
    return true;
  }
  return false;
}

function isCompletePostgres(options) {
  if (options?.deployment?.selection?.adapter === 'postgresql' && options.deployment.identityVerifier) {
    return Boolean(options.deployment.selection.spine?.tenant?.id && options.deployment.selection.identityVerifier);
  }
  if (options?.adapter === 'postgresql' && options.testHarness?.loopback === true
    && options.testHarness.control && options.testHarness.data
    && options.spine?.tenant?.id && options.identityVerifier) {
    return true;
  }
  return false;
}

/**
 * A read-only composition is a *complete* PostgreSQL shape, not an incomplete
 * one. It is deliberately not routed through `isCompletePostgres`, because the
 * two things that function requires are the two things a reader must not have:
 *
 * - a **control-plane endpoint**, which is where the writer-lease table lives.
 *   Holding no credential that can reach it is how "must not acquire or renew
 *   the lease" stops being a rule and becomes unsayable.
 * - an **identity verifier**, whose `operations` *sign* the startup
 *   attestation. A reader attests nothing, and a web process a human logs into
 *   is the last place the platform signing key should be.
 *
 * Both are refused rather than ignored, so a misconfiguration that hands the
 * reader either one fails at composition instead of quietly widening it.
 *
 * @param {any} options
 */
function isReadOnlyPostgres(options) {
  try {
    const selection = options?.deployment?.selection;
    if (selection && selection.adapter === 'postgresql' && selection.access === 'read-only') {
      return Boolean(selection.spine?.tenant?.id && selection.connection);
    }
    // The same two channels the writer has. A composition reachable only from
    // the deployment selection could not be tested against a real database
    // without TLS material, and one reachable only from the harness would be
    // the defect this campaign has now found twice: a contract nobody in
    // production can compose.
    if (options?.adapter === 'postgresql' && options.testHarness?.loopback === true
      && options.testHarness.access === 'read-only') {
      return Boolean(options.spine?.tenant?.id && options.testHarness.data);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * @param {any} options
 */
function refuseReadOnlyWriterInputs(options) {
  const selection = options.deployment?.selection ?? options.testHarness;
  const identityVerifier = options.deployment
    ? options.deployment.identityVerifier
    : options.identityVerifier;
  // Named as the caller wrote it: the deployment channel calls it
  // `controlPlane`, the harness calls it `control`, and a refusal that reports
  // the other one sends the reader looking for a key they did not pass.
  const controlKey = selection.controlPlane != null ? 'controlPlane' : 'control';
  if (selection[controlKey] != null) {
    throw new AppError(
      'a read-only composition takes no control-plane endpoint: the writer-lease table lives there',
      { code: 'READ_ONLY_COMPOSITION_REFUSED', status: 400, details: { option: controlKey } },
    );
  }
  if (identityVerifier != null) {
    throw new AppError(
      'a read-only composition attests nothing, so it takes no identity verifier',
      { code: 'READ_ONLY_COMPOSITION_REFUSED', status: 400, details: { option: 'identityVerifier' } },
    );
  }
  if (options.productionOperations != null) {
    throw new AppError(
      'a read-only composition starts no workers, so it composes no production operations',
      { code: 'READ_ONLY_COMPOSITION_REFUSED', status: 400, details: { option: 'productionOperations' } },
    );
  }
}

/**
 * @param {any} options
 */
function refuseUnavailableOptions(options) {
  if (options == null || typeof options !== 'object' || Array.isArray(options)) {
    return;
  }

  // Before the read-only carve, not after it. The composition whose whole
  // design is "refuse the inputs that would widen this" must not be the one
  // composition that accepts `authorize`, `listen` or `providers` silently.
  refuseGloballyUnsupportedOptions(options);

  if (isReadOnlyPostgres(options)) {
    refuseReadOnlyWriterInputs(options);
    return;
  }

  if (looksLikePostgres(options) && !isCompletePostgres(options)) {
    throw bindingRequired();
  }

  if (!isCompletePostgres(options)) {
    for (const key of ['spine', 'identityVerifier', 'deploymentStorage']) {
      let value;
      try {
        value = options[key];
      } catch {
        throw optionUnsupported(key);
      }
      if (value != null) throw optionUnsupported(key);
    }
  }

}

/**
 * @param {any} options
 */
function refuseGloballyUnsupportedOptions(options) {
  for (const key of UNSUPPORTED_KEYS) {
    let value;
    try {
      value = options[key];
    } catch {
      throw optionUnsupported(key);
    }
    if (value != null) throw optionUnsupported(key);
  }
}

/**
 * Exported for the same reason `passwordFromEndpoint` is: the refusals here are
 * the security properties, and a test that cannot reach them tests prose.
 */
export function sslFromEndpoint(endpoint, projectRoot) {
  const caFile = endpoint.tls?.caFile;
  if (typeof caFile !== 'string' || caFile === '') {
    throw new AppError(
      'deployment-storage PostgreSQL connections require authenticated TLS with certificate and hostname verification',
      { code: 'DEPLOYMENT_STORAGE_TLS_REFUSED', status: 500 },
    );
  }
  const path = isAbsolute(caFile) ? caFile : resolve(projectRoot ?? process.cwd(), caFile);
  const ca = readTrustedRegularFile(path, {
    maxBytes: 64 * 1024,
    untrusted: () => {
      throw new AppError(
        'deployment-storage PostgreSQL connections require authenticated TLS with certificate and hostname verification',
        { code: 'DEPLOYMENT_STORAGE_TLS_REFUSED', status: 500 },
      );
    },
  });
  // A managed database that issues a per-instance certificate names no host in
  // it: the subject is an instance id and there is no SAN. Hostname
  // verification therefore cannot pass, and `servername` cannot rescue it —
  // the `pg` driver copies the caller's TLS options and then overwrites
  // `servername` with the host for any non-IP host (`pg/lib/connection.js`,
  // where the assign at 103 is undone at 118). The seam this function offered
  // was inert with the driver this repository pins, which is worse than an
  // absent option because callers build on it.
  //
  // So a caller may pin the certificate itself instead. This is deliberately
  // NOT a `checkServerIdentity` hook: a hook accepts `() => undefined`, which
  // turns the one seam that exists into the hole that disables verification.
  // A fingerprint can only exchange *which* property is proved, never whether
  // one is. What it proves is narrower and the name says so: possession of the
  // pinned key, not the identity of the host that answered.
  const pinned = endpoint.tls.pinnedCertificateSha256;
  if (pinned !== undefined) {
    const expected = normaliseFingerprint(pinned);
    if (expected === null) {
      throw new AppError(
        'a pinned certificate fingerprint must be 32 bytes of hex, with or without separators',
        { code: 'DEPLOYMENT_STORAGE_TLS_REFUSED', status: 500 },
      );
    }
    return {
      rejectUnauthorized: true,
      ca,
      // Still sent, and still overwritten by the driver. Kept so the intent is
      // legible next to the check that actually holds.
      servername: endpoint.tls.servername ?? endpoint.host,
      checkServerIdentity: (_host, cert) => {
        const presented = normaliseFingerprint(cert?.fingerprint256);
        if (presented === null || presented !== expected) {
          return new AppError(
            'the database presented a certificate this deployment has not pinned',
            { code: 'DEPLOYMENT_STORAGE_TLS_REFUSED', status: 500 },
          );
        }
        return undefined;
      },
    };
  }
  return {
    rejectUnauthorized: true,
    ca,
    servername: endpoint.tls.servername ?? endpoint.host,
  };
}

/**
 * Accepts the two shapes a SHA-256 fingerprint is written in — bare hex and
 * colon-separated, which is what `tls` returns — and refuses everything else.
 * Comparing the written forms directly would make `AA:BB` and `aabb` disagree
 * about the same certificate.
 * @param {unknown} value
 */
function normaliseFingerprint(value) {
  if (typeof value !== 'string') return null;
  const hex = value.replace(/[:\s]/g, '').toLowerCase();
  return /^[0-9a-f]{64}$/.test(hex) ? hex : null;
}

export function passwordFromEndpoint(endpoint, secretResolver, purpose, tenantId) {
  if (typeof endpoint.passwordSecret !== 'string' || !secretResolver) {
    throw new AppError(
      'PostgreSQL deployment storage requires a resolvable credential reference',
      { code: 'DEPLOYMENT_STORAGE_SECRET_REFERENCE_REQUIRED', status: 500, details: { adapter: 'postgresql' } },
    );
  }
  return async function resolvePostgresqlPassword() {
    const lease = await secretResolver.resolveSecret(endpoint.passwordSecret, {
      purpose,
      tenantId,
    });
    return lease.use((value) => value);
  };
}

function postgresqlEndpoint(endpoint, secretResolver, purpose, tenantId, projectRoot) {
  return {
    host: endpoint.host,
    ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
    database: endpoint.database,
    user: endpoint.user,
    password: passwordFromEndpoint(endpoint, secretResolver, purpose, tenantId),
    ssl: sslFromEndpoint(endpoint, projectRoot),
  };
}

function loopbackEndpoint(endpoint) {
  if (!LOOPBACK.has(String(endpoint.host))) {
    throw bindingRequired();
  }
  // search_path / options are never isolation inputs and are not forwarded.
  return Object.freeze({
    host: endpoint.host,
    port: endpoint.port,
    database: endpoint.database,
    user: endpoint.user,
    password: endpoint.password,
    ssl: false,
    acquisitionDeadlineMs: endpoint.acquisitionDeadlineMs,
  });
}

/**
 * Own one portable application. Startup is unconditionally async.
 *
 * @param {{
 *   dbPath?: string,
 *   busyTimeoutMs?: number,
 *   clock?: () => string,
 *   approvalThresholdCents?: number,
 *   catalogTimeoutMs?: number,
 *   signatureTimeoutMs?: number,
 *   selected?: any,
 *   adapter?: unknown,
 *   deployment?: { selection: any, identityVerifier: any, secretResolver?: any },
 *   testHarness?: any,
 *   spine?: any,
 *   identityVerifier?: any,
 *   moduleMigrations?: Array<{name: string, sql: string}>,
 *   projectRoot?: string,
 *   listenMode?: string,
 *   faultInject?: string,
 *   now?: () => number,
 *   leaseTtlMs?: number,
 *   queryDeadlineMs?: number,
 *   acquisitionDeadlineMs?: number,
 *   rebind?: unknown,
 *   promoteClone?: unknown,
 *   telemetry?: unknown,
 *   productionOperations?: object,
 * }} [options]
 */
export async function createAccordoAppAsync(options = {}) {
  refuseUnavailableOptions(options);
  const selected = options.selected === undefined ? DEFAULT_SELECTED_GRAPH : options.selected;
  const listenMode = options.listenMode
    ?? options.deployment?.selection?.spine?.mode
    ?? options.spine?.mode
    ?? 'local-development';

  if (isReadOnlyPostgres(options)) {
    const selection = options.deployment?.selection;
    const tenantId = selection ? selection.spine.tenant.id : options.spine.tenant.id;
    return startPortablePostgresqlReaderApp({
      selected,
      listenMode,
      tenantId,
      data: selection
        ? postgresqlEndpoint(
          selection.connection,
          options.deployment.secretResolver,
          'postgresql-data-password',
          tenantId,
          options.projectRoot,
        )
        : loopbackEndpoint(options.testHarness.data),
      pinnedBindingUuid: selection
        ? selection.pinnedBindingUuid
        : options.testHarness.pinnedBindingUuid,
      moduleMigrations: options.moduleMigrations,
      clock: options.clock,
      approvalThresholdCents: options.approvalThresholdCents,
      catalogTimeoutMs: options.catalogTimeoutMs,
      signatureTimeoutMs: options.signatureTimeoutMs,
      queryDeadlineMs: options.queryDeadlineMs ?? options.testHarness?.queryDeadlineMs,
      acquisitionDeadlineMs: options.acquisitionDeadlineMs ?? options.testHarness?.acquisitionDeadlineMs,
    });
  }

  if (isCompletePostgres(options) && options.deployment?.selection?.adapter === 'postgresql') {
    const selection = options.deployment.selection;
    const projectRoot = options.projectRoot;
    return startPortablePostgresqlApp({
      selected,
      listenMode,
      tenantId: selection.spine.tenant.id,
      identityVerifier: options.deployment.identityVerifier,
      control: postgresqlEndpoint(
        selection.controlPlane,
        options.deployment.secretResolver,
        'postgresql-control-password',
        selection.spine.tenant.id,
        projectRoot,
      ),
      data: postgresqlEndpoint(
        selection.connection,
        options.deployment.secretResolver,
        'postgresql-data-password',
        selection.spine.tenant.id,
        projectRoot,
      ),
      moduleMigrations: options.moduleMigrations,
      clock: options.clock,
      approvalThresholdCents: options.approvalThresholdCents,
      catalogTimeoutMs: options.catalogTimeoutMs,
      signatureTimeoutMs: options.signatureTimeoutMs,
      faultInject: options.faultInject,
      now: options.now,
      leaseTtlMs: options.leaseTtlMs,
      queryDeadlineMs: options.queryDeadlineMs,
      acquisitionDeadlineMs: options.acquisitionDeadlineMs,
      rebind: options.rebind,
      promoteClone: options.promoteClone,
      telemetry: options.telemetry,
      productionOperations: options.productionOperations,
    });
  }

  if (isCompletePostgres(options) && options.testHarness?.loopback === true) {
    return startPortablePostgresqlApp({
      selected,
      listenMode,
      tenantId: options.spine.tenant.id,
      identityVerifier: options.identityVerifier,
      control: loopbackEndpoint(options.testHarness.control),
      data: loopbackEndpoint(options.testHarness.data),
      moduleMigrations: options.moduleMigrations,
      clock: options.clock,
      approvalThresholdCents: options.approvalThresholdCents,
      catalogTimeoutMs: options.catalogTimeoutMs,
      signatureTimeoutMs: options.signatureTimeoutMs,
      faultInject: options.faultInject,
      now: options.now,
      leaseTtlMs: options.leaseTtlMs ?? options.testHarness.leaseTtlMs,
      queryDeadlineMs: options.queryDeadlineMs ?? options.testHarness.queryDeadlineMs,
      acquisitionDeadlineMs: options.acquisitionDeadlineMs ?? options.testHarness.acquisitionDeadlineMs,
      rebind: options.rebind,
      promoteClone: options.promoteClone,
      telemetry: options.telemetry,
      productionOperations: options.productionOperations,
    });
  }

  return startPortableSqliteApp({
    selected,
    dbPath: options.dbPath,
    busyTimeoutMs: options.busyTimeoutMs,
    moduleMigrations: options.moduleMigrations,
    clock: options.clock,
    approvalThresholdCents: options.approvalThresholdCents,
    catalogTimeoutMs: options.catalogTimeoutMs,
    signatureTimeoutMs: options.signatureTimeoutMs,
    telemetry: options.telemetry,
    productionOperations: options.productionOperations,
  });
}
