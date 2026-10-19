// @ts-check

import { AppError, ConflictError } from '../../core/index.js';
import {
  SPACE_AI_PERMISSIONS,
  checkPermissionKey,
  checkSpaceId,
  evaluateAiPermission,
  resolveSpacePermissions,
} from './permissions.js';
import { buildAiProposal } from './proposals.js';

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
    /** @param {{modules?: any, consumer?: string}} context */
    create(context = {}) {
      const modules = requireModules(context, 'space-permission-gate@1');
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
         * @param {{spaceId: unknown, permission: unknown, actionKind: unknown, actionKey: unknown, summary: unknown, proposedAt: unknown, actor?: unknown}} input
         */
        propose(input) {
          const record = input && typeof input === 'object' ? input : {};
          const id = checkSpaceId(record.spaceId);
          const permission = checkPermissionKey(record.permission);
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
            const draft = buildAiProposal({ ...record, spaceId: id, permission });
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
              if (!(error instanceof ConflictError)) throw error;
              const raced = await proposals.listWhere({ spaceId: id });
              const winner = Array.isArray(raced)
                ? raced.find((row) => row && row.sourceKey === draft.sourceKey)
                : null;
              if (!winner) throw error;
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
      };
    },
  };
}

export { SPACE_AI_PERMISSIONS };
