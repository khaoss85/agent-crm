// backlog:1f7cb20d3c30 — VERIFIER_BACK repro: dopo «@Prov» la barra mostrava
// solo «Chiedi all'assistente», nessun suggerimento di agente (neanche per
// quelli del catalogo). La @ si concludeva solo a mano, e l'agente creato a
// mano restava di fatto non incaricabile dalla barra. Cura: le query che
// iniziano con @ elencano gli agenti dello spazio che corrispondono, con
// l'assistente sempre come ultima riga esplicita.
import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCommandRows } from '../apps/admin/public/admin-cmdk.js';
import { buildShellNav, createShellView } from '../apps/admin/public/admin-shell.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const CUSTOM_AGENT = {
  sourceKey: 'custom-agent:prova:01kax7q2e9m4t6z8w0b2d4f6h8j',
  spaceId: 'prova',
  name: 'Prova verifica 44',
  role: 'Fa gli auguri ai clienti',
  instructions: 'Ogni mattina guarda chi compie gli anni.',
  status: 'active',
};
const CATALOG_AGENT = {
  sourceKey: 'agent:prova:pulizia-contatti',
  spaceId: 'prova',
  name: 'Pulizia contatti',
  role: 'Tiene in ordine i clienti',
  instructions: 'Cerca doppioni.',
  status: 'active',
};

test('«@Prov» suggerisce l’agente creato a mano, con l’assistente come ultima riga', () => {
  const rows = buildCommandRows({ query: '@Prov', agents: [CUSTOM_AGENT, CATALOG_AGENT] });
  assert.equal(rows.length, 2, `solo l’agente che corrisponde più l’assistente: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].kind, 'agent');
  assert.equal(rows[0].label, '@Prova verifica 44');
  assert.equal(rows[0].group, 'Agenti');
  assert.equal(rows[1].kind, 'ask');
});

test('«@» da sola elenca gli agenti del team, fino al limite di righe', () => {
  const many = Array.from({ length: 8 }, (_, index) => ({
    sourceKey: `custom-agent:prova:chiave-${index}`,
    name: `Agente ${index}`,
    role: 'Aiuta',
  }));
  const rows = buildCommandRows({ query: '@', agents: many });
  const agents = rows.filter((row) => row.kind === 'agent');
  assert.equal(agents.length, 5, 'COMMAND_GROUP_LIMIT, non una pagina di risultati');
  assert.equal(rows[rows.length - 1].kind, 'ask', 'l’assistente resta l’ultima riga');
});

test('senza agenti (voce non composta) la @ va all’assistente come prima', () => {
  assert.deepEqual(buildCommandRows({ query: '@Prov' }).map((row) => row.kind), ['ask']);
  assert.deepEqual(buildCommandRows({ query: '@Prov', agents: null }).map((row) => row.kind), ['ask']);
});

test('righe senza nome o senza chiave non diventano suggerimenti; il tetto non nasconde', () => {
  const capped = { ...CUSTOM_AGENT, spendingCapCents: 1000 };
  const rows = buildCommandRows({
    query: '@Prova',
    agents: [{ name: '', sourceKey: 'custom-agent:prova:x' }, { name: 'Fantasma' }, null, capped],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].label, '@Prova verifica 44', 'l’agente con tetto si suggerisce comunque');
});

function shell({ agents = async () => [CUSTOM_AGENT, CATALOG_AGENT] } = {}) {
  const doc = createFakeDocument();
  doc.activeElement = null;
  const sidebar = createMount();
  const topbar = createMount();
  const seen = { navigate: [], asked: [], agentsReads: 0 };
  const winListeners = {};
  const win = { addEventListener: (type, handler) => { (winListeners[type] ??= []).push(handler); } };
  const items = buildShellNav({ pipelines: [{ name: 'vendite' }], agentsAvailable: true });
  const view = createShellView({
    doc,
    sidebar,
    topbar,
    spaces: [{ id: 'prova', name: 'Spazio di prova', initials: 'SP' }],
    user: { name: 'Operatore', email: 'op@example.it' },
    navigate: (hash) => seen.navigate.push(hash),
    onAiSubmit: (text) => seen.asked.push(text),
    commandSearch: {
      customers: async () => [],
      offers: async () => [],
      agents: async () => { seen.agentsReads += 1; return agents(); },
    },
    schedule: (fn) => { fn(); return 1; },
    win,
  });
  view.update({ items, activeScreenId: 'oggi', screenLabel: 'Oggi' });
  const input = () => topbar.findAll('input').find((node) => String(node.getAttribute('class')).includes('bo-ai-input'));
  const list = () => topbar.findAll('div').find((node) => node.getAttribute('role') === 'listbox');
  const options = () => {
    const box = list();
    if (!box || box.classList.contains('hidden')) return [];
    const out = [];
    const walk = (node) => { for (const child of node.childNodes) { if (child.getAttribute?.('role') === 'option') out.push(child); walk(child); } };
    walk(box);
    return out;
  };
  const type = async (text) => {
    input().value = text;
    input().dispatch('input', {});
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  };
  const key = (name) => {
    const event = { key: name, defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } };
    input().dispatch('keydown', event);
    return event;
  };
  return { view, seen, winListeners, input, list, options, type, key };
}

test('la barra suggerisce «@Prova verifica 44»: Invio lo completa, l’incarico va all’assistente', async () => {
  const s = shell();
  await s.type('@Prov');
  const rows = s.options();
  const agent = rows.find((row) => row.getAttribute('data-kind') === 'agent');
  assert.ok(agent, `il suggerimento agente c’è: ${rows.map((row) => row.textContent).join(' | ')}`);
  assert.ok(agent.textContent.includes('@Prova verifica 44'));
  assert.ok(s.list().textContent.includes('Agenti'), 'il gruppo Agenti si legge');
  const last = rows[rows.length - 1];
  assert.equal(last.getAttribute('data-kind'), 'ask', 'l’assistente resta l’ultima riga');
  s.key('Enter');
  assert.equal(s.input().value, '@Prova verifica 44 ', 'il suggerimento completa la @ nella barra');
  assert.ok(s.options().length > 0, 'la lista resta aperta per l’incarico');
  assert.deepEqual(s.seen.asked, [], 'scegliere non chiede ancora niente');
  await s.type('@Prova verifica 44 ogni lunedì prepara gli auguri');
  s.key('Enter');
  assert.deepEqual(s.seen.asked, ['@Prova verifica 44 ogni lunedì prepara gli auguri']);
});

test('la lettura agenti gira una volta mentre si digita, e il suo errore non blocca la @', async () => {
  const s = shell();
  await s.type('@Pr');
  await s.type('@Pro');
  await s.type('@Prov');
  assert.equal(s.seen.agentsReads, 1, 'la lettura si riusa come quella delle offerte');
  const failing = shell({ agents: async () => { throw Object.assign(new Error('no'), { status: 502, code: 'BAD_GATEWAY' }); } });
  await failing.type('@Prov');
  assert.ok(failing.list().textContent.includes('Non riesco a leggere gli agenti adesso'), failing.list().textContent);
  failing.key('Enter');
  assert.deepEqual(failing.seen.asked, ['@Prov'], 'senza agenti la @ va comunque all’assistente');
});
