// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  aiBlockOf,
  calendarRefusalText,
  createCalendarioView,
  isProviderDownError,
} from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:afa97ffe5a4d (production 18/11, live pilot a7bd751): the phrase
 * POST «30 minuti con daniele pelleri giovedì…» answered 502
 * LLM_PROVIDER_FAILED and the card said «Ricerca non riuscita. Riprova
 * più tardi.». A provider failure now retries the same POST once; past
 * the retry the card says the assistant is not answering and offers the
 * same manual form as the other AI blocks («Compila a mano»).
 */

const NOW = () => new Date('2026-11-10T08:00:00Z'); // Tuesday, same week as Thursday 12/11.
const PHRASE = 'trova 30 minuti con Marco giovedì';
const ROSTER = [
  { subject: 'marco', displayName: 'Marco', email: 'marco@example.it', role: 'member' },
];
const DRAFT = { teamMemberId: 'marco', startsAt: '2026-11-12T14:00:00.000Z' };

function providerClient({ failures = 0 } = {}) {
  const calls = [];
  let phrasePosts = 0;
  return {
    calls,
    phrasePosts: () => phrasePosts,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      const method = options.method ?? 'GET';
      calls.push({ path, method });
      if (path === '/api/spine/memberships') return { items: ROSTER };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path === '/api/appointments/phrase' && method === 'POST') {
        phrasePosts += 1;
        if (phrasePosts <= failures) {
          throw Object.assign(new Error('llm provider failed'), { status: 502, code: 'LLM_PROVIDER_FAILED' });
        }
        return { draft: { ...DRAFT }, dryRun: false, spaceId: 'test' };
      }
      if (path.startsWith('/api/appointments/team-week')) {
        const ids = new URL(path, 'http://stub.test').searchParams.get('teamMemberIds')?.split(',') ?? [];
        return { members: ids.map((id) => ({ teamMemberId: id, appointments: [] })) };
      }
      if (path.startsWith('/api/appointments/suggest-slots')) {
        const query = new URL(path, 'http://stub.test').searchParams;
        const ids = query.get('teamMemberIds')?.split(',') ?? [];
        const from = Date.parse(query.get('from') ?? '');
        const step = Number(query.get('slotMinutes')) * 60000;
        const slots = [];
        for (let at = from; at + step <= from + step * 4; at += step) {
          slots.push({ startsAt: new Date(at).toISOString(), endsAt: new Date(at + step).toISOString() });
        }
        return { members: ids.map((id) => ({ teamMemberId: id, slots })) };
      }
      if (path === '/api/appointments/propose' || path === '/api/appointments/confirm') {
        throw new Error(`no booking call expected: ${path}`);
      }
      throw Object.assign(new Error('not composed'), { status: 404, code: 'NOT_FOUND' });
    },
  };
}

const flush = async (rounds = 24) => {
  for (let round = 0; round < rounds; round += 1) await new Promise((resolve) => setImmediate(resolve));
};
const button = (mount, label) => mount.findAll('button').find((node) => node.textContent === label);

/** A fake document whose focus() tracks activeElement like a browser. */
function focusingDocument() {
  const doc = /** @type {any} */ (createFakeDocument());
  const create = doc.createElement;
  doc.createElement = (/** @type {string} */ tag) => {
    const node = create(tag);
    node.focus = () => { node.__focused = true; doc.activeElement = node; };
    return node;
  };
  return doc;
}

const isOpen = (mount) => {
  const pop = mount.findAll('div').find((node) => node.getAttribute('data-role') === 'manual-pop');
  return Boolean(pop) && !(pop.getAttribute('class') ?? '').split(' ').includes('hidden') && pop.getAttribute('hidden') === null;
};

async function askPhrase(client) {
  const doc = focusingDocument();
  const mount = createMount();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, now: NOW });
  await view.render();
  await flush();
  mount.querySelector('textarea[name="phrase"]').value = PHRASE;
  button(mount, 'Trova slot liberi').dispatch('click');
  await flush();
  return { doc, mount };
}

test('afa97ffe5a4d: the provider failure code and sentence', () => {
  assert.equal(isProviderDownError({ code: 'LLM_PROVIDER_FAILED' }), true);
  assert.equal(isProviderDownError({ code: 'LLM_OPERATION_TIMEOUT' }), false, 'only the provider failure retries the phrase POST');
  assert.equal(isProviderDownError(null), false);
  assert.equal(aiBlockOf({ code: 'LLM_PROVIDER_FAILED' }), 'down', 'the manual form is offered like the other blocks');
  assert.equal(
    calendarRefusalText({ code: 'LLM_PROVIDER_FAILED' }),
    'L’assistente non risponde in questo momento: riprova tra poco, oppure compila l’appuntamento a mano.',
  );
});

test('afa97ffe5a4d: one provider failure retries the POST and the draft lands', async () => {
  const client = providerClient({ failures: 1 });
  const { mount } = await askPhrase(client);
  assert.equal(client.phrasePosts(), 2, 'the same POST goes out twice, never more');
  assert.ok(mount.textContent.includes('Bozza pronta'), mount.textContent);
  assert.ok(!mount.textContent.includes('Ricerca non riuscita'), 'no generic failure after the retry lands');
  assert.ok((mount.querySelector('.cal-slots')?.findAll('span') ?? []).length > 0, 'free steps are proposed');
});

test('afa97ffe5a4d: two provider failures say the assistant is not answering with «Compila a mano»', async () => {
  const client = providerClient({ failures: 2 });
  const { doc, mount } = await askPhrase(client);
  assert.equal(client.phrasePosts(), 2, 'one retry only, then the card speaks');
  const card = mount.querySelector('.cal-ai');
  assert.ok(
    card.textContent.includes('L’assistente non risponde in questo momento: riprova tra poco, oppure compila l’appuntamento a mano.'),
    card.textContent,
  );
  assert.ok(!mount.textContent.includes('Ricerca non riuscita'), 'never the generic «Ricerca non riuscita»');
  const manual = button(mount, 'Compila a mano');
  assert.ok(manual, 'the card offers «Compila a mano»');
  manual.dispatch('click');
  await flush();
  assert.ok(isOpen(mount), 'the same manual form opens');
  assert.equal(mount.querySelector('input[name="notes"]').value, PHRASE, 'the phrase rides into the Note field');
  assert.equal(doc.activeElement, mount.querySelector('input[name="customerSearch"]'), 'focus lands on the form, first field');
});
