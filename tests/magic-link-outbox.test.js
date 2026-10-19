// @ts-check
/**
 * BO-F0-05 — magic-link delivery through the deployment outbox
 * (backlog:0cbae947, review round 1: P1 outbox routing, P2 orphan rows).
 *
 * The package performs no network I/O: `requestMagicLink` persists the
 * token row first, then enqueues exactly one job under the deterministic
 * key `magic-link:<tokenId>` with an actor. The persistent enqueue IS the
 * cross-process claim. This file proves that contract against a fake
 * persistent outbox plus a fake worker that follows the deployment protocol
 * the README documents (re-read the row fresh before sending; skip unless
 * the row is still live):
 *
 * - a re-enqueue under the same key returns the same job, never a second
 *   send (the claim survives a retry of the enqueue step);
 * - two racing requests mint two links and two jobs, and each settles
 *   exactly once — no cross-talk, no double send of one token;
 * - a token consumed before the worker runs never sends;
 * - a token expired before the worker runs never sends;
 * - a job whose row is gone never sends.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { consumeMagicLink, requestMagicLink } from '../packages/magic-link/src/index.js';
import { createMemoryMagicLinkStore } from '../packages/magic-link/src/store.js';
import { MAGIC_LINK_TTL_MS, isMagicLinkExpired, magicLinkSendKey } from '../packages/magic-link/src/rules.js';

const KNOWN = 'elena@studioaurora.it';

/** A fake persistent outbox with a fake worker following the README protocol. */
function rig() {
  let now = 1_700_000_000_000;
  /** @type {Map<string, { jobId: string, actor: unknown, message: { to: string, token: string, expiresAtIso: string } }>} */
  const jobs = new Map();
  /** @type {Array<{ to: string, token: string, expiresAtIso: string }>} */
  const sends = [];
  const store = createMemoryMagicLinkStore();
  const outbox = {
    enqueue: async (/** @type {{ key: string, actor: unknown, message: { to: string, token: string, expiresAtIso: string } }} */ job) => {
      const existing = jobs.get(job.key);
      if (existing) return { jobId: existing.jobId, duplicate: true };
      const jobId = `job-${jobs.size + 1}`;
      jobs.set(job.key, { jobId, actor: job.actor, message: { ...job.message } });
      return { jobId, duplicate: false };
    },
  };
  const edges = {
    directory: { lookup: async () => ({ subject: 'op-7f3a2c91' }) },
    outbox,
    store,
    clock: () => now,
  };
  // The deployment worker protocol (README "What it needs"): re-read the
  // row fresh and send only while it is still live.
  const settle = async (/** @type {string} */ jobId) => {
    const job = [...jobs.values()].find((entry) => entry.jobId === jobId);
    assert.ok(job, 'the worker only settles a claimed job');
    const row = store.find(job.message.token);
    if (!row || row.spent || isMagicLinkExpired(row, now)) return { sent: false };
    sends.push({ ...job.message });
    return { sent: true };
  };
  return {
    edges, jobs, sends, store,
    setNow: (/** @type {number} */ value) => { now = value; },
    now: () => now,
    settle,
  };
}

test('the send key is deterministic per token and bounded', () => {
  const token = `ml1.${'e'.repeat(32)}`;
  assert.equal(magicLinkSendKey(token), `magic-link:${token}`);
  assert.throws(() => magicLinkSendKey('junk'), /ml1\.<32-hex>/);
});

test('a re-enqueue under the same key returns the same job: one token, one send', async () => {
  const r = rig();
  await requestMagicLink(r.edges, { email: KNOWN });
  assert.equal(r.jobs.size, 1);
  const [[key, first]] = [...r.jobs.entries()];
  assert.match(key, /^magic-link:ml1\.[0-9a-f]{32}$/);
  const again = await r.edges.outbox.enqueue({ key, actor: { type: 'system', id: 'accordo' }, message: first.message });
  assert.equal(again.jobId, first.jobId, 'the retry of the enqueue step replays the claim');
  assert.equal(r.jobs.size, 1, 'still one job, never two');
  const settled = await r.settle(first.jobId);
  assert.equal(settled.sent, true);
  assert.equal(r.sends.length, 1, 'the provider is called once');
  const redeemed = await consumeMagicLink(r.edges, { token: first.message.token });
  assert.equal(redeemed.subject, 'op-7f3a2c91');
});

test('two racing requests mint two links and each settles exactly once', async () => {
  const r = rig();
  const [one, two] = await Promise.all([
    requestMagicLink(r.edges, { email: KNOWN }),
    requestMagicLink(r.edges, { email: KNOWN }),
  ]);
  assert.deepEqual(one, two, 'the receipts stay identical');
  assert.equal(r.jobs.size, 2, 'two requests are two links, each with its own claim');
  const jobIds = [...r.jobs.values()].map((job) => job.jobId).sort();
  assert.deepEqual(jobIds, ['job-1', 'job-2']);
  for (const jobId of jobIds) {
    const settled = await r.settle(jobId);
    assert.equal(settled.sent, true);
  }
  assert.equal(r.sends.length, 2, 'each claimed link sends once, neither sends twice');
  const tokens = r.sends.map((send) => send.token).sort();
  assert.notEqual(tokens[0], tokens[1], 'no cross-talk between the two links');
});

test('a token consumed before the worker runs never sends', async () => {
  const r = rig();
  await requestMagicLink(r.edges, { email: KNOWN });
  const [job] = [...r.jobs.values()];
  await consumeMagicLink(r.edges, { token: job.message.token });
  const settled = await r.settle(job.jobId);
  assert.equal(settled.sent, false, 'the worker re-reads and skips the spent row');
  assert.equal(r.sends.length, 0, 'no provider call for a redeemed link');
});

test('a token expired before the worker runs never sends', async () => {
  const r = rig();
  await requestMagicLink(r.edges, { email: KNOWN });
  const [job] = [...r.jobs.values()];
  r.setNow(r.now() + MAGIC_LINK_TTL_MS + 1);
  const settled = await r.settle(job.jobId);
  assert.equal(settled.sent, false, 'the worker re-reads and skips the dead row');
  assert.equal(r.sends.length, 0, 'no provider call past the ten-minute deadline');
});

test('a job whose row is gone never sends', async () => {
  const r = rig();
  // A durable backing may retain jobs past its rows: simulate a claimed job
  // whose token row no longer exists and prove the worker skips it.
  const ghostToken = `ml1.${'f'.repeat(32)}`;
  r.jobs.set(`magic-link:${ghostToken}`, {
    jobId: 'job-9',
    actor: { type: 'system', id: 'accordo' },
    message: { to: KNOWN, token: ghostToken, expiresAtIso: new Date(r.now() + MAGIC_LINK_TTL_MS).toISOString() },
  });
  const settled = await r.settle('job-9');
  assert.equal(settled.sent, false, 'no row, no send');
  assert.equal(r.sends.length, 0);
});
