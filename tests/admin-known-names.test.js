import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createKnownNames } from '../apps/admin/public/admin-known-names.js';

/**
 * backlog:a762c28a646c (verifica 14/11 00:46Z): the scheda's name waited for
 * its card read (1,3-3,6 s) even when the person had just clicked that name
 * in the Clienti list or an offer's «Per <cliente>». The names the views
 * show are remembered per space; the scheda paints one at once.
 */

test('a762c28a646c: a name is remembered per space, trimmed, and bounded', () => {
  let space = 's1';
  const names = createKnownNames({ space: () => space, limit: 2 });
  names.remember('contact', 'c1', '  Marco Rossi ');
  assert.equal(names.get('contact', 'c1'), 'Marco Rossi');
  assert.equal(names.get('company', 'c1'), null, 'the resource is part of the key');
  space = 's2';
  assert.equal(names.get('contact', 'c1'), null, 'another space never borrows the name');
  space = 's1';
  names.remember('contact', 'c2', 'Anna Bianchi');
  names.remember('contact', 'c3', 'Luca Verdi');
  assert.equal(names.get('contact', 'c1'), null, 'the oldest name leaves first');
  assert.equal(names.get('contact', 'c3'), 'Luca Verdi');
  for (const [resource, id, name] of [['Contact', 'c4', 'X'], ['contact', '', 'X'], ['contact', 'c5', '   '], ['contact', 'c6', null]]) {
    names.remember(resource, id, name);
    assert.equal(names.get(resource, id), null, `refused: ${resource}/${id}/${name}`);
  }
});

test('a762c28a646c: app.js hands one store to the Clienti list, the offer page and the scheda', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  assert.match(app, /const knownNames = createKnownNames\(\{ space: \(\) => shellActiveSpace \?\? null \}\);/);
  for (const view of ['createOfferDetail', 'createCustomerCardView', 'createCustomerListView']) {
    const wiring = new RegExp(`= ${view}\\(\\{([\\s\\S]*?)\\n\\}\\);`).exec(app);
    assert.ok(wiring && /\n  knownNames,\n/.test(wiring[1]), `${view} gets the store`);
  }
  assert.ok(app.indexOf('const knownNames = createKnownNames(') < app.indexOf('const offerDetail = createOfferDetail('), 'declared before the views');
});
