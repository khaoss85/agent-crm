import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createHttpServer } from '../apps/server/src/index.js';
import { accordoSalesPipeline } from '../packages/pipelines/accordo-sales.js';
import { buildMoveStageAction } from '../packages/core/src/pipeline-actions.js';
import { BOARD_GAP, boardPlan, OpportunityService } from '../packages/modules/opportunity/src/opportunity-service.js';

/**
 * backlog:67a3116f4f65 — the card's place inside its pipeline column.
 *
 * Migration v11 adds `opportunities.board_position` (NOT NULL DEFAULT 0:
 * 0 = not placed). `GET /api/opportunities?order=board` reads the board
 * order (position, then newest first); without it the list stays newest
 * first. `move-stage` takes `afterId` or `first: true`: across columns the
 * card lands exactly there, inside the same column it is a reorder (no
 * SAME_STAGE). Placement goes through OpportunityService.positionOnBoard,
 * audited on the moved card, in the action's transaction.
 */

const HEADERS = {
  'content-type': 'application/json',
  'x-actor-id': 'board-test',
  'x-actor-type': 'user',
};
const actor = { type: 'user', id: 'board-test' };
const pause = () => new Promise((resolve) => setTimeout(resolve, 3));

async function boot(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  app.pipelines.register(accordoSalesPipeline);
  app.actions.register(buildMoveStageAction({ module: 'opportunity' }));
  const server = createHttpServer(app);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    app.close();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const company = await app.services.companies.create({ name: 'Board Co' }, { actor });
  /** Create offers one by one (distinct updated_at), all in richiesta-info. */
  const offers = async (...names) => {
    const ids = {};
    for (const name of names) {
      const created = await app.services.opportunities.create(
        { companyId: company.id, name, valueCents: 1000, owner: 'board-test' }, { actor },
      );
      ids[name] = created.id;
      await pause();
    }
    return ids;
  };
  const move = async (id, body) => {
    const response = await fetch(`${baseUrl}/api/modules/opportunity/records/${id}/actions/move-stage`, {
      method: 'POST', headers: HEADERS, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const board = async (stage) => {
    const listed = await fetch(`${baseUrl}/api/opportunities?order=board&limit=200`).then((response) => response.json());
    return listed.items.filter((item) => item.pipelineStage === stage).map((item) => item.name);
  };
  return { app, baseUrl, offers, move, board };
}

test('67a3116f4f65: v11 adds board_position NOT NULL DEFAULT 0; every offer starts unplaced', async (t) => {
  const { app, offers } = await boot(t);
  const columns = app.database.raw.prepare('PRAGMA table_info(opportunities)').all();
  const column = columns.find((entry) => entry.name === 'board_position');
  assert.ok(column, 'the column exists');
  assert.equal(column.notnull, 1);
  assert.equal(String(column.dflt_value), '0');
  const ids = await offers('A');
  assert.equal(app.services.opportunities.get(ids.A).boardPosition, 0, 'a new offer is unplaced');
});

test('67a3116f4f65: a drop between two cards of another column lands exactly there and survives a re-read', async (t) => {
  const { app, offers, move, board } = await boot(t);
  const ids = await offers('A', 'B', 'C', 'X');
  // Prova holds A, B, C — placed in that order (top to bottom).
  for (const name of ['A', 'B', 'C']) {
    const moved = await move(ids[name], { toStage: 'prova', fromStage: 'richiesta-info' });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
  }
  assert.equal((await move(ids.A, { toStage: 'prova', first: true })).status, 200);
  assert.equal((await move(ids.B, { toStage: 'prova', afterId: ids.A })).status, 200);
  assert.equal((await move(ids.C, { toStage: 'prova', afterId: ids.B })).status, 200);
  assert.deepEqual(await board('prova'), ['A', 'B', 'C']);

  // X goes from richiesta-info to Prova, between A and B.
  const dropped = await move(ids.X, { toStage: 'prova', fromStage: 'richiesta-info', afterId: ids.A });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
  assert.equal(dropped.body.result.to, 'prova');
  assert.deepEqual(await board('prova'), ['A', 'X', 'B', 'C'], 'X sits between A and B');
  // A fresh read, as after a page reload, keeps it.
  assert.deepEqual(await board('prova'), ['A', 'X', 'B', 'C']);
  assert.equal(app.services.opportunities.get(ids.X).pipelineStage, 'prova');
});

test('67a3116f4f65: a reorder inside the same column needs no stage change and never answers SAME_STAGE', async (t) => {
  const { app, offers, move, board } = await boot(t);
  const ids = await offers('A', 'B', 'C');
  for (const name of ['A', 'B', 'C']) await move(ids[name], { toStage: 'prova' });
  await move(ids.A, { toStage: 'prova', first: true });
  await move(ids.B, { toStage: 'prova', afterId: ids.A });
  await move(ids.C, { toStage: 'prova', afterId: ids.B });
  const enteredBefore = app.services.opportunities.get(ids.C).stageEnteredAt;

  const reorder = await move(ids.C, { toStage: 'prova', fromStage: 'prova', first: true });
  assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
  assert.equal(reorder.body.result.from, 'prova');
  assert.equal(reorder.body.result.to, 'prova');
  assert.deepEqual(await board('prova'), ['C', 'A', 'B'], 'C moved to the top of its own column');
  assert.equal(app.services.opportunities.get(ids.C).stageEnteredAt, enteredBefore, 'the stage clock is untouched');

  // Without a placement the old contract stays: same stage → 409 SAME_STAGE.
  const same = await move(ids.C, { toStage: 'prova' });
  assert.equal(same.status, 409);
  assert.equal(same.body.error?.code ?? same.body.code, 'SAME_STAGE');
});

test('67a3116f4f65: a terminal column can be reordered, nothing reopens', async (t) => {
  const { app, offers, move, board } = await boot(t);
  const ids = await offers('A', 'B');
  await move(ids.A, { toStage: 'pagato' });
  await pause();
  await move(ids.B, { toStage: 'pagato' });
  assert.deepEqual(await board('pagato'), ['B', 'A'], 'unplaced: newest first');
  const reorder = await move(ids.A, { toStage: 'pagato', first: true });
  assert.equal(reorder.status, 200, JSON.stringify(reorder.body));
  assert.deepEqual(await board('pagato'), ['A', 'B']);
  const a = app.services.opportunities.get(ids.A);
  assert.equal(a.pipelineStage, 'pagato');
  assert.ok(a.closedAt, 'the closure stays');
});

test('67a3116f4f65: unplaced cards stay on top newest first; the first placement renumbers the column in place', async (t) => {
  const { app, offers, move, board } = await boot(t);
  const ids = await offers('A', 'B', 'C');
  // All three unplaced in richiesta-info: newest first.
  assert.deepEqual(await board('richiesta-info'), ['C', 'B', 'A']);
  const updatedBefore = Object.fromEntries(['A', 'B'].map((name) => [name, app.services.opportunities.get(ids[name]).updatedAt]));
  // Put C after A: the column becomes explicit (B, A, C).
  const placed = await move(ids.C, { toStage: 'richiesta-info', afterId: ids.A });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  assert.deepEqual(await board('richiesta-info'), ['B', 'A', 'C']);
  for (const name of ['B', 'A', 'C']) {
    assert.ok(app.services.opportunities.get(ids[name]).boardPosition > 0, `${name} is placed`);
  }
  for (const name of ['A', 'B']) {
    assert.equal(app.services.opportunities.get(ids[name]).updatedAt, updatedBefore[name],
      `${name}: a renumbered neighbour keeps its updated_at (stage claims fence on it)`);
  }
  // One audit row, on the moved card only.
  const audit = app.audit.list({ entityType: 'opportunity', entityId: ids.C, limit: 50 });
  const placement = audit.find((entry) => entry.action === 'opportunity.updated' && entry.data?.boardPosition !== undefined);
  assert.ok(placement, 'the placement is audited on the moved card');
  assert.equal(placement.actorId, 'board-test');
  assert.equal(placement.data.renumbered, 2);
  for (const name of ['A', 'B']) {
    const rows = app.audit.list({ entityType: 'opportunity', entityId: ids[name], limit: 50 });
    assert.ok(!rows.some((entry) => entry.action === 'opportunity.updated'), `${name}: no audit noise for a neighbour`);
  }
});

test('67a3116f4f65: a move without a placement lands unplaced on top of the new column', async (t) => {
  const { app, offers, move, board } = await boot(t);
  const ids = await offers('A', 'B', 'N');
  for (const name of ['A', 'B']) await move(ids[name], { toStage: 'prova' });
  await move(ids.A, { toStage: 'prova', first: true });
  await move(ids.B, { toStage: 'prova', afterId: ids.A });
  // A placed card leaves its column: it arrives unplaced.
  await move(ids.B, { toStage: 'proposta' });
  assert.equal(app.services.opportunities.get(ids.B).boardPosition, 0, 'a stage change unplaces the card');
  await move(ids.N, { toStage: 'prova' });
  assert.deepEqual(await board('prova'), ['N', 'A'], 'the plain move sits on top, as before positions');
});

test('67a3116f4f65: stale or malformed placements are refused before any write', async (t) => {
  const { app, offers, move } = await boot(t);
  const ids = await offers('A', 'B');
  await move(ids.A, { toStage: 'prova' });
  // B is not in Prova: placing after it is stale.
  const stale = await move(ids.A, { toStage: 'prova', afterId: ids.B });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error?.code ?? stale.body.code, 'STALE_POSITION');
  const self = await move(ids.A, { toStage: 'prova', afterId: ids.A });
  assert.equal(self.status, 400);
  const both = await move(ids.A, { toStage: 'prova', afterId: ids.B, first: true });
  assert.equal(both.status, 400);
  // A stale cross-column placement rolls the stage move back too.
  const before = app.services.opportunities.get(ids.B);
  const rolled = await move(ids.B, { toStage: 'prova', fromStage: 'richiesta-info', afterId: 'missing' });
  assert.equal(rolled.status, 409);
  const after = app.services.opportunities.get(ids.B);
  assert.equal(after.pipelineStage, before.pipelineStage, 'the stage move rolled back with the placement');
  assert.equal(after.updatedAt, before.updatedAt);
});

test('67a3116f4f65: the plain list keeps newest first; order=board is the only board order; bad order refuses', async (t) => {
  const { app, baseUrl, offers, move } = await boot(t);
  const ids = await offers('A', 'B');
  await move(ids.A, { toStage: 'prova' });
  await move(ids.A, { toStage: 'prova', first: true });
  await pause();
  // B is touched last: newest.
  await app.services.opportunities.update(ids.B, { valueCents: 2000 }, { actor });
  const plain = await fetch(`${baseUrl}/api/opportunities`).then((response) => response.json());
  assert.deepEqual(plain.items.map((item) => item.name), ['B', 'A'], 'scheda, Oggi and the assistant keep newest first');
  const refused = await fetch(`${baseUrl}/api/opportunities?order=price`);
  assert.equal(refused.status, 400);
});

test('67a3116f4f65: create and PATCH refuse boardPosition; it is managed', async (t) => {
  const { app, offers } = await boot(t);
  const company = await app.services.companies.create({ name: 'Other' }, { actor });
  await assert.rejects(
    async () => app.services.opportunities.create({ companyId: company.id, name: 'X', valueCents: 1, owner: 'o', boardPosition: 5 }, { actor }),
    /boardPosition is managed/,
  );
  const ids = await offers('A');
  await assert.rejects(
    async () => app.services.opportunities.update(ids.A, { boardPosition: 5 }, { actor }),
    /unknown fields: boardPosition/,
  );
});

test('67a3116f4f65: boardPlan writes one row when there is room, the column when there is none', () => {
  assert.deepEqual(boardPlan([], 0), { position: BOARD_GAP, writes: [] });
  assert.deepEqual(boardPlan([{ id: 'a', position: 2048 }], 0), { position: 1024, writes: [] });
  assert.deepEqual(boardPlan([{ id: 'a', position: 1024 }], 1), { position: 2048, writes: [] });
  assert.deepEqual(boardPlan([{ id: 'a', position: 1024 }, { id: 'b', position: 2048 }], 1), { position: 1536, writes: [] });
  // No room between a and b: the column is renumbered.
  assert.deepEqual(
    boardPlan([{ id: 'a', position: 1024 }, { id: 'b', position: 1025 }], 1),
    { position: 2048, writes: [{ id: 'b', position: 3072 }] },
  );
  // An unplaced card in the column: renumbered too, in its shown place.
  assert.deepEqual(
    boardPlan([{ id: 'u', position: 0 }, { id: 'a', position: 1024 }], 2),
    { position: 3072, writes: [{ id: 'u', position: 1024 }, { id: 'a', position: 2048 }] },
  );
});

test('review Muse #785: on async storage (PostgreSQL) the card and its column are read inside the transaction that writes the placement', async () => {
  // A PostgreSQL-shaped handle: async reads and writes, one transaction.
  const rows = new Map([
    ['a', { id: 'a', company_id: 'co', contact_id: null, name: 'A', type: 'new_business', value_cents: 1, currency: 'EUR', stage: 'qualification', owner: 'o', pipeline_key: 'accordo-sales', pipeline_stage: 'prova', board_position: 1024, created_at: 't', updated_at: 't' }],
    ['b', { id: 'b', company_id: 'co', contact_id: null, name: 'B', type: 'new_business', value_cents: 1, currency: 'EUR', stage: 'qualification', owner: 'o', pipeline_key: 'accordo-sales', pipeline_stage: 'prova', board_position: 2048, created_at: 't', updated_at: 't' }],
  ]);
  const log = [];
  let inTx = false;
  const match = (row, where = []) => where.every((clause) => row[clause.column] === clause.value);
  const storage = {
    activeTransaction: () => inTx,
    async maybeOne(statement) {
      if (Array.isArray(statement.columns)) log.push({ read: 'card', inside: inTx });
      return [...rows.values()].find((row) => match(row, statement.where)) ?? null;
    },
    async many(statement) {
      if (Array.isArray(statement.columns) && statement.columns.includes('board_position')) log.push({ read: 'column', inside: inTx });
      return [...rows.values()].filter((row) => match(row, statement.where))
        .sort((x, y) => x.board_position - y.board_position);
    },
    async execute(statement) {
      log.push({ write: true, inside: inTx });
      for (const row of rows.values()) {
        if (!match(row, statement.where)) continue;
        for (const { column, value } of statement.values) row[column] = value;
      }
    },
    async transaction(fn) { inTx = true; try { return await fn(storage); } finally { inTx = false; } },
    async savepoint(_name, fn) { return fn(storage); },
  };
  const service = new OpportunityService({
    database: { storage },
    audit: { record: async () => { log.push({ audit: true, inside: inTx }); } },
    events: { emit: async () => {} },
    companies: { get: async () => ({ name: 'Co' }) },
    contacts: { get: async () => null },
  });
  const placed = await service.positionOnBoard('b', { first: true }, { actor });
  assert.equal(placed.boardPosition, 512, 'B goes first, before A at 1024');
  const planReads = log.filter((entry) => entry.read);
  assert.deepEqual(planReads.map((entry) => entry.read), ['card', 'column'], 'the plan reads the card, then its column');
  assert.ok(planReads.every((entry) => entry.inside), `every plan read is inside the transaction (${JSON.stringify(log)})`);
  assert.ok(log.filter((entry) => entry.write || entry.audit).every((entry) => entry.inside), 'and so are the writes and the audit');
});
