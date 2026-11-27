import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * Lifecycle-renewal operations e2e, second shard (voce f268787b540c): split
 * out of `tests/lifecycle-renewal-operations-e2e.test.js` so each file stays
 * under the per-file ceiling (`MEASURE_FILE_MAX_SEC`, 600 s) even with the
 * server loaded. Same cases, same assertions — only the file layout changed.
 */

const ACTOR = { type: 'user', id: 'e2e' };

const setup = async (t, file, options = {}) => {
  const root = project(t, { withLifecycle: true, ...options });
  const context = await boot(root, join(root, 'data', file));
  t.after(() => context.close());
  return { root, context };
};

const run = (app, module, action, recordId, input, actor = ACTOR) =>
  app.runAction({ module, action, recordId, input, actor });

test('a follow-up key is a round number, so resolved work can come round again', async (t) => {
  const { root, context } = await setup(t, 'rounds.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'Rounds Deal' });

  // Regression: the key used to embed `now()`. Under the injected clock every
  // test and every deterministic deployment runs at one instant, so round two
  // collided with round one and was refused 409 for all time — contradicting
  // this package's own documented rule. Under a wall clock the key changed on
  // every call instead, so it identified nothing and guarded nothing.
  const first = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'first ask' });
  assert.equal(first.result.sourceKey, `commercial-followup:${contract.id}:renewal:1`);
  assert.equal(first.result.status, 'pending_commercial_followup');

  // The open ask IS the identity of the current ask, so an identical repeat
  // replays it rather than telling a client with a lost response that nothing
  // happened. Regression: this was a bare 409 with no path back to the record.
  const replayed = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'first ask' });
  assert.equal(replayed.result.id, first.result.id);
  assert.deepEqual(replayed.result, first.result);

  // A DIFFERENT ask while one is open is refused, with the field named.
  await assert.rejects(
    () => run(app, 'commercial-contract', 'request-commercial-followup', contract.id, { intent: 'renewal', summary: 'again' }),
    (error) => error.code === 'FOLLOWUP_ALREADY_PENDING' && error.status === 409
      && error.details.conflictingFields.join() === 'summary'
      && error.details.existingId === first.result.id,
  );
  // Citing a decision that the open ask does not cite is also a different ask.
  const decision = (await run(app, 'commercial-contract', 'record-renewal-decision', contract.id,
    { decision: 'pursue_renewal', reason: 'worth keeping', asOf: '2027-08-01' })).result;
  await assert.rejects(
    () => run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
      { intent: 'renewal', summary: 'first ask', decisionId: decision.id }),
    (error) => error.details.conflictingFields.join() === 'decisionId',
  );

  // A different intent is a different ask, and is allowed alongside it.
  const expansion = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'expansion', summary: 'more seats' });
  assert.equal(expansion.result.sourceKey, `commercial-followup:${contract.id}:expansion:1`);

  await run(app, 'commercial-followup', 'resolve-commercial-followup', first.result.id,
    { outcome: 'resolved_externally', reason: 'quote issued elsewhere' });
  // The documented rule for new work: once the previous ask reached a terminal
  // state, the next request opens a new round. Legitimate repeated future work
  // is never collapsed into the ask that already closed.
  const second = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'it came round again' });
  assert.equal(second.result.sourceKey, `commercial-followup:${contract.id}:renewal:2`,
    'the round number advances; the clock is not consulted');
  assert.equal(second.result.status, 'pending_commercial_followup');
  assert.notEqual(second.result.id, first.result.id, 'round two is its own record, not a replay of round one');
  // Round two replays on its own terms, and the closed round one stays closed.
  assert.equal((await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'it came round again' })).result.id, second.result.id);
  assert.equal(app.modules.get('commercial-followup').service.get(first.result.id).status, 'resolved_externally');
  // A withdrawn round also releases the intent for genuinely new work.
  await run(app, 'commercial-followup', 'resolve-commercial-followup', second.result.id,
    { outcome: 'withdrawn', reason: 'not this year after all' });
  const third = await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
    { intent: 'renewal', summary: 'and again the year after' });
  assert.equal(third.result.sourceKey, `commercial-followup:${contract.id}:renewal:3`);
  assert.equal(app.modules.get('commercial-followup').service
    .listWhere({ contractId: contract.id, intent: 'renewal' }).length, 3,
    'three rounds, three rows: repeated future work is evidence, not duplication');
});

test('the follow-up state model is an explicit table: terminal never regresses', async (t) => {
  const { root, context } = await setup(t, 'states.sqlite');
  const { app } = context;
  const { contract } = await activatedContract(root, app, { name: 'States Deal' });

  for (const [intent, outcome] of [['renewal', 'resolved_externally'], ['expansion', 'withdrawn']]) {
    const followup = (await run(app, 'commercial-contract', 'request-commercial-followup', contract.id,
      { intent, summary: `ask about ${intent}` })).result;
    const resolved = (await run(app, 'commercial-followup', 'resolve-commercial-followup', followup.id,
      { outcome, reason: 'a human said why' })).result;
    assert.equal(resolved.status, outcome, 'both terminal states are reachable — no dead end');
    assert.equal(resolved.resolvedBy, 'e2e');
    assert.equal(resolved.resolutionReason, 'a human said why');

    // Contradictory input after the fact is refused with the state named, and
    // changes nothing: a terminal state never regresses, not even sideways.
    for (const contradiction of ['resolved_externally', 'withdrawn']) {
      await assert.rejects(
        () => run(app, 'commercial-followup', 'resolve-commercial-followup', followup.id,
          { outcome: contradiction, reason: 'no' }),
        (error) => error.status === 409 && String(error.message).includes(outcome),
      );
    }
    const after = app.modules.get('commercial-followup').service.get(followup.id);
    assert.equal(after.status, outcome);
    assert.equal(after.resolutionReason, 'a human said why');
  }
});

test('money evidence keeps every dimension that distinguishes one ask from another', async (t) => {
  const { root, context } = await setup(t, 'money.sqlite');
  const { app } = context;

  // A baseline that collapses to exactly one kind of money: the amount travels,
  // and it travels with the recurrence that gives it meaning.
  const mono = await activatedContract(root, app, { name: 'Mono Deal', offers: ['fixture:offer:api-monthly'] });
  const single = (await run(app, 'commercial-contract', 'request-commercial-followup', mono.contract.id,
    { intent: 'renewal', summary: 'one kind of money' })).result;
  assert.equal(single.currency, 'EUR');
  assert.ok(Number.isSafeInteger(single.baselineNetAmountCents) && single.baselineNetAmountCents > 0);
  // Regression: the row used to carry a bare amount. "EUR 171.00" is not a
  // fact — monthly, quarterly, annually and once are four different asks, and
  // this row is what Commercial reads.
  assert.equal(single.baselineChargeType, 'recurring');
  assert.equal(single.baselineInterval, 'month');
  assert.equal(single.baselineIntervalCount, 1, 'monthly is month x 1; quarterly would be month x 3');
  assert.equal(single.baselineGroupCount, 1);
  assert.deepEqual(JSON.parse(single.baselineGroupsJson), [{
    currency: 'EUR', chargeType: 'recurring', interval: 'month', intervalCount: 1,
    lineCount: 1, netAmountCents: single.baselineNetAmountCents,
  }], 'the grouped evidence and the scalar summary say the same thing');

  // A mixed baseline: no scalar amount, because there is no single kind of
  // money — but the evidence is grouped and kept, not thrown away with it.
  const mixed = await activatedContract(root, app, { name: 'Mixed Deal' });
  const many = (await run(app, 'commercial-contract', 'request-commercial-followup', mixed.contract.id,
    { intent: 'renewal', summary: 'several kinds of money' })).result;
  assert.equal(many.baselineNetAmountCents, null, 'no grand total across recurrences');
  assert.equal(many.baselineChargeType, null);
  assert.equal(many.baselineInterval, null);
  assert.equal(many.baselineIntervalCount, null);
  assert.equal(many.currency, 'EUR', 'a single shared currency is still honest to state');

  const groups = JSON.parse(many.baselineGroupsJson);
  assert.equal(many.baselineGroupCount, groups.length);
  assert.ok(groups.length > 1, 'the mixed baseline really is mixed');
  // Regression: a mixed baseline used to store three nulls and nothing else, so
  // the money evidence a renewal conversation starts from disappeared exactly
  // when there was most of it.
  const plan = await run(app, 'commercial-contract', 'plan-renewal', mixed.contract.id, { asOf: '2027-08-01' });
  assert.deepEqual(groups, plan.result.baseline.groups.map((group) => ({
    currency: group.currency, chargeType: group.chargeType, interval: group.interval,
    intervalCount: group.intervalCount, lineCount: group.lineCount, netAmountCents: group.netAmountCents,
  })), 'the stored evidence is exactly what the read-only plan computes');

  // No total anywhere: not across recurrence, not across currency.
  const grand = groups.reduce((sum, group) => sum + group.netAmountCents, 0);
  assert.equal(groups.some((group) => group.netAmountCents === grand), false);
  assert.equal(many.baselineNetAmountCents, null);

  // An annual EUR 1,200 and a one-time EUR 1,200 are the case the defect named:
  // they must not be byte-identical rows. Both are built here from real lines.
  const followups = app.modules.get('commercial-followup').service;
  const seen = new Map();
  for (const [name, offers] of [['Annual Deal', ['fixture:offer:support-annual']], ['Once Deal', ['fixture:offer:enterprise']]]) {
    const built = await activatedContract(root, app, { name, offers });
    const row = (await run(app, 'commercial-contract', 'request-commercial-followup', built.contract.id,
      { intent: 'renewal', summary: 'one kind of money' })).result;
    const shape = ['currency', 'baselineNetAmountCents', 'baselineChargeType', 'baselineInterval',
      'baselineIntervalCount', 'baselineGroupsJson'].map((field) => row[field]).join('|');
    seen.set(name, shape);
    assert.equal(followups.get(row.id).baselineGroupsJson, row.baselineGroupsJson, 'and it survives a re-read');
  }
  assert.notEqual(seen.get('Annual Deal'), seen.get('Once Deal'),
    'a recurring and a one-time baseline are distinguishable in what is stored');
});

