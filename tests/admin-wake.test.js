import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WAKE_TRANSIENT_CODES,
  WAKE_WAIT_TEXT,
  humanReadError,
  humanWriteError,
  isNetworkFault,
  isWakeStarting,
  isWakeTransient,
  wakeWaitText,
  withWakeRetry,
} from '../apps/admin/public/admin-core.js';

const quiet = { log: () => {} };

test('isWakeTransient retries a waking service once, nothing else (backlog:5a40c73e54aa)', () => {
  assert.equal(isWakeTransient({ status: 503 }), true);
  for (const code of WAKE_TRANSIENT_CODES) {
    assert.equal(isWakeTransient({ status: 200, code }), true, code);
    assert.equal(isWakeTransient({ code }), true, code);
  }
  assert.equal(isWakeTransient(new TypeError('fetch failed')), true);
  assert.equal(isWakeTransient({ status: 0 }), true);
  assert.equal(isWakeTransient({ code: 'TIMEOUT' }), true);
  assert.equal(isWakeTransient({ status: 404, code: 'NOT_FOUND' }), false);
  assert.equal(isWakeTransient({ status: 400 }), false);
  assert.equal(isWakeTransient({ status: 500 }), false);
  assert.equal(isWakeTransient({ status: 502, code: 'LLM_PROVIDER_FAILED' }), false);
  assert.equal(isWakeTransient(null), false);
  assert.equal(isWakeTransient(undefined), false);
});

test('wakeWaitText names a wait only for an explicit starting signal, in Italian', () => {
  for (const code of WAKE_TRANSIENT_CODES) {
    assert.equal(wakeWaitText({ code }), WAKE_WAIT_TEXT, code);
  }
  assert.match(WAKE_WAIT_TEXT, /attendi/i);
  assert.doesNotMatch(WAKE_WAIT_TEXT, /rifiutata/);
  // A bare 503 or a refused connection is retried once, but once final it
  // stays the refusal it is (voce 908f2eb9bbfb pins the section texts).
  assert.equal(wakeWaitText({ status: 503 }), null);
  assert.equal(wakeWaitText(new TypeError('fetch failed')), null);
  assert.equal(wakeWaitText({ status: 400 }), null);
  assert.equal(wakeWaitText({ status: 500 }), null);
  assert.equal(isWakeStarting({ status: 503 }), false);
  assert.equal(isWakeStarting({ code: 'WORKSPACE_STARTING' }), true);
});

test('withWakeRetry replays the same tap once on a waking service', async () => {
  let runs = 0;
  const waits = [];
  const answer = await withWakeRetry(
    async () => {
      runs += 1;
      if (runs === 1) throw Object.assign(new Error('waking'), { status: 503 });
      return 'ok';
    },
    { waitMs: 10, wait: async (ms) => { waits.push(ms); } },
  );
  assert.equal(answer, 'ok');
  assert.equal(runs, 2);
  assert.deepEqual(waits, [10]);
});

test('isWakeTransient never replays an uncertain commit, on any method (review #673 P0)', () => {
  assert.equal(isWakeTransient({ status: 503, code: 'COMMIT_OUTCOME_UNKNOWN' }), false);
  assert.equal(isWakeTransient({ status: 503, code: 'COMMIT_OUTCOME_UNKNOWN' }, { method: 'POST' }), false);
  assert.equal(isWakeTransient({ code: 'SOME_OUTCOME_UNKNOWN' }, { method: 'POST' }), false);
});

test('isWakeTransient does not replay a write on a bare 503 or network fault (review #673 P0)', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isWakeTransient({ status: 503 }, { method }), false, method);
    assert.equal(isWakeTransient(new TypeError('fetch failed'), { method }), false, method);
    assert.equal(isWakeTransient({ status: 503, code: 'WORKSPACE_STARTING' }, { method }), true, method);
  }
  // Reads keep the old verdict: a bare 503 or a refused connection retries once.
  assert.equal(isWakeTransient({ status: 503 }, { method: 'GET' }), true);
  assert.equal(isWakeTransient(new TypeError('fetch failed'), { method: 'GET' }), true);
});

test('withWakeRetry never replays a POST on a bare 503 (review #673 P0)', async () => {
  let runs = 0;
  let waits = 0;
  await assert.rejects(
    withWakeRetry(
      async () => {
        runs += 1;
        throw Object.assign(new Error('waking'), { status: 503 });
      },
      { method: 'POST', wait: async () => { waits += 1; } },
    ),
    /waking/,
  );
  assert.equal(runs, 1);
  assert.equal(waits, 0);
});

test('withWakeRetry throws a refusal at once, without waiting', async () => {
  let runs = 0;
  let waits = 0;
  await assert.rejects(
    withWakeRetry(
      async () => {
        runs += 1;
        throw Object.assign(new Error('bad'), { status: 400 });
      },
      { wait: async () => { waits += 1; } },
    ),
    /bad/,
  );
  assert.equal(runs, 1);
  assert.equal(waits, 0);
});

test('withWakeRetry gives up after the second run (bounded: at most two)', async () => {
  let runs = 0;
  await assert.rejects(
    withWakeRetry(
      async () => {
        runs += 1;
        throw Object.assign(new Error('still waking'), { status: 503 });
      },
      { waitMs: 1, wait: async () => {} },
    ),
    /still waking/,
  );
  assert.equal(runs, 2);
});

test('isNetworkFault refuses nothing with a status, retries a refused connection', () => {
  assert.equal(isNetworkFault(new TypeError('fetch failed')), true);
  assert.equal(isNetworkFault({ status: 0 }), true);
  assert.equal(isNetworkFault({ code: 'FETCH_ERROR' }), true);
  assert.equal(isNetworkFault({ status: 500 }), false);
  assert.equal(isNetworkFault({ status: 404 }), false);
});

test('humanReadError and humanWriteError name the wait on a starting signal', () => {
  const starting = { status: 503, code: 'WORKSPACE_STARTING' };
  assert.equal(humanReadError(starting, { failed: 'Lettura fallita.', ...quiet }), WAKE_WAIT_TEXT);
  assert.equal(humanWriteError(starting, { failed: 'Scrittura rifiutata.', ...quiet }), WAKE_WAIT_TEXT);
  // A bare 503 stays the honest failure, even after the retry ran.
  const refused = { status: 503, code: 'OPERATION_FAULT_X' };
  assert.equal(humanReadError(refused, { failed: 'Lettura fallita.', ...quiet }), 'Lettura fallita.');
  assert.equal(humanWriteError(refused, { failed: 'Scrittura rifiutata.', ...quiet }), 'Scrittura rifiutata.');
});

test('humanReadError and humanWriteError keep refusals and 404 as they were', () => {
  assert.equal(
    humanReadError({ status: 400 }, { failed: 'Lettura fallita.', ...quiet }),
    'Lettura fallita.',
  );
  assert.equal(
    humanWriteError({ status: 400 }, { failed: 'Scrittura rifiutata.', ...quiet }),
    'Scrittura rifiutata.',
  );
  assert.equal(
    humanReadError({ status: 404 }, { failed: 'Lettura fallita.', notComposed: 'Non composto.', ...quiet }),
    'Non composto.',
  );
});
