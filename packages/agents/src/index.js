// @ts-check

import { definePackage, nowIso, ValidationError } from '../../core/index.js';
// No import from any other domain package. Executions call the
// composition-provided `execute` seam (worker/AI side, like the sequences
// `personalize` hook); approvals apply proposals through the
// composition-provided `applyAction` seam (the governed write path).
import { AGENTS_DOMAIN, AGENT_APPLY_PERMISSION } from './agents.js';
import { createAgentOperations } from './operations.js';

/**
 * The teammate-agents domain package (backlog:8986f4459f0f) — the
 * automation engine: named agents with roles and instructions, assignments
 * created from a human phrase (recurring or one-off), executions recorded
 * with cost and outcome, a monthly spending cap per agent, and action
 * proposals that become writes only after a human approval (or a versioned
 * artifact that needs none).
 *
 * Fail-closed throughout: an unclear phrase refuses instead of guessing a
 * cadence; a capped agent never executes; proposals wait for a human actor
 * (plus the space permission gate when composed); a retry of the same due
 * instant replays the stored run; metrics are counted from rows, never
 * stored.
 *
 * What is deliberately NOT here: the HTTP/backoffice UI (the pilot owns
 * it), the AI that turns a phrase into a plan (the `plan` input is the
 * seam a deployment plugs an intelligence provider into; the built-in
 * Italian parser is the deterministic fallback), provider sends (they stay
 * behind the `applyAction` seam the deployment wires to governed
 * operations), and stored counters.
 */

export const AGENTS_RESOURCES = Object.freeze([
  'teammate-agent', 'teammate-assignment', 'teammate-run',
]);

/**
 * @param {{
 *   permissionGate?: null | { verdict: (input: any) => Promise<any> | any },
 * }} [options]
 *   `permissionGate` is the optional space-permissions gate: when provided,
 *   approving a run also needs its allow verdict for
 *   `agent-action-apply`. Without it the human-actor rule still applies.
 */
export function createAgentsPackage(options = {}) {
  const permissionGate = options.permissionGate ?? null;
  if (permissionGate !== null && typeof permissionGate.verdict !== 'function') {
    throw new ValidationError('agents permissionGate must expose verdict(input)', { field: 'permissionGate' });
  }

  const opsFor = (runtime) => createAgentOperations({
    modules: runtime.modules,
    now: () => nowIso(),
    permissionGate,
  });

  const graph = definePackage({
    packageContract: 1,
    name: AGENTS_DOMAIN,
    // 1: backlog:8986f4459f0f — teammate agents with phrase assignments,
    // approval-gated proposals, versioned artifacts, spending caps.
    // 2: backlog:fd36da512b0e — «Da fare» decisions on a proposed run:
    // reject-run (outcome `rejected`) and revise-run (edit one proposal).
    version: 2,
    label: 'Agenti teammate',
    description:
      'Teammate agents: named agents with roles and instructions, assignments created from a human phrase '
      + 'with a cadence and a next run, executions recorded with cost and outcome, a monthly spending cap '
      + 'per agent, and action proposals a human approves, edits or rejects (or a versioned artifact).',
    resources: [...AGENTS_RESOURCES],
    requires: [],
    capabilities: [],
    actions: [],
    operations: [
      {
        operationContract: 1,
        name: 'create-agent',
        appMethod: 'createTeammateAgent',
        label: 'Create a teammate agent',
        description:
          'Create a named agent with a role, working instructions and an optional monthly spending cap. '
          + 'Idempotent by the caller-supplied source key.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id — always explicit, never inferred.' },
          { name: 'sourceKey', type: 'string', hint: 'Caller-supplied idempotency identity for the agent.' },
          { name: 'name', type: 'string', hint: 'The agent display name.' },
          { name: 'role', type: 'string', hint: 'What the agent is responsible for.' },
          { name: 'instructions', type: 'string', hint: 'How the agent works.' },
          { name: 'spendingCapCents', type: 'integer', hint: 'Optional monthly cap in cents.' },
        ],
        create(runtime) {
          const ops = opsFor(runtime);
          return (request) => ops.createAgent(request);
        },
      },
      {
        operationContract: 1,
        name: 'create-assignment',
        appMethod: 'createTeammateAssignment',
        label: 'Create an assignment from a phrase',
        description:
          'Turn a human phrase into a recurring or one-off assignment with a cadence and a next run. '
          + 'Pass an explicit plan (the fake-AI seam) or let the built-in Italian parser place the phrase; '
          + 'an unclear phrase refuses instead of guessing.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id — always explicit, never inferred.' },
          { name: 'sourceKey', type: 'string', hint: 'Caller-supplied idempotency identity for the assignment.' },
          { name: 'agentSourceKey', type: 'string', hint: 'The agent this assignment belongs to.' },
          { name: 'phrase', type: 'string', hint: 'The human phrase, e.g. ogni lunedi il report vendite.' },
        ],
        create(runtime) {
          const ops = opsFor(runtime);
          return (request) => ops.createAssignment(request);
        },
      },
      {
        operationContract: 1,
        name: 'run-due',
        appMethod: 'runDueTeammateAssignments',
        label: 'Run due assignments',
        description:
          'Run every due active assignment through the execute seam and record each execution with cost '
          + 'and outcome. Agents over their monthly cap record a capped run and never execute.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'Optional: run one space only.' },
        ],
        create(runtime) {
          const ops = opsFor(runtime);
          return (request) => ops.runDue(request);
        },
      },
      {
        operationContract: 1,
        name: 'approve-run',
        appMethod: 'approveTeammateRun',
        label: 'Approve a proposed run',
        description:
          'A human approval: applies every proposal of a proposed run through the governed applyAction '
          + 'seam. Proposals become writes here and nowhere else.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id — always explicit, never inferred.' },
          { name: 'runSourceKey', type: 'string', hint: 'The proposed run to approve.' },
        ],
        create(runtime) {
          const ops = opsFor(runtime);
          return (request) => ops.approveRun(request);
        },
      },
      {
        operationContract: 1,
        name: 'reject-run',
        appMethod: 'rejectTeammateRun',
        label: 'Reject a proposed run',
        description:
          'A human rejection: the proposed run leaves the approval queue as rejected and nothing is applied. '
          + 'A second rejection replays; an applied run refuses.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id — always explicit, never inferred.' },
          { name: 'runSourceKey', type: 'string', hint: 'The proposed run to reject.' },
          { name: 'reason', type: 'string', hint: 'Optional: why, in one line.' },
        ],
        create(runtime) {
          const ops = opsFor(runtime);
          return (request) => ops.rejectRun(request);
        },
      },
      {
        operationContract: 1,
        name: 'revise-run',
        appMethod: 'reviseTeammateRun',
        label: 'Edit a proposal before approving',
        description:
          'A human edit of one proposal of a proposed run: the fields given are merged over its payload and '
          + 'validated again; the action stays the agent one and the run keeps waiting for approval.',
        input: [
          { name: 'spaceId', type: 'string', hint: 'The Accordo space id — always explicit, never inferred.' },
          { name: 'runSourceKey', type: 'string', hint: 'The proposed run to edit.' },
          { name: 'index', type: 'integer', hint: 'Which proposal (0 for the first).' },
          { name: 'payload', type: 'json', hint: 'The payload fields to change, e.g. { "text": "..." }.' },
        ],
        create(runtime) {
          const ops = opsFor(runtime);
          return (request) => ops.reviseRun(request);
        },
      },
    ],
  });
  return graph;
}

export { AGENT_APPLY_PERMISSION };
// backlog:33782ba68747: the ready-made agents the backoffice «Catalogo» offers.
export { AGENT_CATALOG, catalogAgentSourceKey } from './catalog.js';
