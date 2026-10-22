import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { boot, project } from './helpers/customer-data-project.js';

/**
 * **Union opt-out (backlog:c3061a002dd0, owner decision Q-G1).**
 *
 * A contact with an opt-out never enters a union proposal: `recordCandidatePairs`
 * — the single choke point for the sender, import, enrichment and connect
 * paths — skips every pair naming an opted-out contact, so no
 * `duplicate-candidate` row is written for a human to decide on.
 */

const ACTOR = { type: 'user', id: 'union-opt-out' };

async function scene(t, tag) {
  const root = project(t, {});
  const context = await boot(root, join(root, 'data', `${tag}.sqlite`));
  t.after(() => context.close());
  return { root, ...context };
}

function unresolvedCandidates(app) {
  return app.modules.get('duplicate-candidate').service.listWhere({ status: 'unresolved' });
}

test('a conflict naming an opted-out contact writes no union proposal', async (t) => {
  const { app } = await scene(t, 'union-opt-out-skipped');

  const anna = await app.resolveChannelSender({
    channel: 'email', handle: 'anna@prestigroup.example',
    firstName: 'Anna', lastName: 'Bianchi', companyName: 'Presti Group', domain: 'prestigroup.example', actor: ACTOR,
  });
  assert.equal(anna.outcome, 'created');

  const paolo = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000002', email: 'paolo@prestigroup.example',
    firstName: 'Paolo', lastName: 'Esposito', companyName: 'Presti Group', domain: 'prestigroup.example', actor: ACTOR,
  });
  assert.equal(paolo.outcome, 'created');

  const opted = await app.optOutContactEnrichment({
    email: 'paolo@prestigroup.example', reason: 'do not merge my identities', actor: ACTOR,
  });
  assert.equal(opted.outcome, 'opted-out');

  // The WhatsApp handle belongs to Paolo, but the sender also carries Anna's
  // email: conflicting evidence about one sender — the same shape that
  // without an opt-out becomes exactly one candidate.
  const conflict = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000002', email: 'anna@prestigroup.example', actor: ACTOR,
  });
  assert.equal(conflict.outcome, 'unresolved');
  assert.equal(conflict.contact, null);
  assert.equal(conflict.candidatesWritten, 0, 'the opted-out pair is never proposed');

  assert.deepEqual(unresolvedCandidates(app), [], 'no union proposal names the opted-out contact');
});

test('the same conflict without an opt-out still proposes the union', async (t) => {
  const { app } = await scene(t, 'union-opt-out-control');

  const anna = await app.resolveChannelSender({
    channel: 'email', handle: 'anna@prestigroup.example',
    firstName: 'Anna', lastName: 'Bianchi', companyName: 'Presti Group', domain: 'prestigroup.example', actor: ACTOR,
  });
  assert.equal(anna.outcome, 'created');

  const paolo = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000002', email: 'paolo@prestigroup.example',
    firstName: 'Paolo', lastName: 'Esposito', companyName: 'Presti Group', domain: 'prestigroup.example', actor: ACTOR,
  });
  assert.equal(paolo.outcome, 'created');

  const conflict = await app.resolveChannelSender({
    channel: 'whatsapp', handle: '+393330000002', email: 'anna@prestigroup.example', actor: ACTOR,
  });
  assert.equal(conflict.outcome, 'unresolved');
  assert.equal(conflict.candidatesWritten, 1, 'without an opt-out the pair is proposed');

  const candidates = unresolvedCandidates(app);
  assert.equal(candidates.length, 1);
  const pair = [`${candidates[0].leftResource}:${candidates[0].leftId}`, `${candidates[0].rightResource}:${candidates[0].rightId}`].sort();
  assert.deepEqual(pair, [`contact:${anna.contact.id}`, `contact:${paolo.contact.id}`].sort());
});
