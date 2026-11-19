import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REPLIES_ACTION_KIND,
  REPLIES_DEFAULT_MAX_CONSECUTIVE,
  REPLIES_HALT_REASONS,
  REPLIES_PERMISSION,
  REPLIES_SKIP_REASONS,
  buildReplyIntent,
  buildReplyProposal,
  carriesOptOut,
  decideReplyRoute,
  planReply,
} from '../packages/agents/src/replies.js';

/**
 * Inbound-reply agent tests (backlog:e5dd9214, «Risposte»): one arrived
 * message produces one answer proposal linked to its conversation; with the
 * autonomy switch off nothing leaves without approval; with it on the
 * agent stops after N answers in a row; outside the 24-hour Meta window
 * the answer is a template or another channel; an opt-out stops the agent.
 */

const AT = '2026-11-17T10:00:00.000Z';

/** @param {Partial<Record<string, unknown>>} over */
function inbound(over = {}) {
  return {
    messageId: 'msg-1',
    conversationId: 'conv-9',
    customerId: 'cus-test-1',
    displayName: 'Marco',
    channel: 'whatsapp',
    text: 'ciao, a che ora chiudete domani?',
    at: AT,
    consent: 'granted',
    connectedChannels: ['whatsapp', 'email'],
    windowState: 'in-window',
    approvedTemplate: null,
    history: [
      { direction: 'out', text: 'Ciao Marco, come posso aiutarti?' },
    ],
    ...over,
  };
}

/** A fake wording edge that answers one canned reply and captures intents. */
function fakeDraftText(seen = null) {
  return async ({ inbound: checked, route, intent }) => {
    seen?.calls.push({ customerId: checked.customerId, channel: route.channel, intent });
    return { text: `Ciao ${checked.displayName}, chiudiamo alle 20.` };
  };
}

test('acceptance: one inbound produces one reply proposal linked to the conversation', async () => {
  const seen = { calls: [] };
  const outcome = await planReply({ inbound: inbound(), draftText: fakeDraftText(seen) });
  assert.equal(outcome.status, 'proposed');
  const proposal = outcome.proposal;
  assert.equal(proposal.actionKind, REPLIES_ACTION_KIND);
  assert.equal(proposal.actionKey, 'reply:conv-9:msg-1');
  assert.equal(proposal.permission, REPLIES_PERMISSION);
  assert.equal(proposal.kind, 'free-text');
  assert.equal(proposal.channel, 'whatsapp');
  assert.match(proposal.text, /chiudiamo alle 20/);
  assert.deepEqual({ ...proposal.conversationRef }, {
    conversationId: 'conv-9',
    inboundMessageId: 'msg-1',
    customerId: 'cus-test-1',
  });
  assert.equal(seen.calls.length, 1);
  assert.match(seen.calls[0].intent, /a che ora chiudete domani/);
});

test('acceptance: with the switch off the proposal waits for approval, nothing leaves', async () => {
  const outcome = await planReply({ inbound: inbound(), draftText: fakeDraftText() });
  assert.equal(outcome.status, 'proposed');
  // The planner is pure values in, values out: the only send path is the
  // deployment seam, and the proposal names the approval it waits for.
  assert.equal(outcome.proposal.permission, 'send-without-approval');
});

test('acceptance: with the switch on the streak counts, at N in a row the agent stops and signals', async () => {
  const below = await planReply({
    inbound: inbound(),
    consecutiveReplies: REPLIES_DEFAULT_MAX_CONSECUTIVE - 1,
    draftText: fakeDraftText(),
  });
  assert.equal(below.status, 'proposed');
  const atCap = await planReply({
    inbound: inbound(),
    consecutiveReplies: REPLIES_DEFAULT_MAX_CONSECUTIVE,
    draftText: fakeDraftText(),
  });
  assert.equal(atCap.status, 'halted');
  assert.equal(atCap.reason, 'consecutive-cap');
  assert.equal(atCap.proposal, null);
  assert.equal(atCap.signal.kind, 'needs-human');
  assert.equal(atCap.signal.conversationId, 'conv-9');
  assert.match(atCap.signal.note, /persona/);
  const custom = await planReply({
    inbound: inbound(), consecutiveReplies: 1, maxConsecutiveReplies: 1, draftText: fakeDraftText(),
  });
  assert.equal(custom.status, 'halted');
  assert.equal(custom.reason, 'consecutive-cap');
});

test('acceptance: outside the 24h window a template, never free text', async () => {
  const seen = { calls: [] };
  const outcome = await planReply({
    inbound: inbound({
      windowState: 'needs-template',
      approvedTemplate: { name: 'risposta_fuori_orario', language: 'it' },
    }),
    draftText: fakeDraftText(seen),
  });
  assert.equal(outcome.status, 'proposed');
  assert.equal(outcome.proposal.kind, 'template');
  assert.equal(outcome.proposal.channel, 'whatsapp');
  assert.equal(outcome.proposal.template.name, 'risposta_fuori_orario');
  assert.equal(seen.calls.length, 0, 'a template needs no wording edge');
});

test('acceptance: outside the window with no template the reply moves to another channel', async () => {
  const seen = { calls: [] };
  const outcome = await planReply({
    inbound: inbound({ windowState: 'needs-template', approvedTemplate: null }),
    draftText: fakeDraftText(seen),
  });
  assert.equal(outcome.status, 'proposed');
  assert.equal(outcome.proposal.kind, 'free-text');
  assert.equal(outcome.proposal.channel, 'email');
  assert.match(outcome.proposal.summary, /altro canale \(email\)/);
  assert.equal(seen.calls.length, 1);
});

test('acceptance: with no sendable route the inbound is skipped, never forced', async () => {
  const outcome = await planReply({
    inbound: inbound({
      channel: 'instagram', windowState: 'needs-template', approvedTemplate: null,
      connectedChannels: ['instagram'],
    }),
    draftText: fakeDraftText(),
  });
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'no-sendable-route');
});

test('acceptance: an opt-out halts the agent, on consent and on the message itself', async () => {
  const consent = await planReply({
    inbound: inbound({ consent: 'opted-out' }),
    draftText: fakeDraftText(),
  });
  assert.equal(consent.status, 'halted');
  assert.equal(consent.reason, 'opted-out');
  assert.equal(consent.signal.kind, 'needs-human');
  const words = await planReply({
    inbound: inbound({ text: 'Non chiamarmi più, cancellatemi dai vostri elenchi.' }),
    draftText: fakeDraftText(),
  });
  assert.equal(words.status, 'halted');
  assert.equal(words.reason, 'opted-out');
  assert.deepEqual(REPLIES_HALT_REASONS, ['opted-out', 'consecutive-cap']);
});

test('bare sentiment is not an opt-out: the answer still comes', async () => {
  assert.equal(carriesOptOut('non mi piace questo pacchetto'), false);
  const outcome = await planReply({
    inbound: inbound({ text: 'non mi piace questo pacchetto, avete altro?' }),
    draftText: fakeDraftText(),
  });
  assert.equal(outcome.status, 'proposed');
});

test('unknown consent stays a skip: no answer without a consent basis', async () => {
  const outcome = await planReply({
    inbound: inbound({ consent: 'unknown' }),
    draftText: fakeDraftText(),
  });
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'consent-unknown');
  assert.deepEqual(REPLIES_SKIP_REASONS.includes('consent-unknown'), true);
});

test('a refused wording edge keeps its cause beside the no-draft skip', async () => {
  const refusing = async () => { throw new Error('LLM_SECRET_UNAVAILABLE'); };
  const outcome = await planReply({ inbound: inbound(), draftText: refusing });
  assert.equal(outcome.status, 'skipped');
  assert.equal(outcome.reason, 'no-draft');
  assert.equal(outcome.cause, 'LLM_SECRET_UNAVAILABLE');
  const empty = await planReply({ inbound: inbound(), draftText: async () => ({ text: '  ' }) });
  assert.equal(empty.status, 'skipped');
  assert.equal(empty.reason, 'no-draft');
  assert.equal(empty.cause, 'empty-text');
});

test('fail-closed: unreadable inbound, missing window and bad streaks refuse', async () => {
  await assert.rejects(planReply({ inbound: inbound({ text: '  ' }), draftText: fakeDraftText() }));
  await assert.rejects(planReply({
    inbound: inbound({ windowState: undefined }),
    draftText: fakeDraftText(),
  }));
  await assert.rejects(planReply({ inbound: inbound(), draftText: null }));
  await assert.rejects(planReply({
    inbound: inbound(), consecutiveReplies: -1, draftText: fakeDraftText(),
  }));
  const unsupported = await planReply({
    inbound: inbound({ channel: 'tiktok', connectedChannels: ['tiktok'] }),
    draftText: fakeDraftText(),
  });
  assert.equal(unsupported.status, 'skipped');
  assert.equal(unsupported.reason, 'unsupported-channel');
});

test('route and intent units: whatsapp template only, history bounds the prompt', () => {
  const route = decideReplyRoute(inbound({
    channel: 'instagram', windowState: 'needs-template',
    approvedTemplate: { name: 'x' }, connectedChannels: ['instagram'],
  }));
  assert.equal(route.kind, 'none', 'instagram documents no template fallback');
  const intent = buildReplyIntent(inbound({
    history: Array.from({ length: 20 }, (_, i) => ({ direction: i % 2 ? 'out' : 'in', text: `riga ${i}` })),
  }));
  assert.match(intent, /riga 19/);
  assert.doesNotMatch(intent, /riga 0/, 'only the last exchanges travel');
  assert.throws(() => buildReplyProposal({
    inbound: { messageId: 'm', conversationId: 'c', customerId: 'k', displayName: 'N', channel: 'whatsapp' },
    route: { kind: 'free-text', channel: 'whatsapp', template: null },
    draft: { text: ' ' },
  }));
});
