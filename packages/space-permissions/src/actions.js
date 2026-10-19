// @ts-check

import { AppError, ConflictError, ValidationError } from '../../core/index.js';
import {
  SPACE_AI_PERMISSIONS,
  checkPermissionKey,
  checkSpaceId,
  effectivePermission,
} from './permissions.js';
import { buildAiProposal, decideAiProposal } from './proposals.js';

/**
 * The unique constraint picked a winner between two concurrent writers. The
 * loser re-reads the winner's row and answers from it instead of surfacing a
 * driver error — the work package's `createFollowUp` contract, reused here.
 *
 * @param {unknown} error
 */
function isUniqueConflict(error) {
  return error instanceof ConflictError;
}

/**
 * The `space-permission-override` and `space-ai-proposal` record actions.
 *
 * `set-permission` flips one of the five switches of one space. It is
 * input-driven: the switch rows exist only once a space flips one, so the
 * first flip creates the row and later flips patch it. Every write names its
 * actor; an anonymous flip is refused.
 *
 * `propose-action` records what a switched-off action wanted to do. The same
 * action proposed twice replays the first proposal — a retry never opens a
 * second approval for the same work.
 *
 * `approve` and `refuse` run on the proposal record and are human-only: an
 * agent may prepare and propose, it may never decide. Approval authorizes that
 * one action; executing it stays the consumer's job, outside this package.
 */

/** @param {Record<string, string>} [config] module renames */
function resolvedNames(config = {}) {
  return {
    override: config?.overrideModule ?? 'space-permission-override',
    proposal: config?.proposalModule ?? 'space-ai-proposal',
  };
}

/** Trusted managed storage handle; a CRUD-writable module is refused. */
function trusted(modules, name, code) {
  const service = modules?.get?.(name)?.service;
  if (!service || typeof service.createManaged !== 'function') {
    throw new AppError(`Module "${name}" is not a read-only managed record module — regenerate it from the current manifest`, {
      code, status: 500,
    });
  }
  return service;
}

/** An identified actor: user or system with an id. Anonymous writes stop here. */
/** @param {unknown} actor @param {string} what */
function requireIdentifiedActor(actor, what) {
  if (!actor || typeof actor !== 'object'
    || typeof actor.type !== 'string' || actor.type.trim() === ''
    || typeof actor.id !== 'string' || actor.id.trim() === '') {
    throw new AppError(`${what} requires an identified actor`, {
      code: 'SPACE_ACTOR_REQUIRED', status: 403,
    });
  }
  return `${actor.type}:${actor.id}`;
}

/**
 * `space-permission-override.set-permission` — flip one switch of one space.
 *
 * @param {Record<string, string>} [config] module renames
 */
export function buildSetPermissionAction(config) {
  const names = resolvedNames(config);
  return {
    module: names.override,
    name: 'set-permission',
    label: 'Set space AI permission',
    description: 'Flip one of the five AI switches of one space. Creates the switch row on the first flip, patches it after. Records which actor flipped it.',
    actionContract: 1,
    confirm: true,
    input: [
      { name: 'spaceId', type: 'string', required: true, hint: 'Opaque space id issued by the control plane.' },
      { name: 'permission', type: 'string', required: true, hint: `One of: ${SPACE_AI_PERMISSIONS.join(', ')}.` },
      { name: 'enabled', type: 'enum', values: ['on', 'off'], required: true, hint: 'on lets the agent act alone; off turns the action into a proposal.' },
    ],
    /** @param {any} ctx */
    async execute({ input, actor, modules, managed, now, step }) {
      const by = requireIdentifiedActor(actor, 'Flipping a space AI switch');
      const spaceId = checkSpaceId(input?.spaceId);
      const permission = checkPermissionKey(input?.permission);
      if (input?.enabled !== 'on' && input?.enabled !== 'off') {
        throw new ValidationError('enabled must be on or off', { field: 'enabled' });
      }
      const enabled = input.enabled === 'on';
      const store = trusted(modules, names.override, 'SPACE_PERMISSIONS_STORAGE_INVALID');
      const at = now();
      const scopeKey = `${spaceId}:${permission}`;
      const existing = await store.listWhere({ spaceId });
      const current = Array.isArray(existing)
        ? existing.find((row) => row && (row.scopeKey === scopeKey || row.permission === permission))
        : null;
      if (current) {
        await managed(current.id, { enabled, updatedBy: by, updatedAt: at });
        step('space-permission.updated', { spaceId, permission, enabled });
        return { spaceId, permission, enabled, created: false };
      }
      try {
        const created = await store.createManaged({
          spaceId, scopeKey, permission, enabled, updatedBy: by, updatedAt: at,
        }, { actor });
        step('space-permission.created', { spaceId, permission, enabled });
        return { spaceId, permission, enabled, created: true, id: created.id };
      } catch (error) {
        // A concurrent first flip won the unique scopeKey. Patch the winner.
        if (!isUniqueConflict(error)) throw error;
        const raced = await store.listWhere({ spaceId });
        const winner = Array.isArray(raced)
          ? raced.find((row) => row && (row.scopeKey === scopeKey || row.permission === permission))
          : null;
        if (!winner) throw error;
        await managed(winner.id, { enabled, updatedBy: by, updatedAt: at });
        step('space-permission.raced', { spaceId, permission, enabled });
        return { spaceId, permission, enabled, created: false };
      }
    },
  };
}

/**
 * `space-ai-proposal.propose-action` — record what a switched-off action
 * wanted to do. Fails closed when the switch is on: proposing what the space
 * already allows is a caller bug, refused with a code.
 *
 * @param {Record<string, string>} [config] module renames
 */
export function buildProposeAction(config) {
  const names = resolvedNames(config);
  return {
    module: names.proposal,
    name: 'propose-action',
    label: 'Propose space AI action',
    description: 'Record the AI action a switched-off permission blocked, as a proposal for a human. Replays the open proposal when the same action is proposed twice.',
    actionContract: 1,
    input: [
      { name: 'spaceId', type: 'string', required: true, hint: 'Opaque space id issued by the control plane.' },
      { name: 'permission', type: 'string', required: true, hint: `One of: ${SPACE_AI_PERMISSIONS.join(', ')}.` },
      { name: 'actionKind', type: 'string', required: true, hint: 'What the agent wanted to do, in the consumer package\u2019s words.' },
      { name: 'actionKey', type: 'string', required: true, hint: 'Stable key of this one action: same key replays, never duplicates.' },
      { name: 'summary', type: 'string', required: true, hint: 'Bounded human-readable summary of the blocked action.' },
    ],
    /** @param {any} ctx */
    async execute({ input, actor, modules, now, step }) {
      requireIdentifiedActor(actor, 'Proposing a space AI action');
      const overrides = trusted(modules, names.override, 'SPACE_PERMISSIONS_STORAGE_INVALID');
      const proposals = trusted(modules, names.proposal, 'SPACE_PERMISSIONS_STORAGE_INVALID');
      const record = input && typeof input === 'object' ? input : {};
      const spaceId = checkSpaceId(record.spaceId);
      const permission = checkPermissionKey(record.permission);
      const stored = await overrides.listWhere({ spaceId });
      if (effectivePermission(permission, Array.isArray(stored) ? stored : [])) {
        throw new AppError(`Permission "${permission}" is on in this space: act, do not propose`, {
          code: 'SPACE_PERMISSION_ENABLED', status: 409,
        });
      }
      const at = now();
      const draft = buildAiProposal({ ...record, spaceId, permission, proposedAt: at });
      const siblings = await proposals.listWhere({ spaceId });
      const open = Array.isArray(siblings)
        ? siblings.find((row) => row && row.sourceKey === draft.sourceKey && row.status === 'proposed')
        : null;
      if (open) {
        step('space-ai-proposal.replayed', { proposalId: open.id, sourceKey: draft.sourceKey });
        return { proposalId: open.id, replayed: true, sourceKey: draft.sourceKey };
      }
      try {
        const created = await proposals.createManaged({ ...draft }, { actor });
        step('space-ai-proposal.proposed', { proposalId: created.id, sourceKey: draft.sourceKey });
        return { proposalId: created.id, replayed: false, sourceKey: draft.sourceKey };
      } catch (error) {
        // A concurrent proposal won the unique sourceKey. An open winner
        // replays; an already-decided one ends here with a code — a new round
        // is a new action key, never a rewrite of the decided row.
        if (!isUniqueConflict(error)) throw error;
        const raced = await proposals.listWhere({ spaceId });
        const winner = Array.isArray(raced)
          ? raced.find((row) => row && row.sourceKey === draft.sourceKey)
          : null;
        if (!winner) throw error;
        if (winner.status === 'proposed') {
          step('space-ai-proposal.raced', { proposalId: winner.id, sourceKey: draft.sourceKey });
          return { proposalId: winner.id, replayed: true, sourceKey: draft.sourceKey };
        }
        throw new AppError(`This action was already ${winner.status}; a new round needs a new action key`, {
          code: 'SPACE_PROPOSAL_DECIDED', status: 409,
        });
      }
    },
  };
}

/**
 * `space-ai-proposal.approve` / `refuse` — the human decision on the record.
 *
 * @param {Record<string, string>} [config] module renames
 */
export function buildDecideAction(decision, config) {
  const names = resolvedNames(config);
  return {
    module: names.proposal,
    name: decision,
    label: decision === 'approved' ? 'Approve space AI action' : 'Refuse space AI action',
    description: `Decide this proposed AI action as a human user. ${decision === 'approved' ? 'Approval authorizes that one action; executing it stays the consumer\u2019s job.' : 'Refusal ends it with a reason.'}`,
    actionContract: 1,
    confirm: true,
    input: decision === 'refused'
      ? [{ name: 'refusalReason', type: 'string', required: false, hint: 'Why this action must not run.' }]
      : [],
    /** @param {any} ctx */
    async execute({ record: proposal, input, actor, managed, now, step }) {
      if (!actor || typeof actor !== 'object' || actor.type !== 'user') {
        throw new AppError(`Deciding a space AI proposal requires a human user actor (wanted ${decision})`, {
          code: 'HUMAN_APPROVAL_REQUIRED', status: 403,
        });
      }
      const { patch } = decideAiProposal({
        proposal,
        decision,
        actorId: actor.id,
        decidedAt: now(),
        refusalReason: input?.refusalReason,
      });
      await managed(proposal.id, { ...patch });
      step(`space-ai-proposal.${decision}`, { proposalId: proposal.id });
      return { proposalId: proposal.id, status: patch.status };
    },
  };
}

/** @param {Record<string, string>} [config] */
export function buildSpacePermissionActions(config = {}) {
  return [
    buildSetPermissionAction(config),
    buildProposeAction(config),
    buildDecideAction('approved', config),
    buildDecideAction('refused', config),
  ];
}
