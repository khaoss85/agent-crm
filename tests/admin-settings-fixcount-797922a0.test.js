import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { loadFixCount, renderSettingsPanel } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * backlog:797922a0c15e — la card «cose da sistemare» in Impostazioni resta
 * su «Non sono riuscito a leggere…» anche quando non c'è niente da
 * leggere davvero: i moduli non composti rispondono 404 e il conteggio
 * crolla a sconosciuto (null) invece di valere 0.
 */

function notFound(path = '/api/modules/data-quality-issue/records?limit=100') {
  return Object.assign(new Error(`Request failed (404) for ${path}`), {
    code: 'NOT_FOUND',
    status: 404,
    method: 'GET',
    path,
  });
}

test('backlog:797922a0c15e: letture 404 (moduli non composti) contano 0, mai errore', async () => {
  const bothMissing = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      throw notFound(path);
    },
  };
  assert.equal(await loadFixCount(bothMissing), 0);
});

test('backlog:797922a0c15e: un 404 dimezza solo la sua metà, l altra conta', async () => {
  const halfMissing = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.includes('data-quality-issue')) throw notFound(path);
      return { items: [{ status: 'unresolved' }] };
    },
  };
  assert.equal(await loadFixCount(halfMissing), 1);
});

test('backlog:797922a0c15e: un 404 per codice (senza status) conta 0', async () => {
  const codeOnly = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      throw Object.assign(new Error('no such module'), { code: 'NOT_FOUND' });
    },
  };
  assert.equal(await loadFixCount(codeOnly), 0);
});

test('backlog:797922a0c15e: un errore vero resta sconosciuto (null), mai 0', async () => {
  const failing = {
    async request(path = '', options = {}) {
      enforceAdminWriteGate(path, options);
      throw new Error('no such module');
    },
  };
  assert.equal(await loadFixCount(failing), null);
});

test('backlog:797922a0c15e: con 0 da sistemare la card dice «Niente da sistemare.»', () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  renderSettingsPanel({ doc, mount, fixCount: 0, customerDataAvailable: false });
  assert.ok(mount.textContent.includes('Niente da sistemare.'));
  assert.ok(!mount.textContent.includes('Non sono riuscito a leggere'));
});
