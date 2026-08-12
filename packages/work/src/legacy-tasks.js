// @ts-check

import { AppError, ValidationError } from '../../core/index.js';
import { TASK_MODULE, normalizeWorkActor, resolveModule } from './follow-up.js';

/**
 * **The forward migration from the bespoke Lead Task slice.**
 *
 * Before Work v1 the B2B starter shipped its own `task` module over the table
 * `tasks`: `title`, `status` (`open`/`done`), `dueAt`, a **required** `leadId`
 * reference and a unique `sourceKey`, every field publicly writable.
 *
 * **Adoption was tried first and does not work.** Module Evolution (ADR-019) is
 * additive and forward-only — it adds fields, enum values and indexes. It
 * cannot drop a column, cannot relax `required`, and cannot rewrite a
 * `REFERENCES leads(id)` constraint. A generic subject cannot live in a column
 * that must name a lead, so adopting the module would mean either keeping every
 * task attached to a Lead (the defect Work exists to fix) or a destructive
 * migration (refused).
 *
 * So this is an **explicit forward migration**, and the old table is never
 * touched:
 *
 *   - `tasks` is not renamed, not altered and not dropped. Nothing in Work v1
 *     issues DDL against it, and an existing starter database still opens with
 *     every historical row readable.
 *   - Rows are **read** with a bounded `SELECT` and **written** through the
 *     `work-task` module's managed service, so the new rows carry the same
 *     validation, actor, audit and trace as any other managed write. The read is
 *     raw because the legacy module may no longer be composed at all — reading
 *     is not a mutation, and there is no service left to read through.
 *   - It is **dry-run by default**. `{ apply: true }` writes; anything else
 *     returns the plan and touches nothing.
 *   - It is **atomic**: the whole adoption runs in one transaction, so a run
 *     that is killed halfway leaves the database exactly as it found it rather
 *     than half-forward with a reported count nobody can trust.
 *   - It is **idempotent**: every adopted row is keyed `legacy-task:<id>`, so a
 *     second run adopts nothing twice. The legacy `sourceKey` is *reported* but
 *     not reused, because the new key namespace belongs to the caller's business
 *     identity and a historical key may not satisfy it.
 *
 * It is a function, not a command: it adds nothing to the agent surface budget,
 * and a project calls it once from its own code.
 */

const TABLE_RE = /^[a-z][a-z0-9_]*$/;
const STATUS_MAP = Object.freeze({ open: 'open', done: 'completed' });

/** @param {string} id */
export const legacyKey = (id) => `legacy-task:${id}`;

/**
 * @param {{database: any, modules: any, actor?: unknown, now?: () => string,
 *   table?: string, subjectResource?: string}} context
 * @param {{apply?: boolean}} [options]
 */
export async function migrateLegacyTasks(context, options = {}) {
  const table = context.table ?? 'tasks';
  if (!TABLE_RE.test(table)) throw new ValidationError('table must be a canonical table name', { field: 'table' });
  const subjectResource = context.subjectResource ?? 'lead';
  if (!/^[a-z][a-z0-9-]*$/.test(subjectResource)) {
    throw new ValidationError('subjectResource must be a canonical resource name', { field: 'subjectResource' });
  }
  const apply = options.apply === true;
  const service = resolveModule(context.modules, TASK_MODULE)?.service;
  if (!service?.createManaged) {
    throw new AppError(`The work package is installed without its "${TASK_MODULE}" records`, {
      code: 'WORK_STORAGE_INVALID', status: 500,
    });
  }
  const database = context.database;
  if (!database?.raw?.prepare) {
    throw new AppError('migrateLegacyTasks needs the application database handle', {
      code: 'WORK_MIGRATION_INVALID', status: 500,
    });
  }
  const exists = database.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) {
    return Object.freeze({
      workLegacyMigrationContract: 1, mode: apply ? 'apply' : 'dry-run', table,
      found: 0, adopted: 0, alreadyAdopted: 0, refused: [], legacySourceKeys: [],
      note: `no "${table}" table in this database; nothing to migrate`,
    });
  }

  // The column list is fixed and the table name is regex-bounded: nothing a
  // caller supplies is interpolated into the statement beyond that.
  const rows = database.raw
    .prepare(`SELECT id, title, status, due_at, lead_id, source_key, created_at FROM ${table} ORDER BY created_at, id`)
    .all();

  const refused = [];
  const plan = [];
  for (const row of rows) {
    const status = STATUS_MAP[String(row.status ?? '')];
    if (!status) {
      // Fail closed and name the row. Guessing a status would invent evidence.
      refused.push({ id: String(row.id), reason: 'UNMAPPED_STATUS', status: row.status ?? null });
      continue;
    }
    if (!row.lead_id) {
      refused.push({ id: String(row.id), reason: 'NO_SUBJECT', status: row.status ?? null });
      continue;
    }
    plan.push({ row, status, sourceKey: legacyKey(String(row.id)) });
  }

  const already = plan.filter((entry) => service.listWhere({ sourceKey: entry.sourceKey }).length > 0);
  const pending = plan.filter((entry) => !already.includes(entry));

  const report = {
    workLegacyMigrationContract: 1,
    mode: apply ? 'apply' : 'dry-run',
    table,
    found: rows.length,
    adopted: 0,
    alreadyAdopted: already.length,
    refused,
    legacySourceKeys: plan.map((entry) => entry.row.source_key ?? null),
  };
  if (!apply) return Object.freeze({ ...report, wouldAdopt: pending.length });

  const actor = context.actor;
  const who = normalizeWorkActor(actor);
  const now = typeof context.now === 'function' ? context.now : () => new Date().toISOString();
  // **One transaction for the whole adoption.** Row-at-a-time it was merely
  // idempotent: a crash halfway left a database that was neither the old shape
  // nor the new one, and an operator reading `adopted` from a killed run had no
  // way to know how far it got. Atomic *and* idempotent means a run adopted
  // everything it planned or nothing at all, and re-running after any failure
  // is always safe.
  await database.transactionAsync(async () => {
    for (const entry of pending) {
      await service.createManaged({
        sourceKey: entry.sourceKey,
        title: typeof entry.row.title === 'string' && entry.row.title.trim() !== '' ? entry.row.title : 'Follow up',
        status: entry.status,
        dueAt: entry.row.due_at ?? null,
        subjectResource,
        subjectId: String(entry.row.lead_id),
        subjectOwner: 'host',
        subjectOwnerPackage: null,
        subjectLabel: null,
        sourcePackage: 'host',
        sourceAction: 'qualify',
        openedByType: who.type,
        openedById: who.id,
        openedAt: entry.row.created_at ?? now(),
        // A migrated `done` task carries no completion actor or instant, because
        // the legacy row recorded neither. Inventing one would be inventing
        // evidence; an absent value is the honest answer.
        completedBy: null,
        completedAt: null,
        cancelledBy: null,
        cancelledAt: null,
        closingReason: null,
      }, { actor });
      report.adopted += 1;
    }
  });
  return Object.freeze(report);
}
