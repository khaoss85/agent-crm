// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DEPOSIT_BPS,
  DEFAULT_OFFER_SEND_THRESHOLD_CENTS,
  OFFER_SEND_GATE,
  OFFER_SEND_GATE_VERSION,
  OWNER_ROLE,
  authorizeOfferSend,
  computeDepositCents,
  createOfferSendPolicy,
  evaluateOfferAmount,
} from '../packages/pipelines/offer-send-gate.js';
import { createFixtureStripeAdapter } from '../packages/payments/src/stripe.js';

/**
 * BO-F2-06 — sopra 20.000 € serve l'ok della titolare, poi invio sul
 * canale preferito + link Stripe per l'acconto (30%).
 *
 * Owner decision Q-C2: the titolare is a role assigned per space
 * (`owner`); threshold and deposit share are per-space config. The gate
 * below is deterministic: above the threshold nothing sends and no link
 * is minted without a registered approval decided by the owner role
 * (`packages/modules/approval` row with `status: approved`). The deposit
 * link travels the existing payments adapter (here the fixture Stripe
 * adapter — no credentials exist yet); the send itself stays the
 * channels reply path on the preferred channel, which this gate
 * authorizes but does not duplicate.
 */

const OWNER_APPROVAL = Object.freeze({ status: 'approved', decidedBy: 'titolare-1' });
const PENDING_APPROVAL = Object.freeze({ status: 'pending', decidedBy: null });

// Identity, defaults, config validation (per-space configurability).
test('offer send gate: identity, defaults and per-space config validation', () => {
  const policy = createOfferSendPolicy();
  assert.equal(policy.name, OFFER_SEND_GATE, 'the rule set has its shipped name');
  assert.equal(policy.version, OFFER_SEND_GATE_VERSION, 'the rule set is versioned');
  assert.deepEqual(
    policy.config,
    { thresholdCents: 2_000_000, depositBps: 3000, requiredRole: 'owner' },
    'sane defaults: 20.000 € threshold, 30% deposit, titolare as owner',
  );
  assert.equal(DEFAULT_OFFER_SEND_THRESHOLD_CENTS, 2_000_000, 'the default threshold is 20.000 €');
  assert.equal(DEFAULT_DEPOSIT_BPS, 3000, 'the default deposit is 30%');
  assert.equal(OWNER_ROLE, 'owner', 'the titolare is the owner space role');

  const custom = createOfferSendPolicy({ thresholdCents: 5_000_00, depositBps: 2000 });
  assert.equal(custom.config.thresholdCents, 500_000, 'the threshold is per-space config');
  assert.equal(custom.config.depositBps, 2000, 'the deposit share is per-space config');
  assert.equal(typeof custom.evaluate, 'function', 'the definition carries its evaluation');

  for (const bad of [
    { thresholdCents: 0 },
    { thresholdCents: -100 },
    { thresholdCents: 10.5 },
    { thresholdCents: 1_000_000_000_001 },
    { depositBps: 0 },
    { depositBps: 10_001 },
    { depositBps: 12.5 },
    { requiredRole: '' },
    { requiredRole: '   ' },
    { requiredRole: '__proto__' },
    { requiredRole: 42 },
  ]) {
    assert.throws(() => createOfferSendPolicy(bad), /./, `refused config ${JSON.stringify(bad)}`);
  }
});

// Threshold rule: at or below, no approval; above, approval required.
test('offer send gate: within threshold sends, above needs the titolare', () => {
  assert.equal(evaluateOfferAmount({ amountCents: 0 }).decision, 'send', 'zero sends');
  assert.equal(
    evaluateOfferAmount({ amountCents: DEFAULT_OFFER_SEND_THRESHOLD_CENTS }).decision,
    'send',
    'exactly 20.000 € sends: the boundary is inclusive',
  );
  const over = evaluateOfferAmount({ amountCents: DEFAULT_OFFER_SEND_THRESHOLD_CENTS + 1 });
  assert.equal(over.decision, 'approval_required', 'one cent over needs the titolare');
  assert.equal(over.matchedRule, 'above-threshold', 'the band is named');
  assert.match(over.reason, /titolare|owner/i, 'the reason says who must approve');
});

// Above threshold: no send and no link without a registered approval.
test('offer send gate: above threshold no send and no link without approval', async () => {
  const fixture = createFixtureStripeAdapter({ secret: 'gate-secret-1' });
  for (const approval of [null, undefined, PENDING_APPROVAL, { status: 'rejected', decidedBy: 'titolare-1' }]) {
    const verdict = authorizeOfferSend({ amountCents: 2_500_000, approval, approverRole: 'owner' });
    assert.equal(verdict.sendAllowed, false, 'no send without a registered owner approval');
    assert.equal(verdict.linkAllowed, false, 'no deposit link either: one verdict for both');
    assert.equal(verdict.depositCents, 0, 'no amount to mint while blocked');
  }
  assert.equal(
    fixture.api.state.createCalls, 0,
    'the caller mints nothing while the gate refuses: no fixture checkout exists',
  );
});

// Per-space config moves the boundary and the deposit share.
test('offer send gate: threshold and deposit are per-space config', () => {
  const policy = { thresholdCents: 500_000, depositBps: 2000, requiredRole: 'owner' };
  const below = authorizeOfferSend({ amountCents: 500_000, policy });
  assert.equal(below.sendAllowed, true, 'custom threshold holds at its boundary');
  const above = authorizeOfferSend({ amountCents: 500_001, policy, approval: OWNER_APPROVAL, approverRole: 'owner' });
  assert.equal(above.sendAllowed, true, 'owner approval releases under custom config');
  assert.equal(above.depositCents, 100_000, '20% of 500.001 € rounds to 100.000c');
  assert.equal(above.depositBps, 2000, 'the verdict carries the space share');
});

// Space without titolare: blocked with its reason.
test('offer send gate: a space without titolare blocks with its reason', () => {
  const verdict = authorizeOfferSend({
    amountCents: 2_500_000,
    approval: OWNER_APPROVAL,
    approverRole: 'owner',
    spaceHasOwner: false,
  });
  assert.equal(verdict.sendAllowed, false, 'no owner in the space: nothing sends');
  assert.equal(verdict.linkAllowed, false, 'and no deposit link either');
  assert.equal(verdict.matchedRule, 'blocked-no-owner', 'the block is named');
  assert.match(verdict.reason, /owner/, 'the reason names the missing role');

  // Below the threshold the missing owner changes nothing: no approval needed.
  const small = authorizeOfferSend({ amountCents: 100_000, spaceHasOwner: false });
  assert.equal(small.sendAllowed, true, 'small offers do not need a titolare');
});

// Only the owner role releases: operator/observer approvals refuse.
test('offer send gate: only the titolare releases, other roles refuse', () => {
  for (const role of ['operator', 'observer', '', null, undefined]) {
    const verdict = authorizeOfferSend({
      amountCents: 2_500_000, approval: OWNER_APPROVAL, approverRole: role,
    });
    assert.equal(verdict.sendAllowed, false, `role ${JSON.stringify(role)} never releases`);
    assert.equal(verdict.linkAllowed, false, 'the link stays closed too');
    assert.equal(verdict.matchedRule, 'approver-not-owner', 'the refusal names its cause');
  }
});

// Owner approval releases: deposit computed, fixture link minted after the ok.
test('offer send gate: owner ok releases the send and the deposit link (fixture adapter)', async () => {
  const secret = 'gate-secret-2';
  const fixture = createFixtureStripeAdapter({ secret });
  const verdict = authorizeOfferSend({
    amountCents: 2_500_000, approval: OWNER_APPROVAL, approverRole: 'owner',
  });
  assert.equal(verdict.sendAllowed, true, 'registered owner approval releases the send');
  assert.equal(verdict.linkAllowed, true, 'and the deposit link with it');
  assert.equal(verdict.matchedRule, 'approved-by-owner', 'the release is named');
  assert.equal(verdict.depositCents, 750_000, '30% of 25.000 € is 7.500 €');
  assert.match(verdict.reason, /750|30|deposit/i, 'the reason carries the deposit terms');

  // The caller mints the deposit link only now, through the payments
  // adapter — the fixture stands in for Stripe until credentials exist.
  const minted = await fixture.definition.createPayment({
    amount: verdict.depositCents, currency: 'EUR', intentKey: 'bo-f2-06:offer-1', secret,
  });
  assert.match(minted.url, /^https:\/\//, 'the deposit link is a URL');
  assert.ok(minted.providerRef.length > 0, 'the checkout carries its reference');
  assert.equal(fixture.api.state.createCalls, 1, 'exactly one checkout minted, after the ok');
});

// Deposit math and hostile input: deterministic, fail-closed.
test('offer send gate: deposit math is deterministic and bad input refuses', () => {
  assert.equal(computeDepositCents(2_000_000), 600_000, '30% of the threshold');
  assert.equal(computeDepositCents(1, 3000), 0, 'sub-cent rounds down, never up');
  assert.equal(computeDepositCents(100_000, 10_000), 100_000, '100% is the whole amount');
  for (const bad of [-1, 10.5, Number.NaN, '2500000', null, undefined]) {
    assert.throws(() => authorizeOfferSend({ amountCents: bad }), /amountCents/, `refused amount ${String(bad)}`);
    assert.throws(() => computeDepositCents(bad), /amountCents/, `refused deposit amount ${String(bad)}`);
  }
  assert.throws(() => authorizeOfferSend({ amountCents: 2_500_000, policy: { thresholdCents: -5 } }), /thresholdCents/);
  assert.throws(() => authorizeOfferSend({ amountCents: 2_500_000, policy: 'x' }), /policy/);
  assert.throws(() => authorizeOfferSend(null), /argument/, 'no argument object refuses');
  assert.throws(() => createOfferSendPolicy(null), /config/, 'no config object refuses');
});
