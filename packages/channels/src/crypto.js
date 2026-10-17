// @ts-check

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Webhook verification primitives (backlog:e5532d1c9146).
 *
 * Raw bytes end to end: verification sees exactly what the provider signed,
 * before any mutation and before any parsing. A failure echoes nothing — no
 * payload, no signature, no key — and writes nothing.
 */

/** Fingerprint of verified bytes: what makes a replay provably the same event. */
export function fingerprintPayload(rawBody) {
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  if (bytes.length > 1024 * 1024) {
    throw new Error('payload exceeds the 1 MiB webhook bound');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Verify an HMAC-SHA256 webhook signature over `timestamp.body`.
 * Returns true only on an exact, constant-time match.
 *
 * @param {{rawBody: any, signature: unknown, timestamp: unknown, secret: string, toleranceSec?: number, nowMs?: number}} params
 */
export function verifyHmacWebhook({ rawBody, signature, timestamp, secret, toleranceSec = 300, nowMs = Date.now() }) {
  if (typeof secret !== 'string' || secret === '') return false;
  if (typeof signature !== 'string' || signature === '') return false;
  if (typeof timestamp !== 'string' || !/^\d{1,15}$/.test(timestamp)) return false;
  const skewMs = Math.abs(nowMs - Number(timestamp) * 1000);
  if (!Number.isFinite(skewMs) || skewMs > toleranceSec * 1000) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  let expected;
  try {
    expected = createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
      .digest();
  } catch {
    return false;
  }
  let provided;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Header pair a fixture/test client sends for a signed body. */
export function hmacWebhookHeaders(rawBody, secret, timestampSeconds) {
  const timestamp = String(timestampSeconds);
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  return {
    'x-channel-timestamp': timestamp,
    'x-channel-signature-256': createHmac('sha256', secret)
      .update(Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), body]))
      .digest('hex'),
  };
}
