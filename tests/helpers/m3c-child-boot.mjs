#!/usr/bin/env node
// Child-process evidence for PostgreSQL application composition. Prints one
// JSON receipt and never echoes locators or credentials.

import { createAccordoAppAsync } from '../../packages/app/src/index.js';
import { createTestVerifier } from './identity-verifier-fixture.mjs';
import { GADGET_MIGRATION } from './postgresql-application.js';

const SENTINEL = process.env.ACCORDO_M3C_SENTINEL ?? 'SUPERSECRET_SENTINEL_PASSWORD';

function endpoint(database) {
  return {
    host: process.env.ACCORDO_M3C_HOST,
    port: Number(process.env.ACCORDO_M3C_PORT ?? 5432),
    database,
    user: process.env.ACCORDO_M3C_USER,
    password: process.env.ACCORDO_M3C_PASSWORD ?? '',
  };
}

const actor = { type: 'system', id: 'm3c-child' };
const app = await createAccordoAppAsync({
  adapter: 'postgresql',
  testHarness: {
    loopback: true,
    control: endpoint(process.env.ACCORDO_M3C_CONTROL_DB),
    data: endpoint(process.env.ACCORDO_M3C_DATA_DB),
  },
  spine: { mode: 'local-development', tenant: { id: 'acme' } },
  identityVerifier: createTestVerifier({ tenantId: 'acme' }),
  moduleMigrations: [GADGET_MIGRATION],
});

try {
  const company = await app.services.companies.create({ name: 'Child Co' }, { actor });
  const listed = await Promise.resolve(app.services.companies.list());
  const contact = await app.services.contacts.create({
    companyId: company.id, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@child.test',
  }, { actor });
  const opportunity = await app.services.opportunities.create({
    companyId: company.id,
    contactId: contact.id,
    name: 'Child deal',
    valueCents: 6_000_000,
    owner: 'ada',
  }, { actor });
  const approval = await app.services.approvals.request({
    opportunityId: opportunity.id,
    reason: 'policy requires approval',
  }, { actor });
  const workflow = await app.workflows.run('request-opportunity-stage-change', {
    opportunityId: opportunity.id,
    targetStage: 'proposal',
  }, { actor });
  const run = await Promise.resolve(app.workflows.getRun(workflow.runId));
  const audit = await Promise.resolve(app.audit.list({ entityType: 'company', entityId: company.id, limit: 10 }));
  const health = app.health();
  const receipt = {
    ok: true,
    adapter: app.storage.adapter,
    available: app.storage.available,
    companyCount: listed.length,
    company: company.name,
    contact: contact.email,
    opportunity: opportunity.name,
    approval: approval.status,
    workflow: workflow.status,
    traceSpans: (run?.spans ?? []).map((span) => span.name),
    auditActions: audit.map((entry) => entry.action),
    healthAdapter: health.storage.adapter,
    tenantBinding: app.tenantBinding,
  };
  const blob = JSON.stringify(receipt);
  if (blob.includes(SENTINEL) || (process.env.ACCORDO_M3C_PASSWORD && blob.includes(process.env.ACCORDO_M3C_PASSWORD))) {
    throw new Error('child receipt leaked a credential');
  }
  process.stdout.write(`${blob}\n`);
} finally {
  await app.close();
}
