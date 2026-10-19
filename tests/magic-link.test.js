// @ts-check
/**
 * BO-F0-05 — magic-link login (backlog:0cbae947).
 *
 * The backoffice logs in with Google or with a single-use link sent to the
 * work email, valid for ten minutes, no passwords. This file proves the
 * framework side of that story against injected edges (directory, outbox,
 * store, clock) — the deployment wires the real operator directory and the
 * channels-outbox-backed delivery:
 *
 * - a link redeems exactly once: the second use is refused (test);
 * - a link dies ten minutes after issue, on both sides of the claim (test);
 * - known and unknown addresses get the byte-identical receipt with the
 *   same store work: the receipt BODY cannot enumerate (test). Timing is
 *   out of the guarantee — throttling is the follow-up;
 * - a caller-supplied actor is stripped, never trusted: the send runs under
 *   the deployment send actor (test);
 * - an async store cannot fail open: interleaved consumes still elect one
 *   winner (test);
 * - malformed tokens are refused before any store is touched (test);
 * - a failed enqueue leaves no live orphan behind (test);
 * - a miswired clock fails closed, never with a receipt (test);
 * - missing email-hash secret custody fails closed, never with a row (test);
 * - Google sign-in is untouched: the framework owns no OAuth client and
 *   emits no Google request — see tests/admin-login.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMagicLinkPackage, consumeMagicLink, requestMagicLink } from '../packages/magic-link/src/index.js';
import { createMemoryMagicLinkStore } from '../packages/magic-link/src/store.js';
import { MAGIC_LINK_TTL_MS, isMagicLinkExpired } from '../packages/magic-link/src/rules.js';

const KNOWN = 'elena@studioaurora.it';
const UNKNOWN = 'stranger@example.com';

/** Opaque directory subjects, the way the control plane names them: never the address. */
const SUBJECTS = Object.freeze({ [KNOWN]: 'op-7f3a2c91' });

/** @param {{ known?: string[], failDirectory?: boolean, failEnqueue?: number, sendActor?: unknown, failSecret?: boolean, omitSecretCustody?: boolean }} [options] */
function scene(options = {}) {
  let now = 1_700_000_000_000;
  /** @type {Array<{ key: string, jobId: string, actor: unknown, message: { to: string, token: string, expiresAtIso: string } }>} */
  const jobs = [];
  const byKey = new Map();
  let failuresLeft = options.failEnqueue ?? 0;
  const store = createMemoryMagicLinkStore();
  const lookups = [];
  const secretLookups = [];
  const storeCalls = [];
  const countingStore = {
    save: async (/** @type {any} */ record) => { storeCalls.push('save'); return store.save(record); },
    find: async (/** @type {string} */ id) => { storeCalls.push('find'); return store.find(id); },
    spend: async (/** @type {string} */ id) => { storeCalls.push('spend'); return store.spend(id); },
  };
  const edges = {
    directory: {
      lookup: async (/** @type {string} */ email) => {
        lookups.push(email);
        if (options.failDirectory) throw new Error('driver is down');
        const known = options.known ?? [KNOWN];
        if (!known.includes(email)) return null;
        return { subject: SUBJECTS[email] ?? `op-${email.length.toString(16)}` };
      },
    },
    // Persistent idempotent claim, the way the channels outbox behaves: the
    // first enqueue under a key creates the job, a re-enqueue under the
    // same key returns it, never a second job.
    outbox: {
      enqueue: async (/** @type {{ key: string, actor: unknown, message: { to: string, token: string, expiresAtIso: string } }} */ job) => {
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw Object.assign(new Error('outbox down'), { code: 'OUTBOX_DOWN' });
        }
        if (byKey.has(job.key)) return { jobId: /** @type {string} */ (byKey.get(job.key)), duplicate: true };
        const jobId = `job-${byKey.size + 1}`;
        byKey.set(job.key, jobId);
        jobs.push({ key: job.key, jobId, actor: job.actor, message: { ...job.message } });
        return { jobId, duplicate: false };
      },
    },
    store: countingStore,
    clock: () => now,
    ...(options.sendActor !== undefined ? { sendActor: options.sendActor } : {}),
    ...(options.omitSecretCustody ? {} : {
      emailHashSecretRef: 'vault://test/magic-link-email-hash',
      resolveSecret: async (/** @type {string} */ reference, /** @type {{ purpose: string }} */ context) => {
        secretLookups.push({ reference, purpose: context?.purpose });
        if (options.failSecret) throw Object.assign(new Error('vault down'), { code: 'VAULT_DOWN' });
        return 'test-email-hash-secret';
      },
    }),
  };
  return {
    edges,
    jobs,
    lookups,
    secretLookups,
    store,
    storeCalls,
    resetStoreCalls: () => { storeCalls.length = 0; },
    setNow: (/** @type {number} */ value) => { now = value; },
    now: () => now,
  };
}

/** @param {any} error */
function codeOf(error) {
  return error?.code ?? error?.details?.code ?? String(error?.message ?? error);
}

test('a link redeems exactly once: the second use is refused', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: KNOWN });
  assert.equal(s.jobs.length, 1);
  const first = await consumeMagicLink(s.edges, { token: s.jobs[0].message.token });
  assert.equal(first.subject, SUBJECTS[KNOWN]);
  assert.ok(!('token' in first), 'the receipt never repeats the token');
  await assert.rejects(consumeMagicLink(s.edges, { token: s.jobs[0].message.token }), /already used/);
});

test('a link dies ten minutes after issue', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: KNOWN });
  const { token, expiresAtIso } = s.jobs[0].message;
  assert.equal(Date.parse(expiresAtIso) - s.now(), MAGIC_LINK_TTL_MS);
  s.setNow(s.now() + MAGIC_LINK_TTL_MS - 1);
  const ok = await consumeMagicLink(s.edges, { token });
  assert.equal(ok.subject, SUBJECTS[KNOWN]);
  await requestMagicLink(s.edges, { email: KNOWN });
  const late = s.jobs[1].message.token;
  s.setNow(s.now() + MAGIC_LINK_TTL_MS + 1);
  await assert.rejects(consumeMagicLink(s.edges, { token: late }), /expired/);
});

test('a token that crosses its deadline between check and claim refuses expired', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: KNOWN });
  const { token } = s.jobs[0].message;
  const issuedAt = s.now();
  // The consume pre-check reads a live instant, the post-claim re-read lands
  // past the deadline: the stale read must not redeem.
  const ticks = [issuedAt + MAGIC_LINK_TTL_MS - 1, issuedAt + MAGIC_LINK_TTL_MS + 5];
  const edges = { ...s.edges, clock: () => /** @type {number} */ (ticks.shift() ?? ticks[ticks.length - 1]) };
  const failure = await consumeMagicLink(edges, { token }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(failure), 'MAGIC_LINK_EXPIRED');
  assert.ok((await s.store.find(token))?.spent, 'the late row stays dead either way');
  await assert.rejects(consumeMagicLink(s.edges, { token }), /already used/);
});

test('known and unknown addresses get the byte-identical receipt', async () => {
  const s = scene();
  const known = await requestMagicLink(s.edges, { email: KNOWN });
  const unknown = await requestMagicLink(s.edges, { email: UNKNOWN });
  assert.deepEqual(known, unknown);
  assert.deepEqual(known, { status: 'link-requested', message: known.message });
  assert.equal(s.jobs.length, 1, 'only the known address enqueues anything');
  assert.equal(s.jobs[0].message.to, KNOWN);
  assert.ok(!JSON.stringify(known).includes(KNOWN), 'the receipt names nobody');
});

test('an unknown address leaves no live row; the store work is documented, timing is not promised', async () => {
  const s = scene();
  s.resetStoreCalls();
  const receipt = await requestMagicLink(s.edges, { email: UNKNOWN });
  const unknownCalls = s.storeCalls.filter((call) => call !== 'find');
  assert.deepEqual(unknownCalls, ['save', 'spend'], 'unknown: mint, save, then spend-and-discard');
  s.resetStoreCalls();
  await requestMagicLink(s.edges, { email: KNOWN });
  const knownCalls = s.storeCalls.filter((call) => call !== 'find');
  assert.deepEqual(knownCalls, ['save'], 'known: mint, save, then the outbox enqueue (not a store write)');
  assert.equal(receipt.status, 'link-requested');
  assert.equal(s.jobs.length, 1, 'the unknown address enqueues nothing');
  assert.deepEqual(s.lookups, [UNKNOWN, KNOWN]);
  for (const job of s.jobs) {
    assert.ok(!job.message.to.includes('stranger'), 'no unknown mailbox ever reaches the outbox');
  }
});

test('malformed tokens are refused before any store is touched', async () => {
  const s = scene();
  let finds = 0;
  const counting = { ...s.store, find: async (/** @type {string} */ id) => { finds += 1; return s.store.find(id); } };
  const edges = { ...s.edges, store: counting };
  await assert.rejects(consumeMagicLink(edges, { token: 'not-a-token' }), /ml1\.<32-hex>/);
  await assert.rejects(consumeMagicLink(edges, { token: '' }), /ml1\.<32-hex>/);
  assert.equal(finds, 0, 'junk must never reach the store');
});

test('a well-formed unknown token is refused without saying why it is unknown', async () => {
  const s = scene();
  const { mintMagicLinkToken } = await import('../packages/magic-link/src/rules.js');
  const first = await consumeMagicLink(s.edges, { token: mintMagicLinkToken() }).catch(codeOf);
  await requestMagicLink(s.edges, { email: KNOWN });
  const spent = await consumeMagicLink(s.edges, { token: s.jobs[0].message.token }).catch(() => null);
  assert.ok(spent && typeof spent === 'object');
  const second = await consumeMagicLink(s.edges, { token: s.jobs[0].message.token }).catch(codeOf);
  assert.equal(first, second, 'unknown and spent share one refusal code');
  assert.match(String(first), /MAGIC_LINK_INVALID/);
});

test('concurrent consumes elect exactly one winner', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: KNOWN });
  const { token } = s.jobs[0].message;
  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () => consumeMagicLink(s.edges, { token })),
  );
  const won = outcomes.filter((o) => o.status === 'fulfilled');
  const lost = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(won.length, 1);
  assert.equal(lost.length, 9);
  for (const outcome of lost) {
    assert.match(codeOf(outcome.reason), /MAGIC_LINK_INVALID/);
  }
});

test('a failed enqueue spends the row: no live orphan, the retry is the only live token', async () => {
  const s = scene({ failEnqueue: 1 });
  /** @type {string[]} */
  const minted = [];
  const rawSave = s.edges.store.save;
  s.edges.store.save = (/** @type {any} */ record) => { minted.push(record.tokenId); return rawSave(record); };
  const failure = await requestMagicLink(s.edges, { email: KNOWN }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(failure), 'MAGIC_LINK_DELIVERY_FAILED');
  assert.equal(s.jobs.length, 0, 'nothing was claimed');
  assert.equal(minted.length, 1, 'the failed attempt still persisted its row first');
  const orphaned = await consumeMagicLink(s.edges, { token: minted[0] }).catch(codeOf);
  assert.match(String(orphaned), /MAGIC_LINK_INVALID/, 'the failed row is dead, never redeemable');
  await requestMagicLink(s.edges, { email: KNOWN });
  assert.equal(s.jobs.length, 1, 'the retry claims the only job');
  const redeemed = await consumeMagicLink(s.edges, { token: s.jobs[0].message.token });
  assert.equal(redeemed.subject, SUBJECTS[KNOWN]);
});

test('raw addresses are never stored and never returned; the job payload carries exactly the delivery fields', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: '  ELENA@StudioAurora.it ' });
  const row = await s.store.find(s.jobs[0].message.token);
  assert.ok(row && !JSON.stringify(row).includes('ELENA') && !JSON.stringify(row).includes('@'),
    'the row keeps a hash, not the address');
  assert.deepEqual(Object.keys(s.jobs[0].message).sort(), ['expiresAtIso', 'to', 'token'],
    'the outbox payload is delivery material only: no extra copy of anything');
  const receipt = await consumeMagicLink(s.edges, { token: s.jobs[0].message.token });
  assert.ok(!JSON.stringify(receipt).includes('@'), 'the receipt names no address');
});

test('a miswired clock fails closed, never with a receipt', async () => {
  const s = scene();
  for (const broken of [NaN, Infinity, -1, 1.5, 'tomorrow', undefined]) {
    const edges = { ...s.edges, clock: () => broken };
    const requestFailure = await requestMagicLink(edges, { email: KNOWN }).then(
      () => { throw new Error('must refuse'); },
      (error) => error,
    );
    assert.equal(codeOf(requestFailure), 'MAGIC_LINK_CLOCK_FAILED', `request clock ${String(broken)}`);
    assert.equal(requestFailure?.status, 502);
  }
  await requestMagicLink(s.edges, { email: KNOWN });
  const { token } = s.jobs[0].message;
  const consumeFailure = await consumeMagicLink({ ...s.edges, clock: () => NaN }, { token }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(consumeFailure), 'MAGIC_LINK_CLOCK_FAILED');
  assert.ok(!isMagicLinkExpired(/** @type {any} */ (await s.store.find(token)), s.now()), 'the refusal spent nothing and expired nothing');
});

test('the send actor is deployment-owned: a caller actor is stripped, never trusted', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: KNOWN });
  assert.deepEqual(s.jobs[0].actor, { type: 'system', id: 'accordo' });
  // Even a well-formed forged system actor in the request changes nothing.
  await requestMagicLink(s.edges, { email: KNOWN, actor: { type: 'system', id: 'accordo' } });
  await requestMagicLink(s.edges, { email: KNOWN, actor: { type: 'user', id: 'op-7f3a2c91' } });
  // Junk in the request is stripped too, not refused: it was never an input.
  await requestMagicLink(s.edges, { email: KNOWN, actor: { type: 'robot', id: 'x' } });
  for (const job of s.jobs) {
    assert.deepEqual(job.actor, { type: 'system', id: 'accordo' }, 'every job carries the service actor');
  }
  // The deployment overrides the send actor through the edges, not the request.
  const owned = scene({ sendActor: { type: 'user', id: 'op-deploy' } });
  await requestMagicLink(owned.edges, { email: KNOWN });
  assert.deepEqual(owned.jobs[0].actor, { type: 'user', id: 'op-deploy' });
  // A junk deployment actor refuses at request time, never silently.
  const junk = scene({ sendActor: { type: 'robot', id: 'x' } });
  const junkFailure = await requestMagicLink(junk.edges, { email: KNOWN }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(junkFailure?.details?.field, 'sendActor.type');
});

test('interleaved consumes over an async store still elect one winner', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: KNOWN });
  const { token } = s.jobs[0].message;
  // Both consumes read through the same deferred find: the reads resolve
  // together, past each other, before either spend runs. The winner must
  // still be exactly one, because spend awaits nothing between check and
  // mark — the way a durable conditional write behaves.
  let release = () => {};
  const gate = new Promise((resolve) => { release = /** @type {() => void} */ (resolve); });
  const deferred = {
    save: (/** @type {any} */ record) => s.store.save(record),
    find: async (/** @type {string} */ id) => { await gate; return s.store.find(id); },
    spend: (/** @type {string} */ id) => s.store.spend(id),
  };
  const edges = { ...s.edges, store: deferred };
  const first = consumeMagicLink(edges, { token });
  const second = consumeMagicLink(edges, { token });
  release();
  const outcomes = await Promise.allSettled([first, second]);
  const won = outcomes.filter((o) => o.status === 'fulfilled');
  const lost = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(won.length, 1, 'one winner despite the interleaved reads');
  assert.equal(lost.length, 1);
  assert.match(codeOf(/** @type {any} */ (lost[0]).reason), /MAGIC_LINK_INVALID/);
});

test('missing email-hash secret custody fails closed, never with a row', async () => {
  const bare = scene({ omitSecretCustody: true });
  const failure = await requestMagicLink(bare.edges, { email: KNOWN }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(failure), 'MAGIC_LINK_NOT_CONFIGURED');
  assert.equal(bare.jobs.length, 0);
  const down = scene({ failSecret: true });
  const vaultFailure = await requestMagicLink(down.edges, { email: KNOWN }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(vaultFailure), 'MAGIC_LINK_SECRET_UNAVAILABLE');
  assert.equal(vaultFailure?.status, 502);
  assert.equal(down.jobs.length, 0);
  assert.deepEqual(down.secretLookups, [
    { reference: 'vault://test/magic-link-email-hash', purpose: 'magic-link-email-hash' },
  ]);
});

test('an unknown package option is refused, never silently dropped', async () => {
  assert.throws(
    () => createMagicLinkPackage(/** @type {any} */ ({ deliver: () => {} })),
    /unknown magic-link option 'deliver'/,
  );
  const pkg = createMagicLinkPackage();
  assert.equal(pkg.name, 'magic-link');
});

test('unwired edges refuse loudly instead of inventing custody', async () => {
  const requestFailure = await requestMagicLink({ clock: () => 0 }, { email: KNOWN }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(requestFailure), 'MAGIC_LINK_NOT_CONFIGURED');
  const consumeFailure = await consumeMagicLink({ clock: () => 0 }, { token: `ml1.${'c'.repeat(32)}` }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(consumeFailure), 'MAGIC_LINK_NOT_CONFIGURED');
  assert.throws(() => createMagicLinkPackage({ directory: /** @type {any} */ ({}) }), /lookup/);
  assert.throws(() => createMagicLinkPackage({ outbox: /** @type {any} */ ({}) }), /enqueue/);
});

test('a directory outage fails closed, never as a fake success', async () => {
  const s = scene({ failDirectory: true });
  const failure = await requestMagicLink(s.edges, { email: KNOWN }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(failure), 'MAGIC_LINK_DIRECTORY_FAILED');
  assert.equal(s.jobs.length, 0);
});

test('the package declares itself honestly', async () => {
  const pkg = createMagicLinkPackage();
  assert.equal(pkg.name, 'magic-link');
  const meta = pkg.metadata();
  assert.equal(meta.ttlMinutes, 10);
  assert.equal(meta.singleUse, true);
  assert.equal(meta.identicalReceipt, true);
  assert.equal(meta.sendsEmail, false);
  assert.ok(Array.isArray(meta.notModeled) && meta.notModeled.length > 0);
});
