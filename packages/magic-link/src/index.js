// @ts-check

import {
  AppError,
  definePackage,
  requireActor,
  selectPackageGraph,
  trustedSystemActor,
  ValidationError,
} from '../../core/index.js';
import {
  MAGIC_LINK_CONTRACT,
  MAGIC_LINK_REASON,
  hashLoginEmail,
  isMagicLinkExpired,
  magicLinkExpiry,
  magicLinkRequestReceipt,
  magicLinkSendKey,
  mintMagicLinkToken,
  normalizeLoginEmail,
  requireClockMs,
  requireMagicLinkToken,
} from './rules.js';
import { createMemoryMagicLinkStore } from './store.js';

/**
 * The magic-link login domain package (backlog:0cbae947, BO-F0-05).
 *
 * Passwordless login for the backoffice: a visitor types their work email,
 * a known address is sent a single-use link valid for ten minutes, and the
 * link redeems exactly once. Unknown addresses get the byte-identical
 * receipt — the response never says whether an address is registered — and
 * do the same store work, so the receipt is not a timing oracle either.
 *
 * It reuses and never duplicates: error shapes (`core` errors), actor
 * custody (`requireActor`, the framework's own system actor for this
 * unattended send), the deterministic outbox key idiom (M11, like
 * `channelSendIdempotencyKey`), secret-by-reference custody (like
 * `site-forms` and `channels`: values never cross the boundary). It changes
 * no kernel file (ADR-018).
 *
 * What is deliberately NOT here:
 * - the send itself. This package persists the token row FIRST, then hands
 *   the link to the deployment-owned `outbox` edge under the deterministic
 *   key `magic-link:<tokenId>` with an actor. In production that edge is the
 *   channels outbox (`channel-send` job); the persistent enqueue IS the
 *   cross-process claim, so a re-enqueue under the same key returns the same
 *   job and there is no second send path (outbound-send rule). The package
 *   performs no network I/O and holds no credential, and every operation
 *   refuses until the edges are wired.
 * - Google sign-in. The framework owns no OAuth client and emits no Google
 *   request (see `tests/admin-login.test.js`): "Continua con Google" on the
 *   login page targets the deployment's entry, which the control plane
 *   already serves. This package never touches that path.
 * - rate limiting and durable storage. The memory store is the local/test
 *   default; a durable deployment backs `{save, find, spend}` with its
 *   database, where `spend` MUST stay one conditional write
 *   (`UPDATE ... WHERE tokenId = ? AND spent = false`) so concurrent
 *   consumes still elect one winner. Per-address throttling over the real
 *   HTTP path is a follow-up (the residual timing delta after the equal
 *   store work lives in the deployment's transport, not in this package).
 *
 * @typedef {{ lookup: (normalizedEmail: string) => Promise<{ subject: string } | null> }} MagicLinkDirectory
 * @typedef {{ enqueue: (job: { key: string, actor: { type: string, id: string }, message: { to: string, token: string, expiresAtIso: string } }) => Promise<{ jobId: string }> }} MagicLinkOutbox
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
 * @param {{ directory?: MagicLinkDirectory, outbox?: MagicLinkOutbox, store?: MagicLinkStore, clock?: () => number }} [options]
 */
function resolveEdges(options = {}) {
  const { directory, outbox, store, clock } = options;
  if (directory !== undefined && (typeof directory !== 'object' || directory === null || typeof directory.lookup !== 'function')) {
    throw new ValidationError('magic-link directory must expose lookup()', { field: 'directory' });
  }
  if (outbox !== undefined && (typeof outbox !== 'object' || outbox === null || typeof outbox.enqueue !== 'function')) {
    throw new ValidationError('magic-link outbox must expose enqueue()', { field: 'outbox' });
  }
  if (store !== undefined && (typeof store !== 'object' || store === null
    || typeof store.save !== 'function' || typeof store.find !== 'function' || typeof store.spend !== 'function')) {
    throw new ValidationError('magic-link store must expose save/find/spend', { field: 'store' });
  }
  if (clock !== undefined && typeof clock !== 'function') {
    throw new ValidationError('magic-link clock must be a function', { field: 'clock' });
  }
  return { directory, outbox, store, clock: clock ?? (() => Date.now()) };
}

function notConfigured(edge) {
  throw new AppError(`magic-link ${edge} is not wired: the deployment provides it`, {
    code: MAGIC_LINK_REASON.NOT_CONFIGURED, status: 500,
  });
}

/**
 * The send runs under this unattended service actor unless the deployment
 * names its own (validated with `requireActor`, like every write path).
 */
function resolveSendActor(input) {
  const actor = input?.actor;
  if (actor === undefined || actor === null) return trustedSystemActor('magic-link login delivery');
  return requireActor(actor);
}

/**
 * Request one link. Always resolves to the identical receipt — known and
 * unknown addresses are indistinguishable in the response, and both
 * branches do the same store work (mint, save, then enqueue for a known
 * address or spend-and-discard for an unknown one), so the receipt is not
 * a timing oracle either.
 *
 * Claim first, send second: the token row is persisted BEFORE the outbox
 * enqueue runs, and the persistent enqueue under the deterministic key
 * `magic-link:<tokenId>` IS the cross-process claim — a re-enqueue under
 * the same key returns the same job, never a second send. When the enqueue
 * fails, the just-saved row is spent before throwing, so a failed send
 * never leaves a live orphan: the retry mints the only live token.
 * Each request mints its own row; earlier pending rows for the same address
 * stay valid until they expire.
 *
 * @param {{ directory?: MagicLinkDirectory, outbox?: MagicLinkOutbox, store?: MagicLinkStore, clock: () => number }} edges
 * @param {{ email: unknown, actor?: unknown }} input
 */
export async function requestMagicLink(edges, input) {
  const email = normalizeLoginEmail(input?.email);
  const actor = resolveSendActor(input);
  const { directory, outbox, store, clock } = edges;
  if (!directory || !outbox || !store) notConfigured(!directory ? 'directory' : (!outbox ? 'outbox' : 'store'));
  const nowMs = requireClockMs(/** @type {() => number} */ (clock)());
  let hit;
  try {
    hit = await /** @type {MagicLinkDirectory} */ (directory).lookup(email);
  } catch (error) {
    throw new AppError('magic-link directory is unavailable', {
      code: 'MAGIC_LINK_DIRECTORY_FAILED', status: 502,
    });
  }
  const record = {
    tokenId: mintMagicLinkToken(),
    emailHash: hashLoginEmail(email),
    subject: hit === null || hit === undefined ? 'unknown' : requireSubject(hit.subject),
    issuedAtMs: nowMs,
    expiresAtMs: magicLinkExpiry(nowMs),
    spent: false,
  };
  /** @type {MagicLinkStore} */ (store).save(record);
  if (hit === null || hit === undefined) {
    // Same store work as the known branch, then discard: the dummy row is
    // spent before anyone could redeem it, so an unknown address leaves no
    // live token behind.
    /** @type {MagicLinkStore} */ (store).spend(record.tokenId);
    return magicLinkRequestReceipt();
  }
  try {
    await /** @type {MagicLinkOutbox} */ (outbox).enqueue({
      key: magicLinkSendKey(record.tokenId),
      actor,
      message: {
        to: email,
        token: record.tokenId,
        expiresAtIso: new Date(record.expiresAtMs).toISOString(),
      },
    });
  } catch (error) {
    // No live orphan: the row this enqueue belonged to dies here, and the
    // retry mints the only live token.
    /** @type {MagicLinkStore} */ (store).spend(record.tokenId);
    throw new AppError('magic-link delivery failed after the link was recorded', {
      code: 'MAGIC_LINK_DELIVERY_FAILED', status: 502,
    });
  }
  return magicLinkRequestReceipt();
}

/**
 * Redeem one link. Malformed tokens are refused before any store is
 * touched. A well-formed token redeems exactly once: the conditional
 * `spend` elects one winner, every later use — however soon — is refused.
 *
 * Expiry is enforced on both sides of the claim: the row is checked before
 * `spend`, and re-checked with a fresh clock reading after winning it, so
 * a token that crosses its deadline between the check and the claim still
 * refuses with EXPIRED instead of redeeming late. A spent row stays dead
 * either way.
 *
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
  const tick = /** @type {() => number} */ (clock);
  const row = /** @type {MagicLinkStore} */ (store).find(tokenId);
  if (!row || row.spent) {
    throw new AppError('magic link is unknown or already used', {
      code: MAGIC_LINK_REASON.INVALID, status: 401,
    });
  }
  if (isMagicLinkExpired(row, requireClockMs(tick()))) {
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
  if (isMagicLinkExpired(row, requireClockMs(tick()))) {
    throw new AppError('magic link expired: request a new one', {
      code: MAGIC_LINK_REASON.EXPIRED, status: 401,
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
      + 'directory and the outbox edge; Google sign-in stays deployment-owned and untouched.',
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
          + 'single-use token and enqueue the link through the deployment outbox edge under '
          + 'the deterministic key magic-link:<tokenId> with an actor. The receipt is identical '
          + 'for known and unknown addresses. Refuses until directory, outbox and store are wired.',
        input: [
          { name: 'email', type: 'string', hint: 'The visitor work email, never stored raw.' },
          { name: 'actor', type: 'json', hint: 'Optional send actor; defaults to the login service system actor.' },
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
          'delivery transport (deployment-owned outbox edge, channel-send in production)',
          'Google sign-in (deployment-owned, untouched)',
          'per-address throttling over the HTTP path (follow-up)',
          'durable token backing (deployment-owned store edge)',
        ],
      };
    },
  }));
}

export { createMemoryMagicLinkStore };
