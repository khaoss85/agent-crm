// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { aiBlockOf, calendarRefusalText, createCalendarioView } from '../apps/admin/public/admin-calendario.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';

/**
 * backlog:3771ac637027 (production, pilot f88eb0f, a test space with the AI
 * off): the phrase answered 503 LLM_SPACE_DISABLED and the card said «L'AI
 * è spenta in questo spazio: usa il modulo qui sotto.», but no form was
 * below — the manual form opens only from «Nuovo appuntamento ▾ › Compila
 * manualmente», top right. The card now says «AI spenta per questo spazio»
 * (or, on 429, «Hai raggiunto il tetto di spesa AI di oggi») with a
 * «Compila a mano» button that opens that same form and carries the phrase
 * into its Note field.
 */

const PHRASE = 'trova 45 minuti con Marco giovedì';

function refusingClient(error, { phraseAnswer = null } = {}) {
  const calls = [];
  return {
    calls,
    async request(path, options = {}) {
      enforceAdminWriteGate(path, options);
      calls.push(path);
      if (path === '/api/spine/memberships') return { items: [] };
      if (path === '/api/profile') return { member: null, connections: { available: false, items: [] } };
      if (path === '/api/appointments/phrase') {
        if (error) throw error;
        return phraseAnswer;
      }
      if (path.startsWith('/api/catalog/products')) return { products: [] };
      throw new Error(`unexpected path ${path}`);
    },
  };
}

async function settle() {
  for (let round = 0; round < 12; round += 1) await new Promise((resolve) => setImmediate(resolve));
}

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

async function askPhrase(client) {
  const doc = focusingDocument();
  const mount = createMount();
  const view = createCalendarioView({ searchDelayMs: 0, doc, mount, client, wait: () => Promise.resolve(), now: () => new Date('2026-10-21T06:00:00Z') });
  await view.render();
  await settle();
  const box = mount.querySelector('textarea[name="phrase"]');
  box.value = PHRASE;
  box.dispatch('input');
  mount.findAll('button').find((node) => node.textContent === 'Trova slot liberi').dispatch('click');
  await settle();
  return { doc, mount };
}

// backlog:6e6750ff8163: the form lives in its popover, hidden while closed.
const manualPop = (mount) => mount.findAll('div').find((node) => node.getAttribute('data-role') === 'manual-pop');
const isOpen = (mount) => {
  const pop = manualPop(mount);
  return Boolean(pop) && !(pop.getAttribute('class') ?? '').split(' ').includes('hidden') && pop.getAttribute('hidden') === null;
};

const CASES = [
  {
    code: 'LLM_SPACE_DISABLED', status: 503,
    line: 'AI spenta per questo spazio: puoi compilare l’appuntamento a mano.',
  },
  {
    code: 'LLM_DAILY_CAP_EXCEEDED', status: 429,
    line: 'Hai raggiunto il tetto di spesa AI di oggi: puoi compilare l’appuntamento a mano, o riprovare domani.',
  },
];

for (const { code, status, line } of CASES) {
  test(`3771ac637027: ${status} ${code} — «Compila a mano» opens the manual form with the phrase in the notes`, async () => {
    const error = Object.assign(new Error('Calendar phrase refused'), { status, code });
    const { doc, mount } = await askPhrase(refusingClient(error));
    const card = mount.querySelector('.cal-ai');
    assert.ok(card.textContent.includes(line), card.textContent);
    assert.ok(!mount.textContent.includes('qui sotto'), 'never a form «qui sotto» that is not there');
    assert.equal(isOpen(mount), false, 'the manual form starts closed, as in production');
    const button = card.findAll('button').find((node) => node.textContent === 'Compila a mano');
    assert.ok(button, 'the card offers «Compila a mano»');
    button.dispatch('click');
    assert.equal(isOpen(mount), true, 'the same manual form opens');
    const notes = mount.querySelector('input[name="notes"]');
    assert.equal(notes.value, PHRASE, 'the phrase rides into the Note field');
    const first = mount.querySelector('input[name="customerSearch"]');
    assert.equal(doc.activeElement, first, 'focus lands on the form, first field');
    assert.ok(!card.findAll('button').some((node) => node.textContent === 'Accendi l’AI' || node.textContent === "Accendi l'AI"),
      'no «Accendi l’AI»: no /bo screen switches the AI on');
  });
}

test('3771ac637027: a note the operator already wrote is never overwritten by the phrase', async () => {
  const error = Object.assign(new Error('Calendar phrase refused'), { status: 503, code: 'LLM_SPACE_DISABLED' });
  const { mount } = await askPhrase(refusingClient(error));
  const notes = mount.querySelector('input[name="notes"]');
  notes.value = 'porta il certificato';
  notes.dispatch('input');
  mount.findAll('button').find((node) => node.textContent === 'Compila a mano').dispatch('click');
  assert.equal(mount.querySelector('input[name="notes"]').value, 'porta il certificato');
});

test('3771ac637027: a phrase with no draft offers «Compila a mano» too, never «qui sotto»', async () => {
  const { mount } = await askPhrase(refusingClient(null, { phraseAnswer: { draft: null } }));
  assert.ok(mount.textContent.includes('Nessuna bozza dalla frase: riscrivila, o compila l’appuntamento a mano.'), mount.textContent);
  assert.ok(!mount.textContent.includes('qui sotto'));
  mount.findAll('button').find((node) => node.textContent === 'Compila a mano').dispatch('click');
  assert.equal(isOpen(mount), true);
});

test('3771ac637027: the refusal words and the block kind per code', () => {
  assert.equal(aiBlockOf({ code: 'LLM_SPACE_DISABLED' }), 'off');
  assert.equal(aiBlockOf({ code: 'LLM_SECRET_UNAVAILABLE' }), 'off');
  assert.equal(aiBlockOf({ code: 'LLM_DAILY_CAP_EXCEEDED' }), 'cap');
  assert.equal(aiBlockOf({ code: 'LLM_RATE_LIMITED' }), null, 'a provider rate limit is not the spend ceiling');
  assert.equal(aiBlockOf(null), null);
  assert.match(calendarRefusalText({ code: 'LLM_DAILY_CAP_EXCEEDED' }), /tetto di spesa AI di oggi/);
});
