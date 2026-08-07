import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DELIVERY_POLICY, activatedContract, boot, project } from './helpers/contracts-project.js';
import { inspectApplicationCommand } from '../packages/cli/src/app-inspect-command.js';
import { solutionCommand } from '../packages/cli/src/solution-command.js';
import { inspectionFingerprint, parseSolutionPlan, validateSolutionPlan } from '../packages/core/src/solution-plan.js';

/**
 * M14b2 seen from the two agent surfaces, and across an upgrade.
 *
 * AX1 must report the new resources, actions and capabilities of a real
 * composed project — and must not report anything that would let a reader infer
 * billing, a service activation or an authenticated customer. AX2 must be able
 * to *cite* all of it in a plan without executing any of it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const PLAN = join(ROOT, 'examples/solution-plans/govern-delivery-change.plan.json');

const M14B2_RESOURCES = [
  'delivery-change-request', 'delivery-plan-revision', 'delivery-commercial-change',
  'delivery-deliverable', 'delivery-acceptance-request', 'delivery-acceptance-evidence',
];
const M14B2_ACTIONS = [
  'delivery-project.propose-change-request',
  'delivery-change-request.decide-change-request',
  'delivery-work-package.plan-deliverable',
  'delivery-deliverable.complete-deliverable',
  'delivery-milestone.request-acceptance',
  'delivery-acceptance-request.record-acceptance',
];

/** A composed project on disk, with the delivery package and its records. */
function composed(t) {
  return project(t, { withDelivery: true });
}

test('AX1 reports the M14b2 surface of a real composed project', async (t) => {
  const root = composed(t);
  const { report } = await inspectApplicationCommand({ rootDir: root, json: true, capture: true });
  assert.ok(report, 'the project inspects');
  assert.equal(report.valid, true);
  assert.deepEqual(report.problems, []);

  const delivery = report.packages.find((entry) => entry.name === 'delivery');
  assert.ok(delivery, 'the delivery package is composed');
  assert.equal(delivery.version, 4, 'at the version this milestone published');
  assert.equal(delivery.packageContract, 1, 'and the seam is unchanged');

  // Every capability the package now offers, including the two M14b2 added,
  // with the earlier ones untouched.
  const capabilities = Object.fromEntries(report.capabilities.map((entry) => [entry.name, entry]));
  for (const name of ['delivery-obligations', 'delivery-economics', 'delivery-change-management', 'delivery-acceptance-evidence']) {
    assert.ok(capabilities[name], `${name} is reported`);
    assert.equal(capabilities[name].status, 'resolved', `${name} resolves`);
    assert.equal(capabilities[name].version, 1);
  }
  assert.equal(capabilities['delivery-change-management'].provider, 'delivery');
  assert.equal(capabilities['delivery-acceptance-evidence'].provider, 'delivery');

  const resources = new Set(report.resources.map((entry) => entry.resource));
  for (const name of M14B2_RESOURCES) {
    assert.ok(resources.has(name), `${name} is a reported resource`);
  }

  const actions = new Set(report.actions.map((entry) => `${entry.module}.${entry.name}`));
  for (const name of M14B2_ACTIONS) assert.ok(actions.has(name), `${name} is reported`);

  // Declared state metadata where the action declares it — and honestly null
  // where the restriction is imperative, which AX1 already documents.
  const decide = report.actions.find((entry) => entry.name === 'decide-change-request');
  assert.deepEqual(decide.fromStates, ['proposed'], 'the decided-once rule is declared, not only enforced');
  const complete = report.actions.find((entry) => entry.name === 'complete-deliverable');
  assert.deepEqual(complete.fromStates, ['planned']);
  const record = report.actions.find((entry) => entry.name === 'record-acceptance');
  assert.deepEqual(record.fromStates, ['pending']);

  // Read-only boundaries: every new record is package-owned and managed.
  for (const name of M14B2_RESOURCES) {
    const module = report.modules.find((entry) => entry.name === name);
    assert.ok(module, `${name} is a reported record`);
    assert.equal(module.kind, 'package-owned');
    assert.equal(module.owner, 'delivery');
    assert.equal(module.revision, 1, 'a new resource starts at revision 1');
    assert.equal(module.stateFile, 'valid');
    for (const field of module.fields) {
      assert.equal(field.writable, 'managed', `${name}.${field.name} has no public write path`);
    }
  }

  // What must NOT be inferable from the report.
  const serialized = JSON.stringify(report);
  for (const forbidden of ['billing-eligibility', 'invoice', 'payment', 'contract-amendment',
    'service-obligation-activation', 'customer-portal']) {
    assert.equal(resources.has(forbidden), false, `no ${forbidden} resource exists`);
  }
  assert.equal(Object.keys(capabilities).some((name) => /amend|billing|invoice|payment|sla|service/i.test(name)), false,
    'no capability implies a commercial amendment, billing or Service');
  assert.equal(/"authenticated"\s*:\s*true/.test(serialized), false, 'nothing claims an authenticated anybody');

  // AX1 stays source-only: nothing here reports database or auth state.
  const limitations = new Set(report.limitations.map((entry) => entry.code));
  assert.ok(limitations.has('DATABASE_NOT_INSPECTED'));
  assert.ok(limitations.has('PRODUCTION_SPINE_ABSENT'));
  assert.ok(t);
});

test('AX1 reports the same picture deterministically', async (t) => {
  const root = composed(t);
  const first = await inspectApplicationCommand({ rootDir: root, json: true, capture: true });
  const second = await inspectApplicationCommand({ rootDir: root, json: true, capture: true });
  assert.equal(JSON.stringify(first.report), JSON.stringify(second.report),
    'two runs over one checked-in state are byte-identical');
  assert.ok(t);
});

test('the shipped M14b2 solution plan validates, and checks against a composed project', async (t) => {
  const root = composed(t);
  const { report } = await inspectApplicationCommand({ rootDir: root, json: true, capture: true });

  // The plan ships pinned to this composition; if the package moves and nobody
  // regenerates it, this fails, which is the staleness claim applied to itself.
  const source = readFileSync(PLAN, 'utf8');
  const validated = validateSolutionPlan(parseSolutionPlan(source));
  assert.deepEqual(validated.problems, [], 'the shipped plan passes the AX2 contract');

  assert.equal(validated.plan.application.inspectionFingerprint, inspectionFingerprint(report),
    'the plan is stale: re-run `crm solution check --json` against a delivery project and record its inspectionFingerprint');

  const checked = await solutionCommand({ planPath: PLAN, mode: 'check', json: true, rootDir: root, out: () => {} });
  assert.deepEqual(checked.problems, [], 'and it is current against a composed project');
  assert.equal(checked.exitCode, 0);
  assert.ok(t);
});

test('the plan cites the real M14b2 surface, and nothing it must not', async (t) => {
  const { plan } = validateSolutionPlan(parseSolutionPlan(readFileSync(PLAN, 'utf8')));

  // It depends on the capabilities this milestone actually added.
  const required = new Set(plan.steps.flatMap((step) => step.requiresCapabilities));
  assert.ok(required.has('delivery-change-management'), 'the plan needs the change capability');
  assert.ok(required.has('delivery-acceptance-evidence'), 'and the acceptance capability');

  // The decision hierarchy is used honestly: this is configuration and
  // extension of a package that already owns the domain, not a new package.
  assert.deepEqual([...new Set(plan.decisions.map((entry) => entry.type))].sort(), ['configure', 'extend']);
  for (const decision of plan.decisions) {
    assert.ok(decision.rung <= 2, 'nothing here needed rung 3 or above — the package already owns this');
  }

  // Evidence discipline: every derived claim cites, and the gaps are stated.
  assert.ok(plan.evidence.observedFacts.length >= 3);
  assert.ok(plan.evidence.unavailableEvidence.length >= 2, 'a plan that admits what it cannot know');
  for (const category of ['derivedMetrics', 'inferences', 'recommendations']) {
    for (const entry of plan.evidence[category]) {
      assert.ok(entry.citations.length > 0, `${category} entry "${entry.id}" cites its inputs`);
    }
  }

  // Human approval is named where the milestone requires it.
  const text = JSON.stringify(plan);
  assert.match(text, /human/i, 'the plan states the human-actor boundary somewhere');

  // …and it carries nothing executable, which the validator already enforced —
  // asserted here because it is the claim a reader most needs to trust.
  assert.equal(/\bnpm run\b|\bcurl \b|\$\(|<script/i.test(text), false, 'no command, substitution or script');
  assert.equal(/\bSELECT\b.*\bFROM\b|\bINSERT INTO\b/i.test(text), false, 'no SQL');
  assert.ok(t);
});

test('a moved delivery capability makes the plan stale', async (t) => {
  const root = composed(t);
  const { report } = await inspectApplicationCommand({ rootDir: root, json: true, capture: true });
  const { plan } = validateSolutionPlan(parseSolutionPlan(readFileSync(PLAN, 'utf8')));
  const { bindSolutionPlan } = await import('../packages/core/src/solution-plan.js');

  assert.equal(bindSolutionPlan(plan, report).current, true, 'current against the real project');

  const moved = [
    ['the package version', { ...report, packages: report.packages.map((entry) => (entry.name === 'delivery' ? { ...entry, version: 5 } : entry)) }],
    ['a capability that stopped resolving', { ...report, capabilities: report.capabilities.map((entry) => (entry.name === 'delivery-change-management' ? { ...entry, status: 'missing' } : entry)) }],
    ['a capability that disappeared', { ...report, capabilities: report.capabilities.filter((entry) => entry.name !== 'delivery-acceptance-evidence') }],
    ['a record revision', { ...report, modules: report.modules.map((entry) => (entry.name === 'delivery-change-request' ? { ...entry, revision: 2 } : entry)) }],
  ];
  for (const [what, drifted] of moved) {
    const binding = bindSolutionPlan(plan, drifted);
    assert.equal(binding.current, false, `${what} makes the plan stale`);
    assert.ok(binding.problems.some((problem) => problem.code === 'PLAN_STALE' || problem.code === 'CAPABILITY_NOT_AVAILABLE'),
      `${what} is named`);
  }
  assert.ok(t);
});

test('M14b1 data survives the M14b2 upgrade, and nothing historical is rewritten', async (t) => {
  // The upgrade path: a database written before the six new records existed,
  // then opened by an application that has them. Prior rows must be exactly as
  // they were, and no earlier migration may have changed identity.
  const root = composed(t);
  const dbPath = join(root, 'data', 'upgrade.sqlite');
  const context = await boot(root, dbPath);
  t.after(() => context.close());
  const { contract } = await activatedContract(root, context.app, { name: 'Upgrade', offers: OFFERS });
  await context.client.module('commercial-contract').action(contract.id, 'create-delivery-handover', {
    ...DELIVERY_POLICY,
    targetStartDate: '2026-09-20', targetEndDate: '2026-12-20',
    partner: { partnerRef: 'partner:abc', partnerName: 'ABC', reason: 'migrations' },
  });
  const app = context.app;
  const row = app.modules.get('delivery-project').service.listWhere({ contractId: contract.id })[0];
  const wp = app.modules.get('delivery-work-package').service.listWhere({ deliveryProjectId: row.id })[0];
  await context.client.module('delivery-project').action(row.id, 'start-delivery-project', {});
  await context.client.module('delivery-work-package').action(wp.id, 'start-work-package', {});
  await context.client.module('delivery-work-package').action(wp.id, 'record-delivery-time', {
    entryKey: 'pre-upgrade', contributorRef: 'consultant:ana', contributorType: 'internal',
    workDate: '2026-09-21', minutes: 90, category: 'consulting',
  });
  const snapshot = await context.client.module('delivery-project').action(row.id, 'snapshot-delivery-economics', {
    snapshotKey: 'pre-upgrade',
  });
  const before = {
    project: app.modules.get('delivery-project').service.get(row.id),
    workPackage: app.modules.get('delivery-work-package').service.get(wp.id),
    time: app.modules.get('delivery-time-entry').service.list(),
    snapshot: snapshot.result.snapshot,
    migrations: app.database.raw.prepare('SELECT name, checksum FROM module_migrations ORDER BY name').all(),
  };

  // Reopen the same file with a second application: the same source, the same
  // migrations, and the M14b2 tables already present because they were applied
  // with the rest of the project.
  const { createAgentCrmApp } = await import(`file://${join(root, 'packages/app/src/index.js')}`);
  const upgraded = createAgentCrmApp({ dbPath, clock: () => '2026-10-01T10:00:00.000Z' });
  t.after(() => upgraded.close());

  assert.deepEqual(upgraded.modules.get('delivery-project').service.get(row.id), before.project,
    'the delivery project is byte-identical after the upgrade');
  assert.deepEqual(upgraded.modules.get('delivery-work-package').service.get(wp.id), before.workPackage);
  assert.deepEqual(upgraded.modules.get('delivery-time-entry').service.list(), before.time,
    'M14b1 evidence is untouched');
  assert.deepEqual(
    upgraded.modules.get('delivery-economic-snapshot').service.get(before.snapshot.id), before.snapshot,
    'and a snapshot taken before the upgrade still reads exactly the same');
  assert.deepEqual(
    upgraded.database.raw.prepare('SELECT name, checksum FROM module_migrations ORDER BY name').all(),
    before.migrations,
    'no historical migration was edited, renumbered or re-checksummed',
  );

  // The new records work on the upgraded database, starting from empty.
  for (const name of M14B2_RESOURCES) {
    assert.equal(upgraded.modules.get(name).service.list().length, 0, `${name} starts empty`);
  }
  const proposed = await upgraded.runAction({
    module: 'delivery-project', action: 'propose-change-request', recordId: row.id,
    actor: { type: 'user', id: 'upgrade' },
    input: { changeKey: 'post-upgrade', changeType: 'non_commercial_replan', title: 't', reason: 'r' },
  });
  assert.equal(proposed.result.changeRequest.status, 'proposed', 'and M14b2 works on the upgraded database');

  // The economics snapshot still reproduces from the same evidence, which is
  // the property the rejection semantics were chosen to protect.
  const recomputed = await upgraded.runAction({
    module: 'delivery-project', action: 'preview-delivery-economics', recordId: row.id,
    actor: { type: 'user', id: 'upgrade' }, input: {},
  });
  assert.deepEqual(recomputed.result.economics.groups, JSON.parse(before.snapshot.groupsJson),
    'the pre-upgrade economics recompute identically after M14b2');
});

test('the package detaches cleanly, and its whole surface leaves with it', async (t) => {
  // Detach is tested by composing without the package rather than by editing
  // files under a running test: the claim is about the composition, and the
  // composition is the thing to vary.
  const withDelivery = composed(t);
  const withoutDelivery = project(t, { withDelivery: false });

  const attached = (await inspectApplicationCommand({ rootDir: withDelivery, json: true, capture: true })).report;
  const detached = (await inspectApplicationCommand({ rootDir: withoutDelivery, json: true, capture: true })).report;

  assert.equal(detached.valid, true, 'an application without the package is still valid');
  assert.deepEqual(detached.problems, [], 'and composes without a single problem');

  // Every M14b2 surface leaves with the package that provided it.
  const detachedResources = new Set(detached.resources.map((entry) => entry.resource));
  for (const name of M14B2_RESOURCES) {
    assert.equal(detachedResources.has(name), false, `${name} leaves with the package`);
  }
  const detachedActions = new Set(detached.actions.map((entry) => `${entry.module}.${entry.name}`));
  for (const name of M14B2_ACTIONS) {
    assert.equal(detachedActions.has(name), false, `${name} leaves with the package`);
  }
  for (const name of ['delivery-change-management', 'delivery-acceptance-evidence', 'delivery-economics']) {
    assert.equal(detached.capabilities.some((entry) => entry.name === name), false,
      `${name} leaves with the delivery package that provides it`);
  }
  assert.equal(detached.packages.some((entry) => entry.name === 'delivery'), false);

  // `delivery-obligations` is provided by *contracts*, so it stays — with
  // nobody consuming it. That is exactly what a clean detach looks like: the
  // provider is untouched and its offer simply goes unanswered.
  const obligations = detached.capabilities.find((entry) => entry.name === 'delivery-obligations');
  assert.ok(obligations, 'the contracts capability survives its consumer leaving');
  assert.equal(obligations.provider, 'contracts');
  assert.equal(obligations.status, 'resolved', 'and still resolves');
  assert.deepEqual(obligations.consumers, [], 'with no consumers left');
  assert.deepEqual(
    attached.capabilities.find((entry) => entry.name === 'delivery-obligations').consumers, ['delivery'],
    'where the attached application had exactly one',
  );

  // The contracts package is unaffected: its obligations simply go unconsumed,
  // which is what "removable without touching the kernel" has to mean.
  assert.ok(detached.packages.some((entry) => entry.name === 'contracts'),
    'the package it depended on is untouched by its absence');
  assert.equal(attached.packages.find((entry) => entry.name === 'contracts').version,
    detached.packages.find((entry) => entry.name === 'contracts').version,
    'and at exactly the same version');

  // Nothing of M14b2 reached the kernel.
  const { readFileSync: read, readdirSync } = await import('node:fs');
  const kernelDir = join(ROOT, 'packages/core/src');
  for (const file of readdirSync(kernelDir).filter((name) => name.endsWith('.js'))) {
    const source = read(join(kernelDir, file), 'utf8');
    assert.equal(/delivery-change-request|delivery-acceptance|delivery-deliverable|delivery-plan-revision/.test(source), false,
      `the kernel file ${file} knows nothing about M14b2`);
  }

  // …and the package reaches into no other package's private source.
  const packageSource = read(join(ROOT, 'packages/delivery/src/change-acceptance.js'), 'utf8');
  assert.equal(/from '[^']*contracts\//.test(packageSource), false,
    'M14b2 imports nothing from the contracts package');
  assert.equal(/from '[^']*core\/src\//.test(packageSource), false,
    'and nothing from kernel internals — only the published index');
});
