// @ts-check
/**
 * BO-F0-05 — magic-link login (backlog:0cbae947).
 *
 * The backoffice logs in with Google or with a single-use link sent to the
 * work email, valid for ten minutes, no passwords. This file proves the
 * framework side of that story against injected edges (directory, delivery,
 * store, clock) — the deployment wires the real operator directory and the
 * outbox-backed delivery in the wiring turn:
 *
 * - a link redeems exactly once: the second use is refused (test);
 * - a link dies ten minutes after issue (test);
 * - known and unknown addresses get the byte-identical receipt: no user
 *   enumeration (test);
 * - malformed tokens are refused before any store is touched (test);
 * - Google sign-in is untouched: the framework owns no OAuth client and
 *   emits no Google request — see tests/admin-login.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createMagicLinkPackage, consumeMagicLink, requestMagicLink } from '../packages/magic-link/src/index.js';
import { createMemoryMagicLinkStore } from '../packages/magic-link/src/store.js';
import { MAGIC_LINK_TTL_MS } from '../packages/magic-link/src/rules.js';

const KNOWN = 'elena@studioaurora.it';
const UNKNOWN = 'stranger@example.com';

/** Opaque directory subjects, the way the control plane names them: never the address. */
const SUBJECTS = Object.freeze({ [KNOWN]: 'op-7f3a2c91' });

/** @param {{ known?: string[], failDirectory?: boolean }} [options] */
function scene(options = {}) {
  let now = 1_700_000_000_000;
  const sent = [];
  const store = createMemoryMagicLinkStore();
  const lookups = [];
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
    deliver: {
      send: async (/** @type {{ to: string, token: string, expiresAtIso: string }} */ message) => {
        sent.push({ ...message });
        return { queued: true };
      },
    },
    store,
    clock: () => now,
  };
  return {
    edges,
    sent,
    lookups,
    store,
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
  assert.equal(s.sent.length, 1);
  const first = await consumeMagicLink(s.edges, { token: s.sent[0].token });
  assert.equal(first.subject, SUBJECTS[KNOWN]);
  assert.ok(!('token' in first), 'the receipt never repeats the token');
  await assert.rejects(consumeMagicLink(s.edges, { token: s.sent[0].token }), /already used/);
});

test('a link dies ten minutes after issue', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: KNOWN });
  const { token, expiresAtIso } = s.sent[0];
  assert.equal(Date.parse(expiresAtIso) - s.now(), MAGIC_LINK_TTL_MS);
  s.setNow(s.now() + MAGIC_LINK_TTL_MS - 1);
  const ok = await consumeMagicLink(s.edges, { token });
  assert.equal(ok.subject, SUBJECTS[KNOWN]);
  await requestMagicLink(s.edges, { email: KNOWN });
  const late = s.sent[1].token;
  s.setNow(s.now() + MAGIC_LINK_TTL_MS + 1);
  await assert.rejects(consumeMagicLink(s.edges, { token: late }), /expired/);
});

test('known and unknown addresses get the byte-identical receipt', async () => {
  const s = scene();
  const known = await requestMagicLink(s.edges, { email: KNOWN });
  const unknown = await requestMagicLink(s.edges, { email: UNKNOWN });
  assert.deepEqual(known, unknown);
  assert.deepEqual(known, { status: 'link-requested', message: known.message });
  assert.equal(s.sent.length, 1, 'only the known address sends anything');
  assert.equal(s.sent[0].to, KNOWN);
  assert.ok(!JSON.stringify(known).includes(KNOWN), 'the receipt names nobody');
  assert.ok(s.store.find(s.sent[0].token) !== null, 'the known address records a row');
});

test('an unknown address records no row and the receipt stays identical', async () => {
  const s = scene();
  const receipt = await requestMagicLink(s.edges, { email: UNKNOWN });
  assert.equal(receipt.status, 'link-requested');
  assert.equal(s.sent.length, 0);
  assert.deepEqual(s.lookups, [UNKNOWN]);
});

test('malformed tokens are refused before any store is touched', async () => {
  const s = scene();
  let finds = 0;
  const counting = { ...s.store, find: (/** @type {string} */ id) => { finds += 1; return s.store.find(id); } };
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
  const spent = await consumeMagicLink(s.edges, { token: s.sent[0].token }).catch(() => null);
  assert.ok(spent && typeof spent === 'object');
  const second = await consumeMagicLink(s.edges, { token: s.sent[0].token }).catch(codeOf);
  assert.equal(first, second, 'unknown and spent share one refusal code');
  assert.match(String(first), /MAGIC_LINK_INVALID/);
});

test('concurrent consumes elect exactly one winner', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: KNOWN });
  const { token } = s.sent[0];
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

test('raw addresses are never stored and never returned', async () => {
  const s = scene();
  await requestMagicLink(s.edges, { email: '  ELENA@StudioAurora.it ' });
  const row = s.store.find(s.sent[0].token);
  assert.ok(row && !JSON.stringify(row).includes('ELENA') && !JSON.stringify(row).includes('@'),
    'the row keeps a hash, not the address');
  const receipt = await consumeMagicLink(s.edges, { token: s.sent[0].token });
  assert.ok(!JSON.stringify(receipt).includes('@'), 'the receipt names no address');
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
  assert.throws(() => createMagicLinkPackage({ deliver: /** @type {any} */ ({}) }), /send/);
});

test('a directory outage fails closed, never as a fake success', async () => {
  const s = scene({ failDirectory: true });
  const failure = await requestMagicLink(s.edges, { email: KNOWN }).then(
    () => { throw new Error('must refuse'); },
    (error) => error,
  );
  assert.equal(codeOf(failure), 'MAGIC_LINK_DIRECTORY_FAILED');
  assert.equal(s.sent.length, 0);
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
