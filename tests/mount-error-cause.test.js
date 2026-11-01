// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';

import { AppError } from '../packages/core/src/errors.js';
import { createAccordoApp, createAdminShellMount, mountErrorAnswer } from '../packages/app/src/index.js';

/**
 * The cause tokens behind a failed /bo read (backlog:7cacfe33).
 *
 * On 30/10 every read of the presti-group space answered 503
 * `STORAGE_UNAVAILABLE` («PostgreSQL storage is unavailable») with nothing
 * to diagnose: the mount serialized the envelope without the cause, so the
 * SQLSTATE the framework had kept as safe `{code, name}` tokens never
 * reached the browser nor the log. The envelope now carries those two
 * tokens (`cause`), and never the cause itself — its message can hold a
 * host, a user or URL text.
 */

const bodyJson = (answer) => JSON.parse(
  typeof answer.body === 'string' ? answer.body : Buffer.from(answer.body ?? '').toString('utf8'),
);

/** The production shape: what `sanitizePgError` builds, with driver text already redacted. */
const storageDown = (code = '57P03') => new AppError('PostgreSQL storage is unavailable', {
  code: 'STORAGE_UNAVAILABLE',
  status: 503,
  cause: { code, name: 'Error' },
});

test('mountErrorAnswer carries the cause tokens, never the cause text', () => {
  const answer = mountErrorAnswer(storageDown('57P03'));
  assert.equal(answer.status, 503);
  assert.equal(answer.body.error.code, 'STORAGE_UNAVAILABLE');
  assert.deepEqual(answer.body.error.cause, { code: '57P03', name: 'Error' });
  // Serializable by construction: JSON round-trips the exact shape the
  // browser and the pilot log read.
  assert.deepEqual(JSON.parse(JSON.stringify(answer.body)).error.cause, { code: '57P03', name: 'Error' });
});

test('mountErrorAnswer answers null cause when the error carries none', () => {
  const answer = mountErrorAnswer(new AppError('nope', { code: 'SOME_500', status: 500 }));
  assert.equal(answer.status, 500);
  assert.equal(answer.body.error.cause, null);
});

test('mountErrorAnswer falls back to closed vocabulary on non-token causes', () => {
  const answer = mountErrorAnswer(
    new AppError('down', { code: 'STORAGE_UNAVAILABLE', status: 503, cause: { code: 42 } }),
  );
  assert.deepEqual(answer.body.error.cause, { code: 'UNKNOWN', name: 'Error' });
});

test('a failed /bo read answers the cause tokens through the mount', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    const mount = createAdminShellMount(app, {
      basePath: '/bo',
      identityFor: async () => { throw storageDown('ECONNREFUSED'); },
    });
    const answer = await mount.handle({ method: 'GET', path: '/bo/api/schema', headers: {} });
    assert.equal(answer.status, 503);
    const body = bodyJson(answer);
    assert.equal(body.error.code, 'STORAGE_UNAVAILABLE');
    assert.deepEqual(body.error.cause, { code: 'ECONNREFUSED', name: 'Error' });
  } finally {
    app.close();
  }
});

test('a cause-free failure still answers a null cause through the mount', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    const mount = createAdminShellMount(app, {
      basePath: '/bo',
      identityFor: async () => { throw new AppError('broken', { code: 'BROKEN_500', status: 500 }); },
    });
    const answer = await mount.handle({ method: 'GET', path: '/bo/api/schema', headers: {} });
    assert.equal(answer.status, 500);
    assert.equal(bodyJson(answer).error.cause, null);
  } finally {
    app.close();
  }
});
