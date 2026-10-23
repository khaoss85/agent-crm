// @ts-check

import { AppError } from '../../core/index.js';
import { inboundOnlyOutbound } from './adapter.js';
import { verifyHmacWebhook } from './crypto.js';
import { fixtureEnvelopeEvent } from './fixture.js';

/**
 * PBX incoming-call adapter (backlog:ffce3d1cd636).
 *
 * Inbound-only by contract: the centralino delivers call records INTO the
 * space (a customer calling from a company mobile), and this package never
 * places calls through it. Both halves of the outbound path refuse with
 * the contract's CHANNEL_SEND_UNSUPPORTED (see `inboundOnlyOutbound` in
 * `adapter.js`), which `operations.js` hands back intact and the shared
 * kit asserts.
 *
 * Fake-backed on purpose (owner decision MEM_ACC_DECISIONS: no provider
 * credentials exist yet, and none are invented here): inbound notifications
 * verify with the shared channel HMAC scheme (`crypto.js`) — the scheme
 * the fake signs with, and the scheme the kit harness signs with.
 *
 * What the adapter owns (the voice policy, fail-closed):
 * - inbound: PBX inbound-call notifications (`call.inbound` with a call id,
 *   the caller and called E.164 numbers and a canonical start instant)
 *   normalized to one channel event per call, plus the kit's minimal
 *   envelope on the kit path. The conversation subject is the caller
 *   (`tel:<E.164>`), and the sender handle is the same number, so the call
 *   lands on the caller's card. Any other direction refuses: this adapter
 *   models what customers do (call in), never what the PBX logs around it.
 * - outbound: refused, always, with CHANNEL_SEND_UNSUPPORTED.
 */

export const VOICE_ADAPTER_NAME = 'voice-pbx';
export const VOICE_ADAPTER_VERSION = 1;

/** Canonical `+E.164` from a caller string that may carry spaces, dashes or brackets. */
export function canonicalVoiceNumber(value) {
  const digits = typeof value === 'string' ? value.trim().replace(/[\s\-.()]/g, '') : '';
  const bare = digits.startsWith('+') ? digits.slice(1) : digits;
  if (!/^[1-9]\d{7,14}$/.test(bare)) {
    throw new AppError('Voice caller must be an E.164 number', {
      code: 'CHANNEL_EVENT_MALFORMED', status: 422,
    });
  }
  return `+${bare}`;
}

function malformedEvent(reason) {
  throw new AppError(`Voice event is not well-formed: ${reason}`, {
    code: 'CHANNEL_EVENT_MALFORMED', status: 422,
  });
}

function isCanonicalInstant(value) {
  return typeof value === 'string' && value !== '' && Number.isSafeInteger(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

/**
 * Normalize one verified PBX notification. Speaks the `call.inbound`
 * shape when the body carries it, and the kit's minimal envelope otherwise
 * (the same fallback every fake adapter shares, so the kit drives
 * receive/replay/out-of-order through the provider path).
 */
function normalizeVoiceInbound(event) {
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
  if (parsed.event !== 'call.inbound') {
    malformedEvent(`unsupported voice event "${String(parsed.event).slice(0, 64)}"`);
  }
  const callId = typeof parsed.call_id === 'string' ? parsed.call_id : '';
  if (callId === '' || callId.length > 256) {
    malformedEvent('"call_id" must be bounded non-empty text (1-256 characters)');
  }
  const from = canonicalVoiceNumber(parsed.from);
  if (!isCanonicalInstant(parsed.started_at)) {
    malformedEvent('"started_at" must be a canonical instant');
  }
  return {
    providerEventId: callId,
    subject: `tel:${from}`,
    sequence: null,
    occurredAt: parsed.started_at,
  };
}

/**
 * Build the fake-backed voice adapter: `{ definition, api }` in the
 * fixture's shape, so the kit harness drives it unchanged. The double
 * keeps no secret of its own: verification is the HMAC over the secret
 * production resolves through the same `resolveSecret` edge.
 */
export function createVoiceChannelAdapter(options = {}) {
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
      name: options.name ?? VOICE_ADAPTER_NAME,
      version: VOICE_ADAPTER_VERSION,
      label: 'PBX incoming calls (fake-backed)',
      channel: 'voice',
      config: { testOnly: true },

      verifyInbound({ rawBody, headers, secret }) {
        const signature = headers?.['x-channel-signature-256'];
        const timestamp = headers?.['x-channel-timestamp'];
        const ok = verifyHmacWebhook({ rawBody, signature, timestamp, secret });
        if (!ok) return { ok: false };
        return { ok: true, event: Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '') };
      },

      normalizeInbound(event) {
        return normalizeVoiceInbound(event);
      },

      ...inboundOnlyOutbound('PBX incoming calls'),
    },
    api,
  };
}

/** Build one PBX inbound-call body. */
export function voiceEventBody({ callId, from = '+393331234567', to = '+390200000001', at = null }) {
  return JSON.stringify({
    event: 'call.inbound',
    call_id: callId,
    from,
    to,
    started_at: at ?? new Date().toISOString(),
  });
}
