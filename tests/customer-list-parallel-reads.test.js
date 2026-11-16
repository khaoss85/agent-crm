import test from 'node:test';
import assert from 'node:assert/strict';
import { listCustomerRecords } from '../packages/customer-data/src/operations.js';

/**
 * backlog:ca53e443db44 — the server view paid one round trip per module in
 * a row (identities, then opportunities, then three evidence modules one by
 * one, then tasks, messages, calls, conversations, appointments, mailboxes,
 * watermarks, signals, custom fields). The reads that need nothing but the
 * scanned subjects now start together; only the evidence reads wait for the
 * opportunity ids. These tests hold the overlap: every module read starts
 * before any of them finishes, and a module that refuses still leaves its
 * siblings' rows.
 */

const at = (minute) => `2026-10-20T09:${String(minute).padStart(2, '0')}:00.000Z`;
const msg = (over) => ({
  id: `m-${Math.random().toString(36).slice(2)}`, channel: 'whatsapp', direction: 'inbound', body: 'Ciao',
  subjectResource: 'contact', subjectId: 'c1', conversationId: 'wa:1', occurredAt: at(0), ...over,
});

const SCENE = {
  contacts: [
    { id: 'c1', companyId: 'co1', firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it' },
    { id: 'c2', companyId: 'co1', firstName: 'Anna', lastName: 'Bianchi', email: 'anna@example.it' },
  ],
  companies: [{ id: 'co1', name: 'Palestra Esempio' }],
  messages: [
    msg({ subjectId: 'c1', conversationId: 'wa:1', occurredAt: at(1), body: 'Ci sono posti giovedì?' }),
    msg({ subjectId: 'c2', conversationId: 'wa:2', occurredAt: at(5), body: 'Mi richiami?' }),
  ],
};

const match = (rows, filters) => rows.filter((row) => Object.entries(filters).every(([key, value]) => (
  Array.isArray(value) ? value.includes(row?.[key]) : row?.[key] === value)));

/** Fake module map where every exact read blocks on one shared gate. */
function gatedModules() {
  const entered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gatedWhere = (name, rows) => async (filters) => {
    entered.push(name);
    await gate;
    return match(rows, filters);
  };
  const map = new Map([
    ['contact', { service: { list: async () => SCENE.contacts } }],
    ['company', { service: { list: async () => SCENE.companies } }],
    ['external-identity', { service: { listWhere: gatedWhere('external-identity', []) } }],
    ['opportunity', { service: { listWhere: gatedWhere('opportunity', []) } }],
    ['work-task', { service: { listWhere: gatedWhere('work-task', []) } }],
    ['interaction-message', { service: { listWhere: gatedWhere('interaction-message', SCENE.messages) } }],
    ['interaction-call', { service: { listWhere: gatedWhere('interaction-call', []) } }],
    ['conversation', { service: { listWhere: gatedWhere('conversation', []) } }],
    ['appointment', { service: { listWhere: gatedWhere('appointment', []) } }],
    ['order', { service: { listWhere: gatedWhere('order', []) } }],
  ]);
  const modules = {
    get: (name) => {
      const entry = map.get(name);
      if (!entry) throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
      return entry;
    },
  };
  return { modules, entered, release };
}

test('ca53e443db44: the module reads overlap — every read starts before any of them finishes', async () => {
  const { modules, entered, release } = gatedModules();
  const pending = listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti' },
  );
  // Every started read runs until its gate on microtasks alone; the timer
  // below only lets those microtasks drain while no gate is open.
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  for (const name of ['external-identity', 'opportunity', 'work-task', 'interaction-message', 'interaction-call', 'conversation', 'appointment']) {
    assert.ok(entered.includes(name), `${name} starts while its siblings are still reading`);
  }
  assert.ok(!entered.includes('order'), 'the evidence reads wait for the opportunity ids, by design');
  release();
  const page = await pending;
  assert.equal(page.total, 2, 'both customers read, nothing lost to the overlap');
  assert.deepEqual(page.items.map((item) => item.name).sort(), ['Anna Bianchi', 'Guido Presti']);
});

test('ca53e443db44: the three evidence reads overlap once the opportunity ids are known', async () => {
  const entered = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const gatedWhere = (name, rows) => async (filters) => {
    entered.push(name);
    await gate;
    return match(rows, filters);
  };
  const map = new Map([
    ['contact', { service: { list: async () => SCENE.contacts } }],
    ['company', { service: { list: async () => SCENE.companies } }],
    ['external-identity', { service: { listWhere: async (filters) => match([], filters) } }],
    ['opportunity', { service: { listWhere: async (filters) => match([{ id: 'o1' }], filters) } }],
    ['order', { service: { listWhere: gatedWhere('order', []) } }],
    ['commercial-contract', { service: { listWhere: gatedWhere('commercial-contract', []) } }],
    ['subscription', { service: { listWhere: gatedWhere('subscription', []) } }],
  ]);
  const modules = {
    get: (name) => {
      const entry = map.get(name);
      if (!entry) throw Object.assign(new Error(`Unknown module ${name}`), { code: 'MODULE_NOT_FOUND' });
      return entry;
    },
  };
  const pending = listCustomerRecords(
    { modules, core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti' },
  );
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  for (const name of ['order', 'commercial-contract', 'subscription']) {
    assert.ok(entered.includes(name), `${name} starts while its sibling evidence reads are still reading`);
  }
  release();
  const page = await pending;
  assert.equal(page.total, 2, 'both customers read, nothing lost to the overlap');
});

test('ca53e443db44: a module that refuses still leaves its siblings’ rows', async () => {
  const { modules, release } = gatedModules();
  const refusing = {
    get: (name) => (name === 'opportunity'
      ? { service: { listWhere: async () => { throw Object.assign(new Error('renamed shapes'), { code: 'UNKNOWN_SHAPE' }); } } }
      : modules.get(name)),
  };
  release();
  const page = await listCustomerRecords(
    { modules: refusing, core: {}, names: { identity: 'external-identity' } },
    { vista: 'tutti' },
  );
  assert.equal(page.total, 2, 'the refused module reads unreadable, the customers still list');
});
