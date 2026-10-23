// @ts-check

import { AppError } from '../../core/index.js';
import {
  SPACE_AI_PERMISSIONS,
  checkPermissionKey,
  checkSpaceId,
  evaluateAiPermission,
  resolveSpacePermissions,
} from './permissions.js';
import { buildAiProposal } from './proposals.js';
import { isUniqueConflict, requireIdentifiedActor } from './actions.js';

/**
 * What Space Permissions offers to **other packages** — the gate every AI
 * action in a space passes before it runs.
 *
 * `space-permission-gate@1` answers `gate({spaceId, permission})` with
 * `{decision: 'allow'}` or `{decision: 'proposal'}`. A consumer that receives
 * `proposal` records the proposal (through `propose`, inside its own
 * transaction) and stops: the action is never executed on that path, and no
 * method here executes anything on the caller's behalf.
 *
 * Reads are space-scoped by construction: there is no method that lists
 * another space's switches or proposals, so one space stays invisible from
 * the others structurally, not by discipline.
 */

/** @param {any} modules @param {string} name */
function service(modules, name) {
  const module = modules.get(name);
  if (!module?.service || typeof module.service.listWhere !== 'function') {
    throw new AppError(`The space-permissions package is installed without readable "${name}" records`, {
      code: 'SPACE_PERMISSIONS_STORAGE_INVALID', status: 500,
    });
  }
  return module.service;
}

/** @param {any} context @param {string} capability */
function requireModules(context, capability) {
  const modules = context?.modules;
  if (!modules || typeof modules.get !== 'function') {
    throw new AppError(`${capability} requires the caller's modules view`, {
      code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
    });
  }
  return modules;
}

function mapValue(value, map) {
  return value && typeof value.then === 'function' ? value.then(map) : map(value);
}

/**
 * `space-permission-gate@1` — gate one AI action, record its proposal.
 *
 * @param {Record<string, string>} [config] module renames
 */
export function createSpacePermissionGateCapability(config) {
  const names = {
    override: config?.overrideModule ?? 'space-permission-override',
    proposal: config?.proposalModule ?? 'space-ai-proposal',
  };
  return {
    name: 'space-permission-gate',
    version: 1,
    description:
      'Gate AI actions per space: allow what the space switched on, propose what it switched off. Records proposals inside the caller\u2019s transaction; executes nothing, grants no cross-space read and no approval.',
    /**
     * @param {{modules?: any, consumer?: string, now?: () => string}} context
     * `now` is the server clock the capability stamps proposals with; without
     * it the wall clock is used. The caller's clock is never trusted.
     */
    create(context = {}) {
      const modules = requireModules(context, 'space-permission-gate@1');
      const serverNow = typeof context.now === 'function' ? context.now : () => new Date().toISOString();
      return {
        capabilityContract: 1,

        /**
         * All five effective values of one space, frozen.
         * @param {unknown} spaceId
         */
        effective(spaceId) {
          const id = checkSpaceId(spaceId);
          return mapValue(service(modules, names.override).listWhere({ spaceId: id }),
            (rows) => resolveSpacePermissions(id, Array.isArray(rows) ? rows : []));
        },

        /**
         * Gate one AI action of one space: allow it, or turn it into a
         * proposal. Frozen, never an execution.
         * @param {{spaceId: unknown, permission: unknown}} input
         */
        gate(input) {
          const record = input && typeof input === 'object' ? input : {};
          const id = checkSpaceId(record.spaceId);
          const permission = checkPermissionKey(record.permission);
          return mapValue(service(modules, names.override).listWhere({ spaceId: id }),
            (rows) => evaluateAiPermission({
              spaceId: id,
              permission,
              overrideRows: Array.isArray(rows) ? rows : [],
            }));
        },

        /**
         * Record the proposal for a gated-off action inside the caller's
         * transaction. Replays the open proposal for the same action key.
         * The caller names who proposes (`actor`, identified, never
         * anonymous — refused with `SPACE_ACTOR_REQUIRED`); the stamp comes
         * from the server clock, never from the caller, so `proposedAt` is
         * not an input field.
         * @param {{spaceId: unknown, permission: unknown, actionKind: unknown, actionKey: unknown, summary: unknown, actor?: unknown}} input
         */
        propose(input) {
          const record = input && typeof input === 'object' ? input : {};
          const id = checkSpaceId(record.spaceId);
          const permission = checkPermissionKey(record.permission);
          // Identified callers only: anonymous or malformed actors stop here,
          // before any row is read or written. The canonical form (closed
          // type set, trimmed id) is what the row and the audit log record.
          requireIdentifiedActor(record.actor, 'Proposing a space AI action');
          const proposals = service(modules, names.proposal);
          const overrides = service(modules, names.override);
          const run = async () => {
            const stored = await overrides.listWhere({ spaceId: id });
            const verdict = evaluateAiPermission({
              spaceId: id, permission, overrideRows: Array.isArray(stored) ? stored : [],
            });
            if (verdict.decision !== 'proposal') {
              throw new AppError(`Permission "${permission}" is on in this space: act, do not propose`, {
                code: 'SPACE_PERMISSION_ENABLED', status: 409,
              });
            }
            const draft = buildAiProposal({
              ...record, spaceId: id, permission, proposedAt: serverNow(),
            });
            const siblings = await proposals.listWhere({ spaceId: id });
            const open = Array.isArray(siblings)
              ? siblings.find((row) => row && row.sourceKey === draft.sourceKey && row.status === 'proposed')
              : null;
            if (open) return Object.freeze({ proposalId: open.id, replayed: true });
            if (typeof proposals.createManaged !== 'function') {
              throw new AppError(`Module "${names.proposal}" is not a read-only managed record module`, {
                code: 'SPACE_PERMISSIONS_STORAGE_INVALID', status: 500,
              });
            }
            try {
              const created = await proposals.createManaged({ ...draft }, { actor: record.actor ?? null });
              return Object.freeze({ proposalId: created.id, replayed: false });
            } catch (error) {
              if (!isUniqueConflict(error)) throw error;
              const raced = await proposals.listWhere({ spaceId: id });
              const winner = Array.isArray(raced)
                ? raced.find((row) => row && row.sourceKey === draft.sourceKey)
                : null;
              if (!winner) {
                throw new AppError('This proposal raced a concurrent write; retry with the same action key', {
                  code: 'SPACE_PROPOSAL_CONFLICT', status: 409,
                });
              }
              if (winner.status === 'proposed') {
                return Object.freeze({ proposalId: winner.id, replayed: true });
              }
              throw new AppError(`This action was already ${winner.status}; a new round needs a new action key`, {
                code: 'SPACE_PROPOSAL_DECIDED', status: 409,
              });
            }
          };
          return run();
        },

        /**
         * One proposal row of this space, or null. A row of another space is
         * unreachable: the caller names the space, and the match is exact.
         * @param {unknown} spaceId @param {unknown} proposalId
         */
        proposal(spaceId, proposalId) {
          const id = checkSpaceId(spaceId);
          if (typeof proposalId !== 'string' || proposalId === '') return Object.freeze(null);
          return mapValue(service(modules, names.proposal).listWhere({ spaceId: id }),
            (rows) => {
              const row = Array.isArray(rows) ? rows.find((item) => item && item.id === proposalId) : null;
              return row ? Object.freeze({ ...row }) : Object.freeze(null);
            });
        },

        /**
         * The decided (or still open) proposal for one action of this space,
         * or null. A consumer that recorded a proposal and then lost its own
         * row-local pointer (a crash between `propose` and the consumer's
         * write) recovers the winner here instead of re-proposing blindly:
         * `propose` answers such a retry with `SPACE_PROPOSAL_DECIDED` and no
         * id, so without this lookup the decision would be unreachable and
         * the action would wedge. Additive: existing consumers keep working.
         * @param {unknown} spaceId @param {unknown} permission @param {unknown} actionKey
         */
        proposalForAction(spaceId, permission, actionKey) {
          const id = checkSpaceId(spaceId);
          const key = checkPermissionKey(permission);
          if (typeof actionKey !== 'string' || actionKey === '') return Object.freeze(null);
          return mapValue(service(modules, names.proposal).listWhere({ spaceId: id }),
            (rows) => {
              const row = Array.isArray(rows)
                ? rows.find((item) => item && item.permission === key && item.actionKey === actionKey)
                : null;
              return row ? Object.freeze({ ...row }) : Object.freeze(null);
            });
        },
      };
    },
  };
}

export { SPACE_AI_PERMISSIONS };
