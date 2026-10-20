// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AuditLog } from '../packages/core/src/audit.js';
import { createDatabase } from '../packages/core/src/database.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import {
  CALL_TRANSCRIPT_PURGE_HANDLER,
  CALL_TRANSCRIPT_PURGE_KIND,
  CALL_TRANSCRIPT_PURGE_VERSION,
  addMonthsUtc,
  createCallIntelligence,
  isExpired,
  registerCallTranscriptPurge,
  seedCallTranscriptPurge,
} from '../packages/intelligence/src/call-intelligence.js';
import { ConflictError } from '../packages/core/index.js';
import { createIntelligenceDomain } from '../packages/intelligence/src/index.js';
import { createLlmOperations, openLlmComplete } from '../packages/llm/src/operations.js';
import { createFixtureLlmAdapter } from '../packages/llm/src/fixture.js';

/**
 * Call intelligence (BO-F1-08, backlog:588db7766206): the start-of-call
 * notice gates every save, transcripts expire per space (12 months by
 * default), the purge erases them, and the LLM summary stores buying
 * signals that cite their transcript — on real sqlite, real module
 * services, the real llm operations. The fixture adapter stands in only
 * for the LLM provider (owner decision MEM_ACC_DECISIONS: no real
 * credentials in tests), answering the scripted extraction JSON.
 */

const here = dirname(fileURLToPath(import.meta.url));
const loadManifest = (pkg, name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', pkg, 'modules', `${name}.module.json`), 'utf8'),
);

const SPACE = 'call-a';
const SPACE_SHORT = 'call-short';
const USER = { type: 'user', id: 'operator-elena' };
const LLM_SECRET = 'call-llm-secret-1';
const NOW = '2026-10-20T12:00:00.000Z';

const TRANSCRIPT = [
  'Operatrice: buongiorno, la chiamo dalla palestra per la prova gratuita.',
  'Cliente: il budget massimo è 800 euro, non voglio superare questa cifra.',
  'Cliente: vorrei iniziare a gennaio, prima delle feste è impossibile.',
  'Cliente: sono molto interessato al corso di pilates.',
  'Cliente: ho un dubbio sugli orari serali, finisco tardi al lavoro.',
].join('\n');

const SUMMARY_ANSWER = JSON.stringify({
  summary: 'Cliente con budget 800 euro, inizio a gennaio, interessato al pilates, dubbio sugli orari serali.',
  signals: [
    { type: 'budget', excerpt: 'il budget massimo è 800 euro' },
    { type: 'timing', excerpt: 'vorrei iniziare a gennaio' },
    { type: 'interest', excerpt: 'sono molto interessato al corso di pilates' },
    { type: 'doubt', excerpt: 'ho un dubbio sugli orari serali' },
  ],
});

const CALL_MODULES = ['call-notice', 'call-transcript', 'call-signal'];
const LLM_MODULES = ['llm-usage-day', 'llm-call-audit'];

function setupCallHarness({ withLlm = false, retention = undefined, llmAnswers = null } = {}) {
  const database = createDatabase({ path: ':memory:' });
  const manifests = [
    ...CALL_MODULES.map((name) => ({ pkg: 'intelligence', name })),
    ...(withLlm ? LLM_MODULES.map((name) => ({ pkg: 'llm', name })) : []),
  ];
  for (const { pkg, name } of manifests) {
    for (const { sql } of recordModuleMigrations([{ name, manifest: loadManifest(pkg, name) }])) {
      database.raw.exec(sql);
    }
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const { name } of manifests) {
    const built = createRecordModuleFromManifest(
      loadManifest(manifests.find((entry) => entry.name === name).pkg, name),
      { database, audit, events, references: {} },
    );
    modules.set(name, { service: built.service });
  }

  let llm = null;
  let llmApi = null;
  if (withLlm) {
    const fixture = createFixtureLlmAdapter({
      secret: LLM_SECRET,
      answers: llmAnswers ?? [{ text: SUMMARY_ANSWER }],
    });
    llmApi = fixture.api;
    const llmOps = createLlmOperations({
      adapters: [fixture.definition],
      spaces: {
        [SPACE]: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 },
        [SPACE_SHORT]: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 },
      },
      secretRef: `secret://${SPACE}/llm`,
      resolveSecret: async () => LLM_SECRET,
      clock: () => Date.parse(NOW),
    });
    llm = openLlmComplete(llmOps, { modules });
  }

  // The harness database hands the summarize commit its transaction, like
  // the composed runtime does through runtime.database: the signal set and
  // the summary land together or not at all, even under sqlite.
  const ops = createCallIntelligence({ modules, llm, retention, database, now: () => NOW });
  return {
    database, modules, ops, llmApi,
    notices: () => modules.get('call-notice').service.listWhere({}),
    transcripts: () => modules.get('call-transcript').service.listWhere({}),
    signals: () => modules.get('call-signal').service.listWhere({}),
    async close() {
      await database.close?.();
    },
  };
}

const outcome = (promise) => promise.then(
  (result) => ({ accepted: true, result }),
  (error) => ({ accepted: false, code: error.code, status: error.status, message: error.message }),
);

const NOTICE = {
  spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
  callRef: 'call-1', channel: 'phone', actor: USER,
};

async function noticeAndSave(ops, overrides = {}) {
  await ops.recordCallNotice({ ...NOTICE, ...overrides.notice });
  return ops.saveCallTranscript({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-1', text: TRANSCRIPT, recordedAt: '2026-10-01T10:00:00.000Z', actor: USER,
    ...overrides.transcript,
  });
}

test('without a recorded notice no text is saved, and nothing is written', async (t) => {
  const harness = setupCallHarness();
  t.after(() => harness.close());
  const answer = await outcome(harness.ops.saveCallTranscript({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-1', text: TRANSCRIPT, actor: USER,
  }));
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'CALL_NOTICE_MISSING');
  assert.equal(answer.status, 409);
  assert.equal((await harness.transcripts()).length, 0, 'a refused save leaves no transcript row');
});

test('the notice gates the save: recorded notice, then the transcript lands with a 12-month deadline', async (t) => {
  const harness = setupCallHarness();
  t.after(() => harness.close());
  const noticed = await harness.ops.recordCallNotice(NOTICE);
  assert.equal(noticed.replayed, false);
  const saved = await noticeAndSave(harness.ops);
  assert.equal(saved.replayed, false);
  assert.equal(saved.transcript.expiresAt, '2027-10-01T10:00:00.000Z', 'default retention is 12 calendar months');
  assert.equal(saved.transcript.purgedAt, null);
});

test('retention is per space: a 1-month space expires 1 month after recording', async (t) => {
  const harness = setupCallHarness({ retention: { bySpace: { [SPACE_SHORT]: 1 } } });
  t.after(() => harness.close());
  await harness.ops.recordCallNotice({ ...NOTICE, spaceId: SPACE_SHORT });
  const saved = await harness.ops.saveCallTranscript({
    spaceId: SPACE_SHORT, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-1', text: TRANSCRIPT, recordedAt: '2026-10-01T10:00:00.000Z', actor: USER,
  });
  assert.equal(saved.transcript.expiresAt, '2026-11-01T10:00:00.000Z');
});

test('a transcript for another customer than the notice names is refused', async (t) => {
  const harness = setupCallHarness();
  t.after(() => harness.close());
  await harness.ops.recordCallNotice(NOTICE);
  const answer = await outcome(harness.ops.saveCallTranscript({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c2',
    callRef: 'call-1', text: TRANSCRIPT, actor: USER,
  }));
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'CALL_SUBJECT_MISMATCH');
});

test('the summary stores signals that cite the transcript, word for word', async (t) => {
  const harness = setupCallHarness({ withLlm: true });
  t.after(() => harness.close());
  await noticeAndSave(harness.ops);
  const summarized = await harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER });
  assert.equal(summarized.replayed, false);
  assert.match(summarized.summary, /800 euro/);
  assert.deepEqual(
    summarized.signals.map((entry) => entry.type).sort(),
    ['budget', 'doubt', 'interest', 'timing'],
  );
  const rows = await harness.signals();
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.transcriptRef, 'call-transcript:call-a:call-1', 'every signal carries its source in the transcript');
    assert.ok(TRANSCRIPT.includes(row.excerpt), 'every excerpt quotes the transcript');
  }
  assert.equal(harness.llmApi.state.calls.length, 1);
  const replayed = await harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER });
  assert.equal(replayed.replayed, true, 'a summarized call replays without spending again');
  assert.equal(harness.llmApi.state.calls.length, 1, 'no second provider call');
});

test('a summary answer quoting text outside the transcript is refused, and nothing is stored', async (t) => {
  const harness = setupCallHarness({
    withLlm: true,
    llmAnswers: [{
      text: JSON.stringify({
        summary: 'Riassunto inventato.',
        signals: [{ type: 'budget', excerpt: 'un budget che nessuno ha mai detto' }],
      }),
    }],
  });
  t.after(() => harness.close());
  await noticeAndSave(harness.ops);
  const answer = await outcome(harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER }));
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'CALL_SUMMARY_INVALID');
  assert.equal((await harness.signals()).length, 0, 'a refused summary leaves no signal');
  const [transcript] = await harness.transcripts();
  assert.equal(transcript.summary, null, 'a refused summary leaves no summary');
});

test('without a language model the summary refuses instead of inventing one', async (t) => {
  const harness = setupCallHarness();
  t.after(() => harness.close());
  await noticeAndSave(harness.ops);
  const answer = await outcome(harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER }));
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'CALL_SUMMARY_UNAVAILABLE');
});

test('after 12 months the purge wipes text and summary and stamps the proof', async (t) => {
  const harness = setupCallHarness({ withLlm: true });
  t.after(() => harness.close());
  await noticeAndSave(harness.ops);
  await harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER });

  const early = await harness.ops.purgeExpiredTranscripts({ now: '2027-09-30T10:00:00.000Z', actor: USER });
  assert.deepEqual(early.purged, [], 'one day before the deadline nothing is erased');

  const purged = await harness.ops.purgeExpiredTranscripts({ now: '2027-10-01T10:00:00.000Z', actor: USER });
  assert.deepEqual(purged.purged, [{ callRef: 'call-1', purgedAt: '2027-10-01T10:00:00.000Z' }]);
  const [row] = await harness.transcripts();
  assert.equal(row.text, null, 'the transcript text is gone');
  assert.equal(row.summary, null, 'the summary is gone');
  assert.ok(!String(row.text ?? '').includes('800'), 'no personal data survives in the row');
  const signals = await harness.signals();
  assert.equal(signals.length, 4, 'signals stay: they are the working evidence quoting the erased transcript');

  const read = await harness.ops.readCustomerCalls({ spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1' });
  assert.equal(read.calls.length, 1);
  assert.equal(read.calls[0].transcript.available, false);
  assert.match(read.calls[0].transcript.reason, /retention/);
  const summarized = await outcome(harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER }));
  assert.equal(summarized.accepted, false);
  assert.equal(summarized.code, 'CALL_TRANSCRIPT_PURGED');
});

test('the customer read returns the latest call first with summary, signals and openable transcript', async (t) => {
  const harness = setupCallHarness({ withLlm: true });
  t.after(() => harness.close());
  await harness.ops.recordCallNotice({ ...NOTICE, callRef: 'call-old' });
  await harness.ops.saveCallTranscript({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-old', text: TRANSCRIPT, recordedAt: '2026-09-01T10:00:00.000Z', actor: USER,
  });
  await noticeAndSave(harness.ops);
  await harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER });

  const read = await harness.ops.readCustomerCalls({ spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1' });
  assert.equal(read.calls.length, 2);
  assert.equal(read.calls[0].callRef, 'call-1', 'latest first');
  assert.match(read.calls[0].summary, /800 euro/);
  assert.equal(read.calls[0].signals.length, 4);
  assert.equal(read.calls[0].transcript.available, true);
  assert.equal(read.calls[0].transcript.text, TRANSCRIPT);
  assert.equal(read.calls[0].channel, 'phone');
  assert.equal(read.calls[1].summary, null, 'an unsummarized call reads without a summary');
  const other = await harness.ops.readCustomerCalls({ spaceId: SPACE, subjectResource: 'contact', subjectId: 'c2' });
  assert.deepEqual(other.calls, [], 'one customer never sees another customer calls');
});

test('a repeated notice and a repeated identical save resolve without a second row', async (t) => {
  const harness = setupCallHarness();
  t.after(() => harness.close());
  await harness.ops.recordCallNotice(NOTICE);
  const replayed = await harness.ops.recordCallNotice(NOTICE);
  assert.equal(replayed.replayed, true);
  assert.equal((await harness.notices()).length, 1);
  await noticeAndSave(harness.ops);
  const savedAgain = await harness.ops.saveCallTranscript({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-1', text: TRANSCRIPT, recordedAt: '2026-10-01T10:00:00.000Z', actor: USER,
  });
  assert.equal(savedAgain.replayed, true);
  assert.equal((await harness.transcripts()).length, 1);
  const conflict = await outcome(harness.ops.recordCallNotice({ ...NOTICE, channel: 'whatsapp' }));
  assert.equal(conflict.accepted, false);
  assert.equal(conflict.code, 'CALL_NOTICE_CONFLICT');
});

test('the domain hands the composed llm-complete capability to the summarize operation', async (t) => {
  const harness = setupCallHarness({ withLlm: true });
  t.after(() => harness.close());
  const domain = createIntelligenceDomain({
    llm: {
      capabilities: [{
        name: 'llm-complete',
        version: 1,
        create: ({ modules }) => openLlmComplete(
          createLlmOperations({
            adapters: [createFixtureLlmAdapter({ secret: LLM_SECRET, answers: [{ text: SUMMARY_ANSWER }] }).definition],
            spaces: { [SPACE]: { enabled: true, adapter: 'fixture-llm', adapterVersion: 1 } },
            secretRef: `secret://${SPACE}/llm`,
            resolveSecret: async () => LLM_SECRET,
            clock: () => Date.parse(NOW),
          }),
          { modules },
        ),
      }],
    },
  });
  const runtime = { modules: harness.modules };
  const byName = Object.fromEntries(domain.operations.map((entry) => [entry.name, entry]));
  assert.deepEqual(
    Object.keys(byName).sort(),
    ['purge-expired-transcripts', 'read-customer-calls', 'record-call-notice', 'save-call-transcript', 'summarize-call'],
  );
  await byName['record-call-notice'].create(runtime)({ ...NOTICE });
  await byName['save-call-transcript'].create(runtime)({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-1', text: TRANSCRIPT, recordedAt: '2026-10-01T10:00:00.000Z', actor: USER,
  });
  const summarized = await byName['summarize-call'].create(runtime)({ spaceId: SPACE, callRef: 'call-1', actor: USER });
  assert.equal(summarized.signals.length, 4, 'the handed-over adapter summarizes through the domain seam');
  const read = await byName['read-customer-calls'].create(runtime)(
    { spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1' });
  assert.equal(read.calls.length, 1);

  const bare = createIntelligenceDomain();
  const bareOps = Object.fromEntries(bare.operations.map((entry) => [entry.name, entry]));
  await bareOps['record-call-notice'].create(runtime)({ ...NOTICE, callRef: 'call-9' });
  await bareOps['save-call-transcript'].create(runtime)({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-9', text: TRANSCRIPT, recordedAt: '2026-10-01T10:00:00.000Z', actor: USER,
  });
  const refused = await outcome(bareOps['summarize-call'].create(runtime)(
    { spaceId: SPACE, callRef: 'call-9', actor: USER }));
  assert.equal(refused.code, 'CALL_SUMMARY_UNAVAILABLE', 'without llm composed the summary refuses, never at boot');
});

test('two concurrent summarizes converge on one set of signals, never eight', async (t) => {
  const harness = setupCallHarness({ withLlm: true });
  t.after(() => harness.close());
  await noticeAndSave(harness.ops);
  const [first, second] = await Promise.all([
    harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER }),
    harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER }),
  ]);
  const replayed = [first.replayed, second.replayed].sort();
  assert.deepEqual(replayed, [false, true], 'one winner writes, the loser replays');
  assert.equal((await harness.signals()).length, 4, 'deterministic keys keep one signal set');
  assert.equal(first.summary, second.summary);
});

test('addMonthsUtc counts calendar months in UTC', () => {
  assert.equal(addMonthsUtc('2026-10-20T12:00:00.000Z', 12), '2027-10-20T12:00:00.000Z');
  assert.equal(addMonthsUtc('2026-10-01T10:00:00.000Z', 1), '2026-11-01T10:00:00.000Z');
  assert.equal(addMonthsUtc('2026-11-15T00:00:00.000Z', 2), '2027-01-15T00:00:00.000Z');
});

test('a transient conflict with no committed winner propagates, never a partial replay', async (t) => {
  const harness = setupCallHarness({ withLlm: true });
  t.after(() => harness.close());
  await noticeAndSave(harness.ops);
  // A busy store on the first signal write: nothing committed, no winner.
  const signals = harness.modules.get('call-signal').service;
  const createManaged = signals.createManaged.bind(signals);
  let calls = 0;
  signals.createManaged = async (...args) => {
    calls += 1;
    if (calls === 1) throw new ConflictError('write-write conflict on call-signal');
    return createManaged(...args);
  };
  try {
    const answer = await outcome(harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER }));
    assert.equal(answer.accepted, false, 'no committed summary exists, so the conflict retries');
    assert.equal(answer.code, 'CONFLICT');
    assert.equal(answer.message, 'write-write conflict on call-signal');
  } finally {
    signals.createManaged = createManaged;
  }
  assert.equal((await harness.signals()).length, 0, 'the rolled-back commit leaves no partial signal');
  const retry = await harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER });
  assert.equal(retry.replayed, false, 'the retry commits the full set');
  assert.equal(retry.signals.length, 4);
});

test('a purge that lands while the LLM works stops the commit: nothing is restored', async (t) => {
  const harness = setupCallHarness({ withLlm: false });
  t.after(() => harness.close());
  await noticeAndSave(harness.ops);
  const transcriptService = harness.modules.get('call-transcript').service;
  const row = (await harness.transcripts())[0];
  const llm = {
    complete: async () => {
      // Another beat erases the row while the summary is being written.
      await transcriptService.applyManaged(row.id, { text: null, summary: null, purgedAt: NOW }, { actor: USER });
      return { text: SUMMARY_ANSWER };
    },
  };
  const racing = createCallIntelligence({
    modules: harness.modules, llm, database: harness.database, now: () => NOW,
  });
  const answer = await outcome(racing.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER }));
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'CALL_TRANSCRIPT_PURGED');
  assert.equal((await harness.signals()).length, 0, 'no signal cites an erased transcript');
  const after = (await harness.transcripts())[0];
  assert.equal(after.summary ?? null, null, 'no summary is restored onto the purged row');
  assert.equal(after.purgedAt, NOW);
});

test('a transcript past its retention deadline cannot be summarized anymore', async (t) => {
  const harness = setupCallHarness({ withLlm: true });
  t.after(() => harness.close());
  await harness.ops.recordCallNotice(NOTICE);
  await harness.ops.saveCallTranscript({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-1', text: TRANSCRIPT, recordedAt: '2025-10-01T10:00:00.000Z', actor: USER,
  });
  const saved = (await harness.transcripts())[0];
  assert.ok(isExpired(saved, NOW), '13 months back is past the 12-month deadline');
  const answer = await outcome(harness.ops.summarizeCall({ spaceId: SPACE, callRef: 'call-1', actor: USER }));
  assert.equal(answer.accepted, false);
  assert.equal(answer.code, 'CALL_TRANSCRIPT_PURGED');
  assert.equal((await harness.signals()).length, 0, 'no derivative outlives the deadline');
});

test('the purge sweep is registered and seeded like the reminder sweep', async (t) => {
  const harness = setupCallHarness();
  t.after(() => harness.close());
  // The beat fires after the 1-month deadline of the short space: the
  // 12-month default space stays untouched. The short-space save goes
  // through the short retention, so its deadline is stamped at 1 month.
  const short = createCallIntelligence({
    modules: harness.modules, retention: { bySpace: { [SPACE_SHORT]: 1 } }, now: () => '2026-12-01T00:00:00.000Z',
  });
  await short.recordCallNotice({ ...NOTICE, spaceId: SPACE_SHORT });
  await short.saveCallTranscript({
    spaceId: SPACE_SHORT, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-1', text: TRANSCRIPT, recordedAt: '2026-10-01T10:00:00.000Z', actor: USER,
  });

  const registered = [];
  registerCallTranscriptPurge({ register: (entry) => registered.push(entry) }, { calls: short });
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, CALL_TRANSCRIPT_PURGE_KIND);
  assert.equal(registered[0].name, CALL_TRANSCRIPT_PURGE_HANDLER);
  assert.equal(registered[0].version, CALL_TRANSCRIPT_PURGE_VERSION);

  // The beat purges what expired before it fires: the 1-month space goes,
  // the 12-month default space stays. Notices are per call, like the saves.
  await harness.ops.recordCallNotice({ ...NOTICE, callRef: 'call-2' });
  await harness.ops.saveCallTranscript({
    spaceId: SPACE, subjectResource: 'contact', subjectId: 'c1',
    callRef: 'call-2', text: TRANSCRIPT, recordedAt: '2026-10-01T10:00:00.000Z', actor: USER,
  });
  const seeded = [];
  const store = {
    async enqueue(job) {
      seeded.push(job);
      return { id: `job-${seeded.length}` };
    },
  };
  const first = await seedCallTranscriptPurge({ store, at: '2026-12-01T00:00:00.000Z' });
  assert.equal(first.seeded, true);
  assert.equal(seeded[0].kind, CALL_TRANSCRIPT_PURGE_KIND);
  assert.equal(seeded[0].handler.name, CALL_TRANSCRIPT_PURGE_HANDLER);
  assert.equal(seeded[0].idempotencyRoot, 'call-transcript-purge:all:2026-12-01T00:00:00.000Z');
  assert.deepEqual(seeded[0].payload, {}, 'an unscoped beat purges every space');

  const scoped = await seedCallTranscriptPurge({ store, spaceId: SPACE_SHORT, at: '2026-12-01T00:00:00.000Z' });
  assert.equal(scoped.seeded, true);
  assert.equal(seeded[1].idempotencyRoot, `call-transcript-purge:${SPACE_SHORT}:2026-12-01T00:00:00.000Z`);
  assert.deepEqual(seeded[1].payload, { spaceId: SPACE_SHORT });

  const done = await registered[0].execute({ job: { payload: seeded[1].payload, scheduleAt: '2026-12-01T00:00:00.000Z' } });
  assert.equal(done.purged, 1, 'the sweep runs the purge operation');
  const rows = await harness.transcripts();
  assert.equal(rows.find((row) => row.spaceId === SPACE_SHORT)?.purgedAt, '2026-12-01T00:00:00.000Z');
  assert.equal(rows.find((row) => row.callRef === 'call-2')?.purgedAt ?? null, null);

  const refused = await outcome((async () => registerCallTranscriptPurge({}, { calls: short }))());
  assert.equal(refused.accepted, false, 'a registry without register refuses');
  const noStore = await outcome(seedCallTranscriptPurge({ at: '2026-12-01T00:00:00.000Z' }));
  assert.equal(noStore.accepted, false, 'seeding without a store refuses');
});
