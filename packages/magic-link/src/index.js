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
  assertEmailHashSecretRef,
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
 * both branches do the same work: mint, save, then one outbox enqueue under
 * the row's own key. The unknown branch spends its row BEFORE the enqueue,
 * so its dummy job is never delivered (the deployment worker skips spent
 * rows by protocol) and an enqueue failure throws the same stable code on
 * both branches. Timing is explicitly OUT of the guarantee: a latency
 * oracle remains until per-address throttling lands (follow-up).
 *
 * Actor custody: the request is unauthenticated, so `actor` is a
 * server-controlled key — a caller-supplied actor is never read, only the
 * deployment's `sendActor` (validated once at wiring, defaulting to the
 * framework's own system actor for this unattended send). A forged actor in
 * the request is stripped, never trusted.
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
 * - the mailbox beside the hash. Token rows carry only the HMAC of the
 *   address under a deployment-held secret, never the raw address. The
 *   outbox job message IS delivery material — exactly
 *   `{to, token, expiresAtIso}`, nothing else — and carries a live Bearer [REDACTED]
 *   beside the mailbox for ten minutes: the deployment MUST treat job
 *   payloads as transient secrets (never log them, delete the job after
 *   settle, scope backups accordingly).
 * - Google sign-in. The framework owns no OAuth client and emits no Google
 *   request (see `tests/admin-login.test.js`): "Continua con Google" on the
 *   login page targets the deployment's entry, which the control plane
 *   already serves. This package never touches that path.
 * - rate limiting and durable storage. The memory store is the local/test
 *   default; a durable deployment backs the async `{save, find, spend}`
 *   edge with its database, where `spend` MUST stay one conditional write
 *   (`UPDATE ... WHERE tokenId = ? AND spent = false`, awaiting nothing
 *   between check and mark) so concurrent consumes still elect one winner.
 *   Per-address throttling over the real HTTP path is a follow-up.
 *
 * @typedef {{ lookup: (normalizedEmail: string) => Promise<{ subject: string } | null> }} MagicLinkDirectory
 * @typedef {{ enqueue: (job: { key: string, actor: { type: string, id: string }, message: { to: string, token: string, expiresAtIso: string } }) => Promise<{ jobId: string }> }} MagicLinkOutbox
 * @typedef {{ save: (record: any) => Promise<void>, find: (tokenId: string) => Promise<any | null>, spend: (tokenId: string) => Promise<boolean> }} MagicLinkStore
 * @typedef {{ resolveSecret: (reference: string, context: { purpose: string }) => Promise<string> }} MagicLinkSecretCustody
 */

export const MAGIC_LINK_DOMAIN = 'magic-link';

/** @param {unknown} value */
function requireSubject(value) {
  if (typeof value !== 'string' || value === '' || value.length > 200 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    throw new ValidationError('Magic-link directory subject must be bounded text', { field: 'subject' });
  }
  return value;
}

/** The only option keys the package accepts: anything else is refused, never ignored. */
const KNOWN_OPTIONS = Object.freeze([
  'directory', 'outbox', 'store', 'clock', 'sendActor', 'emailHashSecretRef', 'resolveSecret',
]);

/**
 * @param {{ directory?: MagicLinkDirectory, outbox?: MagicLinkOutbox, store?: MagicLinkStore, clock?: () => number, sendActor?: { type: string, id: string }, emailHashSecretRef?: string, resolveSecret?: MagicLinkSecretCustody['resolveSecret'] }} [options]
 */
function resolveEdges(options = {}) {
  const opts = options ?? {};
  for (const key of Object.keys(opts)) {
    if (!KNOWN_OPTIONS.includes(key)) {
      throw new ValidationError(`unknown magic-link option '${key}': refusing instead of ignoring it`, { field: key });
    }
  }
  const { directory, outbox, store, clock, sendActor, emailHashSecretRef, resolveSecret } = opts;
  if (directory !== undefined && (typeof directory !== 'object' || directory === null || typeof directory.lookup !== 'function')) {
    throw new ValidationError('magic-link directory must expose lookup()', { field: 'directory' });
  }
  if (outbox !== undefined && (typeof outbox !== 'object' || outbox === null || typeof outbox.enqueue !== 'function')) {
    throw new ValidationError('magic-link outbox must expose enqueue()', { field: 'outbox' });
  }
  if (store !== undefined && (typeof store !== 'object' || store === null
    || typeof store.save !== 'function' || typeof store.find !== 'function' || typeof store.spend !== 'function')) {
    throw new ValidationError('magic-link store must expose async save/find/spend', { field: 'store' });
  }
  if (clock !== undefined && typeof clock !== 'function') {
    throw new ValidationError('magic-link clock must be a function', { field: 'clock' });
  }
  if (sendActor !== undefined) requireActor(sendActor, 'sendActor');
  if (emailHashSecretRef !== undefined) assertEmailHashSecretRef(emailHashSecretRef);
  if (resolveSecret !== undefined && typeof resolveSecret !== 'function') {
    throw new ValidationError('magic-link resolveSecret must be a function', { field: 'resolveSecret' });
  }
  return { directory, outbox, store, clock: clock ?? (() => Date.now()), sendActor, emailHashSecretRef, resolveSecret };
}

function notConfigured(edge) {
  throw new AppError(`magic-link ${edge} is not wired: the deployment provides it`, {
    code: MAGIC_LINK_REASON.NOT_CONFIGURED, status: 500,
  });
}

/**
 * The store is a deployment-owned driver (connection, SQL, constraint): it
 * can throw raw internals at every touch. Every touch is wrapped so the
 * future HTTP route only ever sees the stable `MAGIC_LINK_STORE_FAILED`
 * code (502) — never a driver message, SQL text or stack. The edge name and
 * the driver error's NAME ride along so the route can log the cause (the
 * review rule: a 5xx without a logged cause is a failure nobody can
 * diagnose); the row, the address and the token never do. A `false` from
 * `spend` is not a failure: it is the normal lost-the-race answer the
 * callers handle themselves.
 *
 * @param {unknown} error
 */
function storeCause(error) {
  const name = error instanceof Error ? error.name : typeof error;
  return typeof name === 'string' && name !== '' ? name : 'unknown';
}

/** @param {MagicLinkStore | undefined} store */
async function storeSave(store, record) {
  try {
    await /** @type {MagicLinkStore} */ (store).save(record);
  } catch (error) {
    throw new AppError('magic-link store is unavailable', {
      code: MAGIC_LINK_REASON.STORE_FAILED, status: 502,
      details: { edge: 'store.save', cause: storeCause(error) },
    });
  }
}

/** @param {MagicLinkStore | undefined} store @param {string} tokenId */
async function storeFind(store, tokenId) {
  try {
    return await /** @type {MagicLinkStore} */ (store).find(tokenId);
  } catch (error) {
    throw new AppError('magic-link store is unavailable', {
      code: MAGIC_LINK_REASON.STORE_FAILED, status: 502,
      details: { edge: 'store.find', cause: storeCause(error) },
    });
  }
}

/** @param {MagicLinkStore | undefined} store @param {string} tokenId */
async function storeSpend(store, tokenId) {
  try {
    return await /** @type {MagicLinkStore} */ (store).spend(tokenId);
  } catch (error) {
    throw new AppError('magic-link store is unavailable', {
      code: MAGIC_LINK_REASON.STORE_FAILED, status: 502,
      details: { edge: 'store.spend', cause: storeCause(error) },
    });
  }
}

/**
 * The send runs under the deployment's `sendActor`, or under this named
 * unattended service actor when the deployment names none. The request
 * itself is unauthenticated, so a caller-supplied actor is never read here
 * — `actor` is a server-controlled key (see `SERVER_CONTROLLED_KEYS`).
 */
function sendActorOf(sendActor) {
  if (sendActor === undefined) return trustedSystemActor('magic-link login delivery');
  return requireActor(sendActor, 'sendActor');
}

/**
 * Resolve the email-hash secret at call time from its reference, never from
 * a stored value. A missing custody, a failed resolution or an empty secret
 * refuses fail-closed (502), never with a receipt: without the secret there
 * is no hash, and without the hash there is no row.
 */
async function resolveEmailHashSecret(resolveSecret, emailHashSecretRef) {
  const reference = assertEmailHashSecretRef(emailHashSecretRef);
  if (typeof resolveSecret !== 'function') notConfigured('email-hash secret custody');
  let secret;
  try {
    secret = await resolveSecret(reference, { purpose: 'magic-link-email-hash' });
  } catch (error) {
    throw new AppError('magic-link email-hash custody failed while resolving the secret', {
      code: MAGIC_LINK_REASON.SECRET_UNAVAILABLE, status: 502,
    });
  }
  if (typeof secret !== 'string' || secret === '') {
    throw new AppError('magic-link email-hash custody is not wired: the secret did not resolve', {
      code: MAGIC_LINK_REASON.SECRET_UNAVAILABLE, status: 502,
    });
  }
  return secret;
}

/**
 * Request one link. Always resolves to the identical receipt — known and
 * unknown addresses are indistinguishable in the response, and both
 * branches do the same work: mint, save, then one outbox enqueue under the
 * row's own key. The receipt BODY cannot enumerate, even when the enqueue
 * fails — both branches throw the same stable code then; timing can (see
 * the package header), and throttling is the follow-up that closes it.
 *
 * A caller-supplied `actor` is never read: the request is unauthenticated,
 * so the send runs under the deployment's `sendActor` (validated at wiring,
 * defaulting to the login service system actor). Forgery in the request is
 * stripped, never trusted.
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
 * The unknown branch enqueues a dummy job under its own key with the same
 * call shape, AFTER spending its row: the deployment worker re-reads the
 * row before sending and skips spent rows by protocol, so the dummy is
 * never delivered — but an outbox outage throws the same
 * `MAGIC_LINK_DELIVERY_FAILED` there as on the known branch. The
 * spend-before-enqueue order is load-bearing: reversing it could deliver a
 * live link to a stranger on a crash between the two steps.
 *
 * @param {{ directory?: MagicLinkDirectory, outbox?: MagicLinkOutbox, store?: MagicLinkStore, clock: () => number, sendActor?: { type: string, id: string }, emailHashSecretRef?: string, resolveSecret?: MagicLinkSecretCustody['resolveSecret'] }} edges
 * @param {{ email: unknown }} input
 */
export async function requestMagicLink(edges, input) {
  const email = normalizeLoginEmail(input?.email);
  const { directory, outbox, store, clock, sendActor, emailHashSecretRef, resolveSecret } = edges ?? {};
  if (!directory || !outbox || !store || !resolveSecret) {
    notConfigured(!directory ? 'directory' : (!outbox ? 'outbox' : (!store ? 'store' : 'email-hash secret custody')));
  }
  const actor = sendActorOf(sendActor);
  const nowMs = requireClockMs(/** @type {() => number} */ (clock)());
  let hit;
  try {
    hit = await /** @type {MagicLinkDirectory} */ (directory).lookup(email);
  } catch (error) {
    throw new AppError('magic-link directory is unavailable', {
      code: 'MAGIC_LINK_DIRECTORY_FAILED', status: 502,
    });
  }
  const secret = await resolveEmailHashSecret(resolveSecret, emailHashSecretRef);
  const record = {
    tokenId: mintMagicLinkToken(),
    emailHash: hashLoginEmail(email, secret),
    subject: hit === null || hit === undefined ? 'unknown' : requireSubject(hit.subject),
    issuedAtMs: nowMs,
    expiresAtMs: magicLinkExpiry(nowMs),
    spent: false,
  };
  await storeSave(store, record);
  if (hit === null || hit === undefined) {
    // Discard first: the row dies before the dummy enqueue below, so the
    // job the unknown branch claims can never deliver — and an unknown
    // address leaves no live token behind either way.
    await storeSpend(store, record.tokenId);
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
    // retry mints the only live token. The compensating spend stays wrapped
    // too: a store outage then surfaces as MAGIC_LINK_STORE_FAILED, never raw.
    await storeSpend(store, record.tokenId);
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
 * never the address, never the address-derived hash: the hash stays
 * row-internal for audit, so one intercepted link cannot correlatably name
 * its mailbox across tokens or sessions.
 *
 * @param {{ store?: MagicLinkStore, clock: () => number }} edges
 * @param {{ token: unknown }} input
 */
export async function consumeMagicLink(edges, input) {
  const tokenId = requireMagicLinkToken(input?.token);
  const { store, clock } = edges ?? {};
  if (!store) notConfigured('store');
  const tick = /** @type {() => number} */ (clock);
  const row = await storeFind(store, tokenId);
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
  const won = await storeSpend(store, tokenId);
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
  return { subject: requireSubject(row.subject) };
}

/**
 * @param {{ directory?: MagicLinkDirectory, outbox?: MagicLinkOutbox, store?: MagicLinkStore, clock?: () => number, sendActor?: { type: string, id: string }, emailHashSecretRef?: string, resolveSecret?: MagicLinkSecretCustody['resolveSecret'] }} [options]
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
      + 'directory, the outbox edge and the email-hash secret custody; Google sign-in stays '
      + 'deployment-owned and untouched.',
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
          + 'the deterministic key magic-link:<tokenId> with the deployment send actor. '
          + 'The receipt is identical for known and unknown addresses; a caller-supplied '
          + 'actor is never read. Refuses until directory, outbox, store and secret custody '
          + 'are wired.',
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
export {
  BACKOFFICE_GOOGLE_HREF,
  backofficeLoginHtml,
  loginGreetingHtml,
  loginGoogleLinkHtml,
  loginPageHtml,
  loginStoryHtml,
} from './login-page.js';
