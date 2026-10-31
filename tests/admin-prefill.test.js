import test from 'node:test';
import assert from 'node:assert/strict';
import { takePendingCustomerPick, writePendingCustomerPick } from '../apps/admin/public/admin-prefill.js';

/**
 * Voce 714433c2: the scheda cliente hands «Nuova offerta» and
 * «Nuovo appuntamento» a customer the creation screen takes exactly once.
 */

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const PICK = { resource: 'contact', id: 'c1', name: 'Guido Presti' };
const PICK_WITH_COMPANY = {
  resource: 'contact', id: 'c1', name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
};

test('a written pick reads back once, then clears', () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'appointment', PICK), true);
  assert.deepEqual(takePendingCustomerPick(storage, 'appointment'), { ...PICK, company: null });
  assert.equal(takePendingCustomerPick(storage, 'appointment'), null, 'the second take finds nothing');
});

test('screens do not see each other\'s picks', () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', PICK), true);
  assert.equal(takePendingCustomerPick(storage, 'appointment'), null, 'no offer pick on the appointment screen');
  assert.deepEqual(takePendingCustomerPick(storage, 'offer'), { ...PICK, company: null });
});

test('the linked company rides the pick for the offer form', () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', PICK_WITH_COMPANY), true);
  assert.deepEqual(takePendingCustomerPick(storage, 'offer'), PICK_WITH_COMPANY);
});

test('a broken company degrades to null, never forges the record', () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', { ...PICK, company: { id: '', name: 'x' } }), true);
  assert.deepEqual(takePendingCustomerPick(storage, 'offer'), { ...PICK, company: null });
});

test('garbage never becomes a pick', () => {
  const storage = memoryStorage();
  for (const bad of [
    null, 'x', 42, { resource: 'lead', id: 'c1', name: 'Guido' },
    { resource: 'contact', id: '', name: 'Guido' }, { resource: 'contact', id: 'c1', name: '  ' },
    { resource: 'company', id: 'co1' },
  ]) {
    assert.equal(writePendingCustomerPick(storage, 'offer', bad), false, `refused: ${JSON.stringify(bad)}`);
  }
  storage.setItem('accordo.bo.customer-pick.offer', '{not json');
  assert.equal(takePendingCustomerPick(storage, 'offer'), null, 'a corrupt stash reads null');
  storage.setItem('accordo.bo.customer-pick.offer', JSON.stringify({ resource: 'contact', id: 'c1', name: 'x' }));
  assert.deepEqual(takePendingCustomerPick(storage, 'offer'), { resource: 'contact', id: 'c1', name: 'x', company: null });
  storage.setItem('accordo.bo.customer-pick.offer', JSON.stringify({ resource: 'lead', id: 'c1', name: 'x' }));
  assert.equal(takePendingCustomerPick(storage, 'offer'), null, 'a corrupt stash reads null, never a forged pick');
});

test('an unknown screen and a missing storage stay inert', () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, '../x', PICK), false);
  assert.equal(writePendingCustomerPick(storage, '', PICK), false);
  assert.equal(takePendingCustomerPick(storage, '../x'), null);
  assert.equal(writePendingCustomerPick(null, 'offer', PICK), false, 'no storage: no write, no crash');
  assert.equal(takePendingCustomerPick(undefined, 'offer'), null, 'no storage: no pick, no crash');
  assert.equal(takePendingCustomerPick({}, 'offer'), null, 'a storage-shaped object without the API reads null');
});
