// @ts-check

import { createHash } from 'node:crypto';
import { AppError, normalizeActor } from '../../core/index.js';
import { buildCustomerDataActions } from './actions.js';
import { LIMITATIONS } from './operations.js';
import { deciding, resolvedNames, trusted } from './store.js';

/**
 * **Bulk application of this package's own human decisions (Customer Data
 * Operations v2).**
 *
 * One call applies one declared record action — link a candidate, dismiss a
 * candidate, or govern a quality issue — across many records, and reports per
 * record whether it applied. The three properties the backlog item demands:
 *
 * - **per-record receipts, partial reads partial.** Every item gets an
 *   outcome; a run that did not apply every item reads `partial`, never
 *   `completed`. A partial run is a result, not an error: the call succeeds
 *   and the failures are named.
 * - **one transaction per item.** A refusal on item 4 does not roll back
 *   items 1–3 and does not stop item 5: the operation cannot die halfway.
 * - **resumable, never silently reapplied.** The idempotency key is derived
 *   from the payload, so retrying the same bulk returns the same run; an
 *   interrupted run stays `in_progress` and a retry continues the items that
 *   have no applied receipt. An item applied by an earlier call is reported
 *   `already-applied` from its stored receipt, never executed twice.
 *
 * What this deliberately does NOT do: it does not reach the action runtime.
 * The ADR-032 operation seam hands an operation `{database, modules, events,
 * config, core}` and deliberately no action registry, no spine and no
 * workflow engine — a test freezes that key list — so the bulk runner
 * executes the package's own declared `execute` functions inside the same
 * per-item envelope the runtime would use (re-read inside the transaction,
 * the `fromStates` guard, buffered domain events), with the two boundaries
 * intact: the HTTP route gates `records.write` before this code runs, and
 * each action's own human-only check still refuses a non-user actor per
 * item. An agent caller therefore gets one `HUMAN_APPROVAL_REQUIRED`
 * receipt per item rather than one silent refusal for the batch.
 */

export const BULK_ACTIONS = Object.freeze([
  'link-canonical-identity',
  'dismiss-duplicate-candidate',
  'govern-data-quality-issue',
]);

/** The package's batch vocabulary is one vocabulary: the import bound. */
export const MAX_BULK_ITEMS = 500;

/**
 * Input validation against the action's own declared schema. The eligible
 * actions declare `string` and `enum` fields only; any other declared shape
 * fails closed here rather than passing unvalidated, with the same
 * trim/required/membership semantics the action runtime applies.
 *
 * @param {Array<{name?: string, type?: string, required?: boolean, values?: string[]}>} schema
 * @param {unknown} body
 */
export function validateBulkItemInput(schema, body) {
  const input = body ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new AppError('a bulk item needs an input object', {
      code: 'BULK_ITEM_INPUT_INVALID', status: 400, details: { field: 'input' },
    });
  }
  const out = {};
  for (const field of schema) {
    if (field.type !== 'string' && field.type !== 'enum') {
      throw new AppError(
        `bulk input cannot validate a "${field.type}" field, so this action is not bulk-eligible`,
        { code: 'BULK_ACTION_NOT_ELIGIBLE', status: 500, details: { field: field.name } },
      );
    }
    const raw = /** @type {Record<string, unknown>} */ (input)[/** @type {string} */ (field.name)];
    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (field.required) {
        throw new AppError(`${field.name} is required`, {
          code: 'BULK_ITEM_INPUT_INVALID', status: 400, details: { field: field.name },
        });
      }
      continue;
    }
    if (field.type === 'enum') {
      if (typeof raw !== 'string' || !(field.values ?? []).includes(raw)) {
        throw new AppError(`${field.name} must be one of: ${(field.values ?? []).join(', ')}`, {
          code: 'BULK_ITEM_INPUT_INVALID', status: 400, details: { field: field.name },
        });
      }
      out[/** @type {string} */ (field.name)] = raw;
      continue;
    }
    if (typeof raw !== 'string') {
      throw new AppError(`${field.name} must be a string`, {
        code: 'BULK_ITEM_INPUT_INVALID', status: 400, details: { field: field.name },
      });
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (field.required) {
        throw new AppError(`${field.name} is required`, {
          code: 'BULK_ITEM_INPUT_INVALID', status: 400, details: { field: field.name },
        });
      }
      continue;
    }
    out[/** @type {string} */ (field.name)] = trimmed;
  }
  return out;
}

/** One item's canonical digest — order-independent across the batch. */
function itemDigest(item) {
  const entries = Object.entries(item.input ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256')
    .update(JSON.stringify([item.recordId, entries]), 'utf8')
    .digest('hex');
}

/**
 * The business-derived idempotency key. Sorted item digests, so the same set
 * of items in a different order is the same bulk — and a different set is a
 * different key rather than an accidental adoption.
 */
export function bulkIdempotencyKeyFor({ action, items }) {
  const digests = items.map(itemDigest).sort();
  return createHash('sha256')
    .update(JSON.stringify(['customer-bulk', action, digests]), 'utf8')
    .digest('hex');
}

/**
 * Normalize and bound the request before anything else happens. Everything
 * refused here is refused before a transaction opens — including every
 * item's input, which is validated against the action's declared schema up
 * front so a malformed batch never half-applies.
 */
export function normalizeBulkRequest(request, declarations) {
  if (!request || typeof request !== 'object') {
    throw new AppError('a bulk action needs a request object', { code: 'BULK_REQUEST_INVALID', status: 400 });
  }
  const action = /** @type {any} */ (request).action;
  if (typeof action !== 'string' || !BULK_ACTIONS.includes(action)) {
    throw new AppError(
      `unknown bulk action: a bulk applies one of ${BULK_ACTIONS.join(', ')}`,
      { code: 'BULK_UNKNOWN_ACTION', status: 400, details: { field: 'action' } },
    );
  }
  const declaration = declarations.find((entry) => entry.name === action);
  if (!declaration) {
    throw new AppError(`bulk action "${action}" is not a declared action of this package`, {
      code: 'BULK_UNKNOWN_ACTION', status: 500, details: { field: 'action' },
    });
  }
  const items = /** @type {any} */ (request).items;
  if (!Array.isArray(items)) {
    throw new AppError('items must be an array', { code: 'BULK_REQUEST_INVALID', status: 400, details: { field: 'items' } });
  }
  if (items.length === 0) {
    throw new AppError('a bulk action needs at least one item', {
      code: 'BULK_REQUEST_INVALID', status: 400, details: { field: 'items' },
    });
  }
  if (items.length > MAX_BULK_ITEMS) {
    throw new AppError(`a bulk action is bounded to ${MAX_BULK_ITEMS} items`, {
      code: 'BULK_TOO_LARGE', status: 400, details: { field: 'items' },
    });
  }
  const normalized = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new AppError(`item ${index} must be an object with a recordId and an input`, {
        code: 'BULK_REQUEST_INVALID', status: 400, details: { field: `items[${index}]` },
      });
    }
    const recordId = /** @type {any} */ (item).recordId;
    if (typeof recordId !== 'string' || recordId.trim() === '') {
      throw new AppError(`item ${index} needs a record id`, {
        code: 'BULK_REQUEST_INVALID', status: 400, details: { field: `items[${index}].recordId` },
      });
    }
    return { index, recordId, input: validateBulkItemInput(declaration.input ?? [], /** @type {any} */ (item).input) };
  });
  return { action, declaration, items: normalized };
}

/**
 * @param {{
 *   database: any, modules: any, events: any, config?: Record<string, unknown>,
 *   core?: Record<string, Function>, policy?: any, names?: any,
 * }} handles
 */
export function createBulkRunner({ database, modules, events, config, core, policy, names: givenNames }) {
  if (!database || !modules || !events) {
    throw new AppError('customer-data bulk needs database, modules and events', {
      code: 'CUSTOMER_DATA_STORAGE_INVALID', status: 500,
    });
  }
  const names = givenNames ?? resolvedNames(config);
  const declarations = buildCustomerDataActions(config);
  const runs = () => trusted(modules, names.bulkRun);
  const receipts = () => trusted(modules, names.bulkItem);

  const summarize = ({ run, stored, idempotencyKey, replayed, action }) => {
    const byIndex = new Map(stored.map((row) => [row.itemIndex, row]));
    return Object.freeze({
      mode: 'apply',
      runId: run.id,
      action,
      idempotencyKey,
      replayed,
      status: run.status,
      counts: Object.freeze({
        items: run.itemCount,
        applied: run.appliedCount,
        failed: run.failedCount,
      }),
      receipts: Object.freeze(run.itemOrder.map((index) => {
        const row = byIndex.get(index);
        return Object.freeze({
          index,
          recordId: row.recordId,
          outcome: row.outcome === 'applied' && row.reportedFrom === 'resume' ? 'already-applied' : row.outcome,
          code: row.code,
          reason: row.reason,
        });
      })),
      limitations: LIMITATIONS,
    });
  };

  return {
    /**
     * Apply the bulk: brand-new, resumed, or replayed — never silently reapplied.
     * @param {any} request
     */
    async applyBulkAction(request) {
      const actor = normalizeActor(request?.actor);
      const { action, declaration, items } = normalizeBulkRequest(request, declarations);
      const idempotencyKey = bulkIdempotencyKeyFor({ action, items });
      const target = trusted(modules, declaration.module);

      const existing = (await runs().listWhere({ idempotencyKey }))[0] ?? null;
      if (existing && (existing.status === 'completed' || existing.status === 'partial')) {
        // The same bulk retried: the stored run IS the answer. Nothing runs
        // twice, and the caller is told it is looking at a replay.
        const stored = await deciding(receipts(), { runId: existing.id });
        return summarize({
          run: { ...existing, itemOrder: items.map((item) => item.index) },
          stored: stored.map((row) => ({ ...row, reportedFrom: 'replay' })),
          idempotencyKey, replayed: true, action,
        });
      }

      const now = new Date().toISOString();
      const run = existing ?? await runs().createManaged({
        sourceKey: `customer-bulk-run:${idempotencyKey}`,
        idempotencyKey,
        actionName: action,
        status: 'in_progress',
        itemCount: items.length,
        appliedCount: 0,
        failedCount: 0,
        actorType: actor.type,
        actorId: actor.id,
        startedAt: now,
        finishedAt: null,
      }, { actor });

      // Items applied by an earlier call of this same run are evidence, not
      // work: they are reported from the stored receipt and never executed
      // again. Failed items get their second chance below.
      const storedByIndex = new Map(
        (await deciding(receipts(), { runId: run.id }))
          .map((row) => [row.itemIndex, row]),
      );

      let applied = 0;
      let failed = 0;
      const reported = [];
      for (const item of items) {
        const previous = storedByIndex.get(item.index);
        if (previous && previous.outcome === 'applied') {
          applied += 1;
          reported.push({ ...previous, reportedFrom: 'resume' });
          continue;
        }
        // The item envelope mirrors the action runtime: the business writes
        // run inside one transaction, and the domain events buffered during
        // it are flushed only after that transaction commits. A subscriber
        // failure during the flush must NOT be reported as a business
        // failure — the caller would retry an item that already succeeded,
        // and the retry would meet the fromStates guard above rather than a
        // clean re-application. Policy (ADR-012): the item stays applied.
        const receipt = await events.buffered(async (outbox) => {
          try {
            const value = await database.transactionAsync(async () => {
              const record = await Promise.resolve(target.get(item.recordId));
              const stateField = declaration.stateField ?? 'status';
              const fromStates = declaration.fromStates;
              // The same guard the action runtime applies: a record that
              // already left the eligible states cannot be decided again,
              // and the bulk reports that per item instead of dying on it.
              // The shape matches the runtime's INVALID_STATE refusal
              // exactly.
              if (Array.isArray(fromStates) && !fromStates.includes(record[stateField])) {
                throw new AppError(
                  `${declaration.module}.${declaration.name} is not allowed from state "${record[stateField]}"`,
                  {
                    code: 'INVALID_STATE', status: 409,
                    details: { field: stateField, from: record[stateField], action: declaration.name },
                  },
                );
              }
              const steps = [];
              await Promise.resolve(declaration.execute({
                record,
                input: item.input,
                actor,
                modules,
                database,
                core: core ?? Object.freeze({}),
                pipelines: Object.freeze({ forModule: () => null, get: () => null, list: () => [] }),
                domains: Object.freeze({ getPolicy: () => { throw new AppError('Domain policy', { code: 'NOT_FOUND', status: 404 }); }, has: () => false }),
                config: config ?? {},
                now: () => now,
                managed: (id, patch) => target.applyManaged(id, patch, { actor }),
                step: (name, output) => steps.push({ name, status: 'completed', output }),
              }));
              return true;
            });
            try {
              await outbox.commit();
            } catch {
              // Dispatch failed after commit: the item stays applied.
            }
            return value;
          } catch (error) {
            return error;
          }
        });

        if (receipt === true) {
          applied += 1;
          const row = previous
            ? await receipts().applyManaged(previous.id, {
              outcome: 'applied', code: 'APPLIED', reason: `${action} applied`, decidedAt: now,
            }, { actor })
            : await receipts().createManaged({
              sourceKey: `customer-bulk-item:${run.id}:${item.index}`,
              runId: run.id,
              itemIndex: item.index,
              recordModule: declaration.module,
              recordId: item.recordId,
              outcome: 'applied',
              code: 'APPLIED',
              reason: `${action} applied`,
              decidedAt: now,
            }, { actor });
          reported.push({ ...row, reportedFrom: 'call' });
        } else {
          // The item's own transaction rolled back; the failure receipt is
          // recorded in a transaction of its own so the evidence survives
          // the business failure it describes.
          failed += 1;
          const code = typeof receipt?.code === 'string' && receipt.code !== '' ? receipt.code : 'BULK_ITEM_FAILED';
          const reason = typeof receipt?.message === 'string' && receipt.message !== ''
            ? receipt.message.slice(0, 500)
            : 'the item could not be applied';
          const row = previous
            ? await receipts().applyManaged(previous.id, { outcome: 'failed', code, reason, decidedAt: now }, { actor })
            : await receipts().createManaged({
              sourceKey: `customer-bulk-item:${run.id}:${item.index}`,
              runId: run.id,
              itemIndex: item.index,
              recordModule: declaration.module,
              recordId: item.recordId,
              outcome: 'failed',
              code,
              reason,
              decidedAt: now,
            }, { actor });
          reported.push({ ...row, reportedFrom: 'call' });
        }
      }

      // The run row finalizes in its own transaction, after every item: a
      // run that did not apply every item reads partial, never completed.
      const finished = await runs().applyManaged(run.id, {
        status: failed === 0 ? 'completed' : 'partial',
        appliedCount: applied,
        failedCount: failed,
        finishedAt: new Date().toISOString(),
      }, { actor });

      events.emit?.('customer-data.bulk.applied', {
        runId: run.id, action, status: finished.status,
        counts: { items: items.length, applied, failed },
      });

      return summarize({
        run: { ...finished, itemOrder: items.map((item) => item.index) },
        stored: reported,
        idempotencyKey, replayed: false, action,
      });
    },
  };
}
