import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { customerCrumbLabel } from '../apps/admin/public/admin-navigation.js';

/**
 * backlog:fe9be5f0af4a — production 13/11, one reload in three: the scheda
 * crumb stayed «… / CLIENTI» without the customer. The race: the card read
 * named the customer, then the shell's schema read (populateNav) landed and
 * re-synced the screen to its plain label; the card emits a name once per
 * customer, so nothing narrowed it again. The shell now remembers the name
 * for the routed customer and every re-sync paints it.
 */

const CARD = { view: 'customer-card', resource: 'contact', subjectId: 'c1' };

test('fe9be5f0af4a: a re-sync of the same card keeps the customer name', () => {
  const remembered = { resource: 'contact', id: 'c1', name: 'Cliente Prova' };
  assert.equal(customerCrumbLabel(CARD, 'Clienti', remembered), 'Clienti / Cliente Prova');
  assert.equal(customerCrumbLabel(CARD, 'Clienti', null), 'Clienti', 'before the card names one');
  assert.equal(customerCrumbLabel(CARD, 'Clienti', { ...remembered, name: null }), 'Clienti', 'a failed card read');
  assert.equal(customerCrumbLabel({ ...CARD, subjectId: 'c2' }, 'Clienti', remembered), 'Clienti', 'another customer never borrows the name');
  assert.equal(customerCrumbLabel({ view: 'customer-data' }, 'Clienti', remembered), 'Clienti', 'the list is plain Clienti');
  assert.equal(customerCrumbLabel({ view: 'pipeline' }, 'Pipeline', remembered), 'Pipeline');
});

test('fe9be5f0af4a: the card naming the customer before the shell re-syncs keeps the name (the race, replayed)', () => {
  // The two writers of the crumb, as app.js wires them.
  let label = null;
  let remembered = null;
  const onCustomerTitle = (target, name) => {
    remembered = { resource: target.resource, id: target.subjectId, name };
    label = customerCrumbLabel(target, 'Clienti', remembered);
  };
  const syncShell = (target) => { label = customerCrumbLabel(target, 'Clienti', remembered); };
  syncShell(CARD); // route(): the crumb moves at once
  onCustomerTitle(CARD, 'Cliente Prova'); // the card read lands first
  syncShell(CARD); // then populateNav's schema read re-syncs the shell
  assert.equal(label, 'Clienti / Cliente Prova');
});

test('fe9be5f0af4a: app.js routes both crumb writers through the remembered name', () => {
  const app = readFileSync(new URL('../apps/admin/public/app.js', import.meta.url), 'utf8');
  const sync = app.slice(app.indexOf('function syncShell(target)'), app.indexOf('async function refreshShellCounts'));
  assert.match(sync, /screenLabel: customerCrumbLabel\(target, [^\n]+, customerTitle\)/, 'syncShell paints the remembered name');
  const hook = app.slice(app.indexOf('onCustomerTitle: (name) =>'), app.indexOf('onCustomerTitle: (name) =>') + 900);
  assert.match(hook, /customerTitle = target\.view === 'customer-card'/, 'the card hook remembers the name for its customer');
  assert.ok(app.indexOf('let customerTitle = null;') < app.indexOf('const customerCardView = createCustomerCardView({'),
    'declared before the card view can call the hook');
});
