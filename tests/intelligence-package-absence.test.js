import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Lead Intelligence is now optional, and "optional" is a claim that has to be
 * paid for rather than asserted.
 *
 * Before the extraction the domain was constructed by the application factory
 * itself: there was no composition to remove, so there was no way to run
 * without it and no way to prove the rest of the CRM did not depend on it. The
 * only honest test of an optional domain is to remove it and look at what is
 * left — including the rows, which must survive, because a customer who
 * removes a package has not asked anybody to delete their data.
 *
 * **Each phase runs in its own process.** The first version of this test
 * rewrote the composition file and re-booted in-process, and the domain stayed
 * available — Node had cached the composition module by URL, so the second boot
 * silently reused the first one's packages. That was a test artifact rather
 * than a product defect, and it is exactly the artifact that would have let
 * this test pass while proving nothing. A composition change is a restart.
 */

const MANIFESTS = [
  'enrichment-snapshot.module.json', 'behavioral-signal.module.json', 'score-run.module.json',
  'score-contribution.module.json', 'routing-run.module.json', 'route-evaluation.module.json',
  'assignment.module.json',
];

const COMPOSITION = 'packages/domains/generated/index.js';
const STARTER = '../../../examples/starters/b2b-lead-qualification';

function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

function compose(root, withIntelligence) {
  writeFileSync(join(root, COMPOSITION), withIntelligence ? [
    '// @ts-check',
    "import { createIntelligenceDomain } from '../../intelligence/src/index.js';",
    'import { fixtureFirmographicsProvider, b2bSaasScoreV1, b2bRoutingV1, routingTargets }',
    `  from '${STARTER}/intelligence.js';`,
    'export const generatedDomains = [createIntelligenceDomain({',
    '  enrichmentProviders: [fixtureFirmographicsProvider],',
    '  scoringModels: [b2bSaasScoreV1],',
    '  routingPolicies: [b2bRoutingV1],',
    '  routingTargets,',
    '})];',
    '',
  ].join('\n') : ['// @ts-check', 'export const generatedDomains = [];', ''].join('\n'));
}

/** Run one phase in a fresh process and return whatever it reported. */
function phase(root, dbPath, body) {
  const script = join(root, `phase-${Math.abs(hash(body))}.mjs`);
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    `const app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    'const actor = { type: "user", id: "absence" };',
    'const out = {};',
    'try {',
    body,
    '} finally { app.close(); }',
    'console.log("__RESULT__" + JSON.stringify(out));',
    '',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `phase produced no result (exit ${run.status}):\nSTDOUT: ${run.stdout}\nSTDERR: ${run.stderr}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

/** @param {string} value */
function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (h * 31 + value.charCodeAt(i)) | 0;
  return h;
}

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-intel-absent-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of ['lead.module.json', 'task.module.json']) {
    assert.equal(cli(root, ['module', 'create', join(starter, manifest), '--apply']).status, 0, manifest);
  }
  for (const manifest of MANIFESTS) {
    assert.equal(cli(root, ['module', 'create', join(root, 'packages/intelligence/modules', manifest), '--apply']).status, 0, manifest);
  }
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    `import { qualifyLead } from '${STARTER}/actions/qualify.js';`,
    'export const generatedActions = [qualifyLead];',
    '',
  ].join('\n'));
  return root;
}

test('the domain is genuinely optional: composed, absent, reattached — with the rows intact', async (t) => {
  const root = project(t);
  const dbPath = join(root, 'data', 'absence.sqlite');

  // ---- composed: the surface exists and writes evidence
  compose(root, true);
  const composed = phase(root, dbPath, `
    const lead = await app.modules.get('lead').service.create({
      firstName: 'Ada', lastName: 'Rossi', email: 'ada@rossi.example',
      companyName: 'Rossi SpA', source: 'website',
    }, { actor });
    out.leadId = lead.id;
    await app.runAction({ module: 'lead', action: 'record-signal', recordId: lead.id,
      input: { signalType: 'demo-requested', observedAt: '2026-08-01T10:00:00Z' }, actor });
    const scored = await app.runAction({ module: 'lead', action: 'score', recordId: lead.id,
      input: { model: 'b2b-saas-score', version: 1 }, actor });
    out.total = scored.result.total;
    out.schemaHasDomain = Boolean(app.domains.metadata().intelligence);
    out.scoreRuns = app.database.raw.prepare('SELECT COUNT(*) AS n FROM score_runs').get().n;
  `);
  assert.equal(typeof composed.total, 'number', 'the composed domain scores');
  assert.equal(composed.schemaHasDomain, true, 'and publishes its schema contribution');
  assert.equal(composed.scoreRuns, 1);

  // ---- absent: one line removed from the composition, nothing else
  compose(root, false);
  const absent = phase(root, dbPath, `
    const leadId = ${JSON.stringify(composed.leadId)};
    out.leadStillReadable = (await app.modules.get('lead').service.get(leadId)).email;
    const made = await app.modules.get('lead').service.create({
      firstName: 'Bo', lastName: 'Neri', email: 'bo@neri.example',
      companyName: 'Neri', source: 'website',
    }, { actor });
    out.coreStillWorks = Boolean(made.id);
    out.action = await app.runAction({ module: 'lead', action: 'score', recordId: leadId,
      input: { model: 'b2b-saas-score', version: 1 }, actor })
      .then(() => ({ ok: true }), (error) => ({ ok: false, status: error.status, code: error.code }));
    out.schemaHasDomain = Boolean(app.domains.metadata().intelligence);
    out.ambientField = app.intelligence === undefined ? 'gone' : 'present';
    out.advertised = ['enrich', 'record-signal', 'score', 'route']
      .filter((name) => { try { return Boolean(app.actions.get('lead', name)); } catch { return false; } });
    out.scoreRuns = app.database.raw.prepare('SELECT COUNT(*) AS n FROM score_runs').get().n;
    out.signals = app.database.raw.prepare('SELECT COUNT(*) AS n FROM behavioral_signals').get().n;
  `);
  assert.equal(absent.leadStillReadable, 'ada@rossi.example', "the Lead is the project's record and survives");
  assert.equal(absent.coreStillWorks, true, 'core CRM still works with no Intelligence composed');
  assert.equal(absent.action.ok, false, 'the action is not silently available');
  assert.equal(absent.action.status, 404, 'and its absence is a 404, not a crash');
  assert.equal(absent.schemaHasDomain, false, 'no schema contribution');
  assert.equal(absent.ambientField, 'gone', 'and no ambient field either — it is gone for good, not defaulted');
  for (const name of ['enrich', 'record-signal', 'score', 'route']) {
    assert.equal(absent.advertised.includes(name), false, `${name} is not advertised`);
  }
  // The ROWS stay. Removing a package is not a data migration.
  assert.equal(absent.scoreRuns, 1, 'the score run written while composed is still on disk');
  assert.equal(absent.signals, 1, 'and so is the signal');

  // ---- reattached: surface and data both come back
  compose(root, true);
  const back = phase(root, dbPath, `
    const rows = app.modules.get('score-run').service.listWhere({ leadId: ${JSON.stringify(composed.leadId)} });
    out.historical = rows.length;
    const rescored = await app.runAction({ module: 'lead', action: 'score',
      recordId: ${JSON.stringify(composed.leadId)}, input: { model: 'b2b-saas-score', version: 1 }, actor });
    out.total = rescored.result.total;
    out.schemaHasDomain = Boolean(app.domains.metadata().intelligence);
  `);
  assert.equal(back.historical, 1, 'the historical run is readable again, and is the same run');
  assert.equal(back.total, composed.total, 'and the domain decides identically after the round trip');
  assert.equal(back.schemaHasDomain, true, 'the schema contribution is back');
});

test('the kernel carries no Lead Intelligence source at all', () => {
  // The check that catches a "move" which left a fallback behind. ADR-021's
  // removal gate says the final head must contain no bridge; this is that gate
  // as a test rather than as a promise.
  const kernel = join(repoRoot, 'packages/core/src');
  assert.deepEqual(readdirSync(kernel).filter((name) => /intelligence/i.test(name)), [],
    'packages/core must contain no Intelligence file');

  assert.doesNotMatch(readFileSync(join(kernel, 'action-runtime.js'), 'utf8'), /intelligence/i,
    'the action runtime must not inject an ambient domain key, not even a defaulted one');
  assert.doesNotMatch(readFileSync(join(repoRoot, 'packages/app/src/create-app.js'), 'utf8'), /intelligence/i,
    'the application factory must not construct the domain it no longer owns');
  assert.doesNotMatch(readFileSync(join(repoRoot, 'apps/server/src/http-server.js'), 'utf8'), /app\.intelligence/,
    'and the HTTP server must not publish an ambient block for it');
});
