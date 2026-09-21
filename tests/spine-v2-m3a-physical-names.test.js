import test from 'node:test';
import assert from 'node:assert/strict';

import {
  POSTGRES_IDENTIFIER_MAX_BYTES,
  mapPhysicalName,
  mapPhysicalNamespace,
  quotePostgresIdent,
} from '../packages/core/src/physical-name.js';

test('safe short identifiers are unchanged', () => {
  assert.deepEqual(mapPhysicalName('companies'), {
    logical: 'companies',
    physical: 'companies',
    mapped: false,
  });
  assert.deepEqual(mapPhysicalName('value_cents'), {
    logical: 'value_cents',
    physical: 'value_cents',
    mapped: false,
  });
  const maxSafe = `c${'a'.repeat(POSTGRES_IDENTIFIER_MAX_BYTES - 1)}`;
  assert.equal(mapPhysicalName(maxSafe).mapped, false);
  assert.equal(mapPhysicalName(maxSafe).physical, maxSafe);
});

test('long names get a bounded prefix and a collision-resistant digest', () => {
  const logical = `opportunities_with_an_extremely_long_qualifier_that_exceeds_namelen_${'x'.repeat(40)}`;
  const mapped = mapPhysicalName(logical);
  assert.equal(mapped.mapped, true);
  assert.equal(mapped.logical, logical);
  assert.ok(mapped.physical.length <= POSTGRES_IDENTIFIER_MAX_BYTES);
  assert.match(mapped.physical, /^[a-z][a-z0-9_]*$/);
  assert.equal(Buffer.byteLength(mapped.physical, 'utf8') <= POSTGRES_IDENTIFIER_MAX_BYTES, true);
  assert.equal(mapPhysicalName(logical).physical, mapped.physical);
});

test('multibyte logical names stay distinct and within 63 bytes', () => {
  const cafe = 'café_pipeline_stage_history_archive_with_extra_qualifiers';
  const cjk = '用户表_pipeline_stage_history_archive_with_extra_qualifiers';
  const left = mapPhysicalName(cafe);
  const right = mapPhysicalName(cjk);
  assert.equal(left.mapped, true);
  assert.equal(right.mapped, true);
  assert.notEqual(left.physical, right.physical);
  assert.ok(Buffer.byteLength(left.physical, 'utf8') <= POSTGRES_IDENTIFIER_MAX_BYTES);
  assert.ok(Buffer.byteLength(right.physical, 'utf8') <= POSTGRES_IDENTIFIER_MAX_BYTES);
});

test('same-prefix long names remain distinct and the namespace is validated before DDL', () => {
  const prefix = 'opportunity_pipeline_stage_history_archive_collision_candidate_';
  const left = `${prefix}alpha_extra_tail_to_force_mapping`;
  const right = `${prefix}bravo_extra_tail_to_force_mapping`;
  const namespace = mapPhysicalNamespace([left, right, 'companies']);
  const physicals = namespace.map((entry) => entry.physical);
  assert.equal(new Set(physicals).size, physicals.length);
  assert.notEqual(
    namespace.find((entry) => entry.logical === left)?.physical,
    namespace.find((entry) => entry.logical === right)?.physical,
  );
  assert.equal(namespace.find((entry) => entry.logical === 'companies')?.mapped, false);
});

test('physical-name refusals carry no path or credential', () => {
  const sentinel = 'postgresql://user:super-secret@sentinel.invalid/accordo';
  assert.throws(
    () => mapPhysicalName(''),
    (error) => error.code === 'PHYSICAL_NAME_INVALID'
      && !JSON.stringify(error).includes(sentinel)
      && !/password|credential|\.sqlite/i.test(error.message),
  );
  assert.equal(quotePostgresIdent('companies'), '"companies"');
});
