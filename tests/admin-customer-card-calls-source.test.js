import test from 'node:test';
import assert from 'node:assert/strict';
import { createCustomerCardView } from '../apps/admin/public/admin-customer-card.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

/**
 * backlog:619b477c0464 (verifica Mac 11/11, punto 6): on Bea Bianchi the
 * cronologia showed «chiamata in entrata · persa» while the Chiamate box
 * said «nessuna chiamata registrata». One source: a call the cronologia
 * holds is a call in the Chiamate box too, even with no recording.
 */

const CARD = {
  customerCardContract: 1,
  subject: { resource: 'contact', id: 'c1' },
  name: 'Bea Bianchi',
  company: { id: 'co1', name: 'Presti Group' },
  phone: { available: true, value: '+39 333 0000000', system: 'phone', reason: null },
  email: null,
  socials: [],
  status: { value: 'contatto', reason: null },
  activePackage: { available: false, count: 0, items: [], reason: 'none' },
  notes: { available: false, items: null, reason: 'none' },
  history: { available: false, items: [], count: 0, truncated: false, completeTimeline: false, reason: 'none' },
  headline: {
    city: { available: false, value: null, reason: 'none' },
    origin: { available: false, system: null, firstObservedAt: null, reason: 'none' },
    assignee: { available: false, value: null, reason: 'none' },
  },
};

function timelineWith(items) {
  return {
    customerTimelineContract: 1,
    subject: { resource: 'contact', id: 'c1' },
    conversations: { available: true, count: 0, truncated: false, items: [], unthreadedMessages: 0, unthreadedCalls: 0 },
    entries: { available: true, count: items.length, truncated: false, items },
    appointments: { available: true, count: 0, truncated: false, items: [] },
    contactPoints: { available: true, count: 0, items: [] },
    timelineNote: '',
  };
}

const MISSED = {
  entry: 'call', id: 'k1', conversationId: null, channel: 'phone', direction: 'inbound',
  sync: 'missed', durationSec: 0, teamAuthorId: null, remoteHandle: '+39 333 0000000',
  errorCode: null, occurredAt: '2026-11-07T10:51:00.000Z',
};
const EARLIER = { ...MISSED, id: 'k0', direction: 'outbound', sync: 'completed', durationSec: 120, occurredAt: '2026-11-05T09:00:00.000Z' };

async function render({ timeline, calls }) {
  const client = {
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      if (path.includes('/customer-hub/card/')) return CARD;
      if (path.includes('/customer-hub/timeline/')) return timeline;
      if (path.startsWith('/api/customer-data/profile/')) throw Object.assign(new Error('no profile'), { status: 404 });
      if (path.startsWith('/api/customer-data/enriched/')) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (path.startsWith('/api/call-intelligence/calls/')) return calls;
      if (path === '/api/customer-data/fields') return { definitions: [] };
      if (path.startsWith('/api/customer-data/fields/values')) return { values: [] };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/schema') return { pipelineContract: 1, pipelines: [] };
      if (path.startsWith('/api/connectors')) return { connectors: [] };
      throw new Error(`unexpected request ${path}`);
    },
  };
  const mount = createMount();
  await createCustomerCardView({ doc: createFakeDocument(), mount, client, spaceId: 's1' }).renderCard('contact', 'c1');
  return mount;
}

/**
 * Voce 2c1c0e149cf9: the «Chiamate» card is gone — the recap panel's
 * «Vista per» tabs paint its content instead (default vista: chiamate).
 * The box below is that recap section; the facts asserted stay the same.
 */
const callsSection = (mount) => mount.findAll('section')
  .find((node) => node.findAll('h4').some((h) => h.textContent.startsWith('✦ Recap')));

test('619b477c0464: a missed call in the cronologia is a call in the Chiamate box, never «nessuna chiamata»', async () => {
  const mount = await render({ timeline: timelineWith([MISSED, EARLIER]), calls: { calls: [] } });
  const box = callsSection(mount);
  assert.ok(box, 'the Chiamate box renders');
  assert.ok(!box.textContent.includes('Nessuna chiamata registrata'), `no «nessuna chiamata» (${box.textContent})`);
  assert.ok(box.textContent.includes('ultima chiamata · in entrata · 7 nov 2026 · persa'), `the missed call is named (${box.textContent})`);
  assert.ok(box.textContent.includes('Nessuna registrazione per questa chiamata'), 'and says why there is no transcript');
  assert.ok(box.textContent.includes('+ 1 chiamate precedenti'), 'the earlier call is counted');
  assert.ok(mount.textContent.includes('chiamata in entrata'), 'the cronologia still shows it');
});

test('619b477c0464: with no call anywhere the box still says so', async () => {
  const mount = await render({ timeline: timelineWith([]), calls: { calls: [] } });
  assert.ok(callsSection(mount).textContent.includes('Nessuna chiamata registrata'));
});

test('619b477c0464: a recorded call keeps its own summary first', async () => {
  const calls = { calls: [{ callRef: 'r1', channel: 'phone', recordedAt: '2026-11-08T10:00:00.000Z', summary: 'Budget 800 euro.', signals: [], transcript: { available: false, reason: 'non disponibile' } }] };
  const mount = await render({ timeline: timelineWith([MISSED]), calls });
  const text = callsSection(mount).textContent;
  assert.ok(text.includes('Budget 800 euro.'), 'the recording leads');
  assert.ok(!text.includes('Nessuna registrazione per questa chiamata'));
});
