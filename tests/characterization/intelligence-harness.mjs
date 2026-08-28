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
  '../../../packages/work/modules/work-task.module.json',
  '../../../packages/work/modules/work-activity.module.json',
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
 * Today: one composition entry in `packages/domains/generated/index.js`, which
 * is how every optional domain package is attached.
 *
 * Before the extraction this wrote four action-registry imports and a fixed
 * project-owned definition slot. That was the whole diff, and `ATTACHMENT`
 * records which shape produced a baseline so a comparison across the move is
 * never silently comparing two different things.
 */
export const ATTACHMENT = 'composed-domain-package';

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
  registry: '../../packages/intelligence/src/registry.js',
  actions: '../../packages/intelligence/src/actions.js',
  entry: '../../packages/intelligence/src/index.js',
  /** Patterns for the architecture-evidence cases, kept in the seam. */
  greps: Object.freeze(['app.intelligence', 'intelligence/src/registry.js', 'intelligence/src/actions.js', 'domains/generated']),
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

/**
 * **Where the published schema block lives.**
 *
 * The cases read this through the seam rather than by path, and that is not
 * tidiness. `architecture.definition-kinds-published` and every
 * `architecture.fingerprint.*` observation is `contractual`, and each of them
 * used to reach `schema.intelligence` directly — a hard-coded location inside
 * an asserted observation.
 *
 * ADR-021 sanctions publishing the block as the package's own contribution,
 * which moves it under `domains`. With the path hard-coded, that move would
 * have read `undefined`, reported empty arrays, and failed as though the
 * definitions had changed. Worse, an extraction that genuinely **lost** the
 * definitions would have produced the identical empty arrays — so the harness
 * could not have told a move from a loss, which is the one distinction it
 * exists to make.
 *
 * Now the location is the seam's business and the contents are the contract.
 * A block that is nowhere returns `undefined`, the contractual observations go
 * red, and losing the definitions stays loud.
 *
 * @param {any} schema the `/api/schema` document
 */
export function intelligenceSchemaBlock(schema) {
  return schema?.intelligence ?? schema?.domains?.intelligence?.metadata ?? schema?.domains?.intelligence;
}

/** Where the block was actually found, recorded as evidence rather than asserted. */
export function intelligenceSchemaLocation(schema) {
  if (schema?.intelligence) return 'schema.intelligence';
  if (schema?.domains?.intelligence?.metadata) return 'schema.domains.intelligence.metadata';
  if (schema?.domains?.intelligence) return 'schema.domains.intelligence';
  return null;
}

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
  'packages/intelligence/src/index.js',
  'packages/intelligence/src/actions.js',
  'packages/intelligence/src/registry.js',
  'packages/intelligence/src/capability.js',
  'packages/core/src/definition-fingerprint.js',
  // The definition-version store, which owns the persist-or-verify loop the
  // registries above used to render by hand (Spine v2 M2B). Hashed for the same
  // reason as the execution-run store in this list: M2B moved behaviour out of
  // files this list hashes into one it did not, so until this line existed a change
  // to the rule that decides whether the application starts moved no baseline
  // hash at all. Found and closed by M2C
  // (`docs/plans/spine-v2-m2c-execution-run-store.md`).
  'packages/core/src/definition-version-store.js',
  'packages/core/src/timeout.js',
  'packages/core/src/action-runtime.js',
  // The execution-run store, which now owns the run and span rows `writeTrace`
  // above used to render by hand (Spine v2 M2C). It is hashed here for one
  // reason: without it this baseline would be strictly LESS sensitive than it
  // was, because behaviour moved out of a file it hashes into one it did not.
  'packages/core/src/execution-run-store.js',
  'packages/app/src/create-app.js',
  'apps/server/src/http-server.js',
  'packages/sdk/src/index.js',
  'examples/starters/b2b-lead-qualification/intelligence.js',
  'examples/starters/b2b-lead-qualification/actions/qualify.js',
  'examples/starters/b2b-lead-qualification/actions/disqualify.js',
  'packages/intelligence/modules/enrichment-snapshot.module.json',
  'packages/intelligence/modules/behavioral-signal.module.json',
  'packages/intelligence/modules/score-run.module.json',
  'packages/intelligence/modules/score-contribution.module.json',
  'packages/intelligence/modules/routing-run.module.json',
  'packages/intelligence/modules/route-evaluation.module.json',
  'packages/intelligence/modules/assignment.module.json',
  'examples/starters/b2b-lead-qualification/lead.module.json',
  'packages/work/modules/work-task.module.json',
  'packages/work/modules/work-activity.module.json',
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
  // The kernel must contain nothing Intelligence any more; if a file reappears
  // there, that is the extraction leaking back and the guard says so.
  const kernel = join(rootDir, 'packages/core/src');
  for (const name of readdirSync(kernel)) {
    if (/intelligence/i.test(name)) found.push(`packages/core/src/${name}`);
  }
  for (const name of readdirSync(join(rootDir, 'packages/intelligence/src'))) {
    if (/\.(mjs|js)$/.test(name)) found.push(`packages/intelligence/src/${name}`);
  }
  for (const name of readdirSync(join(rootDir, 'packages/intelligence/modules'))) {
    if (name.endsWith('.module.json')) found.push(`packages/intelligence/modules/${name}`);
  }
  return found.filter((path) => !owned.has(path)).sort();
}

/** @param {string} root @param {{enrichTimeoutMs?: number}} options */
export function wireIntelligence(root, { enrichTimeoutMs } = {}) {
  const starter = '../../../examples/starters/b2b-lead-qualification';
  const config = enrichTimeoutMs ? `, config: { timeoutMs: ${enrichTimeoutMs} }` : '';
  writeFileSync(join(root, 'packages/actions/generated/index.js'), [
    '// @ts-check',
    `import { qualifyLead } from '${starter}/actions/qualify.js';`,
    `import { disqualifyLead } from '${starter}/actions/disqualify.js';`,
    'export const generatedActions = [qualifyLead, disqualifyLead];',
    '',
  ].join('\n'));

  // One composition entry — the whole attachment. The four actions arrive with
  // the package rather than being registered by the project, which is the
  // difference between a domain the project wires and a domain it composes.
  writeFileSync(join(root, 'packages/domains/generated/index.js'), [
    '// @ts-check',
    "import { createIntelligenceDomain } from '../../intelligence/src/index.js';",
    'import { fixtureFirmographicsProvider, b2bSaasScoreV1, b2bSaasScoreV2, b2bRoutingV1, b2bRoutingV2, routingTargets }',
    `  from '${starter}/intelligence.js';`,
    'export const generatedDomains = [createIntelligenceDomain({',
    '  enrichmentProviders: [fixtureFirmographicsProvider],',
    '  scoringModels: [b2bSaasScoreV1, b2bSaasScoreV2],',
    '  routingPolicies: [b2bRoutingV1, b2bRoutingV2],',
    `  routingTargets${config},`,
    '})];',
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
  const packaged = join(root, 'packages/intelligence/modules');
  for (const manifest of INTELLIGENCE_MODULES) {
    const from = [
    'lead.module.json',
    // Work v1 (ADR-030): the starter's bespoke `task` module is gone and its
    // follow-up now lives in the work package's records. Relative to the
    // starter directory, so the existing join(starter, manifest) still holds.
    '../../../packages/work/modules/work-task.module.json',
    '../../../packages/work/modules/work-activity.module.json',
  ].includes(manifest) ? starter : packaged;
    const applied = cli(root, ['module', 'create', join(from, manifest), '--apply']);
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
