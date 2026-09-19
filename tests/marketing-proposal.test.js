import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reviewProposal, approveProposal, REQUIRED_PROPOSAL_SECTIONS,
} from '../packages/marketing/src/proposal.js';
import { buildProposeAction, buildApproveAction } from '../packages/marketing/src/actions.js';
import { MarketingRegistries } from '../packages/marketing/src/policy.js';

/**
 * MK1 acceptance, first clause: a proposal states audience, exclusions,
 * channel, provider rationale, content plan, tracking plan, risks and required
 * approvals — or it is refused.
 */

const COMPLETE = {
  id: 'prop-1',
  title: 'Win back dormant trial teams',
  mode: 'one-shot',
  status: 'proposed',
  audienceJson: JSON.stringify({ rule: 'trial teams dormant 30d', estimate: 1200 }),
  exclusionsJson: JSON.stringify(['unsubscribed', 'frequency cap hit']),
  channel: 'email',
  providerRationale: 'Resend, because this is bulk-shaped under 5k recipients and the sandbox is configured.',
  contentPlanJson: JSON.stringify({ subject: 'Your trial, resumed', blocks: ['recap', 'cta'] }),
  trackingPlanJson: JSON.stringify({ utm: 'mk1-winback', events: ['trial_resumed'] }),
  risksJson: JSON.stringify(['low open rate on dormant cohorts']),
  requiredApprovalsJson: JSON.stringify(['audience', 'content', 'channel']),
};

const POLICY = { name: 'standard-proposal', version: 1, label: 'Standard', config: {} };
const FINGERPRINT = 'f'.repeat(64);

function registries() {
  return new MarketingRegistries({ proposalPolicies: [POLICY] });
}

/** Minimal action context over stub storage. */
function actionContext(proposal, options = {}) {
  const actor = 'actor' in options ? options.actor : { type: 'user', id: 'ada' };
  const patches = [];
  const created = [];
  const versions = [];
  const modules = {
    get(name) {
      if (name === 'campaign-version') {
        return {
          service: {
            listWhere: (where) => versions.filter((row) => row.proposalId === where.proposalId),
            createManaged: async (row) => {
              const stored = { ...row, id: `ver-${versions.length + 1}` };
              versions.push(stored);
              created.push(stored);
              return stored;
            },
          },
        };
      }
      throw new Error(`unexpected module ${name}`);
    },
  };
  return {
    ctx: {
      record: proposal,
      input: { policy: POLICY.name, policyVersion: POLICY.version },
      actor,
      modules,
      managed: async (id, patch) => {
        patches.push({ id, patch });
        Object.assign(proposal, patch);
        return proposal;
      },
      domains: {
        getPolicy: (pkg, kind, name, version) => {
          assert.equal(pkg, 'marketing');
          assert.equal(kind, 'proposal-policy');
          return registries().getProposalPolicy(name, version);
        },
      },
      now: () => '2026-09-19T09:00:00.000Z',
      step: () => {},
    },
    patches, created,
  };
}

test('the acceptance sections are exactly the eight the milestone names', () => {
  assert.deepEqual(REQUIRED_PROPOSAL_SECTIONS.map((entry) => entry.section), [
    'audience', 'exclusions', 'channel', 'providerRationale',
    'contentPlan', 'trackingPlan', 'risks', 'requiredApprovals',
  ]);
});

test('a complete draft reviews complete', () => {
  assert.deepEqual(reviewProposal(COMPLETE), { complete: true, missing: [] });
});

test('an incomplete draft names every missing section, and nothing else', () => {
  const review = reviewProposal({ ...COMPLETE, exclusionsJson: '', risksJson: null, channel: 'carrier-pigeon' });
  assert.equal(review.complete, false);
  assert.deepEqual([...review.missing].sort(), ['channel', 'exclusions', 'risks']);
});

test('a closed channel and a closed mode keep the proposal honest', () => {
  assert.ok(reviewProposal({ ...COMPLETE, channel: 'sms' }).complete);
  assert.deepEqual(reviewProposal({ ...COMPLETE, mode: 'journey' }).missing, []);
  assert.ok(reviewProposal({ ...COMPLETE, mode: 'telepathy' }).missing.includes('mode'));
  assert.ok(reviewProposal({ ...COMPLETE, title: '  ' }).missing.includes('title'));
});

test('a policy narrows the vocabulary: a channel it forbids is missing', () => {
  const review = reviewProposal(COMPLETE, { allowedChannels: ['sms'] });
  assert.equal(review.complete, false);
  assert.deepEqual([...review.missing], ['channel']);
});

test('propose records the refusal with its reasons instead of erroring', async () => {
  const proposal = { ...COMPLETE, status: 'draft', channel: '' };
  const { ctx, patches } = actionContext(proposal);
  const result = await buildProposeAction(registries()).execute(ctx);
  assert.equal(result.refused, true);
  assert.deepEqual(result.missing, ['channel']);
  assert.equal(patches.length, 1);
  assert.equal(patches[0].patch.status, 'refused');
  assert.deepEqual(JSON.parse(patches[0].patch.refusalReasonsJson), ['channel']);
});

test('propose promotes a complete draft and clears a stale refusal', async () => {
  const proposal = { ...COMPLETE, status: 'refused', refusalReasonsJson: '["risks"]' };
  const { ctx, patches } = actionContext(proposal);
  const result = await buildProposeAction(registries()).execute(ctx);
  assert.equal(result.refused, false);
  assert.equal(patches[0].patch.status, 'proposed');
  assert.equal(patches[0].patch.refusalReasonsJson, null);
  assert.equal(patches[0].patch.policyName, POLICY.name);
});

test('approve refuses a non-human actor before anything else', async () => {
  const proposal = { ...COMPLETE };
  for (const actor of [{ type: 'agent', id: 'coder' }, { type: 'system' }, null, undefined]) {
    const { ctx } = actionContext(proposal, { actor });
    await assert.rejects(
      () => buildApproveAction(registries()).execute(ctx),
      (error) => error.code === 'HUMAN_APPROVAL_REQUIRED' && error.status === 403,
      `actor ${JSON.stringify(actor)}`,
    );
  }
  // The refusal happened before any write: the draft is untouched.
  assert.equal(proposal.status, 'proposed');
});

test('approve refuses a draft that was never proposed, and a stale one', async () => {
  const fingerprint = registries().getProposalPolicy(POLICY.name, POLICY.version).fingerprint;
  for (const status of ['draft', 'refused', 'approved']) {
    const { ctx } = actionContext({
      ...COMPLETE, status,
      policyName: POLICY.name, policyVersion: POLICY.version, policyFingerprint: fingerprint,
    });
    await assert.rejects(
      () => buildApproveAction(registries()).execute(ctx),
      (error) => error.code === 'PROPOSAL_STATE_INVALID' && error.status === 409,
      `status ${status}`,
    );
  }
});

test('approve refuses a proposal the policy drifted under since review', async () => {
  const proposal = {
    ...COMPLETE, policyName: 'standard-proposal', policyVersion: 1, policyFingerprint: '0'.repeat(64),
  };
  const { ctx } = actionContext(proposal);
  await assert.rejects(
    () => buildApproveAction(registries()).execute(ctx),
    (error) => error.code === 'PROPOSAL_POLICY_CHANGED' && error.status === 409,
    'policy drift',
  );
});

test('a human approval creates the immutable version and stamps the proposal', async () => {
  const proposal = {
    ...COMPLETE,
    policyName: POLICY.name, policyVersion: POLICY.version,
    policyFingerprint: registries().getProposalPolicy(POLICY.name, POLICY.version).fingerprint,
  };
  const { ctx, patches, created } = actionContext(proposal);
  const result = await buildApproveAction(registries()).execute(ctx);
  assert.equal(result.versionNumber, 1);
  assert.equal(created.length, 1);
  assert.equal(created[0].proposalId, 'prop-1');
  assert.equal(created[0].approvedBy, 'ada');
  assert.equal(created[0].policyName, POLICY.name);
  const snapshot = JSON.parse(created[0].snapshotJson);
  assert.equal(snapshot.channel, 'email');
  assert.equal(snapshot.providerRationale, COMPLETE.providerRationale);
  assert.equal(patches[0].patch.status, 'approved');
  assert.equal(patches[0].patch.decidedBy, 'ada');
  assert.equal(result.versionId, created[0].id);
});

test('approveProposal answers the version row data without writing', () => {
  const { version, proposalPatch } = approveProposal({
    proposal: { ...COMPLETE },
    actor: { type: 'user', id: 'ada' },
    approvedAt: '2026-09-19T09:00:00.000Z',
    policy: { name: POLICY.name, version: POLICY.version, fingerprint: FINGERPRINT },
    versionNumber: 2,
  });
  assert.equal(version.versionNumber, 2);
  assert.equal(version.proposalId, 'prop-1');
  assert.equal(proposalPatch.status, 'approved');
  assert.ok(Object.isFrozen(version));
});
