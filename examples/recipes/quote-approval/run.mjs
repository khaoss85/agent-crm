#!/usr/bin/env node
// Deterministic local recipe; simulated actors, fixture catalog, no real customer data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../../../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1 || args[0].startsWith('-')) {
  console.error('Usage: node examples/recipes/quote-approval/run.mjs <empty-project-directory>');
  process.exit(2);
}
const target = resolve(args[0]);
const run = (command, argv, cwd) => {
  const result = spawnSync(command, argv, { cwd, encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? ''}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
};
const cli = (argv) => run(process.execPath, ['--no-warnings', join(target, 'packages/cli/bin/accordo.js'), ...argv, '--root', target], target);
const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
const sourceCommit = sha.status === 0 ? sha.stdout.trim() : null;
const recipeSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');

// The existing bootstrap refuses nonempty targets before any composition writes.
run(process.execPath, [join(source, 'packages/create-accordo/bin/create-accordo.js'), target, '--name', 'quote-approval-example', '--apply', '--json'], source);
console.log('Created a fresh local CRM project from the framework source.');
// Installs the generated project's pinned dependency. No provider calls occur in the journey.
run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund'], target);
mkdirSync(join(target, 'examples/quote-approval'), { recursive: true });
copyFileSync(join(source, 'examples/starters/b2b-lead-qualification/commercial.js'), join(target, 'examples/quote-approval/commercial.js'));
// Dependency order matches the existing commercial end-to-end composition.
const modules = ['product', 'product-version', 'price-book', 'offer', 'price-component', 'price-tier',
  'catalog-sync-run', 'quote', 'quote-line', 'quote-version', 'quote-version-line',
  'quote-version-component', 'quote-version-total', 'quote-approval'];
for (const module of modules) {
  const name = `${module}.module.json`;
  cli(['module', 'create', join(target, 'packages/commercial/modules', name), '--apply']);
}
writeFileSync(join(target, 'packages/domains/generated/index.js'), `// @ts-check
import { createCommercialDomain } from '../../commercial/src/index.js';
import { fixtureSaasCatalogProvider, standardSalesDiscountV1 } from '../../../examples/quote-approval/commercial.js';
export const generatedDomains = [createCommercialDomain({
  catalogProviders: [fixtureSaasCatalogProvider], discountPolicies: [standardSalesDiscountV1],
})];
`);
// The scaffolder's composition test starts empty; this recipe deliberately composes commercial.
const testPath = join(target, 'tests/project.test.js');
const baselineTest = readFileSync(testPath, 'utf8');
const emptyAssertion = "assert.deepEqual(generatedDomains, [], 'add a domain by importing it here, deliberately, one line at a time');";
assert.ok(baselineTest.includes(emptyAssertion), 'review the bootstrap composition test if its contract changes');
writeFileSync(testPath, baselineTest
  .replace('this project composes zero domain packages, which is its declared starting point', 'this project deliberately composes the commercial package')
  .replace(emptyAssertion, "assert.deepEqual(generatedDomains.map((domain) => domain.name), ['commercial']);"));
console.log('Composed the existing commercial package, fixture catalog and 10% auto-approval policy.');
const { createAccordoApp } = await import(pathToFileURL(join(target, 'packages/app/src/index.js')).href);
const { createHttpServer } = await import(pathToFileURL(join(target, 'apps/server/src/index.js')).href);
const { AccordoClient } = await import(pathToFileURL(join(target, 'packages/sdk/src/index.js')).href);
const app = createAccordoApp({ dbPath: join(target, 'data/accordo.sqlite') });
const server = createHttpServer(app);
try {
  await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const agent = new AccordoClient({ baseUrl, actor: { type: 'agent', id: 'example-sales-assistant' } });
  const user = new AccordoClient({ baseUrl, actor: { type: 'user', id: 'example-sales-reviewer' } });
  const company = await agent.createCompany({ name: 'Northwind Studio (synthetic)' });
  const opportunity = await agent.createOpportunity({ companyId: company.id, name: '30-seat B2B proposal (synthetic)', type: 'new_business', valueCents: 500_000, currency: 'EUR', stage: 'discovery', owner: 'example-sales-reviewer' });
  await agent.request('/api/catalog/sync', { method: 'POST', body: { provider: 'fixture-saas-catalog' } });
  const book = app.modules.get('price-book').service.listWhere({ sourceKey: 'fixture:pb:standard-eur' })[0];
  const offer = app.modules.get('offer').service.listWhere({ logicalKey: 'fixture:offer:enterprise', active: true })[0];
  const created = await agent.module('opportunity').action(opportunity.id, 'create-quote', { priceBookId: book.id });
  const quoteId = created.result.quote.id;
  await agent.module('quote').action(quoteId, 'add-line', { offerId: offer.id, quantity: 30, discountBps: 2500 });
  const draft = await agent.module('quote').get(quoteId);
  const totals = JSON.parse(draft.totalsJson);
  assert.equal(totals.oneTimeTotal.netAmountCents, 375_000);
  assert.equal(totals.recurringTotals.length, 1);
  assert.equal(totals.recurringTotals[0].interval, 'month');
  assert.equal(totals.recurringTotals[0].netAmountCents, 240_000);
  console.log('Priced 30 seats at 25% off: EUR 3,750 one-time; EUR 2,400 per month. Periods stay separate.');
  const submitted = await agent.module('quote').action(quoteId, 'submit', { policy: 'standard-sales-discount', version: 1 });
  assert.equal(submitted.result.quote.status, 'pending_approval');
  assert.equal(submitted.result.version.decision, 'approval_required');
  const versionId = submitted.result.version.id;
  const snapshot = app.modules.get('quote-version').service.get(versionId);
  const pendingApproval = app.modules.get('quote-approval').service.get(submitted.result.approvalId);
  assert.match(pendingApproval.policyFingerprint, /^[0-9a-f]{64}$/);
  console.log('Submitted: pending_approval. Policy standard-sales-discount v1 requires a user decision.');
  const auditBefore = app.audit.list({ limit: 500 }).length;
  let refused;
  await assert.rejects(() => agent.module('quote').action(quoteId, 'approve', {}), (error) => {
    refused = { status: error.status, code: error.code, details: error.details };
    return error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED';
  });
  assert.equal((await agent.module('quote').get(quoteId)).status, 'pending_approval');
  assert.deepEqual(app.modules.get('quote-approval').service.get(pendingApproval.id), pendingApproval);
  assert.equal(app.audit.list({ limit: 500 }).length, auditBefore);
  const refusalTrace = await user.getTrace(refused.details.workflowRunId);
  assert.equal(refusalTrace.status, 'failed');
  assert.equal(refusalTrace.input.actor.type, 'agent');
  console.log('Agent approval refused: 403 HUMAN_APPROVAL_REQUIRED. Quote and approval remain pending; no business audit added.');
  const approved = await user.module('quote').action(quoteId, 'approve', {});
  assert.equal((await user.module('quote').get(quoteId)).status, 'approved');
  const decision = app.modules.get('quote-approval').service.get(pendingApproval.id);
  assert.equal(decision.status, 'approved');
  assert.equal(decision.decidedBy, 'example-sales-reviewer');
  assert.equal(app.modules.get('quote-approval').service.countWhere({ quoteId }), 1);
  assert.equal(app.modules.get('quote-version').service.countWhere({ quoteId }), 1);
  assert.deepEqual(app.modules.get('quote-version').service.get(versionId), snapshot);
  const audit = app.audit.list({ entityType: 'quote-approval', entityId: pendingApproval.id, limit: 500 });
  const humanAudit = audit.filter((row) => row.actorType === 'user' && row.actorId === 'example-sales-reviewer');
  assert.equal(humanAudit.length, 1, 'one user decision audit');
  const trace = await user.getTrace(approved.runId);
  assert.equal(trace.status, 'completed');
  assert.equal(trace.input.actor.type, 'user');
  assert.equal(trace.output.approvalId, pendingApproval.id);
  assert.equal(trace.output.versionId, versionId);
  assert.equal(humanAudit[0].data.status, 'approved');
  console.log('Simulated user approved. One user decision audit recorded; submitted commercial snapshot unchanged.');
  const receipt = { example: 'quote-approval', executedAt: new Date().toISOString(), sourceCommit, recipeSha256,
    mode: 'local-development; simulated asserted actors; SQLite; fixture catalog',
    companyId: company.id, opportunityId: opportunity.id, quoteId, versionId, approvalId: pendingApproval.id,
    totals, agentRefusal: refused, refusalTrace, decision, snapshot, humanAudit, approvalTrace: trace };
  writeFileSync(join(target, 'data/quote-approval-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log('PASS. Saved data/accordo.sqlite and data/quote-approval-receipt.json in the requested project.');
  console.log('This was a deterministic SDK/HTTP replay, not a coding-agent build or authenticated human session.');
} finally {
  await new Promise((done) => server.close(done));
  app.close();
}
