import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Milestone 9 e2e: enrichment snapshots, explainable versioned scoring,
 * deterministic routing and assignment history — proven in a clean throwaway
 * project with the real CLI/factory, real HTTP server and SDK, against the
 * starter's deterministic fixture provider (no network).
 */
function project(t, { enrichTimeoutMs } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-intel-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of [
    'lead.module.json',
    'task.module.json',
    'enrichment-snapshot.module.json',
    'behavioral-signal.module.json',
    'score-run.module.json',
    'score-contribution.module.json',
    'routing-run.module.json',
    'route-evaluation.module.json',
    'assignment.module.json',
  ]) {
    assert.equal(cli(root, ['module', 'create', join(starter, manifest), '--apply']).status, 0, `apply ${manifest}`);
  }
  const builderOptions = enrichTimeoutMs ? `{ timeoutMs: ${enrichTimeoutMs} }` : '';
  writeFileSync(
    join(root, 'packages/actions/generated/index.js'),
    [
      '// @ts-check',
      "import { qualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/qualify.js';",
      "import { disqualifyLead } from '../../../examples/starters/b2b-lead-qualification/actions/disqualify.js';",
      "import { buildEnrichAction, buildRecordSignalAction, buildScoreAction, buildRouteAction } from '../../core/src/intelligence-actions.js';",
      `export const generatedActions = [qualifyLead, disqualifyLead, buildEnrichAction(${builderOptions}), buildRecordSignalAction(), buildScoreAction(), buildRouteAction()];`,
      '',
    ].join('\n'),
  );
  writeIntelligenceIndex(root);
  return root;
}

function writeIntelligenceIndex(root) {
  writeFileSync(
    join(root, 'packages/intelligence/generated/index.js'),
    [
      '// @ts-check',
      "import { fixtureFirmographicsProvider, b2bSaasScoreV1, b2bSaasScoreV2, b2bRoutingV1, b2bRoutingV2, routingTargets } from '../../../examples/starters/b2b-lead-qualification/intelligence.js';",
      'export const generatedEnrichmentProviders = [fixtureFirmographicsProvider];',
      'export const generatedScoringModels = [b2bSaasScoreV1, b2bSaasScoreV2];',
      'export const generatedRoutingPolicies = [b2bRoutingV1, b2bRoutingV2];',
      'export const generatedRoutingTargets = routingTargets;',
      '',
    ].join('\n'),
  );
}

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root], {
    encoding: 'utf8',
    cwd: root,
  });
}

async function boot(root, dbPath, options = {}) {
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AccordoClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAccordoApp({ dbPath, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AccordoClient({ baseUrl, actor: { type: 'user', id: 'intel-e2e' } });
  return { app, client, close: () => new Promise((resolve) => server.close(resolve)).then(() => app.close()) };
}

test('lead intelligence end to end: enrich → score → route over HTTP/SDK, immutability, reuse/expiry, restart', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'intel.sqlite');
  let instance = await boot(root, dbPath);
  // A failed assertion must not leave the HTTP server running (it would hang
  // the test runner) — always close whatever instance is current.
  t.after(() => instance.close().catch(() => {}));
  const { client } = instance;
  const leads = client.module('lead');

  // Schema: intelligence metadata + the four lead actions, all additive.
  const schema = await client.schema();
  assert.ok(schema.intelligence, 'schema exposes intelligence metadata');
  assert.deepEqual(schema.intelligence.enrichmentProviders.map((p) => p.name), ['fixture-firmographics']);
  assert.deepEqual(schema.intelligence.scoringModels.map((m) => `${m.name}@${m.version}`), ['b2b-saas-score@1', 'b2b-saas-score@2']);
  assert.deepEqual(schema.intelligence.routingPolicies.map((p) => `${p.name}@${p.version}`), ['b2b-sales-routing@1', 'b2b-sales-routing@2']);
  assert.equal(schema.intelligence.routingTargets.length, 4);
  assert.match(schema.intelligence.scoringModels[0].fingerprint, /^[0-9a-f]{64}$/);
  const leadMeta = schema.generatedModules.find((m) => m.name === 'lead');
  for (const name of ['enrich', 'record-signal', 'route', 'score']) {
    assert.ok(leadMeta.actions.some((a) => a.name === name), `lead action ${name} advertised`);
  }
  for (const field of ['score', 'enrichmentSnapshotId', 'scoreRunId', 'assignedTargetId', 'routingRunId']) {
    assert.equal(leadMeta.fields.find((f) => f.name === field).writable, 'managed', `${field} is managed`);
  }

  // Capture + behavioral signals; a duplicated sourceKey is a stable 409.
  const lead = await leads.create({ firstName: 'Giulia', lastName: 'Ferrari', email: 'giulia@ferrari.example', companyName: 'Ferrari Sistemi', source: 'website' });
  await leads.action(lead.id, 'record-signal', { signalType: 'pricing-page-visited', observedAt: '2026-08-01T10:00:00Z' });
  await leads.action(lead.id, 'record-signal', { signalType: 'demo-requested', observedAt: '2026-08-01T11:00:00Z' });
  await assert.rejects(
    () => leads.action(lead.id, 'record-signal', { signalType: 'demo-requested', observedAt: '2026-08-01T11:00:00Z' }),
    (error) => error.status === 409,
    'duplicate signal sourceKey refused',
  );
  const signals = (await client.module('behavioral-signal').list()).items.filter((s) => s.leadId === lead.id);
  assert.equal(signals.length, 2, 'no duplicate signal record');

  // Enrich: snapshot + provenance + managed link; repeat reuses.
  const enriched = await leads.action(lead.id, 'enrich', { provider: 'fixture-firmographics' });
  assert.equal(enriched.result.reused, false);
  const snapshotId = enriched.result.snapshot.id;
  assert.equal(enriched.result.snapshot.sourceKey, `enrich:${lead.id}:fixture-firmographics@1:1`);
  const snapshot = await client.module('enrichment-snapshot').get(snapshotId);
  assert.equal(snapshot.leadId, lead.id);
  assert.equal(snapshot.country, 'IT');
  assert.equal(snapshot.language, 'it');
  assert.equal(snapshot.employeeRange, '1000-5000');
  assert.equal(snapshot.status, 'complete');
  assert.equal(snapshot.confidence, 95);
  assert.equal(snapshot.sourceRef, 'fixture:ferrari.example');
  assert.match(snapshot.providerFingerprint, /^[0-9a-f]{64}$/, 'snapshot carries the provider fingerprint');
  assert.equal(snapshot.providerFingerprint, schema.intelligence.enrichmentProviders[0].fingerprint);
  assert.ok(snapshot.retrievedAt && snapshot.expiresAt, 'provenance timestamps present');
  assert.equal((await leads.get(lead.id)).enrichmentSnapshotId, snapshotId);
  const again = await leads.action(lead.id, 'enrich', { provider: 'fixture-firmographics' });
  assert.equal(again.result.reused, true, 'non-expired snapshot reused');
  assert.equal((await client.module('enrichment-snapshot').list()).items.filter((s) => s.leadId === lead.id).length, 1);

  // Score v1: explainable and reproducible.
  const scored = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 1 });
  assert.equal(scored.result.total, 75);
  assert.equal(scored.result.model, 'b2b-saas-score');
  assert.equal(scored.result.version, 1);
  assert.match(scored.result.fingerprint, /^[0-9a-f]{64}$/);
  const byKey = Object.fromEntries(scored.result.contributions.map((c) => [c.ruleKey, c]));
  assert.deepEqual(
    scored.result.contributions.map((c) => c.ruleKey),
    ['enterprise-company', 'supported-country', 'demo-requested', 'pricing-page-visited', 'highly-engaged', 'missing-company-name'],
    'contributions in declared rule order',
  );
  assert.equal(byKey['enterprise-company'].contribution, 30);
  assert.equal(byKey['supported-country'].contribution, 10);
  assert.equal(byKey['demo-requested'].contribution, 25);
  assert.equal(byKey['pricing-page-visited'].contribution, 10);
  assert.equal(byKey['highly-engaged'].matched, false);
  assert.equal(byKey['missing-company-name'].matched, false);
  const persistedContributions = (await client.module('score-contribution').list()).items.filter((c) => c.runId === scored.result.runId);
  assert.equal(persistedContributions.length, 6, 'every rule persisted a contribution');
  const run = await client.module('score-run').get(scored.result.runId);
  assert.equal(run.totalScore, 75);
  assert.equal(run.snapshotId, snapshotId);
  assert.equal(run.signalCount, 2);
  assert.equal(run.fingerprint, scored.result.fingerprint);
  assert.match(run.leadFingerprint, /^[0-9a-f]{64}$/, 'the mutable lead-field inputs are fingerprinted per run');
  assert.match(run.signalsFingerprint, /^[0-9a-f]{64}$/);
  const linked = await leads.get(lead.id);
  assert.equal(linked.score, 75);
  assert.equal(linked.scoreRunId, scored.result.runId);

  // Re-scoring with identical inputs reproduces the total in a NEW run; the
  // old run stays readable — history is never rewritten.
  const rescored = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 1 });
  assert.equal(rescored.result.total, 75, 'deterministic for identical inputs');
  assert.notEqual(rescored.result.runId, scored.result.runId);
  assert.equal((await client.module('score-run').get(scored.result.runId)).totalScore, 75, 'old run intact');

  // Model v2 exists alongside v1 with its own fingerprint and behavior.
  await leads.action(lead.id, 'record-signal', { signalType: 'product-activated', observedAt: '2026-08-02T09:00:00Z' });
  const v2 = await leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 2 });
  assert.equal(v2.result.total, 100, 'v2 raw total 135 (adds product-activated + highly-engaged) clamps to the declared maxScore 100');
  assert.notEqual(v2.result.fingerprint, scored.result.fingerprint, 'versions have distinct fingerprints');
  assert.equal((await client.module('score-run').get(scored.result.runId)).modelVersion, 1, 'old run keeps its version');
  await assert.rejects(() => leads.action(lead.id, 'score', { model: 'b2b-saas-score', version: 99 }), (e) => e.status === 404);
  await assert.rejects(() => leads.action(lead.id, 'score', { model: 'ghost-model', version: 1 }), (e) => e.status === 404);

  // Route v1 → Enterprise Italy (deterministic, run + assignment history).
  const routed = await leads.action(lead.id, 'route', { policy: 'b2b-sales-routing', version: 1 });
  assert.equal(routed.result.target.key, 'enterprise-italy');
  assert.equal(routed.result.fallbackReason, null);
  assert.match(routed.result.matchedRule, /country\/language match/);
  const routingRun = await client.module('routing-run').get(routed.result.runId);
  assert.equal(routingRun.selectedTarget, 'enterprise-italy');
  assert.equal(routingRun.policyVersion, 1);
  assert.equal(routingRun.fingerprint, routed.result.fingerprint);
  assert.ok(routingRun.evaluatedTargets >= 3);
  const assignment = await client.module('assignment').get(routed.result.assignmentId);
  assert.equal(assignment.leadId, lead.id);
  assert.equal(assignment.targetId, 'enterprise-italy');
  assert.equal(assignment.source, 'automatic');
  assert.equal(assignment.routingRunId, routed.result.runId);
  const assigned = await leads.get(lead.id);
  assert.equal(assigned.assignedTargetId, 'enterprise-italy');
  assert.equal(assigned.routingRunId, routed.result.runId);

  // Chosen v1 semantics: rerouting an assigned lead is a stable conflict.
  await assert.rejects(
    () => leads.action(lead.id, 'route', { policy: 'b2b-sales-routing', version: 1 }),
    (error) => error.status === 409 && error.code === 'ALREADY_ASSIGNED',
  );
  // An unscored lead cannot be routed.
  const unscored = await leads.create({ firstName: 'No', lastName: 'Score', email: 'no@sevilla.example' });
  await assert.rejects(
    () => leads.action(unscored.id, 'route', { policy: 'b2b-sales-routing', version: 1 }),
    (error) => error.status === 409 && error.code === 'LEAD_NOT_SCORED',
  );

  // Fallback: unsupported territory lands in the declared fallback queue.
  const nordic = await leads.create({ firstName: 'Jon', lastName: 'Stefansson', email: 'jon@reykjavik.example', companyName: 'Reykjavik Hosting' });
  await leads.action(nordic.id, 'enrich', { provider: 'fixture-firmographics' });
  await leads.action(nordic.id, 'score', { model: 'b2b-saas-score', version: 1 });
  const fallback = await leads.action(nordic.id, 'route', { policy: 'b2b-sales-routing', version: 1 });
  assert.equal(fallback.result.target.key, 'unrouted-queue');
  assert.equal(fallback.result.target.kind, 'fallback');
  assert.ok(fallback.result.fallbackReason, 'fallback reason recorded');

  // Expiry: an already-expired snapshot is refreshed as a NEW versioned
  // snapshot (never overwritten), and scoring ignores the expired input.
  const ephemeral = await leads.create({ firstName: 'Eva', lastName: 'Now', email: 'eva@ephemeral.example', companyName: 'Ephemeral Labs' });
  const first = await leads.action(ephemeral.id, 'enrich', { provider: 'fixture-firmographics' });
  assert.equal(first.result.reused, false);
  const second = await leads.action(ephemeral.id, 'enrich', { provider: 'fixture-firmographics' });
  assert.equal(second.result.reused, false, 'expired snapshot triggers a refresh');
  assert.notEqual(second.result.snapshot.id, first.result.snapshot.id);
  assert.equal(second.result.snapshot.sourceKey, `enrich:${ephemeral.id}:fixture-firmographics@1:2`);
  assert.equal((await client.module('enrichment-snapshot').get(first.result.snapshot.id)).id, first.result.snapshot.id, 'historical snapshot preserved');
  const ephemeralScore = await leads.action(ephemeral.id, 'score', { model: 'b2b-saas-score', version: 1 });
  assert.equal(ephemeralScore.result.snapshotId, null, 'expired snapshot is not a valid scoring input');

  // Read-only boundary: the intelligence record modules expose NO public
  // write at all — create and update are absent from the service and the
  // capability list, so HTTP POST/PATCH fail closed (404, per ADR-008
  // capability gating) and no client can create even an empty row. Mixed
  // payloads on the lead reject managed fields before any public field
  // applies.
  for (const [module, patch] of [
    ['enrichment-snapshot', { country: 'XX' }],
    ['behavioral-signal', { signalType: 'forged' }],
    ['score-run', { totalScore: 999 }],
    ['score-contribution', { contribution: 999 }],
    ['routing-run', { selectedTarget: 'forged' }],
    ['route-evaluation', { eligible: true }],
    ['assignment', { targetId: 'forged' }],
  ]) {
    const meta = schema.generatedModules.find((m) => m.name === module) ?? (await client.request(`/api/modules/${module}`));
    assert.deepEqual(meta.capabilities, ['get', 'list'], `${module} advertises read-only capabilities`);
    await assert.rejects(
      () => client.module(module).create(patch),
      (error) => error.status === 404,
      `${module} create is absent (404), even empty`,
    );
    await assert.rejects(
      () => client.module(module).create({}),
      (error) => error.status === 404,
      `${module} cannot create an empty row`,
    );
  }
  await assert.rejects(
    () => client.module('enrichment-snapshot').update(snapshotId, { country: 'XX' }),
    (error) => error.status === 404,
    'snapshot update is absent, never a silent no-op',
  );
  await assert.rejects(
    () => client.module('assignment').update(routed.result.assignmentId, {}),
    (error) => error.status === 404,
    'assignment update is absent, never a silent no-op',
  );
  for (const field of ['score', 'scoreRunId', 'assignedTargetId', 'enrichmentSnapshotId', 'routingRunId']) {
    await assert.rejects(
      () => leads.update(lead.id, { [field]: 'forged' }),
      (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
      `lead.${field} is CRUD-proof`,
    );
  }
  // A mixed payload (public + managed) is rejected whole: the public field
  // does not change.
  await assert.rejects(
    () => leads.update(lead.id, { firstName: 'Sneaky', score: 999 }),
    (error) => error.status === 400 && error.code === 'VALIDATION_ERROR',
  );
  assert.equal((await leads.get(lead.id)).firstName, 'Giulia', 'no partial application of a mixed payload');

  // Audit + trace: the route action produced a completed trace run.
  const traces = await client.request('/api/traces?workflowName=lead.route');
  assert.ok(traces.items.filter((item) => item.status === 'completed').length >= 2, 'successful routes traced');
  assert.ok(traces.items.filter((item) => item.status === 'failed').length >= 1, 'refused routes leave honest failed traces');

  // Restart: links, runs and assignments survive a full reboot.
  await instance.close();
  instance = await boot(root, dbPath);
  const rebooted = instance.client;
  const persisted = await rebooted.module('lead').get(lead.id);
  assert.equal(persisted.assignedTargetId, 'enterprise-italy');
  assert.equal(persisted.score, 100, 'latest (clamped) score persisted');
  assert.equal((await rebooted.module('score-run').get(scored.result.runId)).modelVersion, 1);
  assert.equal((await rebooted.module('assignment').get(routed.result.assignmentId)).targetId, 'enterprise-italy');
  await instance.close();
});

test('lead intelligence failure semantics and hostile inputs', async (t) => {
  const root = project(t, { enrichTimeoutMs: 150 });
  const dbPath = join(root, 'data', 'intel-fail.sqlite');
  const instance = await boot(root, dbPath);
  t.after(() => instance.close());
  const { client } = instance;
  const leads = client.module('lead');

  // Provider outage: honest failure, nothing persisted, failed trace.
  const outage = await leads.create({ firstName: 'Out', lastName: 'Age', email: 'x@fail.example' });
  await assert.rejects(
    () => leads.action(outage.id, 'enrich', { provider: 'fixture-firmographics' }),
    (error) => error.status === 502 && error.code === 'PROVIDER_FAILED',
  );
  assert.equal((await leads.get(outage.id)).enrichmentSnapshotId, null);
  assert.equal((await client.module('enrichment-snapshot').list()).items.filter((s) => s.leadId === outage.id).length, 0);
  const failedTraces = await client.request('/api/traces?workflowName=lead.enrich');
  assert.ok(failedTraces.items.some((item) => item.status === 'failed'), 'provider failure leaves an honest failed trace');

  // Provider timeout: bounded, stable code, nothing persisted.
  const slow = await leads.create({ firstName: 'Slow', lastName: 'Poke', email: 'x@slow.example' });
  await assert.rejects(
    () => leads.action(slow.id, 'enrich', { provider: 'fixture-firmographics' }),
    (error) => error.status === 504 && error.code === 'PROVIDER_TIMEOUT',
  );
  assert.equal((await leads.get(slow.id)).enrichmentSnapshotId, null);

  // Late settlement AFTER the timeout: the abandoned promise's rejection is
  // observed (never an unhandled rejection) and nothing is persisted late.
  /** @type {unknown[]} */
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const late = await leads.create({ firstName: 'Late', lastName: 'Fail', email: 'x@latefail.example' });
    await assert.rejects(
      () => leads.action(late.id, 'enrich', { provider: 'fixture-firmographics' }),
      (error) => error.status === 504 && error.code === 'PROVIDER_TIMEOUT',
      'the timeout wins; the late rejection is abandoned',
    );
    await new Promise((resolve) => setTimeout(resolve, 600)); // let the late rejection fire
    assert.deepEqual(unhandled, [], 'no unhandled rejection from the late-settling provider');
    assert.equal((await leads.get(late.id)).enrichmentSnapshotId, null, 'nothing persisted late');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }

  // Provider returning out-of-contract data: refused, never persisted.
  const invalid = await leads.create({ firstName: 'In', lastName: 'Valid', email: 'x@invalid.example' });
  await assert.rejects(
    () => leads.action(invalid.id, 'enrich', { provider: 'fixture-firmographics' }),
    (error) => error.status === 502 && error.code === 'PROVIDER_INVALID',
  );

  // Partial data is honest: status partial, missing fields null.
  const unknown = await leads.create({ firstName: 'Un', lastName: 'Known', email: 'x@nowhere-known.example' });
  const partial = await leads.action(unknown.id, 'enrich', { provider: 'fixture-firmographics' });
  assert.equal(partial.result.snapshot.status, 'partial');
  assert.equal(partial.result.snapshot.country, null);

  // Hostile inputs: prototype names, markup, oversized strings.
  const hostile = await leads.create({ firstName: 'Hostile', lastName: 'Input', email: 'h@acme.example' });
  await assert.rejects(
    () => leads.action(hostile.id, 'enrich', { provider: '__proto__' }),
    (error) => error.status === 404,
    'prototype provider names never resolve',
  );
  await assert.rejects(
    () => leads.action(hostile.id, 'record-signal', { signalType: '__proto__', observedAt: '2026-08-01T10:00:00Z' }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => leads.action(hostile.id, 'record-signal', { signalType: 'ok-type', observedAt: '2026-08-01T10:00:00Z', value: 'x'.repeat(10_001) }),
    (error) => error.status === 400,
    'oversized values bounded by the action input contract',
  );
  const markup = '<img src=x onerror=alert(1)>`${process.exit(1)}` ';
  const signal = await leads.action(hostile.id, 'record-signal', {
    signalType: 'pricing-page-visited',
    observedAt: '2026-08-01T10:00:00Z',
    value: markup,
    source: 'web"quote\'s',
  });
  const stored = await client.module('behavioral-signal').get(signal.result.signal.id);
  assert.equal(stored.value, markup.trim(), 'hostile value stored verbatim (outer whitespace trimmed by the input contract)');
  await assert.rejects(
    () => leads.action(hostile.id, 'score', { model: 'b2b-saas-score', version: 1.5 }),
    (error) => error.status === 400,
    'fractional versions rejected by the integer input contract',
  );
  await assert.rejects(
    () => leads.action(hostile.id, 'route', { policy: 'constructor', version: 1 }),
    (error) => error.status === 409 || error.status === 404,
    'prototype policy names never resolve (unscored lead 409s first)',
  );
});

test('lead intelligence concurrency, one-assignment guarantee and fingerprint drift on reboot', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'intel-conc.sqlite');
  const instance = await boot(root, dbPath, { busyTimeoutMs: 400 });
  t.after(() => instance.close());
  const { app, client } = instance;
  const leads = client.module('lead');
  const actor = { type: 'user', id: 'conc' };

  // Same-app concurrent enrich (over HTTP, the M6 concurrency pattern — one
  // connection serializes writers): one snapshot; the second call reuses it.
  const lead = await leads.create({ firstName: 'Race', lastName: 'One', email: 'race@ferrari.example', companyName: 'Ferrari Sistemi' });
  const enrichments = await Promise.allSettled([
    leads.action(lead.id, 'enrich', { provider: 'fixture-firmographics' }),
    leads.action(lead.id, 'enrich', { provider: 'fixture-firmographics' }),
  ]);
  assert.ok(enrichments.every((r) => r.status === 'fulfilled'), 'both enrich calls resolve');
  const reusedFlags = enrichments.map((r) => r.value.result.reused).sort();
  assert.deepEqual(reusedFlags, [false, true], 'exactly one snapshot creation; the other reused');
  const snapshots = app.modules.get('enrichment-snapshot').service.list({ limit: 500 }).filter((s) => s.leadId === lead.id);
  assert.equal(snapshots.length, 1, 'no duplicate snapshot under same-app concurrency');

  await app.runAction({ module: 'lead', action: 'score', recordId: lead.id, input: { model: 'b2b-saas-score', version: 1 }, actor });

  // Same-app concurrent route: exactly one final assignment; the loser gets a
  // stable ALREADY_ASSIGNED, never a duplicate or a raw SQLITE error.
  const routes = await Promise.allSettled([
    leads.action(lead.id, 'route', { policy: 'b2b-sales-routing', version: 1 }),
    leads.action(lead.id, 'route', { policy: 'b2b-sales-routing', version: 1 }),
  ]);
  const routeOutcomes = routes.map((r) => (r.status === 'fulfilled' ? 'ok' : r.reason.code)).sort();
  assert.deepEqual(routeOutcomes, ['ALREADY_ASSIGNED', 'ok']);
  assert.equal(app.modules.get('assignment').service.list({ limit: 500 }).filter((a) => a.leadId === lead.id).length, 1);
  assert.equal(app.modules.get('routing-run').service.list({ limit: 500 }).filter((r) => r.leadId === lead.id).length, 1);

  // Two independent connections racing to route: one winner, stable 409s for
  // the loser (ALREADY_ASSIGNED or retryable CONFLICT), one assignment.
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const second = createAccordoApp({ dbPath, busyTimeoutMs: 200 });
  t.after(() => second.close());
  const lead2 = await leads.create({ firstName: 'Race', lastName: 'Two', email: 'race2@sevilla.example', companyName: 'Sevilla Digital' });
  await app.runAction({ module: 'lead', action: 'enrich', recordId: lead2.id, input: { provider: 'fixture-firmographics' }, actor });
  await app.runAction({ module: 'lead', action: 'score', recordId: lead2.id, input: { model: 'b2b-saas-score', version: 1 }, actor });
  const crossResults = await Promise.allSettled([
    app.runAction({ module: 'lead', action: 'route', recordId: lead2.id, input: { policy: 'b2b-sales-routing', version: 1 }, actor }),
    second.runAction({ module: 'lead', action: 'route', recordId: lead2.id, input: { policy: 'b2b-sales-routing', version: 1 }, actor }),
  ]);
  const winners = crossResults.filter((r) => r.status === 'fulfilled');
  const losers = crossResults.filter((r) => r.status === 'rejected');
  assert.equal(winners.length, 1, 'exactly one cross-connection winner');
  for (const loser of losers) {
    assert.equal(loser.reason.status, 409, 'loser gets a stable 409');
    assert.ok(['ALREADY_ASSIGNED', 'CONFLICT'].includes(loser.reason.code), `stable code, got ${loser.reason.code}`);
    assert.ok(!/SQLITE_BUSY/.test(loser.reason.message), 'never a raw SQLITE error');
  }
  assert.equal(app.modules.get('assignment').service.list({ limit: 500 }).filter((a) => a.leadId === lead2.id).length, 1);
  assert.equal(second.modules.get('lead').service.get(lead2.id).assignedTargetId, 'spain-sales');

  // Capacity: a full target drops out of eligibility deterministically. Spain
  // Sales has capacity 5 and already carries the cross-connection winner above,
  // so four more Spanish leads fill it — the next one overflows to the growth
  // queue (ES is in its country list), never to a random or overloaded target.
  for (let i = 0; i < 4; i += 1) {
    const es = await leads.create({ firstName: `Cap${i}`, lastName: 'Es', email: `cap${i}@sevilla.example`, companyName: 'Sevilla Digital' });
    await app.runAction({ module: 'lead', action: 'enrich', recordId: es.id, input: { provider: 'fixture-firmographics' }, actor });
    await app.runAction({ module: 'lead', action: 'score', recordId: es.id, input: { model: 'b2b-saas-score', version: 1 }, actor });
    const routedEs = await app.runAction({ module: 'lead', action: 'route', recordId: es.id, input: { policy: 'b2b-sales-routing', version: 1 }, actor });
    assert.equal(routedEs.result.target.key, 'spain-sales', `lead ${i + 2} of 5 fits Spain Sales capacity`);
  }
  const overflow = await leads.create({ firstName: 'Cap6', lastName: 'Es', email: 'cap6@sevilla.example', companyName: 'Sevilla Digital' });
  await app.runAction({ module: 'lead', action: 'enrich', recordId: overflow.id, input: { provider: 'fixture-firmographics' }, actor });
  await app.runAction({ module: 'lead', action: 'score', recordId: overflow.id, input: { model: 'b2b-saas-score', version: 1 }, actor });
  const overflowRouted = await app.runAction({ module: 'lead', action: 'route', recordId: overflow.id, input: { policy: 'b2b-sales-routing', version: 1 }, actor });
  assert.equal(overflowRouted.result.target.key, 'growth-queue', 'a full target is excluded; the next eligible target wins');
  // The routing run carries complete decision evidence: policy + target-set
  // fingerprints plus one route-evaluation row per candidate with the exact
  // load/capacity the decision saw ("at capacity" for Spain).
  const overflowRun = app.modules.get('routing-run').service.get(overflowRouted.result.runId);
  assert.match(overflowRun.targetsFingerprint, /^[0-9a-f]{64}$/);
  const evaluations = app.modules.get('route-evaluation').service.listWhere({ runId: overflowRouted.result.runId });
  assert.equal(evaluations.length, 3, 'one evaluation row per non-fallback candidate');
  const spainEvaluation = evaluations.find((row) => row.targetKey === 'spain-sales');
  assert.equal(spainEvaluation.eligible, false);
  assert.match(spainEvaluation.reason, /at capacity \(5\/5 active leads\)/);

  // Capacity means ACTIVE workload: disqualifying an assigned lead releases
  // its slot, and the next Spanish lead lands in Spain Sales again.
  const releasedLead = app.modules.get('lead').service.listWhere({ assignedTargetId: 'spain-sales', status: 'new' })[0];
  await app.runAction({ module: 'lead', action: 'disqualify', recordId: releasedLead.id, input: { reason: 'Duplicate entry' }, actor });
  const afterRelease = await leads.create({ firstName: 'Cap7', lastName: 'Es', email: 'cap7@sevilla.example', companyName: 'Sevilla Digital' });
  await app.runAction({ module: 'lead', action: 'enrich', recordId: afterRelease.id, input: { provider: 'fixture-firmographics' }, actor });
  await app.runAction({ module: 'lead', action: 'score', recordId: afterRelease.id, input: { model: 'b2b-saas-score', version: 1 }, actor });
  const routedAfterRelease = await app.runAction({ module: 'lead', action: 'route', recordId: afterRelease.id, input: { policy: 'b2b-sales-routing', version: 1 }, actor });
  assert.equal(routedAfterRelease.result.target.key, 'spain-sales', 'a disqualified lead released its capacity slot');

  // Two independent connections race for the LAST Spain slot (Spain is full
  // again): writers serialize, exactly one wins the slot, the loser
  // deterministically overflows to the growth queue (or gets a stable 409) —
  // no target ever exceeds capacity.
  const raceA = await leads.create({ firstName: 'Slot', lastName: 'A', email: 'slot-a@sevilla.example', companyName: 'Sevilla Digital' });
  const raceB = await leads.create({ firstName: 'Slot', lastName: 'B', email: 'slot-b@sevilla.example', companyName: 'Sevilla Digital' });
  const released2 = app.modules.get('lead').service.listWhere({ assignedTargetId: 'spain-sales', status: 'new' })[0];
  await app.runAction({ module: 'lead', action: 'disqualify', recordId: released2.id, input: { reason: 'Duplicate entry' }, actor });
  for (const race of [raceA, raceB]) {
    await app.runAction({ module: 'lead', action: 'enrich', recordId: race.id, input: { provider: 'fixture-firmographics' }, actor });
    await app.runAction({ module: 'lead', action: 'score', recordId: race.id, input: { model: 'b2b-saas-score', version: 1 }, actor });
  }
  const slotRace = await Promise.allSettled([
    app.runAction({ module: 'lead', action: 'route', recordId: raceA.id, input: { policy: 'b2b-sales-routing', version: 1 }, actor }),
    second.runAction({ module: 'lead', action: 'route', recordId: raceB.id, input: { policy: 'b2b-sales-routing', version: 1 }, actor }),
  ]);
  const slotTargets = slotRace
    .filter((result) => result.status === 'fulfilled')
    .map((result) => result.value.result.target.key);
  assert.equal(slotTargets.filter((key) => key === 'spain-sales').length, 1, 'exactly one lead wins the last Spain slot');
  for (const result of slotRace.filter((r) => r.status === 'rejected')) {
    assert.equal(result.reason.status, 409, 'a raced-out route is a stable 409, never raw SQLITE');
  }
  const spainActive = app.modules.get('lead').service.countWhere({ assignedTargetId: 'spain-sales', status: ['new', 'qualified'] });
  assert.ok(spainActive <= 5, `Spain Sales never exceeds capacity (active ${spainActive})`);

  // Lifecycle gating is server-authoritative: routing a qualified lead and
  // enriching a disqualified one are refused regardless of client state.
  const qualifiedLead = await leads.create({ firstName: 'Qual', lastName: 'Ified', email: 'q@sevilla.example', companyName: 'Sevilla Digital' });
  await app.runAction({ module: 'lead', action: 'enrich', recordId: qualifiedLead.id, input: { provider: 'fixture-firmographics' }, actor });
  await app.runAction({ module: 'lead', action: 'score', recordId: qualifiedLead.id, input: { model: 'b2b-saas-score', version: 1 }, actor });
  await app.runAction({ module: 'lead', action: 'qualify', recordId: qualifiedLead.id, input: { dueAt: '2026-08-20T09:00:00Z' }, actor });
  await assert.rejects(
    () => app.runAction({ module: 'lead', action: 'route', recordId: qualifiedLead.id, input: { policy: 'b2b-sales-routing', version: 1 }, actor }),
    (error) => error.code === 'INVALID_STATE' && error.status === 409,
    'route is gated to status new',
  );
  await assert.rejects(
    () => app.runAction({ module: 'lead', action: 'enrich', recordId: released2.id, input: { provider: 'fixture-firmographics' }, actor }),
    (error) => error.code === 'INVALID_STATE' && error.status === 409,
    'enrich refuses a disqualified lead',
  );

  // Exact reads beyond the 500-row page bound: 520 signals all count.
  const busy = await leads.create({ firstName: 'Very', lastName: 'Busy', email: 'busy@sevilla.example', companyName: 'Sevilla Digital' });
  const signalService = app.modules.get('behavioral-signal').service;
  for (let i = 0; i < 520; i += 1) {
    await signalService.createManaged(
      { leadId: busy.id, signalType: 'pricing-page-visited', observedAt: '2026-08-01T10:00:00Z', sourceKey: `bulk:${busy.id}:${i}` },
      { actor },
    );
  }
  assert.equal(signalService.listWhere({ leadId: busy.id }).length, 520, 'listWhere is complete beyond the page bound');
  const busyScore = await app.runAction({ module: 'lead', action: 'score', recordId: busy.id, input: { model: 'b2b-saas-score', version: 1 }, actor });
  assert.equal(busyScore.result.signalCount, 520, 'scoring reads the complete signal set');

  // Version integrity across processes: editing a REGISTERED version's source
  // fails the next boot loudly (rollback = a new version, never an edit).
  writeFileSync(
    join(root, 'packages/intelligence/generated/index.js'),
    [
      '// @ts-check',
      'export const generatedEnrichmentProviders = [];',
      'export const generatedScoringModels = [{',
      "  name: 'b2b-saas-score', version: 1, label: 'Drifted in place',",
      "  rules: [{ key: 'drifted', label: 'Drifted', weight: 1, evaluate: () => true }],",
      '}];',
      'export const generatedRoutingPolicies = [];',
      'export const generatedRoutingTargets = [];',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(root, 'drift-boot.mjs'),
    [
      "import { createAccordoApp } from './packages/app/src/index.js';",
      `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
      'app.close();',
      "console.log('booted');",
      '',
    ].join('\n'),
  );
  const drifted = spawnSync(process.execPath, ['--no-warnings', join(root, 'drift-boot.mjs')], { encoding: 'utf8', cwd: root });
  assert.notEqual(drifted.status, 0, 'a drifted registered version stops the app');
  assert.match(drifted.stderr, /source changed after registration/, 'the startup error names the drift');
  // Restore the real definitions: the same fingerprints boot cleanly again.
  writeIntelligenceIndex(root);
  const healthy = spawnSync(process.execPath, ['--no-warnings', join(root, 'drift-boot.mjs')], { encoding: 'utf8', cwd: root });
  assert.equal(healthy.status, 0, `healthy definitions boot: ${healthy.stderr}`);
});
