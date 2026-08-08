import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { activatedContract, boot, project } from './helpers/contracts-project.js';
import { inspectApplicationCommand } from '../packages/cli/src/app-inspect-command.js';
import { solutionCommand } from '../packages/cli/src/solution-command.js';
import { inspectionFingerprint, parseSolutionPlan, validateSolutionPlan } from '../packages/core/src/solution-plan.js';

/**
 * M15 seen from the two agent surfaces, and across the contracts upgrade.
 *
 * AX1 must report the Service package, its declared dependency, its three
 * capabilities, its resources and actions and its policy fingerprint — and must
 * not report anything a reader could mistake for billing, a signed service
 * contract, an authenticated customer or a scheduler. AX2 must be able to
 * *cite* all of it without executing any of it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OFFERS = ['fixture:offer:enterprise', 'fixture:offer:setup', 'fixture:offer:support-annual'];
const PLAN = join(ROOT, 'examples/solution-plans/activate-support-and-manage-cases.plan.json');

const SERVICE_RESOURCES = [
  'service-coverage', 'service-entitlement', 'service-activation-run',
  'support-case', 'support-case-activity', 'service-sla-evaluation', 'service-escalation',
];
const SERVICE_ACTIONS = [
  'commercial-contract.plan-service-activation',
  'commercial-contract.activate-service',
  'service-coverage.end-service-coverage',
  'service-entitlement.record-service-case',
  'support-case.record-first-response',
  'support-case.transition-case',
  'support-case.record-case-activity',
  'support-case.preview-sla',
  'support-case.record-sla-evaluation',
  'support-case.record-escalation',
];

const composed = (t) => project(t, { withService: true });

test('AX1 reports the Service surface of a real composed project', async (t) => {
  const root = composed(t);
  const { report } = await inspectApplicationCommand({ rootDir: root, json: true, capture: true });
  assert.ok(report, 'the project inspects');
  assert.equal(report.valid, true);
  assert.deepEqual(report.problems, []);

  const service = report.packages.find((entry) => entry.name === 'service');
  assert.ok(service, 'the Service package is reported');
  assert.equal(service.version, 1);
  assert.deepEqual(service.requires.map((entry) => `${entry.package}/${entry.capability}@${entry.version}`),
    ['contracts/service-obligations@1'], 'exactly one declared reach, and it is the contracts one');
  assert.deepEqual(service.provides.map((entry) => `${entry.name}@${entry.version}`).sort(),
    ['service-case-management@1', 'service-coverage@1', 'service-sla-evidence@1']);

  // The capability edge resolves, which is the thing a broken composition breaks.
  const capabilities = Object.fromEntries(report.capabilities.map((entry) => [entry.name, entry]));
  assert.equal(capabilities['service-obligations'].status, 'resolved');
  assert.equal(capabilities['service-obligations'].provider, 'contracts');

  const resources = new Set(report.modules.map((entry) => entry.name));
  for (const resource of SERVICE_RESOURCES) {
    assert.ok(resources.has(resource), `${resource} is reported`);
    const module = report.modules.find((entry) => entry.name === resource);
    assert.equal(module.kind, 'package-owned', `${resource} is package-owned`);
    for (const field of module.fields ?? []) {
      assert.equal(field.writable, 'managed', `${resource}.${field.name} is managed`);
    }
  }

  const actions = new Set(report.actions.map((entry) => `${entry.module}.${entry.name}`));
  for (const action of SERVICE_ACTIONS) assert.ok(actions.has(action), `${action} is reported`);

  // Declared transition metadata is published where it exists.
  const transitionCase = report.actions.find((entry) => entry.name === 'transition-case');
  assert.deepEqual(transitionCase.fromStates, ['new', 'in_progress', 'waiting_customer', 'resolved']);
  const endCoverage = report.actions.find((entry) => entry.name === 'end-service-coverage');
  assert.deepEqual(endCoverage.fromStates, ['active']);

  // The activation policy is fingerprinted and reported.
  const policies = report.policies.filter((entry) => entry.kind === 'service-activation-policy');
  assert.equal(policies.length, 2, 'both starter policies are composed');
  for (const policy of policies) assert.ok(policy.name && Number.isInteger(policy.version));

  // What must NOT be inferable from the report, scoped to the Service package.
  const serviceSurface = [
    ...service.provides.map((entry) => entry.name),
    ...service.requires.map((entry) => entry.capability),
    ...SERVICE_RESOURCES,
  ];
  for (const forbidden of [/invoice/i, /payment/i, /billing/i, /renewal/i, /portal/i, /amend/i]) {
    assert.equal(serviceSurface.some((name) => forbidden.test(name)), false,
      `no Service surface name matches ${forbidden}`);
  }
  for (const forbidden of ['invoice', 'payment', 'billing-eligibility', 'service-contract', 'renewal', 'customer-portal']) {
    assert.equal(resources.has(forbidden), false, `no ${forbidden} resource exists`);
  }
  assert.equal(/"authenticated"\s*:\s*true/.test(JSON.stringify(report)), false,
    'nothing claims an authenticated anybody');

  // AX1 stays source-only: it reports no provider health and no auth state.
  const limitations = new Set(report.limitations.map((entry) => entry.code));
  assert.ok(limitations.has('DATABASE_NOT_INSPECTED'));
  assert.ok(limitations.has('PROVIDER_HEALTH_UNKNOWN'));
  assert.ok(limitations.has('PRODUCTION_SPINE_ABSENT'));
  assert.ok(t);
});

test('the shipped Service solution plan validates, and checks against a composed project', async (t) => {
  const root = composed(t);
  const { report } = await inspectApplicationCommand({ rootDir: root, json: true, capture: true });

  const validated = validateSolutionPlan(parseSolutionPlan(readFileSync(PLAN, 'utf8')));
  assert.deepEqual(validated.problems, [], 'the shipped plan passes the AX2 contract');
  assert.equal(validated.plan.application.inspectionFingerprint, inspectionFingerprint(report),
    'the plan is stale: re-run `crm solution check --json` against a service project and record its inspectionFingerprint');

  const checked = await solutionCommand({ planPath: PLAN, mode: 'check', json: true, rootDir: root, out: () => {} });
  assert.deepEqual(checked.problems, [], 'and it is current against a composed project');
  assert.equal(checked.exitCode, 0);
  assert.ok(t);
});

test('the plan cites the real Service surface, and nothing it must not', async (t) => {
  const { plan } = validateSolutionPlan(parseSolutionPlan(readFileSync(PLAN, 'utf8')));

  const required = new Set(plan.steps.flatMap((step) => step.requiresCapabilities));
  assert.ok(required.has('service-obligations'), 'the plan needs the contracts capability');
  assert.ok(required.has('service-case-management'), 'and the case-management capability it provides');

  // Human approvals are named where the milestone requires them.
  const text = JSON.stringify(plan);
  assert.match(text, /human/i, 'the plan states the human-actor boundary');
  assert.match(text, /not a signed/i, 'and that coverage is not a signed agreement');

  // Evidence discipline: every derived claim cites, and the gaps are stated.
  assert.ok(plan.evidence.observedFacts.length >= 3);
  assert.ok(plan.evidence.unavailableEvidence.length >= 2, 'a plan that admits what it cannot know');
  for (const category of ['derivedMetrics', 'inferences', 'recommendations']) {
    for (const entry of plan.evidence[category]) {
      assert.ok(entry.citations.length > 0, `${category} entry "${entry.id}" cites its inputs`);
    }
  }

  // …and it carries nothing executable, which the validator already enforced.
  assert.equal(/\bnpm run\b|\bcurl \b|\$\(|<script/i.test(text), false, 'no command, substitution or script');
  assert.equal(/\bSELECT\b.*\bFROM\b|\bINSERT INTO\b/i.test(text), false, 'no SQL');
  assert.ok(t);
});

test('a moved Service capability makes the plan stale', async (t) => {
  const root = composed(t);
  const { report } = await inspectApplicationCommand({ rootDir: root, json: true, capture: true });
  const { plan } = validateSolutionPlan(parseSolutionPlan(readFileSync(PLAN, 'utf8')));
  const { bindSolutionPlan } = await import('../packages/core/src/solution-plan.js');

  assert.equal(bindSolutionPlan(plan, report).current, true, 'current against the real project');

  for (const [what, drifted] of [
    ['the package version', { ...report, packages: report.packages.map((entry) => (entry.name === 'service' ? { ...entry, version: 2 } : entry)) }],
    ['a capability that stopped resolving', { ...report, capabilities: report.capabilities.map((entry) => (entry.name === 'service-obligations' ? { ...entry, status: 'missing' } : entry)) }],
    ['a capability that disappeared', { ...report, capabilities: report.capabilities.filter((entry) => entry.name !== 'service-case-management') }],
    ['a record revision', { ...report, modules: report.modules.map((entry) => (entry.name === 'support-case' ? { ...entry, revision: 2 } : entry)) }],
  ]) {
    const binding = bindSolutionPlan(plan, drifted);
    assert.equal(binding.current, false, `${what} makes the plan stale`);
    assert.ok(binding.problems.some((problem) => problem.code === 'PLAN_STALE'), what);
  }
  assert.ok(t);
});

test('the Service package detaches cleanly, and its whole surface leaves with it', async (t) => {
  // Detach is tested by composing without the package rather than by editing
  // files under a running test: the claim is about the composition, and the
  // composition is the thing to vary.
  const withService = composed(t);
  const withoutService = project(t, { withDelivery: false });

  const attached = (await inspectApplicationCommand({ rootDir: withService, json: true, capture: true })).report;
  const detached = (await inspectApplicationCommand({ rootDir: withoutService, json: true, capture: true })).report;

  assert.equal(detached.valid, true, 'an application without the package is still valid');
  assert.deepEqual(detached.problems, [], 'and composes without a single problem');

  const attachedResources = new Set(attached.modules.map((entry) => entry.name));
  const detachedResources = new Set(detached.modules.map((entry) => entry.name));
  for (const name of SERVICE_RESOURCES) {
    assert.ok(attachedResources.has(name), `${name} is present when attached`);
    assert.equal(detachedResources.has(name), false, `${name} left with the package`);
  }
  const detachedActions = new Set(detached.actions.map((entry) => `${entry.module}.${entry.name}`));
  for (const action of SERVICE_ACTIONS) {
    assert.equal(detachedActions.has(action), false, `${action} left with the package`);
  }
  assert.equal(detached.packages.some((entry) => entry.name === 'service'), false);
  assert.equal(detached.capabilities.some((entry) => entry.name === 'service-coverage'
    || entry.name === 'service-case-management' || entry.name === 'service-sla-evidence'), false,
    'no service capability is offered by an application without the package');

  // …and `service-obligations@1` survives with zero consumers: it is provided
  // by CONTRACTS, and a provider does not depend on being consumed.
  const provider = detached.capabilities.find((entry) => entry.name === 'service-obligations');
  assert.ok(provider, 'contracts still provides service-obligations@1');
  assert.equal(provider.provider, 'contracts');
  assert.ok(t);
});
