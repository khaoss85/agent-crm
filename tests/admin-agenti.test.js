// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_AUTONOMY_LABEL,
  DA_FARE_DISABLED_NOTE,
  PHRASE_UNCLEAR_NOTE,
  buildAgentCards,
  buildCatalogItems,
  buildDaFare,
  createAgentiView,
  describeSchedule,
  findMentionedAgent,
  renderTeamAgentRows,
  spentThisMonthCents,
} from '../apps/admin/public/admin-agenti.js';
import { createAssistantPanel, ASSISTANT_STATUS_PATH } from '../apps/admin/public/admin-assistant.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';

/**
 * The «Agenti» screen (backlog:33782ba68747): «I tuoi agenti», «Da fare»
 * and «Catalogo», the Team rows and the «@Agente …» instruction from the
 * ⌘K panel. Pure builders first, then the views over the fake DOM with the
 * strict write gate (every write must carry a submission-owned key).
 */

const NOW = '2026-11-07T10:00:00.000Z';
const RIAGGANCIO = { id: 1, sourceKey: 'agent:presti:riaggancio', spaceId: 'presti', name: 'Riaggancio', role: 'Ricontatta i clienti', status: 'active' };
const REPORT = { id: 2, sourceKey: 'agent:presti:report-vendite', spaceId: 'presti', name: 'Report vendite', role: 'Riepilogo vendite', status: 'paused' };
const CATALOG = [
  { slug: 'riaggancio', name: 'Riaggancio', role: 'Ricontatta i clienti', instructions: 'Trova i clienti…', examplePhrase: 'occupati dei lead WhatsApp non contattati', agentSourceKey: 'agent:presti:riaggancio' },
  { slug: 'pulizia-contatti', name: 'Pulizia contatti', role: 'Tiene in ordine', instructions: 'Cerca doppioni…', examplePhrase: 'ogni venerdì controlla i doppioni', agentSourceKey: 'agent:presti:pulizia-contatti' },
];

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function textOf(node) {
  return node.textContent;
}

test('describeSchedule reads the stored machine schedule in Italian', () => {
  assert.equal(describeSchedule({ cadence: 'once' }), 'Una volta');
  assert.equal(describeSchedule({ cadence: 'daily', timeOfDay: '08:00' }), 'Ogni giorno alle 08:00');
  assert.equal(describeSchedule({ cadence: 'weekly', weekday: 1, timeOfDay: '08:00' }), 'Ogni lunedì alle 08:00');
  assert.equal(describeSchedule({ cadence: 'weekly', weekday: 9 }), 'Ogni settimana');
  assert.equal(describeSchedule({ cadence: 'monthly', timeOfDay: '09:30' }), 'Ogni mese alle 09:30');
  assert.equal(describeSchedule({ cadence: 'mystery' }), 'Quando non è chiaro');
});

test('spend this month follows the package rule: this UTC month, positive costs, by decidedAt', () => {
  const runs = [
    { agentSourceKey: RIAGGANCIO.sourceKey, decidedAt: '2026-11-02T08:00:00.000Z', costCents: 40 },
    { agentSourceKey: RIAGGANCIO.sourceKey, decidedAt: '2026-10-31T23:59:59.000Z', costCents: 999 },
    { agentSourceKey: RIAGGANCIO.sourceKey, startedAt: '2026-11-05T08:00:00.000Z', costCents: 2 },
    { agentSourceKey: RIAGGANCIO.sourceKey, decidedAt: '2026-11-05T08:00:00.000Z', costCents: 0, outcome: 'capped' },
    { agentSourceKey: REPORT.sourceKey, decidedAt: '2026-11-05T08:00:00.000Z', costCents: 50 },
  ];
  assert.equal(spentThisMonthCents(runs, RIAGGANCIO.sourceKey, NOW), 42);
});

test('agent cards carry status, the one true autonomy, spend, assignments and pending proposals', () => {
  const cards = buildAgentCards({
    agents: [RIAGGANCIO, REPORT, { sourceKey: '', name: 'senza chiave' }],
    assignments: [
      { sourceKey: 'a-1', agentSourceKey: RIAGGANCIO.sourceKey, phrase: 'occupati dei lead', cadence: 'once', status: 'active', decidedAt: '2026-11-06T09:00:00.000Z' },
      { sourceKey: 'a-2', agentSourceKey: RIAGGANCIO.sourceKey, phrase: 'ogni lunedì ricontrolla', cadence: 'weekly', weekday: 1, timeOfDay: '08:00', status: 'active', decidedAt: '2026-11-07T09:00:00.000Z' },
    ],
    runs: [{ agentSourceKey: RIAGGANCIO.sourceKey, decidedAt: '2026-11-06T09:01:00.000Z', costCents: 42, outcome: 'proposed', sourceKey: 'r-1' }],
    nowIso: NOW,
  });
  assert.equal(cards.length, 2, 'a row without a key never becomes a card');
  const [riaggancio, report] = cards;
  assert.equal(riaggancio.statusLabel, 'Attivo');
  assert.equal(report.statusLabel, 'In pausa');
  assert.equal(riaggancio.autonomy, AGENT_AUTONOMY_LABEL);
  assert.equal(riaggancio.spentLabel, '0,42 €');
  assert.equal(report.spentLabel, '0 €');
  assert.equal(riaggancio.pending, 1);
  assert.equal(riaggancio.initials, 'RI');
  assert.equal(report.initials, 'RV');
  assert.deepEqual(riaggancio.assignments.map((row) => row.phrase), ['ogni lunedì ricontrolla', 'occupati dei lead'], 'newest first');
  assert.equal(riaggancio.assignments[0].schedule, 'Ogni lunedì alle 08:00');
});

test('catalogue tiles say which ready-made agents are already in the team', () => {
  const items = buildCatalogItems({ catalog: CATALOG, agents: [RIAGGANCIO] });
  assert.deepEqual(items.map((item) => [item.slug, item.added]), [['riaggancio', true], ['pulizia-contatti', false]]);
});

test('Da fare lists only proposed runs, newest first, and flags unreadable proposals', () => {
  const items = buildDaFare({
    agents: [RIAGGANCIO],
    assignments: [{ sourceKey: 'a-1', phrase: 'occupati dei lead' }],
    runs: [
      { sourceKey: 'r-old', agentSourceKey: RIAGGANCIO.sourceKey, assignmentSourceKey: 'a-1', outcome: 'proposed', startedAt: '2026-11-05T08:00:00.000Z', proposals: JSON.stringify([{ action: 'send-message', payload: { summary: 'WhatsApp a Giulia' } }, { action: 'tag-customer', payload: {} }]) },
      { sourceKey: 'r-new', agentSourceKey: 'agent:sconosciuto', outcome: 'proposed', startedAt: '2026-11-06T08:00:00.000Z', proposals: '{not json' },
      { sourceKey: 'r-done', agentSourceKey: RIAGGANCIO.sourceKey, outcome: 'applied', startedAt: '2026-11-07T08:00:00.000Z' },
    ],
  });
  assert.deepEqual(items.map((item) => item.runSourceKey), ['r-new', 'r-old']);
  assert.equal(items[0].unreadable, true);
  assert.equal(items[0].agentName, 'Agente sconosciuto');
  assert.deepEqual(items[1].lines, ['WhatsApp a Giulia', 'tag-customer']);
  assert.equal(items[1].phrase, 'occupati dei lead');
});

test('@mention resolves the longest agent name, with or without spaces, never a prefix of a word', () => {
  const agents = [RIAGGANCIO, REPORT, { sourceKey: 'agent:presti:report', name: 'Report' }];
  assert.equal(findMentionedAgent('occupati dei lead', agents), null, 'not a mention');
  const plain = findMentionedAgent('@Riaggancio occupati dei lead WhatsApp non contattati', agents);
  assert.equal(plain?.agent?.sourceKey, RIAGGANCIO.sourceKey);
  assert.equal(plain?.instruction, 'occupati dei lead WhatsApp non contattati');
  assert.equal(findMentionedAgent('@report vendite ogni lunedì', agents)?.agent?.sourceKey, REPORT.sourceKey);
  assert.equal(findMentionedAgent('@ReportVendite, ogni lunedì', agents)?.instruction, 'ogni lunedì');
  assert.equal(findMentionedAgent('@Report ogni giorno', agents)?.agent?.sourceKey, 'agent:presti:report');
  const unknown = findMentionedAgent('@Riagganciox fai qualcosa', agents);
  assert.equal(unknown?.agent, null);
  assert.equal(unknown?.typedName, 'Riagganciox');
});

test('Team rows: nothing when there are no agents, an «Agente» badge beside each one otherwise', () => {
  const doc = createFakeDocument();
  assert.equal(renderTeamAgentRows(doc, null), null);
  assert.equal(renderTeamAgentRows(doc, []), null);
  const rows = renderTeamAgentRows(doc, [RIAGGANCIO, { ...REPORT, name: '<img src=x onerror=alert(1)>' }]);
  assert.ok(rows);
  const members = rows.findAll('div').filter((node) => node.classList.contains('bo-agent-member'));
  assert.equal(members.length, 2);
  assert.ok(textOf(members[0]).includes('Riaggancio'));
  assert.ok(textOf(members[0]).includes('Agente'));
  assert.equal(rows.findAll('img').length, 0, 'a hostile name stays text');
  assert.equal(members.some((node) => node.classList.contains('bo-spazi-member')), false, 'agents never count as people');
});

test('the #/agenti route resolves to the Agenti screen; anything under it is invalid', () => {
  assert.deepEqual(parseModuleRoute('#/agenti'), { view: 'agenti' });
  assert.equal(parseModuleRoute('#/agenti/x').view, 'invalid');
});

/** A drive over the three reads and the two writes, like the server. */
function driveClient({ composed = true, unclearFirst = false } = {}) {
  const calls = [];
  const agents = [{ ...RIAGGANCIO }];
  const assignments = [];
  const runs = [{
    sourceKey: 'r-1', agentSourceKey: RIAGGANCIO.sourceKey, assignmentSourceKey: 'a-0', outcome: 'proposed',
    startedAt: '2026-11-06T09:01:00.000Z', decidedAt: '2026-11-06T09:01:00.000Z', costCents: 42,
    proposals: JSON.stringify([{ action: 'send-message', payload: { summary: 'WhatsApp a Giulia Romano' } }]),
  }];
  let refusedOnce = false;
  return {
    calls,
    agents,
    assignments,
    request: async (path, options = {}) => {
      enforceAdminWriteGate(path, options);
      const method = String(options.method ?? 'GET').toUpperCase();
      const body = typeof options.body === 'string' && options.body !== '' ? JSON.parse(options.body) : options.body;
      calls.push({ path, method, body, key: options.idempotencyKey });
      if (path.startsWith('/api/agents/catalog')) {
        if (!composed) throw Object.assign(new Error('Operation not found'), { code: 'NOT_FOUND', status: 404 });
        return { agents: CATALOG };
      }
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: agents.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-assignment/records?')) return { items: assignments.map((row) => ({ ...row })) };
      if (path.startsWith('/api/modules/teammate-run/records?')) return { items: runs };
      if (path === '/api/agents/create' && method === 'POST') {
        const entry = CATALOG.find((item) => item.slug === body.slug);
        const existing = agents.find((row) => row.sourceKey === entry.agentSourceKey);
        if (existing) return { duplicate: true, agent: existing };
        const agent = { id: agents.length + 1, sourceKey: entry.agentSourceKey, spaceId: body.spaceId, name: entry.name, role: entry.role, status: 'active' };
        agents.push(agent);
        return { duplicate: false, agent };
      }
      if (path === '/api/agents/assign' && method === 'POST') {
        if (unclearFirst && !refusedOnce && !body.plan) {
          refusedOnce = true;
          throw Object.assign(new Error('This phrase does not name a schedule'), { code: 'AGENT_PHRASE_UNCLEAR', status: 422 });
        }
        const assignment = {
          sourceKey: body.sourceKey, agentSourceKey: body.agentSourceKey, phrase: body.phrase,
          cadence: body.plan ? body.plan.cadence : 'weekly', weekday: 1, timeOfDay: '08:00', status: 'active', decidedAt: NOW,
        };
        assignments.push(assignment);
        return { duplicate: false, assignment };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
}

function findButton(mount, action) {
  return mount.querySelector(`button[data-action="${action}"]`);
}

test('the screen paints I tuoi agenti, Da fare with honest disabled controls, and the catalogue', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient();
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  const text = textOf(mount);
  for (const heading of ['Agenti', 'I tuoi agenti', 'Da fare', 'Catalogo']) assert.ok(text.includes(heading), heading);
  assert.ok(text.includes('Riaggancio'));
  assert.ok(text.includes(AGENT_AUTONOMY_LABEL));
  assert.ok(text.includes('0,42 €'), 'the spend comes from the run rows');
  assert.ok(text.includes('WhatsApp a Giulia Romano'));
  assert.ok(text.includes(DA_FARE_DISABLED_NOTE));
  for (const action of ['approve', 'edit', 'reject']) {
    const button = findButton(mount, action);
    assert.ok(button, action);
    assert.equal(button.disabled, true, `${action} stays disabled: no operation is wired`);
  }
  assert.ok(text.includes('Nel tuo team'), 'the catalogue marks the agent already added');
  assert.ok(mount.querySelector('a[href="#/sequenze"]'), 'the old Sequenze stay reachable');
  assert.ok(client.calls.every((call) => call.method === 'GET'), 'painting writes nothing');
  assert.ok(client.calls.filter((call) => call.path.startsWith('/api/modules/')).every((call) => call.path.includes('filter.spaceId=presti')));
});

test('Aggiungi adds a catalogue agent through one keyed POST and the team shows it', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient();
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  const add = mount.querySelector('button[data-slug="pulizia-contatti"]');
  assert.ok(add);
  add.dispatch('click', {});
  await flush();
  const posts = client.calls.filter((call) => call.path === '/api/agents/create');
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].body, { spaceId: 'presti', slug: 'pulizia-contatti' });
  assert.equal(typeof posts[0].key, 'string');
  const text = textOf(mount);
  assert.ok(text.includes('Pulizia contatti è entrato nel tuo team.'));
  assert.equal(mount.querySelector('article[data-agent="agent:presti:pulizia-contatti"]') !== null, true);
  assert.equal(mount.querySelector('button[data-slug="pulizia-contatti"]'), null, 'the tile now says Nel tuo team');
});

test('talking to an agent: a scheduled phrase becomes an assignment, an unclear one asks before «una volta, adesso»', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({ unclearFirst: true });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  const input = mount.querySelector(`input[name="talk-${RIAGGANCIO.sourceKey}"]`);
  input.value = 'occupati dei lead WhatsApp non contattati';
  input.dispatch('input', {});
  mount.querySelector('form').dispatch('submit', {});
  await flush();
  let posts = client.calls.filter((call) => call.path === '/api/agents/assign');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.plan, undefined, 'the screen never picks a plan on its own');
  assert.ok(textOf(mount).includes(PHRASE_UNCLEAR_NOTE));
  findButton(mount, 'once').dispatch('click', {});
  await flush();
  posts = client.calls.filter((call) => call.path === '/api/agents/assign');
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].body.plan, { cadence: 'once', runAt: NOW });
  assert.equal(posts[1].body.phrase, 'occupati dei lead WhatsApp non contattati');
  assert.notEqual(posts[0].key, posts[1].key, 'a different body takes a new key');
  const text = textOf(mount);
  assert.ok(text.includes('Incarico dato a Riaggancio: una volta.'));
  assert.ok(text.includes('«occupati dei lead WhatsApp non contattati»'));
});

test('without the agents package the screen says so, and writes nothing', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({ composed: false });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  assert.ok(textOf(mount).includes('Gli agenti non sono attivi in questo spazio'));
  assert.equal(client.calls.length, 1);
});

test('hostile agent names and proposals render as inert text', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient();
  client.agents[0].name = '<script>alert(1)</script>';
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  assert.equal(mount.findAll('script').length, 0);
  assert.ok(textOf(mount).includes('<script>alert(1)</script>'));
});

function assistantClient(agents, { unclearFirst = false } = {}) {
  const drive = driveClient({ unclearFirst });
  drive.agents.splice(0, drive.agents.length, ...agents);
  return {
    calls: drive.calls,
    request: async (path, options = {}) => {
      if (path === ASSISTANT_STATUS_PATH) return { freeQuestions: 'disabled' };
      return drive.request(path, options);
    },
  };
}

test('⌘K «@Riaggancio …» asks for one confirm, then gives the agent the instruction', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = assistantClient([RIAGGANCIO], { unclearFirst: true });
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti' });
  await panel.open('oggi', null, null, '@Riaggancio occupati dei lead WhatsApp non contattati');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'confirm');
  assert.ok(textOf(mount).includes('Incarico per Riaggancio: «occupati dei lead WhatsApp non contattati»'));
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing is written before the confirm');
  findButton(mount, 'agent-assign').dispatch('click', {});
  await flush();
  assert.equal(panel.getState().mentionStatus, 'unclear');
  findButton(mount, 'agent-once').dispatch('click', {});
  await flush();
  const posts = client.calls.filter((call) => call.path === '/api/agents/assign');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.agentSourceKey, RIAGGANCIO.sourceKey);
  assert.equal(posts[1].body.spaceId, 'presti');
  assert.equal(posts[1].body.plan.cadence, 'once');
  assert.equal(panel.getState().mentionStatus, 'done');
  assert.ok(mount.querySelector('a[href="#/agenti"]'));
});

test('⌘K «@Nome» of nobody lists the team agents; a chip re-asks with the same instruction', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = assistantClient([RIAGGANCIO]);
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti' });
  await panel.open('oggi', null, null, '@Riagancio occupati dei lead');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'unknown');
  const chip = mount.findAll('button').find((node) => node.textContent === '@Riaggancio');
  assert.ok(chip);
  chip.dispatch('click', {});
  await flush();
  assert.equal(panel.getState().mentionStatus, 'confirm');
  assert.ok(textOf(mount).includes('«occupati dei lead»'));
});

test('⌘K «@…» without the agents package says the agents are not available yet', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = {
    calls: [],
    request: async (path) => {
      if (path === ASSISTANT_STATUS_PATH) return { freeQuestions: 'disabled' };
      throw Object.assign(new Error('Module not found'), { code: 'NOT_FOUND', status: 404 });
    },
  };
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti' });
  await panel.open('oggi', null, null, '@Riaggancio occupati dei lead');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'unavailable');
  assert.ok(textOf(mount).includes('Gli agenti non sono ancora disponibili in questo spazio.'));
});
