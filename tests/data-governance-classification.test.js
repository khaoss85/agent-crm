import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DATA_CLASSIFICATIONS,
  UNCLASSIFIED_DATA,
  fieldDataClassifications,
  generateModuleMigration,
  validateModuleManifest,
} from '../packages/core/src/module-manifest.js';
import { moduleStateFingerprint, planModuleEvolution } from '../packages/core/src/module-evolution.js';

/**
 * Data Governance criterion 1 (`docs/strategy/DATA_GOVERNANCE.md`
 * §Classification; owner taxonomy 2026-09-19, `backlog:0c1af0e22dc6`): a
 * personal-data field carries a classification, and a field with none is
 * reported as unclassified rather than treated as safe.
 */

const manifest = (fields) => ({ name: 'contact', fields });

test('the taxonomy is the three owner-approved classes', () => {
  assert.deepEqual([...DATA_CLASSIFICATIONS], ['identification', 'special-category', 'non-personal']);
  assert.equal(UNCLASSIFIED_DATA, 'unclassified');
});

test('each approved class validates, normalizes frozen, and survives the round trip', () => {
  for (const classification of DATA_CLASSIFICATIONS) {
    const normalized = validateModuleManifest(manifest([{ name: 'email', type: 'string', classification }]));
    assert.equal(normalized.fields[0].classification, classification);
    assert.ok(Object.isFrozen(normalized.fields[0]));
    const again = validateModuleManifest(JSON.parse(JSON.stringify(normalized)));
    assert.equal(again.fields[0].classification, classification);
  }
});

test('unknown classifications fail closed, including unclassified itself', () => {
  for (const classification of ['unclassified', 'personal', 'sensitive', 'pseudonymous', 'public', '']) {
    assert.throws(
      () => validateModuleManifest(manifest([{ name: 'email', type: 'string', classification }])),
      /classification must be one of: identification, special-category, non-personal/,
      `expected ${JSON.stringify(classification)} to be rejected`,
    );
  }
});

test('a field with no marker is reported as unclassified, never as non-personal', () => {
  const report = fieldDataClassifications(manifest([
    { name: 'email', type: 'string', classification: 'identification' },
    { name: 'note', type: 'string' },
  ]));
  assert.deepEqual([...report], [
    { name: 'email', classification: 'identification' },
    { name: 'note', classification: 'unclassified' },
  ]);
  assert.ok(Object.isFrozen(report));
  assert.ok(report.every((row) => Object.isFrozen(row)));
  assert.notEqual(report[1].classification, 'non-personal');
});

test('classification is metadata: the generated SQL is byte-identical with or without it', () => {
  const plain = manifest([{ name: 'email', type: 'string' }]);
  const marked = manifest([{ name: 'email', type: 'string', classification: 'identification' }]);
  assert.equal(generateModuleMigration(marked).sql, generateModuleMigration(plain).sql);
});

test('a classification-only change evolves as metadata, never storage', () => {
  const previous = manifest([{ name: 'email', type: 'string' }]);
  const next = { ...manifest([{ name: 'email', type: 'string', classification: 'identification' }]), revision: 2 };
  const plan = planModuleEvolution({ previous, next });
  assert.equal(plan.strategy, 'metadata');
  assert.deepEqual(plan.metadataChanges, ['email.classification']);
  assert.deepEqual(plan.addedFields, []);
});

test('fingerprints of unmarked manifests do not move; adding a marker does', () => {
  const before = manifest([{ name: 'email', type: 'string' }]);
  const untouched = manifest([{ name: 'email', type: 'string' }]);
  assert.equal(moduleStateFingerprint(before), moduleStateFingerprint(untouched));
  const marked = manifest([{ name: 'email', type: 'string', classification: 'identification' }]);
  assert.notEqual(moduleStateFingerprint(marked), moduleStateFingerprint(before));
});
