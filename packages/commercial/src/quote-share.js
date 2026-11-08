// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import { AppError, ValidationError, nowIso } from '../../core/index.js';

/**
 * Public quote links (A5 offerta via link, accettazione e prezzo congelato).
 *
 * A `quote-share` row binds ONE approved quote version to an unguessable
 * token. Whoever holds the token reads the frozen version and accepts it —
 * no login, because the token itself is the credential (like every signed
 * link). The row stores only the token's SHA-256, so the bearer never rests
 * in the database — and the action traces (`workflow_runs`/`trace_spans`)
 * hold only the hash too, never the bearer: the raw token leaves the server
 * exactly once, as the top-level `token` of a fresh share-link result. The
 * accepted price is read from the immutable `quote-version` rows only, so a
 * later catalog change can never move it. Acceptance is idempotent and
 * terminal per version: the first accept wins one conditional claim, every
 * later accept answers «già accettata» without writing — even after the link
 * itself expired — and a version that already has an accepted share is never
 * minted a new link. An expired or unknown token refuses with a short
 * Italian message and never leaks names, prices or rows.
 *
 * The quote record itself stays `approved`: customer acceptance is tracked
 * on the share row, while discount approval keeps its own lifecycle.
 * Wiring the acceptance into the pipeline stage is the caller's job
 * (it reads `accepted` / `alreadyAccepted` from the result).
 */

/** @typedef {{
 *   quoteModule?: string, versionModule?: string,
 *   versionLineModule?: string, versionTotalModule?: string,
 *   shareModule?: string,
 * }} QuoteShareConfig */

/** @param {QuoteShareConfig} [config] */
function resolved(config = {}) {
  return {
    quoteModule: config.quoteModule ?? 'quote',
    versionModule: config.versionModule ?? 'quote-version',
    versionLineModule: config.versionLineModule ?? 'quote-version-line',
    versionTotalModule: config.versionTotalModule ?? 'quote-version-total',
    shareModule: config.shareModule ?? 'quote-share',
  };
}

function optionalService(modules, name) {
  try {
    return modules.get(name)?.service ?? null;
  } catch {
    return null;
  }
}

function requireShareService(modules, cfg) {
  const shares = optionalService(modules, cfg.shareModule);
  if (!shares || typeof shares.createManaged !== 'function') {
    throw new AppError('Quote links are not enabled in this project: apply quote-share.module.json', {
      code: 'QUOTE_LINK_UNAVAILABLE', status: 409,
    });
  }
  return shares;
}

/** An unguessable 64-hex-char public token. */
export function generateShareToken() {
  return randomBytes(32).toString('hex');
}

/**
 * What the database holds of a bearer: the SHA-256 hex of the token, never
 * the token. The row, the audit trail and every summary stay useless to a
 * reader without the link itself (the calendar-sync channel-token precedent:
 * rows hold hashes, the raw secret travels once at issue).
 */
export function hashShareToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Draft-revision optimistic concurrency guard (mirrors the quote actions). */
function checkRevision(quote, input) {
  if (input.expectedRevision !== undefined && input.expectedRevision !== quote.draftRevision) {
    throw new AppError(
      `Stale draft revision: expected ${input.expectedRevision}, quote is at ${quote.draftRevision}`,
      { code: 'STALE_REVISION', status: 409, details: { draftRevision: quote.draftRevision } },
    );
  }
}

function requireUserActor(actor) {
  if (!actor || typeof actor !== 'object' || /** @type {any} */ (actor).type !== 'user') {
    throw new AppError('Sharing a quote link requires a human user actor', { code: 'HUMAN_ACTOR_REQUIRED', status: 403 });
  }
  return String(/** @type {any} */ (actor).id ?? 'unknown');
}

/**
 * The frozen commercial evidence one token carries: version identity plus
 * the immutable lines and grouped totals. Reads version rows only —
 * the live catalog is never consulted, so the price cannot move after
 * the send.
 */
async function frozenOffer(modules, cfg, share) {
  const versions = optionalService(modules, cfg.versionModule);
  const lineService = optionalService(modules, cfg.versionLineModule);
  const totalService = optionalService(modules, cfg.versionTotalModule);
  if (!versions || !lineService || !totalService) {
    throw new AppError('Quote links are not enabled in this project: apply quote-share.module.json', {
      code: 'QUOTE_LINK_UNAVAILABLE', status: 409,
    });
  }
  const version = await versions.get(share.quoteVersionId);
  if (!version || version.quoteId !== share.quoteId) {
    throw new AppError('The quote link points at a version that no longer exists', {
      code: 'COMMERCIAL_STATE_CORRUPT', status: 409,
    });
  }
  const lines = (await lineService.listWhere({ versionId: version.id }))
    .sort((a, b) => (a.position === b.position ? (a.id < b.id ? -1 : 1) : a.position - b.position))
    .map((line) => ({
      offerName: line.offerName,
      quantity: line.quantity,
      listAmountCents: line.listAmountCents,
      discountAmountCents: line.discountAmountCents,
      netAmountCents: line.netAmountCents,
    }));
  const totals = (await totalService.listWhere({ versionId: version.id }))
    .map((row) => ({
      kind: row.kind,
      currency: row.currency,
      interval: row.interval,
      intervalCount: row.intervalCount,
      listAmountCents: row.listAmountCents,
      discountAmountCents: row.discountAmountCents,
      netAmountCents: row.netAmountCents,
    }));
  return {
    quoteId: share.quoteId,
    versionId: version.id,
    versionNumber: version.versionNumber,
    currency: version.currency,
    oneTimeNetCents: version.oneTimeNetCents,
    lines,
    totals,
  };
}

function shareSummary(share) {
  // No token here on purpose: the summary travels in traces, audit and
  // action results, and the hash the row holds is not the bearer. The raw
  // token leaves the server exactly once, as the top-level `token` of a
  // fresh share-link result.
  return {
    quoteId: share.quoteId,
    quoteVersionId: share.quoteVersionId,
    versionNumber: share.versionNumber,
    status: share.status,
    expiresAt: share.expiresAt,
    acceptedAt: share.acceptedAt ?? null,
    acceptCount: share.acceptCount ?? 0,
  };
}

async function findShare(shares, token) {
  if (typeof token !== 'string' || token === '') return null;
  return (await shares.listWhere({ tokenHash: hashShareToken(token) }))[0] ?? null;
}

/**
 * One source of truth for the first accept: the committing write is a
 * single conditional UPDATE gated on `status = 'active'` where it executes
 * — the product-import row-decision idiom (`affectedRows` verdict, audit
 * mirror, managed re-read, one event). Zero rows means a concurrent accept
 * won or the row moved meanwhile: the caller re-reads and answers from the
 * row it finds. Never accept with an unconditional write.
 *
 * @param {any} shares the quote-share managed service
 */
async function claimAcceptedShare(shares, share, at, actor) {
  const manifest = shares?.manifest;
  const fields = Array.isArray(manifest?.fields) ? manifest.fields : null;
  const columnOf = (name) => fields?.find((field) => field?.name === name)?.column ?? null;
  const table = manifest?.table;
  const columns = {
    status: columnOf('status'),
    acceptedAt: columnOf('acceptedAt'),
    acceptCount: columnOf('acceptCount'),
  };
  const syncApi = shares?.database?.storage?.sync;
  const syncMutation = syncApi
    && typeof syncApi.execute === 'function'
    && typeof syncApi.savepoint === 'function'
    && typeof shares.mutationSync === 'function';
  const asyncMutation = typeof shares.mutationAsync === 'function';
  if (!manifest || typeof table !== 'string' || typeof manifest.name !== 'string'
    || Object.values(columns).some((column) => typeof column !== 'string' || column === '')
    || typeof shares.get !== 'function'
    || typeof shares.audit?.record !== 'function'
    || typeof shares.events?.emit !== 'function'
    || (!syncMutation && !asyncMutation)) {
    throw new AppError('quote-share storage cannot prove an atomic accept claim', {
      code: 'COMMERCIAL_STORAGE_INVALID', status: 500,
    });
  }
  const statement = {
    kind: 'update',
    table,
    values: [
      { column: columns.status, value: 'accepted' },
      { column: columns.acceptedAt, value: at },
      { column: columns.acceptCount, value: 1 },
      { column: 'updated_at', value: nowIso() },
    ],
    where: [
      { column: 'id', op: 'eq', value: share.id },
      { column: columns.status, op: 'eq', value: 'active' },
    ],
  };
  const auditEvent = {
    actor, entityType: manifest.name, entityId: share.id,
    data: { status: 'accepted', acceptedAt: at, acceptCount: 1 },
    action: `${manifest.name}.updated`,
  };
  let won = false;
  if (syncMutation) {
    won = shares.mutationSync(() => {
      const claimed = syncApi.execute(statement);
      if (Number(claimed?.affectedRows ?? 0) !== 1) return false;
      shares.audit.record(auditEvent, syncApi);
      return true;
    });
  } else {
    won = await shares.mutationAsync(async (tx) => {
      const claimed = await tx.execute(statement);
      if (Number(claimed?.affectedRows ?? 0) !== 1) return false;
      await shares.audit.record(auditEvent, tx);
      return true;
    });
  }
  if (!won) return null;
  const updated = await shares.get(share.id);
  await shares.events.emit(`${manifest.name}.updated`, updated);
  return updated;
}

function invalidLink() {
  return new AppError('link non valido o scaduto', { code: 'QUOTE_LINK_INVALID', status: 404 });
}

function expiredLink() {
  return new AppError('offerta scaduta', { code: 'QUOTE_LINK_EXPIRED', status: 410 });
}

/**
 * One source of truth for what a quote version already has: an accepted share
 * is terminal and wins over a live one, a live (unexpired, active) share is
 * reused, otherwise there is nothing to reuse. Every share-link decision —
 * reuse the live link, reuse the accepted receipt, mint a new token — reads
 * this, never a status filter of its own, so an accepted version can never be
 * minted a second accept-able token.
 *
 * @param {any} shares the quote-share managed service
 */
async function resolveVersionShare(shares, quote, at) {
  const rows = await shares.listWhere({ quoteId: quote.id, quoteVersionId: quote.currentVersionId });
  const accepted = rows.find((row) => row.status === 'accepted') ?? null;
  if (accepted) return { kind: 'accepted', share: accepted };
  const live = rows
    .filter((row) => row.status === 'active' && typeof row.expiresAt === 'string' && row.expiresAt > at)[0] ?? null;
  if (live) return { kind: 'live', share: live };
  return null;
}

/**
 * Trace redaction for the token the caller presents: the persisted trace
 * input holds only the SHA-256 hash, never the bearer.
 */
function redactedTokenInput(input) {
  if (!input || typeof input.token !== 'string' || input.token === '') return input;
  const { token, ...rest } = input;
  return { ...rest, tokenHash: hashShareToken(token) };
}

/**
 * Trace redaction for a result carrying a fresh bearer: the persisted trace
 * output holds only the SHA-256 hash, never the bearer. The live return
 * value keeps the raw token — it leaves the server exactly once, here.
 */
function redactedShareResult(result) {
  if (!result || typeof result.token !== 'string' || result.token === '') return result;
  return { ...result, token: null, tokenHash: hashShareToken(result.token) };
}

/** @param {QuoteShareConfig} [config] */
export function buildShareLinkAction(config) {
  const cfg = resolved(config);
  return {
    module: cfg.quoteModule,
    name: 'share-link',
    label: 'Share link',
    description: 'Create (or reuse) the public acceptance link for the approved quote version; the price stays the frozen version price.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['approved'],
    input: [
      { name: 'expiresInDays', type: 'integer', required: false, hint: 'Link lifetime in days, 1-90 (default 14).' },
      { name: 'expectedRevision', type: 'integer', required: false },
    ],
    traceRedact: { output: redactedShareResult },
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, now, step }) {
      const createdBy = requireUserActor(actor);
      checkRevision(quote, input);
      const shares = requireShareService(modules, cfg);
      if (!quote.currentVersionId) {
        throw new AppError('The quote carries no approved version to share', { code: 'COMMERCIAL_STATE_CORRUPT', status: 409 });
      }
      const days = input.expiresInDays ?? 14;
      if (!Number.isInteger(days) || days < 1 || days > 90) {
        throw new ValidationError('expiresInDays must be an integer between 1 and 90', { field: 'expiresInDays' });
      }
      const at = now();
      const existing = await resolveVersionShare(shares, quote, at);
      if (existing) {
        // The bearer is not recoverable from the hash, so a reused link
        // returns no token: resend the original link the first share made.
        // An accepted share is terminal for its version — reusing it here,
        // instead of minting a fresh token, is what makes double acceptance
        // of one version impossible.
        step('quote.link-reused', { quoteId: quote.id, versionNumber: existing.share.versionNumber });
        return { alreadyExisted: true, share: shareSummary(existing.share), token: null };
      }
      const token = generateShareToken();
      const expiresAt = new Date(Date.parse(at) + days * 86_400_000).toISOString();
      const share = await shares.createManaged(
        {
          quoteId: quote.id,
          quoteVersionId: quote.currentVersionId,
          versionNumber: quote.currentVersionNumber,
          tokenHash: hashShareToken(token),
          status: 'active',
          expiresAt,
          acceptCount: 0,
          createdBy,
        },
        { actor },
      );
      step('quote.link-shared', { quoteId: quote.id, versionNumber: share.versionNumber });
      // The only result that ever carries the raw bearer: the operator
      // copies it into the message once, then it lives only in the link.
      return { alreadyExisted: false, share: shareSummary(share), token };
    },
  };
}

/** @param {QuoteShareConfig} [config] */
export function buildAcceptLinkAction(config) {
  const cfg = resolved(config);
  return {
    module: cfg.quoteModule,
    name: 'accept-link',
    label: 'Accept via link',
    description: 'Accept the frozen quote version behind a public token. Idempotent: a second accept answers already accepted. The token is the only credential, so no user actor is required.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['approved'],
    confirm: false,
    input: [
      { name: 'token', type: 'string', required: true, hint: 'The public token from the shared link.' },
    ],
    traceRedact: { input: redactedTokenInput },
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, now, step }) {
      const shares = requireShareService(modules, cfg);
      // One connection runs one outer record-action transaction at a time
      // (NESTED_TRANSACTION), so overlapping accepts on the same connection
      // serialize in the framework before they reach this claim; overlapping
      // accepts on different connections meet in the conditional claim
      // below, which elects exactly one winner.
      const share = await findShare(shares, input.token);
      if (!share || share.quoteId !== quote.id) throw invalidLink();
      // An accepted link stays accepted: the acceptance proof survives the
      // link's own expiry, so a reopened link never reports «scaduta».
      if (share.status === 'accepted') {
        return {
          alreadyAccepted: true,
          acceptedAt: share.acceptedAt ?? null,
          share: shareSummary(share),
          offer: await frozenOffer(modules, cfg, share),
        };
      }
      const at = now();
      if (typeof share.expiresAt !== 'string' || share.expiresAt <= at) throw expiredLink();
      const offer = await frozenOffer(modules, cfg, share);
      const updated = await claimAcceptedShare(shares, share, at, actor);
      if (!updated) {
        // Another accept won the conditional claim between our read and our
        // write (another connection): answer from the row it left, never
        // from our stale read.
        const current = await shares.get(share.id);
        if (current.status === 'accepted') {
          return {
            alreadyAccepted: true,
            acceptedAt: current.acceptedAt ?? null,
            share: shareSummary(current),
            offer: await frozenOffer(modules, cfg, current),
          };
        }
        if (typeof current.expiresAt !== 'string' || current.expiresAt <= now()) throw expiredLink();
        throw new AppError('quote link was decided concurrently: reopen it', {
          code: 'QUOTE_LINK_CONTEST', status: 409,
        });
      }
      step('quote.link-accepted', { quoteId: quote.id, versionNumber: share.versionNumber });
      return { accepted: true, acceptedAt: at, share: shareSummary(updated), offer };
    },
  };
}

/** @param {QuoteShareConfig} [config] */
export function buildLinkInfoAction(config) {
  const cfg = resolved(config);
  return {
    module: cfg.quoteModule,
    name: 'link-info',
    label: 'Link info',
    description: 'Read what a public token shows: the frozen offer while the link is live, only a short message once it is expired or unknown. Never leaks prices on dead links.',
    actionContract: 1,
    stateField: 'status',
    fromStates: ['approved'],
    input: [
      { name: 'token', type: 'string', required: true, hint: 'The public token from the shared link.' },
    ],
    traceRedact: { input: redactedTokenInput },
    /** @param {any} ctx */
    async execute({ record: quote, input, modules, now }) {
      const shares = requireShareService(modules, cfg);
      const share = await findShare(shares, input.token);
      if (!share || share.quoteId !== quote.id) throw invalidLink();
      const at = now();
      // Accepted first here too: an accepted-then-expired link proves the
      // acceptance, it never reports «offerta scaduta».
      if (share.status === 'accepted') {
        return { status: 'accepted', message: 'già accettata', acceptedAt: share.acceptedAt ?? null, offer: await frozenOffer(modules, cfg, share) };
      }
      if (typeof share.expiresAt !== 'string' || share.expiresAt <= at) {
        return { status: 'expired', message: 'offerta scaduta', expiresAt: share.expiresAt ?? null };
      }
      return { status: 'active', expiresAt: share.expiresAt, offer: await frozenOffer(modules, cfg, share) };
    },
  };
}

/**
 * The three public-link actions the package contributes, in registration order.
 * @param {QuoteShareConfig|undefined} config
 */
export function buildQuoteShareActions(config) {
  return [buildShareLinkAction(config), buildAcceptLinkAction(config), buildLinkInfoAction(config)];
}
