// @ts-check

import { assertHistoryPage } from './adapter.js';

/**
 * The channel adapter contract-test kit (backlog:e5532d1c9146,
 * INTEGRATION_RUNTIME.md §Provider contract-test kit).
 *
 * A published suite a channel adapter runs against its own implementation:
 * receive, send, replay, bad signature, out-of-order delivery, no secret
 * material in storage, and per-space isolation. An adapter that passes it
 * is compatible; one that does not is not shipped.
 *
 * The kit drives behavior only through the caller-built harness — the same
 * operations the deployment wires — so it proves the adapter against real
 * storage, real jobs and real retries, never against a second
 * implementation of them. Fault injection (`faults`) is caller-provided
 * because only the adapter's own double knows how to fail on cue; the
 * fixture adapter's double is in `fixture.js`.
 *
 * Harness shape:
 * ```
 * {
 *   register(spaceId, input) -> {connection},
 *   activate(spaceId, connectionKey) -> connection,
 *   ingest(spaceId, {connectionKey, rawBody, headers}) -> result,
 *   queue(spaceId, {connectionKey, message, messageKey}) -> {jobId},
 *   pump(jobId) -> settled job row ({state, attempt, ...}),
 *   faults: {
 *     sentCount() -> number, transientNext(n), refuseNext(), timeoutNext(), reset(),
 *     sign(rawBody) -> headers,
 *   },
 *   connections(spaceId) -> rows, inbox(spaceId) -> rows,
 *   letters(spaceId, state?) -> rows, dumpStorage() -> Promise<string>,
 * }
 * ```
 */

const CHECKS = Object.freeze([
  'receive',
  'send',
  'replay',
  'bad-signature',
  'out-of-order',
  'no-secrets',
  'space-isolation',
  'history',
]);

/**
 * @param {{
 *   adapter: any,
 *   secrets: {ref: string, value: string},
 *   spaceA?: string, spaceB?: string,
 *   accountA?: string, accountB?: string,
 *   actor?: any,
 *   harness: any,
 * }} options
 * @returns {Promise<Array<{name: string, pass: boolean, detail: string}>>}
 */
export async function runChannelAdapterKit(options) {
  const adapter = options?.adapter;
  if (!adapter || typeof adapter.name !== 'string') {
    throw new Error('runChannelAdapterKit needs the adapter definition under test');
  }
  const harness = options?.harness;
  for (const key of ['register', 'activate', 'ingest', 'queue', 'pump', 'connections', 'inbox', 'letters', 'dumpStorage']) {
    if (typeof harness?.[key] !== 'function') {
      throw new Error(`runChannelAdapterKit harness needs "${key}"`);
    }
  }
  const faults = harness.faults;
  for (const key of ['sentCount', 'transientNext', 'refuseNext', 'timeoutNext', 'reset', 'sign']) {
    if (typeof faults?.[key] !== 'function') {
      throw new Error(`runChannelAdapterKit harness.faults needs "${key}"`);
    }
  }
  const { ref: secretRef, value: secretValue } = options.secrets ?? {};
  if (typeof secretRef !== 'string' || typeof secretValue !== 'string' || secretValue === '') {
    throw new Error('runChannelAdapterKit needs secrets {ref, value}');
  }
  const spaceA = options.spaceA ?? 'kit-space-a';
  const spaceB = options.spaceB ?? 'kit-space-b';
  const accountA = options.accountA ?? '+390200000001';
  const accountB = options.accountB ?? '+390200000002';
  const actor = options.actor ?? { type: 'user', id: 'channel-kit' };

  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn() ?? 'ok';
      results.push({ name, pass: true, detail: String(detail) });
    } catch (error) {
      results.push({
        name,
        pass: false,
        detail: error && typeof error === 'object' && 'code' in error
          ? `${error.code}: ${error.message}` : String(error?.message ?? error),
      });
    }
  };
  const fail = (message) => { throw new Error(message); };
  const asCode = async (fn) => {
    try {
      await fn();
    } catch (error) {
      return error && typeof error === 'object' ? error.code : null;
    }
    return null;
  };

  // ---- setup: one bound account per space, both activated ----
  const regA = await harness.register(spaceA, {
    channel: adapter.channel, account: accountA,
    adapter: adapter.name, adapterVersion: adapter.version, secretRef, actor,
  });
  const regB = await harness.register(spaceB, {
    channel: adapter.channel, account: accountB,
    adapter: adapter.name, adapterVersion: adapter.version, secretRef, actor,
  });
  if (regA.duplicate || regB.duplicate) fail('setup registrations must be new');
  const keyA = regA.connection.sourceKey;
  const keyB = regB.connection.sourceKey;
  await harness.activate(spaceA, keyA);
  await harness.activate(spaceB, keyB);

  await check('receive', async () => {
    const rawBody = JSON.stringify({ id: 'evt-receive-1', subject: 'chat-kit-1', seq: 1 });
    const out = await harness.ingest(spaceA, { connectionKey: keyA, rawBody, headers: faults.sign(rawBody) });
    if (out.duplicate || out.effect !== 'applied') fail(`expected applied, got ${JSON.stringify(out)}`);
    const rows = harness.inbox(spaceA).filter((row) => row.providerEventId === 'evt-receive-1');
    if (rows.length !== 1 || rows[0].processed !== true) fail('inbox row missing or unprocessed');
    if (typeof rows[0].payloadFingerprint !== 'string' || rows[0].payloadFingerprint.length !== 64) {
      fail('payload fingerprint missing');
    }
    return `event ${rows[0].id}`;
  });

  await check('send', async () => {
    faults.reset();
    // Adapters behind a service window (Meta's 24 hours) refuse free text
    // with no observed inbound: the kit seeds one windowed inbound through
    // the real ingest path first, so the send proves the seeded window
    // rather than an absent one. Adapters without the capability send
    // exactly as before.
    if (adapter.outboundWindow && typeof adapter.outboundWindow.seedInbound === 'function') {
      const seed = adapter.outboundWindow.seedInbound({ from: accountA });
      const seeded = await harness.ingest(spaceA, { connectionKey: keyA, rawBody: seed, headers: faults.sign(seed) });
      if (seeded.effect !== 'applied') fail(`window seed must apply, got ${JSON.stringify(seeded)}`);
    }
    const before = faults.sentCount();
    const queued = await harness.queue(spaceA, {
      connectionKey: keyA, message: { to: accountA, text: 'kit hello' }, messageKey: 'kit-send-1',
    });
    const settled = await harness.pump(queued.jobId);
    if (settled.state !== 'succeeded') fail(`expected succeeded, got ${settled.state}`);
    if (faults.sentCount() !== before + 1) fail('provider saw != 1 effective send');
    return `job ${settled.id}`;
  });

  await check('replay', async () => {
    const rawBody = JSON.stringify({ id: 'evt-replay-1', subject: 'chat-kit-1', seq: 2 });
    const headers = faults.sign(rawBody);
    const first = await harness.ingest(spaceA, { connectionKey: keyA, rawBody, headers });
    if (first.duplicate) fail('first delivery must not be a duplicate');
    const countBefore = harness.inbox(spaceA).length;
    const second = await harness.ingest(spaceA, { connectionKey: keyA, rawBody, headers });
    if (!second.duplicate || second.eventId !== first.eventId) fail(`replay must resolve identically, got ${JSON.stringify(second)}`);
    if (harness.inbox(spaceA).length !== countBefore) fail('replay created a row');
    return `event ${first.eventId} acknowledged twice, stored once`;
  });

  await check('bad-signature', async () => {
    const rawBody = JSON.stringify({ id: 'evt-forged-1', subject: 'chat-kit-1', seq: 3 });
    const headers = faults.sign(rawBody);
    const tampered = { ...headers, 'x-channel-signature-256': '0'.repeat(64) };
    const countBefore = harness.inbox(spaceA).length;
    const code = await asCode(() => harness.ingest(spaceA, { connectionKey: keyA, rawBody, headers: tampered }));
    if (code !== 'CHANNEL_SIGNATURE_INVALID') fail(`expected CHANNEL_SIGNATURE_INVALID, got ${code}`);
    if (harness.inbox(spaceA).length !== countBefore) fail('forged delivery wrote a row');
    return 'refused 401, nothing written';
  });

  await check('out-of-order', async () => {
    const newer = JSON.stringify({ id: 'evt-ooo-2', subject: 'chat-kit-ooo', seq: 2 });
    const older = JSON.stringify({ id: 'evt-ooo-1', subject: 'chat-kit-ooo', seq: 1 });
    const first = await harness.ingest(spaceA, { connectionKey: keyA, rawBody: newer, headers: faults.sign(newer) });
    if (first.effect !== 'applied') fail(`newer delivery must apply, got ${first.effect}`);
    const second = await harness.ingest(spaceA, { connectionKey: keyA, rawBody: older, headers: faults.sign(older) });
    if (second.effect !== 'ignored') fail(`older delivery must be ignored, got ${JSON.stringify(second)}`);
    const replay = await harness.ingest(spaceA, { connectionKey: keyA, rawBody: newer, headers: faults.sign(newer) });
    if (!replay.duplicate) fail('replay of the applied event must be a duplicate');
    return 'newest wins, older ignored with reason, replay idempotent';
  });

  await check('no-secrets', async () => {
    const dump = await harness.dumpStorage();
    if (dump.includes(secretValue)) fail('secret value present in stored rows');
    const connections = harness.connections(spaceA);
    if (!connections.some((row) => row.secretRef === secretRef)) fail('secret reference missing from the connection row');
    const serialized = JSON.stringify(connections);
    if (serialized.includes(secretValue)) fail('secret value present in the connection row');
    return 'reference stored, value nowhere';
  });

  await check('space-isolation', async () => {
    // A's webhook under B's space: unknown connection, never A's rows.
    const rawBody = JSON.stringify({ id: 'evt-xspace-1', subject: 'chat-kit-1', seq: 9 });
    const code = await asCode(() => harness.ingest(spaceB, { connectionKey: keyA, rawBody, headers: faults.sign(rawBody) }));
    if (code !== 'CHANNEL_CONNECTION_UNKNOWN') fail(`expected CHANNEL_CONNECTION_UNKNOWN, got ${code}`);
    const queueCode = await asCode(() => harness.queue(spaceB, {
      connectionKey: keyA, message: { to: accountA, text: 'cross-space' }, messageKey: 'kit-xspace-1',
    }));
    if (queueCode !== 'CHANNEL_CONNECTION_UNKNOWN') fail(`expected CHANNEL_CONNECTION_UNKNOWN, got ${queueCode}`);
    for (const row of harness.inbox(spaceB)) {
      if (row.connectionKey === keyA || row.providerEventId === 'evt-xspace-1') {
        fail('space B holds a row bound to space A');
      }
    }
    for (const row of harness.inbox(spaceA)) {
      if (row.spaceId !== spaceA) fail('space A holds a foreign row');
    }
    return 'no row crosses spaces in either direction';
  });

  await check('history', async () => {
    // Adapters without readable past skip with their reason: starting
    // their import refuses CHANNEL_HISTORY_UNAVAILABLE, so there is no
    // paging to prove here.
    const history = adapter.historyImport;
    if (!history || typeof history.listHistory !== 'function') {
      return 'adapter declares no readable past: import refuses CHANNEL_HISTORY_UNAVAILABLE';
    }
    const since = new Date(Date.now() - 3600 * 1000).toISOString();
    const call = (pageToken) => history.listHistory({
      secret: secretValue, account: accountA, since, pageToken, limit: 2,
    });
    const first = await call(null);
    const checked = assertHistoryPage(first, 2);
    const replayed = await call(null);
    if (JSON.stringify(replayed) !== JSON.stringify(first)) fail('the same page token must replay the same page');
    let pages = 1;
    let events = checked.events.length;
    let token = checked.nextPageToken;
    if (token !== null) {
      const second = await call(token);
      const following = assertHistoryPage(second, 2);
      const seen = new Set(checked.events.map((event) => event.providerEventId));
      for (const event of following.events) {
        if (seen.has(event.providerEventId)) fail('history pages overlap');
      }
      pages = 2;
      events += following.events.length;
      token = following.nextPageToken;
    }
    return `${events} event(s) across ${pages} page(s)${token === null ? ', past exhausted' : ', past continues'}`;
  });

  return Object.freeze(results);
}

export const CHANNEL_KIT_CHECKS = CHECKS;
