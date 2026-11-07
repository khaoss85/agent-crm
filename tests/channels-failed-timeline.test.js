import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GMAIL_ADAPTER_NAME,
  GMAIL_ADAPTER_VERSION,
  createGmailChannelAdapter,
} from '../packages/channels/src/gmail.js';
import { createChannelsHarness } from './helpers/channels-harness.js';

/**
 * Scheda composer «invio fallito in cronologia» (backlog:97cba17c,
 * VALIDAZIONE A4): the worker of a terminally refused send writes the
 * subject's failed outbound timeline row through the composed
 * interaction-log handle — log as sent, then advance to failed — and the
 * dead letter stays the record of the failure. What the tests read below
 * is what the worker produced (dead-letter rows plus the recording fake
 * standing in for the composed capability), never a stub-injected card row.
 *
 * No Google credentials anywhere: the fake secret is a declared test-only
 * value.
 */

const SPACE = 'presti';
const MAILBOX = 'presti-pilota@example.com';
const CUSTOMER = 'cliente@example.com';
const SECRET_REF = 'vault://kit/gmail-failed-timeline';
const SECRET = 'gmail-fake-secret-failed-timeline';
const BODY = 'Preventivo palestra di marzo, corpo segreto prova 97cba17c';

const TIMELINE = { subject: { resource: 'contact', id: 'c1', owner: 'host' } };

function setup(interactionLog) {
  const { definition, api } = createGmailChannelAdapter({ mailbox: MAILBOX, secret: SECRET });
  const harness = createChannelsHarness({
    adapterDefinition: definition,
    fixtureApi: api,
    secretRef: SECRET_REF,
    secretValue: SECRET,
    tenantId: 'channel-kit-failed',
    interactionLog,
  });
  return { harness, api };
}

function recordingLog({ failLog = null, failAdvance = null } = {}) {
  const calls = { log: [], advance: [] };
  let n = 0;
  return {
    calls,
    handle: {
      logMessage: async (request) => {
        calls.log.push(request);
        if (failLog) throw failLog;
        n += 1;
        return { message: { id: `row-${n}`, status: 'sent' } };
      },
      advanceMessage: async (row, to, errorCode) => {
        calls.advance.push({ row, to, errorCode });
        if (failAdvance) throw failAdvance;
        return { message: { ...row, status: 'failed', errorCode } };
      },
    },
  };
}

async function registeredActive(harness) {
  const reg = await harness.register(SPACE, {
    channel: 'email', account: MAILBOX, adapter: GMAIL_ADAPTER_NAME, adapterVersion: GMAIL_ADAPTER_VERSION,
    secretRef: SECRET_REF,
  });
  await harness.activate(SPACE, reg.connection.sourceKey);
  return reg.connection.sourceKey;
}

function captureConsoleError(t) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  t.after(() => { console.error = original; });
  return lines;
}

test('97cba17c: a refused send writes the failed timeline row and the dead letter keeps the code', async (t) => {
  const log = recordingLog();
  const { harness, api } = setup(log.handle);
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  harness.faults.refuseNext();
  const queued = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: CUSTOMER, subject: 'Preventivo', text: BODY },
    messageKey: 'failed-timeline-1',
    timeline: TIMELINE,
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'failed_terminal');
  assert.equal(api.state.sentByKey.size, 0, 'the provider never sent');
  assert.equal(log.calls.log.length, 1, 'the worker logged one timeline row');
  assert.equal(log.calls.advance.length, 1, 'the worker advanced it to failed');
  assert.equal(log.calls.advance[0].to, 'failed');
  assert.equal(log.calls.advance[0].errorCode, 'CHANNEL_SEND_REFUSED');
  const letters = await harness.letters(SPACE);
  assert.equal(letters.length, 1, 'the dead letter stays the record');
  assert.equal(letters[0].errorCode, 'CHANNEL_SEND_REFUSED');
  assert.equal(letters[0].state, 'open');
});

test('97cba17c: a refused advance leaves no silent ghost — the letter names it and the cause is logged', async (t) => {
  const lines = captureConsoleError(t);
  const advanceError = new Error('applyManaged blew up mid-advance');
  advanceError.code = 'INTERACTIONS_INVALID_STATE';
  const log = recordingLog({ failAdvance: advanceError });
  const { harness } = setup(log.handle);
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  harness.faults.refuseNext();
  const queued = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: CUSTOMER, subject: 'Preventivo', text: BODY },
    messageKey: 'failed-timeline-ghost',
    timeline: TIMELINE,
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'failed_terminal');
  assert.equal(log.calls.log.length, 1, 'the sent row was committed before the advance refused');
  assert.equal(log.calls.advance.length, 1);
  const letters = await harness.letters(SPACE);
  assert.equal(letters.length, 1);
  assert.equal(letters[0].errorCode, 'CHANNEL_SEND_REFUSED', 'the send failure keeps its code');
  assert.match(
    letters[0].stateReason,
    /timeline row left as sent/,
    'the dead letter says the timeline stayed sent',
  );
  const logged = lines.filter((line) => line.includes('advance to failed refused'));
  assert.equal(logged.length, 1, 'the refused advance is logged, never swallowed');
  assert.ok(logged[0].includes(SPACE), 'the log names the tenant');
  assert.ok(!logged[0].includes(BODY), 'the log carries no message body');
});

test('97cba17c: a refused timeline write never renames the failure — the letter keeps the code and the cause is logged', async (t) => {
  const lines = captureConsoleError(t);
  const log = recordingLog({ failLog: new Error('storage down on logMessage') });
  const { harness } = setup(log.handle);
  t.after(() => harness.close());
  const key = await registeredActive(harness);
  harness.faults.refuseNext();
  const queued = await harness.queue(SPACE, {
    connectionKey: key,
    message: { to: CUSTOMER, subject: 'Preventivo', text: BODY },
    messageKey: 'failed-timeline-write',
    timeline: TIMELINE,
  });
  const settled = await harness.pump(queued.jobId);
  assert.equal(settled.state, 'failed_terminal');
  const letters = await harness.letters(SPACE);
  assert.equal(letters.length, 1, 'the dead letter is still recorded');
  assert.equal(letters[0].errorCode, 'CHANNEL_SEND_REFUSED', 'the send failure keeps its code');
  const logged = lines.filter((line) => line.includes('timeline write refused'));
  assert.equal(logged.length, 1, 'the swallowed write now logs its cause');
  assert.ok(logged[0].includes(SPACE), 'the log names the tenant');
  assert.ok(logged[0].includes('CHANNEL_SEND_REFUSED') || logged[0].includes('Error'), 'the log names the cause');
  assert.ok(!logged[0].includes(BODY), 'the log carries no message body');
});
