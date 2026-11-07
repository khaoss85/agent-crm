// @ts-check

import { AppError, ConflictError, nowIso, withTimeout } from '../../core/index.js';
import {
  AGENTS_DOMAIN,
  AGENT_APPLY_PERMISSION,
  AGENT_APPLY_TIMEOUT_MS,
  AGENT_APPROVAL_LEASE_MS,
  AGENT_CLAIM_LEASE_MS,
  AGENT_TIMER_ACTOR,
  RUN_TERMINAL,
  agentRunKey,
  assertRunTransition,
  checkAgentInput,
  checkAssignmentInput,
  checkCostCents,
  checkExecuteResult,
  checkProposal,
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
 * One source of truth for a due slot's identity: the slot is the
 * assignment's due instant (`nextRunAt`), never the sweep's wall clock.
 * Two sweeps at different milliseconds contend the same UNIQUE run key,
 * so the loser replays instead of executing twice past the spending cap.
 * @param {any} assignment
 */
function slotOf(assignment, at) {
  const slot = typeof assignment?.nextRunAt === 'string' && assignment.nextRunAt !== ''
    ? assignment.nextRunAt
    : at;
  return { startedAt: slot, runKey: agentRunKey(assignment.sourceKey, slot) };
}

/**
 * A stored terminal outcome counts in its own documented summary bucket:
 * `artifact` counts as `artifacts`, `applied` as `applied` — never as a
 * verbatim key that would corrupt the summary with NaN or a wrong bucket.
 * @param {unknown} outcome
 */
function replayBucket(outcome) {
  if (outcome === 'artifact') return 'artifacts';
  if (outcome === 'applied') return 'applied';
  if (outcome === 'proposed' || outcome === 'capped' || outcome === 'failed') return outcome;
  return null;
}

/**
 * The storage seam a conditional run write needs: the managed service's
 * own manifest (field names to physical columns, resolved at runtime so
 * no backend's naming is hardcoded here), its storage `execute` with the
 * `affectedRows` verdict, and the service's own atomic-mutation entry
 * point (`mutationSync` on sync storage, `mutationAsync` otherwise — the
 * same ones `applyManaged` uses, so the conditional write, its framework
 * audit row and the re-read land in one unit with no new seam and no
 * cross-package import). Only `eq` predicates are used: every
 * compare-and-swap matches the exact note read fresh, never a pattern.
 * Missing seam refuses fail-closed.
 * @param {any} runService
 */
function runStorageSeam(runService) {
  const manifest = runService?.manifest;
  const storage = runService?.database?.storage;
  const fields = Array.isArray(manifest?.fields) ? manifest.fields : null;
  const columnOf = (name) => fields?.find((field) => field?.name === name)?.column ?? null;
  const columns = {
    outcome: columnOf('outcome'),
    note: columnOf('note'),
    costCents: columnOf('costCents'),
    proposals: columnOf('proposals'),
    artifact: columnOf('artifact'),
    artifactVersion: columnOf('artifactVersion'),
  };
  const syncApi = storage?.sync;
  const syncMutation = syncApi
    && typeof syncApi.execute === 'function'
    && typeof syncApi.savepoint === 'function'
    && typeof runService.mutationSync === 'function';
  const asyncMutation = typeof runService.mutationAsync === 'function';
  if (!manifest || typeof manifest.table !== 'string' || typeof manifest.name !== 'string'
    || Object.values(columns).some((column) => typeof column !== 'string' || column === '')
    || !storage || typeof storage.execute !== 'function'
    || typeof runService.get !== 'function'
    || typeof runService.audit?.record !== 'function'
    || typeof runService.events?.emit !== 'function'
    || (!syncMutation && !asyncMutation)) {
    throw new AppError('agent run storage cannot prove an atomic conditional write', {
      code: 'AGENTS_STORAGE_INVALID', status: 500,
    });
  }
  return { manifest, columns, syncApi: syncMutation ? syncApi : null };
}

/**
 * One conditional run write: `SET` the mapped patch only where every
 * `expect` equality still holds, in the service's own atomic unit with
 * the framework audit row, then re-read. Returns the fresh row, or null
 * when a concurrent writer moved the row first (the caller re-reads the
 * winner instead of overwriting it).
 * @param {any} runService
 */
async function conditionalRunWrite(runService, id, patch, expect, actor) {
  const { manifest, columns, syncApi } = runStorageSeam(runService);
  const at = nowIso();
  const values = [];
  for (const field of ['outcome', 'note', 'costCents', 'proposals', 'artifact', 'artifactVersion']) {
    if (patch[field] !== undefined) values.push({ column: columns[field], value: patch[field] });
  }
  if (values.length === 0) throw new AppError('A conditional run write needs a patch', {
    code: 'AGENTS_WRITE_EMPTY', status: 500,
  });
  values.push({ column: 'updated_at', value: at });
  const where = [{ column: 'id', op: 'eq', value: id }];
  for (const [field, value] of Object.entries(expect)) {
    const column = columns[field];
    if (!column) throw new AppError(`A conditional run write cannot expect ${field}`, {
      code: 'AGENTS_WRITE_INVALID', status: 500,
    });
    if (value === null) where.push({ column, op: 'is-null' });
    else where.push({ column, op: 'eq', value });
  }
  const statement = { kind: 'update', table: manifest.table, values, where };
  const auditEvent = {
    actor, entityType: manifest.name, entityId: id,
    data: { ...patch }, action: `${manifest.name}.updated`,
  };
  let won = false;
  if (syncApi) {
    won = runService.mutationSync(() => {
      const claimed = syncApi.execute(statement);
      if (Number(claimed?.affectedRows ?? 0) !== 1) return false;
      runService.audit.record(auditEvent);
      return true;
    });
  } else {
    won = await runService.mutationAsync(async (tx) => {
      const claimed = await tx.execute(statement);
      if (Number(claimed?.affectedRows ?? 0) !== 1) return false;
      await runService.audit.record(auditEvent, tx);
      return true;
    });
  }
  if (!won) return null;
  const fresh = await runService.get(id);
  await runService.events.emit(`${manifest.name}.updated`, fresh);
  return fresh;
}

/**
 * Same-process serialization for one run's approval, one FIFO chain per
 * run: two approvals racing in this process apply in order, and the loser
 * re-reads the winner's applied row instead of applying twice.
 * Cross-process writers do NOT serialize here — the approval claim and
 * the finalizing write below are conditional storage writes on the row
 * read fresh, so a cross-process racer loses the claim and replays the
 * winner instead of overwriting it.
 */
const approvalChains = new Map();

/**
 * @param {string} key @param {() => Promise<any>} fn
 */
async function withApprovalLock(key, fn) {
  const previous = approvalChains.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => gate);
  approvalChains.set(key, chained);
  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    release();
    if (approvalChains.get(key) === chained) approvalChains.delete(key);
  }
}

/**
 * Same-process serialization for one capped agent's sweep work, one FIFO
 * chain per agent (`spaceId:agentSourceKey`): the whole per-assignment
 * section — cap gate, slot claim, execute, finalize — runs while holding
 * the agent's chain, so two concurrent sweeps covering different
 * assignments of one capped agent cannot both pass the gate on the same
 * stale `spent` snapshot and execute past the monthly cap. The second
 * sweep waits, then re-reads the ledger with the first sweep's finalized
 * cost already counted. Assignments of different agents (or spaces) use
 * different keys and still run independently. Cross-process writers do
 * NOT serialize here, and the UNIQUE slot claim only guards same-slot
 * races. Across processes the cap holds through the reservation in
 * storage: every started claim of a capped agent carries its estimate as
 * `costCents`, the ledger counts it, and each sweep re-checks the ledger
 * after its own claim landed (see runDue). Two claims racing across
 * processes both see each other and both record `capped` — fail-closed,
 * never past the cap.
 */
const agentCapChains = new Map();

/**
 * @param {string} key @param {() => Promise<any>} fn
 */
async function withAgentCapLock(key, fn) {
  const previous = agentCapChains.get(key) ?? Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const chained = previous.then(() => gate);
  agentCapChains.set(key, chained);
  try {
    await previous.catch(() => {});
    return await fn();
  } finally {
    release();
    if (agentCapChains.get(key) === chained) agentCapChains.delete(key);
  }
}

/** @param {string} token @param {number} nowMs */
function approvalClaimNote(token, nowMs) {
  return `approval-claim ${String(token).replace(/\s+/g, '_')} ${nowMs}`;
}

/** @param {number} done @param {number} total @param {number} nowMs */
function approvalProgressNote(done, total, nowMs) {
  return `approval-progress ${done}/${total} ${nowMs}`;
}

/**
 * Read one approval note written by this module: a claim, a progress
 * heartbeat, a stopped marker left by a failed attempt, or null for any
 * other text (the human-readable notes the sweeps and the final approval
 * write).
 * @param {unknown} note
 */
function parseApprovalNote(note) {
  if (typeof note !== 'string') return null;
  let match = /^approval-claim (\S+) (\d+)$/.exec(note);
  if (match) return { kind: 'claim', token: match[1], atMs: Number(match[2]) };
  match = /^approval-progress (\d+)\/(\d+) (\d+)$/.exec(note);
  if (match) return { kind: 'progress', done: Number(match[1]), total: Number(match[2]), atMs: Number(match[3]) };
  // A finished attempt that failed partway leaves where the retry resumes.
  // It is never live: nothing is applying behind it anymore.
  match = /^approval stopped (\d+)\/(\d+) (\d+)$/.exec(note);
  if (match) return { kind: 'stopped', done: Number(match[1]), total: Number(match[2]), atMs: Number(match[3]) };
  return null;
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
    // Reload: a concurrent sweep may have advanced (or a human paused)
    // the assignment after this sweep listed it. Only an active row moves;
    // a repeat advance from the same instant is a no-op, never a second
    // transition.
    const fresh = (await assignments().listWhere({ spaceId: assignment.spaceId, sourceKey: assignment.sourceKey }))[0] ?? null;
    const current = fresh ?? assignment;
    if (current.status !== 'active') return;
    if (current.cadence === 'once') {
      await assignments().applyManaged(
        current.id,
        { status: 'completed', lastRunAt: from },
        { actor: AGENT_TIMER_ACTOR },
      );
      return;
    }
    const schedule = {
      cadence: current.cadence,
      weekday: current.weekday ?? null,
      timeOfDay: current.timeOfDay ?? '08:00',
      runAt: null,
    };
    await assignments().applyManaged(
      current.id,
      { nextRunAt: computeNextRun(schedule, from), lastRunAt: from },
      { actor: AGENT_TIMER_ACTOR },
    );
  }

  /**
   * A sweep that lost the UNIQUE run-key race replays the winner instead
   * of executing again: a finished winner counts in its own summary
   * bucket, a still-started winner is skipped, and a stale started claim
   * is handed back for takeover. Returns `{ handled, claim }`: handled
   * rows need no further work, a returned claim is this sweep's slot.
   */
  async function replayLostRace(spaceId, runKey, assignment, startedAt, summary, actor) {
    const stored = (await runs().listWhere({ spaceId, sourceKey: runKey }))[0] ?? null;
    if (stored && RUN_TERMINAL.includes(stored.outcome)) {
      // A retry after a finished run: replay the stored outcome,
      // advance past the slot, never execute again.
      const bucket = replayBucket(stored.outcome);
      if (bucket !== null) summary[bucket] += 1;
      else summary.skipped += 1;
      summary.advanced += 1;
      await advanceAssignment(assignment, startedAt);
      return { handled: true, claim: null };
    }
    const leaseMs = Date.parse(now()) - Date.parse(stored?.decidedAt ?? now());
    if (stored && stored.outcome === 'started' && Number.isFinite(leaseMs) && leaseMs > AGENT_CLAIM_LEASE_MS) {
      // The claiming sweep never finished: reclaim its slot.
      return { handled: false, claim: stored };
    }
    summary.skipped += 1;
    return { handled: true, claim: null };
  }

  /**
   * Finalize one claimed run row: the patch lands only while the row
   * still carries the exact outcome and note this sweep claimed it with,
   * so a concurrent capped sweep that stole a stale claim (or any other
   * writer) cannot be overwritten silently. The winner's row stands and
   * this sweep replays it; nobody's evidence is lost, nobody's is forged.
   * Counts the sweep's outcome bucket and advances past the slot.
   */
  async function finalizeClaim(spaceId, runKey, claim, patch, bucket, assignment, startedAt, summary, actor) {
    const won = await conditionalRunWrite(
      runs(), claim.id, patch, { outcome: claim.outcome, note: claim.note }, actor,
    );
    if (won) {
      summary[bucket] += 1;
      summary.advanced += 1;
      await advanceAssignment(assignment, startedAt);
      return won;
    }
    const stored = (await runs().listWhere({ spaceId, sourceKey: runKey }))[0] ?? null;
    if (stored && RUN_TERMINAL.includes(stored.outcome)) {
      const replayed = replayBucket(stored.outcome);
      if (replayed !== null) summary[replayed] += 1;
      else summary.skipped += 1;
      summary.advanced += 1;
      await advanceAssignment(assignment, startedAt);
      return stored;
    }
    summary.skipped += 1;
    return null;
  }

  /**
   * Run every due active assignment. `execute({ agent, assignment })` is the
   * worker/AI seam returning `{ kind: 'proposals' | 'artifact', ... }`.
   * The cap is checked before `execute` runs (estimate gate) and enforced
   * again after it returns (actual-cost gate); a capped or failed execution
   * is still recorded with agent, assignment, cost and outcome.
   * Per-assignment work for one agent holds that agent's same-process
   * chain, so concurrent sweeps cannot both pass the gate on a stale
   * `spent` snapshot and execute past the monthly cap. Across processes,
   * a capped agent's claim reserves its estimate on the ledger and the
   * sweep re-checks the ledger after the claim, before `execute`.
   * One broken assignment never stops the sweep: its error is counted as
   * `skipped` with an `errors[]` entry and the next assignment runs.
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
      advanced: 0, proposed: 0, applied: 0, artifacts: 0, capped: 0, failed: 0, skipped: 0, errors: [],
    };
    for (const assignment of due) {
      try {
        // P1 monthly-cap race: the cap gate, slot claim, execute and finalize
        // for one agent hold that agent's chain, so two concurrent sweeps
        // covering different assignments of one capped agent cannot both pass
        // the gate on the same stale `spent` snapshot and execute past the
        // cap. The loser waits, then re-reads the ledger with the winner's
        // finalized cost already counted. Assignments of different agents (or
        // spaces) use different keys and proceed independently.
        await withAgentCapLock(`${assignment.spaceId}:${assignment.agentSourceKey}`, async () => {
          const spaceId = assignment.spaceId;
          const agent = await loadAgent(spaceId, assignment.agentSourceKey);
          if (agent.status !== 'active') return;
          const { startedAt, runKey } = slotOf(assignment, at);
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
              let cappedClaim = null;
              try {
                cappedClaim = await runs().createManaged({
                  ...base,
                  sourceKey: runKey,
                  costCents: 0,
                  outcome: 'capped',
                  note: `Monthly cap reached: spent ${spent}c of ${agent.spendingCapCents}c, this run would cost ${estimate}c.`,
                }, { actor });
                void cappedClaim;
              } catch (error) {
                if (!isWinnerConflict(error)) throw error;
                // A concurrent capped sweep claimed the same slot: replay the
                // winner (or take over its stale started claim) instead of
                // crashing runDue.
                const lost = await replayLostRace(spaceId, runKey, assignment, startedAt, summary, actor);
                if (lost.handled) return;
                cappedClaim = lost.claim;
                // A stolen stale claim finalizes conditionally: if its sweep
                // woke up and recorded first, the winner stands and this sweep
                // replays it instead of overwriting it.
                await finalizeClaim(spaceId, runKey, cappedClaim, {
                  costCents: 0,
                  outcome: 'capped',
                  note: `Monthly cap reached: spent ${spent}c of ${agent.spendingCapCents}c, this run would cost ${estimate}c.`,
                }, 'capped', assignment, startedAt, summary, actor);
                // finalizeClaim already counted and advanced: never fall
                // through to the outer capped/advanced increment below.
                return;
              }
              summary.capped += 1;
              summary.advanced += 1;
              await advanceAssignment(assignment, startedAt);
              return;
            }
          }
          const capped = agent.spendingCapCents !== null && agent.spendingCapCents !== undefined;
          const estimate = Number.isInteger(assignment.costPerRunCents) ? assignment.costPerRunCents : 0;
          // 2. Claim the slot before executing: overlapping sweeps serialize on
          // the UNIQUE run key. The loser replays or skips, never re-executes.
          // A capped agent's claim reserves its estimate on the ledger
          // (`costCents` of the started row): every other sweep, in any
          // process, counts it before executing. Finalize replaces it with the
          // actual cost (0 on failure).
          let claim = null;
          try {
            claim = await runs().createManaged({
              ...base,
              sourceKey: runKey,
              costCents: capped ? estimate : 0,
              outcome: 'started',
              note: 'Slot claimed, execution not yet recorded.',
            }, { actor });
          } catch (error) {
            if (!isWinnerConflict(error)) throw error;
            const lost = await replayLostRace(spaceId, runKey, assignment, startedAt, summary, actor);
            if (lost.handled) return;
            claim = lost.claim;
          }
          // This claim's own reservation, already on the ledger.
          const reserved = typeof claim?.costCents === 'number' && Number.isFinite(claim.costCents) && claim.costCents > 0
            ? claim.costCents
            : 0;
          // 2b. Re-check the cap with this claim's reservation stored: a sweep
          // of another process may have reserved between the gate above and
          // this claim. Everything else on the ledger (finalized costs and
          // in-flight reservations) plus this estimate must fit; otherwise the
          // slot records `capped` and nothing executes. Two claims racing
          // across processes both see each other here: fail-closed.
          if (capped) {
            const others = (await monthSpent(spaceId, agent.sourceKey, at)) - reserved;
            if (others + estimate > agent.spendingCapCents) {
              await finalizeClaim(spaceId, runKey, claim, {
                costCents: 0,
                outcome: 'capped',
                note: `Monthly cap reached: spent or reserved ${others}c of ${agent.spendingCapCents}c, this run would cost ${estimate}c.`,
              }, 'capped', assignment, startedAt, summary, actor);
              return;
            }
          }
          // 3. Execute, then finalize the claimed row. A crash between the
          // claim and the finalize leaves a `started` row the next sweep
          // reclaims after the lease — the work runs again, the evidence stays
          // one row per slot.
          let checked;
          try {
            checked = checkExecuteResult(await execute({ agent, assignment }));
          } catch (error) {
            await finalizeClaim(spaceId, runKey, claim, {
              costCents: 0,
              outcome: 'failed',
              note: sanitizeFailure(error, spaceId),
            }, 'failed', assignment, startedAt, summary, actor);
            summary.errors.push({
              assignmentSourceKey: assignment.sourceKey,
              spaceId,
              code: error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN',
            });
            return;
          }
          const costCents = checkCostCents(checked.costCents, 'result.costCents') ?? 0;
          // Post-execution allowance: the executor reports its own actual
          // cost, so the pre-execution estimate cannot hold the cap alone. A
          // run whose actual cost no longer fits the remaining allowance is
          // recorded as `capped` — the true cost stays on the ledger (later
          // sweeps stop here too), but its proposals/artifact are dropped and
          // nothing is proposed or stored from an over-cap run.
          if (capped) {
            // The ledger still holds this claim's own reservation: the
            // allowance is the cap minus everything else.
            const spentNow = (await monthSpent(spaceId, agent.sourceKey, at)) - reserved;
            const allowance = agent.spendingCapCents - spentNow;
            if (costCents > allowance) {
              await finalizeClaim(spaceId, runKey, claim, {
                costCents,
                outcome: 'capped',
                note: `Monthly cap stopped this run after execution: actual cost ${costCents}c exceeds the remaining allowance ${allowance}c of ${agent.spendingCapCents}c (estimate was ${estimate}c). Proposals/artifact not stored.`,
              }, 'capped', assignment, startedAt, summary, actor);
              return;
            }
          }
          const overrun = capped && costCents > estimate
            ? ` Actual cost ${costCents}c exceeded the ${estimate}c estimate.`
            : '';
          if (checked.kind === 'proposals') {
            await finalizeClaim(spaceId, runKey, claim, {
              costCents,
              outcome: 'proposed',
              proposals: JSON.stringify(checked.proposals),
              note: `${checked.proposals.length} action proposal(s) waiting for human approval.${overrun}`,
            }, 'proposed', assignment, startedAt, summary, actor);
            return;
          }
          const previous = await runs().listWhere({ spaceId, assignmentSourceKey: assignment.sourceKey });
          let version = 1;
          for (const row of previous) {
            if (row && Number.isInteger(row.artifactVersion) && row.artifactVersion >= version) {
              version = row.artifactVersion + 1;
            }
          }
          // An artifact row never keeps the claim note: without an overrun
          // the note is cleared (null), so no "Slot claimed..." line ever
          // survives on a finished artifact row.
          await finalizeClaim(spaceId, runKey, claim, {
            costCents,
            outcome: 'artifact',
            artifact: JSON.stringify(checked.artifact),
            artifactVersion: version,
            note: overrun === '' ? null : overrun.trim(),
          }, 'artifacts', assignment, startedAt, summary, actor);
        });
      } catch (error) {
        // One broken assignment (dangling agent, missing estimate, a
        // storage hiccup) never stops the sweep: count it, keep the code
        // and space only (no message, no secrets), go on with the next.
        summary.skipped += 1;
        summary.errors.push({
          assignmentSourceKey: typeof assignment?.sourceKey === 'string' ? assignment.sourceKey : null,
          spaceId: typeof assignment?.spaceId === 'string' ? assignment.spaceId : null,
          code: error && typeof error === 'object' && typeof error.code === 'string' ? error.code : 'UNKNOWN',
        });
      }
    }
    return summary;
  }

  /**
   * Approve one proposed run: a human actor, the optional space permission
   * gate, then every proposal through the `applyAction` seam. Proposals
   * become writes here and nowhere else.
   *
   * Concurrency: approvals of one run serialize on a same-process FIFO
   * chain, and the approval itself is a conditional claim on the row read
   * fresh (compare-and-swap on the exact note, `eq` only): the winner
   * applies, every loser replays the applied row or refuses while a claim
   * is live. Each applied proposal writes a progress heartbeat, so a retry
   * after a partial failure resumes past the proposals already applied
   * instead of duplicating them. Every `applyAction` call carries an
   * idempotency key (`agent-approval:<runSourceKey>:<index>:<action>`) the
   * deployment must honor, and runs bounded by AGENT_APPLY_TIMEOUT_MS.
   *
   * What this does NOT cover: a deployment that ignores the idempotency
   * key can still double-apply when two approver processes race across
   * machines (same-process races and retries are safe here); a late
   * `applyAction` that settles after its timeout is abandoned best-effort,
   * like every bounded provider call in this framework.
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
    // An approval that lands after the run applied is an idempotent
    // replay, never a second application: same result, no new writes.
    if (run.outcome === 'applied') return { run, applied: [], duplicate: true };
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
    return withApprovalLock(`${spaceId}:${runSourceKey}`, async () => {
      const current = (await runs().listWhere({ spaceId, sourceKey: runSourceKey }))[0] ?? null;
      if (!current) {
        throw new AppError('Unknown run in this space', { code: 'AGENT_RUN_UNKNOWN', status: 404 });
      }
      if (current.outcome === 'applied') return { run: current, applied: [], duplicate: true };
      assertRunTransition(current.outcome, 'approve');
      // Re-validate the stored proposals right before applying: corrupt
      // or empty proposals refuse instead of applying blind.
      let raw;
      try {
        raw = JSON.parse(current.proposals ?? '[]');
      } catch {
        throw new AppError('Stored proposals are unreadable: refusing to apply blind', {
          code: 'AGENT_PROPOSALS_CORRUPT', status: 500,
        });
      }
      if (!Array.isArray(raw) || raw.length === 0) {
        throw new AppError('A proposed run with no proposals cannot be approved', {
          code: 'AGENT_PROPOSALS_EMPTY', status: 409,
        });
      }
      const proposals = raw.map((proposal) => checkProposal(proposal));
      // Claim the run before any side effect: the claim lands only while
      // the row still carries the exact note read above. A live claim or
      // live progress heartbeat from another approver (including one at
      // done == total, still before its final write) refuses with a
      // retryable 409; a stale one is taken over and resumes from its
      // heartbeat instead of replaying applied proposals.
      const nowMs = Date.parse(now());
      const marker = parseApprovalNote(current.note);
      const ageMs = marker === null ? null : nowMs - marker.atMs;
      const live = marker !== null && Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= AGENT_APPROVAL_LEASE_MS
        && (marker.kind === 'claim'
          || (marker.kind === 'progress' && marker.total === proposals.length && marker.done <= marker.total));
      if (live) {
        throw new AppError('Another approval of this run is in progress: retry', {
          code: 'AGENT_APPROVAL_IN_PROGRESS', status: 409,
        });
      }
      // Resume where a previous attempt stopped: a stale progress
      // heartbeat means its approver is gone; a stopped marker means its
      // attempt returned a failure and nothing is applying behind it. A
      // stale `done == total` heartbeat applied everything and only missed
      // the final write: resume at the end, re-apply nothing.
      let start = 0;
      if (marker !== null && (marker.kind === 'progress' || marker.kind === 'stopped')
        && marker.total === proposals.length
        && Number.isInteger(marker.done) && marker.done > 0 && marker.done <= marker.total) {
        start = marker.done;
      }
      const claimText = approvalClaimNote(actor.id, nowMs);
      const claimed = await conditionalRunWrite(
        runs(), current.id, { note: claimText }, { outcome: 'proposed', note: current.note }, actor,
      );
      if (!claimed) {
        const loser = (await runs().listWhere({ spaceId, sourceKey: runSourceKey }))[0] ?? null;
        if (loser && loser.outcome === 'applied') return { run: loser, applied: [], duplicate: true };
        throw new AppError('Another approval of this run moved first: retry', {
          code: 'AGENT_APPROVAL_CONFLICT', status: 409,
        });
      }
      let currentNote = claimText;
      const applied = [];
      for (let index = start; index < proposals.length; index += 1) {
        const proposal = proposals[index];
        const idempotencyKey = `agent-approval:${runSourceKey}:${index}:${proposal.action}`;
        let result;
        try {
          result = await withTimeout(
            Promise.resolve().then(() => applyAction({ spaceId, actor, runSourceKey, proposal, idempotencyKey })),
            AGENT_APPLY_TIMEOUT_MS,
            `agent applyAction "${proposal.action}"`,
          );
        } catch (error) {
          // This attempt is over: leave a stopped marker (never live) so
          // the retry resumes at this proposal instead of meeting a
          // lease-held progress heartbeat. Best-effort: when another
          // approver already took over, their marker stands.
          const stopped = `approval stopped ${index}/${proposals.length} ${Date.parse(now())}`;
          await conditionalRunWrite(
            runs(), current.id, { note: stopped }, { outcome: 'proposed', note: currentNote }, actor,
          ).catch(() => null);
          throw error;
        }
        applied.push(result);
        // Progress heartbeat: a crash or a timeout after this write
        // leaves exactly where the retry resumes. Losing the heartbeat
        // race means another approver took over: stop, do not continue.
        const progress = approvalProgressNote(index + 1, proposals.length, Date.parse(now()));
        const heartbeat = await conditionalRunWrite(
          runs(), current.id, { note: progress }, { outcome: 'proposed', note: currentNote }, actor,
        );
        if (!heartbeat) {
          throw new AppError('Another approval of this run moved first: retry the remainder', {
            code: 'AGENT_APPROVAL_CONFLICT', status: 409,
          });
        }
        currentNote = progress;
      }
      const final = await conditionalRunWrite(
        runs(), current.id,
        {
          outcome: 'applied',
          note: `Applied ${proposals.length} action proposal(s) after human approval.`,
        },
        { outcome: 'proposed', note: currentNote }, actor,
      );
      if (!final) {
        const loser = (await runs().listWhere({ spaceId, sourceKey: runSourceKey }))[0] ?? null;
        if (loser && loser.outcome === 'applied') return { run: loser, applied: [], duplicate: true };
        throw new AppError('Another approval of this run moved first: retry', {
          code: 'AGENT_APPROVAL_CONFLICT', status: 409,
        });
      }
      const updated = (await runs().listWhere({ spaceId, sourceKey: runSourceKey }))[0] ?? null;
      return { run: updated, applied };
    });
  }

  return { createAgent, createAssignment, runDue, approveRun };
}
