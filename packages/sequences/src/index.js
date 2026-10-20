// @ts-check

import {
  AppError,
  ConflictError,
  definePackage,
  nowIso,
  selectPackageGraph,
  ValidationError,
} from '../../core/index.js';
// No import from any other domain package. What the sweep sends through
// arrives as the composition-provided `queueTemplate` seam (the channels
// outbox enqueue, same as every channel send), and what it gates on arrives
// as the created `space-permission-gate@1` capability object handed to this
// factory at the composition site.
import {
  advanceSequences,
  checkRecordKey,
  checkSpaceId,
  checkStepInput,
  computeSequenceMetrics,
  enrollSequencePerson,
  requireSequenceActor,
  sequenceKey,
  transitionEnrollment,
  transitionSequence,
} from './sequences.js';

/**
 * The Sequences domain package (BO-F3-03 — backoffice "10 Sequenze",
 * backlog:22bb154a72ea).
 *
 * One space's follow-up sequences: an ordered list of day+channel steps with
 * personalized templates, a trigger that enrolls people, and an automatic
 * stop at the first recorded reply. Above `packages/work` (the timer beats
 * the advance, like the appointment reminder sweep) and `packages/channels`
 * (the outbox the steps queue into, the inbox the stop reads) — reused,
 * never duplicated (MEM_ACC_REUSE).
 *
 * Fail-closed throughout: without the `send-without-approval` permission a
 * due step becomes a human-decided approval proposal and waits — the
 * provider sees nothing until a person approves; without the template queue
 * or the reply window the advance refuses instead of sending blind; a
 * paused sequence or enrollment fires nothing; metrics are counted from
 * rows, never stored.
 *
 * What is deliberately NOT here: the HTTP/backoffice UI (the pilot owns it),
 * provider sends (the channels outbox owns them), AI text rewriting (the
 * `personalize` hook is the seam a deployment plugs an intelligence
 * provider into; the built-in substitution is deterministic), and stored
 * counters.
 */

export const SEQUENCES_DOMAIN = 'sequences';

/** The record modules this package owns. A second claimant is a startup collision. */
export const SEQUENCES_RESOURCES = Object.freeze([
  'sequence', 'sequence-step', 'sequence-enrollment', 'sequence-send',
]);

const SEQUENCES_REQUIRES = Object.freeze([
  { package: 'space-permissions', capability: 'space-permission-gate', version: 1 },
]);

/** Managed-record handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.createManaged !== 'function' || typeof service.applyManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a managed record module — apply its manifest first`, {
      code: 'SEQUENCES_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

function isWinnerConflict(error) {
  if (error instanceof ConflictError) return true;
  if (error instanceof Error) {
    if (error.message.includes('UNIQUE constraint failed')) return true;
    if (error.message.includes('duplicate key value violates unique constraint')) return true;
  }
  if (error !== null && typeof error === 'object') {
    const code = /** @type {any} */ (error).code;
    if (code === '23505' || code === 'SQLITE_CONSTRAINT_UNIQUE') return true;
  }
  return false;
}

/**
 * @param {{
 *   spacePermissions?: { capabilities?: Array<any> },
 *   queueTemplate?: (params: any) => Promise<any>,
 *   replyWindows?: Record<string, any>,
 *   personalize?: ((input: any) => Promise<string[]> | string[]) | null,
 * }} [options]
 *   `spacePermissions` is the composed space-permissions package definition;
 *   the gate is opened from its own created capability, so name resolution
 *   stays the provider's. `queueTemplate` is the bound channels
 *   `queueTemplateSend` (same durable enqueue as every channel send).
 *   `replyWindows` maps a connection key (or channel) to the adapter's
 *   `outboundWindow` (`subjectForRecipient`/`isObservation`); without the
 *   window for a connection the enrollment is recorded blind
 *   (`SEQUENCES_WINDOW_MISSING`) and never fires — fail closed, never a
 *   raw-recipient match.
 *   `personalize` optionally rewrites the substituted variables (the AI
 *   seam); without it the deterministic substitution stands.
 */
export function createSequencesPackage(options = {}) {
  const { queueTemplate = null, replyWindows = {}, personalize = null } = options;
  if (queueTemplate !== null && typeof queueTemplate !== 'function') {
    throw new ValidationError('sequences queueTemplate must be a function', { field: 'queueTemplate' });
  }
  if (personalize !== null && personalize !== undefined && typeof personalize !== 'function') {
    throw new ValidationError('sequences personalize must be a function', { field: 'personalize' });
  }
  const gateOffered = Array.isArray(options.spacePermissions?.capabilities)
    ? options.spacePermissions.capabilities.find((entry) => entry?.name === 'space-permission-gate' && entry?.version === 1) ?? null
    : null;

  const openGate = (modules) => {
    if (!gateOffered || typeof gateOffered.create !== 'function') {
      throw new AppError(
        'The sequences package requires the space-permissions package capability space-permission-gate@1: '
        + 'compose it with the provider definition, e.g. createSequencesPackage({ spacePermissions }) '
        + 'beside createSpacePermissionsDomain()',
        { code: 'PACKAGE_DEPENDENCY_MISSING', status: 409 },
      );
    }
    return gateOffered.create({ modules, consumer: SEQUENCES_DOMAIN, now: () => nowIso() });
  };

  /** Fetch the sequence row of this space, or refuse another space's row. */
  const loadSequence = async (modules, spaceId, sourceKey) => {
    const rows = await trusted(modules, 'sequence').listWhere({ spaceId, sourceKey });
    const sequence = rows[0] ?? null;
    if (!sequence) {
      throw new AppError('Unknown sequence in this space', { code: 'SEQUENCE_UNKNOWN', status: 404 });
    }
    return sequence;
  };

  /** Steps of one sequence, order-ascending. */
  const loadSteps = async (modules, sequenceSourceKey) => (await trusted(modules, 'sequence-step')
    .listWhere({ sequenceSourceKey }))
    .filter((row) => row && Number.isInteger(row.stepOrder))
    .sort((a, b) => a.stepOrder - b.stepOrder);

  const graph = definePackage({
    packageContract: 1,
    name: SEQUENCES_DOMAIN,
    // 1: BO-F3-03 — sequences with reply stop, fail-closed permission,
    // pause/resume without doubles, metrics counted from records.
    version: 1,
    label: 'Follow-up sequences',
    description:
      'Follow-up sequences with reply stop and human approval: ordered day+channel steps with personalized '
      + 'templates over the channels outbox, per-person states, pause and resume without double sends, and '
      + 'metrics counted from records. Sends nothing without the space send permission.',
    resources: [...SEQUENCES_RESOURCES],
    requires: [...SEQUENCES_REQUIRES],
    capabilities: [],
    actions: [],
    operations: [
      {
        operationContract: 1,
        name: 'create-sequence',
        appMethod: 'createSequence',
        label: 'Create a follow-up sequence',
        description:
          'Create a draft sequence with its ordered day+channel steps. Idempotent by the caller-supplied '
          + 'source key: a retry replays the stored sequence and steps.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id — always explicit, never inferred.' },
          { name: 'sourceKey', type: 'string', hint: 'Caller-supplied idempotency identity for the sequence.' },
          { name: 'name', type: 'string', hint: 'The human-readable sequence name.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const actor = requireSequenceActor(record.actor, 'Creating a sequence');
            const spaceId = checkSpaceId(record.spaceId);
            const sourceKey = checkRecordKey(record.sourceKey, 'sourceKey');
            const name = typeof record.name === 'string' && record.name.trim() !== '' && record.name.length <= 200
              ? record.name.trim()
              : (() => { throw new ValidationError('name must be bounded single-line text', { field: 'name' }); })();
            const rawSteps = Array.isArray(record.steps) ? record.steps : [];
            if (rawSteps.length === 0 || rawSteps.length > 32) {
              throw new ValidationError('a sequence needs 1 to 32 ordered steps', { field: 'steps' });
            }
            const at = nowIso();
            const sequences = trusted(runtime.modules, 'sequence');
            const checked = rawSteps.map((step, index) => checkStepInput(step, index));
            let sequence = (await sequences.listWhere({ spaceId, sourceKey }))[0] ?? null;
            let replayed = sequence !== null;
            if (!sequence) {
              try {
                sequence = await sequences.createManaged({
                  sourceKey, spaceId, name, status: 'draft',
                  decidedAt: at,
                  actorType: actor.type, actorId: actor.id,
                  sourcePackage: SEQUENCES_DOMAIN, sourceAction: 'create-sequence',
                }, { actor });
              } catch (error) {
                if (!isWinnerConflict(error)) throw error;
                sequence = (await sequences.listWhere({ spaceId, sourceKey }))[0] ?? null;
                if (!sequence) throw error;
                replayed = true;
              }
            }
            // An interrupted first attempt leaves the sequence row with only
            // some step rows: the retry carries the same payload under the
            // same key, so every missing deterministic step row is created
            // now instead of activating a truncated workflow later.
            const stepService = trusted(runtime.modules, 'sequence-step');
            const stored = [];
            for (const step of checked) {
              const stepKey = sequenceKey('seq-step', sourceKey, String(step.stepOrder));
              const found = await stepService.listWhere({ sourceKey: stepKey });
              if (found[0]) {
                stored.push(found[0]);
                continue;
              }
              try {
                stored.push(await stepService.createManaged({
                  sourceKey: stepKey,
                  sequenceSourceKey: sourceKey,
                  stepOrder: step.stepOrder,
                  dayOffset: step.dayOffset,
                  channel: step.channel,
                  templateName: step.templateName,
                  templateLanguage: step.templateLanguage,
                  templateVars: step.templateVars,
                  actorType: actor.type, actorId: actor.id,
                }, { actor }));
              } catch (error) {
                if (!isWinnerConflict(error)) throw error;
                const winner = await stepService.listWhere({ sourceKey: stepKey });
                if (winner[0]) stored.push(winner[0]);
              }
            }
            return {
              sequence,
              steps: stored.sort((a, b) => a.stepOrder - b.stepOrder),
              replayed,
            };
          };
        },
      },
      {
        operationContract: 1,
        name: 'add-sequence-step',
        appMethod: 'addSequenceStep',
        label: 'Append a step to a draft sequence',
        description:
          'Append one ordered day+channel step to a draft sequence; an active or paused sequence refuses, '
          + 'so a running person never sees a step change under them.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
          { name: 'sourceKey', type: 'string', hint: 'The sequence source key.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const actor = requireSequenceActor(record.actor, 'Adding a sequence step');
            const spaceId = checkSpaceId(record.spaceId);
            const sequence = await loadSequence(runtime.modules, spaceId, record.sourceKey);
            if (sequence.status !== 'draft') {
              throw new AppError(`Sequence is ${sequence.status}: steps change only in draft`, {
                code: 'SEQUENCE_NOT_DRAFT', status: 409,
              });
            }
            const existing = await loadSteps(runtime.modules, sequence.sourceKey);
            const checked = checkStepInput(record.step ?? {}, existing.length);
            const stepService = trusted(runtime.modules, 'sequence-step');
            const stepKey = sequenceKey('seq-step', sequence.sourceKey, String(checked.stepOrder));
            try {
              const step = await stepService.createManaged({
                sourceKey: stepKey,
                sequenceSourceKey: sequence.sourceKey,
                stepOrder: checked.stepOrder,
                dayOffset: checked.dayOffset,
                channel: checked.channel,
                templateName: checked.templateName,
                templateLanguage: checked.templateLanguage,
                templateVars: checked.templateVars,
                actorType: actor.type,
                actorId: actor.id,
              }, { actor });
              return { step, replayed: false };
            } catch (error) {
              if (!isWinnerConflict(error)) throw error;
              const winner = await stepService.listWhere({ sourceKey: stepKey });
              return { step: winner[0] ?? null, replayed: true };
            }
          };
        },
      },
      {
        operationContract: 1,
        name: 'activate-sequence',
        appMethod: 'activateSequence',
        label: 'Activate a draft sequence',
        description: 'Move a draft (or paused) sequence to active so its steps can fire.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
          { name: 'sourceKey', type: 'string', hint: 'The sequence source key.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const actor = requireSequenceActor(record.actor, 'Activating a sequence');
            const sequence = await loadSequence(runtime.modules, checkSpaceId(record.spaceId), record.sourceKey);
            const at = nowIso();
            return transitionSequence({
              sequences: trusted(runtime.modules, 'sequence'),
              sequence, event: 'activate', at, actor,
            });
          };
        },
      },
      {
        operationContract: 1,
        name: 'pause-sequence',
        appMethod: 'pauseSequence',
        label: 'Pause a sequence',
        description: 'Pause an active sequence: no step of any enrollment fires while paused.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
          { name: 'sourceKey', type: 'string', hint: 'The sequence source key.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const actor = requireSequenceActor(record.actor, 'Pausing a sequence');
            const sequence = await loadSequence(runtime.modules, checkSpaceId(record.spaceId), record.sourceKey);
            return transitionSequence({
              sequences: trusted(runtime.modules, 'sequence'),
              sequence, event: 'pause', at: nowIso(), actor,
            });
          };
        },
      },
      {
        operationContract: 1,
        name: 'resume-sequence',
        appMethod: 'resumeSequence',
        label: 'Resume a paused sequence',
        description: 'Resume a paused sequence: due steps fire on the next advance, never twice.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
          { name: 'sourceKey', type: 'string', hint: 'The sequence source key.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const actor = requireSequenceActor(record.actor, 'Resuming a sequence');
            const sequence = await loadSequence(runtime.modules, checkSpaceId(record.spaceId), record.sourceKey);
            return transitionSequence({
              sequences: trusted(runtime.modules, 'sequence'),
              sequence, event: 'resume', at: nowIso(), actor,
            });
          };
        },
      },
      {
        operationContract: 1,
        name: 'enroll-sequence-person',
        appMethod: 'enrollSequencePerson',
        label: 'Enroll a person in a sequence',
        description:
          'Enroll one person in an active sequence: their own state, due from the first step. '
          + 'Idempotent by enrollment key: a retry replays the stored enrollment.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
          { name: 'sequenceSourceKey', type: 'string', hint: 'The sequence source key.' },
        ],
        create(runtime) {
          return async (request) => enrollSequencePerson({ modules: runtime.modules, input: request ?? {}, at: nowIso() });
        },
      },
      {
        operationContract: 1,
        name: 'pause-sequence-enrollment',
        appMethod: 'pauseSequenceEnrollment',
        label: 'Pause one enrollment',
        description: 'Pause one person: their steps stop firing while paused; nothing already queued is withdrawn.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
          { name: 'enrollmentSourceKey', type: 'string', hint: 'The enrollment source key.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const actor = requireSequenceActor(record.actor, 'Pausing an enrollment');
            const spaceId = checkSpaceId(record.spaceId);
            const key = typeof record.enrollmentSourceKey === 'string' ? record.enrollmentSourceKey : '';
            const rows = await trusted(runtime.modules, 'sequence-enrollment').listWhere({ spaceId, sourceKey: key });
            if (!rows[0]) {
              throw new AppError('Unknown sequence enrollment in this space', { code: 'SEQUENCE_ENROLLMENT_UNKNOWN', status: 404 });
            }
            return transitionEnrollment({
              enrollments: trusted(runtime.modules, 'sequence-enrollment'),
              enrollment: rows[0], event: 'pause', at: nowIso(), actor, spaceId,
            });
          };
        },
      },
      {
        operationContract: 1,
        name: 'resume-sequence-enrollment',
        appMethod: 'resumeSequenceEnrollment',
        label: 'Resume one enrollment',
        description:
          'Resume a paused person: overdue steps fire on the next advance, steps already queued or sent never fire twice.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
          { name: 'enrollmentSourceKey', type: 'string', hint: 'The enrollment source key.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const actor = requireSequenceActor(record.actor, 'Resuming an enrollment');
            const spaceId = checkSpaceId(record.spaceId);
            const key = typeof record.enrollmentSourceKey === 'string' ? record.enrollmentSourceKey : '';
            const rows = await trusted(runtime.modules, 'sequence-enrollment').listWhere({ spaceId, sourceKey: key });
            if (!rows[0]) {
              throw new AppError('Unknown sequence enrollment in this space', { code: 'SEQUENCE_ENROLLMENT_UNKNOWN', status: 404 });
            }
            return transitionEnrollment({
              enrollments: trusted(runtime.modules, 'sequence-enrollment'),
              enrollment: rows[0], event: 'resume', at: nowIso(), actor, resumeNow: true, spaceId,
            });
          };
        },
      },
      {
        operationContract: 1,
        name: 'advance-sequences',
        appMethod: 'advanceSequences',
        label: 'Advance due sequence steps',
        description:
          'Fire every due step of every active sequence: reply stop, permission gate, outbox queue, then '
          + 'confirm. The deployment beats this on its own interval.',
        input: [],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const actor = record.actor ?? { type: 'system', id: 'sequence-sweep' };
            return advanceSequences({
              modules: runtime.modules,
              queueTemplate,
              permissionGate: openGate(runtime.modules),
              replyWindows,
              now: () => nowIso(),
              actor,
              personalize,
            });
          };
        },
      },
      {
        operationContract: 1,
        name: 'read-sequence-metrics',
        appMethod: 'readSequenceMetrics',
        label: 'Read sequence metrics',
        description:
          'Count-only metrics of one sequence from its enrollment and send rows: people by state and fires by step.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
          { name: 'sourceKey', type: 'string', hint: 'The sequence source key.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const sequence = await loadSequence(runtime.modules, checkSpaceId(record.spaceId), record.sourceKey);
            const enrollments = await trusted(runtime.modules, 'sequence-enrollment')
              .listWhere({ sequenceSourceKey: sequence.sourceKey });
            const sends = await trusted(runtime.modules, 'sequence-send')
              .listWhere({ sequenceSourceKey: sequence.sourceKey });
            return {
              sequence: { sourceKey: sequence.sourceKey, name: sequence.name, status: sequence.status },
              ...computeSequenceMetrics({ enrollments, sends }),
            };
          };
        },
      },
      {
        operationContract: 1,
        name: 'list-sequences',
        appMethod: 'listSequences',
        label: 'List sequences with state and metrics',
        description: 'Every sequence of one space with its status and its counted metrics (the backoffice elenco).',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id.' },
        ],
        create(runtime) {
          return async (request) => {
            const record = request && typeof request === 'object' ? request : {};
            const spaceId = typeof record.spaceId === 'string' ? record.spaceId.trim() : '';
            if (spaceId === '') {
              throw new ValidationError('spaceId must be a non-empty id', { field: 'spaceId' });
            }
            const rows = await trusted(runtime.modules, 'sequence').listWhere({ spaceId });
            const enrollments = trusted(runtime.modules, 'sequence-enrollment');
            const sends = trusted(runtime.modules, 'sequence-send');
            const out = [];
            for (const sequence of rows) {
              const people = await enrollments.listWhere({ sequenceSourceKey: sequence.sourceKey });
              const fires = await sends.listWhere({ sequenceSourceKey: sequence.sourceKey });
              out.push({
                sourceKey: sequence.sourceKey,
                name: sequence.name,
                status: sequence.status,
                ...computeSequenceMetrics({ enrollments: people, sends: fires }),
              });
            }
            return Object.freeze(out.sort((a, b) => (a.sourceKey < b.sourceKey ? -1 : 1)));
          };
        },
      },
    ],
    policies: [],
    /** Function-free, additive schema metadata. */
    metadata() {
      return {
        resources: [...SEQUENCES_RESOURCES],
        notModeled: [
          'provider sends: the channels outbox owns them; this package only queues',
          'AI text rewriting: the personalize hook is the seam; the built-in substitution is deterministic',
          'backoffice UI: the pilot owns the elenco rendering; list-sequences serves its rows',
        ],
      };
    },
  });

  // Distinct awaited contract-2 graph. Existing `createSequencesPackage()` callers keep v1.
  return selectPackageGraph(graph, options.packageContract === 2 ? 2 : 1);
}

/** The records this package owns (re-exported for the composition that applies manifests). */
export {
  SEQUENCE_SEND_PERMISSION,
  advanceSequences,
  computeSequenceMetrics,
  findReply,
  personalizeVars,
  sequenceKey,
  sequenceMessageKey,
} from './sequences.js';
