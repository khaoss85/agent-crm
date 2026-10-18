// @ts-check

import { AppError } from '../../core/index.js';
import { defineCustomerMatchPolicy } from './policy.js';
import { createChannelSenderResolution } from './sender.js';
import { resolvedNames } from './store.js';

/**
 * `channel-sender@1` — the one write capability this package offers, because
 * it has a real consumer: the channels initial history import
 * (backlog:66282d13d81c), which reconciles every imported sender to its
 * contact through this path instead of a second identity store.
 *
 * The consumer is a package, not an app operation, so the capability opens
 * on the consumer's runtime: `create({ modules, core, ... })` hands back a
 * `resolveSender` bound to the provider's own module-name resolution and
 * match policy — exactly one name resolution, the provider's — while the
 * storage handle, event bus and core adapters arrive from the opener. An
 * opener that cannot supply them fails closed naming the edge, never with
 * a missing-module stack trace at import time.
 *
 * Writes are the resolution's own, unchanged: matched refreshes the
 * sighting, an unknown sender carrying an email creates its contact,
 * ambiguous evidence becomes an unresolved duplicate-candidate for a human
 * and is never merged. The capability adds no decision of its own.
 */
export function createChannelSenderCapability({ config, policy } = {}) {
  const names = resolvedNames(config);
  const matchPolicy = policy ?? defineCustomerMatchPolicy();

  return {
    name: 'channel-sender',
    version: 1,
    description:
      'Resolve one channel sender to its contact through the external-identity records and the deterministic '
      + 'customer match policy: matched names the contact, an unknown sender carrying an email creates it, '
      + 'ambiguous evidence stays an unresolved duplicate-candidate for a human. Opens on the consumer runtime.',
    /** @param {{modules?: any, core?: any, database?: any, events?: any, actor?: unknown, consumer?: string}} [context] */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('channel-sender@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      const identityService = modules.get(names.identity)?.service ?? null;
      const database = context?.database ?? identityService?.database ?? null;
      const events = context?.events ?? identityService?.events ?? null;
      const core = context?.core ?? null;
      if (!core || typeof core.findContactByEmail !== 'function' || typeof core.createContact !== 'function') {
        throw new AppError(
          'channel-sender@1 requires the caller\'s core contact adapters (findContactByEmail, createContact): '
          + 'open it from an application runtime, e.g. { modules: runtime.modules, core: runtime.core }',
          { code: 'CAPABILITY_CONTEXT_INVALID', status: 500 },
        );
      }
      // database and events fall through to the resolution's own
      // validation, which names the missing handle the same way the
      // resolve-channel-sender operation would.
      const resolution = createChannelSenderResolution({
        database, modules, events, core, policy: matchPolicy, names,
      });
      const defaultActor = context?.actor;
      return Object.freeze({
        capabilityContract: 1,
        /**
         * Resolve one sender. The request actor wins when present; else the
         * actor the capability was opened with; else the resolution's own
         * anonymous actor — every write still carries an actor.
         * @param {any} request
         */
        resolveSender: (request) => resolution.resolveChannelSender(
          request?.actor === undefined && defaultActor !== undefined
            ? { ...request, actor: defaultActor }
            : request,
        ),
      });
    },
  };
}
