// @ts-check

import { AppError, ValidationError } from './errors.js';
import { isSyncStorage, storageApi } from './storage-runtime.js';

/**
 * PostgreSQL write-outcome ledger (Spine v2 M4A).
 *
 * One row per (canonical tenant namespace, raw caller key, phase). The row is
 * inserted in the same SERIALIZABLE transaction as the domain write. Lookup is
 * by tenant+raw key (+phase) first; stored scope is compared afterwards.
 *
 * This store is adapter infrastructure, not a CRM module. SQLite compositions
 * never create or query the table.
 */

export const WRITE_OUTCOMES = 'write_outcomes';
export const WRITE_OUTCOME_PHASES = Object.freeze(['root', 'intent', 'call', 'receipt', 'finalize']);

export const WRITE_OUTCOME_DDL = `
CREATE TABLE IF NOT EXISTS write_outcomes (
  tenant_namespace TEXT NOT NULL,
  raw_key TEXT NOT NULL,
  phase TEXT NOT NULL,
  subject_fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL,
  target TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  record_ids_json TEXT NOT NULL,
  response_json TEXT,
  event_intents_json TEXT NOT NULL,
  trace_intent_json TEXT NOT NULL,
  run_id TEXT NOT NULL,
  events_promoted INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  acknowledged_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_namespace, raw_key, phase)
)
`;

/**
 * @param {unknown} value
 */
function decodeJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * @param {any} row
 */
function mapOutcome(row) {
  if (!row) return null;
  return Object.freeze({
    tenantNamespace: String(row.tenant_namespace),
    rawKey: String(row.raw_key),
    phase: String(row.phase),
    subjectFingerprint: String(row.subject_fingerprint),
    operation: String(row.operation),
    target: String(row.target),
    contractVersion: String(row.contract_version),
    requestFingerprint: String(row.request_fingerprint),
    recordIds: decodeJson(row.record_ids_json),
    response: decodeJson(row.response_json),
    eventIntents: decodeJson(row.event_intents_json) ?? [],
    traceIntent: decodeJson(row.trace_intent_json),
    runId: String(row.run_id),
    eventsPromoted: Number(row.events_promoted ?? 0) === 1,
    createdAt: row.created_at,
    acknowledgedAt: row.acknowledged_at ?? null,
  });
}

/**
 * @param {any} database
 */
export function createWriteOutcomeStore(database) {
  if (isSyncStorage(database)) {
    throw new ValidationError('Write outcomes are PostgreSQL-only');
  }

  function api() {
    return storageApi(database);
  }

  return Object.freeze({
    /**
     * @param {string} tenantNamespace
     * @param {string} rawKey
     * @param {string} [phase]
     */
    async lookup(tenantNamespace, rawKey, phase = 'root') {
      const row = await api().maybeOne({
        kind: 'select',
        table: WRITE_OUTCOMES,
        columns: '*',
        where: [
          { column: 'tenant_namespace', op: 'eq', value: tenantNamespace },
          { column: 'raw_key', op: 'eq', value: rawKey },
          { column: 'phase', op: 'eq', value: phase },
        ],
      });
      return mapOutcome(row);
    },

    /** Lookup one exact phase by its stable run identity without exposing the raw key to jobs. */
    async lookupByRun(tenantNamespace, runId, phase) {
      const row = await api().maybeOne({
        kind: 'select',
        table: WRITE_OUTCOMES,
        columns: '*',
        where: [
          { column: 'tenant_namespace', op: 'eq', value: tenantNamespace },
          { column: 'run_id', op: 'eq', value: runId },
          { column: 'phase', op: 'eq', value: phase },
        ],
      });
      return mapOutcome(row);
    },

    /**
     * @param {{
     *   tenantNamespace: string,
     *   rawKey: string,
     *   phase?: string,
     *   subjectFingerprint: string,
     *   operation: string,
     *   target: string,
     *   contractVersion: string,
     *   requestFingerprint: string,
     *   recordIds: unknown,
     *   response: unknown,
     *   eventIntents: unknown,
     *   traceIntent: unknown,
     *   runId: string,
     *   createdAt: string,
     * }} outcome
     */
    async insert(outcome) {
      const phase = outcome.phase ?? 'root';
      if (!WRITE_OUTCOME_PHASES.includes(phase)) {
        throw new ValidationError('Unsupported write-outcome phase', { field: 'phase' });
      }
      await api().execute({
        kind: 'insert',
        table: WRITE_OUTCOMES,
        values: [
          { column: 'tenant_namespace', value: outcome.tenantNamespace },
          { column: 'raw_key', value: outcome.rawKey },
          { column: 'phase', value: phase },
          { column: 'subject_fingerprint', value: outcome.subjectFingerprint },
          { column: 'operation', value: outcome.operation },
          { column: 'target', value: outcome.target },
          { column: 'contract_version', value: outcome.contractVersion },
          { column: 'request_fingerprint', value: outcome.requestFingerprint },
          { column: 'record_ids_json', value: JSON.stringify(outcome.recordIds ?? []) },
          { column: 'response_json', value: JSON.stringify(outcome.response ?? null) },
          { column: 'event_intents_json', value: JSON.stringify(outcome.eventIntents ?? []) },
          { column: 'trace_intent_json', value: JSON.stringify(outcome.traceIntent ?? null) },
          { column: 'run_id', value: outcome.runId },
          { column: 'events_promoted', value: 0 },
          { column: 'created_at', value: outcome.createdAt },
        ],
      });
    },

    /**
     * Compare-and-set terminal event-promotion evidence. Call only after every
     * stored intent was dispatched; V3A job ownership prevents concurrent dispatch.
     *
     * @param {{ tenantNamespace: string, rawKey: string, phase?: string }} outcome
     */
    async tryPromoteEvents(outcome) {
      const phase = outcome.phase ?? 'root';
      const result = await api().execute({
        kind: 'update',
        table: WRITE_OUTCOMES,
        values: [{ column: 'events_promoted', value: 1 }],
        where: [
          { column: 'tenant_namespace', op: 'eq', value: outcome.tenantNamespace },
          { column: 'raw_key', op: 'eq', value: outcome.rawKey },
          { column: 'phase', op: 'eq', value: phase },
          { column: 'events_promoted', op: 'eq', value: 0 },
        ],
      });
      return Number(result?.affectedRows ?? 0) === 1;
    },

    /**
     * Subject-scoped pending discovery. Never returns another subject's keys
     * and never includes domain payload.
     *
     * @param {string} tenantNamespace
     * @param {string} subjectFingerprint
     */
    async listUnacknowledged(tenantNamespace, subjectFingerprint) {
      const rows = await api().many({
        kind: 'select',
        table: WRITE_OUTCOMES,
        columns: '*',
        where: [
          { column: 'tenant_namespace', op: 'eq', value: tenantNamespace },
          { column: 'subject_fingerprint', op: 'eq', value: subjectFingerprint },
          { column: 'phase', op: 'eq', value: 'root' },
          { column: 'acknowledged_at', op: 'is-null' },
        ],
        orderBy: [
          { column: 'created_at', direction: 'asc' },
          { column: 'raw_key', direction: 'asc' },
        ],
      });
      return (rows ?? []).map(mapOutcome).filter(Boolean);
    },

    /**
     * Compare-and-set client acknowledgement. Returns true when this caller
     * flipped the flag.
     *
     * @param {{ tenantNamespace: string, rawKey: string, phase?: string, acknowledgedAt: string }} outcome
     */
    async tryAcknowledge(outcome) {
      const phase = outcome.phase ?? 'root';
      const result = await api().execute({
        kind: 'update',
        table: WRITE_OUTCOMES,
        values: [{ column: 'acknowledged_at', value: outcome.acknowledgedAt }],
        where: [
          { column: 'tenant_namespace', op: 'eq', value: outcome.tenantNamespace },
          { column: 'raw_key', op: 'eq', value: outcome.rawKey },
          { column: 'phase', op: 'eq', value: phase },
          { column: 'acknowledged_at', op: 'is-null' },
        ],
      });
      return Number(result?.affectedRows ?? 0) === 1;
    },
  });
}

/**
 * @param {unknown} error
 */
export function isUnknownCommit(error) {
  return Boolean(error && typeof error === 'object' && /** @type {any} */ (error).code === 'COMMIT_OUTCOME_UNKNOWN');
}

/**
 * @param {unknown} error
 */
export function unknownCommitUnprovable(error) {
  if (isUnknownCommit(error)) return true;
  const code = error && typeof error === 'object' ? /** @type {any} */ (error).code : undefined;
  return code === 'STORAGE_UNAVAILABLE' || code === 'STORAGE_TIMEOUT';
}

/**
 * @param {string} idempotencyKey
 * @param {string} [runId]
 */
export function unknownCommitError(idempotencyKey, runId) {
  return new AppError('PostgreSQL commit outcome is unknown', {
    code: 'COMMIT_OUTCOME_UNKNOWN',
    status: 503,
    details: {
      idempotencyKey,
      ...(runId ? { runId } : {}),
    },
  });
}
