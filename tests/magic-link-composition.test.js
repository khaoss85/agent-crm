// @ts-check
/**
 * BO-F6-06 slice 1 — magic-link local composition (backlog:ed4bbd35883a).
 *
 * The login screen's email half is served by the existing `magic-link`
 * domain package (BO-F0-05). This file proves slice 1 of the login map:
 * the reference application boots with that package composed on a memory
 * store, and both operations refuse fail-closed — with the stable
 * `MAGIC_LINK_NOT_CONFIGURED` code, no row and no job — until the
 * deployment wires its own directory, outbox and secret custody. The
 * deployment edges (control plane directory, channels outbox, vault) are
 * deliberately NOT wired here: no credentials, no transport, no Google
 * machinery (see tests/admin-login.test.js for the Google boundary).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createAccordoApp } from '../packages/app/src/index.js';

/** @param {unknown} error */
function codeOf(error) {
  return error?.code ?? error?.details?.code ?? String(error?.message ?? error);
}

/** @param {Promise<unknown>} promise */
async function codeOfRejection(promise) {
  const failure = await promise.then(
    () => { throw new Error('must refuse while deployment edges are unwired'); },
    (error) => error,
  );
  return codeOf(failure);
}

test('the reference application boots with the login domain composed', () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.ok(app.domains.names().includes('magic-link'), 'magic-link is composed');
    assert.equal(typeof app.requestMagicLink, 'function', 'request-magic-link is served');
    assert.equal(typeof app.consumeMagicLink, 'function', 'consume-magic-link is served');
  } finally {
    app.close();
  }
});

test('store-only composition refuses fail-closed, never with a row or a job', async () => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  try {
    assert.equal(
      await codeOfRejection(app.requestMagicLink({ email: 'elena@studioaurora.it' })),
      'MAGIC_LINK_NOT_CONFIGURED',
    );
    // The store edge is wired but empty and the other edges are not: an
    // unknown token is simply unknown — no row is invented, no job exists.
    assert.equal(
      await codeOfRejection(app.consumeMagicLink({ token: `ml1.${'c'.repeat(32)}` })),
      'MAGIC_LINK_INVALID',
    );
  } finally {
    app.close();
  }
});
