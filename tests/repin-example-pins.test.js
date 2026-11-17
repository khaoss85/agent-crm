// @ts-check

/**
 * `scripts/repin-example-pins.js`: every checked-in example plan and evidence
 * pins the composition its authority observes, and one command refreshes all
 * nine example files — no hand-edits, no hunt across files. `--check` fails
 * naming that command when any pin drifted.
 *
 * The live proof observes the real authorities once (the root inspection, the
 * two composed fixture projects, the verifier scenario run), then replays
 * those observations against drifted copies in a temp dir: the command
 * restores exactly the pins the repository carries. Copies live in a temp
 * dir; the repository is never written.
 */

import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { inspectApplicationCommand } from '../packages/cli/src/app-inspect-command.js';
import { scenarioRunCommand } from '../packages/cli/src/scenario-run-command.js';
import { inspectionFingerprint } from '../packages/core/src/solution-plan.js';
import { repinExamplePins } from '../scripts/repin-example-pins.js';
import { VERIFIER_FIXTURE_SCENARIO } from '../scripts/repin-verifier-fixture.js';
import { project as composeFixtureProject } from './helpers/contracts-project.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const PLAN_FILES = [
  'examples/solution-plans/lead-to-won.plan.json',
  'examples/solution-plans/activate-support-and-manage-cases.plan.json',
  'examples/solution-plans/govern-delivery-change.plan.json',
  'examples/solution-plans/verifier-fixture-exit-zero.plan.json',
  'examples/solution-plans/govern-customer-identity.plan.json',
];
const EVIDENCE_FILES = [
  'examples/implementation-evidence/lead-to-won.evidence.json',
  'examples/implementation-evidence/activate-support-and-manage-cases.evidence.json',
  'examples/implementation-evidence/govern-customer-identity.evidence.json',
  'examples/implementation-evidence/verifier-fixture-exit-zero.evidence.json',
];
/** The frozen plan: repinned derived values only, never the composition pin. */
const FROZEN_PLAN = 'examples/solution-plans/govern-customer-identity.plan.json';
const SINK = () => {};

/** Faithful copies of the nine example files plus every artifact they cite. */
function copyTree(directory) {
  const copyIn = (relative) => {
    const target = join(directory, relative);
    mkdirSync(join(directory, relative.split('/').slice(0, -1).join('/')), { recursive: true });
    cpSync(join(repoRoot, relative), target, { recursive: false });
  };
  for (const relative of [...PLAN_FILES, ...EVIDENCE_FILES]) copyIn(relative);
  const seen = new Set();
  for (const relative of EVIDENCE_FILES) {
    const document = JSON.parse(readFileSync(join(directory, relative), 'utf8'));
    for (const requirement of document.requirements ?? []) {
      for (const ref of requirement.evidence ?? []) {
        if (ref?.kind === 'source.artifact' && !seen.has(ref.path)) {
          seen.add(ref.path);
          copyIn(ref.path);
        }
      }
    }
  }
}

const staleDigest = (digest) => (digest.endsWith('0') ? `${digest.slice(0, -1)}1` : `${digest.slice(0, -1)}0`);

/**
 * Move every pin the repin owns by one nibble (the frozen composition pin
 * stays: the command must never observe a new composition for it), and change
 * the bytes of one cited artifact so its hash must be re-read from live bytes.
 */
function staleCopies(directory) {
  for (const relative of PLAN_FILES) {
    if (relative === FROZEN_PLAN) continue;
    const file = join(directory, relative);
    const plan = JSON.parse(readFileSync(file, 'utf8'));
    plan.application.inspectionFingerprint = staleDigest(plan.application.inspectionFingerprint);
    writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
  }
  for (const relative of EVIDENCE_FILES) {
    const file = join(directory, relative);
    const evidence = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof evidence.planFingerprint === 'string') evidence.planFingerprint = staleDigest(evidence.planFingerprint);
    if (typeof evidence.applicationInspectionFingerprint === 'string') {
      evidence.applicationInspectionFingerprint = staleDigest(evidence.applicationInspectionFingerprint);
    }
    writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  }
  const artifact = join(directory, 'packages/customer-data/src/operations.js');
  writeFileSync(artifact, `${readFileSync(artifact, 'utf8')}\n// repin-example-pins test: drifted bytes.\n`);
}

function pinsOf(directory) {
  const pins = {};
  for (const relative of PLAN_FILES) {
    pins[`${relative}#application.inspectionFingerprint`] =
      JSON.parse(readFileSync(join(directory, relative), 'utf8')).application.inspectionFingerprint;
  }
  for (const relative of EVIDENCE_FILES) {
    const evidence = JSON.parse(readFileSync(join(directory, relative), 'utf8'));
    pins[`${relative}#planFingerprint`] = evidence.planFingerprint ?? null;
    pins[`${relative}#applicationInspectionFingerprint`] = evidence.applicationInspectionFingerprint ?? null;
  }
  return pins;
}

function checkedInPins() {
  return pinsOf(repoRoot);
}

/** The real authorities, observed once against this repository. */
async function liveAuthorities() {
  const cleanups = [];
  const root = await inspectApplicationCommand({ rootDir: repoRoot, json: true, capture: true });
  const serviceDir = composeFixtureProject({ after: (fn) => cleanups.push(fn) }, { withService: true });
  let service;
  try {
    service = await inspectApplicationCommand({ rootDir: serviceDir, json: true, capture: true });
  } finally {
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch { /* the inspection already ran */ }
    }
  }
  const deliveryDir = composeFixtureProject({ after: (fn) => cleanups.push(fn) }, { withDelivery: true });
  let delivery;
  try {
    delivery = await inspectApplicationCommand({ rootDir: deliveryDir, json: true, capture: true });
  } finally {
    for (const fn of cleanups.splice(0)) {
      try { fn(); } catch { /* the inspection already ran */ }
    }
  }
  const scenario = await scenarioRunCommand({
    scenarioRef: VERIFIER_FIXTURE_SCENARIO, rootDir: repoRoot, json: true, out: SINK, err: SINK, env: process.env,
  });
  return { root, service, delivery, scenario };
}

/**
 * Stubs replaying the live observations: the temp copies are repinned to the
 * composition this repository carries, never to a value typed by the test.
 */
function authorityStubs(live) {
  const fingerprintOf = (answered) => inspectionFingerprint(answered?.report ?? answered);
  return {
    inspect: async () => live.root,
    inspectFixture: async (options) => (options?.withService ? live.service : live.delivery),
    scenario: async () => live.scenario,
    liveFingerprints: {
      root: fingerprintOf(live.root),
      service: fingerprintOf(live.service),
      delivery: fingerprintOf(live.delivery),
      scenario: live.scenario?.report?.composition?.compositionFingerprint ?? null,
    },
  };
}

/**
 * The real authorities, observed once and replayed by every test: building
 * the two composed fixture projects copies the whole repository, so each test
 * capturing its own observations quadruples that cost and the loader
 * timeouts that come with it.
 */
let live = null;
let stubs = null;

before(async () => {
  live = await liveAuthorities();
  stubs = authorityStubs(live);
  assert.ok(live.root?.report, 'the live root inspection answered with a report');
  assert.ok(live.service?.report, 'the live service inspection answered with a report');
  assert.ok(live.delivery?.report, 'the live delivery inspection answered with a report');
  assert.ok(live.scenario?.report?.composition?.compositionFingerprint,
    'the live scenario run answered with a composition');
});

test('drifted copies fail --check naming the repin command, and the command restores the checked-in pins', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-example-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyTree(directory);
  const checkedIn = checkedInPins();
  assert.equal(stubs.liveFingerprints.root, checkedIn['examples/solution-plans/lead-to-won.plan.json#application.inspectionFingerprint'],
    'the live root composition is what lead-to-won pins: when it moved on purpose, run `npm run repin:example-pins` on the repository and commit the rewritten files');
  assert.equal(stubs.liveFingerprints.service, checkedIn['examples/solution-plans/activate-support-and-manage-cases.plan.json#application.inspectionFingerprint'],
    'the live service composition is what the service plan pins: when it moved on purpose, run `npm run repin:example-pins` on the repository and commit the rewritten files');
  assert.equal(stubs.liveFingerprints.delivery, checkedIn['examples/solution-plans/govern-delivery-change.plan.json#application.inspectionFingerprint'],
    'the live delivery composition is what the delivery plan pins: when it moved on purpose, run `npm run repin:example-pins` on the repository and commit the rewritten files');

  staleCopies(directory);
  const args = { rootDir: directory, ...stubs, out: SINK };

  let stderr = '';
  const checkResult = await repinExamplePins({ ...args, check: true, err: (text) => { stderr += text; } });
  assert.equal(checkResult.exitCode, 1, 'drifted pins fail --check');
  assert.ok(checkResult.drifted.length > 0, 'every drifted pin is reported');
  assert.ok(checkResult.drifted.some((field) => field.endsWith('#application.inspectionFingerprint')),
    'a drifted composition pin is reported');
  assert.ok(checkResult.drifted.some((field) => field.includes('#source.artifact')),
    'a drifted artifact hash is reported');
  assert.match(stderr, /npm run repin:example-pins/, '--check names the fix');

  let stdout = '';
  const repinResult = await repinExamplePins({ ...args, err: SINK, out: (text) => { stdout += text; } });
  assert.equal(repinResult.exitCode, 0);
  assert.match(stdout, /repinned \d+ file\(s\)/, 'the repin names what it rewrote');
  assert.deepEqual(pinsOf(directory), checkedIn,
    'the command reproduces the checked-in pins from drift, not a new hand-edit');
  const rehashed = JSON.parse(readFileSync(
    join(directory, 'examples/implementation-evidence/govern-customer-identity.evidence.json'), 'utf8'));
  const driftedRef = rehashed.requirements
    .flatMap((requirement) => requirement.evidence ?? [])
    .find((ref) => ref?.kind === 'source.artifact' && ref.path === 'packages/customer-data/src/operations.js');
  assert.equal(driftedRef.sha256,
    createHash('sha256').update(readFileSync(join(directory, driftedRef.path), 'utf8')).digest('hex'),
    'an artifact hash is re-read from the live bytes, the value `crm solution verify` checks');

  const clean = await repinExamplePins({ ...args, check: true, out: SINK, err: SINK });
  assert.equal(clean.exitCode, 0, '--check passes once repinned');
  assert.deepEqual(clean.drifted, []);

  let rewritten = '';
  const rerun = await repinExamplePins({ ...args, out: (text) => { rewritten += text; }, err: SINK });
  assert.equal(rerun.exitCode, 0);
  assert.deepEqual(rerun.wrote, [], 'a repin that changes nothing writes nothing');
  assert.match(rewritten, /nothing written/);
});

test('the frozen pair keeps its composition pin and still refreshes derived values', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-example-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyTree(directory);

  staleCopies(directory);
  const before = JSON.parse(readFileSync(join(directory, FROZEN_PLAN), 'utf8'))
    .application.inspectionFingerprint;

  const result = await repinExamplePins({ rootDir: directory, ...stubs, out: SINK, err: SINK });
  assert.equal(result.exitCode, 0);
  const plan = JSON.parse(readFileSync(join(directory, FROZEN_PLAN), 'utf8'));
  assert.equal(plan.application.inspectionFingerprint, before,
    'no authority observes a new composition for the frozen plan');
  assert.ok(!result.wrote.includes(FROZEN_PLAN), 'the frozen plan file is untouched');
  assert.deepEqual(pinsOf(directory)['examples/implementation-evidence/govern-customer-identity.evidence.json#planFingerprint'],
    checkedInPins()['examples/implementation-evidence/govern-customer-identity.evidence.json#planFingerprint'],
    'the frozen evidence still rebinds to its plan and the live bytes');
});

test('no observed composition, no repin: the command refuses rather than writing pins it did not observe', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-example-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyTree(directory);
  const before = pinsOf(directory);

  const result = await repinExamplePins({
    rootDir: directory,
    inspect: async () => { throw new Error('the authority is unreachable'); },
    out: SINK, err: SINK,
  });
  assert.equal(result.exitCode, 2);
  assert.deepEqual(pinsOf(directory), before, 'a refused repin writes nothing');
});

test('an example plan with no authority refuses instead of inventing a binding', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-example-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyTree(directory);
  const extra = join(directory, 'examples/solution-plans/unbound.plan.json');
  writeFileSync(extra, JSON.stringify(JSON.parse(readFileSync(
    join(directory, 'examples/solution-plans/lead-to-won.plan.json'), 'utf8')), null, 2));

  let stderr = '';
  const result = await repinExamplePins({ rootDir: directory, ...stubs, out: SINK, err: (text) => { stderr += text; } });
  assert.equal(result.exitCode, 2);
  assert.match(stderr, /unbound\.plan\.json has no authority/, 'the refusal names the unbound plan');
  assert.deepEqual(pinsOf(directory), checkedInPins(), 'a refused repin writes nothing');
});

test('an evidence naming no checked-in plan refuses instead of binding to it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-example-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyTree(directory);
  const source = JSON.parse(readFileSync(
    join(directory, 'examples/implementation-evidence/lead-to-won.evidence.json'), 'utf8'));
  source.plan = 'examples/solution-plans/no-such.plan.json';
  writeFileSync(join(directory, 'examples/implementation-evidence/unbound.evidence.json'),
    `${JSON.stringify(source, null, 2)}\n`);

  let stderr = '';
  const result = await repinExamplePins({ rootDir: directory, ...stubs, out: SINK, err: (text) => { stderr += text; } });
  assert.equal(result.exitCode, 2);
  assert.match(stderr, /no-such\.plan\.json/, 'the refusal names the unknown plan');
  assert.deepEqual(pinsOf(directory), checkedInPins(), 'a refused repin writes nothing');
});

test('the default fixture authority holds the fixture project until the inspection resolves', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-example-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyTree(directory);
  // Pristine pins: with honest authorities --check passes, so the only way
  // this fails is the authority deleting the fixture mid-inspection.
  let fixtures = 0;
  const inspect = async ({ rootDir }) => {
    if (rootDir === directory) return live.root;
    fixtures += 1;
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(rootDir), 'the fixture project survives until the inspection resolves');
    return fixtures === 1 ? live.service : live.delivery;
  };

  const result = await repinExamplePins({
    rootDir: directory, inspect, scenario: stubs.scenario, out: SINK, err: SINK, check: true,
  });
  assert.equal(fixtures, 2, 'both fixture authorities ran through the default path');
  assert.equal(result.exitCode, 0, 'the inspection saw its project the whole time');
});

test('a refused repin in write mode leaves even the verifier pair untouched', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'repin-example-pins-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  copyTree(directory);
  // Drift the verifier plan so the verifier command would rewrite its pair
  // in write mode, then break an unrelated evidence document: the refusal
  // must land before any file is touched.
  const verifierPlan = join(directory, 'examples/solution-plans/verifier-fixture-exit-zero.plan.json');
  const verifierRaw = JSON.parse(readFileSync(verifierPlan, 'utf8'));
  verifierRaw.application.inspectionFingerprint = staleDigest(verifierRaw.application.inspectionFingerprint);
  writeFileSync(verifierPlan, `${JSON.stringify(verifierRaw, null, 2)}\n`);
  const broken = join(directory, 'examples/implementation-evidence/lead-to-won.evidence.json');
  writeFileSync(broken, `${readFileSync(broken, 'utf8')}not json anymore {{{`);

  const before = {};
  for (const relative of [...PLAN_FILES, ...EVIDENCE_FILES]) {
    before[relative] = readFileSync(join(directory, relative), 'utf8');
  }

  let stderr = '';
  const result = await repinExamplePins({
    rootDir: directory, ...stubs, out: SINK, err: (text) => { stderr += text; },
  });
  assert.equal(result.exitCode, 2);
  assert.match(stderr, /lead-to-won\.evidence\.json/, 'the refusal names the unreadable evidence');
  assert.deepEqual(result.wrote, []);
  for (const relative of [...PLAN_FILES, ...EVIDENCE_FILES]) {
    assert.equal(readFileSync(join(directory, relative), 'utf8'), before[relative],
      `${relative} is untouched by the refused repin`);
  }
});
