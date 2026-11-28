import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { customerOf } from '../apps/admin/public/admin-pipeline.js';
import { offerCustomer } from '../apps/admin/public/admin-labels.js';

/**
 * backlog:ac65e448fcb4 — una vera azienda «Senza azienda» non è un
 * segnaposto: Pipeline, cmdk ed etichette la nominano dal flag, mai dal
 * nome. Il segnaposto (flag alto) resta invisibile ovunque.
 */

const OPERATOR = { type: 'user', id: 'placeholder-flag-pipe-op' };

function scene(t) {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  return { app };
}

async function fileOpportunity(app, company) {
  const opportunity = await app.services.opportunities.create({
    companyId: company.id, name: 'Offerta Vera',
    type: 'new_business', valueCents: 100000, currency: 'EUR', stage: 'discovery', owner: 'guido',
  }, { actor: OPERATOR });
  const rows = await app.services.opportunities.list({});
  const row = rows.find((candidate) => candidate.id === opportunity.id);
  assert.ok(row, 'the filed opportunity reads back');
  return row;
}

test('a real company named «Senza azienda» names the Pipeline customer (backlog:ac65e448fcb4)', async (t) => {
  const { app } = scene(t);
  const real = await app.services.companies.create({ name: 'Senza azienda', domain: null }, { actor: OPERATOR });
  assert.equal(real.placeholder, false);
  const row = await fileOpportunity(app, real);
  assert.equal(row.companyPlaceholder, false, 'the opportunity row carries the flag down');
  assert.equal(customerOf(row), 'Senza azienda', 'Pipeline names the real company');
  assert.equal(offerCustomer(row)?.name, 'Senza azienda', 'labels name the real company');
});

test('a placeholder company still names nobody in Pipeline (backlog:ac65e448fcb4)', async (t) => {
  const { app } = scene(t);
  const inner = await app.services.companies.create(
    { name: 'Senza azienda', domain: null, placeholder: true },
    { actor: OPERATOR, allowPlaceholder: true },
  );
  assert.equal(inner.placeholder, true);
  const row = await fileOpportunity(app, inner);
  assert.equal(row.companyPlaceholder, true, 'the opportunity row carries the flag up');
  assert.equal(customerOf(row), null, 'Pipeline hides the placeholder');
  assert.equal(offerCustomer(row), null, 'labels hide the placeholder');
});
