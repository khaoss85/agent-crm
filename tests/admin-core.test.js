import test from 'node:test';
import assert from 'node:assert/strict';
import {
  humanizeLabel,
  fieldControl,
  editableFields,
  buildCreatePayload,
  buildUpdatePayload,
  apiErrorToFormErrors,
  selectGeneratedModules,
  displayTitle,
  SUPPORTED_ADMIN_CONTRACT,
} from '../apps/admin/public/admin-core.js';

test('humanizeLabel handles camelCase, snake_case and acronyms', () => {
  assert.equal(humanizeLabel('companyName'), 'Company name');
  assert.equal(humanizeLabel('company_name'), 'Company name');
  assert.equal(humanizeLabel('URLValue'), 'URL value');
  assert.equal(humanizeLabel('tier'), 'Tier');
  assert.equal(humanizeLabel('active'), 'Active');
  assert.equal(humanizeLabel('valueCents'), 'Value cents');
  assert.equal(humanizeLabel(''), '');
});

test('fieldControl maps every supported type', () => {
  assert.equal(fieldControl({ name: 'name', type: 'string', required: true }).control, 'text');
  assert.equal(fieldControl({ name: 'age', type: 'integer' }).control, 'number');
  assert.equal(fieldControl({ name: 'active', type: 'boolean' }).control, 'checkbox');
  assert.equal(fieldControl({ name: 'email', type: 'email' }).control, 'email');
  const enumControl = fieldControl({ name: 'tier', type: 'enum', values: ['a', 'b'] });
  assert.equal(enumControl.control, 'select');
  assert.deepEqual(enumControl.options, ['a', 'b']);
});

test('editableFields excludes immutable framework fields', () => {
  const fields = editableFields({ fields: [{ name: 'name', type: 'string' }, { name: 'id', type: 'string' }] });
  assert.deepEqual(fields.map((field) => field.name), ['name']);
});

test('buildCreatePayload enforces required, omits optional blanks and strict types', () => {
  const fields = [
    { name: 'name', type: 'string', required: true },
    { name: 'tier', type: 'enum', values: ['gold'] },
    { name: 'seats', type: 'integer' },
    { name: 'active', type: 'boolean' },
  ];
  const ok = buildCreatePayload(fields, { name: 'Acme', tier: '', seats: '5', active: true });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.payload, { name: 'Acme', seats: 5, active: true });

  const missing = buildCreatePayload(fields, { name: '  ', active: false });
  assert.match(missing.errors.name, /required/);
  assert.deepEqual(missing.payload, { active: false });

  const bad = buildCreatePayload(fields, { name: 'X', seats: '1.5' });
  assert.match(bad.errors.seats, /whole number/);
  assert.equal('seats' in bad.payload, false);
});

test('buildUpdatePayload sends only changed fields, never immutable ones', () => {
  const fields = [
    { name: 'name', type: 'string', required: true },
    { name: 'tier', type: 'enum', values: ['gold', 'platinum'] },
    { name: 'id', type: 'string' },
  ];
  const current = { name: 'Acme', tier: 'gold', id: 'x1' };
  const result = buildUpdatePayload(fields, { name: 'Acme', tier: 'platinum', id: 'hack' }, current);
  assert.deepEqual(result.payload, { tier: 'platinum' });

  const noop = buildUpdatePayload(fields, { name: 'Acme', tier: 'gold' }, current);
  assert.deepEqual(noop.payload, {});
});

test('apiErrorToFormErrors maps status/code/field', () => {
  const mapped = apiErrorToFormErrors({ message: 'tier must be one of', status: 400, code: 'VALIDATION_ERROR', details: { field: 'tier' } });
  assert.equal(mapped.status, 400);
  assert.equal(mapped.code, 'VALIDATION_ERROR');
  assert.equal(mapped.fields.tier, 'tier must be one of');
});

test('selectGeneratedModules gates on contract version and sorts deterministically', () => {
  const schema = {
    generatedResourceContract: SUPPORTED_ADMIN_CONTRACT,
    generatedModules: [
      { name: 'supplier', kind: 'generated', capabilities: ['list'], fields: [] },
      { name: 'partner', kind: 'generated', capabilities: ['list'], fields: [] },
      { name: 'BAD NAME', kind: 'generated', capabilities: ['list'], fields: [] },
      { name: 'notgen', kind: 'core', capabilities: [], fields: [] },
    ],
  };
  const result = selectGeneratedModules(schema);
  assert.equal(result.supported, true);
  assert.deepEqual(result.modules.map((module) => module.name), ['partner', 'supplier']);

  const future = selectGeneratedModules({ generatedResourceContract: 999, generatedModules: [] });
  assert.equal(future.supported, false);
  assert.deepEqual(future.modules, []);

  const legacy = selectGeneratedModules({});
  assert.equal(legacy.supported, false);
});

test('displayTitle prefers the first required string, falls back to id', () => {
  const fields = [{ name: 'name', type: 'string', required: true }, { name: 'tier', type: 'enum', values: [] }];
  assert.equal(displayTitle({ name: 'Acme', id: 'x' }, fields), 'Acme');
  assert.equal(displayTitle({ id: 'x1' }, fields), 'x1');
});
