import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = join(repoRoot, 'tests/fixtures/pre-extraction-m9.sql');

/**
 * **A database written by pre-extraction code must boot under the extracted
 * package, and keep every guarantee it had.**
 *
 * The extraction's own tests all create their databases with the *new* code,
 * which cannot show that an existing customer's database survives. This one
 * starts from a database that the pre-extraction runtime actually wrote:
 * `tests/fixtures/pre-extraction-m9.sql` was produced by booting the kernel at
 * the commit before the move, running real M9 flows — leads, behavioural
 * signals, enrichment snapshots, scoring runs with contributions, routing runs
 * with evaluations and assignments — and dumping the result.
 *
 * It is checked in as **SQL text, not a database file**: reviewable in a diff,
 * and not a tracked binary. Its most important rows are the five
 * `definition_versions` entries typed `enrichment-provider`, `scoring-model`
 * and `routing-policy` — the legacy type strings the package deliberately
 * keeps. If the extraction had re-typed them, this test is where an existing
 * database would be caught losing its immutability guarantee.
 */

const INTELLIGENCE_MODULES = [
  'enrichment-snapshot', 'behavioral-signal', 'score-run', 'score-contribution',
  'routing-run', 'route-evaluation', 'assignment',
];
const STARTER = '../../../examples/starters/b2b-lead-qualification';

function project(t) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-upgrade-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  // A real upgrade has two halves: the customer's **source** and the
  // customer's **database**. The source is regenerated here from the same
  // manifests the old project used — byte-identical, because the extraction
  // moved them without editing them — into a throwaway database. The legacy
  // database is then restored separately and booted against that source, which
  // is exactly the shape of a customer pulling a new release.
  const cli = (args) => spawnSync(process.execPath,
    ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of ['lead.module.json', 'task.module.json']) {
    const applied = cli(['module', 'create', join(starter, manifest), '--apply']);
    assert.equal(applied.status, 0, `${manifest}: ${applied.stderr}`);
  }
  for (const name of INTELLIGENCE_MODULES) {
    const applied = cli(['module', 'create', join(root, 'packages/intelligence/modules', `${name}.module.json`), '--apply']);
    assert.equal(applied.status, 0, `${name}: ${applied.stderr}`);
  }
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    '// @ts-check',
    "import { createIntelligenceDomain } from '../../intelligence/src/index.js';",
    'import { fixtureFirmographicsProvider, b2bSaasScoreV1, b2bSaasScoreV2, b2bRoutingV1, b2bRoutingV2, routingTargets }',
    `  from '${STARTER}/intelligence.js';`,
    'export const generatedDomains = [createIntelligenceDomain({',
    '  enrichmentProviders: [fixtureFirmographicsProvider],',
    '  scoringModels: [b2bSaasScoreV1, b2bSaasScoreV2],',
    '  routingPolicies: [b2bRoutingV1, b2bRoutingV2],',
    '  routingTargets,',
    '})];',
    '',
  ].join('\n'));
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    `import { qualifyLead } from '${STARTER}/actions/qualify.js';`,
    'export const generatedActions = [qualifyLead];',
    '',
  ].join('\n'));
  return root;
}

/** Replay the pre-extraction dump into a fresh database file. */
function restore(root) {
  const dbPath = join(root, 'data', 'legacy.sqlite');
  mkdirSync(join(root, 'data'), { recursive: true });
  const script = join(root, 'restore.mjs');
  writeFileSync(script, [
    "import { DatabaseSync } from 'node:sqlite';",
    "import { readFileSync } from 'node:fs';",
    `const db = new DatabaseSync(${JSON.stringify(dbPath)});`,
    `db.exec(readFileSync(${JSON.stringify(FIXTURE)}, 'utf8'));`,
    'db.close();',
    "console.log('__RESTORED__');",
    '',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  assert.match(run.stdout || '', /__RESTORED__/, `restore failed: ${run.stderr}`);
  return dbPath;
}

function phase(root, dbPath, body, label) {
  const script = join(root, `phase-${label}.mjs`);
  writeFileSync(script, [
    "import { createAccordoApp } from './packages/app/src/index.js';",
    'const out = {};',
    'let app;',
    'try {',
    `  app = createAccordoApp({ dbPath: ${JSON.stringify(dbPath)} });`,
    '} catch (error) {',
    '  out.bootFailed = { code: error.code, message: String(error.message) };',
    "  console.log('__RESULT__' + JSON.stringify(out)); process.exit(0);",
    '}',
    'const actor = { type: "user", id: "upgrade" };',
    'try {',
    body,
    '} finally { app.close(); }',
    "console.log('__RESULT__' + JSON.stringify(out));",
    '',
  ].join('\n'));
  const run = spawnSync(process.execPath, ['--no-warnings', script], { encoding: 'utf8', cwd: root });
  const line = (run.stdout || '').split('\n').find((l) => l.startsWith('__RESULT__'));
  assert.ok(line, `phase ${label} produced no result (exit ${run.status}):\nSTDOUT: ${run.stdout}\nSTDERR: ${run.stderr}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

test('a pre-extraction database boots under the extracted package with its rows and guarantees intact', async (t) => {
  const root = project(t);
  const dbPath = restore(root);

  const after = phase(root, dbPath, `
    out.counts = {};
    for (const table of ${JSON.stringify(['enrichment_snapshots', 'behavioral_signals', 'score_runs',
      'score_contributions', 'routing_runs', 'route_evaluations', 'assignments'])}) {
      out.counts[table] = app.database.raw.prepare('SELECT COUNT(*) AS n FROM ' + table).get().n;
    }
    // The legacy definition rows must still be the ones being checked.
    out.definitionTypes = app.database.raw
      .prepare('SELECT DISTINCT type FROM definition_versions ORDER BY type').all().map((r) => r.type);
    out.definitionRows = app.database.raw.prepare('SELECT COUNT(*) AS n FROM definition_versions').get().n;
    // Every M9 record module is readable through the extracted package.
    out.readable = {};
    for (const name of ${JSON.stringify(INTELLIGENCE_MODULES)}) {
      const page = await app.modules.get(name).service.list({ limit: 500 });
      out.readable[name] = Array.isArray(page) ? page.length : (page.items ?? []).length;
    }
    // The historical scoring evidence still explains itself.
    const runsPage = await app.modules.get('score-run').service.list({ limit: 500 });
    const runs = Array.isArray(runsPage) ? runsPage : (runsPage.items ?? []);
    out.historicalRun = runs[0] ? {
      model: runs[0].model, version: runs[0].modelVersion,
      fingerprint: runs[0].fingerprint, total: runs[0].totalScore,
    } : null;
    // And the domain still WORKS on the old data: re-score an existing lead.
    const leadId = runs[0].leadId;
    const rescored = await app.runAction({ module: 'lead', action: 'score', recordId: leadId,
      input: { model: 'b2b-saas-score', version: 1 }, actor });
    out.rescored = { total: rescored.result.total };
    out.declaredFingerprint = app.domains.metadata().intelligence.scoringModels
      .find((m) => m.name === 'b2b-saas-score' && m.version === 1).fingerprint;
  `, 'upgrade');

  assert.equal(after.bootFailed, undefined, `the extracted code must boot on a pre-extraction database: ${JSON.stringify(after.bootFailed)}`);

  // Rows survive, exactly.
  assert.deepEqual(after.counts, {
    enrichment_snapshots: 2, behavioral_signals: 4, score_runs: 2,
    score_contributions: 12, routing_runs: 2, route_evaluations: 6, assignments: 2,
  }, 'every M9 row written by the old code is still there');

  // The guarantee that would have been lost by re-typing the rows.
  assert.deepEqual(after.definitionTypes, ['enrichment-provider', 'routing-policy', 'scoring-model'],
    'the package still checks the definition_versions rows the old code wrote, under their original type strings');
  assert.equal(after.definitionRows, 5, 'and it added no duplicate set alongside them');

  for (const [name, count] of Object.entries(after.readable)) {
    assert.ok(count > 0, `${name} is readable through the extracted package`);
  }

  // Historical evidence still explains itself, and the model it names is the
  // model the composition still declares — the fingerprint did not move.
  assert.match(after.historicalRun.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(after.historicalRun.fingerprint, after.declaredFingerprint,
    'the fingerprint on a run written before the extraction still matches the declared model after it');
  assert.equal(after.rescored.total, after.historicalRun.total,
    'and re-scoring the same lead with the same model version reproduces the same total');
});

test('a drifted definition still stops the boot of a pre-extraction database', async (t) => {
  // The immutability guarantee, tested where it matters most: on a database
  // whose definition_versions rows predate the package. If the package had
  // re-typed them, the old rows would go unmatched and this drift would be
  // silently accepted.
  const root = project(t);
  const dbPath = restore(root);
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    '// @ts-check',
    "import { createIntelligenceDomain } from '../../intelligence/src/index.js';",
    'export const generatedDomains = [createIntelligenceDomain({',
    '  scoringModels: [{',
    "    name: 'b2b-saas-score', version: 1, label: 'Drifted after the extraction',",
    "    rules: [{ key: 'drifted', label: 'Drifted', weight: 1, evaluate: () => true }],",
    '  }],',
    '})];',
    '',
  ].join('\n'));
  const drifted = phase(root, dbPath, 'out.booted = true;', 'drift');
  assert.ok(drifted.bootFailed, 'editing a registered version must still stop the boot');
  assert.match(drifted.bootFailed.message, /source changed after registration/,
    'and say why, naming the immutability rule rather than a SQL error');
});

test('the fixture is text, reviewable, and carries no machine layout', () => {
  const sql = readFileSync(FIXTURE, 'utf8');
  assert.match(sql, /^PRAGMA foreign_keys=OFF;/, 'a plain SQL dump, not a binary database');
  assert.match(sql, /INSERT INTO "definition_versions"/, 'including the legacy definition rows');
  for (const forbidden of [/\/home\//, /\/tmp\//, /password/i, /secret/i, /BEGIN [A-Z ]*PRIVATE KEY/]) {
    assert.doesNotMatch(sql, forbidden, `the fixture must not carry ${forbidden}`);
  }
});
