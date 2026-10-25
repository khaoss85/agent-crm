// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
import { buildSpacePermissionActions } from './actions.js';
import { createSpacePermissionGateCapability } from './capability.js';
import { SPACE_AI_PERMISSIONS } from './permissions.js';
import {
  SPACE_PACKAGE_CATALOG,
  createEffectiveSpaceAiPermissionsOperation,
  createSetSpaceAiPermissionOperation,
  createSpacePackageOperations,
} from './composition.js';

/**
 * The Space Permissions domain package (BO-F0-06 — backoffice
 * "08 Spazi e accessi").
 *
 * It owns the five AI switches of a space and the proposals a switched-off
 * action becomes: per-space overrides (`space-permission-override`) and
 * human-decided action proposals (`space-ai-proposal`). Any other package
 * gates its AI actions through the `space-permission-gate@1` capability:
 * `allow` runs, `proposal` records and stops — nothing executes on the
 * proposal path, structurally.
 *
 * **The space itself lives in the control plane.** This package stores no
 * spaces, no members and no invitations: the space id is an opaque string the
 * control plane issued, checked for shape and never for existence. Invitation
 * assignment (role plus response channels) is validated by
 * `reviewSpaceInvite`, not stored: membership is control-plane data.
 *
 * What this package does NOT do, deliberately: spaces, members, invitations
 * storage, roles beyond the control-plane mirror, provider sends, approval
 * of anything but one proposed AI action, execution of an approved action.
 * Those are the control plane's, the pilot's, or a later package's.
 *
 * Composition is one static import in `packages/domains/generated/index.js`
 * (a project that does not want it removes the line and keeps working);
 * the kernel never imports this package.
 */

export const SPACE_PERMISSIONS_DOMAIN = 'space-permissions';

/** The record modules this package owns. `resources` declares ownership, so a second package claiming one is a startup collision. */
export const SPACE_PERMISSIONS_RESOURCES = Object.freeze([
  'space-permission-override', 'space-ai-proposal', 'space-package',
]);

/**
 * Build the domain definition the application composes.
 *
 * @param {{config?: Record<string, string>}} [options] `config` carries record-module renames.
 */
export function createSpacePermissionsDomain(options = {}) {
  const config = options.config;

  const pkg = definePackage({
    packageContract: 1,
    name: SPACE_PERMISSIONS_DOMAIN,
    // 1: BO-F0-06 — five AI switches per space with send-without-approval off
    // by default, switched-off actions recorded as human-decided proposals.
    version: 1,
    label: 'Space AI permissions',
    description:
      'Per-space AI switches with human approval: five permission keys with effective defaults, per-space overrides, and proposals a switched-off action becomes instead of running. Stores no spaces, members or invitations.',
    resources: [...SPACE_PERMISSIONS_RESOURCES],
    capabilities: [
      createSpacePermissionGateCapability(config),
    ],
    actions: buildSpacePermissionActions(config),
    policies: [],
    // BO-F4-01 Personalizzazione: per-space activation of framework packages
    // and agent skills, recorded in `space-package`, plus the read-only
    // "Prova" preview. The routes in `apps/server` delegate to these app
    // methods when the package is composed and answer an honest 404 without
    // it — same pattern as the channels operations.
    operations: [
      {
        operationContract: 1,
        name: 'preview-space-package',
        label: 'Preview space package activation',
        appMethod: 'previewSpacePackage',
        description: 'Demonstrate a package or skill on one space\u2019s real rows without writing anything: activation state, per-module counts, one real row as the example.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'Opaque space id issued by the control plane.' },
          { name: 'unit', type: 'string', required: true, hint: 'A catalog unit: a package slug or skill:<slug>.' },
        ],
        create(runtime) {
          const ops = createSpacePackageOperations({ modules: runtime.modules });
          return (params) => ops.preview(params);
        },
      },
      {
        operationContract: 1,
        name: 'activate-space-package',
        label: 'Activate space package',
        appMethod: 'activateSpacePackage',
        description: 'Record that a space switched a package or skill on. Repeating it replays; a removed unit reactivates. Every write names its actor.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'Opaque space id issued by the control plane.' },
          { name: 'unit', type: 'string', required: true, hint: 'A catalog unit: a package slug or skill:<slug>.' },
        ],
        create(runtime) {
          const ops = createSpacePackageOperations({ modules: runtime.modules });
          return (params) => ops.activate(params);
        },
      },
      {
        operationContract: 1,
        name: 'deactivate-space-package',
        label: 'Deactivate space package',
        appMethod: 'deactivateSpacePackage',
        description: 'Record that a space switched a package or skill off. History is kept: the row flips to removed, never deleted.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'Opaque space id issued by the control plane.' },
          { name: 'unit', type: 'string', required: true, hint: 'A catalog unit: a package slug or skill:<slug>.' },
        ],
        create(runtime) {
          const ops = createSpacePackageOperations({ modules: runtime.modules });
          return (params) => ops.deactivate(params);
        },
      },
      {
        operationContract: 1,
        name: 'effective-space-ai-permissions',
        label: 'Effective space AI permissions',
        appMethod: 'effectiveSpaceAiPermissions',
        description: 'Read the five AI switches of one space with their effective values: the only HTTP-reachable read path (BO-F0-06). The generic records surface cannot filter this module by space, so this operation scopes server-side and resolves through the same defaults the gate uses.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'Opaque space id issued by the control plane.' },
        ],
        create(runtime) {
          const ops = createEffectiveSpaceAiPermissionsOperation({ modules: runtime.modules });
          return (params) => ops.effective(params);
        },
      },
      {
        operationContract: 1,
        name: 'set-space-ai-permission',
        label: 'Set space AI permission',
        appMethod: 'setSpaceAiPermission',
        description: 'Flip one of the five AI switches of one space: the only HTTP-reachable flip path (BO-F0-06). Human user actor only; anonymous, agent and system flips are refused with the same codes as the record action.',
        input: [
          { name: 'spaceId', type: 'string', required: true, hint: 'Opaque space id issued by the control plane.' },
          { name: 'permission', type: 'string', required: true, hint: `One of: ${SPACE_AI_PERMISSIONS.join(', ')}.` },
          { name: 'enabled', type: 'string', required: true, hint: 'on lets the agent act alone; off turns the action into a proposal.' },
        ],
        create(runtime) {
          const ops = createSetSpaceAiPermissionOperation({ modules: runtime.modules, database: runtime.database });
          return (params) => ops.set(params);
        },
      },
    ],
    /** Function-free, additive schema metadata. The registry publishes
     * `resources` from the composition, so restating it here is refused. */
    metadata() {
      return {
        notModeled: [
          'spaces: the control plane owns spaces; the space id is opaque here',
          'space members: membership lives in the control plane, never in a framework record',
          'invitations: assignment shape is validated (reviewSpaceInvite), never stored',
          'approved-action execution: approval authorizes one action; running it is the consumer\u2019s job',
          'provider sends: this package holds no credential and contacts no provider',
        ],
      };
    },
  });

  return selectPackageGraph(pkg, options.packageContract === 2 ? 2 : 1);
}

export {
  SPACE_AI_PERMISSIONS,
  SPACE_AI_PERMISSION_DEFAULTS,
  checkPermissionKey,
  checkSpaceId,
  effectivePermission,
  evaluateAiPermission,
  resolveSpacePermissions,
} from './permissions.js';
export { RESPONSE_CHANNELS, SPACE_ROLES, reviewSpaceInvite } from './invites.js';
export {
  PROPOSAL_STATES,
  PROPOSAL_TERMINAL,
  buildAiProposal,
  decideAiProposal,
  escapeKeyPart,
} from './proposals.js';
export {
  buildDecideAction,
  buildProposeAction,
  buildSetPermissionAction,
  buildSpacePermissionActions,
  isUniqueConflict,
  requireIdentifiedActor,
  scopeKeyFor,
} from './actions.js';
export { createSpacePermissionGateCapability } from './capability.js';
export {
  SPACE_PACKAGE_CATALOG,
  compositionKeyFor,
  createEffectiveSpaceAiPermissionsOperation,
  createSetSpaceAiPermissionOperation,
  createSpacePackageOperations,
  lookupSpacePackageUnit,
} from './composition.js';
