import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * **Every path that knows where Lead Intelligence lives today, in one place.**
 *
 * The claim was "one file changes at extraction". It was not literally true:
 * the helper cases imported `intelligence-registry.js` and
 * `intelligence-actions.js` directly, and the architecture-evidence cases
 * grepped for those paths, so extraction would have edited two files and a
 * reviewer would have had to find the second one.
 *
 * They belong here because that is the seam's whole job. After the move these
 * specifiers point into the package, `wireIntelligence` writes a composition
 * import, and nothing else in `tests/characterization/` changes.
 */
export const INTELLIGENCE_SOURCE = Object.freeze({
  registry: '../../packages/core/src/intelligence-registry.js',
  actions: '../../packages/core/src/intelligence-actions.js',
  /** Grep patterns for the architecture-evidence cases. */
  greps: Object.freeze(['app.intelligence', 'intelligence-registry.js', 'intelligence-actions.js', 'intelligence/generated']),
});

/**
 * The two neutral helpers, loaded from wherever they currently live.
 *
 * They no longer live in an Intelligence file: they were assessed
 * domain-neutral and moved to `definition-fingerprint.js` and `timeout.js`,
 * which is exactly the move the helper cases exist to police. The specifiers
 * are separate from `INTELLIGENCE_SOURCE` because the helpers and the domain
 * now move independently — folding them back together would re-create the
 * coupling the move removed.
 */
export const NEUTRAL_HELPER_SOURCE = Object.freeze({
  fingerprint: '../../packages/core/src/definition-fingerprint.js',
  timeout: '../../packages/core/src/timeout.js',
});

/** The two neutral helpers, loaded from wherever they currently live. */
export async function loadNeutralHelpers() {
  const { computeDefinitionFingerprint } = await import(NEUTRAL_HELPER_SOURCE.fingerprint);
  const { withTimeout } = await import(NEUTRAL_HELPER_SOURCE.timeout);
  return { computeDefinitionFingerprint, withTimeout };
}

/**
 * Behaviour-bearing source: every file whose content decides what Lead
 * Intelligence does, and therefore what this baseline observes.
 *
 * The first version listed eleven files and missed six that matter — the action
 * runtime that builds the context, the starter's `qualify`/`disqualify` actions
 * whose lifecycle gating LA0 freezes, the HTTP server that publishes the schema
 * block LA0 freezes, the application factory, and the SDK the cases drive. Any
 * of them could have changed observed behaviour without staling the baseline,
 * which is the one failure a freshness mechanism cannot have.
 */
export const BEHAVIOUR_BEARING_SOURCE = Object.freeze([
  'packages/core/src/intelligence-actions.js',
  'packages/core/src/intelligence-registry.js',
  'packages/core/src/definition-fingerprint.js',
  'packages/core/src/timeout.js',
  'packages/core/src/action-runtime.js',
  'packages/app/src/create-app.js',
  'apps/server/src/http-server.js',
  'packages/sdk/src/index.js',
  'examples/starters/b2b-lead-qualification/intelligence.js',
  'examples/starters/b2b-lead-qualification/actions/qualify.js',
  'examples/starters/b2b-lead-qualification/actions/disqualify.js',
  'examples/starters/b2b-lead-qualification/enrichment-snapshot.module.json',
  'examples/starters/b2b-lead-qualification/behavioral-signal.module.json',
  'examples/starters/b2b-lead-qualification/score-run.module.json',
  'examples/starters/b2b-lead-qualification/score-contribution.module.json',
  'examples/starters/b2b-lead-qualification/routing-run.module.json',
  'examples/starters/b2b-lead-qualification/route-evaluation.module.json',
  'examples/starters/b2b-lead-qualification/assignment.module.json',
  'examples/starters/b2b-lead-qualification/lead.module.json',
  'examples/starters/b2b-lead-qualification/task.module.json',
]);

/**
 * The guard that stops the list above rotting.
 *
 * A hand-maintained set of files is exactly the kind of thing that is correct
 * on the day it is written and wrong six months later. This enumerates the
 * files a *future* Intelligence change would plausibly land in, so a new
 * `intelligence-*.js` in the kernel or a new Intelligence module manifest in
 * the starter cannot silently fall outside digest ownership.
 *
 * @param {string} rootDir
 */
export function unownedIntelligenceSource(rootDir) {
  const owned = new Set(BEHAVIOUR_BEARING_SOURCE);
  const found = [];
  const kernel = join(rootDir, 'packages/core/src');
  for (const name of readdirSync(kernel)) {
    if (/intelligence/i.test(name)) found.push(`packages/core/src/${name}`);
  }
  const starter = join(rootDir, 'examples/starters/b2b-lead-qualification');
  for (const name of readdirSync(starter)) {
    if (!name.endsWith('.module.json')) continue;
    if (INTELLIGENCE_MODULES.includes(name)) found.push(`examples/starters/b2b-lead-qualification/${name}`);
  }
  return found.filter((path) => !owned.has(path)).sort();
}

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
  return spawnSync(process.execPath, ['--no-warnings', join(root, 'packages/cli/bin/accordo.js'), ...args, '--root', root],
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
export function characterizationProject(t, { enrichTimeoutMs, name = 'accordo-la0-' } = {}) {
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
  const { createAccordoApp } = await import(pathToFileURL(join(root, 'packages/app/src/index.js')).href);
  const { createHttpServer } = await import(pathToFileURL(join(root, 'apps/server/src/index.js')).href);
  const { AccordoClient } = await import(pathToFileURL(join(root, 'packages/sdk/src/index.js')).href);
  const app = createAccordoApp({ dbPath, clock: () => FIXED_NOW, ...options });
  const server = createHttpServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const client = new AccordoClient({ baseUrl, actor: { type: 'user', id: 'la0-characterization' } });
  return {
    app,
    client,
    baseUrl,
    close: () => new Promise((resolve) => server.close(resolve)).then(() => app.close()),
  };
}
