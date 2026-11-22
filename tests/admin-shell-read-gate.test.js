import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import {
  SHELL_MAX_IN_FLIGHT,
  createShellReadGate,
  loadClientCount,
  loadFixCount,
} from '../apps/admin/public/admin-shell.js';
import { loadOggiData } from '../apps/admin/public/admin-oggi.js';

// Voce e1b3d56730fa: i contatori della barra (doppioni, qualità dati,
// attività canali, permessi) partivano accanto alle letture della pagina —
// su un carico lento oltre il tetto di afterScreen le due ondate si
// sovrapponevano (dieci letture in volo contro un tetto di sei). Ora
// condividono la stessa coda: il picco totale resta dentro il tetto.

const OGGI_NOW = new Date('2026-10-19T07:00:00.000Z'); // 09:00 in Rome, Monday

/**
 * A raw client that tracks the combined in-flight peak across a macrotask
 * tick per read, so waves that truly overlap show their combined peak.
 * Serves the reads the page and the shell counters issue, like the seed
 * data of the 57994a8c7287 real-data peak test (eight appointments of
 * distinct customers to name, four automated notifications).
 */
function createPeakClient() {
  let inFlight = 0;
  let peak = 0;
  const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const appointments = Array.from({ length: 8 }, (_, index) => ({
    id: `appt-real-${index + 1}`,
    status: 'booked',
    subjectResource: 'lead',
    subjectId: `lead-real-${index + 1}`,
    subjectOwner: 'host',
    subjectLabel: `Cliente ${index + 1}`,
    startsAt: `2026-10-19T${String(8 + index).padStart(2, '0')}:00:00.000Z`,
  }));
  const messages = [1, 2, 3, 4].map((n) => ({
    id: `msg-auto-${n}`,
    channel: 'email',
    direction: 'inbound',
    conversationId: `conv-auto-${n}`,
    remoteHandle: `notifiche@cliente${n}.it`,
    subjectResource: 'contact',
    subjectId: `c-real-${n}`,
    subjectLabel: `Cliente ${n}`,
    occurredAt: '2026-10-18T15:00:00.000Z',
    body: 'La ricevuta del pagamento.',
  }));
  const conversations = [1, 2, 3, 4].map((n) => ({ id: `conv-auto-${n}`, status: 'open' }));
  const request = async (path, options = {}) => {
    enforceAdminWriteGate(path, options);
    inFlight += 1;
    if (inFlight > peak) peak = inFlight;
    try {
      await tick();
      if (path === '/api/schema') {
        return {
          domains: {
            work: {},
            appointments: {},
            channels: {},
            interactions: {},
            'customer-data': {},
            'site-forms': {},
          },
        };
      }
      if (path === '/api/profile') return { member: { email: 'op@palestra-esempio.it' } };
      if (path === '/api/spine/memberships') return { items: [] };
      if (path.startsWith('/api/customer-data/customers?')) {
        return { items: [], total: 7, totalIsExact: true, views: [] };
      }
      if (path.startsWith('/api/customer-data/profile/')) {
        const id = decodeURIComponent(path.split('/').pop() ?? '');
        return { identity: { contact: { firstName: 'Cliente', lastName: id } } };
      }
      if (path.startsWith('/api/space-permissions/effective')) return { overrides: [] };
      if (path.startsWith('/api/connectors/activity')) return { needsFix: 0 };
      if (path.startsWith('/api/modules/appointment/records')) return { items: appointments };
      if (path.startsWith('/api/modules/interaction-message/records')) return { items: messages };
      if (path.startsWith('/api/modules/conversation/records')) return { items: conversations };
      if (path.startsWith('/api/modules/')) return { items: [] };
      throw new Error(`unexpected read: ${path}`);
    } finally {
      inFlight -= 1;
    }
  };
  return { request, peak: () => peak };
}

test('e1b3d56730fa: shell counters share the page queue — combined peak within the ceiling', async () => {
  const raw = createPeakClient();
  // The one queue app.js hands to the Oggi screen and the shell counters.
  const shared = createShellReadGate(raw);
  assert.equal(SHELL_MAX_IN_FLIGHT, 6);

  const pagePromise = loadOggiData(shared, OGGI_NOW, { spaceId: 'spazio-test' });
  // The afterScreen-cap race: the counters start while the page still
  // reads, like the slow load the Mac measured — never beside the queue.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  const shellPromise = (async () => {
    const [fixes, clients] = await Promise.all([
      loadFixCount(shared, { spaceId: 'spazio-test' }),
      loadClientCount(shared),
    ]);
    const permissions = await shared.request('/api/space-permissions/effective?spaceId=spazio-test');
    return { fixes, clients, permissions };
  })();

  const [page, shell] = await Promise.all([pagePromise, shellPromise]);
  assert.ok(raw.peak() <= 6, `the shell + page peak stays within the ceiling (peak ${raw.peak()})`);
  assert.ok(page.appointmentsAvailable, 'the page still loads');
  assert.equal(Object.keys(page.appointmentNames).length, 8, 'every appointment customer is still named');
  assert.equal(typeof shell.fixes, 'number', 'the quality/duplicate/activity counters still answer');
  assert.deepEqual(shell.clients, { count: 7, exact: true }, 'the live client count still answers');
  assert.deepEqual(shell.permissions, { overrides: [] }, 'the space-master read still answers');
});

test('e1b3d56730fa: the shared queue caps at the ceiling and keeps flowing after a refusal', async () => {
  let inFlight = 0;
  let peak = 0;
  const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });
  const seen = [];
  const gated = createShellReadGate({
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      seen.push(path);
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      try {
        await tick();
        if (path === '/api/refused') {
          const error = new Error('Request failed (403)');
          error.status = 403;
          throw error;
        }
        return { ok: true };
      } finally {
        inFlight -= 1;
      }
    },
  }, 2);
  const outcomes = await Promise.allSettled([
    gated.request('/api/a'),
    gated.request('/api/refused'),
    gated.request('/api/b'),
    gated.request('/api/c'),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 3);
  const refused = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal(refused?.reason?.status, 403, 'a refused read still rejects to its own caller');
  assert.deepEqual(seen.length, 4, 'every queued read still runs');
  assert.ok(peak <= 2, `the queue caps the peak at its max (peak ${peak})`);
});
