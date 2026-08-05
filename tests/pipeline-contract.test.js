import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PipelineRegistry,
  validatePipelineDefinition,
  pipelineMetadata,
} from '../packages/core/src/pipeline-registry.js';
import { formatMinorUnits } from '../apps/admin/public/admin-core.js';

const deps = { moduleExists: (name) => ['opportunity', 'ticket'].includes(name) };

function validPipeline(overrides = {}) {
  return {
    pipelineContract: 1,
    name: 'b2b-sales',
    label: 'B2B Sales',
    module: 'opportunity',
    defaultStage: 'discovery',
    stages: [
      { key: 'discovery', label: 'Discovery', order: 10, type: 'open', probability: 10 },
      { key: 'demo', label: 'Demo', order: 20, type: 'open', probability: 30 },
      { key: 'won', label: 'Won', order: 50, type: 'won', probability: 100 },
      { key: 'lost', label: 'Lost', order: 60, type: 'lost', probability: 0 },
    ],
    ...overrides,
  };
}

test('a well-formed pipeline validates', () => {
  assert.doesNotThrow(() => validatePipelineDefinition(validPipeline(), deps));
});

test('malformed pipelines fail closed with precise reasons', () => {
  const stages = validPipeline().stages;
  const cases = [
    [validPipeline({ pipelineContract: 2 }), /pipelineContract must be 1/],
    [validPipeline({ name: 'B2B' }), /name must match/],
    [validPipeline({ module: 'ghost' }), /does not exist or is not staged-eligible/],
    [validPipeline({ label: 'x'.repeat(81) }), /at most 80/],
    [validPipeline({ stages: [] }), /non-empty array/],
    [validPipeline({ stages: [...stages, { key: 'demo', order: 70, type: 'open', probability: 1 }] }), /duplicate stage key/],
    [validPipeline({ stages: [...stages, { key: 'extra', order: 10, type: 'open', probability: 1 }] }), /duplicate stage order/],
    [validPipeline({ stages: [{ key: 'a', order: 1, type: 'weird', probability: 1 }] }), /type must be one of/],
    [validPipeline({ stages: [{ key: 'a', order: 1, type: 'open', probability: 101 }] }), /probability must be an integer 0–100/],
    [validPipeline({ stages: [{ key: 'a', order: 1, type: 'open', probability: 1.5 }] }), /probability must be an integer/],
    [validPipeline({ stages: stages.map((s) => (s.type === 'won' ? { ...s, probability: 90 } : s)) }), /won stage must have probability 100/],
    [validPipeline({ stages: stages.map((s) => (s.type === 'lost' ? { ...s, probability: 5 } : s)) }), /lost stage must have probability 0/],
    [validPipeline({ stages: [{ key: 'won', order: 1, type: 'won', probability: 100 }] }), /at least one open stage/],
    [validPipeline({ stages: [...stages, { key: 'won2', order: 70, type: 'won', probability: 100 }] }), /at most one won/],
    [validPipeline({ stages: [...stages, { key: 'lost2', order: 70, type: 'lost', probability: 0 }] }), /at most one lost/],
    [validPipeline({ defaultStage: 'ghost' }), /defaultStage must name one of the stage keys/],
    [validPipeline({ defaultStage: 'won' }), /defaultStage must be an open stage/],
  ];
  for (const [definition, pattern] of cases) {
    assert.throws(() => validatePipelineDefinition(definition, deps), pattern);
  }
});

test('registry: unique names, one pipeline per module, prototype-safe lookups', () => {
  const registry = new PipelineRegistry(deps);
  registry.register(validPipeline());
  assert.throws(() => registry.register(validPipeline()), /Duplicate pipeline name|already has pipeline/);
  assert.throws(
    () => registry.register(validPipeline({ name: 'other-sales' })),
    /already has pipeline "b2b-sales"/,
  );
  // A second pipeline for a DIFFERENT module is fine — the contract is not
  // hardcoded to one stage list or one module.
  registry.register(validPipeline({
    name: 'support',
    module: 'ticket',
    defaultStage: 'triage',
    stages: [
      { key: 'triage', order: 1, type: 'open', probability: 10 },
      { key: 'resolved', order: 2, type: 'won', probability: 100 },
    ],
  }));
  assert.equal(registry.forModule('ticket').name, 'support');
  assert.equal(registry.forModule('missing'), null);
  assert.equal(registry.forModule('__proto__'), null);
  assert.throws(() => registry.get('__proto__'), (error) => error.code === 'NOT_FOUND');
  assert.throws(() => registry.get('constructor'), (error) => error.code === 'NOT_FOUND');
});

test('pipeline metadata is deterministic, ordered and function-free', () => {
  const meta = pipelineMetadata(validPipeline({
    stages: [
      { key: 'won', order: 50, type: 'won', probability: 100 },
      { key: 'discovery', order: 10, type: 'open', probability: 10 },
      { key: 'lost', order: 60, type: 'lost', probability: 0 },
      { key: 'demo', order: 20, type: 'open', probability: 30 },
    ],
  }));
  assert.deepEqual(meta.stages.map((stage) => stage.key), ['discovery', 'demo', 'won', 'lost'], 'sorted by order');
  assert.equal(meta.movePath, '/api/modules/opportunity/records/:id/actions/move-stage');
  assert.equal(JSON.parse(JSON.stringify(meta)).name, meta.name, 'plain serializable data');
  for (const value of Object.values(meta)) assert.notEqual(typeof value, 'function');
});

test('formatMinorUnits is deterministic and never locale-driven', () => {
  assert.equal(formatMinorUnits(5_000_000, 'EUR'), 'EUR 50,000.00');
  assert.equal(formatMinorUnits(500000, 'EUR'), 'EUR 5,000.00');
  assert.equal(formatMinorUnits(1, 'USD'), 'USD 0.01');
  assert.equal(formatMinorUnits(0, 'EUR'), 'EUR 0.00');
  assert.equal(formatMinorUnits(123456789, 'CHF'), 'CHF 1,234,567.89');
  assert.equal(formatMinorUnits(-2500, 'EUR'), 'EUR -25.00');
  assert.equal(formatMinorUnits(Number.NaN, 'EUR'), '—');
  assert.equal(formatMinorUnits(1.5, 'EUR'), '—', 'fractional minor units are invalid');
});
