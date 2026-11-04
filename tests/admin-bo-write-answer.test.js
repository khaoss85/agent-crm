// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { bindAdminMutations, unwrapBoWriteAnswer } from '../apps/admin/public/admin-submission.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

// Production 03/11: the /bo writes ride the worker and answer
// { saved, spaceId }; the Nuovo cliente form read receipts[0] off the
// envelope and said «non si è potuto creare» on a customer it had created.
test('a /bo write answer is opened to the framework result', () => {
  const receipt = { receipts: [{ outcome: 'accepted', subject: { id: 'c1', resource: 'contact' } }] };
  assert.deepEqual(unwrapBoWriteAnswer({ saved: receipt, spaceId: 'space-1' }), receipt);
});

test('any other answer passes through untouched', () => {
  const plain = { receipts: [] };
  assert.equal(unwrapBoWriteAnswer(plain), plain);
  const withMore = { saved: { a: 1 }, spaceId: 's', extra: true };
  assert.equal(unwrapBoWriteAnswer(withMore), withMore);
  assert.equal(unwrapBoWriteAnswer(null), null);
});

test('the bound client hands screens the opened result of a write', async () => {
  const receipt = { receipts: [{ outcome: 'accepted', subject: { id: 'c1' } }] };
  const memory = new Map();
  const storage = { getItem: (k) => memory.get(k) ?? null, setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) };
  const raw = { request: async (path = '', options = {}) => { enforceAdminWriteGate(path, options); return { saved: receipt, spaceId: 'space-1' }; } };
  const { client } = bindAdminMutations(raw, { storage });
  const answer = await client.request('/api/customer-data/import/apply', { method: 'POST', body: JSON.stringify({ rows: [] }) });
  assert.deepEqual(answer, receipt);
});
