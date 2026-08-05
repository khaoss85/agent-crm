import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferenceResolver } from '../packages/core/src/reference-resolver.js';

function fakeRegistry(modules) {
  return { modules: new Map(modules.map((m) => [m.name, m])) };
}

test('assertTarget validates through the target service and fails closed', () => {
  const partner = {
    name: 'partner',
    kind: 'generated',
    table: 'partners',
    capabilities: ['get'],
    service: {
      get(id) {
        if (id !== 'p1') throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' });
        return { id };
      },
    },
  };
  const resolver = createReferenceResolver(fakeRegistry([partner]));

  assert.equal(resolver.assertTarget('partners', 'p1', 'partnerId'), 'p1');

  // Missing record → field-tied validation error.
  assert.throws(
    () => resolver.assertTarget('partners', 'ghost', 'partnerId'),
    (error) => error.code === 'VALIDATION_ERROR' && error.details.field === 'partnerId',
  );

  // Non-string / blank id.
  assert.throws(() => resolver.assertTarget('partners', '', 'partnerId'), /must reference an existing record/);
  assert.throws(() => resolver.assertTarget('partners', 42, 'partnerId'), /must reference an existing record/);

  // Unknown target table → fail closed, not a crash.
  assert.throws(() => resolver.assertTarget('nope', 'p1', 'partnerId'), /target module is not available/);
});

test('a target without get capability, or a core module, is never a valid target', () => {
  const noGet = { name: 'x', kind: 'generated', table: 'xs', capabilities: ['list'], service: { get() {} } };
  const core = { name: 'company', kind: undefined, table: 'companies', service: { get: () => ({ id: 'c1' }) } };
  const resolver = createReferenceResolver(fakeRegistry([noGet, core]));
  assert.throws(() => resolver.assertTarget('xs', 'a', 'ref'), /target module is not available/);
  // Core module (kind !== 'generated') is invisible to the resolver.
  assert.throws(() => resolver.assertTarget('companies', 'c1', 'ref'), /target module is not available/);
});

test('an unexpected target-service error is not swallowed as a missing target', () => {
  const boom = {
    name: 'partner',
    kind: 'generated',
    table: 'partners',
    capabilities: ['get'],
    service: {
      get() {
        throw Object.assign(new Error('permission denied'), { code: 'FORBIDDEN', status: 403 });
      },
    },
  };
  const resolver = createReferenceResolver(fakeRegistry([boom]));
  // Must propagate the original error, never rewrite it to "does not exist".
  assert.throws(
    () => resolver.assertTarget('partners', 'p1', 'partnerId'),
    (error) => error.code === 'FORBIDDEN' && /permission denied/.test(error.message),
  );
});

test('two independent resolvers over same-named modules stay isolated', () => {
  const make = (allowed) => ({
    name: 'partner',
    kind: 'generated',
    table: 'partners',
    capabilities: ['get'],
    service: { get(id) { if (id !== allowed) throw Object.assign(new Error('x'), { code: 'NOT_FOUND' }); return { id }; } },
  });
  const a = createReferenceResolver(fakeRegistry([make('a1')]));
  const b = createReferenceResolver(fakeRegistry([make('b1')]));
  assert.equal(a.assertTarget('partners', 'a1', 'ref'), 'a1');
  assert.equal(b.assertTarget('partners', 'b1', 'ref'), 'b1');
  assert.throws(() => a.assertTarget('partners', 'b1', 'ref'), /does not exist/);
  assert.throws(() => b.assertTarget('partners', 'a1', 'ref'), /does not exist/);
});

test('non-string ids fail predictably and are never coerced', () => {
  const resolver = createReferenceResolver(fakeRegistry([
    { name: 'partner', kind: 'generated', table: 'partners', capabilities: ['get'], service: { get: () => ({ id: 'p1' }) } },
  ]));
  for (const bad of [42, true, ['p1'], { id: 'p1' }, '   ', new String('p1')]) {
    assert.throws(() => resolver.assertTarget('partners', bad, 'ref'), /must reference an existing record/);
  }
});

test('resolution is lazy: a target registered after the resolver is still found', () => {
  const registry = fakeRegistry([]);
  const resolver = createReferenceResolver(registry);
  assert.throws(() => resolver.assertTarget('partners', 'p1', 'ref'));
  registry.modules.set('partner', {
    name: 'partner',
    kind: 'generated',
    table: 'partners',
    capabilities: ['get'],
    service: { get: () => ({ id: 'p1' }) },
  });
  assert.equal(resolver.assertTarget('partners', 'p1', 'ref'), 'p1');
});
