import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SPACE_WAKING_TEXT,
  apiFailure,
  pollWhileWaking,
} from '../apps/admin/public/admin-core.js';

/**
 * backlog:0d25ed7dc34f — the /bo test space reads «si sta avviando» and never
 * reloads by itself. The pilot edge answers a starting space with 503 +
 * Retry-After and a self-reloading page (renderWaitingPage in
 * accordo-arvo-pilot src/shared/web.js); the shell polls the same way: while
 * the failure says the service is waking, it waits and reads again, and the
 * page shows its data as soon as the space answers.
 */

function scripted(steps, { waits, everyMs = 3000, rounds = 20, method = 'GET', stale = () => false, onWaking = () => {} } = {}) {
  const calls = [];
  const waking = [];
  const run = async () => {
    const step = steps[Math.min(calls.length, steps.length - 1)];
    calls.push(step);
    if (step instanceof Error) throw step;
    return step;
  };
  const result = pollWhileWaking(run, {
    wait: async (ms) => { waits.push(ms); },
    everyMs,
    rounds,
    method,
    stale,
    onWaking: (on) => { waking.push(on); onWaking(on); },
  });
  return { calls, waking, result };
}

test('a space that comes back answers by itself: 503s, then the data', async () => {
  const waits = [];
  const { calls, waking, result } = scripted(
    [apiFailure(503, null), apiFailure(503, null), { ok: 'dato' }],
    { waits },
  );
  const settled = await result;
  assert.deepEqual(settled, { answer: { ok: 'dato' } });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [3000, 3000]);
  assert.deepEqual(waking, [true, false], 'the notice opens on the wait and closes on the answer');
});

test('a refused connection during the release polls until the space answers', async () => {
  const waits = [];
  const { calls, result } = scripted(
    [new TypeError('fetch failed'), apiFailure(503, { error: { code: 'WORKSPACE_STARTING' } }), 'pronto'],
    { waits },
  );
  assert.deepEqual(await result, { answer: 'pronto' });
  assert.equal(calls.length, 3);
  assert.equal(waits.length, 2);
});

test('an explicit starting signal polls on a write too, once the server proves it was down', async () => {
  const waits = [];
  const { calls, result } = scripted(
    [apiFailure(503, { error: { code: 'WORKSPACE_STARTING' } }), 'inviato'],
    { waits, method: 'POST' },
  );
  assert.deepEqual(await result, { answer: 'inviato' });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [3000]);
});

test('a space that never answers stays a failure after the bound, with the last error', async () => {
  const waits = [];
  const failures = [apiFailure(503, null), apiFailure(503, null), apiFailure(503, null)];
  const { calls, waking, result } = scripted(failures, { waits, rounds: 3 });
  const settled = await result;
  assert.equal(settled.error, failures[2]);
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [3000, 3000]);
  assert.deepEqual(waking, [true, false]);
});

test('a final refusal stops at once, with no wait and no waking notice', async () => {
  const waits = [];
  const refusal = apiFailure(400, { error: { code: 'VALIDATION_FAILED' } });
  const { calls, waking, result } = scripted([refusal, 'mai'], { waits });
  assert.deepEqual(await result, { error: refusal });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
  assert.deepEqual(waking, []);
});

test('a lost session never polls: it leaves for the login at once', async () => {
  const waits = [];
  const lost = apiFailure(401, { error: { code: 'WORKSPACE_SESSION_REQUIRED' } });
  const { calls, result } = scripted([lost, 'mai'], { waits });
  assert.deepEqual(await result, { error: lost });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a write never replays a bare 503 or a refused connection', async () => {
  for (const failure of [apiFailure(503, null), new TypeError('fetch failed')]) {
    const waits = [];
    const { calls, result } = scripted([failure, 'mai'], { waits, method: 'POST' });
    assert.deepEqual(await result, { error: failure });
    assert.equal(calls.length, 1);
    assert.deepEqual(waits, []);
  }
});

test('an uncertain outcome never polls, on any method', async () => {
  const uncertain = apiFailure(503, { error: { code: 'COMMIT_OUTCOME_UNKNOWN' } });
  const waits = [];
  const { calls, result } = scripted([uncertain, 'mai'], { waits });
  assert.deepEqual(await result, { error: uncertain });
  assert.equal(calls.length, 1);
  assert.deepEqual(waits, []);
});

test('a screen that moved on aborts the poll with no stray request', async () => {
  const waits = [];
  let runs = 0;
  const settled = await pollWhileWaking(
    async () => { runs += 1; throw apiFailure(503, null); },
    { wait: async (ms) => { waits.push(ms); }, rounds: 10, stale: () => runs >= 1 },
  );
  assert.deepEqual(settled, { stale: true });
  assert.equal(runs, 1);
  assert.deepEqual(waits, [3000], 'one gap, then the abort is seen before the next run');
});

test('an already-gone screen runs nothing', async () => {
  let runs = 0;
  const settled = await pollWhileWaking(
    async () => { runs += 1; return 'mai'; },
    { wait: async () => {}, stale: () => true },
  );
  assert.deepEqual(settled, { stale: true });
  assert.equal(runs, 0);
});

test('a throwing waking notice never masks the read: the space still answers by itself', async () => {
  const waits = [];
  const { calls, result } = scripted(
    [apiFailure(503, null), 'dato'],
    { waits, onWaking: () => { throw new Error('no toast'); } },
  );
  assert.deepEqual(await result, { answer: 'dato' });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [3000]);
});

test('the waiting line says the page reloads by itself, never «rifiutata»', () => {
  assert.match(SPACE_WAKING_TEXT, /si sta avviando/);
  assert.match(SPACE_WAKING_TEXT, /si ricarica da sola/);
  assert.doesNotMatch(SPACE_WAKING_TEXT, /rifiutata/);
  assert.doesNotMatch(SPACE_WAKING_TEXT, /Riprova|riprova/);
});
