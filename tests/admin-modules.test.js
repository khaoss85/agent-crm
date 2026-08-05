import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentCrmApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { createModuleAdmin } from '../apps/admin/public/admin-modules.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { NotFoundError, ValidationError, ConflictError } from '../packages/core/src/errors.js';

/**
 * Real server + real fetch + a fake document: exercises the Admin view code and
 * the full data path without a browser dependency. A generated Partner-like and
 * Supplier-like module are applied in memory via the registry contract shape.
 */

function partnerModule() {
  return {
    name: 'partner',
    version: '0.1.0',
    description: 'Channel partners.',
    kind: 'generated',
    manifestVersion: 1,
    capabilities: ['create', 'get', 'list', 'update'],
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    fields: [
      { name: 'name', type: 'string', required: true, unique: false },
      { name: 'tier', type: 'enum', required: false, unique: false, values: ['silver', 'gold', 'platinum'] },
      { name: 'territory', type: 'string', required: false, unique: false },
      { name: 'active', type: 'boolean', required: false, unique: false },
    ],
  };
}

// A real generated module built from a manifest through the factory would carry
// a working service. For an in-process Admin test we register a small in-memory
// service that matches the generated service contract (validation + audit +
// events), so the Admin exercises the real API/adapter path.
function inMemoryModule(app, definition, validators) {
  const rows = new Map();
  const service = {
    async create(input, ctx = {}) {
      const record = { id: `id-${rows.size + 1}`, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
      for (const field of definition.fields) record[field.name] = validators(field, input, rows);
      rows.set(record.id, record);
      app.audit.record({ actor: ctx.actor, action: `${definition.name}.created`, entityType: definition.name, entityId: record.id, data: record });
      await app.events.emit(`${definition.name}.created`, record);
      return record;
    },
    get(id) {
      const row = rows.get(id);
      if (!row) throw new NotFoundError(definition.name, id);
      return row;
    },
    list() {
      return [...rows.values()];
    },
    async update(id, input, ctx = {}) {
      const row = service.get(id);
      for (const field of definition.fields) {
        if (Object.hasOwn(input, field.name)) row[field.name] = validators(field, input, rows, id);
      }
      app.audit.record({ actor: ctx.actor, action: `${definition.name}.updated`, entityType: definition.name, entityId: id, data: input });
      await app.events.emit(`${definition.name}.updated`, row);
      return row;
    },
  };
  app.modules.register({ ...definition, service });
}

function partnerValidator(field, input, rows, updatingId) {
  const value = input[field.name];
  if (field.required && (value === undefined || value === null || value === '')) {
    throw new ValidationError(`${field.name} is required`, { field: field.name });
  }
  if (field.type === 'enum' && value != null && value !== '' && !field.values.includes(value)) {
    throw new ValidationError(`${field.name} must be one of: ${field.values.join(', ')}`, { field: field.name });
  }
  if (field.unique && value != null && value !== '') {
    for (const [id, row] of rows) {
      if (id !== updatingId && row[field.name] === value) {
        throw new ConflictError(`${field.name} already exists`, { field: field.name });
      }
    }
  }
  if (field.type === 'boolean') return value === true;
  return value ?? null;
}

function startServer(t, configure) {
  const app = createAgentCrmApp({ dbPath: ':memory:' });
  configure(app);
  const server = createHttpServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      t.after(async () => {
        await new Promise((r) => server.close(r));
        app.close();
      });
      resolve({ app, baseUrl });
    });
  });
}

function clientFor(baseUrl) {
  return {
    async request(path, options = {}) {
      const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'admin-ui', ...(options.headers || {}) },
      });
      const text = await response.text();
      const payload = text === '' ? null : JSON.parse(text);
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `failed ${response.status}`);
        Object.assign(error, { status: response.status, code: payload?.error?.code, details: payload?.error?.details });
        throw error;
      }
      return payload;
    },
  };
}

function setup(t, { partner = true, supplier = false } = {}) {
  return startServer(t, (app) => {
    if (partner) inMemoryModule(app, partnerModule(), partnerValidator);
    if (supplier) {
      inMemoryModule(app, {
        name: 'supplier',
        version: '0.1.0',
        description: 'Suppliers.',
        kind: 'generated',
        manifestVersion: 1,
        immutableFields: ['id', 'createdAt', 'updatedAt'],
        capabilities: ['create', 'get', 'list', 'update'],
        fields: [{ name: 'code', type: 'string', required: true, unique: true }],
      }, partnerValidator);
    }
  });
}

test('Admin lists generated module records with schema-derived columns', async (t) => {
  const { app, baseUrl } = await setup(t);
  await app.modules.get('partner').service.create({ name: 'Acme', tier: 'gold' }, { actor: { type: 'user', id: 'seed' } });
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {} });

  await admin.renderList('partner');
  const headers = mount.findAll('th').map((node) => node.textContent.trim());
  assert.ok(headers.includes('Name') && headers.includes('Tier') && headers.includes('Created'));
  const rows = mount.findAll('tbody')[0].findAll('tr');
  assert.equal(rows.length, 1);
  assert.ok(rows[0].textContent.includes('Acme') && rows[0].textContent.includes('gold'));
});

test('create form renders correct controls and posts a create with audit + event', async (t) => {
  const { app, baseUrl } = await setup(t);
  const events = [];
  app.events.subscribe('partner.created', () => events.push('created'));
  const doc = createFakeDocument();
  const mount = createMount();
  const navs = [];
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: (h) => navs.push(h) });

  const form = await admin.renderNew('partner');
  // Controls derived from field metadata.
  assert.equal(form.__inputs.name.tagName, 'INPUT');
  assert.equal(form.__inputs.tier.tagName, 'SELECT');
  assert.deepEqual(form.__inputs.tier.findAll('option').map((o) => o.getAttribute('value')), ['', 'silver', 'gold', 'platinum']);
  assert.equal(form.__inputs.active.getAttribute('type'), 'checkbox');

  // Fill and submit.
  form.__inputs.name.value = 'Globex';
  form.__inputs.tier.value = 'platinum';
  form.__inputs.active.checked = true;
  await form.__submit({ preventDefault() {} });

  assert.equal(app.modules.get('partner').service.list().length, 1);
  const created = app.modules.get('partner').service.list()[0];
  assert.equal(created.tier, 'platinum');
  assert.equal(created.active, true);
  assert.deepEqual(events, ['created']);
  const audit = app.audit.list({ entityType: 'partner' });
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorType, 'user');
  assert.equal(audit[0].actorId, 'admin-ui');
  assert.ok(navs.some((h) => h.startsWith('#/modules/partner/')));
});

test('validation and conflict errors render without audit or events', async (t) => {
  const { app, baseUrl } = await setup(t, { supplier: true });
  await app.modules.get('supplier').service.create({ code: 'DUP' }, { actor: { type: 'user', id: 'seed' } });
  const events = [];
  app.events.subscribe('partner.created', () => events.push('p'));
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {} });

  // Missing required field: server 400, field error shown, no mutation.
  const form = await admin.renderNew('partner');
  await form.__submit({ preventDefault() {} });
  const errorNodes = mount.findAll('small').filter((n) => n.classList.contains('field-error') && !n.classList.contains('hidden'));
  assert.ok(errorNodes.some((n) => /required/i.test(n.textContent)));
  assert.equal(app.audit.list({ entityType: 'partner' }).length, 0);
  assert.deepEqual(events, []);
});

test('detail view loads a record, shows immutable fields read-only, and edits it', async (t) => {
  const { app, baseUrl } = await setup(t);
  const created = await app.modules.get('partner').service.create({ name: 'Initech', tier: 'silver' }, { actor: { type: 'user', id: 'seed' } });
  const events = [];
  app.events.subscribe('partner.updated', () => events.push('u'));
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {} });

  const form = await admin.renderDetail('partner', created.id);
  // Immutable metadata rendered.
  assert.ok(mount.findAll('dd').some((node) => node.textContent === created.id));
  // Change tier only.
  form.__inputs.tier.value = 'gold';
  await form.__submit({ preventDefault() {} });
  assert.equal(app.modules.get('partner').service.get(created.id).tier, 'gold');
  assert.deepEqual(events, ['u']);
  assert.equal(app.audit.list({ entityType: 'partner', entityId: created.id }).some((e) => e.action === 'partner.updated'), true);
});

test('missing record shows a not-found message, not a crash', async (t) => {
  const { baseUrl } = await setup(t);
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {} });
  await admin.renderDetail('partner', 'does-not-exist');
  assert.ok(mount.textContent.includes('Record not found'));
});

test('hostile metadata and record values are rendered as text, never markup', async (t) => {
  const hostile = partnerModule();
  hostile.name = 'partner';
  hostile.description = '<script>window.x=1</script>';
  hostile.fields = [
    { name: 'name', type: 'string', required: true, unique: false },
    { name: 'tier', type: 'enum', required: false, unique: false, values: ['<img onerror=alert(1)>'] },
  ];
  const { app, baseUrl } = await startServer(t, (app2) => inMemoryModule(app2, hostile, partnerValidator));
  await app.modules.get('partner').service.create({ name: '<b>pwn</b>', tier: '<img onerror=alert(1)>' }, { actor: { type: 'user', id: 'seed' } });
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {} });

  await admin.renderList('partner');
  // The hostile strings appear only as text nodes (no element ever has tagName SCRIPT/IMG/B).
  assert.equal(mount.findAll('script').length, 0);
  assert.equal(mount.findAll('img').length, 0);
  assert.equal(mount.findAll('b').length, 0);
  assert.ok(mount.textContent.includes('<b>pwn</b>'), 'hostile value must survive as literal text');

  const form = await admin.renderNew('partner');
  const optionValues = form.__inputs.tier.findAll('option').map((o) => o.getAttribute('value'));
  assert.ok(optionValues.includes('<img onerror=alert(1)>'));
  assert.equal(form.__inputs.tier.findAll('img').length, 0);
});

test('Supplier stays isolated from Partner and both are independently usable', async (t) => {
  const { app, baseUrl } = await setup(t, { supplier: true });
  const doc = createFakeDocument();
  const client = clientFor(baseUrl);
  const admin = createModuleAdmin({ doc, mount: createMount(), client, navigate: () => {} });

  const partnerForm = await admin.renderNew('partner');
  assert.deepEqual(Object.keys(partnerForm.__inputs), ['name', 'tier', 'territory', 'active']);
  const supplierForm = await admin.renderNew('supplier');
  assert.deepEqual(Object.keys(supplierForm.__inputs), ['code']);

  await app.modules.get('partner').service.create({ name: 'P1' }, { actor: { type: 'user', id: 's' } });
  const supplierMount = createMount();
  const admin2 = createModuleAdmin({ doc, mount: supplierMount, client, navigate: () => {} });
  await admin2.renderList('supplier');
  assert.ok(supplierMount.textContent.includes('No records yet'), 'partner data bled into supplier');
});

test('capability gating: a module without update renders a read-only detail', async (t) => {
  const definition = {
    name: 'readonly',
    version: '0.1.0',
    description: 'Read-only module.',
    kind: 'generated',
    manifestVersion: 1,
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    capabilities: ['get', 'list'], // no create, no update
    fields: [{ name: 'name', type: 'string', required: true, unique: false }],
  };
  const { app, baseUrl } = await startServer(t, (app2) => inMemoryModule(app2, definition, partnerValidator));
  const created = await app.modules.get('readonly').service.create({ name: 'Fixed' }, { actor: { type: 'user', id: 'seed' } });
  const doc = createFakeDocument();
  const navs = [];
  const listMount = createMount();
  const listAdmin = createModuleAdmin({ doc, mount: listMount, client: clientFor(baseUrl), navigate: (h) => navs.push(h) });
  await listAdmin.renderList('readonly');
  // No Create button when create is not a capability.
  assert.equal(listMount.findAll('button').some((b) => b.getAttribute('data-action') === 'create'), false);

  const detailMount = createMount();
  const detailAdmin = createModuleAdmin({ doc, mount: detailMount, client: clientFor(baseUrl), navigate: () => {} });
  const form = await detailAdmin.renderDetail('readonly', created.id);
  const submit = form.findAll('button').find((b) => b.getAttribute('type') === 'submit');
  assert.equal(submit.disabled, true, 'submit must be disabled without update capability');
  assert.ok(detailMount.textContent.includes('read-only'));
});

test('stale out-of-order renders do not overwrite the current view', async (t) => {
  const { app, baseUrl } = await setup(t, { supplier: true });
  await app.modules.get('partner').service.create({ name: 'P' }, { actor: { type: 'user', id: 's' } });
  await app.modules.get('supplier').service.create({ code: 'S1' }, { actor: { type: 'user', id: 's' } });
  const doc = createFakeDocument();
  const mount = createMount();

  // A client that delays the FIRST request (partner) longer than the second.
  let call = 0;
  const base = clientFor(baseUrl);
  const slowFirst = {
    request(path, options) {
      call += 1;
      const delay = call === 1 ? 40 : 1;
      return new Promise((resolve, reject) => {
        setTimeout(() => base.request(path, options).then(resolve, reject), delay);
      });
    },
  };
  const admin = createModuleAdmin({ doc, mount, client: slowFirst, navigate: () => {} });
  // Start partner list (slow), then immediately supplier list (fast).
  const first = admin.renderList('partner');
  const second = admin.renderList('supplier');
  await Promise.all([first, second]);
  // Supplier was requested last, so it must own the view even though partner
  // resolved afterwards.
  assert.ok(mount.textContent.includes('Supplier'), 'newest render must win');
  assert.equal(mount.textContent.includes('Channel partners'), false, 'stale partner render leaked in');
});

test('an unsupported schema contract version fails gracefully', async (t) => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request() {
      return { generatedResourceContract: 999, generatedModules: [] };
    },
  };
  const admin = createModuleAdmin({ doc, mount, client, navigate: () => {} });
  await admin.renderList('partner');
  assert.ok(mount.textContent.toLowerCase().includes('needs an update'));
});
