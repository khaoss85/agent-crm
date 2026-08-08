import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, characterizationProject } from './characterization/intelligence-harness.mjs';

/**
 * `record-signal`'s `value`: bounded and single-line.
 *
 * LA0 found both gaps and deliberately refused to freeze them — a
 * characterization suite that encoded them as contract would have carried them
 * through the extraction and out the other side. This is the separate
 * pre-extraction fix it recommended.
 *
 * **What `value` is**, established before choosing a rule: an optional scalar
 * qualifier on an immutable observed signal. Nothing in this repository reads
 * it — scoring counts `signalType`, routing never sees it, no Admin section
 * renders it. It is stored evidence.
 *
 * **The bound is this domain's own `MAX_TEXT = 500`**, which already governs
 * every other text `intelligence-actions.js` accepts; `value` was simply never
 * held to it. A Solution Plan's 2,000 is prose and `partner-scorecard`'s 300 is
 * a human-written reason — neither was copied.
 */

/** The whole project boots once: these assertions are about one action's input. */
let instance;
let leadId;
let root;

// Cleanups are collected at module scope and run by ONE file-level hook.
// Registering `test.after` from inside `before` attaches it to the before
// context, which tore the server down before the first assertion ran.
const cleanups = [];
test.after(async () => {
  for (const cleanup of cleanups.reverse()) {
    try { await cleanup(); } catch { /* already gone */ }
  }
});

test.before(async () => {
  root = characterizationProject({ after: (fn) => cleanups.push(fn) }, { name: 'agent-crm-signal-' });
  instance = await boot(root, join(root, 'data', 'signal.sqlite'));
  cleanups.push(() => instance.close());
  const lead = await instance.client.module('lead').create({
    firstName: 'Giulia', lastName: 'Ferrari', email: 'giulia@ferrari.example',
    companyName: 'Ferrari Sistemi', source: 'website',
  });
  leadId = lead.id;
}, { timeout: 300_000 });

let counter = 0;
const send = (value, extra = {}) => {
  counter += 1;
  return instance.client.module('lead').action(leadId, 'record-signal', {
    signalType: 'pricing-page-visited',
    observedAt: '2026-08-01T10:00:00Z',
    sourceKey: `case:${counter}`,
    ...(value === undefined ? {} : { value }),
    ...extra,
  });
};
const outcome = (promise) => promise.then(
  (result) => ({ accepted: true, status: null, result }),
  (error) => ({ accepted: false, status: error.status, message: error.message }),
);
const stored = async (sourceKey) => (await instance.client.module('behavioral-signal').list({ limit: 500 }))
  .items.find((entry) => entry.sourceKey === sourceKey);

test('the exact maximum is accepted and stored unchanged', async () => {
  const value = 'x'.repeat(500);
  const key = `case:${counter + 1}`;
  const answer = await outcome(send(value));
  assert.equal(answer.accepted, true, answer.message);
  const row = await stored(key);
  assert.equal(row.value, value, 'stored byte-identical: no truncation, no normalization');
  assert.equal(row.value.length, 500);
});

test('one character past the maximum is refused, and nothing is written', async () => {
  const key = `case:${counter + 1}`;
  const answer = await outcome(send('x'.repeat(501)));
  assert.equal(answer.accepted, false);
  assert.equal(answer.status, 400, 'caller input is a 400, never a raw database error');
  assert.match(answer.message, /at most 500 characters/);
  assert.equal(await stored(key), undefined, 'a refused signal leaves no record');
});

test('the 5,000-character value LA0 found is refused', async () => {
  const answer = await outcome(send('x'.repeat(5_000)));
  assert.equal(answer.accepted, false);
  assert.equal(answer.status, 400);
});

test('control characters and line breaks are refused', async () => {
  const cases = {
    nul: 'a\u0000b',
    bell: 'a\u0007b',
    backspace: 'a\u0008b',
    tab: 'a\tb',
    newline: 'a\nb',
    'carriage-return': 'a\rb',
    'ansi-escape': 'a\u001b[31mred',
    delete: 'a\u007fb',
    'c1-next-line': 'a\u0085b',
    'c1-control': 'a\u009fb',
    'line-separator': 'a\u2028b',
    'paragraph-separator': 'a\u2029b',
  };
  for (const [label, value] of Object.entries(cases)) {
    const key = `case:${counter + 1}`;
    const answer = await outcome(send(value));
    assert.equal(answer.accepted, false, `${label} should be refused`);
    assert.equal(answer.status, 400, label);
    assert.match(answer.message, /control characters or line breaks/, label);
    assert.equal(await stored(key), undefined, `${label} must write nothing`);
  }
});

test('legitimate text is still accepted, byte-identical', async () => {
  const cases = [
    'enterprise',
    '/pricing?plan=team&utm_source=x',
    '42',
    'Ferrari Sistemi S.p.A.',
    'prezzo — piano «team»',
    'ключ значение',
    '<script>alert(1)</script>',
    "'; DROP TABLE lead; --",
    'he said "hi" and \'bye\' and `tick`',
    '${process.env.HOME}',
    '../../../../etc/passwd',
    'a'.repeat(499),
  ];
  for (const value of cases) {
    const key = `case:${counter + 1}`;
    const answer = await outcome(send(value));
    assert.equal(answer.accepted, true, `${value.slice(0, 30)}: ${answer.message}`);
    const row = await stored(key);
    // Escaping is the renderer's job. Storing a value the caller sent, exactly
    // as they sent it, is what makes it evidence.
    assert.equal(row.value, value, 'stored byte-identical');
  }
});

test('empty, whitespace-only and absent all mean absent', async () => {
  for (const value of ['', '   ', undefined, null]) {
    const key = `case:${counter + 1}`;
    const answer = await outcome(send(value));
    assert.equal(answer.accepted, true, `${JSON.stringify(value)}: ${answer.message}`);
    assert.equal((await stored(key)).value, null, `${JSON.stringify(value)} should store null`);
  }
});

test('a non-string value is refused rather than coerced', async () => {
  for (const value of [42, true, { a: 1 }, ['x']]) {
    const key = `case:${counter + 1}`;
    const answer = await outcome(send(value));
    assert.equal(answer.accepted, false, `${JSON.stringify(value)} should be refused`);
    assert.equal(answer.status, 400);
    assert.equal(await stored(key), undefined);
  }
});

test('a refusal writes no record and no audit entry, but the attempt is traced', async () => {
  const { app } = instance;
  const before = {
    signals: app.modules.get('behavioral-signal').service.list({ limit: 500 }).length,
    audits: app.audit.list({ limit: 500 }).length,
    runs: app.workflows.listRuns({ limit: 500 }).length,
  };
  await outcome(send('x'.repeat(5_000)));
  await outcome(send('a\u0000b'));
  const after = {
    signals: app.modules.get('behavioral-signal').service.list({ limit: 500 }).length,
    audits: app.audit.list({ limit: 500 }).length,
    runs: app.workflows.listRuns({ limit: 500 }).length,
  };
  assert.equal(after.signals, before.signals, 'no signal row');
  assert.equal(after.audits, before.audits, 'no audit entry: nothing happened, so nothing is claimed to have happened');
  // The trace, by contrast, DOES record the attempt — and should. An audit
  // entry asserts a change was made; a trace run records that somebody tried.
  // Refusing to trace a refused call would hide exactly the calls an operator
  // most wants to find.
  assert.equal(after.runs, before.runs + 2, 'each refused attempt is still traced');
});

test('the refusal is stable under retry, and a valid retry still works', async () => {
  const key = `case:${counter + 1}`;
  const first = await outcome(send('bad\nvalue', { sourceKey: 'retry:1' }));
  const second = await outcome(send('bad\nvalue', { sourceKey: 'retry:1' }));
  assert.equal(first.status, 400);
  assert.equal(second.status, 400, 'the same input answers the same way every time');
  assert.equal(first.message, second.message);
  void key;

  // The dedupe key is untouched by a refusal, so the corrected call succeeds.
  const corrected = await outcome(send('bad value', { sourceKey: 'retry:1' }));
  assert.equal(corrected.accepted, true, corrected.message);
  assert.equal((await stored('retry:1')).value, 'bad value');

  // And the existing duplicate contract still holds.
  const duplicate = await outcome(send('bad value', { sourceKey: 'retry:1' }));
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.status, 409, 'a duplicate sourceKey is still a 409, not a 400');
});

test('historical rows written before the bound remain readable', async () => {
  // The fix hardens new writes. It does not rewrite stored evidence, and it
  // must not make an existing row unreadable — a record somebody relied on
  // yesterday is still a record today.
  const { app } = instance;
  // Written straight to storage, because the point is a row that predates the
  // rule — exactly what an existing installation has.
  const id = '00000000-0000-4000-8000-000000000001';
  const legacyValue = `legacy value ${'x'.repeat(2_000)}`;
  app.database.raw.prepare(
    'INSERT INTO behavioral_signals (id, lead_id, signal_type, source, observed_at, value, source_key, created_at, updated_at)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(id, leadId, 'pricing-page-visited', null, '2026-07-01T10:00:00.000Z', legacyValue, 'legacy:1',
    '2026-07-01T10:00:00.000Z', '2026-07-01T10:00:00.000Z');

  const readBack = await instance.client.module('behavioral-signal').get(id);
  assert.equal(readBack.value, legacyValue, 'still readable, byte for byte: evidence is never rewritten');
  assert.ok(readBack.value.length > 500, 'and longer than the new bound, which is the whole point');

  // And the score that reads these rows still runs over them.
  const scored = await instance.client.module('lead').action(leadId, 'score', { model: 'b2b-saas-score', version: 1 });
  assert.ok(Number.isInteger(scored.result.total));
});

test('the declared input contract advertises the rule', async () => {
  const schema = await instance.client.schema();
  const action = schema.generatedModules.find((entry) => entry.name === 'lead')
    .actions.find((entry) => entry.name === 'record-signal');
  const value = action.input.find((entry) => entry.name === 'value');
  assert.match(value.hint, /500/);
  assert.match(value.hint, /control characters/);
  assert.equal(value.required, false, 'still optional: this bounds a value, it does not demand one');
});
