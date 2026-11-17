import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerListView } from '../apps/admin/public/admin-clienti.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * The Clienti Punteggio cell (backlog:e80c6aee42c5).
 *
 * What it must prove: when the server names the punteggio column the list
 * shows the score with its reasons in the title — never a bare number — and
 * an unavailable row reads its reason; when the server names no punteggio
 * column (no playbook) no score renders anywhere.
 */

const FIT_MENUS = {
  views: [{ id: 'tutti', label: 'Tutti' }],
  sorts: [
    { id: 'recent', label: 'Ultimo contatto' },
    { id: 'fit', label: 'Punteggio' },
  ],
  columns: [
    { id: 'cliente', label: 'Cliente', always: true, ai: false },
    { id: 'punteggio', label: 'Punteggio', always: false, ai: true, def: true },
  ],
  pageSizes: [10, 25, 50],
};

const ROW_SCORED = {
  resource: 'contact', id: 'c1', name: 'Guido Presti',
  company: { id: 'co1', name: 'Palestra Esempio' },
  email: 'guido@palestra-esempio.it', phone: null, channels: ['whatsapp'],
  status: { value: 'contatto', reason: 'x' },
  lastContactAt: null, lastContactChannel: null,
  offerValueCents: null, offerCurrency: null, nextStep: null,
  fit: { available: true, value: 80, reasons: ['ruolo «titolare» nel cliente ideale', 'azienda «palestra» nel cliente ideale'], reason: null },
};

const ROW_PLAIN = {
  resource: 'contact', id: 'c2', name: 'Anna Bianchi',
  company: null, email: 'anna@esempio.it', phone: null, channels: [],
  status: { value: 'contatto', reason: 'x' },
  lastContactAt: null, lastContactChannel: null,
  offerValueCents: null, offerCurrency: null, nextStep: null,
  fit: { available: false, value: null, reasons: ['il cliente ideale non è compilato: compila il playbook e il punteggio compare'], reason: 'il cliente ideale non è compilato: compila il playbook e il punteggio compare' },
};

const stubClient = (answer) => ({
  async request(path, options = {}) {
    enforceAdminWriteGate(path, options);
    return answer;
  },
});

const render = async (answer) => {
  const doc = createFakeDocument();
  const mount = createMount();
  const store = { map: new Map(), getItem(k) { return this.map.get(k) ?? null; }, setItem(k, v) { this.map.set(k, v); } };
  const view = createCustomerListView({ doc, mount, client: stubClient(answer), storage: store, notify: () => {} });
  await view.render();
  return { mount };
};

const answerWith = (items, menus) => ({
  customerListContract: 1, items, total: items.length, page: 1, pageSize: 10, pages: 1,
  totalIsExact: true, ...menus,
});

test('the punteggio column shows the score with its reasons in the title', async () => {
  const { mount } = await render(answerWith([ROW_SCORED, ROW_PLAIN], FIT_MENUS));
  assert.ok(mount.textContent.includes('80'), 'the score value renders');
  const scored = mount.findAll('span').find((node) => node.textContent === '✦ 80');
  assert.ok(scored, 'the score reads with its mark');
  assert.ok(String(scored.getAttribute('title') ?? '').includes('titolare'), `reasons ride the title: ${scored.getAttribute('title')}`);
  assert.ok(mount.textContent.includes('cliente ideale non è compilato'), 'an unscored row reads its reason');
});

test('without the server column no score renders anywhere', async () => {
  const menus = { ...FIT_MENUS, columns: FIT_MENUS.columns.filter((column) => column.id !== 'punteggio'), sorts: FIT_MENUS.sorts.filter((sort) => sort.id !== 'fit') };
  const { mount } = await render(answerWith([ROW_SCORED, ROW_PLAIN], menus));
  assert.ok(!mount.textContent.includes('✦ 80'), 'no score without the column');
  assert.ok(!mount.textContent.includes('titolare» nel cliente ideale'), 'no reasons without the column');
});
