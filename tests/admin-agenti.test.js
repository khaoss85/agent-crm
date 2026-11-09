// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { enforceAdminWriteGate } from './helpers/admin-strict-client.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';
import {
  AGENT_AUTONOMY_LABEL,
  AGENTS_IDLE_NOTE,
  DA_FARE_PENDING_NOTE,
  DA_FARE_UNAVAILABLE_NOTE,
  assignmentStatusLabel,
  PHRASE_UNCLEAR_NOTE,
  buildAgentCards,
  buildCatalogItems,
  buildDaFare,
  createAgentiView,
  describeSchedule,
  findMentionedAgent,
  renderTeamAgentRows,
  spentThisMonthCents,
  isDaFareRun,
  lastRunLine,
  isDecisionUnavailable,
} from '../apps/admin/public/admin-agenti.js';
import { rerendersOnSpaceSwitch } from '../apps/admin/public/admin-shell.js';
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
      { id: 'run-old', sourceKey: 'r-old', agentSourceKey: RIAGGANCIO.sourceKey, assignmentSourceKey: 'a-1', outcome: 'proposed', startedAt: '2026-11-05T08:00:00.000Z', proposals: JSON.stringify([{ action: 'send-message', payload: { summary: 'WhatsApp a Giulia' } }, { action: 'tag-customer', payload: {} }]) },
      { id: 'run-new', sourceKey: 'r-new', agentSourceKey: 'agent:sconosciuto', outcome: 'proposed', startedAt: '2026-11-06T08:00:00.000Z', proposals: '{not json' },
      { sourceKey: 'r-done', agentSourceKey: RIAGGANCIO.sourceKey, outcome: 'applied', startedAt: '2026-11-07T08:00:00.000Z' },
    ],
  });
  // backlog:31a76b6f19a3: the item carries the run's id, never its source key.
  assert.deepEqual(items.map((item) => item.runId), ['run-new', 'run-old']);
  // The source key stays beside the id (agent-crm#684 reads it).
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
function driveClient({ composed = true, unclearFirst = false, loseFirstAnswer = false, rows = null, onApprove = null, onReject = null, onRevise = null } = {}) {
  const calls = [];
  const agents = [{ ...RIAGGANCIO }];
  const assignments = [];
  const runs = [{
    id: '5f0c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f50',
    sourceKey: 'r-1', agentSourceKey: RIAGGANCIO.sourceKey, assignmentSourceKey: 'a-0', outcome: 'proposed',
    startedAt: '2026-11-06T09:01:00.000Z', decidedAt: '2026-11-06T09:01:00.000Z', costCents: 42,
    proposals: JSON.stringify([{ action: 'send-message', payload: { summary: 'WhatsApp a Giulia Romano' } }]),
  }];
  let refusedOnce = false;
  let lostOnce = false;
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
      if (path.startsWith('/api/modules/teammate-agent/records?')) return { items: rows ?? agents.map((row) => ({ ...row })) };
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
        // Like create-assignment: a known sourceKey replays, never doubles.
        const known = assignments.find((row) => row.sourceKey === body.sourceKey);
        if (known) return { duplicate: true, assignment: known };
        const assignment = {
          sourceKey: body.sourceKey, agentSourceKey: body.agentSourceKey, phrase: body.phrase,
          cadence: body.plan ? body.plan.cadence : 'weekly', weekday: 1, timeOfDay: '08:00', status: 'active', decidedAt: NOW,
        };
        assignments.push(assignment);
        if (loseFirstAnswer && !lostOnce) {
          lostOnce = true;
          throw Object.assign(new Error('network lost after commit'), { code: 'NETWORK', status: 0 });
        }
        return { duplicate: false, assignment };
      }
      if (path === '/api/agents/approve' && method === 'POST') {
        if (typeof onApprove === 'function') return onApprove(body, runs);
        const run = runs.find((row) => row.id === body.runId);
        if (run) run.outcome = 'applied';
        return { duplicate: false, run: { id: body.runId, outcome: 'applied' } };
      }
      if (path === '/api/agents/reject' && method === 'POST') {
        if (typeof onReject === 'function') return onReject(body, runs);
        const run = runs.find((row) => row.id === body.runId);
        if (run) run.outcome = 'rejected';
        return { duplicate: false, run: { id: body.runId, outcome: 'rejected' } };
      }
      if (path === '/api/agents/revise' && method === 'POST') {
        if (typeof onRevise === 'function') return onRevise(body, runs);
        const run = runs.find((row) => row.id === body.runId);
        const proposals = JSON.parse(run.proposals);
        proposals[body.index] = { ...proposals[body.index], payload: { ...proposals[body.index].payload, ...body.payload } };
        run.proposals = JSON.stringify(proposals);
        return { run: { id: body.runId, outcome: 'proposed' }, proposal: proposals[body.index] };
      }
      throw new Error(`unexpected request ${method} ${path}`);
    },
  };
}

function findButton(mount, action) {
  return mount.querySelector(`button[data-action="${action}"]`);
}

test('the screen paints I tuoi agenti, Da fare with Approva Modifica Rifiuta live, and the catalogue', async () => {
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
  for (const action of ['approve', 'edit', 'reject']) {
    const button = findButton(mount, action);
    assert.ok(button, action);
    assert.equal(button.disabled, false, `${action} is live (backlog:31a76b6f19a3)`);
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

test('review #661 P1: a retry after a lost answer reuses the same sourceKey and key — one incarico, not two', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({ loseFirstAnswer: true });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  const input = mount.querySelector(`input[name="talk-${RIAGGANCIO.sourceKey}"]`);
  input.value = 'ogni lunedì ricontrolla i lead';
  input.dispatch('input', {});
  mount.querySelector('form').dispatch('submit', {});
  await flush();
  // backlog:7cc35edab50c: the lost answer is a network fault (code NETWORK,
  // status 0), so it reads as a connection failure, never as a refusal.
  assert.ok(textOf(mount).includes('Connessione non riuscita, riprova.'));
  mount.querySelector('form').dispatch('submit', {});
  await flush();
  const posts = client.calls.filter((call) => call.path === '/api/agents/assign');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.sourceKey, posts[0].body.sourceKey, 'the retry keeps the assignment identity');
  assert.equal(posts[1].key, posts[0].key, 'the same body keeps its Idempotency-Key');
  assert.equal(client.assignments.length, 1, 'one user intent, one incarico');
  // A new phrase after success is a new intent with a new identity.
  input.value = 'ogni giorno controlla le offerte';
  const fresh = mount.querySelector(`input[name="talk-${RIAGGANCIO.sourceKey}"]`);
  fresh.value = 'ogni giorno controlla le offerte';
  fresh.dispatch('input', {});
  mount.querySelector('form').dispatch('submit', {});
  await flush();
  const after = client.calls.filter((call) => call.path === '/api/agents/assign');
  assert.notEqual(after[2].body.sourceKey, posts[0].body.sourceKey);
});

test('review #661 P2: ⌘K never posts to the space left behind; it resolves again in the active one', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = assistantClient([RIAGGANCIO]);
  let space = 'presti';
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => space });
  await panel.open('oggi', null, null, '@Riaggancio ogni lunedì ricontrolla i lead');
  await flush();
  assert.equal(panel.getState().mentionStatus, 'confirm');
  space = 'altro';
  findButton(mount, 'agent-assign').dispatch('click', {});
  await flush();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing posted for the old space');
  const reads = client.calls.filter((call) => call.path.startsWith('/api/modules/teammate-agent/records?'));
  assert.ok(reads.at(-1).path.includes('filter.spaceId=altro'), 'the agents are read again in the active space');
});

test('review #661 P1: ⌘K «Riprova» after a lost answer keeps the same sourceKey and key', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const drive = driveClient({ loseFirstAnswer: true });
  const client = {
    calls: drive.calls,
    request: async (path, options = {}) => (path === ASSISTANT_STATUS_PATH ? { freeQuestions: 'disabled' } : drive.request(path, options)),
  };
  const panel = createAssistantPanel({ doc, mount, client, navigate: () => {}, notify: () => {}, spaceId: () => 'presti' });
  await panel.open('oggi', null, null, '@Riaggancio ogni lunedì ricontrolla i lead');
  await flush();
  findButton(mount, 'agent-assign').dispatch('click', {});
  await flush();
  assert.equal(panel.getState().mentionStatus, 'error');
  findButton(mount, 'agent-retry').dispatch('click', {});
  await flush();
  const posts = drive.calls.filter((call) => call.path === '/api/agents/assign');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].body.sourceKey, posts[0].body.sourceKey);
  assert.equal(posts[1].key, posts[0].key);
  assert.equal(drive.assignments.length, 1);
  assert.equal(panel.getState().mentionStatus, 'done');
});

test('review #661 P3: «capped» needs a row past the page; an unreadable clock counts no spend', async () => {
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1, sourceKey: `agent:presti:a${i}`, spaceId: 'presti', name: `Agente ${i}`, status: 'active' }));
  for (const [count, capped] of [[200, false], [201, true]]) {
    const doc = createFakeDocument();
    const mount = createMount();
    const client = driveClient({ rows: many(count) });
    const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
    await view.render();
    await flush();
    assert.equal(view.state.capped, capped, `${count} rows`);
    assert.ok(view.state.agents.length <= 200);
    assert.ok(client.calls.some((call) => call.path.includes('limit=201')));
  }
  const runs = [{ agentSourceKey: 'a', decidedAt: '2026-11-02T08:00:00.000Z', costCents: 40 }];
  assert.equal(spentThisMonthCents(runs, 'a', 'not-a-date'), 0);
});

test('review #661 giro 2 P2: the card counter and Da fare agree — a proposed run without a key counts nowhere', () => {
  const runs = [
    { agentSourceKey: RIAGGANCIO.sourceKey, outcome: 'proposed', startedAt: '2026-11-06T09:00:00.000Z', proposals: '[]' },
    { sourceKey: 'r-ok', agentSourceKey: RIAGGANCIO.sourceKey, outcome: 'proposed', startedAt: '2026-11-06T10:00:00.000Z', proposals: '[]' },
  ];
  const [card] = buildAgentCards({ agents: [RIAGGANCIO], runs, nowIso: NOW });
  const items = buildDaFare({ agents: [RIAGGANCIO], runs });
  assert.equal(card.pending, items.length);
  assert.equal(card.pending, 1);
  assert.equal(isDaFareRun(runs[0]), false);
});

test('review #661 giro 2 P2: after a space switch the screen never writes to the space left behind', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient();
  let space = 'presti';
  const view = createAgentiView({ doc, mount, client, spaceId: () => space, now: () => NOW });
  await view.render();
  await flush();
  const input = mount.querySelector(`input[name="talk-${RIAGGANCIO.sourceKey}"]`);
  input.value = 'ogni lunedì ricontrolla i lead';
  input.dispatch('input', {});
  space = 'altro';
  mount.querySelector('form').dispatch('submit', {});
  await flush();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'nothing posted for the old space');
  assert.equal(view.state.space, 'altro', 'the screen repainted on the active space');
  const add = mount.querySelector('button[data-slug="pulizia-contatti"]');
  space = 'terzo';
  add.dispatch('click', {});
  await flush();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0);
  assert.equal(view.state.space, 'terzo');
});

test('review #661 giro 2 P2: switching space re-renders Agenti and Sequenze like the other space-scoped screens', () => {
  for (const view of ['agenti', 'sequenze', 'customer-card', 'sync']) assert.equal(rerendersOnSpaceSwitch(view), true, view);
  assert.equal(rerendersOnSpaceSwitch('dashboard', { mounted: true }), true);
  assert.equal(rerendersOnSpaceSwitch('dashboard'), false);
  assert.equal(rerendersOnSpaceSwitch('reporting'), false);
});

test('review #661 giro 2 P3: out-of-range times, a bare «@» and parsed proposal arrays', () => {
  assert.equal(describeSchedule({ cadence: 'daily', timeOfDay: '99:99' }), 'Ogni giorno');
  assert.equal(findMentionedAgent('@', [RIAGGANCIO]), null);
  assert.equal(findMentionedAgent('@   ', [RIAGGANCIO]), null);
  const [parsed, odd] = buildDaFare({
    agents: [RIAGGANCIO],
    runs: [
      { sourceKey: 'r-a', agentSourceKey: RIAGGANCIO.sourceKey, outcome: 'proposed', startedAt: '2026-11-06T10:00:00.000Z', proposals: [{ action: 'send', payload: { summary: 'Ciao Giulia' } }] },
      { sourceKey: 'r-b', agentSourceKey: RIAGGANCIO.sourceKey, outcome: 'proposed', startedAt: '2026-11-06T09:00:00.000Z', proposals: 42 },
    ],
  });
  assert.deepEqual(parsed.lines, ['Ciao Giulia']);
  assert.equal(odd.unreadable, true);
});

const RUN_ID = '5f0c2a4e-1b2c-4d3e-8f9a-0b1c2d3e4f50';

test('31a76b6f19a3: Approva sends the run id once, shows «Approvo…», then the Italian outcome', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  /** @type {null | ((value: any) => void)} */
  let answer = null;
  const client = driveClient({
    onApprove: (body, runs) => new Promise((resolve) => {
      answer = (value) => { runs[0].outcome = 'applied'; resolve(value); };
    }),
  });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  const row = mount.querySelector(`article[data-run="${RUN_ID}"]`);
  assert.ok(row, 'the Da fare row names the run id');
  findButton(mount, 'approve').dispatch('click');
  findButton(mount, 'approve').dispatch('click');
  await flush();
  const posts = client.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, 'a double click sends one request');
  assert.equal(posts[0].path, '/api/agents/approve');
  assert.deepEqual(posts[0].body, { spaceId: 'presti', runId: RUN_ID }, 'the run id, never r-1');
  assert.ok(posts[0].key, 'the write carries a submission key');
  const busy = findButton(mount, 'approve');
  assert.equal(busy.textContent, 'Approvo…');
  assert.equal(busy.disabled, true, 'in corso: locked');
  answer({ duplicate: false, run: { id: RUN_ID, outcome: 'applied' } });
  await flush();
  assert.ok(mount.textContent.includes('Approvato: la proposta di Riaggancio è applicata.'));
  assert.equal(mount.querySelector(`article[data-run="${RUN_ID}"]`), null, 'the applied run leaves Da fare');
});

test('31a76b6f19a3: a queued approval reads neutral («Non ancora confermato»), never as an error, and stays locked', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({
    onApprove: () => { throw Object.assign(new Error('Agent write pending'), { code: 'BO_AGENT_PENDING', status: 504 }); },
  });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'approve').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes(DA_FARE_PENDING_NOTE), 'the neutral line');
  assert.equal(mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '').includes('bo-seq-error')).length, 0,
    'no error line');
  assert.equal(findButton(mount, 'approve').disabled, true, 'locked: a second click would queue a second approval');
  findButton(mount, 'approve').dispatch('click');
  await flush();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1);
  assert.ok(findButton(mount, 'reload-dafare'), 'Ricarica reads the list again');
});

test('31a76b6f19a3: a refused approval says why in Italian and lets the operator try again', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let refuse = true;
  const client = driveClient({
    onApprove: (body, runs) => {
      if (refuse) throw Object.assign(new Error('Agent write refused'), { code: 'BO_AGENT_RUN_REFUSED', status: 400 });
      runs[0].outcome = 'applied';
      return { duplicate: true, run: { id: body.runId, outcome: 'applied' } };
    },
  });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'approve').dispatch('click');
  await flush();
  const error = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '').includes('bo-seq-error'));
  assert.ok(error && error.textContent !== '', 'an Italian error line');
  assert.ok(!/BO_|AGENT_/.test(error.textContent), 'never a raw code');
  assert.equal(findButton(mount, 'approve').disabled, false, 'free to try again');
  refuse = false;
  findButton(mount, 'approve').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes('La proposta di Riaggancio era già approvata.'));
});

test('31a76b6f19a3: Da fare no longer says the agents do not start, and a «niente da proporre» run shows on its assignment', async () => {
  assert.ok(!/non partono/.test(AGENTS_IDLE_NOTE), 'the old false sentence is gone');
  const runs = [
    { assignmentSourceKey: 'a-1', outcome: 'proposed', startedAt: '2026-11-06T08:00:00.000Z', decidedAt: '2026-11-06T08:00:00.000Z' },
    { assignmentSourceKey: 'a-1', outcome: 'artifact', startedAt: '2026-11-07T13:30:00.000Z', decidedAt: '2026-11-07T13:30:00.000Z' },
    { assignmentSourceKey: 'a-2', outcome: 'failed', startedAt: '2026-11-07T09:00:00.000Z' },
  ];
  assert.equal(lastRunLine(runs, 'a-1'), 'Ultimo giro: niente da proporre, 7 nov, 14:30');
  assert.equal(lastRunLine(runs, 'a-2'), 'Ultimo giro: non riuscito, 7 nov, 10:00');
  assert.equal(lastRunLine(runs, 'a-3'), null, 'an assignment that never ran says nothing');
  const cards = buildAgentCards({
    agents: [RIAGGANCIO],
    assignments: [{ sourceKey: 'a-1', agentSourceKey: RIAGGANCIO.sourceKey, phrase: 'occupati dei lead', cadence: 'daily', status: 'active' }],
    runs: runs.map((run) => ({ ...run, agentSourceKey: RIAGGANCIO.sourceKey })),
    nowIso: NOW,
  });
  assert.equal(cards[0].assignments[0].lastRun, 'Ultimo giro: niente da proporre, 7 nov, 14:30');
});

test('31a76b6f19a3: Rifiuta asks an optional reason, sends one request with the run id, then says it in Italian', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  /** @type {null | ((value: any) => void)} */
  let answer = null;
  const client = driveClient({
    onReject: (body, runs) => new Promise((resolve) => { answer = (value) => { runs[0].outcome = 'rejected'; resolve(value); }; }),
  });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'reject').dispatch('click');
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 0, 'Rifiuta first asks, never posts blind');
  const reason = mount.findAll('input').find((node) => node.getAttribute('aria-label') === 'Motivo del rifiuto (facoltativo)');
  reason.value = 'Cliente già contattato';
  reason.dispatch('input');
  findButton(mount, 'confirm-reject').dispatch('click');
  findButton(mount, 'confirm-reject').dispatch('click');
  await flush();
  const posts = client.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, 'a double click sends one request');
  assert.equal(posts[0].path, '/api/agents/reject');
  assert.deepEqual(posts[0].body, { spaceId: 'presti', runId: RUN_ID, reason: 'Cliente già contattato' });
  assert.equal(findButton(mount, 'confirm-reject').textContent, 'Rifiuto…', 'in corso');
  answer({ duplicate: false, run: { id: RUN_ID, outcome: 'rejected' } });
  await flush();
  assert.ok(mount.textContent.includes('Rifiutata: la proposta di Riaggancio non sarà applicata.'));
  assert.equal(mount.querySelector(`article[data-run="${RUN_ID}"]`), null, 'the refused run leaves Da fare');
});

test('31a76b6f19a3: Modifica edits the proposal text and sends index and payload; the run keeps waiting', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient();
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'edit').dispatch('click');
  const area = mount.findAll('textarea').find((node) => node.getAttribute('data-proposal') === '0');
  assert.equal(area.value, 'WhatsApp a Giulia Romano', 'the editor starts from the proposal text');
  area.value = 'WhatsApp a Giulia: ti va di riprovare giovedì?';
  area.dispatch('input');
  findButton(mount, 'save-edit').dispatch('click');
  findButton(mount, 'save-edit').dispatch('click');
  await flush();
  const posts = client.calls.filter((call) => call.method === 'POST');
  assert.equal(posts.length, 1, 'one request');
  assert.equal(posts[0].path, '/api/agents/revise');
  assert.deepEqual(posts[0].body, { spaceId: 'presti', runId: RUN_ID, index: 0, payload: { summary: 'WhatsApp a Giulia: ti va di riprovare giovedì?' } });
  assert.ok(mount.textContent.includes('Modifica salvata: la proposta di Riaggancio aspetta ancora il tuo ok.'));
  assert.ok(mount.querySelector(`article[data-run="${RUN_ID}"]`), 'the run stays in Da fare');
  assert.ok(mount.textContent.includes('WhatsApp a Giulia: ti va di riprovare giovedì?'), 'with the edited text');
});

test('31a76b6f19a3: a deployment without the route (405 or 404) reads «Non ancora disponibile», never a technical error', async () => {
  for (const [kind, status] of [['reject', 405], ['revise', 404], ['approve', 405]]) {
    const doc = createFakeDocument();
    const mount = createMount();
    // What the routers answer for a route they do not have (review #688).
    const refuse = () => {
      throw status === 404
        ? Object.assign(new Error('Route not found'), { status, code: 'NOT_FOUND' })
        : Object.assign(new Error('Method POST is not mounted here'), { status, code: 'ADMIN_METHOD_NOT_ALLOWED' });
    };
    const client = driveClient({ onApprove: refuse, onReject: refuse, onRevise: refuse });
    const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
    await view.render();
    await flush();
    if (kind === 'approve') {
      findButton(mount, 'approve').dispatch('click');
    } else if (kind === 'reject') {
      findButton(mount, 'reject').dispatch('click');
      findButton(mount, 'confirm-reject').dispatch('click');
    } else {
      findButton(mount, 'edit').dispatch('click');
      findButton(mount, 'save-edit').dispatch('click');
    }
    await flush();
    assert.ok(mount.textContent.includes(DA_FARE_UNAVAILABLE_NOTE), `${kind}: the neutral line`);
    assert.equal(mount.findAll('p').filter((node) => (node.getAttribute('class') ?? '').includes('bo-seq-error')).length, 0,
      `${kind}: no error line`);
    assert.ok(!/405|404|METHOD|NOT_FOUND/.test(mount.textContent), `${kind}: no technical text`);
  }
});

test('31a76b6f19a3: a queued refusal reads neutral and stays locked', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({
    onReject: () => { throw Object.assign(new Error('Agent write pending'), { code: 'BO_AGENT_PENDING', status: 504 }); },
  });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'reject').dispatch('click');
  findButton(mount, 'confirm-reject').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes(DA_FARE_PENDING_NOTE));
  for (const action of ['approve', 'edit', 'reject']) assert.equal(findButton(mount, action).disabled, true, `${action} locked`);
});

test('31a76b6f19a3: an assignment reads «Attivo» once it ran or recurs with a next run, «In attesa di partire» only if it never started', () => {
  const runs = [{ assignmentSourceKey: 'a-ran', outcome: 'artifact' }];
  assert.equal(assignmentStatusLabel({ sourceKey: 'a-ran', status: 'active', cadence: 'once' }, runs), 'Attivo', 'it ran');
  assert.equal(assignmentStatusLabel({ sourceKey: 'a-weekly', status: 'active', cadence: 'weekly', nextRunAt: '2026-11-10T07:00:00.000Z' }, runs),
    'Attivo', 'recurring with its next run scheduled');
  assert.equal(assignmentStatusLabel({ sourceKey: 'a-once', status: 'active', cadence: 'once', nextRunAt: '2026-11-10T07:00:00.000Z' }, runs),
    'In attesa di partire', 'a one-off that never ran');
  assert.equal(assignmentStatusLabel({ sourceKey: 'a-new', status: 'active', cadence: 'weekly' }, runs), 'In attesa di partire', 'nothing scheduled, never ran');
  assert.equal(assignmentStatusLabel({ sourceKey: 'a-done', status: 'completed' }, runs), 'Fatto');
  assert.equal(assignmentStatusLabel({ sourceKey: 'a-p', status: 'paused' }, runs), 'In pausa');
});

test('review #688 P1: an answer that lands after a space switch is dropped, never painted on the space now shown', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let space = 'presti';
  /** @type {null | ((value: any) => void)} */
  let answer = null;
  const client = driveClient({ onApprove: () => new Promise((resolve) => { answer = resolve; }) });
  const view = createAgentiView({ doc, mount, client, spaceId: () => space, now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'approve').dispatch('click');
  await flush();
  assert.ok(answer, 'the approval is in flight');
  space = 'altro';
  answer({ duplicate: false, run: { id: RUN_ID, outcome: 'applied' } });
  await flush();
  assert.equal(view.state.space, 'altro', 'the active space is painted');
  assert.ok(!mount.textContent.includes('Approvato'), 'the outcome of presti never lands on altro');
  assert.equal(view.state.notice, '');
  assert.ok([...view.state.decisions.values()].every((decision) => decision.busy === null && !decision.pending && decision.error === ''),
    'no decision state of presti is carried over');
});

test('review #688 P1: a queued decision stays locked across Ricarica until its run leaves «proposed», with no second request', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({
    onApprove: () => { throw Object.assign(new Error('Agent write pending'), { code: 'BO_AGENT_PENDING', status: 504 }); },
  });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'approve').dispatch('click');
  await flush();
  const firstKey = client.calls.find((call) => call.method === 'POST').key;
  findButton(mount, 'reload-dafare').dispatch('click');
  await flush();
  assert.ok(mount.textContent.includes(DA_FARE_PENDING_NOTE), 'still «Non ancora confermato» after the reload');
  assert.equal(findButton(mount, 'approve').disabled, true, 'still locked');
  findButton(mount, 'approve').dispatch('click');
  await flush();
  assert.equal(client.calls.filter((call) => call.method === 'POST').length, 1, 'no second approval while the first is queued');
  assert.equal(view.state.queued.get(RUN_ID)?.keys.get('approve'), firstKey, 'its key is kept');
  // The worker applied it: the next read finds the run applied and forgets the queue.
  const { items: runs } = await client.request('/api/modules/teammate-run/records?filter.spaceId=presti', {});
  runs[0].outcome = 'applied';
  await view.render();
  await flush();
  assert.equal(view.state.queued.size, 0, 'a settled run leaves the queue');
  assert.equal(mount.querySelector(`article[data-run="${RUN_ID}"]`), null);
});

test('review #688 P2: Modifica edits the very field the row shows', async () => {
  const items = buildDaFare({
    agents: [RIAGGANCIO],
    runs: [{ id: 'run-x', sourceKey: 'r-x', agentSourceKey: RIAGGANCIO.sourceKey, outcome: 'proposed', startedAt: NOW,
      proposals: JSON.stringify([{ action: 'invia', payload: { summary: 'WhatsApp a Giulia', text: 'Ciao Giulia, ti va giovedì?' } }]) }],
  });
  assert.equal(items[0].lines[0], 'WhatsApp a Giulia');
  assert.deepEqual(items[0].edits[0], { index: 0, field: 'summary', value: 'WhatsApp a Giulia' }, 'the editor opens the shown field');
});

test('review #688 P2: only a missing route reads «Non ancora disponibile»; a gone run is said and the list is read again', async () => {
  assert.equal(isDecisionUnavailable({ status: 405, code: 'ADMIN_METHOD_NOT_ALLOWED' }), true);
  assert.equal(isDecisionUnavailable({ status: 404, code: 'NOT_FOUND', message: 'Route not found' }), true);
  assert.equal(isDecisionUnavailable({ status: 404 }), true, 'no domain code');
  assert.equal(isDecisionUnavailable({ status: 404, code: 'BO_AGENT_ROUTE_UNKNOWN' }), true);
  assert.equal(isDecisionUnavailable({ status: 404, code: 'BO_AGENT_DECISION_UNAVAILABLE' }), true);
  assert.equal(isDecisionUnavailable({ status: 404, code: 'AGENT_RUN_UNKNOWN' }), false, 'an AGENT_ refusal is never hidden');
  assert.equal(isDecisionUnavailable({ status: 404, code: 'NOT_FOUND', message: 'teammate-run not found' }), false, 'a gone record is not a missing route');

  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({
    onApprove: (body, runs) => {
      runs.splice(0, runs.length);
      throw Object.assign(new Error('Agent write refused'), { status: 404, code: 'AGENT_RUN_UNKNOWN' });
    },
  });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'approve').dispatch('click');
  await flush();
  assert.ok(!mount.textContent.includes(DA_FARE_UNAVAILABLE_NOTE), 'not hidden as «non disponibile»');
  const error = mount.findAll('p').find((node) => (node.getAttribute('class') ?? '').includes('bo-seq-error'));
  assert.ok(error && error.textContent !== '' && !/AGENT_|404/.test(error.textContent), 'an Italian line, no code');
  assert.equal(mount.querySelector(`article[data-run="${RUN_ID}"]`), null, 'the list was read again: the stale row is gone');
});

test('review #688 P3: Modifica shows «Salvo…» while its edit flies', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  const client = driveClient({ onRevise: () => new Promise(() => {}) });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  findButton(mount, 'edit').dispatch('click');
  findButton(mount, 'save-edit').dispatch('click');
  await flush();
  assert.equal(findButton(mount, 'edit').textContent, 'Salvo…');
  assert.equal(findButton(mount, 'edit').getAttribute('aria-busy'), 'true');
});

test('review #688 giro 2 P1: a queued edit unlocks after Ricarica and a re-save of the same text reuses its key', async () => {
  const doc = createFakeDocument();
  const mount = createMount();
  let queue = true;
  const client = driveClient({
    onRevise: (body, runs) => {
      if (queue) throw Object.assign(new Error('Agent write pending'), { code: 'BO_AGENT_PENDING', status: 504 });
      return { run: { id: body.runId, outcome: 'proposed' } };
    },
  });
  const view = createAgentiView({ doc, mount, client, spaceId: () => 'presti', now: () => NOW });
  await view.render();
  await flush();
  const save = async (text) => {
    findButton(mount, 'edit').dispatch('click');
    const area = mount.findAll('textarea').find((node) => node.getAttribute('data-proposal') === '0');
    area.value = text;
    area.dispatch('input');
    findButton(mount, 'save-edit').dispatch('click');
    await flush();
  };
  await save('Ciao Giulia, giovedì alle 18?');
  assert.ok(mount.textContent.includes(DA_FARE_PENDING_NOTE), 'the edit is queued');
  assert.equal(findButton(mount, 'approve').disabled, true, 'locked while it flies');
  findButton(mount, 'reload-dafare').dispatch('click');
  await flush();
  for (const action of ['approve', 'edit', 'reject']) {
    assert.equal(findButton(mount, action).disabled, false, `${action} unlocked after Ricarica: an edit never leaves «proposed»`);
  }
  queue = false;
  await save('Ciao Giulia, giovedì alle 18?');
  const posts = client.calls.filter((call) => call.method === 'POST' && call.path === '/api/agents/revise');
  assert.equal(posts.length, 2);
  assert.equal(posts[1].key, posts[0].key, 'the same text goes again under the same key');
  assert.ok(mount.textContent.includes('Modifica salvata'));
});

test('review #688 giro 2 P2: a 405 with a domain code is a real refusal, not «Non ancora disponibile»', () => {
  assert.equal(isDecisionUnavailable({ status: 405, code: 'AGENT_RUN_UNKNOWN' }), false);
  assert.equal(isDecisionUnavailable({ status: 405, code: 'BO_AGENT_RUN_REFUSED' }), false);
  for (const code of [undefined, 'ADMIN_METHOD_NOT_ALLOWED', 'NOT_FOUND', 'BO_AGENT_ROUTE_UNKNOWN', 'BO_AGENT_DECISION_UNAVAILABLE']) {
    assert.equal(isDecisionUnavailable({ status: 405, code }), true, String(code));
  }
});
