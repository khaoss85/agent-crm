// @ts-check

import { AppError } from '../../core/index.js';

/**
 * Fake Google Contacts provider (backlog:3de717335694).
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no Google
 * credentials exist yet, and none are invented here): an in-memory double
 * that speaks the People API `people.connections.list` semantics the
 * enrichment import depends on, so the import is proven against paging,
 * tokens and field shapes without dialing Google. No network, no paid
 * enrichment service: the only sources this feature reads are this fake
 * (and the real People API once the deployment wires it) and email
 * signatures parsed locally.
 *
 * Modeled semantics (the subset the import needs, nothing more):
 * - `listConnections` pages with `pageSize`/`pageToken`; a token this fake
 *   did not issue refuses with `GOOGLE_CONTACTS_TOKEN_MALFORMED`, the way
 *   the Gmail adapter refuses a foreign history token.
 * - a person carries the People API shape the import reads: `resourceName`,
 *   `names[]`, `emailAddresses[]`, `phoneNumbers[]`, `organizations[]`.
 *   Nothing else is read, so nothing else is modeled.
 * - `expectedSecret` binds the fake to the space grant: every import call
 *   must then carry it as its call-time `secret`, or the call refuses with
 *   `GOOGLE_GRANT_REFUSED`, the way the calendar fake refuses without its
 *   OAuth grant. Unset, the fake stays permissive for unwired tests.
 */

export const GOOGLE_CONTACTS_TOKEN_MALFORMED = 'GOOGLE_CONTACTS_TOKEN_MALFORMED';
export const GOOGLE_GRANT_REFUSED = 'GOOGLE_GRANT_REFUSED';

const MAX_PAGE_SIZE = 500;

function fakeError(code, status, message) {
  return new AppError(message, { code, status });
}

function encodeToken(index) {
  return Buffer.from(String(index), 'utf8').toString('base64url');
}

function decodeToken(pageToken) {
  if (pageToken === null || pageToken === undefined || pageToken === '') return 0;
  let index = -1;
  try {
    index = Number.parseInt(Buffer.from(String(pageToken), 'base64url').toString('utf8'), 10);
  } catch {
    index = -1;
  }
  if (!Number.isSafeInteger(index) || index < 0) {
    throw fakeError(GOOGLE_CONTACTS_TOKEN_MALFORMED, 422, 'Google Contacts page token is not one this source issued');
  }
  return index;
}

/**
 * @param {{ expectedSecret?: string }} [options]
 */
export function createFakeGoogleContacts(options = {}) {
  const expectedSecret = typeof options.expectedSecret === 'string' && options.expectedSecret !== ''
    ? options.expectedSecret
    : null;
  /** @type {Array<any>} */
  const people = [];

  function requireGrant(params) {
    if (expectedSecret === null) return;
    if (!params || params.secret !== expectedSecret) {
      throw fakeError(GOOGLE_GRANT_REFUSED, 401, 'google contacts refused: the call carries no grant for this space');
    }
  }

  return {
    /** Seed one person directly (test setup): People API shape, no sync involved. */
    seedPerson(person) {
      const index = people.length;
      const stored = {
        resourceName: typeof person?.resourceName === 'string' && person.resourceName !== ''
          ? person.resourceName
          : `people/c${index + 1}`,
        names: Array.isArray(person?.names) ? person.names : [],
        emailAddresses: Array.isArray(person?.emailAddresses) ? person.emailAddresses : [],
        phoneNumbers: Array.isArray(person?.phoneNumbers) ? person.phoneNumbers : [],
        organizations: Array.isArray(person?.organizations) ? person.organizations : [],
      };
      people.push(stored);
      return Object.freeze({ ...stored });
    },

    /** People API `people.connections.list`, paged. */
    listConnections(params = {}) {
      requireGrant(params);
      const start = decodeToken(params.pageToken);
      if (start > people.length) {
        throw fakeError(GOOGLE_CONTACTS_TOKEN_MALFORMED, 422, 'Google Contacts page token is not one this source issued');
      }
      const size = params.pageSize === undefined || params.pageSize === null ? 100 : Number(params.pageSize);
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_PAGE_SIZE) {
        throw fakeError(GOOGLE_CONTACTS_TOKEN_MALFORMED, 422, 'Google Contacts page size must be 1-500');
      }
      const connections = people.slice(start, start + size).map((person) => Object.freeze({ ...person }));
      const next = start + size < people.length ? encodeToken(start + size) : null;
      return Object.freeze({ connections: Object.freeze(connections), nextPageToken: next });
    },

    /** How many people are seeded (test assertions). */
    size() {
      return people.length;
    },
  };
}
