// @ts-check

import { AppError } from '../../core/index.js';
import { inboundOnlyOutbound } from './adapter.js';
import { verifyHmacWebhook } from './crypto.js';
import { fixtureEnvelopeEvent } from './fixture.js';

/**
 * Website-form adapter (backlog:ffce3d1cd636).
 *
 * Inbound-only by contract: the site submits visitor requests INTO the
 * space, and this package never sends through it — the reply rides the
 * visitor's reachable channel (WhatsApp when the submission carries a
 * phone number, email otherwise). Both halves of the outbound path refuse
 * with the contract's CHANNEL_SEND_UNSUPPORTED (see `inboundOnlyOutbound`
 * in `adapter.js`), which `operations.js` hands back intact and the shared
 * kit asserts.
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no provider
 * credentials exist yet, and none are invented here): inbound submissions
 * verify with the shared channel HMAC scheme (`crypto.js`) — the scheme
 * the fake signs with, and the scheme the kit harness signs with. The
 * pilot's own validation and anti-spam stay in `packages/site-forms`;
 * this adapter is the channel binding that records the submission as one
 * inbox event.
 *
 * What the adapter owns (the site-form policy, fail-closed):
 * - inbound: form submissions (`form.submitted` with a submission id and
 *   the form id) normalized to one channel event per submission, plus the
 *   kit's minimal envelope on the kit path. The subject is the submission
 *   (`form:<submissionId>`). The raw submission is never stored — only the
 *   fingerprint.
 * - outbound: refused, always, with CHANNEL_SEND_UNSUPPORTED.
 */

export const SITE_FORM_ADAPTER_NAME = 'site-form-inbox';
export const SITE_FORM_ADAPTER_VERSION = 1;
const MAX_ID = 256;
const MAX_FORM_ID = 128;

function malformedEvent(reason) {
  throw new AppError(`Site-form event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function boundedId(value, max, field) {
  if (typeof value !== 'string' || value === '' || value.length > max) {
    malformedEvent(`${field} must be bounded non-empty text (1-${max} characters)`);
  }
  return value;
}

/**
 * Normalize one verified submission body. Speaks the `form.submitted`
 * shape when the body carries it, and the kit's minimal envelope otherwise
 * (the same fallback every fake adapter shares, so the kit drives
 * receive/replay/out-of-order through the provider path).
 */
function normalizeSiteFormInbound(event) {
  let parsed;
  try {
    parsed = JSON.parse(String(event));
  } catch {
    malformedEvent('event is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    malformedEvent('event is not an object');
  }
  if (parsed.event === undefined || parsed.event === null) {
    return fixtureEnvelopeEvent(parsed);
  }
  if (parsed.event !== 'form.submitted') {
    malformedEvent(`unsupported site-form event "${String(parsed.event).slice(0, 64)}"`);
  }
  const submissionId = boundedId(parsed.submission_id, MAX_ID, '"submission_id"');
  // The form id names the surface; the row subject is the submission, and
  // sender resolution stays in `packages/site-forms` — webhook ingest never
  // resolves senders, so the adapter carries no sender evidence.
  boundedId(parsed.form_id, MAX_FORM_ID, '"form_id"');
  return {
    providerEventId: submissionId,
    subject: `form:${submissionId}`,
    sequence: null,
    occurredAt: typeof parsed.at === 'string' ? parsed.at : null,
  };
}

/**
 * Build the fake-backed site-form adapter: `{ definition, api }` in the
 * fixture's shape, so the kit harness drives it unchanged. The double
 * keeps no secret of its own: verification is the HMAC over the secret
 * production resolves through the same `resolveSecret` edge.
 */
export function createSiteFormChannelAdapter(options = {}) {
  const state = {
    mode: 'ok',
    flakyRemaining: 0,
    /** @type {Map<string, {providerMessageId: string, message: any}>} */
    sentByKey: new Map(),
    sendCalls: 0,
  };

  const api = {
    state,
    /** @param {'ok'|'refuse'|'timeout'} mode @param {number} [flakyFailures] */
    setMode(mode, flakyFailures = 0) {
      state.mode = mode;
      state.flakyRemaining = flakyFailures;
    },
    reset() {
      state.mode = 'ok';
      state.flakyRemaining = 0;
      state.sentByKey.clear();
      state.sendCalls = 0;
    },
  };

  return {
    definition: {
      name: options.name ?? SITE_FORM_ADAPTER_NAME,
      version: SITE_FORM_ADAPTER_VERSION,
      label: 'Website form submissions (fake-backed)',
      channel: 'site-form',
      config: { testOnly: true },

      verifyInbound({ rawBody, headers, secret }) {
        const signature = headers?.['x-channel-signature-256'];
        const timestamp = headers?.['x-channel-timestamp'];
        const ok = verifyHmacWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      normalizeInbound(event) {
        return normalizeSiteFormInbound(event);
      },

      ...inboundOnlyOutbound('Website form submissions'),
    },
    api,
  };
}

/** Build one site-form submission body. */
export function siteFormEventBody({ submissionId, formId = 'contatti', name, email, phone, message, at = null }) {
  return JSON.stringify({
    event: 'form.submitted',
    submission_id: submissionId,
    form_id: formId,
    ...(name === undefined ? {} : { name }),
    ...(email === undefined ? {} : { email }),
    ...(phone === undefined ? {} : { phone }),
    ...(message === undefined ? {} : { message }),
    ...(at === null ? {} : { at }),
  });
}
