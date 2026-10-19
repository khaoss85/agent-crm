// @ts-check

import {
  AppError,
  definePackage,
  selectPackageGraph,
  ValidationError,
} from '../../core/index.js';
import {
  MAGIC_LINK_CONTRACT,
  MAGIC_LINK_REASON,
  hashLoginEmail,
  isMagicLinkExpired,
  magicLinkExpiry,
  magicLinkRequestReceipt,
  mintMagicLinkToken,
  normalizeLoginEmail,
  requireMagicLinkToken,
} from './rules.js';
import { createMemoryMagicLinkStore } from './store.js';

/**
 * The magic-link login domain package (backlog:0cbae947, BO-F0-05).
 *
 * Passwordless login for the backoffice: a visitor types their work email,
 * a known address is sent a single-use link valid for ten minutes, and the
 * link redeems exactly once. Unknown addresses get the byte-identical
 * receipt — the response never says whether an address is registered.
 *
 * It reuses and never duplicates: error shapes (`core` errors), the closed
 * key idiom (`idempotency.js`), secret-by-reference custody (like
 * `site-forms` and `channels`: values never cross the boundary). It changes
 * no kernel file (ADR-018).
 *
 * What is deliberately NOT here:
 * - the send itself. This package persists the token row FIRST, then calls
 *   the deployment-owned `deliver` edge with the link. In production that
 *   edge enqueues through the channels outbox (outbound-send rule, proven
 *   with `tests/helpers/outbound-send-conformance.js` in the wiring turn);
 *   here it is injected, and every operation refuses until it is wired.
 * - Google sign-in. The framework owns no OAuth client and emits no Google
 *   request (see `tests/admin-login.test.js`): "Continua con Google" on the
 *   login page targets the deployment's entry, which the control plane
 *   already serves. This package never touches that path.
 * - rate limiting and durable storage. The memory store is the local/test
 *   default; a durable deployment backs `{save, find, spend}` with its
 *   database, where `spend` MUST stay one conditional write so concurrent
 *   consumes still elect one winner.
 *
 * @typedef {{ lookup: (normalizedEmail: string) => Promise<{ subject: string } | null> }} MagicLinkDirectory
 * @typedef {{ send: (message: { to: string, token: string, expiresAtIso: string }) => Promise<unknown> }} MagicLinkDeliver
 * @typedef {{ save: (record: any) => void, find: (tokenId: string) => any | null, spend: (tokenId: string) => boolean }} MagicLinkStore
 */

export const MAGIC_LINK_DOMAIN = 'magic-link';

/** @param {unknown} value */
function requireSubject(value) {
  if (typeof value !== 'string' || value === '' || value.length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new ValidationError('Magic-link directory subject must be bounded text', { field: 'subject' });
  }
  return value;
}

/**
 * @param {{ directory?: MagicLinkDirectory, deliver?: MagicLinkDeliver, store?: MagicLinkStore, clock?: () => number }} [options]
 */
function resolveEdges(options = {}) {
  const { directory, deliver, store, clock } = options;
  if (directory !== undefined && (typeof directory !== 'object' || directory === null || typeof directory.lookup !== 'function')) {
    throw new ValidationError('magic-link directory must expose lookup()', { field: 'directory' });
  }
  if (deliver !== undefined && (typeof deliver !== 'object' || deliver === null || typeof deliver.send !== 'function')) {
    throw new ValidationError('magic-link deliver must expose send()', { field: 'deliver' });
  }
  if (store !== undefined && (typeof store !== 'object' || store === null
    || typeof store.save !== 'function' || typeof store.find !== 'function' || typeof store.spend !== 'function')) {
    throw new ValidationError('magic-link store must expose save/find/spend', { field: 'store' });
  }
  if (clock !== undefined && typeof clock !== 'function') {
    throw new ValidationError('magic-link clock must be a function', { field: 'clock' });
  }
  return { directory, deliver, store, clock: clock ?? (() => Date.now()) };
}

function notConfigured(edge) {
  throw new AppError(`magic-link ${edge} is not wired: the deployment provides it`, {
    code: MAGIC_LINK_REASON.NOT_CONFIGURED, status: 500,
  });
}

/**
 * Request one link. Always resolves to the identical receipt — known and
 * unknown addresses are indistinguishable in the response. The token row is
 * persisted BEFORE the delivery edge runs (claim first, send second), so a
 * failed send never invents a link and a retry never mints a second row for
 * the same attempt... each request mints its own row; earlier pending rows
 * for the same address stay valid until they expire.
 *
 * @param {{ directory?: MagicLinkDirectory, deliver?: MagicLinkDeliver, store?: MagicLinkStore, clock: () => number }} edges
 * @param {{ email: unknown }} input
 */
export async function requestMagicLink(edges, input) {
  const email = normalizeLoginEmail(input?.email);
  const { directory, deliver, store, clock } = edges;
  if (!directory || !deliver || !store) notConfigured(!directory ? 'directory' : (!deliver ? 'deliver' : 'store'));
  let hit;
  try {
    hit = await /** @type {MagicLinkDirectory} */ (directory).lookup(email);
  } catch (error) {
    throw new AppError('magic-link directory is unavailable', {
      code: 'MAGIC_LINK_DIRECTORY_FAILED', status: 502,
    });
  }
  if (hit !== null && hit !== undefined) {
    const subject = requireSubject(hit.subject);
    const issuedAtMs = /** @type {() => number} */ (clock)();
    const record = {
      tokenId: mintMagicLinkToken(),
      emailHash: hashLoginEmail(email),
      subject,
      issuedAtMs,
      expiresAtMs: magicLinkExpiry(issuedAtMs),
      spent: false,
    };
    /** @type {MagicLinkStore} */ (store).save(record);
    try {
      await /** @type {MagicLinkDeliver} */ (deliver).send({
        to: email,
        token: record.tokenId,
        expiresAtIso: new Date(record.expiresAtMs).toISOString(),
      });
    } catch (error) {
      throw new AppError('magic-link delivery failed after the link was recorded', {
        code: 'MAGIC_LINK_DELIVERY_FAILED', status: 502,
      });
    }
  }
  return magicLinkRequestReceipt();
}

/**
 * Redeem one link. Malformed tokens are refused before any store is
 * touched. A well-formed token redeems exactly once: the conditional
 * `spend` elects one winner, every later use — however soon — is refused.
 * Returns the subject the directory named at issue time. Never the token,
 * never the address.
 *
 * @param {{ store?: MagicLinkStore, clock: () => number }} edges
 * @param {{ token: unknown }} input
 */
export async function consumeMagicLink(edges, input) {
  const tokenId = requireMagicLinkToken(input?.token);
  const { store, clock } = edges;
  if (!store) notConfigured('store');
  const row = /** @type {MagicLinkStore} */ (store).find(tokenId);
  if (!row || row.spent) {
    throw new AppError('magic link is unknown or already used', {
      code: MAGIC_LINK_REASON.INVALID, status: 401,
    });
  }
  if (isMagicLinkExpired(row, /** @type {() => number} */ (clock)())) {
    throw new AppError('magic link expired: request a new one', {
      code: MAGIC_LINK_REASON.EXPIRED, status: 401,
    });
  }
  const won = /** @type {MagicLinkStore} */ (store).spend(tokenId);
  if (!won) {
    throw new AppError('magic link is unknown or already used', {
      code: MAGIC_LINK_REASON.INVALID, status: 401,
    });
  }
  return { subject: requireSubject(row.subject), emailHash: row.emailHash };
}

/**
 * @param {{ directory?: MagicLinkDirectory, deliver?: MagicLinkDeliver, store?: MagicLinkStore, clock?: () => number }} [options]
 */
export function createMagicLinkPackage(options = {}) {
  const edges = resolveEdges(options);
  return selectPackageGraph(definePackage({
    packageContract: 1,
    name: MAGIC_LINK_DOMAIN,
    version: 1,
    label: 'Magic-link login',
    description:
      'Passwordless backoffice login (BO-F0-05): single-use links valid for ten minutes, '
      + 'identical receipts for known and unknown addresses. The deployment wires the operator '
      + 'directory and the delivery edge; Google sign-in stays deployment-owned and untouched.',
    // No module-factory records: token rows live behind the injected store
    // edge (memory here, durable in the deployment), never as CRUD records.
    resources: [],
    requires: [],
    capabilities: [],
    actions: [],
    policies: [],
    operations: [
      {
        operationContract: 1,
        name: 'request-magic-link',
        label: 'Request a magic link',
        appMethod: 'requestMagicLink',
        description:
          'Validate one login email and, when the deployment directory knows it, record a '
          + 'single-use token and hand the link to the delivery edge. The receipt is identical '
          + 'for known and unknown addresses. Refuses until directory, deliver and store are wired.',
        input: [
          { name: 'email', type: 'string', hint: 'The visitor work email, never stored raw.' },
        ],
        create() {
          return (request) => requestMagicLink(edges, request);
        },
      },
      {
        operationContract: 1,
        name: 'consume-magic-link',
        label: 'Redeem a magic link',
        appMethod: 'consumeMagicLink',
        description:
          'Redeem one link exactly once within ten minutes of issue. A second use, an '
          + 'expired link and an unknown token are all refused. Refuses until the store is wired.',
        input: [
          { name: 'token', type: 'string', hint: 'The ml1.<32-hex> token from the delivered link.' },
        ],
        create() {
          return (request) => consumeMagicLink(edges, request);
        },
      },
    ],
    /** Function-free, deterministic schema metadata. Never a handler or a secret. */
    metadata() {
      return {
        magicLinkContract: MAGIC_LINK_CONTRACT,
        ttlMinutes: 10,
        singleUse: true,
        identicalReceipt: true,
        sendsEmail: false,
        notModeled: [
          'delivery transport (deployment-owned deliver edge)',
          'Google sign-in (deployment-owned, untouched)',
          'rate limiting per address (follow-up)',
          'durable token backing (deployment-owned store edge)',
        ],
      };
    },
  }));
}

export { createMemoryMagicLinkStore };
