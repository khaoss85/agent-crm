import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importsFrom } from './characterization/source-scan.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * **`intelligence@1` proved by a consumer, not by resolution.**
 *
 * The extraction replaced an ambient field with a declared capability. That is
 * only an improvement if the capability is genuinely reachable by a package
 * that declares it — and until this test existed, `crm app inspect` reported
 * `intelligence@1` with `consumers: []`. A capability nothing consumes is
 * proved to *resolve*; "the registry did not complain" is the kind of
 * self-report this framework refuses everywhere else.
 *
 * The consumer is deliberately **customer-authored**, under
 * `examples/custom-packages/`, because ADR-021's sixth point is that a custom
 * package gets exactly the same access a first-party one does.
 *
 * Each phase boots in its own process: a composition change is a restart, and
 * an in-process re-boot would reuse Node's cached composition module and prove
 * nothing.
 */

const STARTER = '../../../examples/starters/b2b-lead-qualification';
const CONSUMER = '../../../examples/custom-packages/score-disclosure/src/index.js';

const INTELLIGENCE_MODULES = [
  'enrichment-snapshot', 'behavioral-signal', 'score-run', 'score-contribution',
  'routing-run', 'route-evaluation', 'assignment',
];

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/**
 * @param {string} root
 * @param {{intelligence: boolean, consumer: boolean, capabilityVersion?: number}} shape
 */
function compose(root, { intelligence, consumer, capabilityVersion }) {
  const lines = ['// @ts-check'];
  if (intelligence) {
    lines.push("import { createIntelligenceDomain } from '../../intelligence/src/index.js';");
    lines.push('import { fixtureFirmographicsProvider, b2bSaasScoreV1, b2bSaasScoreV2, b2bRoutingV1, routingTargets }');
    lines.push(`  from '${STARTER}/intelligence.js';`);
  }
  if (consumer) lines.push(`import { createScoreDisclosurePackage } from '${CONSUMER}';`);
  lines.push('const packages = [];');
  if (intelligence) {
    lines.push('packages.push(createIntelligenceDomain({');
    lines.push('  enrichmentProviders: [fixtureFirmographicsProvider],');
    lines.push('  scoringModels: [b2bSaasScoreV1, b2bSaasScoreV2],');
    lines.push('  routingPolicies: [b2bRoutingV1],');
    lines.push('  routingTargets,');
    lines.push('}));');
  }
  if (consumer) {
    lines.push('const consumerPkg = createScoreDisclosurePackage();');
    if (capabilityVersion !== undefined) {
      // Ask for a version the provider does not offer, to prove the refusal.
      lines.push(`consumerPkg.requires = [{ package: 'intelligence', capability: 'intelligence', version: ${capabilityVersion} }];`);
    }
    lines.push('packages.push(consumerPkg);');
  }
  lines.push('export const generatedDomains = packages;', '');
  writeFileSync(join(root, 'packages/domains/generated/index.js'), lines.join('\n'));
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-cap-consumer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of [
    'lead.module.json',
    // Work v1 (ADR-030): the starter's bespoke `task` module is gone and its
    // follow-up now lives in the work package's records. Relative to the
    // starter directory, so the existing join(starter, manifest) still holds.
    '../../../packages/work/modules/work-task.module.json',
    '../../../packages/work/modules/work-activity.module.json',
  ]) {
    assert.equal(cli(root, ['module', 'create', join(starter, manifest), '--apply']).status, 0, manifest);
  }
  for (const name of INTELLIGENCE_MODULES) {
    assert.equal(cli(root, ['module', 'create', join(root, 'packages/intelligence/modules', `${name}.module.json`), '--apply']).status, 0, name);
  }
  assert.equal(
    cli(root, ['module', 'create', join(root, 'examples/custom-packages/score-disclosure/modules/score-disclosure.module.json'), '--apply']).status,
    0, 'score-disclosure manifest',
  );
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    `import { qualifyLead } from '${STARTER}/actions/qualify.js';`,
    'export const generatedActions = [qualifyLead];',
    '',
  ].join('\n'));
  return root;
}

/** Run one phase in a fresh process. */
function phase(root, dbPath, body, label) {
  const script = join(root, `phase-${label}.mjs`);
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    'const out = {};',
    'let app;',
    'try {',
    `  app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    '} catch (error) {',
    '  out.bootFailed = { code: error.code, status: error.status, message: String(error.message) };',
    '  console.log("__RESULT__" + JSON.stringify(out));',
    '  process.exit(0);',
    '}',
    'const actor = { type: "user", id: "reviewer-1" };',
    'try {',
    body,
    '} finally { app.close(); }',
    'console.log("__RESULT__" + JSON.stringify(out));',
    '',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `phase ${label} produced no result (exit ${run.status}):\nSTDOUT: ${run.stdout}\nSTDERR: ${run.stderr}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

test('a customer-authored package consumes intelligence@1 through the public capability path', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'consumer.sqlite');
  compose(root, { intelligence: true, consumer: true });

  const result = phase(root, dbPath, `
    const lead = await app.modules.get('lead').service.create({
      firstName: 'Nadia', lastName: 'Conti', email: 'nadia@conti.example',
      companyName: 'Conti SRL', source: 'website',
    }, { actor });
    const disclosed = await app.runAction({ module: 'lead', action: 'disclose-scoring-model',
      recordId: lead.id, input: { model: 'b2b-saas-score', version: 2 }, actor });
    out.record = disclosed.result;
    // The capability's own view, for comparison — same declared definition.
    out.declared = app.domains.metadata().intelligence.scoringModels
      .find((m) => m.name === 'b2b-saas-score' && m.version === 2);
    // An agent actor is refused the disclosure.
    out.agentRefused = await app.runAction({ module: 'lead', action: 'disclose-scoring-model',
      recordId: lead.id, input: { model: 'b2b-saas-score', version: 1 },
      actor: { type: 'agent', id: 'bot' } })
      .then(() => ({ ok: true }), (e) => ({ ok: false, status: e.status, code: e.code }));
    // An undeclared model is refused with a field-tied validation error.
    out.unknownModel = await app.runAction({ module: 'lead', action: 'disclose-scoring-model',
      recordId: lead.id, input: { model: 'not-a-model', version: 1 }, actor })
      .then(() => ({ ok: true }), (e) => ({ ok: false, status: e.status }));
    out.disclosureRows = app.database.raw.prepare('SELECT COUNT(*) AS n FROM score_disclosures').get().n;
  `, 'present');

  assert.equal(result.record.modelName, 'b2b-saas-score', 'the disclosure names the declared model');
  assert.equal(result.record.modelVersion, 2);
  assert.match(result.record.modelFingerprint, /^[0-9a-f]{64}$/, 'and freezes its declared-definition fingerprint');
  assert.equal(result.record.modelFingerprint, result.declared.fingerprint,
    'the fingerprint the consumer recorded is the one the provider declares — the read went through the capability');
  assert.equal(result.record.ruleCount, result.declared.rules.length, 'and the rule count matches the declaration');

  assert.equal(result.agentRefused.ok, false);
  assert.equal(result.agentRefused.status, 403, 'an agent cannot sign a disclosure');
  assert.equal(result.agentRefused.code, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(result.unknownModel.ok, false);
  assert.equal(result.unknownModel.status, 400, 'an undeclared model is a field-tied refusal, not a crash');
  assert.equal(result.disclosureRows, 1, 'exactly one disclosure was written');
});

test('the consumer fails clearly when the provider is absent, and when the version does not match', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'absent.sqlite');

  // Provider absent: the composition must be refused at STARTUP, naming the
  // edge — not at runtime inside a transaction.
  compose(root, { intelligence: false, consumer: true });
  const absent = phase(root, dbPath, 'out.booted = true;', 'absent');
  assert.ok(absent.bootFailed, 'an unmet declared capability must stop startup');
  assert.match(`${absent.bootFailed.message}`, /intelligence/,
    'and the refusal must name the capability that is missing');

  // Provider present, wrong version: also a startup refusal.
  compose(root, { intelligence: true, consumer: true, capabilityVersion: 99 });
  const mismatch = phase(root, dbPath, 'out.booted = true;', 'mismatch');
  assert.ok(mismatch.bootFailed, 'a version the provider does not offer must stop startup');
  assert.match(`${mismatch.bootFailed.message}`, /intelligence/);
});

test('the consumer reaches Intelligence only through the capability, never by import', () => {
  // The rule the capability exists to enforce. `packages/*/src` is private by
  // written contract (PACKAGE_AUTHORING §"Everything in packages/core/src/* is
  // private"), and a consumer that deep-imports the provider has re-created the
  // coupling the extraction removed — silently, and while still passing.
  const source = readFileSync(
    join(repoRoot, 'examples/custom-packages/score-disclosure/src/index.js'), 'utf8',
  );
  assert.deepEqual(importsFrom(source, /packages\/intelligence/), [],
    'the consumer must not import anything from the intelligence package');
  assert.deepEqual(importsFrom(source, /intelligence\/(src|modules)/), []);
  // The one kernel import a package is allowed.
  assert.deepEqual(importsFrom(source, /core\/index\.js$/), ['../../../../packages/core/index.js']);
});
