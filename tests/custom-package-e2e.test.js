import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DELIVERY_POLICY, activatedContract, boot, project } from './helpers/contracts-project.js';

/**
 * **Custom Package Authoring v1, proven end to end.**
 *
 * A customer-authored package (`examples/custom-packages/partner-scorecard`)
 * attaches to a running application through exactly the path the first-party
 * packages use: its manifest is applied by the ordinary module factory, its
 * definition is added to the checked-in composition file, and nothing in
 * `packages/core` changes. Removing that one import removes it again.
 *
 * If this test ever needs a kernel edit to pass, the authoring story is
 * broken — which is the whole point of keeping it.
 */

const DELIVERY_OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const WINDOW = { targetStartDate: '2026-09-20', targetEndDate: '2026-12-20' };
const PARTNER = { partnerRef: 'partner:abc-consulting', partnerName: 'ABC Consulting', reason: 'they run our migrations' };

test('a customer-authored package attaches, works and detaches with no kernel change', async (t) => {
  const root = project(t, { withDelivery: true, withCustomPackage: true });
  const dbPath = join(root, 'data', 'custom.sqlite');
  const kernelBefore = kernelFingerprint(root);
  const context = await boot(root, dbPath);
  const { app, client, agentClient } = context;

  // ---- it is a package like any other in the published schema ----
  const schema = await client.request('/api/schema');
  assert.equal(schema.domains['partner-scorecard'].packageContract, 1);
  assert.equal(schema.domains['partner-scorecard'].version, 1);
  assert.deepEqual(schema.domains['partner-scorecard'].resources, ['partner-scorecard']);
  assert.deepEqual(schema.domains['partner-scorecard'].actions, ['delivery-partner-engagement.rate-partner']);
  assert.match(schema.domains['partner-scorecard'].policies[0].fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(schema.domains['partner-scorecard']).includes('function'), false);
  assert.match(schema.domains['partner-scorecard'].note, /authoring\/conformance example/i);

  // ---- its action runs on the generic runtime, over the generic API ----
  const { contract } = await activatedContract(root, app, { name: 'Custom Package Deal', offers: DELIVERY_OFFERS });
  await client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY, ...WINDOW, partner: PARTNER,
  });
  const engagement = app.modules.get('delivery-partner-engagement').service.list()[0];

  // An agent may not record a human judgement.
  await assert.rejects(
    () => agentClient.module('delivery-partner-engagement').action(engagement.id, 'rate-partner', {
      policy: 'standard-partner-rating', policyVersion: 1, score: 95, reason: 'bot opinion',
    }),
    (error) => error.status === 403 && error.code === 'HUMAN_APPROVAL_REQUIRED',
  );
  // Bounds are the package's own, enforced like anyone else's.
  for (const [input, expected] of [
    [{ score: 101, reason: 'x' }, /between 0 and 100/],
    [{ score: -1, reason: 'x' }, /between 0 and 100/],
    [{ score: 50, reason: '   ' }, /reason is required/],
    [{ score: 50, reason: `a${String.fromCharCode(0)}b` }, /control characters/],
  ]) {
    await assert.rejects(
      () => client.module('delivery-partner-engagement').action(engagement.id, 'rate-partner', {
        policy: 'standard-partner-rating', policyVersion: 1, ...input,
      }),
      expected,
      JSON.stringify(input),
    );
  }

  const rated = await client.module('delivery-partner-engagement').action(engagement.id, 'rate-partner', {
    policy: 'standard-partner-rating', policyVersion: 1, score: 95, reason: 'delivered the migration on time',
  });
  assert.equal(rated.result.scorecard.rating, 'preferred', 'the versioned policy decided the band');

  const scorecard = app.modules.get('partner-scorecard').service.listWhere({ engagementId: engagement.id })[0];
  assert.equal(scorecard.score, 95);
  assert.equal(scorecard.partnerRef, PARTNER.partnerRef);
  assert.equal(scorecard.ratedBy, 'e2e');
  assert.match(scorecard.policyFingerprint, /^[0-9a-f]{64}$/);
  // Its records are read-only publicly, like every other package's evidence.
  assert.deepEqual(app.modules.get('partner-scorecard').capabilities, ['get', 'list']);
  const post = await fetch(`${context.baseUrl}/api/modules/partner-scorecard/records`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-actor-type': 'user', 'x-actor-id': 'e2e' },
    body: JSON.stringify({ score: 100 }),
  });
  assert.equal(post.status, 404);
  // A second rating is a stable refusal, not a second opinion.
  await assert.rejects(
    () => client.module('delivery-partner-engagement').action(engagement.id, 'rate-partner', {
      policy: 'standard-partner-rating', policyVersion: 1, score: 20, reason: 'changed my mind',
    }),
    (error) => error.code === 'ALREADY_RATED',
  );
  // Audit and trace treat it exactly like a first-party action.
  assert.equal(app.audit.list({ limit: 500 }).filter((entry) => entry.entityType === 'partner-scorecard').length, 1);
  const run = app.workflows.listRuns({ workflowName: 'delivery-partner-engagement.rate-partner', status: 'completed', limit: 5 })[0];
  assert.ok(run, 'the package action produced a trace run');
  await context.close();

  // ---- removing it is one line in the composition file ----
  const composition = join(root, 'packages/domains/generated/index.js');
  const source = readFileSync(composition, 'utf8');
  writeFileSync(
    composition,
    source
      .split('\n')
      .filter((line) => !line.includes('partner-scorecard') && !line.includes('createPartnerScorecardPackage'))
      .join('\n'),
  );
  const probe = spawnSync(process.execPath, ['--no-warnings', '-e', `
    const { createAccordoApp } = await import(${JSON.stringify(pathToFileURL(join(root, 'packages/app/src/index.js')).href)});
    const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });
    console.log(JSON.stringify({
      packages: [...app.domains.names()],
      actions: app.actions.listForModule('delivery-partner-engagement').map((action) => action.name),
      scorecards: app.database.raw.prepare('SELECT COUNT(*) AS n FROM partner_scorecards').get().n,
      deliveryProjects: app.database.raw.prepare('SELECT COUNT(*) AS n FROM delivery_projects').get().n,
    }));
    app.close();
  `], { encoding: 'utf8', cwd: root });
  assert.equal(probe.status, 0, probe.stderr);
  const facts = JSON.parse(probe.stdout.trim().split('\n').at(-1));
  assert.deepEqual(facts.packages, ['commercial', 'signature', 'contracts', 'delivery'], 'the custom package is gone');
  assert.deepEqual(facts.actions, [], 'and so is its action');
  assert.equal(facts.scorecards, 1, 'its data is left alone, not deleted');
  assert.equal(facts.deliveryProjects, 1, 'every other package is untouched');

  // ---- and the kernel never changed ----
  assert.deepEqual(kernelFingerprint(root), kernelBefore, 'no kernel source was modified to make this work');
});

/** A content fingerprint of every kernel source file, to prove none changed. */
function kernelFingerprint(root) {
  const dir = join(root, 'packages/core/src');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => `${name}:${createHash('sha256').update(readFileSync(join(dir, name))).digest('hex').slice(0, 16)}`);
}
