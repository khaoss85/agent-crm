// @ts-check

import { randomBytes } from 'node:crypto';
import { AppError, ValidationError } from '../../core/index.js';

/**
 * Public quote links (A5 offerta via link, accettazione e prezzo congelato).
 *
 * A `quote-share` row binds ONE approved quote version to an unguessable
 * token. Whoever holds the token reads the frozen version and accepts it —
 * no login, because the token itself is the credential (like every signed
 * link). The accepted price is read from the immutable `quote-version`
 * rows only, so a later catalog change can never move it. Acceptance is
 * idempotent: the first accept stamps the row once, every later accept
 * answers «già accettata» without writing. An expired or unknown token
 * refuses with a short Italian message and never leaks names, prices or
 * rows.
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
  return {
    token: share.token,
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
  return (await shares.listWhere({ token }))[0] ?? null;
}

function invalidLink() {
  return new AppError('link non valido o scaduto', { code: 'QUOTE_LINK_INVALID', status: 404 });
}

function expiredLink() {
  return new AppError('offerta scaduta', { code: 'QUOTE_LINK_EXPIRED', status: 410 });
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
      const live = (await shares.listWhere({ quoteId: quote.id, quoteVersionId: quote.currentVersionId, status: 'active' }))
        .filter((row) => typeof row.expiresAt === 'string' && row.expiresAt > at)[0] ?? null;
      if (live) {
        step('quote.link-reused', { quoteId: quote.id, versionNumber: live.versionNumber });
        return { alreadyExisted: true, share: shareSummary(live) };
      }
      const token = generateShareToken();
      const expiresAt = new Date(Date.parse(at) + days * 86_400_000).toISOString();
      const share = await shares.createManaged(
        {
          quoteId: quote.id,
          quoteVersionId: quote.currentVersionId,
          versionNumber: quote.currentVersionNumber,
          token,
          sourceKey: `qs:${token}`,
          status: 'active',
          expiresAt,
          acceptCount: 0,
          createdBy,
        },
        { actor },
      );
      step('quote.link-shared', { quoteId: quote.id, versionNumber: share.versionNumber });
      return { alreadyExisted: false, share: shareSummary(share) };
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
    /** @param {any} ctx */
    async execute({ record: quote, input, actor, modules, now, step }) {
      const shares = requireShareService(modules, cfg);
      const share = await findShare(shares, input.token);
      if (!share || share.quoteId !== quote.id) throw invalidLink();
      const at = now();
      if (typeof share.expiresAt !== 'string' || share.expiresAt <= at) throw expiredLink();
      const offer = await frozenOffer(modules, cfg, share);
      if (share.status === 'accepted') {
        return { alreadyAccepted: true, acceptedAt: share.acceptedAt ?? null, share: shareSummary(share), offer };
      }
      const updated = await shares.applyManaged(
        share.id,
        { status: 'accepted', acceptedAt: at, acceptCount: 1 },
        { actor },
      );
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
    /** @param {any} ctx */
    async execute({ record: quote, input, modules, now }) {
      const shares = requireShareService(modules, cfg);
      const share = await findShare(shares, input.token);
      if (!share || share.quoteId !== quote.id) throw invalidLink();
      const at = now();
      if (typeof share.expiresAt !== 'string' || share.expiresAt <= at) {
        return { status: 'expired', message: 'offerta scaduta', expiresAt: share.expiresAt ?? null };
      }
      if (share.status === 'accepted') {
        return { status: 'accepted', message: 'già accettata', acceptedAt: share.acceptedAt ?? null, offer: await frozenOffer(modules, cfg, share) };
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
