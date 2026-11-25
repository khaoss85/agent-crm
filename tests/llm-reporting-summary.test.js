import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPORTING_SUMMARY_LINES,
  REPORTING_SUMMARY_PURPOSE,
  assertReportingSummaryFacts,
  buildReportingSummaryPrompt,
  parseReportingSummaryResponse,
  reportingSummaryHasData,
  summarizeReportingPeriod,
} from '../packages/llm/src/reporting-summary.js';
import { LLM_PURPOSES } from '../packages/llm/src/operations.js';

/**
 * Reporting AI summary tests (backlog:766e9cf9469e): the two lines at the
 * top of the Reporting screen, written by the model from the period's own
 * numbers. A period with no data calls no model, a disabled or failing AI
 * keeps the computed fallback of #1145 (never an error in the header), and
 * an invented number never reaches the screen.
 */

const ACTOR = { type: 'user', id: 'reporting-summary-kit' };
const FACTS = Object.freeze({
  text: Object.freeze([
    '28 nuovi clienti in 4 settimane, soprattutto da Instagram.',
    'Ultima settimana: 5, quella prima: 9 (in calo). Preventivi aperti: 6 per 26000.',
  ]),
  integers: Object.freeze([28, 4, 5, 9, 6, 26000]),
});
const COUNTS = Object.freeze({ customersTotal: 28, openCount: 6, wonCount: 2, lostCount: 1 });

const ANSWER = 'Il periodo ha portato 28 nuovi clienti in 4 settimane.\nUltima settimana 5 contro 9 di quella prima, con 6 preventivi aperti.';

/** A fake `complete` that captures the prompt and answers canned text. */
function fakeComplete({ text = ANSWER, seen = null, error = null } = {}) {
  const complete = async (request) => {
    if (seen !== null) seen.request = request;
    if (error !== null) throw error;
    return { text, dryRun: false };
  };
  return complete;
}

test('reporting-summary is its own audited purpose', () => {
  assert.equal(REPORTING_SUMMARY_PURPOSE, 'reporting-summary');
  assert.ok(LLM_PURPOSES.includes('reporting-summary'), 'the purpose travels the audited complete path');
  assert.equal(REPORTING_SUMMARY_LINES, 2, 'the header renders exactly two lines');
});

test('the summary rewrites the period numbers in two lines', async () => {
  const seen = {};
  const out = await summarizeReportingPeriod({
    complete: fakeComplete({ seen }),
    spaceId: 'presti',
    actor: ACTOR,
    facts: FACTS,
    counts: COUNTS,
  });
  assert.deepEqual([...out.lines], [
    'Il periodo ha portato 28 nuovi clienti in 4 settimane.',
    'Ultima settimana 5 contro 9 di quella prima, con 6 preventivi aperti.',
  ]);
  assert.equal(out.reason, 'ai');
  assert.equal(seen.request.purpose, 'reporting-summary');
  assert.equal(seen.request.spaceId, 'presti');
});

test('the prompt carries the period facts verbatim', async () => {
  const seen = {};
  await summarizeReportingPeriod({
    complete: fakeComplete({ seen }),
    spaceId: 'presti',
    actor: ACTOR,
    facts: FACTS,
    counts: COUNTS,
  });
  const prompt = seen.request.messages.map((message) => message.content).join('\n');
  assert.ok(prompt.includes('28 nuovi clienti'), 'the customer count reaches the model');
  assert.ok(prompt.includes('quella prima: 9'), 'the comparison reaches the model');
});

test('a period with no data calls no model', async () => {
  let called = 0;
  const complete = async () => { called += 1; return { text: ANSWER, dryRun: false }; };
  for (const counts of [
    { customersTotal: 0, openCount: 0, wonCount: 0, lostCount: 0 },
    { customersTotal: 0, openCount: 0 },
    {},
    null,
  ]) {
    const out = await summarizeReportingPeriod({
      complete, spaceId: 'presti', actor: ACTOR, facts: FACTS, counts,
    });
    assert.equal(out.lines, null, 'no lines without data');
    assert.equal(out.reason, 'empty');
  }
  assert.equal(called, 0, 'the model is never called for an empty period');
  assert.equal(reportingSummaryHasData(COUNTS), true);
  assert.equal(reportingSummaryHasData({ customersTotal: 0, openCount: 0, wonCount: 0, lostCount: 0 }), false);
});

test('with the AI off (dry run) the header keeps the computed fallback', async () => {
  const complete = async () => ({ text: 'fixture answer', dryRun: true });
  const out = await summarizeReportingPeriod({
    complete, spaceId: 'presti', actor: ACTOR, facts: FACTS, counts: COUNTS,
  });
  assert.equal(out.lines, null, 'no fixture wording reaches the header');
  assert.equal(out.reason, 'ai-disabled');
});

test('a missing, disabled, capped or failing AI keeps the fallback, never an error', async () => {
  const missing = await summarizeReportingPeriod({
    complete: null, spaceId: 'presti', actor: ACTOR, facts: FACTS, counts: COUNTS,
  });
  assert.equal(missing.lines, null);
  assert.equal(missing.reason, 'ai-unavailable');
  const coded = async (code) => summarizeReportingPeriod({
    complete: fakeComplete({ error: Object.assign(new Error(code), { code }) }),
    spaceId: 'presti',
    actor: ACTOR,
    facts: FACTS,
    counts: COUNTS,
  });
  assert.equal((await coded('LLM_SPACE_DISABLED')).reason, 'ai-disabled');
  assert.equal((await coded('LLM_DAILY_CAP_EXCEEDED')).reason, 'ai-capped');
  assert.equal((await coded('LLM_SECRET_UNAVAILABLE')).reason, 'ai-secret');
  assert.equal((await coded('boom')).reason, 'ai-error');
});

test('an invented number never reaches the header', async () => {
  const invented = await summarizeReportingPeriod({
    complete: fakeComplete({ text: 'Il periodo ha portato 28 nuovi clienti.\nE 99 vendite mai viste prima.' }),
    spaceId: 'presti',
    actor: ACTOR,
    facts: FACTS,
    counts: COUNTS,
  });
  assert.equal(invented.lines, null);
  assert.equal(invented.reason, 'unparseable');
});

test('parse refuses anything but exactly two numbered lines', () => {
  const facts = assertReportingSummaryFacts(FACTS);
  assert.throws(() => parseReportingSummaryResponse('Solo una riga con 28 clienti.', facts), /exactly/);
  assert.throws(
    () => parseReportingSummaryResponse('Prima riga con 28 clienti.\nSeconda senza numeri.', facts),
    /no period number/,
  );
  assert.doesNotThrow(() => parseReportingSummaryResponse(ANSWER, facts));
});

test('bad facts refuse fail-closed', () => {
  assert.throws(() => assertReportingSummaryFacts(null), /facts/);
  assert.throws(() => assertReportingSummaryFacts({ text: [], integers: [1] }), /facts/);
  assert.throws(() => buildReportingSummaryPrompt({ text: ['ok'], integers: [] }), /integers/);
});
