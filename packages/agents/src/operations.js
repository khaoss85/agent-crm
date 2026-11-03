// @ts-check

import { AppError, ConflictError, nowIso } from '../../core/index.js';
import {
  AGENTS_DOMAIN,
  AGENT_APPLY_PERMISSION,
  AGENT_CLAIM_LEASE_MS,
  AGENT_TIMER_ACTOR,
  RUN_TERMINAL,
  agentRunKey,
  assertAgentTransition,
  assertAssignmentTransition,
  assertRunTransition,
  checkAgentInput,
  checkAssignmentInput,
  checkCostCents,
  checkExecuteResult,
  checkSchedulePlan,
  checkSpaceId,
  computeNextRun,
  monthStartIso,
  parsePhraseSchedule,
  requireAgentActor,
  requireCostEstimate,
  requireHumanActor,
  sanitizeFailure,
  spentSince,
} from './agents.js';

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

/** Managed-record handle; a CRUD-writable module is refused. */
function trusted(modules, name) {
  const service = modules.get(name)?.service;
  if (!service || typeof service.createManaged !== 'function' || typeof service.applyManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a managed record module — apply its manifest first`, {
      code: 'AGENTS_STORAGE_INVALID', status: 500,
    });
  }
  return service;
}

/**
 * Teammate-agent operations over real sqlite record services.
 *
 * @param {{
 *   modules: Map<string, { service: any }>,
 *   now?: () => string,
 *   permissionGate?: null | { verdict: (input: any) => Promise<any> | any },
 * }} options
 *   `now` is the clock (tests pin it). `permissionGate` is the optional
 *   space-permissions gate: when provided, approving a run also needs its
 *   allow verdict for `agent-action-apply`; the human-actor rule applies
 *   either way.
 */
export function createAgentOperations(options = {}) {
  const modules = options.modules;
  if (!modules || typeof modules.get !== 'function') {
    throw new AppError('Agent operations need the composed record modules', {
      code: 'AGENTS_MODULES_MISSING', status: 500,
    });
  }
  const now = typeof options.now === 'function' ? options.now : () => nowIso();
  const permissionGate = options.permissionGate ?? null;
  if (permissionGate !== null && typeof permissionGate.verdict !== 'function') {
    throw new AppError('Agent permissionGate must expose verdict(input)', {
      code: 'AGENTS_GATE_INVALID', status: 500,
    });
  }

  const agents = () => trusted(modules, 'teammate-agent');
  const assignments = () => trusted(modules, 'teammate-assignment');
  const runs = () => trusted(modules, 'teammate-run');

  async function loadAgent(spaceId, agentSourceKey) {
    const row = (await agents().listWhere({ spaceId, sourceKey: agentSourceKey }))[0] ?? null;
    if (!row) {
      throw new AppError('Unknown agent in this space', { code: 'AGENT_UNKNOWN', status: 404 });
    }
    return row;
  }

  async function loadAssignment(spaceId, assignmentSourceKey) {
    const row = (await assignments().listWhere({ spaceId, sourceKey: assignmentSourceKey }))[0] ?? null;
    if (!row) {
      throw new AppError('Unknown assignment in this space', { code: 'AGENT_ASSIGNMENT_UNKNOWN', status: 404 });
    }
    return row;
  }

  async function monthSpent(spaceId, agentSourceKey, at) {
    const rows = await runs().listWhere({ spaceId, agentSourceKey });
    return spentSince(rows, monthStartIso(at));
  }

  /** Create one teammate agent: name, role, instructions, optional monthly cap. */
  async function createAgent(request) {
    const record = request && typeof request === 'object' ? request : {};
    const actor = requireAgentActor(record.actor, 'Creating an agent');
    const input = checkAgentInput(record);
    const at = now();
    const existing = (await agents().listWhere({ spaceId: input.spaceId, sourceKey: input.sourceKey }))[0] ?? null;
    if (existing) return { duplicate: true, agent: existing };
    const agent = await agents().createManaged({
      sourceKey: input.sourceKey,
      spaceId: input.spaceId,
      name: input.name,
      role: input.role,
      instructions: input.instructions,
      ...(input.spendingCapCents === null ? {} : { spendingCapCents: input.spendingCapCents }),
      status: 'active',
      decidedAt: at,
      actorType: actor.type,
      actorId: actor.id,
      sourcePackage: AGENTS_DOMAIN,
      sourceAction: 'create-agent',
    }, { actor });
    return { duplicate: false, agent };
  }

  /**
   * Create one assignment from a human phrase. `plan` is the explicit
   * schedule (the fake-AI seam): without it the built-in Italian parser
   * runs, and an unclear phrase refuses with AGENT_PHRASE_UNCLEAR.
   */
  async function createAssignment(request) {
    const record = request && typeof request === 'object' ? request : {};
    const actor = requireAgentActor(record.actor, 'Creating an assignment');
    const input = checkAssignmentInput(record);
    const agent = await loadAgent(input.spaceId, input.agentSourceKey);
    requireCostEstimate(agent.spendingCapCents, input.costPerRunCents);
    const at = now();
    const schedule = record.plan !== undefined && record.plan !== null
      ? checkSchedulePlan(record.plan)
      : parsePhraseSchedule(input.phrase, at);
    const nextRunAt = schedule.cadence === 'once' && schedule.runAt ? schedule.runAt : computeNextRun(schedule, at);
    const existing = (await assignments().listWhere({ spaceId: input.spaceId, sourceKey: input.sourceKey }))[0] ?? null;
    if (existing) return { duplicate: true, assignment: existing };
    const assignment = await assignments().createManaged({
      sourceKey: input.sourceKey,
      spaceId: input.spaceId,
      agentSourceKey: input.agentSourceKey,
      phrase: input.phrase,
      cadence: schedule.cadence,
      ...(schedule.weekday === null ? {} : { weekday: schedule.weekday }),
      timeOfDay: schedule.timeOfDay,
      ...(schedule.runAt === null ? {} : { runAt: schedule.runAt }),
      nextRunAt,
      ...(input.costPerRunCents === 0 ? {} : { costPerRunCents: input.costPerRunCents }),
      status: 'active',
      decidedAt: at,
      actorType: actor.type,
      actorId: actor.id,
      sourcePackage: AGENTS_DOMAIN,
      sourceAction: 'create-assignment',
    }, { actor });
    return { duplicate: false, assignment };
  }

  async function advanceAssignment(assignment, from) {
    if (assignment.cadence === 'once') {
      await assignments().applyManaged(
        assignment.id,
        { status: 'completed', lastRunAt: from },
        { actor: AGENT_TIMER_ACTOR },
      );
      return;
    }
    const schedule = {
      cadence: assignment.cadence,
      weekday: assignment.weekday ?? null,
      timeOfDay: assignment.timeOfDay ?? '08:00',
      runAt: null,
    };
    await assignments().applyManaged(
      assignment.id,
      { nextRunAt: computeNextRun(schedule, from), lastRunAt: from },
      { actor: AGENT_TIMER_ACTOR },
    );
  }

  /**
   * Run every due active assignment. `execute({ agent, assignment })` is the
   * worker/AI seam returning `{ kind: 'proposals' | 'artifact', ... }`.
   * The cap is checked before `execute` runs; a capped or failed execution
   * is still recorded with agent, assignment, cost and outcome.
   */
  async function runDue(request) {
    const record = request && typeof request === 'object' ? request : {};
    const actor = requireAgentActor(record.actor ?? AGENT_TIMER_ACTOR, 'Running due assignments');
    const execute = record.execute;
    if (typeof execute !== 'function') {
      throw new AppError('Running assignments needs the execute seam', {
        code: 'AGENT_EXECUTE_MISSING', status: 500,
      });
    }
    const at = typeof record.at === 'string' ? record.at : now();
    const scopeSpace = record.spaceId !== undefined ? checkSpaceId(record.spaceId) : null;
    const due = (await assignments().listWhere(scopeSpace ? { spaceId: scopeSpace } : {}))
      .filter((row) => row && row.status === 'active'
        && typeof row.nextRunAt === 'string' && Date.parse(row.nextRunAt) <= Date.parse(at));
    const summary = {
      advanced: 0, proposed: 0, artifacts: 0, capped: 0, failed: 0, skipped: 0, errors: [],
    };
    for (const assignment of due) {
      const spaceId = assignment.spaceId;
      const agent = await loadAgent(spaceId, assignment.agentSourceKey);
      if (agent.status !== 'active') continue;
      const startedAt = at;
      const runKey = agentRunKey(assignment.sourceKey, startedAt);
      const base = {
        spaceId,
        agentSourceKey: agent.sourceKey,
        assignmentSourceKey: assignment.sourceKey,
        startedAt,
        decidedAt: now(),
        actorType: actor.type,
        actorId: actor.id,
        sourcePackage: AGENTS_DOMAIN,
        sourceAction: 'run-due',
      };
      // 1. Cap gate first: a capped agent runs only against a positive
      // estimate, and the estimate is the allowance. Unknown cost never runs.
      if (agent.spendingCapCents !== null && agent.spendingCapCents !== undefined) {
        const estimate = requireCostEstimate(agent.spendingCapCents, assignment.costPerRunCents);
        const spent = await monthSpent(spaceId, agent.sourceKey, at);
        if (spent + estimate > agent.spendingCapCents) {
          await runs().createManaged({
            ...base,
            sourceKey: runKey,
            costCents: 0,
            outcome: 'capped',
            note: `Monthly cap reached: spent ${spent}c of ${agent.spendingCapCents}c, this run would cost ${estimate}c.`,
          }, { actor });
          summary.capped += 1;
          summary.advanced += 1;
          await advanceAssignment(assignment, startedAt);
          continue;
        }
      }
      // 2. Claim the slot before executing: overlapping sweeps serialize on
      // the UNIQUE run key. The loser replays or skips, never re-executes.
      let claim = null;
      let reclaimed = false;
      try {
        claim = await runs().createManaged({
          ...base,
          sourceKey: runKey,
          costCents: 0,
          outcome: 'started',
          note: 'Slot claimed, execution not yet recorded.',
        }, { actor });
      } catch (error) {
        if (!isWinnerConflict(error)) throw error;
        const stored = (await runs().listWhere({ spaceId, sourceKey: runKey }))[0] ?? null;
        if (stored && RUN_TERMINAL.includes(stored.outcome)) {
          // A retry after a finished run: replay the stored outcome,
          // advance past the slot, never execute again.
          summary[stored.outcome === 'applied' ? 'proposed' : stored.outcome] += 1;
          summary.advanced += 1;
          await advanceAssignment(assignment, startedAt);
          continue;
        }
        const leaseMs = Date.parse(now()) - Date.parse(stored?.decidedAt ?? now());
        if (stored && stored.outcome === 'started' && Number.isFinite(leaseMs) && leaseMs > AGENT_CLAIM_LEASE_MS) {
          // The claiming sweep never finished: reclaim its slot.
          claim = stored;
          reclaimed = true;
        } else {
          summary.skipped += 1;
          continue;
        }
      }
      void reclaimed;
      // 3. Execute, then finalize the claimed row. A crash between the
      // claim and the finalize leaves a `started` row the next sweep
      // reclaims after the lease — the work runs again, the evidence stays
      // one row per slot.
      let checked;
      try {
        checked = checkExecuteResult(await execute({ agent, assignment }));
      } catch (error) {
        await runs().applyManaged(claim.id, {
          costCents: 0,
          outcome: 'failed',
          note: sanitizeFailure(error, spaceId),
        }, { actor });
        summary.failed += 1;
        summary.advanced += 1;
        summary.errors.push({
          assignmentSourceKey: assignment.sourceKey,
          spaceId,
          code: error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN',
        });
        await advanceAssignment(assignment, startedAt);
        continue;
      }
      const costCents = checkCostCents(checked.costCents, 'result.costCents') ?? 0;
      const capped = agent.spendingCapCents !== null && agent.spendingCapCents !== undefined;
      const estimate = Number.isInteger(assignment.costPerRunCents) ? assignment.costPerRunCents : 0;
      const overrun = capped && costCents > estimate
        ? ` Actual cost ${costCents}c exceeded the ${estimate}c estimate.`
        : '';
      if (checked.kind === 'proposals') {
        await runs().applyManaged(claim.id, {
          costCents,
          outcome: 'proposed',
          proposals: JSON.stringify(checked.proposals),
          note: `${checked.proposals.length} action proposal(s) waiting for human approval.${overrun}`,
        }, { actor });
        summary.proposed += 1;
        summary.advanced += 1;
        await advanceAssignment(assignment, startedAt);
        continue;
      }
      const previous = await runs().listWhere({ spaceId, assignmentSourceKey: assignment.sourceKey });
      let version = 1;
      for (const row of previous) {
        if (row && Number.isInteger(row.artifactVersion) && row.artifactVersion >= version) {
          version = row.artifactVersion + 1;
        }
      }
      await runs().applyManaged(claim.id, {
        costCents,
        outcome: 'artifact',
        artifact: JSON.stringify(checked.artifact),
        artifactVersion: version,
        ...(overrun === '' ? {} : { note: overrun.trim() }),
      }, { actor });
      summary.artifacts += 1;
      summary.advanced += 1;
      await advanceAssignment(assignment, startedAt);
    }
    return summary;
  }

  /**
   * Approve one proposed run: a human actor, the optional space permission
   * gate, then every proposal through the `applyAction` seam. Proposals
   * become writes here and nowhere else.
   *
   * What this does NOT cover: the seam has no timeout and no conditional
   * write, so a deployment must bound `applyAction` itself and make it
   * idempotent per (runSourceKey, action) — a retry after a partial failure
   * replays the same proposals, and two concurrent approvals of one run are
   * not serialized here.
   */
  async function approveRun(request) {
    const record = request && typeof request === 'object' ? request : {};
    const actor = requireHumanActor(requireAgentActor(record.actor, 'Approving a run'), 'Approving a run');
    const spaceId = checkSpaceId(record.spaceId);
    const runSourceKey = typeof record.runSourceKey === 'string' && record.runSourceKey !== ''
      ? record.runSourceKey
      : (() => { throw new AppError('runSourceKey is required', { code: 'AGENT_RUN_KEY_REQUIRED', status: 400 }); })();
    const applyAction = record.applyAction;
    if (typeof applyAction !== 'function') {
      throw new AppError('Approving a run needs the applyAction seam', {
        code: 'AGENT_APPLY_MISSING', status: 500,
      });
    }
    const run = (await runs().listWhere({ spaceId, sourceKey: runSourceKey }))[0] ?? null;
    if (!run) {
      throw new AppError('Unknown run in this space', { code: 'AGENT_RUN_UNKNOWN', status: 404 });
    }
    assertRunTransition(run.outcome, 'approve');
    if (permissionGate) {
      const verdict = await permissionGate.verdict({
        spaceId, permission: AGENT_APPLY_PERMISSION, actor, runSourceKey,
      });
      const allowed = verdict === true || (verdict && (verdict.allowed === true || verdict.decision === 'allow'));
      if (!allowed) {
        throw new AppError('The space permission gate refused this approval', {
          code: 'AGENT_APPROVAL_DENIED', status: 403,
        });
      }
    }
    let proposals;
    try {
      proposals = JSON.parse(run.proposals ?? '[]');
    } catch {
      throw new AppError('Stored proposals are unreadable: refusing to apply blind', {
        code: 'AGENT_PROPOSALS_CORRUPT', status: 500,
      });
    }
    if (!Array.isArray(proposals) || proposals.length === 0) {
      throw new AppError('A proposed run with no proposals cannot be approved', {
        code: 'AGENT_PROPOSALS_EMPTY', status: 409,
      });
    }
    const applied = [];
    for (const proposal of proposals) {
      applied.push(await applyAction({ spaceId, actor, runSourceKey, proposal }));
    }
    await runs().applyManaged(
      run.id,
      { outcome: 'applied' },
      { actor },
    );
    const updated = (await runs().listWhere({ spaceId, sourceKey: runSourceKey }))[0] ?? null;
    return { run: updated, applied };
  }

  async function pauseAgent(request) {
    const record = request && typeof request === 'object' ? request : {};
    const actor = requireAgentActor(record.actor, 'Pausing an agent');
    const spaceId = checkSpaceId(record.spaceId);
    const agent = await loadAgent(spaceId, record.agentSourceKey);
    assertAgentTransition(agent.status, 'pause');
    await agents().applyManaged(
      agent.id,
      { status: 'paused' },
      { actor },
    );
    return { agent: (await agents().listWhere({ spaceId, sourceKey: agent.sourceKey }))[0] };
  }

  async function pauseAssignment(request) {
    const record = request && typeof request === 'object' ? request : {};
    const actor = requireAgentActor(record.actor, 'Pausing an assignment');
    const spaceId = checkSpaceId(record.spaceId);
    const assignment = await loadAssignment(spaceId, record.assignmentSourceKey);
    assertAssignmentTransition(assignment.status, 'pause');
    await assignments().applyManaged(
      assignment.id,
      { status: 'paused' },
      { actor },
    );
    return { assignment: (await assignments().listWhere({ spaceId, sourceKey: assignment.sourceKey }))[0] };
  }

  return { createAgent, createAssignment, runDue, approveRun, pauseAgent, pauseAssignment };
}
