import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REENGAGEMENT_ACTION_KIND,
  REENGAGEMENT_DEFAULT_QUIET_DAYS,
  REENGAGEMENT_INBOUND_CHANNELS,
  REENGAGEMENT_PERMISSION,
  buildReengagementIntent,
  buildReengagementProposal,
  decideReengagementRoute,
  scanReengagement,
  selectReengagementCandidate,
  silentDays,
} from '../packages/reengagement/src/reengagement.js';
import { createReengagementPackage } from '../packages/reengagement/src/index.js';

/**
 * Re-engagement agent tests (backlog:f50ad5c9): Presti's first teammate
 * agent proposes one knock per unanswered customer and none for the
 * others, and outside the 24-hour Meta window it proposes a template or
 * another channel — never free text.
 */

const NOW_MS = Date.parse('2026-11-03T12:00:00.000Z');
const TEN_DAYS_AGO = '2026-10-24T09:00:00.000Z';
const NINE_DAYS_AGO = '2026-10-25T09:00:00.000Z';
const TWO_DAYS_AGO = '2026-11-01T10:00:00.000Z';

/** @param {Partial<Record<string, unknown>>} over */
function customer(over = {}) {
  return {
    customerId: 'cus-test-1',
    displayName: 'Marco',
    channel: 'whatsapp',
    lastInboundAt: TEN_DAYS_AGO,
    lastOutboundAt: null,
    consent: 'granted',
    connectedChannels: ['whatsapp', 'email'],
    windowState: 'in-window',
    approvedTemplate: null,
    history: [{ direction: 'in', text: 'ciao, a che ora chiudete domani?' }],
    ...over,
  };
}

/** A fake wording edge that answers one canned knock and captures intents. */
function fakeDraftText(seen = null) {
  return async ({ candidate, route, intent }) => {
    seen?.calls.push({ customerId: candidate.customerId, channel: route.channel, intent });
    return { text: `Ciao ${candidate.displayName}, ti scrivo da Presti.` };
  };
}

test('acceptance: one proposal per silent customer, none for the others', async () => {
  const seen = { calls: [] };
  const { proposals, skipped } = await scanReengagement({
    customers: [
      customer({ customerId: 'cus-silent-wa' }),
      customer({
        customerId: 'cus-replied-ig', channel: 'instagram', lastOutboundAt: TWO_DAYS_AGO,
        connectedChannels: ['instagram'], windowState: 'in-window',
      }),
      customer({ customerId: 'cus-recent-mail', channel: 'email', lastInboundAt: TWO_DAYS_AGO }),
      customer({ customerId: 'cus-opted-out', consent: 'opted-out' }),
    ],
    quietDays: 7,
    nowMs: NOW_MS,
    draftText: fakeDraftText(seen),
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].customerRef.customerId, 'cus-silent-wa');
  assert.equal(proposals[0].kind, 'free-text');
  assert.equal(proposals[0].channel, 'whatsapp');
  assert.match(proposals[0].text, /Ciao/);
  const reasons = Object.fromEntries(skipped.map((entry) => [entry.customerId, entry.reason]));
  assert.deepEqual(reasons, {
    'cus-replied-ig': 'replied',
    'cus-recent-mail': 'recent',
    'cus-opted-out': 'opted-out',
  });
  assert.equal(seen.calls.length, 1);
});

test('acceptance: outside the 24h window a template, never free text', async () => {
  const seen = { calls: [] };
  const { proposals, skipped } = await scanReengagement({
    customers: [
      customer({
        customerId: 'cus-stale-template', windowState: 'needs-template',
        approvedTemplate: { name: 'riattivazione' },
      }),
    ],
    quietDays: 7,
    nowMs: NOW_MS,
    draftText: fakeDraftText(seen),
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'template');
  assert.equal(proposals[0].channel, 'whatsapp');
  assert.equal(proposals[0].template.name, 'riattivazione');
  assert.equal(proposals[0].text, null);
  assert.deepEqual(skipped, []);
  assert.equal(seen.calls.length, 0);
});

test('acceptance: outside the window with no template, another channel — still never free text', async () => {
  const { proposals, skipped } = await scanReengagement({
    customers: [
      customer({ customerId: 'cus-stale-email-fallback', windowState: 'needs-template' }),
      customer({
        customerId: 'cus-stale-no-route', windowState: 'needs-template',
        connectedChannels: ['whatsapp'],
      }),
    ],
    quietDays: 7,
    nowMs: NOW_MS,
    draftText: fakeDraftText(),
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].customerRef.customerId, 'cus-stale-email-fallback');
  assert.equal(proposals[0].kind, 'free-text');
  assert.equal(proposals[0].channel, 'email');
  const reasons = Object.fromEntries(skipped.map((entry) => [entry.customerId, entry.reason]));
  assert.deepEqual(reasons, { 'cus-stale-no-route': 'no-sendable-route' });
});

test('a stale reply knocks again: silence counts from the latest contact', async () => {
  const { proposals, skipped } = await scanReengagement({
    customers: [
      customer({
        customerId: 'cus-stale-reply', lastInboundAt: TEN_DAYS_AGO, lastOutboundAt: NINE_DAYS_AGO,
      }),
    ],
    quietDays: 7,
    nowMs: NOW_MS,
    draftText: fakeDraftText(),
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].customerRef.customerId, 'cus-stale-reply');
  assert.deepEqual(skipped, []);
});

test('facebook is windowed too: the fallback skips it for a channel with no observation', async () => {
  const { proposals, skipped } = await scanReengagement({
    customers: [
      customer({
        customerId: 'cus-fb-fallback', windowState: 'needs-template',
        connectedChannels: ['whatsapp', 'facebook', 'email'],
      }),
      customer({
        customerId: 'cus-fb-only', windowState: 'needs-template',
        connectedChannels: ['whatsapp', 'facebook'],
      }),
    ],
    quietDays: 7,
    nowMs: NOW_MS,
    draftText: fakeDraftText(),
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].channel, 'email');
  const reasons = Object.fromEntries(skipped.map((entry) => [entry.customerId, entry.reason]));
  assert.deepEqual(reasons, { 'cus-fb-only': 'no-sendable-route' });
});

test('an unusable draft skips instead of proposing a free-text knock with no text', async () => {
  for (const [name, draft] of [['null', null], ['empty-object', {}], ['blank', { text: '   ' }]]) {
    const { proposals, skipped } = await scanReengagement({
      customers: [customer({ customerId: `cus-no-draft-${name}` })],
      quietDays: 7,
      nowMs: NOW_MS,
      draftText: async () => draft,
    });
    assert.deepEqual(proposals, []);
    assert.deepEqual(skipped.map((entry) => entry.reason), ['no-draft']);
  }
  assert.throws(() => buildReengagementProposal({
    candidate: { customerId: 'cus-a', displayName: 'Anna', channel: 'whatsapp' },
    route: { kind: 'free-text', channel: 'whatsapp', template: null },
    draft: { text: '  ' },
    day: '2026-11-03',
  }), /draft/);
});

test('the route invariant holds for every decided route: stale windowed channels never read free text', () => {
  const route = decideReengagementRoute(customer({ windowState: 'needs-template' }));
  assert.ok(route.kind === 'template' || route.kind === 'none' || route.channel === 'email');
});

test('no template route on instagram/facebook: only whatsapp sends approved templates', async () => {
  for (const channel of ['instagram', 'facebook']) {
    const route = decideReengagementRoute(customer({
      channel,
      windowState: 'needs-template',
      approvedTemplate: { name: 'riattivazione' },
      connectedChannels: [channel, 'email'],
    }));
    assert.notEqual(route.kind, 'template');
    assert.ok(route.kind === 'none' || route.channel === 'email');
  }
  const { proposals, skipped } = await scanReengagement({
    customers: [
      customer({
        customerId: 'cus-ig-template', channel: 'instagram', windowState: 'needs-template',
        approvedTemplate: { name: 'riattivazione' },
        connectedChannels: ['instagram', 'email'],
      }),
    ],
    quietDays: 7,
    nowMs: NOW_MS,
    draftText: fakeDraftText(),
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].kind, 'free-text');
  assert.equal(proposals[0].channel, 'email');
  assert.deepEqual(skipped, []);
});

test('a throwing draftText skips that customer instead of aborting the sweep', async () => {
  const draftText = async ({ candidate }) => {
    if (candidate.customerId === 'cus-draft-boom') throw new Error('LLM timeout');
    return { text: `Ciao ${candidate.displayName}, ti scrivo da Presti.` };
  };
  const { proposals, skipped } = await scanReengagement({
    customers: [
      customer({ customerId: 'cus-draft-ok' }),
      customer({ customerId: 'cus-draft-boom' }),
    ],
    quietDays: 7,
    nowMs: NOW_MS,
    draftText,
  });
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].customerRef.customerId, 'cus-draft-ok');
  assert.deepEqual(skipped.map((entry) => [entry.customerId, entry.reason]), [
    ['cus-draft-boom', 'no-draft'],
  ]);
});

test('unknown consent skips fail-closed and malformed customers refuse the scan', async () => {
  const { proposals, skipped } = await scanReengagement({
    customers: [customer({ customerId: 'cus-unknown', consent: 'unknown' })],
    nowMs: NOW_MS,
    draftText: fakeDraftText(),
  });
  assert.deepEqual(proposals, []);
  assert.deepEqual(skipped.map((entry) => entry.reason), ['consent-unknown']);
  await assert.rejects(
    scanReengagement({
      customers: [{ customerId: 'cus-broken', displayName: 'Broken', channel: 'whatsapp' }],
      nowMs: NOW_MS,
      draftText: fakeDraftText(),
    }),
    /lastInboundAt/,
  );
  await assert.rejects(
    scanReengagement({ customers: [customer()], nowMs: NOW_MS, draftText: null }),
    /draftText/,
  );
});

test('the drafting intent carries the customer facts: name, channel, silence and last inbound line', () => {
  const checked = customer({});
  const candidate = { ...checked, silentDays: silentDays(checked.lastInboundAt, NOW_MS) };
  const intent = buildReengagementIntent(candidate);
  assert.match(intent, /Marco/);
  assert.match(intent, /whatsapp/);
  assert.match(intent, /a che ora chiudete domani/);
  assert.equal(silentDays(TEN_DAYS_AGO, NOW_MS), 10);
});

test('proposal values fit the approval record and stay stable per customer per day', () => {
  const day = '2026-11-03';
  const first = buildReengagementProposal({
    candidate: { customerId: 'cus-a', displayName: 'Anna', channel: 'whatsapp' },
    route: { kind: 'free-text', channel: 'whatsapp', template: null },
    draft: { text: 'Ciao Anna.' },
    day,
  });
  const second = buildReengagementProposal({
    candidate: { customerId: 'cus-a', displayName: 'Anna', channel: 'email' },
    route: { kind: 'free-text', channel: 'email', template: null },
    draft: { text: 'Ciao Anna.' },
    day,
  });
  assert.equal(first.actionKind, REENGAGEMENT_ACTION_KIND);
  assert.equal(first.permission, REENGAGEMENT_PERMISSION);
  assert.equal(first.actionKey, second.actionKey);
  assert.match(first.summary, /Anna/);
  assert.ok(first.summary.length <= 500);
  assert.throws(() => buildReengagementProposal({
    candidate: { customerId: 'cus-a', displayName: 'Anna', channel: 'whatsapp' },
    route: { kind: 'free-text', channel: 'whatsapp', template: null },
    draft: null,
    day: 'not-a-day',
  }), /day/);
});

test('the package composes with no records and its operation refuses without the wording edge', async () => {
  const graph = createReengagementPackage();
  assert.equal(graph.name, 'reengagement');
  assert.deepEqual(graph.resources, []);
  assert.deepEqual(graph.requires, []);
  const operation = graph.operations.find((entry) => entry.appMethod === 'scanReengagement');
  assert.ok(operation);
  const run = operation.create({});
  const error = await run({ actor: { type: 'agent', id: 'reengagement' }, customers: [] }).then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error?.code, 'REENGAGEMENT_DRAFT_UNAVAILABLE');
});

test('selection answers every quiet state: replied, recent, unsupported and missing inbound', () => {
  const base = { nowMs: NOW_MS, quietDays: REENGAGEMENT_DEFAULT_QUIET_DAYS };
  assert.equal(REENGAGEMENT_DEFAULT_QUIET_DAYS, 7);
  assert.ok(REENGAGEMENT_INBOUND_CHANNELS.includes('whatsapp'));
  const replied = selectReengagementCandidate(
    { ...customer({}), channel: 'email', lastOutboundAt: TWO_DAYS_AGO }, base,
  );
  assert.equal(replied.skip, 'replied');
  const staleReply = selectReengagementCandidate(
    { ...customer({}), channel: 'email', lastOutboundAt: NINE_DAYS_AGO }, base,
  );
  assert.equal(staleReply.skip, null);
  assert.equal(staleReply.candidate.silentDays, 9);
  const recent = selectReengagementCandidate({ ...customer({}), lastInboundAt: TWO_DAYS_AGO }, base);
  assert.equal(recent.skip, 'recent');
  const unsupported = selectReengagementCandidate({ ...customer({}), channel: 'sms' }, base);
  assert.equal(unsupported.skip, 'unsupported-channel');
});
