import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PIPELINE_STAGE_TYPES,
  validatePipelineDefinition,
} from '../packages/core/src/pipeline-registry.js';
import { buildMoveStageAction } from '../packages/core/src/pipeline-actions.js';
import {
  confirmStageProposal,
  customizePipelineStages,
  proposePipelineStages,
} from '../packages/pipelines/space-stages.js';

/**
 * BO-F2-02 (backoffice roadmap "06 Pipeline"): per-space stage customization
 * against the 5 closed types, delete-only-if-empty, AI suggestion as a
 * proposal until a person confirms. The base definition below stays a valid
 * code-first definition; space overrides never mutate it.
 */

function basePipeline() {
  return {
    pipelineContract: 1,
    name: 'b2b-sales',
    label: 'B2B Sales',
    module: 'opportunity',
    defaultStage: 'info',
    stages: [
      { key: 'info', label: 'Info', order: 10, type: 'open', probability: 10 },
      { key: 'trial', label: 'Trial', order: 20, type: 'open', probability: 30 },
      { key: 'won', label: 'Won', order: 40, type: 'won', probability: 100 },
      { key: 'paid', label: 'Paid', order: 50, type: 'paid', probability: 100 },
      { key: 'lost', label: 'Lost', order: 60, type: 'lost', probability: 0 },
      { key: 'renewal', label: 'Renewal', order: 70, type: 'renewal', probability: 20 },
    ],
  };
}

const SPACE = 'space-presti';

// Acceptance: types are closed to the 5 of the prototype.
test('stage types are closed to open/won/paid/lost/renewal', () => {
  assert.deepEqual([...PIPELINE_STAGE_TYPES], ['open', 'won', 'paid', 'lost', 'renewal']);
  assert.ok(Object.isFrozen(PIPELINE_STAGE_TYPES));
  assert.doesNotThrow(() => validatePipelineDefinition(basePipeline(), { moduleExists: () => true }));
  const sixth = basePipeline();
  sixth.stages = [...sixth.stages, { key: 'extra', order: 80, type: 'archived', probability: 0 }];
  assert.throws(
    () => validatePipelineDefinition(sixth, { moduleExists: () => true }),
    /type must be one of: open, won, paid, lost, renewal/,
  );
});

test('paid behaves like a terminal positive outcome, renewal like a working state', () => {
  const badPaid = basePipeline();
  badPaid.stages = badPaid.stages.map((s) => (s.key === 'paid' ? { ...s, probability: 90 } : s));
  assert.throws(
    () => validatePipelineDefinition(badPaid, { moduleExists: () => true }),
    /the paid stage must have probability 100/,
  );
  const twoPaid = basePipeline();
  twoPaid.stages = [...twoPaid.stages, { key: 'paid2', order: 80, type: 'paid', probability: 100 }];
  assert.throws(
    () => validatePipelineDefinition(twoPaid, { moduleExists: () => true }),
    /at most one paid stage/,
  );
  const renewalDefault = basePipeline();
  renewalDefault.defaultStage = 'renewal';
  assert.throws(
    () => validatePipelineDefinition(renewalDefault, { moduleExists: () => true }),
    /defaultStage must be an open stage/,
  );
});

// Acceptance: deleting a stage that contains offers is refused with a reason.
test('removing a stage with offers is refused with the reason and the count', () => {
  const base = basePipeline();
  assert.throws(
    () => customizePipelineStages(base, { remove: ['trial'] }, { spaceId: SPACE, offerCounts: { trial: 2 } }),
    (error) => {
      assert.equal(error.code, 'STAGE_NOT_EMPTY');
      assert.equal(error.status, 409);
      assert.match(error.message, /still contains 2 offers/);
      assert.match(error.message, /move or close them first/);
      assert.deepEqual(error.details, {
        spaceId: SPACE, pipeline: 'b2b-sales', stage: 'trial', offerCount: 2,
      });
      return true;
    },
  );
  // The base is untouched and the refusal leaves the configuration unchanged.
  assert.equal(base.stages.length, 6);
});

test('removing an empty stage works; the default cannot vanish silently', () => {
  const removed = customizePipelineStages(basePipeline(), { remove: ['renewal'] }, { spaceId: SPACE });
  assert.deepEqual(removed.stages.map((s) => s.key), ['info', 'trial', 'won', 'paid', 'lost']);
  assert.throws(
    () => customizePipelineStages(basePipeline(), { remove: ['info'] }, { spaceId: SPACE }),
    /previous default was removed, name its replacement/,
  );
  const moved = customizePipelineStages(
    basePipeline(),
    { remove: ['info'], defaultStage: 'trial' },
    { spaceId: SPACE },
  );
  assert.equal(moved.defaultStage, 'trial');
});

test('rename, reorder, recolor, retype and add validate like code-first stages', () => {
  const customized = customizePipelineStages(
    basePipeline(),
    {
      rename: { trial: 'Sopralluogo' },
      reorder: { trial: 15 },
      recolor: { trial: '#ff8800', info: '#f80' },
      retype: { renewal: 'open' },
      add: [{ key: 'preventivo', label: 'Preventivo', order: 25, type: 'open', probability: 40 }],
    },
    { spaceId: SPACE },
  );
  assert.equal(customized.spaceId, SPACE);
  assert.equal(customized.pipeline, 'b2b-sales');
  const trial = customized.stages.find((s) => s.key === 'trial');
  assert.equal(trial.label, 'Sopralluogo');
  assert.equal(trial.order, 15);
  assert.equal(trial.color, '#ff8800');
  assert.deepEqual(customized.stages.map((s) => s.key), ['info', 'trial', 'preventivo', 'won', 'paid', 'lost', 'renewal']);
  assert.ok(Object.isFrozen(customized));
  assert.ok(Object.isFrozen(customized.stages));

  assert.throws(
    () => customizePipelineStages(basePipeline(), { rename: { ghost: 'X' } }, { spaceId: SPACE }),
    /targets unknown stage "ghost"/,
  );
  assert.throws(
    () => customizePipelineStages(basePipeline(), { recolor: { trial: 'red' } }, { spaceId: SPACE }),
    /color must be a hex color/,
  );
  assert.throws(
    () => customizePipelineStages(basePipeline(), { retype: { trial: 'archived' } }, { spaceId: SPACE }),
    /type must be one of: open, won, paid, lost, renewal/,
  );
  // Retyping onto a terminal type without terminal probability fails closed.
  assert.throws(
    () => customizePipelineStages(basePipeline(), { retype: { trial: 'paid' } }, { spaceId: SPACE }),
    /the paid stage must have probability 100/,
  );
  assert.throws(
    () => customizePipelineStages(basePipeline(), { reorder: { trial: 10 } }, { spaceId: SPACE }),
    /duplicate stage order/,
  );
  assert.throws(
    () => customizePipelineStages(basePipeline(), { add: [{ key: 'trial', order: 99, type: 'open', probability: 1 }] }, { spaceId: SPACE }),
    /duplicate stage key "trial"/,
  );
  assert.throws(
    () => customizePipelineStages(basePipeline(), {}, { spaceId: '' }),
    /spaceId must be a non-empty string/,
  );
});

// Acceptance: the AI suggestion stays a proposal until a person confirms.
test('an AI stage suggestion is a proposal and changes nothing by itself', () => {
  const base = basePipeline();
  const candidate = [
    ...base.stages.slice(0, 2),
    { key: 'sopralluogo', label: 'Sopralluogo', order: 22, type: 'open', probability: 35 },
    { key: 'preventivo', label: 'Preventivo', order: 24, type: 'open', probability: 45 },
    ...base.stages.slice(2),
  ];
  const proposal = proposePipelineStages({
    spaceId: SPACE,
    baseDefinition: base,
    candidateStages: candidate,
    proposedBy: { type: 'ai', id: 'stage-suggester' },
    evidence: ['trial notes mention site visits before quoting'],
  });
  assert.equal(proposal.status, 'proposed');
  assert.equal(proposal.decidedBy, null);
  assert.deepEqual(proposal.stages.map((s) => s.key),
    ['info', 'trial', 'sopralluogo', 'preventivo', 'won', 'paid', 'lost', 'renewal']);
  // Nothing was applied: the base still has its six stages.
  assert.equal(base.stages.length, 6);
  assert.ok(!base.stages.some((s) => s.key === 'sopralluogo'));
});

test('only a person can confirm a stage proposal, with a reason on reject', () => {
  const args = {
    spaceId: SPACE,
    baseDefinition: basePipeline(),
    candidateStages: [...basePipeline().stages],
    proposedBy: { type: 'ai', id: 'stage-suggester' },
    evidence: ['keep the current stages'],
  };
  assert.throws(
    () => confirmStageProposal(proposePipelineStages(args), { decision: 'accept' }),
    /requires an actor/,
  );
  assert.throws(
    () => confirmStageProposal(
      proposePipelineStages(args),
      { actor: { type: 'ai', id: 'stage-suggester' }, decision: 'accept' },
    ),
    (error) => {
      assert.equal(error.code, 'FORBIDDEN');
      assert.match(error.message, /only a person can confirm/);
      return true;
    },
  );
  const accepted = confirmStageProposal(
    proposePipelineStages(args),
    { actor: { type: 'user', id: 'titolare' }, decision: 'accept' },
  );
  assert.equal(accepted.proposal.status, 'confirmed');
  assert.deepEqual(accepted.proposal.decidedBy, { type: 'user', id: 'titolare' });
  assert.ok(Array.isArray(accepted.stages));

  assert.throws(
    () => confirmStageProposal(
      proposePipelineStages(args),
      { actor: { type: 'user', id: 'titolare' }, decision: 'reject' },
    ),
    /rejecting a stage proposal requires a reason/,
  );
  const rejected = confirmStageProposal(
    proposePipelineStages(args),
    { actor: { type: 'user', id: 'titolare' }, decision: 'reject', reason: 'we quote without visits' },
  );
  assert.equal(rejected.proposal.status, 'rejected');
  assert.equal(rejected.stages, null);

  assert.throws(
    () => confirmStageProposal(accepted.proposal, { actor: { type: 'user', id: 'x' }, decision: 'accept' }),
    (error) => {
      assert.equal(error.code, 'PROPOSAL_ALREADY_DECIDED');
      return true;
    },
  );
});

// move-stage coherence for the two new types.
function moveHarness(pipeline) {
  const action = buildMoveStageAction({ module: 'opportunity' });
  return (record, input) => action.execute({
    record,
    input,
    managed: async (id, patch) => ({ ...record, ...patch }),
    pipelines: { forModule: () => pipeline },
    step: () => {},
    now: () => '2026-10-20T15:00:00.000Z',
  });
}

test('move-stage: paid closes like won, renewal works like open', async () => {
  const pipeline = basePipeline();
  const move = moveHarness(pipeline);
  const open = { id: 'o1', pipelineKey: 'b2b-sales', pipelineStage: 'trial', closedAt: null, closeReason: null };

  const toPaid = await move(open, { toStage: 'paid' });
  assert.equal(toPaid.to, 'paid');
  assert.equal(toPaid.record.closedAt, '2026-10-20T15:00:00.000Z');
  assert.equal(toPaid.record.closeReason, null);

  const corrupt = { ...open, pipelineStage: 'trial', closedAt: '2020-01-01T00:00:00.000Z', closeReason: 'stale' };
  const toRenewal = await move(corrupt, { toStage: 'renewal' });
  assert.equal(toRenewal.record.closedAt, null);
  assert.equal(toRenewal.record.closeReason, null);

  await assert.rejects(
    move({ ...open, pipelineStage: 'paid', closedAt: '2026-10-20T15:00:00.000Z' }, { toStage: 'trial' }),
    (error) => {
      assert.equal(error.code, 'TERMINAL_STAGE');
      return true;
    },
  );
  const outOfRenewal = await move({ ...open, pipelineStage: 'renewal' }, { toStage: 'trial' });
  assert.equal(outOfRenewal.to, 'trial');

  await assert.rejects(
    move(open, { toStage: 'lost' }),
    /reason is required when moving to the lost stage/,
  );
});
