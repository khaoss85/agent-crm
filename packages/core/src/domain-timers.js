// @ts-check

/**
 * **Scheduled asks — the composition that owns *when*.**
 *
 * Two sentences in the checked-in packages decide the shape of this file, and
 * both were written deliberately. `work` "schedules nothing, reminds nobody and
 * assigns to nobody" and is "consumed, never a consumer". `lifecycle` "cancels
 * nothing, schedules nothing, prices nothing and notifies nobody". They are a
 * division of labour: **a domain owns what is asked, the spine owns when, and
 * the application composes the two.** Nothing here lives inside a domain
 * package, and no package claim changes because this exists.
 *
 * What a scheduled ask is: a human writes an instruction to open a domain ask
 * at a future instant. The instruction is a visible record, not a job payload,
 * so it can be read, cancelled and rescheduled like anything else a person
 * owns. The durable job carries only the record's identity and a fingerprint.
 *
 * What the timer may do with it is deliberately almost nothing. At the instant,
 * it marks the record due and — for an ask that opens domain work — presents
 * the instruction to the seam the domain already offers, using the consumer
 * identity **the record carries**. It chooses neither the consumer, nor the
 * content, nor the instant: all three are covered by a fingerprint written when
 * a person asked. A record whose provenance or content has moved is refused, so
 * "a timer could pass any consumer" is false in the only sense that matters.
 */

import { createHash, randomUUID } from 'node:crypto';
import { AppError, ValidationError } from './errors.js';
import { normalizeActor, trustedSystemActor } from './actor.js';
import { createDurableJobStore } from './durable-jobs.js';
import { storageApi } from './storage-runtime.js';
import { nowIso } from './time.js';

export const DOMAIN_TIMER_CONTRACT = 1;

/** The closed set of asks a timer may open. */
export const SCHEDULED_ASK_KINDS = Object.freeze(['work-follow-up', 'renewal-review']);

/** The closed lifecycle of one scheduled ask. */
export const SCHEDULED_ASK_STATES = Object.freeze(['scheduled', 'due', 'opened', 'cancelled']);

export const SCHEDULED_ASK_TABLE = 'spine_scheduled_asks';
const JOB_KIND = 'scheduled-ask';
const HANDLER_NAME = 'open-scheduled-ask';
const MAX_TEXT = 200;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const NAME = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const SCHEDULED_ASK_COLUMNS = `(
  id TEXT PRIMARY KEY,
  contract_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  consumer_package TEXT NOT NULL,
  capability_name TEXT NOT NULL,
  capability_version INTEGER NOT NULL,
  ask_json TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  state TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  opened_reference TEXT,
  requested_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

/**
 * The composition module, per dialect.
 *
 * Keyed by name rather than by version, so a scheduled ask adds no core
 * migration and moves no frozen migration expectation. PostgreSQL keeps its
 * tables in the application schema and SQLite has none, so the two renderings
 * differ in exactly that: a single string would have been wrong on one of them.
 *
 * @param {{dialect?: 'sqlite'|'postgresql'}} [options]
 */
export function scheduledAskMigration(options = {}) {
  const dialect = options.dialect ?? 'sqlite';
  if (dialect !== 'sqlite' && dialect !== 'postgresql') {
    throw new ValidationError('dialect must be sqlite or postgresql', { field: 'dialect' });
  }
  const table = dialect === 'postgresql'
    ? `"accordo"."${SCHEDULED_ASK_TABLE}"`
    : SCHEDULED_ASK_TABLE;
  const prelude = dialect === 'postgresql' ? 'CREATE SCHEMA IF NOT EXISTS "accordo";\n' : '';
  return Object.freeze({
    name: 'spine_scheduled_asks_v1',
    sql: `${prelude}CREATE TABLE IF NOT EXISTS ${table} ${SCHEDULED_ASK_COLUMNS};\n`,
  });
}

/** The SQLite rendering, which is what a local composition uses. */
export const SCHEDULED_ASK_MIGRATION = scheduledAskMigration({ dialect: 'sqlite' });

function refuse(code, message, status = 400) {
  throw new AppError(message, { code, status });
}

function boundedText(value, field, max = MAX_TEXT) {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, { field });
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > max) {
    throw new ValidationError(`${field} must be 1..${max} characters`, { field });
  }
  if (CONTROL_CHARS.test(trimmed)) throw new ValidationError(`${field} must not carry control characters`, { field });
  return trimmed;
}

function boundedName(value, field) {
  const text = boundedText(value, field, 64);
  if (!NAME.test(text)) throw new ValidationError(`${field} must be a canonical name`, { field });
  return text;
}

function instant(value, field) {
  const text = boundedText(value, field, 40);
  if (!UTC_INSTANT.test(text) || Number.isNaN(Date.parse(text))) {
    throw new ValidationError(`${field} must be a canonical UTC instant`, { field });
  }
  return text;
}

/**
 * The human boundary, and the reason it is here rather than in a domain.
 *
 * Scheduling is an instruction a person gives. The domain packages already
 * refuse an agent every writing action; a scheduled ask would be a way around
 * that refusal if it did not make the same demand at the moment the instruction
 * is written. The timer that later executes it holds no authority of its own.
 */
function requireHumanRequester(actor) {
  const normalized = normalizeActor(actor);
  if (normalized.type !== 'user') {
    refuse('HUMAN_APPROVAL_REQUIRED', 'Scheduling an ask is a human decision', 403);
  }
  return normalized.id;
}

/** Canonical JSON, so a fingerprint is stable across key order. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

/**
 * Everything a timer is not allowed to choose is covered here: who asked, what
 * for, which consumer identity, and when. A record that has moved in any of
 * them stops being the instruction that was written.
 */
export function scheduledAskFingerprint(record) {
  return createHash('sha256').update(canonical({
    contractVersion: DOMAIN_TIMER_CONTRACT,
    id: record.id,
    kind: record.kind,
    tenantId: record.tenantId,
    consumerPackage: record.consumerPackage,
    capabilityName: record.capabilityName,
    capabilityVersion: record.capabilityVersion,
    ask: record.ask,
    scheduledFor: record.scheduledFor,
    requestedBy: record.requestedBy,
  })).digest('hex');
}

function validateAsk(kind, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError('ask must be an object', { field: 'ask' });
  }
  if (kind === 'work-follow-up') {
    const subject = value.subject;
    if (!subject || typeof subject !== 'object') {
      throw new ValidationError('ask.subject is required', { field: 'ask.subject' });
    }
    return Object.freeze({
      sourceKey: boundedText(value.sourceKey, 'ask.sourceKey'),
      title: boundedText(value.title, 'ask.title'),
      subject: Object.freeze({
        resource: boundedName(subject.resource, 'ask.subject.resource'),
        id: boundedText(subject.id, 'ask.subject.id'),
      }),
    });
  }
  return Object.freeze({
    sourceKey: boundedText(value.sourceKey, 'ask.sourceKey'),
    summary: boundedText(value.summary, 'ask.summary'),
    contractId: boundedText(value.contractId, 'ask.contractId'),
  });
}

function decodeRow(row) {
  if (!row) return null;
  return Object.freeze({
    id: String(row.id),
    contractVersion: Number(row.contract_version),
    kind: String(row.kind),
    tenantId: String(row.tenant_id),
    consumerPackage: String(row.consumer_package),
    capabilityName: String(row.capability_name),
    capabilityVersion: Number(row.capability_version),
    ask: Object.freeze(JSON.parse(String(row.ask_json))),
    scheduledFor: String(row.scheduled_for),
    state: String(row.state),
    fingerprint: String(row.fingerprint),
    openedReference: row.opened_reference == null ? null : String(row.opened_reference),
    requestedBy: String(row.requested_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  });
}

function api(database) {
  return storageApi(database);
}

async function loadAsk(database, tenantId, id) {
  const row = await api(database).maybeOne({
    kind: 'select',
    table: SCHEDULED_ASK_TABLE,
    columns: '*',
    where: [
      { column: 'tenant_id', op: 'eq', value: String(tenantId) },
      { column: 'id', op: 'eq', value: String(id) },
    ],
  });
  return decodeRow(row);
}

/**
 * Write the instruction and the timer that will present it, in one transaction.
 *
 * A rollback therefore leaves neither, and no task exists before the instant.
 * The job payload carries the record id and its fingerprint and nothing else:
 * the shape V3B established, for the reason V3B established it.
 *
 * @param {{database: any, tenantId: string, actor: unknown, now?: () => string}} context
 * @param {{kind: string, consumerPackage: string, capability: {name: string, version: number},
 *   scheduledFor: string, ask: any, id?: string}} request
 */
export async function scheduleAsk(context, request) {
  const { database, tenantId } = context;
  const now = typeof context.now === 'function' ? context.now : nowIso;
  const requestedBy = requireHumanRequester(context.actor);
  if (!request || typeof request !== 'object') throw new ValidationError('a scheduled ask request is required');
  const kind = boundedName(request.kind, 'kind');
  if (!SCHEDULED_ASK_KINDS.includes(kind)) {
    throw new ValidationError('kind must be a supported scheduled ask', { field: 'kind' });
  }
  const capability = request.capability;
  if (!capability || typeof capability !== 'object') {
    throw new ValidationError('capability is required', { field: 'capability' });
  }
  const record = {
    id: typeof request.id === 'string' && request.id ? boundedText(request.id, 'id') : randomUUID(),
    kind,
    tenantId: String(tenantId),
    consumerPackage: boundedName(request.consumerPackage, 'consumerPackage'),
    capabilityName: boundedName(capability.name, 'capability.name'),
    capabilityVersion: Number.isInteger(capability.version) && capability.version > 0
      ? capability.version
      : (() => { throw new ValidationError('capability.version must be a positive integer', { field: 'capability.version' }); })(),
    ask: validateAsk(kind, request.ask),
    scheduledFor: instant(request.scheduledFor, 'scheduledFor'),
    requestedBy,
  };
  const fingerprint = scheduledAskFingerprint(record);
  const createdAt = now();
  const jobs = createDurableJobStore({ storage: database.storage, tenantId: String(tenantId), clock: now });

  return database.transactionAsync(async () => {
    await api(database).execute({
      kind: 'insert',
      table: SCHEDULED_ASK_TABLE,
      values: [
        { column: 'id', value: record.id },
        { column: 'contract_version', value: DOMAIN_TIMER_CONTRACT },
        { column: 'kind', value: record.kind },
        { column: 'tenant_id', value: record.tenantId },
        { column: 'consumer_package', value: record.consumerPackage },
        { column: 'capability_name', value: record.capabilityName },
        { column: 'capability_version', value: record.capabilityVersion },
        { column: 'ask_json', value: JSON.stringify(record.ask) },
        { column: 'scheduled_for', value: record.scheduledFor },
        { column: 'state', value: 'scheduled' },
        { column: 'fingerprint', value: fingerprint },
        { column: 'opened_reference', value: null },
        { column: 'requested_by', value: record.requestedBy },
        { column: 'created_at', value: createdAt },
        { column: 'updated_at', value: createdAt },
      ],
    });
    const job = await jobs.enqueue({
      kind: JOB_KIND,
      handler: { name: HANDLER_NAME, contract: 1, version: 1 },
      payload: { contractVersion: DOMAIN_TIMER_CONTRACT, askId: record.id, fingerprint },
      scheduleAt: record.scheduledFor,
      idempotencyRoot: `scheduled-ask:${record.id}`,
      outcomeReference: `scheduled-ask:${record.id}`,
      recoveryPolicy: 'reconcilable_at_least_once',
      maxAttempts: 5,
    }, { transaction: api(database), actor: context.actor });
    return Object.freeze({ ...record, fingerprint, state: 'scheduled', jobId: job.id, createdAt });
  });
}

export { JOB_KIND as SCHEDULED_ASK_JOB_KIND, HANDLER_NAME as SCHEDULED_ASK_HANDLER };
export { loadAsk as readScheduledAsk };

const TIMER_ACTOR = trustedSystemActor('presenting a human-written scheduled ask at its instant');

async function moveState(database, tenantId, record, next, now, extra = []) {
  const result = await api(database).execute({
    kind: 'update',
    table: SCHEDULED_ASK_TABLE,
    values: [{ column: 'state', value: next }, { column: 'updated_at', value: now }, ...extra],
    where: [
      { column: 'tenant_id', op: 'eq', value: record.tenantId },
      { column: 'id', op: 'eq', value: record.id },
      { column: 'state', op: 'eq', value: record.state },
    ],
  });
  if (Number(result?.affectedRows ?? 0) !== 1) {
    refuse('SCHEDULED_ASK_STATE_CONFLICT', 'the scheduled ask moved under this caller', 409);
  }
}

/**
 * Cancel an instruction. A cancelled ask is never presented: the timer still
 * runs, reads the record, and does nothing — which is why cancellation is a
 * plain mutation here rather than a search for a job to delete.
 *
 * @param {{database: any, tenantId: string, actor: unknown, now?: () => string}} context
 */
export async function cancelScheduledAsk(context, id) {
  const now = typeof context.now === 'function' ? context.now : nowIso;
  requireHumanRequester(context.actor);
  const record = await loadAsk(context.database, context.tenantId, id);
  if (!record) refuse('SCHEDULED_ASK_NOT_FOUND', 'no such scheduled ask', 404);
  if (record.state === 'opened') refuse('SCHEDULED_ASK_ALREADY_OPENED', 'an opened ask cannot be cancelled', 409);
  if (record.state === 'cancelled') return record;
  return context.database.transactionAsync(async () => {
    await moveState(context.database, context.tenantId, record, 'cancelled', now());
    return loadAsk(context.database, context.tenantId, id);
  });
}

/**
 * Move an instruction to a new instant. The fingerprint moves with it, so a
 * timer already holding the old one refuses: a rescheduled ask executes at the
 * new instant and never at the old one.
 *
 * @param {{database: any, tenantId: string, actor: unknown, now?: () => string}} context
 */
export async function rescheduleAsk(context, id, scheduledFor) {
  const now = typeof context.now === 'function' ? context.now : nowIso;
  requireHumanRequester(context.actor);
  const next = instant(scheduledFor, 'scheduledFor');
  const record = await loadAsk(context.database, context.tenantId, id);
  if (!record) refuse('SCHEDULED_ASK_NOT_FOUND', 'no such scheduled ask', 404);
  if (record.state !== 'scheduled') {
    refuse('SCHEDULED_ASK_NOT_RESCHEDULABLE', 'only a scheduled ask can be moved', 409);
  }
  const moved = { ...record, scheduledFor: next };
  const fingerprint = scheduledAskFingerprint(moved);
  const jobs = createDurableJobStore({ storage: context.database.storage, tenantId: String(context.tenantId), clock: now });
  return context.database.transactionAsync(async () => {
    await moveState(context.database, context.tenantId, record, 'scheduled', now(), [
      { column: 'scheduled_for', value: next },
      { column: 'fingerprint', value: fingerprint },
    ]);
    await jobs.enqueue({
      kind: JOB_KIND,
      handler: { name: HANDLER_NAME, contract: 1, version: 1 },
      payload: { contractVersion: DOMAIN_TIMER_CONTRACT, askId: record.id, fingerprint },
      scheduleAt: next,
      idempotencyRoot: `scheduled-ask:${record.id}:${fingerprint}`,
      outcomeReference: `scheduled-ask:${record.id}`,
      recoveryPolicy: 'reconcilable_at_least_once',
      maxAttempts: 5,
    }, { transaction: api(context.database), actor: context.actor });
    return loadAsk(context.database, context.tenantId, id);
  });
}

/**
 * Register the timer consumer on a V3A handler registry.
 *
 * `domains` is the composed package registry: the handler reaches a domain only
 * through the capability seam, and passes the consumer identity the record
 * carries. `PackageRegistry.capability` re-proves that identity against the
 * consumer's own declared `requires`, so an instruction naming a package that
 * is not composed, or that never declared the capability, is refused there.
 *
 * @param {any} registry
 * @param {{database: any, tenantId: string, domains?: any, modules?: any, clock?: () => string}} composition
 */
/**
 * Answer, before anything is composed over it, whether this database can serve
 * the scheduled-ask table.
 *
 * The table is not core schema in either dialect: `scheduledAskMigration` ships
 * with this contract and the composing application applies it, the same way it
 * starts the worker. That is deliberate, and it has one failure mode — compose
 * the timers, forget the migration, and learn about it at the first poll, in a
 * worker, as a job that fails. This turns that into a refusal at the wiring.
 *
 * Three states, not a boolean, because the two adapters do not know the same
 * amount. SQLite says `no such table` and can be believed. PostgreSQL wraps
 * every failure as `STORAGE_UNAVAILABLE` with no cause and no code, so a
 * missing table and an unreachable database are the same sentence there. The
 * honest answer is `unreadable`: something is wrong, and this cannot say which.
 * Reporting that as `missing` would send a reader to apply a migration while
 * their database was down.
 *
 * @param {any} database
 * @param {string} tenantId
 * @returns {Promise<'ready' | 'missing' | 'unreadable'>}
 */
export async function scheduledAskStorageReady(database, tenantId) {
  try {
    await storageApi(database).maybeOne({
      kind: 'select',
      table: SCHEDULED_ASK_TABLE,
      columns: '*',
      where: [{ column: 'tenant_id', op: 'eq', value: String(tenantId) }],
    });
    return 'ready';
  } catch (error) {
    const code = /** @type {any} */ (error)?.code;
    if (code === '42P01') return 'missing';
    const message = String(/** @type {any} */ (error)?.message ?? '');
    if (/no such table/i.test(message)) return 'missing';
    if (code === 'STORAGE_UNAVAILABLE') return 'unreadable';
    throw error;
  }
}

export function registerScheduledAskHandlers(registry, composition) {
  const { database, tenantId } = composition;
  const now = typeof composition.clock === 'function' ? composition.clock : nowIso;
  // What `execute` opened, so the terminal transition can record it. It is only
  // an optimisation: a process that dies here retries, and opening an ask is
  // idempotent on its source key, so the ask is opened once either way.
  const opened = new Map();

  function decide(record, payload) {
    if (!record) return { outcome: 'unavailable' };
    // The instruction must still be the one this timer was given. A moved
    // consumer, content or instant is a different instruction, and this timer
    // has no authority to infer intent from it.
    if (record.fingerprint !== payload.fingerprint
      || scheduledAskFingerprint(record) !== record.fingerprint) return { outcome: 'superseded' };
    if (record.state === 'cancelled' || record.state === 'opened') return { outcome: record.state };
    return { outcome: record.kind === 'renewal-review' ? 'due' : 'open' };
  }

  function boundedPayload(job) {
    const payload = job?.payload;
    if (!payload || payload.contractVersion !== DOMAIN_TIMER_CONTRACT
      || typeof payload.askId !== 'string' || typeof payload.fingerprint !== 'string') {
      refuse('SCHEDULED_ASK_PAYLOAD_INVALID', 'scheduled ask identity is invalid', 500);
    }
    return payload;
  }

  registry.register({
    kind: JOB_KIND,
    name: HANDLER_NAME,
    version: 1,
    async execute({ job }) {
      const payload = boundedPayload(job);
      const record = await loadAsk(database, tenantId, payload.askId);
      const { outcome } = decide(record, payload);
      if (outcome === 'unavailable') {
        refuse('SCHEDULED_ASK_SOURCE_UNAVAILABLE', 'the scheduled ask no longer exists', 500);
      }
      if (outcome !== 'open') return { outcomeReference: `scheduled-ask:${payload.askId}:${outcome}` };

      const domains = composition.domains;
      if (!domains || typeof domains.capability !== 'function') {
        refuse('SCHEDULED_ASK_CAPABILITY_UNAVAILABLE', 'no package registry was composed for this timer', 500);
      }
      // The identity is the record's, never this timer's. `PackageRegistry`
      // re-proves it against that package's own declared requirements, so an
      // instruction naming a package that never declared the capability is
      // refused there rather than trusted here.
      // Awaited, and it must be: under packageContract 2 the registry wraps every
      // capability seam, so `capability()` hands back a promise. Read
      // synchronously it is an object with no `createFollowUp` on it, and this
      // handler refused every real v2 composition while passing against a
      // synchronous double. Integration found it; no unit test could.
      const seam = await domains.capability({
        consumer: record.consumerPackage,
        capability: record.capabilityName,
        version: record.capabilityVersion,
        context: { modules: composition.modules, actor: TIMER_ACTOR, now },
      });
      if (!seam || typeof seam.createFollowUp !== 'function') {
        refuse('SCHEDULED_ASK_CAPABILITY_INVALID', 'the named capability opens no follow-up', 500);
      }
      const result = await seam.createFollowUp({
        sourceKey: record.ask.sourceKey,
        title: record.ask.title,
        subject: { ...record.ask.subject },
        source: { package: record.consumerPackage, action: HANDLER_NAME },
      });
      const reference = result?.task?.id ?? result?.id ?? null;
      if (reference !== null) opened.set(job.id, String(reference));
      return { outcomeReference: `scheduled-ask:${record.id}:opened` };
    },
    /**
     * The state moves in the same transaction as the job's terminal transition,
     * on the handle that transaction owns: a settled timer whose instruction
     * still says `scheduled` is a pair this contract never produces.
     */
    async complete({ job, transaction }) {
      const payload = boundedPayload(job);
      const scoped = { storage: transaction };
      const record = await loadAsk(scoped, tenantId, payload.askId);
      const { outcome } = decide(record, payload);
      if (outcome !== 'open' && outcome !== 'due') return;
      const reference = opened.get(job.id) ?? null;
      opened.delete(job.id);
      await moveState(scoped, tenantId, record, outcome === 'due' ? 'due' : 'opened', now(),
        reference === null ? [] : [{ column: 'opened_reference', value: reference }]);
    },
  });
  return registry;
}

/**
 * The closed vocabulary of a scheduled ask, so a reader — or a truth probe —
 * learns what this contract is without reading its implementation.
 */
export function scheduledAskVocabulary() {
  return Object.freeze({
    contract: DOMAIN_TIMER_CONTRACT,
    kinds: SCHEDULED_ASK_KINDS,
    states: SCHEDULED_ASK_STATES,
    dialects: Object.freeze(['sqlite', 'postgresql']),
    jobKind: JOB_KIND,
    handler: HANDLER_NAME,
    // What a timer may never do, stated where it can be read rather than
    // inferred: it opens an ask and closes none.
    humanBoundary: 'scheduling requires a human actor; the timer opens an ask and decides nothing, and every closing action stays refused to it',
    autostart: false,
  });
}
