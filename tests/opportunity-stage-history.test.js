// Voce c1649d1d9670: a state change of the offer leaves a row in the
// history (who, from which stage to which, when). The service stamps the
// previous pipeline stage into the audit data of a pipeline move
// (`fromPipelineStage` in applyManaged), so the scheda «Storia stati» and
// the offerta «Cronologia» can read da/a without re-reading the row.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';

const ACTOR = { type: 'user', id: 'storia-stati' };

async function fixture(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  const company = await app.services.companies.create({ name: 'Palestra' }, { actor: ACTOR });
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    name: 'Pacchetto 10 ingressi',
    valueCents: 25000,
    owner: 'elena',
  }, { actor: ACTOR });
  t.after(() => app.close());
  return { app, opportunity };
}

const at = (hour) => `2026-11-09T${String(hour).padStart(2, '0')}:00:00.000Z`;

test('a pipeline move audits who, from which stage to which, and when', async (t) => {
  const { app, opportunity } = await fixture(t);
  // Placement: the entry into the first stage, not a move — no `from`.
  await app.services.opportunities.applyManaged(opportunity.id, {
    pipelineKey: 'accordo-sales', pipelineStage: 'richiesta-info', stageEnteredAt: at(9),
  }, { actor: ACTOR });
  const moved = await app.services.opportunities.applyManaged(opportunity.id, {
    pipelineStage: 'prova', stageEnteredAt: at(10),
  }, { actor: ACTOR });
  assert.equal(moved.pipelineStage, 'prova');

  const rows = app.audit.list({ entityType: 'opportunity', entityId: opportunity.id });
  const move = rows.find((row) => row.action === 'opportunity.updated'
    && row?.data?.pipelineStage === 'prova');
  assert.ok(move, 'the move leaves an audit row');
  assert.equal(move.data.fromPipelineStage, 'richiesta-info', 'the row names the stage it left');
  assert.equal(move.data.pipelineStage, 'prova', 'the row names the stage it entered');
  assert.equal(move.actorId, 'storia-stati', 'the row names who moved it');
  assert.equal(move.actorType, 'user');
  assert.ok(Date.parse(move.createdAt) > 0, 'the row names when it happened');
});

test('placement and commercial edits audit no from stage', async (t) => {
  const { app, opportunity } = await fixture(t);
  await app.services.opportunities.applyManaged(opportunity.id, {
    pipelineKey: 'accordo-sales', pipelineStage: 'richiesta-info', stageEnteredAt: at(9),
  }, { actor: ACTOR });
  await app.services.opportunities.update(opportunity.id, { owner: 'guido' }, { actor: ACTOR });

  const rows = app.audit.list({ entityType: 'opportunity', entityId: opportunity.id });
  for (const row of rows) {
    assert.ok(!Object.hasOwn(row.data ?? {}, 'fromPipelineStage'),
      `no invented from stage on ${row.action}`);
  }
});
