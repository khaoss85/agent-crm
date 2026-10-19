// @ts-check

import { definePackage, selectPackageGraph } from '../../core/index.js';
import { buildSpacePermissionActions } from './actions.js';
import { createSpacePermissionGateCapability } from './capability.js';

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
  'space-permission-override', 'space-ai-proposal',
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
    /** Function-free, additive schema metadata. */
    metadata() {
      return {
        resources: [...SPACE_PERMISSIONS_RESOURCES],
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
} from './proposals.js';
export {
  buildDecideAction,
  buildProposeAction,
  buildSetPermissionAction,
  buildSpacePermissionActions,
} from './actions.js';
export { createSpacePermissionGateCapability } from './capability.js';
