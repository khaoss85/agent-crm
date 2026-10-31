// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_MODULES, readNativeModuleStatus } from '../packages/cli/src/native-modules-catalog.js';
import { SHELL_GROUPS, SETTINGS_AREAS, buildShellNav } from '../apps/admin/public/admin-shell.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { PERSONALIZZAZIONE_TAB_LABELS } from '../apps/admin/public/admin-personalizzazione.js';

/**
 * Native-modules catalog (backlog:329bbbb7) — the machine-readable answer an
 * agent starts from instead of rewriting a native module.
 *
 * The properties under test are the ones an agent would be harmed by getting
 * wrong: every entry carries name, purpose, screen, activation and
 * customization; every screen is a real backoffice voice (no invented
 * route); every activation names a real package factory the framework ships;
 * and a generated project reports active natives and custom bundles as two
 * distinct lists that never mix.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

test('catalog lists the eight native modules with every field filled', () => {
  assert.equal(NATIVE_MODULES.length, 8);
  const ids = new Set();
  for (const entry of NATIVE_MODULES) {
    assert.match(entry.id, /^[a-z-]+$/, `id ${entry.id}`);
    assert.ok(!ids.has(entry.id), `duplicate id ${entry.id}`);
    ids.add(entry.id);
    for (const field of ['name', 'purpose']) {
      assert.equal(typeof entry[field], 'string', `${entry.id}.${field}`);
      assert.ok(entry[field].trim() !== '', `${entry.id}.${field} is empty`);
    }
    assert.equal(typeof entry.screen.route, 'string', `${entry.id}.screen.route`);
    assert.equal(typeof entry.screen.label, 'string', `${entry.id}.screen.label`);
    assert.ok(['domain', 'pipeline'].includes(entry.activation.kind), `${entry.id}.activation.kind`);
    for (const field of ['package', 'factory', 'import', 'file']) {
      assert.equal(typeof entry.activation[field], 'string', `${entry.id}.activation.${field}`);
    }
    assert.ok(Array.isArray(entry.customize) && entry.customize.length > 0, `${entry.id}.customize is empty`);
  }
  assert.deepEqual([...ids].sort(), ['calendario', 'canali', 'catalogo', 'clienti', 'pipeline', 'sequenze', 'spazi-accessi', 'stato-sync']);
});

test('every catalog screen is a real backoffice voice, never an invented route', () => {
  // The fully composed shell: every native the catalog names must resolve to
  // a voice the backoffice actually renders — including the ones whose static
  // route is null until their composition arrives (pipeline, sequenze).
  const nav = buildShellNav({
    pipelines: [{ name: 'vendite' }],
    customModules: [],
    customerDataAvailable: true,
    sequencesAvailable: true,
  });
  const voices = new Map(nav.filter((item) => typeof item.route === 'string').map((item) => [item.route, item.label]));
  const areas = new Map(SETTINGS_AREAS.map((area) => [area.route, area.label]));
  assert.equal(SHELL_GROUPS.find((group) => group.id === 'native')?.header, 'Moduli nativi');
  assert.equal(SHELL_GROUPS.find((group) => group.id === 'custom')?.header, 'Moduli personalizzati');
  for (const entry of NATIVE_MODULES) {
    if (entry.id === 'pipeline') {
      // The pipeline voice resolves to #/pipelines/<name> once composed.
      assert.ok(entry.screen.route.startsWith('#/pipelines/'), 'pipeline screen stays under #/pipelines/');
      assert.equal(voices.get('#/pipelines/vendite'), entry.screen.label);
      continue;
    }
    const voiceLabel = voices.get(entry.screen.route) ?? areas.get(entry.screen.route);
    if (voiceLabel !== undefined) {
      assert.equal(voiceLabel, entry.screen.label, `${entry.id} screen label does not match the backoffice voice`);
      continue;
    }
    // Otherwise the route must still resolve in the backoffice router — a
    // guided flow like #/connettori has no sidebar voice of its own.
    const parsed = parseModuleRoute(entry.screen.route);
    assert.notEqual(parsed.view, 'invalid', `${entry.id} screen ${entry.screen.route} resolves to no backoffice view`);
    if (entry.id === 'canali') {
      assert.equal(entry.screen.label, PERSONALIZZAZIONE_TAB_LABELS.connettori);
    }
  }
});

test('every activation names a package factory the framework actually ships', async () => {
  for (const entry of NATIVE_MODULES) {
    assert.ok(existsSync(join(repoRoot, entry.activation.file)), `${entry.id}: ${entry.activation.file} missing`);
    if (entry.activation.kind === 'domain') {
      const packageDir = join(repoRoot, 'packages', entry.activation.package);
      assert.ok(existsSync(join(packageDir, 'src', 'index.js')), `${entry.id}: packages/${entry.activation.package}/src/index.js missing`);
      const packageIndex = await import(`../packages/${entry.activation.package}/src/index.js`);
      assert.equal(typeof packageIndex[entry.activation.factory], 'function', `${entry.id}: ${entry.activation.factory} not exported`);
    } else {
      assert.ok(existsSync(join(repoRoot, 'packages', entry.activation.package, 'accordo-sales.js')), `${entry.id}: packages/pipelines/accordo-sales.js missing`);
      const pipelineModule = await import('../packages/pipelines/accordo-sales.js');
      assert.ok(pipelineModule.accordoSalesPipeline != null, 'accordoSalesPipeline missing');
    }
  }
});

test('framework checkout: composed natives read active, the rest do not', () => {
  const report = readNativeModuleStatus({ rootDir: repoRoot });
  assert.equal(report.catalogContract, 1);
  assert.equal(report.nativeModules.length, 8);
  const byId = new Map(report.nativeModules.map((entry) => [entry.id, entry]));
  // The reference composition composes customer-data, space-permissions,
  // channels, sequences and work — and no pipeline.
  for (const id of ['clienti', 'stato-sync', 'spazi-accessi', 'canali', 'sequenze']) {
    assert.equal(byId.get(id).active, true, `${id} should read active on the reference composition`);
  }
  assert.equal(byId.get('pipeline').active, false, 'pipeline should read inactive on an empty registry');
  assert.equal(byId.get('calendario').active, false, 'calendario should read inactive without appointments');
  assert.equal(byId.get('catalogo').active, false, 'catalogo should read inactive without commercial');
});

/** A throwaway project generated by create-accordo, the way an agent would. */
async function generatedProject(t) {
  const { applyProjectBootstrap } = await import('../packages/create-accordo/src/project-bootstrap.js');
  const directory = mkdtempSync(join(tmpdir(), 'accordo-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const applied = applyProjectBootstrap({ directory, name: 'prova-catalogo', cwd: tmpdir(), sourceRoot: repoRoot });
  assert.equal(applied.ok, true, `bootstrap failed: ${JSON.stringify(applied.problems)}`);
  return directory;
}

function catalogJson(projectDir) {
  const stdout = execFileSync('node', [join(repoRoot, 'packages/cli/bin/accordo.js'), 'modules', 'catalog', '--root', projectDir], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

const probeManifest = {
  manifestVersion: 1,
  name: 'sonde',
  description: 'Probe custom bundle: KPI del pilota (etichetta + conteggio).',
  fields: [
    { name: 'label', type: 'string', required: true },
    { name: 'count', type: 'integer' },
  ],
};

test('a generated project lists active natives and a custom bundle as distinct things', async (t) => {
  const projectDir = await generatedProject(t);
  const { applyBundleCreate, planBundleCreate } = await import('../packages/cli/src/bundle-manager.js');

  // The generated AGENTS.md tells the agent to start from the catalog and not
  // to rewrite a native module, with the command to run.
  const generatedAgents = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8');
  assert.match(generatedAgents, /modules catalog/, 'generated AGENTS.md names the catalog command');
  assert.match(generatedAgents, /never to rewrite/i, 'generated AGENTS.md forbids rewriting a native module');

  // Fresh from create-accordo: the kernel only, no native active, no bundle.
  const fresh = catalogJson(projectDir);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.nativeModules.length, 8);
  assert.ok(fresh.nativeModules.every((entry) => entry.active === false), 'a fresh project has no native module active');
  assert.deepEqual(fresh.customModules, []);

  // The agent activates one native (one composition line, no new code) and
  // creates one custom bundle beside the kernel (never under packages/).
  appendFileSync(
    join(projectDir, 'packages/domains/generated/index.js'),
    `\nimport { createSequencesPackage } from '../../sequences/src/index.js';\nexport const generatedSequences = [createSequencesPackage()];\n`,
  );
  applyBundleCreate(planBundleCreate({ manifest: probeManifest, name: 'sonde', version: '0.0.1', createdBy: 'ai', rootDir: projectDir }));

  const report = catalogJson(projectDir);
  const active = report.nativeModules.filter((entry) => entry.active);
  assert.equal(active.length, 1, `exactly one native active, got ${JSON.stringify(active.map((entry) => entry.id))}`);
  assert.equal(active[0].id, 'sequenze');
  assert.equal(report.customModules.length, 1);
  assert.equal(report.customModules[0].kind, 'bundle');
  assert.equal(report.customModules[0].name, 'sonde');
  assert.deepEqual(report.customModules[0].modules, ['sonde']);
  // The two lists never mix: no custom bundle carries a native id.
  const nativeIds = new Set(report.nativeModules.map((entry) => entry.id));
  for (const custom of report.customModules) {
    assert.ok(!nativeIds.has(custom.name), `custom bundle ${custom.name} collides with a native module`);
  }
});
