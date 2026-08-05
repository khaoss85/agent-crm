import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionRegistry,
  validateActionDefinition,
  actionMetadata,
  SUPPORTED_ACTION_CONTRACT,
} from '../packages/core/src/action-registry.js';
import { validateActionInput } from '../packages/core/src/action-runtime.js';

const deps = { moduleExists: (name) => name === 'lead' };

function validDefinition(overrides = {}) {
  return {
    module: 'lead',
    name: 'qualify',
    actionContract: 1,
    fromStates: ['new'],
    input: [{ name: 'dueAt', type: 'timestamp', required: true }],
    execute() {},
    ...overrides,
  };
}

test('a well-formed action definition validates', () => {
  assert.doesNotThrow(() => validateActionDefinition(validDefinition(), deps));
});

test('malformed action definitions fail closed with a precise reason', () => {
  const cases = [
    [validDefinition({ module: 'Lead' }), /module must match/],
    [validDefinition({ name: 'Qualify' }), /name must match/],
    [validDefinition({ actionContract: 2 }), /actionContract must be 1/],
    [validDefinition({ module: 'ghost' }), /target module "ghost" is not a generated module/],
    [validDefinition({ execute: 'nope' }), /execute must be a function/],
    [validDefinition({ input: {} }), /input must be an array/],
    [validDefinition({ input: [{ name: 'Bad', type: 'string' }] }), /camelCase name/],
    [validDefinition({ input: [{ name: 'x', type: 'string' }, { name: 'x', type: 'string' }] }), /duplicate input "x"/],
    [validDefinition({ input: [{ name: 'x', type: 'number' }] }), /type must be one of/],
    [validDefinition({ input: [{ name: 'x', type: 'enum' }] }), /enum input "x" needs values/],
    [validDefinition({ fromStates: 'new' }), /fromStates must be an array/],
  ];
  for (const [definition, pattern] of cases) {
    assert.throws(() => validateActionDefinition(definition, deps), pattern);
  }
});

test('registry enforces unique identity and resolves by module+name', () => {
  const registry = new ActionRegistry(deps);
  registry.register(validDefinition());
  assert.throws(() => registry.register(validDefinition()), /Duplicate action identity: lead.qualify/);
  assert.equal(registry.get('lead', 'qualify').name, 'qualify');
  assert.throws(() => registry.get('lead', 'ghost'), (error) => error.code === 'NOT_FOUND');
});

test('registry is Map-backed: prototype-polluting names never resolve', () => {
  const registry = new ActionRegistry(deps);
  assert.throws(() => registry.get('lead', '__proto__'), (error) => error.code === 'NOT_FOUND');
  assert.throws(() => registry.get('constructor', 'toString'), (error) => error.code === 'NOT_FOUND');
});

test('listForModule returns deterministic, source-free metadata sorted by name', () => {
  const registry = new ActionRegistry(deps);
  registry.register(validDefinition({ name: 'qualify' }));
  registry.register(validDefinition({ name: 'disqualify', input: [{ name: 'reason', type: 'string', required: true }] }));
  const list = registry.listForModule('lead');
  assert.deepEqual(list.map((action) => action.name), ['disqualify', 'qualify']);
  for (const entry of list) {
    assert.equal(typeof entry.execute, 'undefined', 'metadata never leaks the execute function');
    assert.equal(entry.actionContract, SUPPORTED_ACTION_CONTRACT);
    assert.equal(entry.stateField, 'status');
  }
  assert.equal(registry.listForModule('other').length, 0);
});

test('actionMetadata exposes label/description defaults, input, path and confirm', () => {
  const meta = actionMetadata(validDefinition({ label: 'Qualify lead', confirm: true }));
  assert.equal(meta.label, 'Qualify lead');
  assert.equal(meta.description, null);
  assert.equal(meta.confirm, true);
  assert.deepEqual(meta.fromStates, ['new']);
  assert.deepEqual(meta.input, [{ name: 'dueAt', type: 'timestamp', required: true }]);
  assert.equal(meta.path, '/api/modules/lead/records/:id/actions/qualify');
});

// ---- input validation --------------------------------------------------

test('validateActionInput: required missing, optional missing, and type checks', () => {
  const schema = [
    { name: 'dueAt', type: 'timestamp', required: true },
    { name: 'note', type: 'string' },
    { name: 'channel', type: 'enum', values: ['email', 'call'] },
  ];
  // Happy path with trimming and ISO normalization.
  assert.deepEqual(
    validateActionInput(schema, { dueAt: '2026-08-12T09:00:00Z', note: '  hi  ', channel: 'email' }),
    { dueAt: '2026-08-12T09:00:00.000Z', note: 'hi', channel: 'email' },
  );
  // Optional fields simply omitted when blank.
  assert.deepEqual(validateActionInput(schema, { dueAt: '2026-08-12T09:00:00Z' }), { dueAt: '2026-08-12T09:00:00.000Z' });
  // Required missing → field-tied ValidationError.
  assert.throws(() => validateActionInput(schema, {}), (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'dueAt');
  // Bad timestamp, bad enum, non-object body.
  assert.throws(() => validateActionInput(schema, { dueAt: 'not-a-date' }), /ISO-8601/);
  assert.throws(() => validateActionInput(schema, { dueAt: '2026-08-12T09:00:00Z', channel: 'sms' }), /must be one of/);
  assert.throws(() => validateActionInput(schema, [1, 2]), /must be a JSON object/);
});
