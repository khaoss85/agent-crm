// @ts-check

import { AppError, definePackage } from '../../core/index.js';
import {
  ACTIVITY_KINDS,
  ACTIVITY_MODULE,
  TASK_MODULE,
  TASK_OPEN,
  TASK_STATES,
  TASK_TERMINAL,
  TASK_TRANSITIONS,
  bounds,
  closingKey,
  createFollowUp,
  optionalSafeText,
  recordActivity,
  requireHumanActor,
  safeText,
  sortTimeline,
} from './follow-up.js';

/**
 * **Work v1 — tasks and activity evidence.**
 *
 * Two records and no more: a **Task** — a unit of human follow-up work arising
 * from a business event — and an **Activity** — an append-only, user-facing
 * entry on a subject's timeline. One capability, `follow-up@1`, lets a
 * consuming domain action create a deterministic follow-up inside its own
 * transaction.
 *
 * **Named `work` deliberately.** `tasks` describes half of it and `activities`
 * the other half; `engagement` would promise a channel that does not exist; and
 * `work-management` would promise planning, scheduling and capacity — which
 * would also collide with Delivery's shipped work packages and milestones.
 * `work` is the smallest noun covering both records, and it is bounded below
 * rather than by its name.
 *
 * **What it deliberately is not, and each is published in `metadata()`:** a
 * scheduler, reminders, calendar sync, email/SMS/WhatsApp, notifications,
 * authenticated or secure assignment, RBAC, a project-management suite, a
 * universal event bus, or a replacement for audit and trace.
 *
 * **Audit versus Activity.** Audit and trace stay the technical record of every
 * write; Activity is the curated semantic one, with a closed four-entry
 * vocabulary. Nothing here projects one into the other: the event bus dispatches
 * after commit (ADR-012), so a projection would either escape the originating
 * transaction or need Jobs/Outbox, which does not exist. Every Activity row is
 * written inside the transaction of the action that caused it.
 */

export const WORK_PACKAGE = 'work';
export const WORK_RESOURCES = Object.freeze([TASK_MODULE, ACTIVITY_MODULE]);
export const FOLLOW_UP_CAPABILITY = Object.freeze({ package: WORK_PACKAGE, capability: 'follow-up', version: 1 });

export {
  ACTIVITY_KINDS, ACTIVITY_MODULE, TASK_MODULE, TASK_OPEN, TASK_STATES,
  TASK_TERMINAL, TASK_TRANSITIONS, createFollowUp, sortTimeline,
};

/** @param {Record<string, string>} [moduleNames] */
function resolvedNames(moduleNames = {}) {
  return {
    task: moduleNames[TASK_MODULE] ?? TASK_MODULE,
    activity: moduleNames[ACTIVITY_MODULE] ?? ACTIVITY_MODULE,
  };
}

/** @param {any} modules @param {string} name */
function activityService(modules, name) {
  const service = modules?.get?.(name)?.service;
  if (!service?.createManaged) {
    throw new AppError(`The work package is installed without its "${name}" records`, {
      code: 'WORK_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/** The subject envelope as it was recorded on the task; never re-resolved. */
function subjectOf(record) {
  return { resource: record.subjectResource, id: record.subjectId };
}

/**
 * `complete` — the only way a task becomes `completed`.
 *
 * `fromStates: ['open']` is the transition table, enforced by the action
 * runtime before this code runs: a completed or cancelled task answers `409
 * INVALID_STATE` naming the state it is in. There is no reopen, so both
 * terminal states are genuinely terminal.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildCompleteTaskAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.task,
    name: 'complete',
    label: 'Complete task',
    description: 'Record that this follow-up work is done. A human decision; it notifies nobody and schedules nothing.',
    actionContract: 1,
    stateField: 'status',
    fromStates: [TASK_OPEN],
    toState: 'completed',
    input: [{ name: 'note', type: 'string', required: false, hint: 'Optional: what was done. Recorded on the timeline as text.' }],
    async execute({ record, input, actor, modules, managed, now }) {
      const completedBy = requireHumanActor(actor, 'Completing a task');
      const note = optionalSafeText(input.note, 'note', bounds.reason);
      const activities = activityService(modules, names.activity);
      const completedAt = now();
      const task = await managed(record.id, {
        status: 'completed',
        completedBy,
        completedAt,
        closingReason: note,
      });
      // Same transaction as the transition: a completed task without its
      // timeline entry is a pair this package never produces.
      const activity = await recordActivity({ activities, actor }, {
        sourceKey: closingKey(record.id, 'completed'),
        kind: 'task_completed',
        subject: subjectOf(record),
        taskId: record.id,
        body: note,
        occurredAt: completedAt,
        source: { package: WORK_PACKAGE, action: 'complete' },
      });
      return { task, activity };
    },
  };
}

/**
 * `cancel` — work that will not be done, with the reason on the record.
 *
 * Cancellation is not completion and the two are never collapsed: a cancelled
 * task is evidence that somebody decided the work was not needed, and reading
 * it as "done" would be wrong in the only direction that matters.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildCancelTaskAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.task,
    name: 'cancel',
    label: 'Cancel task',
    description: 'Record that this follow-up work will not be done, with a reason. A human decision; nothing is notified.',
    actionContract: 1,
    confirm: true,
    stateField: 'status',
    fromStates: [TASK_OPEN],
    toState: 'cancelled',
    input: [{ name: 'reason', type: 'string', required: true, hint: 'Why the work is not being done. Required.' }],
    async execute({ record, input, actor, modules, managed, now }) {
      const cancelledBy = requireHumanActor(actor, 'Cancelling a task');
      const reason = safeText(input.reason, 'reason', bounds.reason);
      const activities = activityService(modules, names.activity);
      const cancelledAt = now();
      const task = await managed(record.id, {
        status: 'cancelled',
        cancelledBy,
        cancelledAt,
        closingReason: reason,
      });
      const activity = await recordActivity({ activities, actor }, {
        sourceKey: closingKey(record.id, 'cancelled'),
        kind: 'task_cancelled',
        subject: subjectOf(record),
        taskId: record.id,
        body: reason,
        occurredAt: cancelledAt,
        source: { package: WORK_PACKAGE, action: 'cancel' },
      });
      return { task, activity };
    },
  };
}

/**
 * `add-note` — the one place a human writes free text into the timeline.
 *
 * It has **no `fromStates`**: a note on a closed task is legitimate — often it
 * is the explanation of why it closed the way it did — and refusing it would
 * make the timeline stop exactly where it becomes interesting.
 *
 * It carries **no source key**, deliberately: two identical notes are two
 * statements, not a duplicate, so there is nothing to deduplicate against. That
 * makes a retried note request a second note, which is stated as
 * `MANUAL_NOTES_ARE_NOT_IDEMPOTENT` rather than hidden behind a key that would
 * silently swallow the second one.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function buildAddNoteAction(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    module: names.task,
    name: 'add-note',
    label: 'Add note',
    description: 'Append a human note to this task\'s subject timeline. Safe text only; it is not sent anywhere.',
    actionContract: 1,
    input: [{ name: 'body', type: 'string', required: true, hint: 'The note. Plain text, at most 1000 characters.' }],
    async execute({ record, input, actor, modules, now }) {
      requireHumanActor(actor, 'Adding a note');
      const body = safeText(input.body, 'body', bounds.noteBody);
      const activities = activityService(modules, names.activity);
      const activity = await recordActivity({ activities, actor }, {
        sourceKey: null,
        kind: 'note',
        subject: subjectOf(record),
        taskId: record.id,
        body,
        occurredAt: now(),
        source: { package: WORK_PACKAGE, action: 'add-note' },
      });
      return { activity };
    },
  };
}

/**
 * `follow-up@1` — the declared capability, and the only automatic write path.
 *
 * It is created with the **caller's** runtime handles, so everything it writes
 * happens inside the caller's transaction. It returns a frozen object with two
 * methods and hands out no service, no table, no query handle and no mutable
 * state — there is nothing here a consumer could use to reach around the
 * contract.
 *
 * @param {Record<string, string>} [moduleNames]
 */
export function createFollowUpCapability(moduleNames) {
  const names = resolvedNames(moduleNames);
  return {
    name: FOLLOW_UP_CAPABILITY.capability,
    version: FOLLOW_UP_CAPABILITY.version,
    description:
      'Create exactly one deterministic follow-up task and its creation activity inside the caller\'s transaction, keyed by a business identity the caller supplies.',
    /**
     * @param {{modules: any, actor?: unknown, now?: () => string, consumer?: string}} context
     *   `consumer` is added by `PackageRegistry.capability()` from the identity
     *   it resolved and verified against that package's own declared
     *   `requires`. It **is** the provenance this capability records: a request
     *   asserting a different `source.package` is refused 403
     *   `WORK_SOURCE_PACKAGE_MISMATCH`, so a declared consumer cannot store
     *   another package's name on work it opened.
     */
    create(context) {
      const scoped = {
        ...context,
        modules: {
          get: (name) => context.modules.get(name === TASK_MODULE ? names.task : name === ACTIVITY_MODULE ? names.activity : name),
        },
      };
      return Object.freeze({
        /** @param {unknown} request */
        createFollowUp: (request) => createFollowUp(scoped, request),
        /**
         * Read the task a business identity already produced, exactly — never a
         * paged scan. A consumer that wants to know "did this already happen?"
         * asks this rather than listing.
         * @param {string} sourceKey
         */
        findBySourceKey(sourceKey) {
          const service = context.modules?.get?.(names.task)?.service;
          if (!service?.listWhere) {
            throw new AppError(`The work package is installed without its "${names.task}" records`, {
              code: 'WORK_STORAGE_INVALID', status: 500,
            });
          }
          return service.listWhere({ sourceKey: String(sourceKey) })[0] ?? null;
        },
      });
    },
  };
}

/** @param {{modules?: Record<string, string>}} [options] */
export function createWorkPackage(options = {}) {
  return definePackage({
    packageContract: 1,
    name: WORK_PACKAGE,
    version: 1,
    label: 'Work items and activity evidence',
    description:
      'Owns follow-up tasks and an append-only user-facing activity timeline, and offers one capability so a domain action can create a deterministic follow-up inside its own transaction. It schedules nothing, reminds nobody and assigns to nobody.',
    resources: [...WORK_RESOURCES],
    // Nothing. Work is consumed, never a consumer, so no composition that adds
    // it can create a dependency cycle.
    requires: [],
    capabilities: [createFollowUpCapability(options.modules)],
    actions: [
      buildCompleteTaskAction(options.modules),
      buildCancelTaskAction(options.modules),
      buildAddNoteAction(options.modules),
    ],
    // None. A versioned policy earns its fingerprint when two consumers share a
    // rule; these two share none — one wants a lead's name and a due date, the
    // other a contract intent and no date. See ADR-030.
    policies: [],
    metadata() {
      return {
        workContract: 1,
        task: {
          states: [...TASK_STATES],
          open: TASK_OPEN,
          terminal: [...TASK_TERMINAL],
          transitions: { open: [...TASK_TRANSITIONS.open], completed: [], cancelled: [] },
          reopen:
            'not supported in v1. A repeated business round is a new task under a new source key; un-completing work would need a second lifecycle nothing here has',
          dueAt:
            'evidence only. Nothing schedules on it, nothing fires from it, and no clock changes a status because of it. A read-only due/overdue may be computed at an injected instant and never writes. It must still name a day that existed: an impossible date is refused rather than rolled over to the next real one (ADR-028)',
          assignment:
            'there is no assignee field. This package does not model assignment, ownership or routing, and nothing here is secure assignment',
        },
        activity: {
          kinds: [...ACTIVITY_KINDS],
          appendOnly: 'no action in this package updates or deletes an activity, and the module has no public write path',
          order:
            'a timeline is read oldest-first by occurredAt, compared by code point and never by host locale collation, so the order does not depend on the machine, the ICU build or LANG. TIMELINE_ORDER_TIES_ARE_ARBITRARY — entries recorded at the same instant have no business order and are broken by created stamp then id, purely so two readers see the same list',
          versusAudit:
            'audit and trace stay the technical record of every write; this is the curated user-facing one with a closed vocabulary. Nothing projects one into the other, and there is no asynchronous projection engine',
          content:
            'the only free text is a note body, bounded and control-character-free. No provider payload, attachment, email body or chat message is stored',
        },
        subject: {
          shape: ['subjectResource', 'subjectId', 'subjectOwner', 'subjectOwnerPackage', 'subjectLabel'],
          owner: ['host', 'package'],
          provenance: ['sourcePackage', 'sourceAction'],
          referentialIntegrity:
            'SQLite cannot enforce a foreign key whose target table varies per row, and this package does not pretend it can. The domain action that owns the source record proves it exists and creates the task in the same transaction; nothing prevents that record being deleted afterwards, and a task whose subject is gone still reads as a task',
          label: 'subjectLabel is a display snapshot taken at creation. It is never refreshed and may be stale',
        },
        capability: {
          name: `${FOLLOW_UP_CAPABILITY.capability}@${FOLLOW_UP_CAPABILITY.version}`,
          transaction:
            'created with the caller\'s modules handle, so both rows commit or roll back with the caller\'s own writes. Verified rather than assumed: a call that cannot prove an open transaction on that connection is refused 500 WORK_TRANSACTION_REQUIRED before the first write, so no half pair can be produced by calling it from a script or outside an action',
          hostLimitation:
            'HOST_ACTIONS_CANNOT_DECLARE_CAPABILITIES — PackageRegistry.capability() resolves consumer against registered packages, so a host application action cannot open this capability. The host composes the same exported creator directly from project source; it is the same code, not a second path',
          sourcePackageIsBound:
            'source.package is no longer free caller text repeated in the payload: the registry hands the consumer identity it resolved to the provider, that identity is what is stored, and a request asserting anything else is refused 403 WORK_SOURCE_PACKAGE_MISMATCH. A direct host caller has no package identity and may only assert "host"',
          bindingLimitation:
            'NOT authentication, and it is not claimed to be. PackageRegistry.capability() checks that the named consumer is a registered package which itself declared work/follow-up@1 — it cannot tell which package\'s code is executing (ADR-018 addendum 4: the consumer name is asserted by the caller). So the floor this raises is from "any package name at all" to "a package that also declared this capability", which is a real narrowing and not a boundary. Trusted checked-in source remains the security model',
          stillAsserted:
            'source.action and subject.ownerPackage remain caller-asserted with no registry knowledge behind them: the registry does not know which of a package\'s actions is calling, and a subject may legitimately be owned by a third package',
        },
        humanApproval:
          'complete, cancel and add-note require actor.type === "user"; an agent actor is refused 403 HUMAN_APPROVAL_REQUIRED. A human-actor boundary, not RBAC and not authentication',
        idempotency: {
          followUp:
            'the caller supplies a business source key. Same key and same payload returns the existing task and its creation activity; same key with any different semantic field is refused 409 WORK_FOLLOW_UP_CONFLICT naming the fields that differ. A new business round uses a new key and creates a new task',
          semanticIdentity: [
            'title', 'dueAt', 'subjectResource', 'subjectId', 'subjectOwner', 'subjectOwnerPackage',
            'sourcePackage', 'sourceAction',
          ],
          presentationSnapshot:
            'subjectLabel only. It is a display snapshot taken at creation, stated as non-authoritative, so a replay whose ONLY difference is a renamed subject is honoured rather than refused. Every other stored fact is identity',
          clock:
            'Work applies NO clock heuristic to a source key: it cannot tell a moving key from a stable 13-digit customer id, a provider event id or a business event whose scheduled instant is part of its identity, and refusing those was a false restriction. Key stability is the caller\'s guarantee, derived from a committed record id and proven by that consumer\'s own retry test',
          notes: 'MANUAL_NOTES_ARE_NOT_IDEMPOTENT — a note carries no key, because two identical notes are two statements',
        },
        wording: {
          recorded: ['follow-up task opened', 'task completed', 'task cancelled', 'note recorded'],
          neverClaimed: ['reminded', 'notified', 'scheduled', 'assigned', 'emailed', 'escalated', 'due today'],
        },
        notModeled: [
          'scheduler', 'reminders', 'due-date alerts', 'recurring or repeating work',
          'calendar sync', 'meetings and calls', 'email', 'SMS', 'WhatsApp', 'chat',
          'notifications', 'assignment', 'ownership', 'workload or capacity', 'RBAC',
          'subtasks', 'dependencies', 'projects', 'attachments', 'file storage',
          'a unified cross-domain timeline', 'a job queue', 'delayed workflows',
        ],
        limitation:
          'Work v1 records human follow-up work and what happened to it. Nothing in it runs on a timer, sends anything, or tells anybody. A task is only ever moved by a person.',
      };
    },
  });
}

export default createWorkPackage;
