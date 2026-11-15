// @ts-check

/**
 * Re-engagement proposals in «Da fare» (backlog:fd36da512b0e).
 *
 * The backoffice «Da fare» lists teammate runs with outcome `proposed`;
 * the re-engagement agent (#570) used to return space-ai-proposal-shaped
 * values no screen read. Now its executor is the `execute` seam of the
 * agents package's `run-due`: the knock lands as one teammate-run
 * `proposed`, the screen's own predicate (`buildDaFare`) shows it, and
 * Approva / Modifica / Rifiuta act on that row (`approve-run`,
 * `revise-run`, `reject-run`).
 *
 * Real sqlite plus the real record services, like agents-teammate.test.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../packages/core/src/database.js';
import { AuditLog } from '../packages/core/src/audit.js';
import { EventBus } from '../packages/core/src/event-bus.js';
import {
  createRecordModuleFromManifest,
  recordModuleMigrations,
} from '../packages/core/src/record-module-runtime.js';
import { createAgentsPackage } from '../packages/agents/src/index.js';
import { createAgentOperations } from '../packages/agents/src/operations.js';
import {
  REENGAGEMENT_ACTION_KIND,
  createReengagementExecutor,
} from '../packages/reengagement/src/index.js';
import { buildDaFare } from '../apps/admin/public/admin-agenti.js';

const here = dirname(fileURLToPath(import.meta.url));
const USER = { type: 'user', id: 'presti-owner' };
const SYSTEM = { type: 'system', id: 'agent-sweep' };
const SPACE = 'presti';
const MON_07 = '2026-11-02T07:00:00.000Z';
const MON_0801 = '2026-11-02T08:01:00.000Z';
const RUN_KEY = 'run:as-riaggancio:2026-11-02T08:00:00.000Z';
const NOW_MS = Date.parse(MON_0801);
const DAY_MS = 24 * 60 * 60 * 1000;

const manifest = (name) => JSON.parse(
  readFileSync(join(here, '..', 'packages', 'agents', 'modules', `${name}.module.json`), 'utf8'),
);
const MANIFESTS = ['teammate-agent', 'teammate-assignment', 'teammate-run'];

function compose(t) {
  const database = createDatabase({ path: ':memory:' });
  t.after(() => database.close?.());
  for (const { sql } of recordModuleMigrations(MANIFESTS.map((name) => ({ name, manifest: manifest(name) })))) {
    database.raw.exec(sql);
  }
  const audit = new AuditLog(database);
  const events = new EventBus();
  const modules = new Map();
  for (const name of MANIFESTS) {
    const built = createRecordModuleFromManifest(manifest(name), { database, audit, events, references: {} });
    modules.set(name, { service: built.service });
  }
  let clock = MON_07;
  const ops = createAgentOperations({ modules, now: () => clock });
  return { modules, ops, setNow: (iso) => { clock = iso; } };
}

const silent = (customerId, displayName, channel, extra = {}) => ({
  customerId,
  displayName,
  channel,
  lastInboundAt: new Date(NOW_MS - 10 * DAY_MS).toISOString(),
  lastOutboundAt: null,
  consent: 'granted',
  connectedChannels: [channel],
  ...(channel === 'whatsapp' ? { windowState: 'in-window' } : {}),
  history: [{ direction: 'in', text: 'Quanto costa la prova?' }],
  ...extra,
});

const CUSTOMERS = [
  silent('cust-anna', 'Anna', 'whatsapp'),
  silent('cust-bruno', 'Bruno', 'email'),
  silent('cust-carla', 'Carla', 'email', { consent: 'opted-out' }),
];

const draftText = async ({ candidate }) => ({ text: `Ciao ${candidate.displayName}, ti va di riprovare?` });

/** The riaggancio agent with one daily assignment due at 08:00, swept at 08:01. */
async function proposedRun(t, customers = CUSTOMERS) {
  const harness = compose(t);
  const { ops, setNow } = harness;
  await ops.createAgent({
    actor: USER, spaceId: SPACE, sourceKey: 'ag-riaggancio', name: 'Riaggancio',
    role: 'Ricontatta i clienti rimasti senza risposta', instructions: 'Prepara un messaggio per ciascuno.',
  });
  await ops.createAssignment({
    actor: USER, spaceId: SPACE, sourceKey: 'as-riaggancio', agentSourceKey: 'ag-riaggancio',
    phrase: 'ogni giorno occupati dei lead non contattati', plan: { cadence: 'daily', timeOfDay: '08:00' },
  });
  setNow(MON_0801);
  const loads = [];
  const execute = createReengagementExecutor({
    loadCustomers: (context) => { loads.push(context.agent?.sourceKey); return customers; },
    draftText,
    nowMs: () => NOW_MS,
  });
  const summary = await ops.runDue({ actor: SYSTEM, at: MON_0801, execute });
  return { ...harness, summary, loads };
}

async function runRows(modules) {
  return modules.get('teammate-run').service.listWhere({ spaceId: SPACE });
}

async function daFare(modules) {
  const runs = await runRows(modules);
  const agents = await modules.get('teammate-agent').service.listWhere({ spaceId: SPACE });
  const assignments = await modules.get('teammate-assignment').service.listWhere({ spaceId: SPACE });
  return buildDaFare({ runs, agents, assignments });
}

test('a re-engagement proposal lands in «Da fare» as a teammate-run proposed', async (t) => {
  const { modules, summary, loads } = await proposedRun(t);
  assert.equal(summary.proposed, 1, 'run-due recorded one proposed run');
  assert.deepEqual(loads, ['ag-riaggancio'], 'the executor read the customers once, for the agent');
  const [run] = await runRows(modules);
  assert.equal(run.outcome, 'proposed');
  const proposals = JSON.parse(run.proposals);
  assert.deepEqual(proposals.map((entry) => entry.action), [REENGAGEMENT_ACTION_KIND, REENGAGEMENT_ACTION_KIND]);
  assert.deepEqual(proposals.map((entry) => entry.payload.customerRef.customerId), ['cust-anna', 'cust-bruno'],
    'one knock per silent customer; the opted-out one never');
  assert.equal(proposals[0].payload.channel, 'whatsapp');
  assert.equal(proposals[0].payload.text, 'Ciao Anna, ti va di riprovare?');

  const items = await daFare(modules);
  assert.equal(items.length, 1, 'the screen shows the run');
  assert.equal(items[0].runSourceKey, RUN_KEY);
  assert.equal(items[0].agentName, 'Riaggancio');
  assert.equal(items[0].unreadable, false);
  assert.match(items[0].lines[0], /^Ricontatta Anna su whatsapp/, 'the line reads the proposal summary');
});

test('Approva sends each message once through applyAction and the row leaves «Da fare»', async (t) => {
  const { modules, ops } = await proposedRun(t);
  const sent = [];
  const { run } = await ops.approveRun({
    actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY,
    applyAction: async ({ proposal, idempotencyKey }) => {
      sent.push({ action: proposal.action, to: proposal.payload.customerRef.customerId, idempotencyKey });
      return { queued: true };
    },
  });
  assert.equal(run.outcome, 'applied');
  assert.deepEqual(sent.map((entry) => entry.to), ['cust-anna', 'cust-bruno']);
  assert.ok(sent.every((entry) => entry.action === REENGAGEMENT_ACTION_KIND));
  assert.equal((await daFare(modules)).length, 0);
});

test('Modifica changes one message before approval; the approval sends the new text', async (t) => {
  const { modules, ops } = await proposedRun(t);
  const revised = await ops.reviseRun({
    actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY, index: 1,
    payload: { text: 'Ciao Bruno, la lezione di prova è gratis questa settimana.' },
  });
  assert.equal(revised.run.outcome, 'proposed', 'the run keeps waiting');
  assert.equal(revised.proposal.action, REENGAGEMENT_ACTION_KIND, 'the action stays the agent one');
  assert.equal(revised.proposal.payload.channel, 'email', 'untouched fields stay');
  assert.equal((await daFare(modules)).length, 1, 'still in «Da fare»');

  await assert.rejects(
    () => ops.reviseRun({ actor: SYSTEM, spaceId: SPACE, runSourceKey: RUN_KEY, payload: { text: 'x' } }),
    (error) => error.code === 'AGENT_APPROVAL_FORBIDDEN', 'only a human edits',
  );
  await assert.rejects(
    () => ops.reviseRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY, index: 5, payload: { text: 'x' } }),
    (error) => error.code === 'AGENT_PROPOSAL_INDEX_INVALID',
  );
  await assert.rejects(
    () => ops.reviseRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY, payload: 'testo' }),
    (error) => error.code === 'AGENT_PROPOSAL_PAYLOAD_INVALID',
  );

  const texts = [];
  await ops.approveRun({
    actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY,
    applyAction: async ({ proposal }) => { texts.push(proposal.payload.text); return {}; },
  });
  assert.deepEqual(texts, ['Ciao Anna, ti va di riprovare?', 'Ciao Bruno, la lezione di prova è gratis questa settimana.']);
});

test('Modifica refuses a message an earlier approval attempt already sent', async (t) => {
  const { ops, setNow } = await proposedRun(t);
  let fail = true;
  await assert.rejects(() => ops.approveRun({
    actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY,
    applyAction: async ({ proposal }) => {
      if (proposal.payload.customerRef.customerId === 'cust-bruno' && fail) throw new Error('outbox down');
      return {};
    },
  }), /outbox down/);
  setNow('2026-11-02T08:05:00.000Z');
  await assert.rejects(
    () => ops.reviseRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY, index: 0, payload: { text: 'tardi' } }),
    (error) => error.code === 'AGENT_PROPOSAL_ALREADY_APPLIED',
  );
  await ops.reviseRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY, index: 1, payload: { text: 'Riprovo io' } });
  fail = false;
  const resumed = [];
  const { run } = await ops.approveRun({
    actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY,
    applyAction: async ({ proposal }) => { resumed.push(proposal.payload.text); return {}; },
  });
  assert.equal(run.outcome, 'applied');
  assert.deepEqual(resumed, ['Riprovo io'], 'the retry resumes at the edited message, never resends Anna');
});

test('Rifiuta closes the row as rejected and nothing is sent', async (t) => {
  const { modules, ops } = await proposedRun(t);
  await assert.rejects(
    () => ops.rejectRun({ actor: SYSTEM, spaceId: SPACE, runSourceKey: RUN_KEY }),
    (error) => error.code === 'AGENT_APPROVAL_FORBIDDEN', 'only a human rejects',
  );
  const first = await ops.rejectRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY, reason: 'Li chiamo io' });
  assert.equal(first.duplicate, false);
  assert.equal(first.run.outcome, 'rejected');
  assert.match(first.run.note, /Reason: Li chiamo io/);
  assert.equal((await daFare(modules)).length, 0, 'the row left «Da fare»');
  const again = await ops.rejectRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY });
  assert.equal(again.duplicate, true, 'a second rejection replays');
  let called = 0;
  await assert.rejects(
    () => ops.approveRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY, applyAction: async () => { called += 1; } }),
    (error) => error.code === 'AGENT_TRANSITION_INVALID', 'a rejected run never applies',
  );
  assert.equal(called, 0);
  await assert.rejects(
    () => ops.rejectRun({ actor: USER, spaceId: 'altro', runSourceKey: RUN_KEY }),
    (error) => error.code === 'AGENT_RUN_UNKNOWN', 'another space never sees the run',
  );
});

test('Rifiuta refuses an applied run', async (t) => {
  const { ops } = await proposedRun(t);
  await ops.approveRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY, applyAction: async () => ({}) });
  await assert.rejects(
    () => ops.rejectRun({ actor: USER, spaceId: SPACE, runSourceKey: RUN_KEY }),
    (error) => error.code === 'AGENT_TRANSITION_INVALID',
  );
});

test('nobody to knock: the run is an artifact counting the skips, not a «Da fare» row', async (t) => {
  const { modules, summary } = await proposedRun(t, [silent('cust-carla', 'Carla', 'email', { consent: 'opted-out' })]);
  assert.equal(summary.artifacts, 1);
  const [run] = await runRows(modules);
  assert.equal(run.outcome, 'artifact');
  assert.deepEqual(JSON.parse(run.artifact).skippedByReason, { 'opted-out': 1 });
  assert.equal((await daFare(modules)).length, 0);
});

test('the executor refuses without its seams', () => {
  assert.throws(() => createReengagementExecutor(/** @type {any} */ ({ draftText })), /loadCustomers/);
  assert.throws(() => createReengagementExecutor(/** @type {any} */ ({ loadCustomers: () => [] })), /draftText/);
});

test('the agents package declares reject-run and revise-run (since version 2)', () => {
  const graph = createAgentsPackage();
  // 3 since backlog:1f7cb20d3c30 (hand-written agents, run-due runnable).
  assert.ok(graph.version >= 2);
  const names = graph.operations.map((operation) => operation.name);
  for (const name of ['run-due', 'approve-run', 'reject-run', 'revise-run']) {
    assert.ok(names.includes(name), `${name} is declared`);
  }
});
