// @ts-check

/**
 * Checked-in registry of optional domain packages (ADR-018 addendum).
 *
 * A domain package owns its records, actions and versioned policies and is
 * registered here by static import — the same code-first pattern used for
 * actions, pipelines, intelligence, commercial and signature.
 *
 * This repository ships the reference CRM composition (customer-data,
 * space-permissions, channels, sequences, work, magic-link). A generated project starts
 * empty instead: `create-accordo` overwrites this copied file with the empty
 * composition, because composition is one line a human adds deliberately.
 *
 * The kernel never imports a domain package; composition happens only here.
 * Removing a line here removes the whole domain, and the application must
 * keep working without it.
 *
 * Example:
 *
 *   import { createContractsDomain } from '../../contracts/src/index.js';
 *   export const generatedDomains = [createContractsDomain()];
 */

import { createCustomerDataPackage } from '../../customer-data/src/index.js';
import { createSpacePermissionsDomain } from '../../space-permissions/src/index.js';
import { createChannelsPackage } from '../../channels/src/index.js';
import { createMagicLinkPackage, createMemoryMagicLinkStore } from '../../magic-link/src/index.js';
import { createSequencesPackage } from '../../sequences/src/index.js';
import { createWorkPackage } from '../../work/src/index.js';

export const generatedDomains = [
  createCustomerDataPackage(),
  createSpacePermissionsDomain(),
  createChannelsPackage(),
  // BO-F6-06 slice 1 (backlog:ed4bbd35883a): local composition only. The
  // memory store lets the reference app boot with the login domain; the
  // deployment-owned edges (directory, outbox, secret custody) stay unwired,
  // so request refuses with MAGIC_LINK_NOT_CONFIGURED and an unknown token
  // stays MAGIC_LINK_INVALID until the deployment wires them. No
  // credentials, no transport, no Google machinery.
  createMagicLinkPackage({ store: createMemoryMagicLinkStore() }),
  createSequencesPackage(),
  createWorkPackage(),
];
