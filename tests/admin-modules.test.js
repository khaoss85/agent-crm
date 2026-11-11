import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import {
  createModuleAdmin, centsToEuroField, pickedOfferTitle, quoteLineInputs, fileQuoteWithLines,
} from '../apps/admin/public/admin-modules.js';
import { writePendingCustomerPick, takePendingCustomerPick } from '../apps/admin/public/admin-prefill.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { NotFoundError, ValidationError, ConflictError } from '../packages/core/src/errors.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

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
  const app = createAccordoApp({ dbPath: ':memory:' });
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
      enforceAdminWriteGate(path, options);
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
      enforceAdminWriteGate(path, options);
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

function contactModule() {
  return {
    name: 'partner-contact',
    version: '0.1.0',
    description: 'Partner contacts.',
    kind: 'generated',
    manifestVersion: 1,
    immutableFields: ['id', 'createdAt', 'updatedAt'],
    capabilities: ['create', 'get', 'list', 'update'],
    fields: [
      { name: 'fullName', type: 'string', required: true, unique: false },
      { name: 'partnerId', type: 'reference', required: true, unique: false, references: 'partners', targetModule: 'partner', targetKey: 'id', targetDisplayField: 'name', targetKind: 'generated' },
    ],
  };
}

test('Admin renders a reference field as a target selector and submits the target id', async (t) => {
  const { app, baseUrl } = await startServer(t, (app2) => {
    inMemoryModule(app2, partnerModule(), partnerValidator);
    inMemoryModule(app2, contactModule(), partnerValidator);
  });
  const pA = await app.modules.get('partner').service.create({ name: 'Alpha Partner', tier: 'gold' }, { actor: { type: 'user', id: 's' } });
  const pB = await app.modules.get('partner').service.create({ name: 'Beta Partner' }, { actor: { type: 'user', id: 's' } });
  const doc = createFakeDocument();
  const client = clientFor(baseUrl);
  const navs = [];
  const admin = createModuleAdmin({ doc, mount: createMount(), client, navigate: (h) => navs.push(h) });

  const form = await admin.renderNew('partner-contact');
  const select = form.__inputs.partnerId;
  assert.equal(select.tagName, 'SELECT');
  // Placeholder + one option per partner, labelled by the display field (name).
  const optionLabels = select.findAll('option').map((o) => o.textContent);
  assert.ok(optionLabels.includes('Alpha Partner') && optionLabels.includes('Beta Partner'));
  const optionValues = select.findAll('option').map((o) => o.getAttribute('value'));
  assert.ok(optionValues.includes(pA.id) && optionValues.includes(pB.id));

  // Submit selecting Partner B → the id is stored.
  form.__inputs.fullName.value = 'Mario';
  select.value = pB.id;
  await form.__submit({ preventDefault() {} });
  const created = app.modules.get('partner-contact').service.list()[0];
  assert.equal(created.partnerId, pB.id);
});

test('reference edit preselects the current target even if outside the first page', async (t) => {
  const { app, baseUrl } = await startServer(t, (app2) => {
    inMemoryModule(app2, partnerModule(), partnerValidator);
    inMemoryModule(app2, contactModule(), partnerValidator);
  });
  const partners = app.modules.get('partner').service;
  // Create many partners so the linked one is not on the first page of 100.
  const first = await partners.create({ name: 'Linked Partner' }, { actor: { type: 'user', id: 's' } });
  for (let i = 0; i < 120; i += 1) await partners.create({ name: `Filler ${i}` }, { actor: { type: 'user', id: 's' } });
  const contact = await app.modules.get('partner-contact').service.create({ fullName: 'Mario', partnerId: first.id }, { actor: { type: 'user', id: 's' } });

  const doc = createFakeDocument();
  const admin = createModuleAdmin({ doc, mount: createMount(), client: clientFor(baseUrl), navigate: () => {} });
  const form = await admin.renderDetail('partner-contact', contact.id);
  const select = form.__inputs.partnerId;
  // The current target must be present and selected even though it is beyond
  // the first 100 returned rows.
  assert.equal(select.value, first.id, 'current target lost');
  assert.ok(select.findAll('option').some((o) => o.getAttribute('value') === first.id && o.textContent === 'Linked Partner'));
});

test('reference selector shows a truncation notice only when the target list is capped', async (t) => {
  const { app, baseUrl } = await startServer(t, (app2) => {
    inMemoryModule(app2, partnerModule(), partnerValidator);
    inMemoryModule(app2, contactModule(), partnerValidator);
  });
  const partners = app.modules.get('partner').service;
  // Fewer than the cap first: no notice.
  await partners.create({ name: 'Only Partner' }, { actor: { type: 'user', id: 's' } });
  const doc = createFakeDocument();
  const admin = createModuleAdmin({ doc, mount: createMount(), client: clientFor(baseUrl), navigate: () => {} });
  let form = await admin.renderNew('partner-contact');
  let hint = form.findAll('small').find((n) => /Showing the first 100/.test(n.textContent));
  assert.ok(hint && hint.classList.contains('hidden'), 'notice must be hidden when not truncated');

  // Now exceed the cap: the notice is revealed.
  for (let i = 0; i < 100; i += 1) await partners.create({ name: `P${i}` }, { actor: { type: 'user', id: 's' } });
  const admin2 = createModuleAdmin({ doc, mount: createMount(), client: clientFor(baseUrl), navigate: () => {} });
  form = await admin2.renderNew('partner-contact');
  hint = form.findAll('small').find((n) => /Showing the first 100/.test(n.textContent));
  assert.ok(hint && !hint.classList.contains('hidden'), 'notice must show when the target list is capped');
});

test('list label resolution deduplicates and bounds by-id fetches', async (t) => {
  const { app, baseUrl } = await startServer(t, (app2) => {
    inMemoryModule(app2, partnerModule(), partnerValidator);
    inMemoryModule(app2, contactModule(), partnerValidator);
  });
  const partners = app.modules.get('partner').service;
  const contacts = app.modules.get('partner-contact').service;
  const pShared = await partners.create({ name: 'Shared Partner' }, { actor: { type: 'user', id: 's' } });
  // Many contacts share ONE partner id → the label must resolve with the single
  // list call, never one fetch per row.
  for (let i = 0; i < 20; i += 1) await contacts.create({ fullName: `C${i}`, partnerId: pShared.id }, { actor: { type: 'user', id: 's' } });

  // Count target requests during the render.
  const base = clientFor(baseUrl);
  let getCalls = 0;
  const counting = {
    request(path, options) {
      enforceAdminWriteGate(path, options);
      if (/\/api\/modules\/partner\/records\/[^?]+$/.test(path)) getCalls += 1;
      return base.request(path, options);
    },
  };
  const mount = createMount();
  const admin = createModuleAdmin({ doc: createFakeDocument(), mount, client: counting, navigate: () => {} });
  await admin.renderList('partner-contact');
  // Shared id is on the first page → zero per-cell by-id fetches.
  assert.equal(getCalls, 0, `expected 0 by-id fetches, got ${getCalls}`);
  // Every row shows the resolved label, not the raw id.
  const cells = mount.findAll('td').map((c) => c.textContent);
  assert.ok(cells.filter((t) => t === 'Shared Partner').length >= 20);
});

test('hostile target labels render as text in the reference selector', async (t) => {
  const { app, baseUrl } = await startServer(t, (app2) => {
    inMemoryModule(app2, partnerModule(), partnerValidator);
    inMemoryModule(app2, contactModule(), partnerValidator);
  });
  await app.modules.get('partner').service.create({ name: '<img src=x onerror=alert(1)>' }, { actor: { type: 'user', id: 's' } });
  const doc = createFakeDocument();
  const admin = createModuleAdmin({ doc, mount: createMount(), client: clientFor(baseUrl), navigate: () => {} });
  const form = await admin.renderNew('partner-contact');
  const select = form.__inputs.partnerId;
  assert.equal(select.findAll('img').length, 0);
  assert.ok(select.findAll('option').some((o) => o.textContent.includes('<img src=x onerror=alert(1)>')));
});

test('an unsupported schema contract version names the update, with no retry', async (t) => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path = '', options = {}) {
      enforceAdminWriteGate(path, options);
      return { generatedResourceContract: 999, generatedModules: [] };
    },
  };
  const admin = createModuleAdmin({ doc, mount, client, navigate: () => {} });
  const retryButtons = () => mount.findAll('button').filter((node) => node.textContent === 'Retry');
  await admin.renderList('partner');
  // backlog:9da124e5 — distinct non-retryable state, never the contract code.
  assert.ok(mount.textContent.includes('needs an update'), 'list names the update');
  assert.ok(!mount.textContent.includes('UNSUPPORTED_CONTRACT'), 'no error code reaches the customer');
  assert.equal(retryButtons().length, 0, 'no retry that can never succeed');
  await admin.renderNew('partner');
  assert.ok(mount.textContent.includes('needs an update'), 'form names the update');
  assert.ok(!mount.textContent.includes('UNSUPPORTED_CONTRACT'), 'no error code reaches the customer');
  assert.equal(retryButtons().length, 0, 'no retry that can never succeed');
  await admin.renderDetail('partner', 'whatever');
  assert.ok(mount.textContent.includes('needs an update'), 'detail names the update');
  assert.ok(!mount.textContent.includes('UNSUPPORTED_CONTRACT'), 'no error code reaches the customer');
  assert.equal(retryButtons().length, 0, 'no retry that can never succeed');
});

test('a transient list failure still offers a retry', async (t) => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    async request(path = '', options = {}) { enforceAdminWriteGate(path, options); throw new Error('boom'); },
  };
  const admin = createModuleAdmin({ doc, mount, client, navigate: () => {} });
  await admin.renderList('partner');
  assert.ok(mount.textContent.includes('The list could not be loaded. Try again later.'));
  assert.ok(mount.findAll('button').some((node) => node.textContent === 'Retry'), 'a transient failure offers a way back');
});

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

const ACTOR = { type: 'user', id: 'admin-ui' };

// Voce 714433c2: «Nuova offerta» from the scheda cliente takes the one-time
// pick on render — the form starts with the customer chosen — and files the
// opportunity under the right company through POST /api/opportunities. The
// server stays authoritative: unknown ids refuse, never invent.
test('714433c2: renderNew(opportunity) starts with the picked customer and creates', async (t) => {
  const { app, baseUrl } = await startServer(t, () => {});
  const company = await app.services.companies.create({ name: 'Palestra Esempio' }, { actor: ACTOR });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  }, { actor: ACTOR });

  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', {
    resource: 'contact', id: contact.id, name: 'Guido Presti',
    company: { id: company.id, name: 'Palestra Esempio' },
  }), true);
  const doc = createFakeDocument();
  const mount = createMount();
  const navs = [];
  const toasts = [];
  const admin = createModuleAdmin({
    doc, mount, client: clientFor(baseUrl), navigate: (h) => navs.push(h),
    toast: (message) => toasts.push(message), storage,
  });

  const form = await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('Nuova offerta'), 'the offer screen paints');
  assert.ok(mount.textContent.includes('Cliente: Guido Presti'), 'the picked customer is named');
  assert.ok(mount.textContent.includes('Palestra Esempio'), 'the filing company is named');
  assert.ok(!mount.textContent.includes(contact.id), 'no raw id reaches the screen');
  assert.equal(takePendingCustomerPick(storage, 'offer'), null, 'the pick is read once, never kept');

  form.__inputs.title.value = 'Pacchetto 10 ingressi';
  form.__inputs.value.value = '250.00';
  form.__inputs.expiry.value = '2026-12-31';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });

  const rows = app.services.opportunities.list({ companyId: company.id });
  assert.equal(rows.length, 1, 'one opportunity filed');
  assert.equal(rows[0].contactId, contact.id, 'filed under the picked contact');
  assert.equal(rows[0].name, 'Pacchetto 10 ingressi');
  assert.equal(rows[0].valueCents, 25000, 'euro text becomes integer cents');
  assert.deepEqual(toasts, ['Offerta creata'], 'the creation toasts in Italian');
  assert.deepEqual(navs, ['#/pipelines/accordo-sales'], 'success lands on the offers board');
});

test('714433c2: renderNew(opportunity) validates before writing', async (t) => {
  const { app, baseUrl } = await startServer(t, () => {});
  const company = await app.services.companies.create({ name: 'Palestra Esempio' }, { actor: ACTOR });
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', {
    resource: 'company', id: company.id, name: 'Palestra Esempio',
  }), true);
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {} , storage});

  const form = await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('Azienda: Palestra Esempio'), 'a company pick files under itself');
  await form.__submit({ preventDefault() {} });
  assert.ok(mount.textContent.includes('Il titolo è obbligatorio.'), 'an empty title is refused');
  assert.ok(mount.textContent.includes('Il valore è obbligatorio'), 'an empty value is refused');
  assert.ok(mount.textContent.includes('Il referente è obbligatorio.'), 'an empty owner is refused');
  assert.equal(app.services.opportunities.list({ companyId: company.id }).length, 0, 'no write on invalid input');

  form.__inputs.title.value = 'Prova';
  form.__inputs.value.value = 'not-a-number';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });
  assert.ok(mount.textContent.includes('Il valore è obbligatorio'), 'a hostile value is refused');
  assert.equal(app.services.opportunities.list({ companyId: company.id }).length, 0, 'no write on a bad value');
});

// Voce 96e7b579: without a scheda pick the operator chooses the cliente in
// the form, from the server company and contact lists — never a typed id,
// never an invented customer. The server re-checks the pair on write.
function catalogClient(baseUrl, catalog) {
  const base = clientFor(baseUrl);
  return {
    request(path, options) {
      enforceAdminWriteGate(path, options);
      if (String(path).startsWith('/api/catalog/products')) return catalog;
      return base.request(path, options);
    },
  };
}

const CATALOG_FLAT = {
  products: [{
    productId: 'p1', sku: 'YOGA-10', name: 'Pacchetto 10 lezioni',
    offers: [{
      offerId: 'o-flat', name: 'Pacchetto 10 lezioni', active: true,
      currency: 'EUR',
      components: [{ pricingModel: 'flat_fee', flatAmountCents: 9900, tiers: [] }],
    }, {
      offerId: 'o-unit', name: 'Ingresso singolo', active: true,
      currency: 'EUR',
      components: [{ pricingModel: 'per_unit', unitAmountCents: 2500, tiers: [] }],
    }, {
      offerId: 'o-tiered', name: 'Abbonamento a scaglioni', active: true,
      currency: 'EUR',
      components: [{ pricingModel: 'per_unit', unitAmountCents: 1000, tiers: [{ upTo: 10, unitAmountCents: 1000 }] }],
    }],
  }],
};

async function flushContactOptions(contactSelect, rounds = 50) {
  for (let i = 0; i < rounds && contactSelect.findAll('option').length < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test('96e7b579: renderNew(opportunity) without a pick chooses the cliente from the server lists', async (t) => {
  const { app, baseUrl } = await startServer(t, () => {});
  const company = await app.services.companies.create({ name: 'Palestra Esempio' }, { actor: ACTOR });
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Guido', lastName: 'Presti', email: 'guido@palestra-esempio.it',
  }, { actor: ACTOR });
  const doc = createFakeDocument();
  const mount = createMount();
  const navs = [];
  const toasts = [];
  const admin = createModuleAdmin({
    doc, mount, client: catalogClient(baseUrl, { products: [] }),
    navigate: (h) => navs.push(h), toast: (message) => toasts.push(message), storage: memoryStorage(),
  });
  const form = await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('Nuova offerta'), 'the offer screen paints');
  assert.equal(mount.findAll('form').length, 1, 'the cliente is chosen in a form, not invented');
  const companyOptions = form.__inputs.company.findAll('option').map((o) => o.textContent);
  assert.ok(companyOptions.includes('Palestra Esempio'), 'companies come from the server list');
  assert.ok(!mount.textContent.includes(company.id), 'no raw id reaches the screen');

  form.__inputs.company.value = company.id;
  form.__inputs.company.dispatch('change');
  await flushContactOptions(form.__inputs.contact);
  const contactOptions = form.__inputs.contact.findAll('option').map((o) => o.textContent);
  assert.ok(contactOptions.includes('Guido Presti'), 'contacts follow the chosen company');
  form.__inputs.contact.value = contact.id;

  form.__inputs.title.value = 'Pacchetto 10 ingressi';
  form.__inputs.value.value = '250.00';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });
  const rows = app.services.opportunities.list({ companyId: company.id });
  assert.equal(rows.length, 1, 'one opportunity filed under the chosen company');
  assert.equal(rows[0].contactId, contact.id, 'filed under the chosen contact');
  assert.deepEqual(toasts, ['Offerta creata'], 'the creation toasts in Italian');
  assert.deepEqual(navs, ['#/pipelines/accordo-sales'], 'success lands on the offers board');
});

test('96e7b579: renderNew(opportunity) without companies says so, never invents', async (t) => {
  const { baseUrl } = await startServer(t, () => {});
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: clientFor(baseUrl), navigate: () => {}, storage: memoryStorage() });
  await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('Nuova offerta'), 'the offer screen paints');
  assert.ok(mount.textContent.includes('Non c'), 'without companies the screen says so');
  assert.equal(mount.findAll('form').length, 0, 'no form invents a customer');
});

test('96e7b579: ticked catalog products total into Valore and file the offer', async (t) => {
  const { app, baseUrl } = await startServer(t, () => {});
  const company = await app.services.companies.create({ name: 'Palestra Esempio' }, { actor: ACTOR });
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({
    doc, mount, client: catalogClient(baseUrl, CATALOG_FLAT),
    navigate: () => {}, storage: memoryStorage(),
  });
  const form = await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('scaglioni'), 'a tiered offer paints as text and stays manual');
  assert.equal(form.__productPicks.length, 2, 'only plain flat/per-unit offers are tickable');

  const [flat, unit] = form.__productPicks;
  flat.checkbox.checked = true;
  unit.checkbox.checked = true;
  unit.qtyInput.value = '2';
  form.__useTotal();
  assert.equal(form.__inputs.value.value, '149,00', 'flat once plus per-unit times quantity, comma decimals');
  form.__inputs.company.value = company.id;
  form.__inputs.title.value = 'Pacchetto 10 ingressi';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });
  const rows = app.services.opportunities.list({ companyId: company.id });
  assert.equal(rows.length, 1, 'one opportunity filed');
  assert.equal(rows[0].valueCents, 14900, 'the catalog total files as integer cents');
  assert.equal(rows[0].currency, 'EUR', 'a single-currency selection sets the currency');
});

test('96e7b579: a failed cliente read offers a retry, never an empty choice', async (t) => {
  const { baseUrl } = await startServer(t, () => {});
  const base = clientFor(baseUrl);
  const failing = { request(path, options) {
    enforceAdminWriteGate(path, options);
    if (String(path).startsWith('/api/companies')) throw new Error('boom');
    return base.request(path, options);
  } };
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: failing, navigate: () => {}, storage: memoryStorage() });
  await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('non si sono caricati'), 'a failed read says so honestly');
  assert.ok(mount.findAll('button').some((node) => node.textContent === 'Riprova'), 'a failed read offers a way back');
  assert.equal(mount.findAll('form').length, 0, 'no form chooses from a read that failed');
});

test('96e7b579: without a catalog the offer still files with a hand-typed value', async (t) => {
  const { app, baseUrl } = await startServer(t, () => {});
  const company = await app.services.companies.create({ name: 'Palestra Esempio' }, { actor: ACTOR });
  const base = clientFor(baseUrl);
  const noCatalog = { request(path, options) {
    enforceAdminWriteGate(path, options);
    if (String(path).startsWith('/api/catalog/products')) {
      const error = new Error('manual catalog not composed');
      Object.assign(error, { status: 404 });
      throw error;
    }
    return base.request(path, options);
  } };
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({ doc, mount, client: noCatalog, navigate: () => {}, storage: memoryStorage() });
  const form = await admin.renderNew('opportunity');
  assert.ok(mount.textContent.includes('Nessun catalogo'), 'a missing catalog is stated once as a hint');
  form.__inputs.company.value = company.id;
  form.__inputs.title.value = 'Pacchetto 10 ingressi';
  form.__inputs.value.value = '250.00';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });
  const rows = app.services.opportunities.list({ companyId: company.id });
  assert.equal(rows.length, 1, 'the manual value files without a catalog');
  assert.equal(rows[0].currency, 'EUR', 'a hand-typed value keeps EUR');
});

test('96e7b579: mixed-currency products refuse instead of filing', async (t) => {
  const { app, baseUrl } = await startServer(t, () => {});
  const company = await app.services.companies.create({ name: 'Palestra Esempio' }, { actor: ACTOR });
  const catalog = {
    products: [{
      productId: 'p1', name: 'Corso',
      offers: [
        { offerId: 'o-eur', name: 'Corso EUR', active: true, currency: 'EUR', components: [{ pricingModel: 'flat_fee', flatAmountCents: 1000, tiers: [] }] },
        { offerId: 'o-usd', name: 'Corso USD', active: true, currency: 'USD', components: [{ pricingModel: 'flat_fee', flatAmountCents: 1000, tiers: [] }] },
      ],
    }],
  };
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({
    doc, mount, client: catalogClient(baseUrl, catalog),
    navigate: () => {}, storage: memoryStorage(),
  });
  const form = await admin.renderNew('opportunity');
  for (const pick of form.__productPicks) pick.checkbox.checked = true;
  form.__inputs.company.value = company.id;
  form.__inputs.title.value = 'Prova';
  form.__inputs.value.value = '10.00';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });
  assert.ok(mount.textContent.includes('valute diverse'), 'a mixed selection refuses honestly');
  assert.equal(app.services.opportunities.list({ companyId: company.id }).length, 0, 'no write on a mixed selection');
});

// Voce 0c9a27bb: il prodotto scelto in «Nuova offerta» diventa la riga del
// preventivo dell'offerta. Prima i puri, poi la vista con un client finto:
// il titolo si compila da solo, il submit archivia offerta + preventivo.
test('0c9a27bb: pickedOfferTitle names the ticked offers, never a raw id', () => {
  assert.equal(pickedOfferTitle([]), '', 'nothing ticked reads as no title');
  assert.equal(
    pickedOfferTitle([{ checkbox: { checked: false }, offer: { name: 'Pacchetto' } }]),
    '',
    'an unticked row names nothing',
  );
  assert.equal(
    pickedOfferTitle([{ checkbox: { checked: true }, offer: { name: '  Pacchetto 10 lezioni  ' } }]),
    'Pacchetto 10 lezioni',
    'the ticked name is trimmed',
  );
  assert.equal(
    pickedOfferTitle([
      { checkbox: { checked: true }, offer: { name: 'Pacchetto 10 lezioni' } },
      { checkbox: { checked: true }, offer: { name: '' }, productName: 'Ingresso singolo' },
      { checkbox: { checked: true }, offer: {} },
    ]),
    'Pacchetto 10 lezioni + Ingresso singolo',
    'nameless rows fall back to the product, never to an id',
  );
});

test('0c9a27bb: centsToEuroField writes the comma form with integer math', () => {
  assert.equal(centsToEuroField(1500), '15,00', 'the acceptance example');
  assert.equal(centsToEuroField(14900), '149,00', 'what Usa il totale writes');
  assert.equal(centsToEuroField(120000), '1200,00', 'no float, no dot');
});

test('0c9a27bb: quoteLineInputs files one line per ticked offer', () => {
  assert.equal(quoteLineInputs([]), null, 'nothing ticked files nothing');
  assert.equal(quoteLineInputs([{ checkbox: { checked: false } }]), null, 'unticked files nothing');
  assert.deepEqual(
    quoteLineInputs([
      { checkbox: { checked: true }, offer: { offerId: 'o-flat' }, qtyInput: null },
      { checkbox: { checked: true }, offer: { offerId: 'o-unit' }, qtyInput: { value: '2' } },
    ]),
    { lines: [{ offerId: 'o-flat', quantity: 1 }, { offerId: 'o-unit', quantity: 2 }] },
    'flat fees file once, per-unit multiply',
  );
  assert.deepEqual(
    quoteLineInputs([{ checkbox: { checked: true }, offer: { offerId: 'o' }, qtyInput: { value: '0' } }]),
    { error: 'qty' },
    'a zero quantity cannot file',
  );
  assert.deepEqual(
    quoteLineInputs([{ checkbox: { checked: true }, offer: { offerId: 'o' }, qtyInput: { value: 'tante' } }]),
    { error: 'qty' },
    'a written-out quantity cannot file',
  );
  assert.deepEqual(
    quoteLineInputs([{ checkbox: { checked: true }, offer: {}, qtyInput: null }]),
    { error: 'offer' },
    'a row without an offer id cannot file',
  );
});

function quoteFilingClient({ books = { 'o-flat': 'pb1', 'o-unit': 'pb1' } } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if ((options.method ?? 'GET') === 'GET') {
        const id = decodeURIComponent(String(path).split('/').pop());
        if (!Object.hasOwn(books, id)) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { id, priceBookId: books[id] };
      }
      if (String(path).endsWith('/actions/create-quote')) return { ok: true, result: { quote: { id: 'q1' } } };
      if (String(path).endsWith('/actions/add-line')) return { ok: true, result: { line: { id: 'l1' } } };
      throw new Error(`unexpected write ${path}`);
    },
  };
}

test('0c9a27bb: fileQuoteWithLines opens one quote on the shared book and files the lines', async () => {
  const client = quoteFilingClient();
  const filed = await fileQuoteWithLines(client, {
    opportunityId: 'opp-1',
    lines: [{ offerId: 'o-flat', quantity: 1 }, { offerId: 'o-unit', quantity: 2 }],
    keyPrefix: 'k',
  });
  assert.deepEqual(filed, { quoteId: 'q1' }, 'the filed quote id comes back');
  const posts = client.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 3, 'one quote plus two lines');
  assert.ok(posts[0].path.endsWith('/api/modules/opportunity/records/opp-1/actions/create-quote'), 'the quote opens on the offer');
  assert.deepEqual(JSON.parse(posts[0].body), { priceBookId: 'pb1' }, 'the shared book prices the quote');
  assert.deepEqual(JSON.parse(posts[1].body), { offerId: 'o-flat', quantity: 1 }, 'the flat fee files once');
  assert.deepEqual(JSON.parse(posts[2].body), { offerId: 'o-unit', quantity: 2 }, 'the per-unit line keeps its quantity');
});

test('0c9a27bb: fileQuoteWithLines refuses mixed price books before any write', async () => {
  const client = quoteFilingClient({ books: { 'o-a': 'pb1', 'o-b': 'pb2' } });
  await assert.rejects(
    fileQuoteWithLines(client, {
      opportunityId: 'opp-1',
      lines: [{ offerId: 'o-a', quantity: 1 }, { offerId: 'o-b', quantity: 1 }],
      keyPrefix: 'k',
    }),
    (error) => error.code === 'QUOTE_BOOKS_MISMATCH',
    'mixed books refuse with a named error',
  );
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'no write on mixed books');
});

test('0c9a27bb: fileQuoteWithLines files nothing without lines', async () => {
  const client = quoteFilingClient();
  assert.equal(
    await fileQuoteWithLines(client, { opportunityId: 'opp-1', lines: [], keyPrefix: 'k' }),
    null,
    'nothing ticked files nothing',
  );
  assert.equal(client.calls.length, 0, 'no read and no write without lines');
});

// The view double: catalog plus the offer/quote writes, gated like the real
// client (a write without the submission key dies here, as live).
function quoteFilingStub({ client = quoteFilingClient() } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (String(path).startsWith('/api/catalog/products')) return CATALOG_FLAT;
      if (String(path).startsWith('/api/modules/offer/records/')) return client.request(path);
      if (String(path) === '/api/opportunities' && (options.method ?? 'GET') === 'POST') return { id: 'opp-1' };
      if (String(path).endsWith('/actions/create-quote')) return client.request(path, options);
      if (String(path).endsWith('/actions/add-line')) return client.request(path, options);
      throw new Error(`unexpected request ${options.method ?? 'GET'} ${path}`);
    },
  };
}

test('0c9a27bb: ticking a catalog product fills the title, a hand-typed title stays', async () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', {
    resource: 'company', id: 'c1', name: 'Palestra Esempio',
  }), true);
  const doc = createFakeDocument();
  const mount = createMount();
  const admin = createModuleAdmin({
    doc, mount, client: quoteFilingStub(), navigate: () => {}, toast: () => {}, storage,
  });
  const form = await admin.renderNew('opportunity');
  const [flat, unit] = form.__productPicks;

  flat.checkbox.checked = true;
  flat.checkbox.dispatch('change');
  assert.equal(form.__inputs.title.value, 'Pacchetto 10 lezioni', 'the ticked product names the offer');
  unit.checkbox.checked = true;
  unit.checkbox.dispatch('change');
  assert.equal(
    form.__inputs.title.value,
    'Pacchetto 10 lezioni + Ingresso singolo',
    'two ticked products join with +',
  );
  form.__inputs.title.value = 'Offerta per Guido';
  flat.checkbox.checked = false;
  flat.checkbox.dispatch('change');
  assert.equal(form.__inputs.title.value, 'Offerta per Guido', 'a hand-typed title is never touched');
});

test('0c9a27bb: submit files the offer and its quote lines, never an empty quote', async () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', {
    resource: 'company', id: 'c1', name: 'Palestra Esempio',
  }), true);
  const doc = createFakeDocument();
  const mount = createMount();
  const stub = quoteFilingStub();
  const navs = [];
  const toasts = [];
  const admin = createModuleAdmin({
    doc, mount, client: stub, navigate: (h) => navs.push(h), toast: (message) => toasts.push(message), storage,
  });
  const form = await admin.renderNew('opportunity');
  const [flat, unit] = form.__productPicks;
  flat.checkbox.checked = true;
  flat.checkbox.dispatch('change');
  unit.checkbox.checked = true;
  unit.qtyInput.value = '2';
  unit.checkbox.dispatch('change');
  form.__inputs.value.value = '149,00';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });

  const posts = stub.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 4, 'offer plus quote plus two lines');
  assert.equal(posts[0].path, '/api/opportunities', 'the offer files first');
  assert.equal(
    JSON.parse(posts[0].body).name,
    'Pacchetto 10 lezioni + Ingresso singolo',
    'the product names file as the offer title',
  );
  assert.ok(posts[1].path.endsWith('/actions/create-quote'), 'one draft quote opens on the offer');
  const lines = posts.slice(2).map((call) => JSON.parse(call.body));
  assert.deepEqual(
    lines,
    [{ offerId: 'o-flat', quantity: 1 }, { offerId: 'o-unit', quantity: 2 }],
    'every ticked product becomes a quote line',
  );
  assert.deepEqual(toasts, ['Offerta creata'], 'the creation toasts in Italian');
  assert.deepEqual(navs, ['#/pipelines/accordo-sales'], 'success lands on the offers board');
});

test('0c9a27bb: a bad row quantity refuses before any write', async () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', {
    resource: 'company', id: 'c1', name: 'Palestra Esempio',
  }), true);
  const doc = createFakeDocument();
  const mount = createMount();
  const stub = quoteFilingStub();
  const navs = [];
  const admin = createModuleAdmin({
    doc, mount, client: stub, navigate: (h) => navs.push(h), toast: () => {}, storage,
  });
  const form = await admin.renderNew('opportunity');
  const [, unit] = form.__productPicks;
  unit.checkbox.checked = true;
  unit.qtyInput.value = '0';
  form.__inputs.title.value = 'Prova';
  form.__inputs.value.value = '15,00';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });
  assert.ok(mount.textContent.includes('non \u00e8 valida'), 'a bad quantity refuses honestly');
  assert.equal(stub.calls.filter((call) => call.method === 'POST').length, 0, 'no write on a bad quantity');
  assert.deepEqual(navs, [], 'no navigation without a filed offer');
});

test('0c9a27bb: a failed quote filing says the offer is filed and stays for a retry', async () => {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', {
    resource: 'company', id: 'c1', name: 'Palestra Esempio',
  }), true);
  const doc = createFakeDocument();
  const mount = createMount();
  const stub = quoteFilingStub({ client: quoteFilingClient({ books: {} }) });
  const navs = [];
  const admin = createModuleAdmin({
    doc, mount, client: stub, navigate: (h) => navs.push(h), toast: () => {}, storage,
  });
  const form = await admin.renderNew('opportunity');
  const [flat] = form.__productPicks;
  flat.checkbox.checked = true;
  flat.checkbox.dispatch('change');
  form.__inputs.value.value = '99,00';
  form.__inputs.owner.value = 'elena';
  await form.__submit({ preventDefault() {} });
  assert.ok(
    mount.textContent.includes('Offerta creata, ma il preventivo non si \u00e8 compilato'),
    'the half-filed offer is said out loud with a way back',
  );
  assert.deepEqual(navs, [], 'no silent landing on the board without the lines');
  const posts = stub.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, 'only the offer filed, no quote write after the refusal');
  assert.equal(posts[0].path, '/api/opportunities', 'the offer write stands for the retry');
});

// Voce 0c9a27bb, giro 2 (review Codex P1/P2): mounted /bo writes ride
// `{ saved, spaceId }`, and a retry resumes instead of reposting. The stub
// below speaks the mounted shape on switch and fails one step at a time.
function resumeFilingStub(state = {}) {
  const calls = [];
  return {
    calls,
    state,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push({ path, method: options.method ?? 'GET', body: options.body });
      if (String(path).startsWith('/api/catalog/products')) return CATALOG_FLAT;
      if (String(path).startsWith('/api/modules/offer/records/')) {
        const id = decodeURIComponent(String(path).split('/').pop());
        return { id, priceBookId: 'pb1' };
      }
      if (String(path) === '/api/opportunities' && (options.method ?? 'GET') === 'POST') {
        return state.mounted === true ? { saved: { id: 'opp-9' }, spaceId: 'sp1' } : { id: 'opp-1' };
      }
      if (String(path).endsWith('/actions/create-quote')) {
        if (state.failQuote === true) throw Object.assign(new Error('boom'), { code: 'BOOM' });
        return state.mounted === true
          ? { saved: { result: { quote: { id: 'q9' } } }, spaceId: 'sp1' }
          : { ok: true, result: { quote: { id: 'q1' } } };
      }
      if (String(path).endsWith('/actions/add-line')) {
        const body = typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
        if (state.failLine === body.offerId) throw Object.assign(new Error('boom'), { code: 'BOOM' });
        return state.mounted === true
          ? { saved: { result: { line: { id: 'l9' } } }, spaceId: 'sp1' }
          : { ok: true, result: { line: { id: 'l1' } } };
      }
      throw new Error(`unexpected request ${options.method ?? 'GET'} ${path}`);
    },
  };
}

async function submitNewOffer({ stub, ticks = ['flat'], value = '99,00', owner = 'elena' } = {}) {
  const storage = memoryStorage();
  assert.equal(writePendingCustomerPick(storage, 'offer', {
    resource: 'company', id: 'c1', name: 'Palestra Esempio',
  }), true);
  const doc = createFakeDocument();
  const mount = createMount();
  const navs = [];
  const toasts = [];
  const admin = createModuleAdmin({
    doc, mount, client: stub, navigate: (h) => navs.push(h), toast: (message) => toasts.push(message), storage,
  });
  const form = await admin.renderNew('opportunity');
  const [flat, unit] = form.__productPicks;
  if (ticks.includes('flat')) {
    flat.checkbox.checked = true;
    flat.checkbox.dispatch('change');
  }
  if (ticks.includes('unit')) {
    unit.checkbox.checked = true;
    unit.qtyInput.value = '2';
    unit.checkbox.dispatch('change');
  }
  form.__inputs.value.value = value;
  form.__inputs.owner.value = owner;
  await form.__submit({ preventDefault() {} });
  return { form, mount, navs, toasts };
}

test('0c9a27bb giro 2 P1: a mounted write envelope still files the quote on the real offer', async () => {
  const stub = resumeFilingStub({ mounted: true });
  const { navs, toasts } = await submitNewOffer({ stub });
  const quoteOpens = stub.calls.filter((call) => call.method === 'POST' && String(call.path).includes('/actions/create-quote'));
  assert.equal(quoteOpens.length, 1, 'one quote opens');
  assert.ok(quoteOpens[0].path.includes('/records/opp-9/'), 'the quote opens on the unwrapped offer, never undefined');
  assert.ok(!quoteOpens[0].path.includes('undefined'), 'no undefined id in the quote path');
  const lineAdds = stub.calls.filter((call) => call.method === 'POST' && String(call.path).includes('/actions/add-line'));
  assert.equal(lineAdds.length, 1, 'the ticked product files one line');
  assert.ok(lineAdds[0].path.includes('/records/q9/'), 'the line files on the unwrapped quote');
  assert.deepEqual(toasts, ['Offerta creata'], 'the creation toasts in Italian');
  assert.deepEqual(navs, ['#/pipelines/accordo-sales'], 'success lands on the offers board');
});

test('0c9a27bb giro 2 P1: fileQuoteWithLines opens the mounted envelope before reading the quote id', async () => {
  const client = quoteFilingClient();
  const mounted = {
    calls: client.calls,
    async request(path, options = {}) {
      const answer = await client.request(path, options);
      if ((options.method ?? 'GET') !== 'GET') return { saved: answer, spaceId: 'sp1' };
      return answer;
    },
  };
  const filed = await fileQuoteWithLines(mounted, {
    opportunityId: 'opp-1',
    lines: [{ offerId: 'o-flat', quantity: 1 }],
    keyPrefix: 'k',
  });
  assert.deepEqual(filed, { quoteId: 'q1' }, 'the quote id is read through the envelope');
  const lineAdds = mounted.calls.filter((call) => call.method === 'POST' && String(call.path).includes('/actions/add-line'));
  assert.equal(lineAdds.length, 1, 'the line files once');
  assert.ok(lineAdds[0].path.includes('/records/q1/'), 'the line files on the opened quote, never undefined');
});

test('0c9a27bb giro 2 P2: a retry after a failed quote resumes without a second offer', async () => {
  const stub = resumeFilingStub({ failQuote: true });
  const first = await submitNewOffer({ stub });
  assert.ok(
    first.mount.textContent.includes('Offerta creata, ma il preventivo non si'),
    'the half-filed offer is said out loud with a way back',
  );
  assert.deepEqual(first.navs, [], 'no landing without the lines');
  stub.state.failQuote = false;
  await first.form.__submit({ preventDefault() {} });
  const offerPosts = stub.calls.filter((call) => call.method === 'POST' && call.path === '/api/opportunities');
  assert.equal(offerPosts.length, 1, 'the retry files no second offer');
  const quoteOpens = stub.calls.filter((call) => call.method === 'POST' && String(call.path).includes('/actions/create-quote'));
  assert.equal(quoteOpens.length, 2, 'the unopened quote opens once it can (one failure, one filing)');
  const lineAdds = stub.calls.filter((call) => call.method === 'POST' && String(call.path).includes('/actions/add-line'));
  assert.equal(lineAdds.length, 1, 'the line files once the quote opens');
  assert.deepEqual(first.toasts, ['Offerta creata'], 'the completed retry toasts in Italian');
  assert.deepEqual(first.navs, ['#/pipelines/accordo-sales'], 'the completed retry lands on the offers board');
});

test('0c9a27bb giro 2 P2: a retry after a half-filed line files only the missing lines', async () => {
  const stub = resumeFilingStub({ failLine: 'o-unit' });
  const first = await submitNewOffer({ stub, ticks: ['flat', 'unit'] });
  assert.ok(
    first.mount.textContent.includes('Offerta creata, ma il preventivo non si'),
    'the half-filed quote stays for a retry',
  );
  stub.state.failLine = null;
  await first.form.__submit({ preventDefault() {} });
  const offerPosts = stub.calls.filter((call) => call.method === 'POST' && call.path === '/api/opportunities');
  assert.equal(offerPosts.length, 1, 'the retry files no second offer');
  const quoteOpens = stub.calls.filter((call) => call.method === 'POST' && String(call.path).includes('/actions/create-quote'));
  assert.equal(quoteOpens.length, 1, 'the kept quote opens no second quote');
  const flatAdds = stub.calls.filter((call) => (
    call.method === 'POST' && String(call.path).includes('/actions/add-line') && String(call.body).includes('"offerId":"o-flat"')
  ));
  assert.equal(flatAdds.length, 1, 'the filed line is not filed again');
  const unitAdds = stub.calls.filter((call) => (
    call.method === 'POST' && String(call.path).includes('/actions/add-line') && String(call.body).includes('"offerId":"o-unit"')
  ));
  assert.equal(unitAdds.length, 2, 'the missing line is retried once (one failure, one filing)');
  assert.deepEqual(first.toasts, ['Offerta creata'], 'the completed retry toasts in Italian');
  assert.deepEqual(first.navs, ['#/pipelines/accordo-sales'], 'the completed retry lands on the offers board');
});
