import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * **The one file the extraction edits.**
 *
 * LA0 exists to prove that moving Lead Intelligence out of the kernel changes
 * no externally observable behaviour. That proof is only worth anything if the
 * *same* cases and the *same* baseline run on both sides of the move — so
 * everything that knows where Intelligence currently lives is concentrated
 * here, in `wireIntelligence`, and nothing else in
 * `tests/characterization/` mentions `packages/core/src` at all.
 *
 * After the extraction, `wireIntelligence` writes a composition import instead
 * of an action-registry import and a fixed definition slot. Every case file,
 * every assertion and the checked-in baseline stay byte-identical. If they have
 * to change, the extraction changed behaviour, which is exactly the thing this
 * harness is here to refuse.
 *
 * **It moves nothing.** LA0 does not extract, does not move a helper, does not
 * replace `app.intelligence` and adds no seam. It only writes down what is true
 * today.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Records Lead Intelligence owns today, plus the host records it acts on. */
export const INTELLIGENCE_MODULES = Object.freeze([
  'lead.module.json',
  'task.module.json',
  'enrichment-snapshot.module.json',
  'behavioral-signal.module.json',
  'score-run.module.json',
  'score-contribution.module.json',
  'routing-run.module.json',
  'route-evaluation.module.json',
  'assignment.module.json',
]);

/** The fixed clock every case runs against: a characterization may not drift with the wall clock. */
export const FIXED_NOW = '2026-01-01T00:00:00.000Z';

/**
 * How Lead Intelligence is attached to a project **today**.
 *
 * Today: four actions built by `intelligence-actions.js` into the project's
 * action registry, and four definition kinds written into the project-owned
 * `packages/intelligence/generated/index.js` slot.
 *
 * After extraction this function writes one composition import instead. That is
 * the whole diff, and `ATTACHMENT` records which shape produced a baseline so a
 * comparison across the move is never silently comparing two different things.
 */
export const ATTACHMENT = 'kernel-actions-and-fixed-definition-slot';

/** @param {string} root @param {{enrichTimeoutMs?: number}} options */
export function wireIntelligence(root, { enrichTimeoutMs } = {}) {
  const starter = '../../../examples/starters/b2b-lead-qualification';
  const builderOptions = enrichTimeoutMs ? `{ timeoutMs: ${enrichTimeoutMs} }` : '';
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    `import { qualifyLead } from '${starter}/actions/qualify.js';`,
    `import { disqualifyLead } from '${starter}/actions/disqualify.js';`,
    "import { buildEnrichAction, buildRecordSignalAction, buildScoreAction, buildRouteAction }",
    "  from '../../core/src/intelligence-actions.js';",
    `export const generatedActions = [qualifyLead, disqualifyLead, buildEnrichAction(${builderOptions}),`,
    '  buildRecordSignalAction(), buildScoreAction(), buildRouteAction()];',
    '',
  ].join('\n'));

  writeFileSync(join(root, 'packages/intelligence/generated/index.js'), [
    '// @ts-check',
    'import { fixtureFirmographicsProvider, b2bSaasScoreV1, b2bSaasScoreV2, b2bRoutingV1, b2bRoutingV2, routingTargets }',
    `  from '${starter}/intelligence.js';`,
    'export const generatedEnrichmentProviders = [fixtureFirmographicsProvider];',
    'export const generatedScoringModels = [b2bSaasScoreV1, b2bSaasScoreV2];',
    'export const generatedRoutingPolicies = [b2bRoutingV1, b2bRoutingV2];',
    'export const generatedRoutingTargets = routingTargets;',
    '',
  ].join('\n'));
}

/** @param {string} root @param {string[]} args */
function cli(root, args) {
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/agent-crm.js'), ...args, '--root', root],
    { encoding: 'utf8', cwd: root });
}

/**
 * A throwaway project with Lead Intelligence attached, built by the real module
 * factory and the real CLI — not by hand-written fixtures, because a
 * characterization of hand-written fixtures characterizes the fixtures.
 *
 * @param {import('node:test').TestContext} t
 * @param {{enrichTimeoutMs?: number, name?: string}} [options]
 */
export function characterizationProject(t, { enrichTimeoutMs, name = 'agent-crm-la0-' } = {}) {
  const root = mkdtempSync(join(tmpdir(), name));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const entry of ['packages', 'apps', 'examples', 'package.json']) {
    cpSync(join(repoRoot, entry), join(root, entry), { recursive: true });
  }
  const starter = join(root, 'examples/starters/b2b-lead-qualification');
  for (const manifest of INTELLIGENCE_MODULES) {
    const applied = cli(root, ['module', 'create', join(starter, manifest), '--apply']);
    assert.equal(applied.status, 0, `apply ${manifest}: ${applied.stderr}`);
  }
  wireIntelligence(root, { enrichTimeoutMs });
  return root;
}

/**
 * Boot the project the way a consumer does: a real application, a real HTTP
 * server and the real SDK. Characterizing through the public surface is the
 * point — an in-process call would prove the internals still work after a move
 * that changed what a consumer sees.
 *
 * @param {string} root @param {string} dbPath @param {Record<string, unknown>} [options]
 */
export async function boot(root, dbPath, options = {}) {
  const { createAgentCrmApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AgentCrmClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAgentCrmApp({ dbPath, clock: () => FIXED_NOW, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AgentCrmClient({ baseUrl, actor: { type: 'user', id: 'la0-characterization' } });
  return {
    app,
    client,
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)).then(() => app.close()),
  };
}
