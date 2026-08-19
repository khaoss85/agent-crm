// @ts-check

import { AppError } from '../../core/index.js';
import { canonicalClusterFor } from './profile.js';
import { deciding, newestFirst, resolvedNames, subjectOf, trusted } from './store.js';

/**
 * `customer-identity@1` — the one capability this package offers, because it
 * is the one with a real consumer.
 *
 * The consumer is the profile surface and the Admin section built on it: both
 * need to ask "which records are this customer, and what does the outside
 * world call them" without reaching into this package's tables. Nothing else
 * is frozen here — a capability shaped for a consumer that does not exist yet
 * is a guess with a version number on it.
 *
 * Read-only by construction: it hands back frozen rows, no storage handle, no
 * decision path, and nothing that could link, dismiss or erase. Canonical
 * identity changes only through the human action, never through a capability.
 */
export function createCustomerIdentityCapability(config) {
  const names = resolvedNames(config);
  return {
    name: 'customer-identity',
    version: 1,
    description:
      'Read canonical customer identity and external identifiers for one record: which records a human linked as the same '
      + 'customer, which system calls it what, and the outstanding duplicate candidates. Grants no write, no linking, no '
      + 'deletion and no storage handle.',
    /** @param {{modules?: any, consumer?: string}} context */
    create(context = {}) {
      const modules = context?.modules;
      if (!modules || typeof modules.get !== 'function') {
        throw new AppError('customer-identity@1 requires the caller\'s modules view', {
          code: 'CAPABILITY_CONTEXT_INVALID', status: 500,
        });
      }
      return Object.freeze({
        capabilityContract: 1,

        /**
         * The canonical identity cluster for a record: its members and which
         * one is canonical. A record nobody has linked stands for itself —
         * reported honestly as `linked: false`, not as an empty cluster.
         * @param {{resource: string, id: string}} subject
         */
        canonicalIdentity(subject) {
          if (!subject || typeof subject.resource !== 'string' || typeof subject.id !== 'string') return null;
          return canonicalClusterFor({ modules, names, subject });
        },

        /**
         * Active external identifiers for one record, frozen.
         * @param {{resource: string, id: string}} subject
         */
        externalIdentities(subject) {
          if (!subject || typeof subject.resource !== 'string' || typeof subject.id !== 'string') return Object.freeze([]);
          // A complete read: a consumer asking "what does the outside world
          // call this record" must not be told "nothing" because the answer is
          // older than one display page of the identity table.
          return Object.freeze(deciding(trusted(modules, names.identity), {
            subjectResource: subject.resource, subjectId: subject.id, status: 'active',
          })
            .map((row) => Object.freeze({
              system: row.system,
              externalId: row.externalId,
              firstObservedAt: row.firstObservedAt,
              lastObservedAt: row.lastObservedAt,
            })));
        },

        /**
         * Which record an external identifier names, or null. The read a
         * second importer needs before it invents a duplicate.
         * @param {string} system @param {string} externalId
         */
        resolveExternalIdentity(system, externalId) {
          if (typeof system !== 'string' || typeof externalId !== 'string') return null;
          const row = trusted(modules, names.identity).listWhere({ sourceKey: `${system}:${externalId}` })
            .find((entry) => entry.status === 'active');
          return row ? subjectOf(row) : null;
        },

        /**
         * Outstanding duplicate candidates touching this record. Unresolved is
         * a real answer: this package never decides them.
         * @param {{resource: string, id: string}} subject
         */
        openDuplicateCandidates(subject) {
          if (!subject || typeof subject.resource !== 'string' || typeof subject.id !== 'string') return Object.freeze([]);
          // A candidate names two records, so both sides are asked for
          // completely and unioned by id.
          const candidates = trusted(modules, names.candidate);
          const rows = new Map();
          for (const side of [
            { leftResource: subject.resource, leftId: subject.id },
            { rightResource: subject.resource, rightId: subject.id },
          ]) {
            for (const row of deciding(candidates, { ...side, status: 'unresolved' })) rows.set(row.id, row);
          }
          return Object.freeze(newestFirst([...rows.values()])
            .map((row) => Object.freeze({
              id: row.id,
              left: subjectOf(row, 'left'),
              right: subjectOf(row, 'right'),
              rule: row.rule,
              evidence: row.evidence,
            })));
        },
      });
    },
  };
}
