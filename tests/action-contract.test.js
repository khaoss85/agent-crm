import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ActionRegistry,
  validateActionDefinition,
  actionMetadata,
  SUPPORTED_ACTION_CONTRACT,
} from '../packages/core/src/action-registry.js';
import { validateActionInput, ACTION_STRING_MAX_LENGTH } from '../packages/core/src/action-runtime.js';

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

test('M2E-1: actionContract 2 is accepted, and externalOperation is a separate version set', () => {
  // The accepted set widened to {1, 2}.
  assert.doesNotThrow(() => validateActionDefinition(validDefinition({ actionContract: 2 }), deps));

  // Phase-shape marker, not the action contract. v1 remains the SQLite/legacy
  // runner; v2 is the PostgreSQL recovery contract. Both are valid definitions.
  assert.doesNotThrow(() => validateActionDefinition(validDefinition({
    actionContract: 2, externalOperation: 2, execute: undefined,
    intent() {}, external() {}, finalize() {},
  }), deps));
  assert.throws(
    () => validateActionDefinition(validDefinition({
      actionContract: 2, externalOperation: 3, execute: undefined,
      intent() {},
    }), deps),
    /externalOperation must be one of 1, 2/,
  );
});

test('malformed action definitions fail closed with a precise reason', () => {
  const cases = [
    [validDefinition({ module: 'Lead' }), /module must match/],
    [validDefinition({ name: 'Qualify' }), /name must match/],
    [validDefinition({ actionContract: 3 }), /actionContract must be one of 1, 2/],
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

test('timestamps: one canonical UTC contract, real calendar dates only', () => {
  const schema = [{ name: 'dueAt', type: 'timestamp', required: true }];
  const ok = (raw) => validateActionInput(schema, { dueAt: raw }).dueAt;
  const bad = (raw) => assert.throws(
    () => validateActionInput(schema, { dueAt: raw }),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'dueAt',
    `expected rejection for ${JSON.stringify(raw)}`,
  );

  // Canonical accepted forms normalize to millisecond ISO.
  assert.equal(ok('2026-08-10T09:00:00.000Z'), '2026-08-10T09:00:00.000Z');
  assert.equal(ok('2026-08-10T09:00:00Z'), '2026-08-10T09:00:00.000Z');

  // JavaScript's Date would silently roll these over; the contract rejects them.
  bad('2026-02-30T09:00:00Z'); // no Feb 30
  bad('2026-04-31T09:00:00Z'); // no Apr 31
  bad('2026-13-01T09:00:00Z'); // no month 13
  assert.equal(ok('2024-02-29T09:00:00Z'), '2024-02-29T09:00:00.000Z'); // leap day is real

  // Offsets, date-only, space-separated, junk: not the canonical form.
  bad('2026-08-10T11:00:00+02:00');
  bad('2026-08-10');
  bad('2026-08-10 09:00');
  bad('invalid date');
  bad('NaN');
  bad(12345);
  bad(`2026-08-10T09:00:00Z${'x'.repeat(500)}`);
});

test('integer inputs: JSON safe integers only, zero allowed, everything else rejected', () => {
  const schema = [{ name: 'valueCents', type: 'integer', required: true }];
  assert.equal(validateActionInput(schema, { valueCents: 5_000_000 }).valueCents, 5_000_000);
  assert.equal(validateActionInput(schema, { valueCents: 0 }).valueCents, 0, 'zero is present, not missing');
  assert.equal(validateActionInput(schema, { valueCents: -3 }).valueCents, -3, 'sign policy belongs to the action');
  for (const bad of ['50000', 10.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, true, null, [5], {}]) {
    assert.throws(
      () => validateActionInput(schema, { valueCents: bad }),
      (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'valueCents',
      `expected rejection for ${String(bad)}`,
    );
  }
  // The registry accepts integer as a declared input type.
  assert.doesNotThrow(() => validateActionDefinition(validDefinition({ input: [{ name: 'n', type: 'integer' }] }), deps));
});

test('input hints are validated metadata, exposed as text and bounded', () => {
  const withHint = validDefinition({ input: [{ name: 'valueCents', type: 'integer', hint: 'Integer MINOR units: 500000 means 5,000.00.' }] });
  assert.doesNotThrow(() => validateActionDefinition(withHint, deps));
  const meta = actionMetadata(withHint);
  assert.equal(meta.input[0].hint, 'Integer MINOR units: 500000 means 5,000.00.');
  // Non-string and oversized hints fail closed at registration.
  assert.throws(
    () => validateActionDefinition(validDefinition({ input: [{ name: 'x', type: 'string', hint: 42 }] }), deps),
    /hint must be a string/,
  );
  assert.throws(
    () => validateActionDefinition(validDefinition({ input: [{ name: 'x', type: 'string', hint: 'h'.repeat(201) }] }), deps),
    /at most 200/,
  );
  // No hint declared → no hint key in metadata (deterministic shape).
  assert.equal(Object.hasOwn(actionMetadata(validDefinition()).input[0], 'hint'), false);
});

test('string inputs are bounded; whitespace-only counts as missing after trim', () => {
  const schema = [{ name: 'reason', type: 'string', required: true }];
  assert.equal(validateActionInput(schema, { reason: '  keep  inner  space  ' }).reason, 'keep  inner  space');
  assert.throws(
    () => validateActionInput(schema, { reason: 'x'.repeat(ACTION_STRING_MAX_LENGTH + 1) }),
    (error) => error.code === 'VALIDATION_ERROR' && /at most/.test(error.message),
  );
  // A newline-only reason survives the missing check (it is not '') but trims
  // to empty — the runtime stores '', which the starter treats as unusable, so
  // verify the documented behavior: trim happens, and blank-after-trim strings
  // are rejected as missing.
  assert.throws(
    () => validateActionInput(schema, { reason: '\n\t  ' }),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'reason',
  );
});
