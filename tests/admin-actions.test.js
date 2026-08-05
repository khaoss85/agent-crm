import test from 'node:test';
import assert from 'node:assert/strict';
import { createModuleAdmin } from '../apps/admin/public/admin-modules.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * The Admin's action controls are generic: they are built purely from the
 * `actions` metadata the schema advertises, with no per-module code. These
 * tests drive the view against a stub client so the rendering rules — state
 * gating, input forms, managed fields shown read-only, error handling — are
 * asserted precisely. The real HTTP/runtime path is covered end to end by
 * tests/lead-qualification-e2e.test.js.
 */

const LEAD_META = {
  name: 'lead',
  description: 'Inbound leads.',
  kind: 'generated',
  manifestVersion: 1,
  capabilities: ['create', 'get', 'list', 'update'],
  immutableFields: ['id', 'createdAt', 'updatedAt'],
  fields: [
    { name: 'firstName', type: 'string', required: true, unique: false, writable: 'public' },
    { name: 'status', type: 'enum', required: false, unique: false, writable: 'managed', values: ['new', 'qualified', 'disqualified'] },
    { name: 'qualifiedAt', type: 'timestamp', required: false, unique: false, writable: 'managed' },
  ],
  actions: [
    {
      name: 'disqualify',
      label: 'Disqualify lead',
      description: 'Requires a reason.',
      actionContract: 1,
      input: [{ name: 'reason', type: 'string', required: true }],
      fromStates: ['new'],
      stateField: 'status',
      confirm: false,
      path: '/api/modules/lead/records/:id/actions/disqualify',
    },
    {
      name: 'qualify',
      label: 'Qualify lead',
      description: null,
      actionContract: 1,
      input: [{ name: 'dueAt', type: 'timestamp', required: true }],
      fromStates: ['new'],
      stateField: 'status',
      confirm: false,
      path: '/api/modules/lead/records/:id/actions/qualify',
    },
  ],
};

/**
 * Stub client. `record` is a live object the test can mutate to simulate the
 * state change an action causes; `calls` records every request.
 */
function stubClient(record, { failWith } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') {
        return { generatedResourceContract: 1, generatedModules: [LEAD_META] };
      }
      if (options.method === 'POST') {
        if (failWith) throw Object.assign(new Error(failWith.message), failWith);
        return { ok: true };
      }
      return record;
    },
  };
}

function panelOf(mount) {
  return mount.childNodes.find((node) => (node.getAttribute('class') ?? '').includes('actions-panel'));
}

test('action buttons render from metadata for a record in a valid state', async () => {
  const record = { id: 'l1', firstName: 'Dana', status: 'new', qualifiedAt: null, createdAt: 'x', updatedAt: 'x' };
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: stubClient(record), navigate: () => {} });

  await admin.renderDetail('lead', 'l1');
  const panel = panelOf(mount);
  assert.ok(panel, 'an actions panel is rendered');
  assert.deepEqual(panel.__actions, ['disqualify', 'qualify']);

  const triggers = panel.findAll('button').map((node) => node.textContent);
  assert.ok(triggers.includes('Qualify lead'));
  assert.ok(triggers.includes('Disqualify lead'));
});

test('actions invalid for the current state are not offered', async () => {
  const record = { id: 'l1', firstName: 'Dana', status: 'qualified', qualifiedAt: '2026-08-12T09:00:00.000Z', createdAt: 'x', updatedAt: 'x' };
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: stubClient(record), navigate: () => {} });

  await admin.renderDetail('lead', 'l1');
  const panel = panelOf(mount);
  assert.deepEqual(panel.__actions, [], 'qualify/disqualify are gated off once qualified');
  assert.ok(panel.textContent.includes('No actions available'));
});

test('managed fields are shown read-only and never as editable form inputs', async () => {
  const record = { id: 'l1', firstName: 'Dana', status: 'qualified', qualifiedAt: '2026-08-12T09:00:00.000Z', createdAt: 'x', updatedAt: 'x' };
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: stubClient(record), navigate: () => {} });

  const form = await admin.renderDetail('lead', 'l1');
  // The edit form offers only public fields — no status/qualifiedAt input.
  assert.deepEqual(Object.keys(form.__inputs), ['firstName']);
  // But the managed values are visible in the actions panel.
  const panel = panelOf(mount);
  const managed = panel.findAll('dd').map((node) => node.textContent);
  assert.ok(managed.includes('qualified'));
  assert.ok(managed.includes('2026-08-12T09:00:00.000Z'));
});

test('running an action posts the collected input to the action route', async () => {
  const record = { id: 'l1', firstName: 'Dana', status: 'new', qualifiedAt: null, createdAt: 'x', updatedAt: 'x' };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(record);
  const admin = createModuleAdmin({ doc, mount, client, navigate: () => {} });

  await admin.renderDetail('lead', 'l1');
  await panelOf(mount).__runAction('qualify', { dueAt: '2026-08-12T09:00:00Z' });

  const post = client.calls.find((call) => call.method === 'POST');
  assert.equal(post.path, '/api/modules/lead/records/l1/actions/qualify');
  assert.deepEqual(JSON.parse(post.body), { dueAt: '2026-08-12T09:00:00Z' });
});

test('a successful action re-renders the detail so state and buttons update', async () => {
  const record = { id: 'l1', firstName: 'Dana', status: 'new', qualifiedAt: null, createdAt: 'x', updatedAt: 'x' };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    calls: [],
    async request(path, options = {}) {
      this.calls.push({ path, method: options.method ?? 'GET' });
      if (path === '/api/schema') return { generatedResourceContract: 1, generatedModules: [LEAD_META] };
      if (options.method === 'POST') {
        // The action moved the lead on; subsequent GETs see the new state.
        record.status = 'qualified';
        record.qualifiedAt = '2026-08-12T09:00:00.000Z';
        return { ok: true };
      }
      return record;
    },
  };
  const admin = createModuleAdmin({ doc, mount, client, navigate: () => {} });

  await admin.renderDetail('lead', 'l1');
  assert.deepEqual(panelOf(mount).__actions, ['disqualify', 'qualify']);
  await panelOf(mount).__runAction('qualify', { dueAt: '2026-08-12T09:00:00Z' });
  // After the re-render the record is qualified and no action is offered.
  assert.deepEqual(panelOf(mount).__actions, []);
  assert.ok(panelOf(mount).findAll('dd').map((n) => n.textContent).includes('qualified'));
});

test('a rejected action surfaces the server message and leaves state untouched', async () => {
  const record = { id: 'l1', firstName: 'Dana', status: 'new', qualifiedAt: null, createdAt: 'x', updatedAt: 'x' };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = stubClient(record, {
    failWith: { message: 'lead.qualify is not allowed from state "qualified"', status: 409, code: 'INVALID_STATE', details: { field: 'status' } },
  });
  const admin = createModuleAdmin({ doc, mount, client, navigate: () => {} });

  await admin.renderDetail('lead', 'l1');
  await panelOf(mount).__runAction('qualify', { dueAt: '2026-08-12T09:00:00Z' });

  const panel = panelOf(mount);
  const error = panel.findAll('p').find((node) => (node.getAttribute('class') ?? '') === 'form-error');
  assert.ok(error, 'the error is revealed');
  assert.equal(error.textContent, 'lead.qualify is not allowed from state "qualified"');
  // The record still shows its original state; nothing was optimistically applied.
  assert.ok(panel.findAll('dd').map((n) => n.textContent).includes('new'));
});

test('integer action inputs render as number controls and post JSON numbers', async () => {
  const record = { id: 'l1', firstName: 'Dana', status: 'qualified', qualifiedAt: 'x', createdAt: 'x', updatedAt: 'x' };
  const meta = {
    ...LEAD_META,
    actions: [{
      name: 'convert',
      label: 'Convert lead',
      description: null,
      actionContract: 1,
      input: [
        { name: 'opportunityName', type: 'string', required: true },
        { name: 'valueCents', type: 'integer', required: true },
      ],
      fromStates: ['qualified'],
      stateField: 'status',
      confirm: false,
      path: '/api/modules/lead/records/:id/actions/convert',
    }],
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const calls = [];
  const client = {
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (path === '/api/schema') return { generatedResourceContract: 1, generatedModules: [meta] };
      if (options.method === 'POST') return { ok: true };
      return record;
    },
  };
  const admin = createModuleAdmin({ doc, mount, client, navigate: () => {} });
  await admin.renderDetail('lead', 'l1');

  const form = panelOf(mount).findAll('form')[0];
  const valueInput = form.__inputs.valueCents;
  assert.equal(valueInput.getAttribute('type'), 'number', 'integer inputs are number controls');

  // A non-numeric value is refused client-side: no POST happens.
  form.__inputs.opportunityName.value = 'Acme — Enterprise';
  valueInput.value = 'abc';
  await form.__run();
  assert.ok(!calls.some((call) => call.method === 'POST'), 'no POST for a non-numeric value');
  const error = form.findAll('small').find((node) => (node.getAttribute('class') ?? '') === 'field-error');
  assert.match(error.textContent, /whole number/);

  // A valid value is posted as a JSON NUMBER, not a string.
  valueInput.value = '5000000';
  await form.__run();
  const post = calls.find((call) => call.method === 'POST');
  assert.ok(post, 'the action was posted');
  assert.deepEqual(JSON.parse(post.body), { opportunityName: 'Acme — Enterprise', valueCents: 5000000 });
});

test('hostile action metadata and values are rendered as text, never markup', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const record = { id: 'l1', firstName: 'Dana', status: 'new', qualifiedAt: hostile, createdAt: 'x', updatedAt: 'x' };
  const meta = {
    ...LEAD_META,
    actions: [{ ...LEAD_META.actions[1], label: hostile, description: hostile }],
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path) {
      if (path === '/api/schema') return { generatedResourceContract: 1, generatedModules: [meta] };
      return record;
    },
  };
  const admin = createModuleAdmin({ doc, mount, client, navigate: () => {} });

  await admin.renderDetail('lead', 'l1');
  const panel = panelOf(mount);
  const button = panel.findAll('button')[0];
  assert.equal(button.textContent, hostile, 'the label is inert text');
  assert.equal(button.childNodes.length, 0, 'no elements were parsed out of the hostile string');
  assert.ok(panel.findAll('dd').map((n) => n.textContent).includes(hostile));
});
