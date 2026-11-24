import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { accordoSalesPipeline } from '../packages/pipelines/accordo-sales.js';
import { buildAssignPipelineAction } from '../packages/core/src/pipeline-actions.js';
import { buildAssignPipelineAction as buildAssignPipelineActionFromKernel } from '../packages/core/index.js';
import {
  isLostOfferStage,
  isOpenOfferStage,
  isWonOfferStage,
} from '../packages/core/index.js';

/**
 * backlog:19efb8e3cee5 — an offer without a pipeline gets pipeline and
 * stage with the single `assign-pipeline` action, next to `move-stage`.
 *
 * One throwaway app per file: the offer is created while no pipeline is
 * registered (legacy null pipeline state, like the parked «N offerte di
 * altre pipeline» rows), then the accordo-sales pipeline and the action
 * are registered and the assignment runs through the shared action
 * runtime — the same road the HTTP route takes.
 */

const actor = { type: 'user', id: 'assign-pipeline-test' };

async function boot(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const company = await app.services.companies.create({ name: 'Assign Co' }, { actor });
  // No pipeline registered yet: the documented deterministic default is
  // legacy null pipeline state, never an invented stage.
  const created = await app.services.opportunities.create(
    { companyId: company.id, name: 'Senza pipeline', valueCents: 100000, owner: 'assign-test' },
    { actor },
  );
  assert.equal(created.pipelineKey, null);
  assert.equal(created.pipelineStage, null);
  app.pipelines.register(accordoSalesPipeline);
  app.actions.register(buildAssignPipelineAction({ module: 'opportunity' }));
  return { app, offerId: created.id };
}

async function assign(app, offerId, input) {
  const envelope = await app.runAction({ module: 'opportunity', action: 'assign-pipeline', recordId: offerId, input, actor });
  assert.equal(envelope.ok, true);
  return envelope.result;
}

test('19efb8e3cee5: the kernel surface publishes the assign-pipeline factory beside move-stage', () => {
  assert.equal(buildAssignPipelineAction, buildAssignPipelineActionFromKernel);
  const definition = buildAssignPipelineAction({ module: 'opportunity' });
  assert.equal(definition.module, 'opportunity');
  assert.equal(definition.name, 'assign-pipeline');
  assert.equal(definition.actionContract, 1);
});

test('19efb8e3cee5: one action assigns pipeline and default stage, audited on the offer', async (t) => {
  const { app, offerId } = await boot(t);
  const result = await assign(app, offerId, {});
  assert.equal(result.to, 'richiesta-info');
  assert.equal(result.from, null);
  assert.equal(result.record.pipelineKey, 'accordo-sales');
  const reread = app.services.opportunities.get(offerId);
  assert.equal(reread.pipelineKey, 'accordo-sales');
  assert.equal(reread.pipelineStage, 'richiesta-info');
  const audit = app.audit.list({ entityType: 'opportunity', entityId: offerId, limit: 50 });
  const entry = audit.find((row) => row.action === 'opportunity.updated'
    && row.data?.pipelineKey === 'accordo-sales'
    && row.data?.pipelineStage === 'richiesta-info');
  assert.ok(entry, 'the assignment is recorded in the audit on the offer');
});

test('19efb8e3cee5: an explicit stage of the pipeline is assigned in the same single action', async (t) => {
  const { app, offerId } = await boot(t);
  const result = await assign(app, offerId, { toStage: 'proposta' });
  assert.equal(result.to, 'proposta');
  assert.equal(app.services.opportunities.get(offerId).pipelineStage, 'proposta');
});

test('19efb8e3cee5: a stage outside the chosen pipeline is refused with an Italian message', async (t) => {
  const { app, offerId } = await boot(t);
  await assert.rejects(
    assign(app, offerId, { toStage: 'discovery' }),
    (error) => {
      assert.match(error.message, /non appartiene alla pipeline "accordo-sales"/);
      assert.match(error.message, /richiesta-info/);
      return true;
    },
  );
  assert.equal(app.services.opportunities.get(offerId).pipelineKey, null, 'the refused offer stays pipeline-less');
});

test('19efb8e3cee5: naming another pipeline is refused', async (t) => {
  const { app, offerId } = await boot(t);
  await assert.rejects(
    assign(app, offerId, { pipeline: 'b2b-sales', toStage: 'proposta' }),
    /qui si assegna solo "accordo-sales"/,
  );
});

test('19efb8e3cee5: an offer already on a pipeline is refused, never reassigned', async (t) => {
  const { app, offerId } = await boot(t);
  await assign(app, offerId, { toStage: 'prova' });
  await assert.rejects(
    assign(app, offerId, { toStage: 'proposta' }),
    (error) => {
      assert.equal(error.code, 'ALREADY_ON_PIPELINE');
      return true;
    },
  );
  assert.equal(app.services.opportunities.get(offerId).pipelineStage, 'prova');
});

test('19efb8e3cee5: assigning to the lost stage needs a reason and closes the offer', async (t) => {
  const { app, offerId } = await boot(t);
  await assert.rejects(assign(app, offerId, { toStage: 'perso' }), /reason is required/);
  const result = await assign(app, offerId, { toStage: 'perso', reason: 'Prezzo troppo alto' });
  assert.equal(result.to, 'perso');
  const reread = app.services.opportunities.get(offerId);
  assert.equal(reread.closeReason, 'Prezzo troppo alto');
  assert.ok(reread.closedAt, 'the lost assignment closes the offer');
});

test('19efb8e3cee5: after the assignment Clienti, Reporting and the Pipeline header count the offer the same way', async (t) => {
  // The three surfaces share one closed/won rule (backlog:1adf95307b31):
  // with a pipeline the stage type decides, so an assigned row is read
  // identically everywhere — no per-surface recount.
  const { app, offerId } = await boot(t);
  await assign(app, offerId, { toStage: 'proposta' });
  const open = app.services.opportunities.get(offerId);
  assert.equal(isOpenOfferStage(accordoSalesPipeline, open.pipelineStage), true);
  assert.equal(isWonOfferStage(accordoSalesPipeline, open.pipelineStage), false);
  assert.equal(isLostOfferStage(accordoSalesPipeline, open.pipelineStage), false);

  const second = await boot(t);
  await assign(second.app, second.offerId, { toStage: 'pagato' });
  const won = second.app.services.opportunities.get(second.offerId);
  assert.equal(isWonOfferStage(accordoSalesPipeline, won.pipelineStage), true);
  assert.equal(isOpenOfferStage(accordoSalesPipeline, won.pipelineStage), false);

  const third = await boot(t);
  await assign(third.app, third.offerId, { toStage: 'perso', reason: 'Non interessato' });
  const lost = third.app.services.opportunities.get(third.offerId);
  assert.equal(isLostOfferStage(accordoSalesPipeline, lost.pipelineStage), true);
  assert.equal(isOpenOfferStage(accordoSalesPipeline, lost.pipelineStage), false);
});
