import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SPACE_AI_PERMISSIONS,
  SPACE_AI_PERMISSION_DEFAULTS,
  checkPermissionKey,
  checkSpaceId,
  effectivePermission,
  evaluateAiPermission,
  resolveSpacePermissions,
  createSpacePermissionsDomain,
} from '../packages/space-permissions/src/index.js';
import {
  RESPONSE_CHANNELS,
  SPACE_ROLES,
  reviewSpaceInvite,
} from '../packages/space-permissions/src/invites.js';
import {
  buildAiProposal,
  decideAiProposal,
} from '../packages/space-permissions/src/proposals.js';
import {
  buildDecideAction,
  buildProposeAction,
  buildSetPermissionAction,
} from '../packages/space-permissions/src/actions.js';
import { createSpacePermissionGateCapability } from '../packages/space-permissions/src/capability.js';
import { ConflictError } from '../packages/core/index.js';

/**
 * BO-F0-06 acceptance: five AI switches per space, send-without-approval off
 * by default; a switched-off action becomes a proposal, never an execution;
 * invitations assign role plus reply channels; one space's data is invisible
 * from the others; no spaces model in the framework.
 */

const SPACE_A = 'presti-group';
const SPACE_B = 'other-space';
const USER = { type: 'user', id: 'owner-1' };
const SYSTEM = { type: 'system', id: 'control-plane' };

test('five permission keys, send-without-approval off by default', () => {
  assert.deepEqual([...SPACE_AI_PERMISSIONS], [
    'merge-duplicates',
    'drafts',
    'send-without-approval',
    'book-appointments',
    'move-offers',
  ]);
  assert.equal(SPACE_AI_PERMISSION_DEFAULTS['send-without-approval'], false);
  for (const key of SPACE_AI_PERMISSIONS) {
    if (key === 'send-without-approval') continue;
    assert.equal(SPACE_AI_PERMISSION_DEFAULTS[key], true, `${key} defaults on`);
  }
  const resolved = resolveSpacePermissions([]);
  assert.equal(resolved['send-without-approval'], false);
  assert.equal(Object.keys(resolved).length, 5);
});

for (const permission of SPACE_AI_PERMISSIONS) {
  test(`gate with ${permission} off returns proposal, never allow`, () => {
    const verdict = evaluateAiPermission({
      spaceId: SPACE_A,
      permission,
      overrideRows: [{ permission, enabled: false }],
    });
    assert.equal(verdict.decision, 'proposal');
    assert.equal(verdict.enabled, false);
    assert.equal(verdict.spaceId, SPACE_A);
    assert.ok(Object.isFrozen(verdict));
  });

  test(`gate with ${permission} on returns allow`, () => {
    const verdict = evaluateAiPermission({
      spaceId: SPACE_A,
      permission,
      overrideRows: [{ permission, enabled: true }],
    });
    assert.equal(verdict.decision, 'allow');
    assert.equal(verdict.enabled, true);
  });
}

test('unknown permission key is a typed refusal, including prototype keys', () => {
  for (const hostile of ['__proto__', 'constructor', 'prototype', 'send', '', null, undefined, 42]) {
    assert.throws(() => checkPermissionKey(hostile), (error) => error.code === 'SPACE_PERMISSION_UNKNOWN');
  }
});

test('space id is opaque but shaped: empty and hostile ids refused', () => {
  assert.equal(checkSpaceId('  presti-group  '), 'presti-group');
  for (const bad of ['', '   ', null, undefined, 42, 'a'.repeat(129), 'space\nid', 'space\x00id']) {
    assert.throws(() => checkSpaceId(bad), (error) => error.code === 'VALIDATION_ERROR' || /spaceId/.test(error.message));
  }
});

test('override rows of another space never leak in: isolation by exact match', () => {
  const verdict = evaluateAiPermission({
    spaceId: SPACE_A,
    permission: 'send-without-approval',
    overrideRows: [
      { spaceId: SPACE_B, permission: 'send-without-approval', enabled: true },
    ],
  });
  // The gate reads only the rows the caller filtered for SPACE_A; a foreign
  // row passed by mistake carries no spaceId match and changes nothing.
  assert.equal(verdict.decision, 'proposal');
});

test('invitation assigns a control-plane role and reply channels', () => {
  assert.deepEqual([...SPACE_ROLES], ['owner', 'operator', 'observer']);
  const reviewed = reviewSpaceInvite({
    spaceId: SPACE_A,
    role: 'operator',
    responseChannels: ['whatsapp', 'email'],
  });
  assert.equal(reviewed.ok, true);
  assert.deepEqual(reviewed.invite, {
    spaceId: SPACE_A,
    role: 'operator',
    responseChannels: ['whatsapp', 'email'],
  });
});

test('invitation refuses unknown roles, entry-only channels and empties', () => {
  const noRole = reviewSpaceInvite({ spaceId: SPACE_A, role: 'admin', responseChannels: ['whatsapp'] });
  assert.equal(noRole.ok, false);
  assert.ok(noRole.errors.some((message) => message.startsWith('role:')));

  const entryOnly = reviewSpaceInvite({ spaceId: SPACE_A, role: 'observer', responseChannels: ['tiktok'] });
  assert.equal(entryOnly.ok, false);

  const siteForm = reviewSpaceInvite({ spaceId: SPACE_A, role: 'observer', responseChannels: ['site-form'] });
  assert.equal(siteForm.ok, false);

  const empty = reviewSpaceInvite({ spaceId: SPACE_A, role: 'observer', responseChannels: [] });
  assert.equal(empty.ok, false);

  const dup = reviewSpaceInvite({ spaceId: SPACE_A, role: 'observer', responseChannels: ['email', 'email'] });
  assert.equal(dup.ok, false);

  const noSpace = reviewSpaceInvite({ spaceId: '', role: 'observer', responseChannels: ['email'] });
  assert.equal(noSpace.ok, false);
});

test('proposal identity is deterministic: same action replays, never duplicates', () => {
  const first = buildAiProposal({
    spaceId: SPACE_A,
    permission: 'send-without-approval',
    actionKind: 'send quote follow-up',
    actionKey: 'quote-7',
    summary: 'Send the follow-up for quote 7 on WhatsApp.',
    proposedAt: '2026-10-19T20:00:00.000Z',
  });
  const second = buildAiProposal({
    spaceId: SPACE_A,
    permission: 'send-without-approval',
    actionKind: 'send quote follow-up, reworded',
    actionKey: 'quote-7',
    summary: 'Different wording, same action.',
    proposedAt: '2026-10-19T20:01:00.000Z',
  });
  assert.equal(first.sourceKey, second.sourceKey);
  assert.equal(first.status, 'proposed');
});

test('only a proposed row can be decided; terminal rows conflict', () => {
  const patch = decideAiProposal({
    proposal: { status: 'proposed' },
    decision: 'approved',
    actorId: 'owner-1',
    decidedAt: '2026-10-19T21:00:00.000Z',
  });
  assert.equal(patch.patch.status, 'approved');
  assert.equal(patch.patch.refusalReason, null);

  const refused = decideAiProposal({
    proposal: { status: 'proposed' },
    decision: 'refused',
    actorId: 'owner-1',
    decidedAt: '2026-10-19T21:00:00.000Z',
    refusalReason: 'Wrong customer.',
  });
  assert.equal(refused.patch.refusalReason, 'Wrong customer.');

  for (const status of ['approved', 'refused', 'draft', undefined]) {
    assert.throws(() => decideAiProposal({
      proposal: { status },
      decision: 'approved',
      actorId: 'owner-1',
      decidedAt: '2026-10-19T21:00:00.000Z',
    }), (error) => error.code === 'SPACE_PROPOSAL_STATE_INVALID');
  }
});

/** Stub module services over plain arrays, space-filtered like the real ones. */
function stubModules() {
  const overrides = [];
  const proposals = [];
  let seq = 0;
  const serviceFor = (rows) => ({
    async listWhere(where) {
      return rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
    },
    async createManaged(row) {
      seq += 1;
      const stored = { ...row, id: `row-${seq}` };
      rows.push(stored);
      return { ...stored };
    },
  });
  return {
    rows: { overrides, proposals },
    modules: {
      get(name) {
        if (name === 'space-permission-override') return { service: serviceFor(overrides) };
        if (name === 'space-ai-proposal') return { service: serviceFor(proposals) };
        throw new Error(`unexpected module ${name}`);
      },
    },
  };
}

function actionCtx(stub, { record = {}, input = {}, actor = SYSTEM } = {}) {
  const patches = [];
  return {
    ctx: {
      record, input, actor,
      modules: stub.modules,
      managed: async (id, patch) => {
        patches.push({ id, patch });
        for (const rows of Object.values(stub.rows)) {
          const row = rows.find((item) => item.id === id);
          if (row) Object.assign(row, patch);
        }
      },
      now: () => '2026-10-19T20:00:00.000Z',
      step: () => {},
    },
    patches,
  };
}

test('set-permission creates on first flip, patches after, names the actor', async () => {
  const stub = stubModules();
  const action = buildSetPermissionAction();
  const anonymous = actionCtx(stub, {
    input: { spaceId: SPACE_A, permission: 'drafts', enabled: 'off' },
    actor: null,
  });
  await assert.rejects(() => action.execute(anonymous.ctx), (error) => error.code === 'SPACE_ACTOR_REQUIRED');

  const first = actionCtx(stub, { input: { spaceId: SPACE_A, permission: 'drafts', enabled: 'off' } });
  const created = await action.execute(first.ctx);
  assert.equal(created.created, true);
  assert.equal(stub.rows.overrides.length, 1);
  assert.equal(stub.rows.overrides[0].updatedBy, 'system:control-plane');

  const second = actionCtx(stub, { input: { spaceId: SPACE_A, permission: 'drafts', enabled: 'on' } });
  const updated = await action.execute(second.ctx);
  assert.equal(updated.created, false);
  assert.equal(stub.rows.overrides.length, 1);
  assert.equal(stub.rows.overrides[0].enabled, true);
});

test('propose-action refuses when the switch is on: act, do not propose', async () => {
  const stub = stubModules();
  stub.rows.overrides.push({ id: 'row-0', spaceId: SPACE_A, permission: 'drafts', enabled: true });
  const action = buildProposeAction();
  const { ctx } = actionCtx(stub, {
    input: {
      spaceId: SPACE_A, permission: 'drafts', actionKind: 'draft reply',
      actionKey: 'conv-1', summary: 'Draft a reply.',
    },
  });
  await assert.rejects(() => action.execute(ctx), (error) => error.code === 'SPACE_PERMISSION_ENABLED');
  assert.equal(stub.rows.proposals.length, 0);
});

test('propose-action records one proposal and replays the retry', async () => {
  const stub = stubModules();
  const action = buildProposeAction();
  const draft = {
    spaceId: SPACE_A, permission: 'send-without-approval', actionKind: 'send follow-up',
    actionKey: 'quote-7', summary: 'Send the follow-up for quote 7.',
  };
  const first = await action.execute(actionCtx(stub, { input: draft }).ctx);
  assert.equal(first.replayed, false);
  const second = await action.execute(actionCtx(stub, { input: draft }).ctx);
  assert.equal(second.replayed, true);
  assert.equal(second.proposalId, first.proposalId);
  assert.equal(stub.rows.proposals.length, 1);
});

test('concurrent first flips converge on one switch row', async () => {
  const stub = stubModules();
  const action = buildSetPermissionAction();
  const draft = { spaceId: SPACE_A, permission: 'drafts', enabled: 'off' };
  // The loser of the unique scopeKey re-reads the winner and patches it.
  let calls = 0;
  const realService = stub.modules.get('space-permission-override').service;
  const racing = {
    ...realService,
    async createManaged(row) {
      calls += 1;
      if (calls === 1) {
        // The other connection's insert wins first; the store refuses ours.
        await realService.createManaged(row);
        throw new ConflictError('space-permission-override.scopeKey already exists');
      }
      return realService.createManaged(row);
    },
  };
  const racingModules = { get: (name) => (name === 'space-permission-override' ? { service: racing } : stub.modules.get(name)) };
  const first = actionCtx(stub, { input: draft });
  first.ctx.modules = racingModules;
  const won = await action.execute(first.ctx);
  assert.equal(won.created, false);
  assert.equal(stub.rows.overrides.filter((row) => row.permission === 'drafts').length, 1);
  assert.equal(stub.rows.overrides[0].enabled, false);
});

test('concurrent proposals replay the open winner, refuse after decision', async () => {
  const stub = stubModules();
  const action = buildProposeAction();
  const draft = {
    spaceId: SPACE_A, permission: 'send-without-approval', actionKind: 'send follow-up',
    actionKey: 'quote-9', summary: 'Send the follow-up for quote 9.',
  };
  const realService = stub.modules.get('space-ai-proposal').service;
  let reads = 0;
  const racing = {
    ...realService,
    // First read sees nothing (both connections passed the pre-check); later
    // reads see the winner. The create path enforces the unique sourceKey
    // like the real store: a clash is a ConflictError, never a second row.
    async listWhere(where) {
      reads += 1;
      if (reads <= 2) return [];
      return realService.listWhere(where);
    },
    async createManaged(row) {
      const clash = (await realService.listWhere({ spaceId: row.spaceId }))
        .find((item) => item.sourceKey === row.sourceKey);
      if (clash) throw new ConflictError('space-ai-proposal.sourceKey already exists');
      return realService.createManaged(row);
    },
  };
  const racingModules = { get: (name) => (name === 'space-ai-proposal' ? { service: racing } : stub.modules.get(name)) };
  // The other connection wins between our pre-check and our insert.
  const winner = await realService.createManaged({
    ...buildAiProposal({ ...draft, proposedAt: '2026-10-19T20:00:00.000Z' }),
  });
  const loser = actionCtx(stub, { input: draft });
  loser.ctx.modules = racingModules;
  const replayed = await action.execute(loser.ctx);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.proposalId, winner.id);
  assert.equal(stub.rows.proposals.filter((row) => row.sourceKey === winner.sourceKey).length, 1);

  // After a human decided it, the same action key ends with a code.
  winner.status = 'approved';
  const late = actionCtx(stub, { input: draft });
  late.ctx.modules = racingModules;
  await assert.rejects(() => action.execute(late.ctx), (error) => error.code === 'SPACE_PROPOSAL_DECIDED');
});

test('approve and refuse are human-only; decided rows go terminal', async () => {
  const stub = stubModules();
  const approve = buildDecideAction('approved');
  const refuse = buildDecideAction('refused');
  const proposal = { id: 'row-1', status: 'proposed' };

  const agent = actionCtx(stub, { record: proposal, actor: SYSTEM });
  await assert.rejects(() => approve.execute(agent.ctx), (error) => error.code === 'HUMAN_APPROVAL_REQUIRED');
  await assert.rejects(() => refuse.execute(agent.ctx), (error) => error.code === 'HUMAN_APPROVAL_REQUIRED');

  const human = actionCtx(stub, { record: proposal, actor: USER });
  const decided = await approve.execute(human.ctx);
  assert.equal(decided.status, 'approved');
  assert.equal(proposal.status, 'approved');

  const again = actionCtx(stub, { record: proposal, actor: USER });
  await assert.rejects(() => approve.execute(again.ctx), (error) => error.code === 'SPACE_PROPOSAL_STATE_INVALID');
});

test('capability gate reads stored overrides and keeps spaces apart', async () => {
  const stub = stubModules();
  stub.rows.overrides.push(
    { id: 'row-1', spaceId: SPACE_A, permission: 'send-without-approval', enabled: true },
    { id: 'row-2', spaceId: SPACE_B, permission: 'drafts', enabled: false },
  );
  stub.rows.proposals.push(
    { id: 'row-9', spaceId: SPACE_B, permission: 'drafts', status: 'proposed', sourceKey: `${SPACE_B}:drafts:k` },
  );
  const gate = createSpacePermissionGateCapability().create({ modules: stub.modules, consumer: 'test' });

  const allowed = await gate.gate({ spaceId: SPACE_A, permission: 'send-without-approval' });
  assert.equal(allowed.decision, 'allow');

  const other = await gate.gate({ spaceId: SPACE_B, permission: 'send-without-approval' });
  assert.equal(other.decision, 'proposal');

  const effective = await gate.effective(SPACE_B);
  assert.equal(effective.drafts, false);
  assert.equal(effective['send-without-approval'], false);

  // A proposal of space B is unreachable through space A.
  const missing = await gate.proposal(SPACE_A, 'row-9');
  assert.equal(missing, null);
  const found = await gate.proposal(SPACE_B, 'row-9');
  assert.equal(found.id, 'row-9');
});

test('package definition composes: identity, resources, actions, capability', () => {
  const pkg = createSpacePermissionsDomain();
  assert.equal(pkg.name, 'space-permissions');
  assert.deepEqual([...pkg.resources], ['space-permission-override', 'space-ai-proposal']);
  assert.equal(pkg.actions.length, 4);
  assert.equal(pkg.capabilities.length, 1);
  assert.equal(pkg.capabilities[0].name, 'space-permission-gate');
  const meta = pkg.metadata();
  assert.ok(Array.isArray(meta.notModeled) && meta.notModeled.length > 0);
});

test('response channels stay inside the framework channel vocabulary', async () => {
  const { CHANNELS } = await import('../packages/channels/src/adapter.js');
  for (const channel of RESPONSE_CHANNELS) {
    assert.ok(CHANNELS.includes(channel), `${channel} is a framework channel`);
  }
  assert.ok(!RESPONSE_CHANNELS.includes('tiktok'));
  assert.ok(!RESPONSE_CHANNELS.includes('site-form'));
});
