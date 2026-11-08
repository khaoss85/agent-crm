#!/usr/bin/env node
// @ts-check

/**
 * Package surface baselines (backlog:61355d3ed19b).
 *
 * Why this exists: twice in the night of 2026-11-07/08 a merged PR changed a
 * package's declared surface without bumping its version (agent-crm#662
 * interactions, agent-crm#668 customer-data). The pilot pins every composed
 * surface's fingerprint, turned red, and needed repair PRs (#665, #674). The
 * fast gate is in `requiredChecks`, so this check refuses such a merge on its
 * own, on the PR, instead of on main the next night.
 *
 * What "surface" means here: everything a consuming composition can observe
 * about a package except its identity — the package contract, the claimed
 * resources, the required capabilities, the declared capabilities, actions
 * and operations (names, versions, contracts, descriptions, input shapes and
 * handler source), the versioned policies, and the machine-readable
 * `metadata()` contract admin renders from. Deliberately excluded: `name` and
 * `version` (the identity the fingerprint is compared against), `label` and
 * `description` (human prose — fixing a typo must not force a version bump),
 * and runtime helpers some definitions carry (`registries`,
 * `persistFingerprints`), which never reach a composition.
 *
 * Both contract graphs are pinned (giro 2, review P1 on #675): most packages
 * select an awaited twin when built with `{ packageContract: 2 }`
 * (`selectPackageGraph` stamps seams and handler sources, so one V1 digest
 * can never cover both graphs — sequences and space-permissions prove it:
 * they honour the option with no `*V2` export at all). A V2-only change must
 * demand a version bump exactly like a V1 one. The only single-pinned package
 * is magic-link: its factory refuses unknown options, so it has no contract-2
 * graph; the day a twin lands, its new pin appears as BASELINE_MISSING red
 * until the baseline is refreshed.
 *
 * The fingerprint is `computeDefinitionFingerprint` from
 * `packages/core/src/definition-fingerprint.js` — the same function the
 * pilot uses to pin surfaces — so a fingerprint computed here and one
 * computed there agree byte for byte on the same surface.
 *
 * Two commands, deliberately separate (like the commercial characterization
 * baseline): comparing is the gate, refreshing is the deliberate act.
 *
 *   node scripts/package-surface.js --check    # exit 0 when live == baseline
 *   node scripts/package-surface.js --refresh  # rewrite the baseline file
 *   npm run surface:baseline                    # same refresh, npm spelling
 *
 * Rules the check enforces, per package and graph:
 * - fingerprint changed, version unchanged → fail with
 *   "aumenta la versione di <pacchetto>" (the #662 shape: bump the version
 *   in the package source, never adopt the new surface under the old one);
 * - version changed, fingerprint unchanged, or both changed → fail until the
 *   baseline is regenerated IN THE SAME COMMIT (`npm run surface:baseline`),
 *   so the diff that changed the surface and the new pins travel together
 *   and a reviewer sees both.
 *
 * New-package detection is fail-closed (giro 2, review P2 on #675): the gate
 * probes every `packages/*` module at runtime — it imports each index and
 * calls the factory-shaped exports, flagging anything that returns a package
 * definition (or throws, since a throw cannot prove non-package) — instead of
 * grepping for a `definePackage(` substring that a re-export layout dodges.
 * The test (`tests/package-surface-version.test.js`) uses an independent
 * method (its own source-text scan of the whole `src/` tree) and asserts both
 * methods agree: one heuristic can never silently blind the pair, because a
 * disagreement is itself red.
 */

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeDefinitionFingerprint } from '../packages/core/src/definition-fingerprint.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export const BASELINE_PATH = join(root, 'tests', 'package-surface-baseline.json');

/** Baseline file format version: 2 pins `{ name, dir, graph, version, fingerprint }` per package. */
export const BASELINE_CONTRACT = 2;

/**
 * Every composed domain package: the directory under `packages/` and the
 * no-argument factory that builds its default (contract-1) definition. The
 * contract-2 graph is the same factory called with `{ packageContract: 2 }`
 * (or, when the factory refuses that option, its `*V2` twin export) — each
 * graph gets its own pin, because stamping alone already diverges them.
 */
export const PACKAGES = Object.freeze([
  { dir: 'agents', factory: 'createAgentsPackage' },
  { dir: 'appointments', factory: 'createAppointmentsPackage' },
  { dir: 'calendar-sync', factory: 'createCalendarSyncPackage' },
  { dir: 'channels', factory: 'createChannelsPackage' },
  { dir: 'commercial', factory: 'createCommercialDomain' },
  { dir: 'contracts', factory: 'createContractsDomain' },
  { dir: 'customer-data', factory: 'createCustomerDataPackage' },
  { dir: 'customer-hub', factory: 'createCustomerHubPackage' },
  { dir: 'delivery', factory: 'createDeliveryPackage' },
  { dir: 'intelligence', factory: 'createIntelligenceDomain' },
  { dir: 'interactions', factory: 'createInteractionsPackage' },
  { dir: 'lifecycle', factory: 'createLifecyclePackage' },
  { dir: 'llm', factory: 'createLlmPackage' },
  { dir: 'magic-link', factory: 'createMagicLinkPackage' },
  { dir: 'marketing', factory: 'createMarketingDomain' },
  { dir: 'payments', factory: 'createPaymentsPackage' },
  { dir: 'reengagement', factory: 'createReengagementPackage' },
  { dir: 'sequences', factory: 'createSequencesPackage' },
  { dir: 'service', factory: 'createServicePackage' },
  { dir: 'signature', factory: 'createSignatureDomain' },
  { dir: 'site-forms', factory: 'createSiteFormsPackage' },
  { dir: 'space-permissions', factory: 'createSpacePermissionsDomain' },
  { dir: 'work', factory: 'createWorkPackage' },
]);

/**
 * The declared surface of one package definition: identity and prose out,
 * everything a composition can observe in.
 * @param {any} definition the value a `create*` factory returns
 */
export function surfaceOf(definition) {
  return {
    packageContract: definition.packageContract,
    resources: definition.resources ?? [],
    requires: definition.requires ?? [],
    capabilities: definition.capabilities ?? [],
    actions: definition.actions ?? [],
    operations: definition.operations ?? [],
    policies: definition.policies ?? [],
    metadata: typeof definition.metadata === 'function' ? definition.metadata() : null,
  };
}

/**
 * True when a value already looks like a package definition: the same three
 * fields the gate pins, checked without calling anything.
 * @param {any} value
 */
export function isPackageDefinition(value) {
  return !!value && typeof value === 'object'
    && typeof value.packageContract === 'number'
    && typeof value.name === 'string'
    && typeof value.version === 'number';
}

/** Export names this probe is willing to call with no arguments. */
const FACTORY_CALL_RE = /^create[A-Z][A-Za-z0-9]*(Package|Domain)(V2)?$/;

/** Twin-export names pinned beside the option-selected contract-2 graph. */
const TWIN_EXPORT_RE = /^create\w+V2$/;

/**
 * Probe every `packages/*` module at runtime for package-ness (fail-closed):
 * import the index, call the factory-shaped exports with no arguments, and
 * flag whatever returns a package definition. A factory that throws is
 * flagged too — a throw cannot prove the directory holds no package. Plain
 * object exports are shape-checked without calling (no side effects either
 * way; factories are pure definition builders).
 * @returns {Promise<{ dir: string, reasons: string[] }[]>}
 */
export async function probePackageDirs() {
  const found = new Map();
  const flag = (dir, reason) => {
    if (!found.has(dir)) found.set(dir, []);
    found.get(dir).push(reason);
  };
  for (const entry of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = entry.name;
    const indexPath = join(root, 'packages', dir, 'src', 'index.js');
    try {
      readFileSync(indexPath, 'utf8');
    } catch {
      continue;
    }
    let mod;
    try {
      mod = await import(pathToFileURL(indexPath).href);
    } catch (error) {
      flag(dir, `src/index.js does not import (${String(error && error.message || error).slice(0, 120)}): cannot prove it holds no package`);
      continue;
    }
    for (const [key, value] of Object.entries(mod)) {
      if (value !== null && typeof value === 'object') {
        if (isPackageDefinition(value)) flag(dir, `export ${key} already is a package definition`);
        continue;
      }
      if (typeof value !== 'function' || !FACTORY_CALL_RE.test(key)) continue;
      try {
        const definition = value();
        if (isPackageDefinition(definition)) flag(dir, `factory ${key}() returned a package definition`);
      } catch (error) {
        flag(dir, `factory ${key}() threw (${String(error && error.message || error).slice(0, 120)}): cannot prove ${dir} holds no package`);
      }
    }
  }
  return [...found.entries()]
    .map(([dir, reasons]) => ({ dir, reasons }))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

/**
 * Directories under `packages/` that declare a package, by runtime probe.
 * Async because probing imports every package index (side-effect free:
 * factory calls are pure definition builders).
 * @returns {Promise<string[]>}
 */
export async function declaredPackageDirs() {
  return (await probePackageDirs()).map((entry) => entry.dir);
}

/**
 * The live `{ name, dir, graph, version, fingerprint }` pins of every
 * package: one pin per contract graph. The contract-2 graph is the factory
 * called with `{ packageContract: 2 }`; when the factory refuses that option
 * (unknown-option validation, e.g. magic-link) the `*V2` twin export is used
 * instead, and when neither exists the package is single-pinned — a twin
 * landing later appears as a new pin, red until the baseline is refreshed.
 * @returns {Promise<{ name: string, dir: string, graph: string, version: number, fingerprint: string }[]>}
 */
export async function liveSurfaces() {
  const out = [];
  const pinned = (name, fingerprint) => out.some((pin) => pin.name === name && pin.fingerprint === fingerprint);
  for (const { dir, factory } of PACKAGES) {
    const moduleUrl = pathToFileURL(join(root, 'packages', dir, 'src', 'index.js')).href;
    const mod = await import(moduleUrl);
    if (typeof mod[factory] !== 'function') {
      throw new Error(`package-surface: ${dir}/src/index.js no longer exports ${factory} — update scripts/package-surface.js`);
    }
    const contract1 = mod[factory]();
    // Both graphs are always pinned, even when their fingerprints coincide
    // today: a twin honouring the option tomorrow must move the contract2
    // pin, never slip under it.
    out.push({
      name: contract1.name,
      dir,
      graph: 'contract1',
      version: contract1.version,
      fingerprint: computeDefinitionFingerprint(surfaceOf(contract1)),
    });
    const twinNames = Object.keys(mod)
      .filter((key) => TWIN_EXPORT_RE.test(key) && typeof mod[key] === 'function')
      .sort();
    let contract2 = null;
    try {
      contract2 = mod[factory]({ packageContract: 2 });
    } catch (error) {
      const refusedOption = /unknown .* option/is.test(String(error && error.message || error));
      if (!refusedOption) throw error;
      // The factory refuses the contract-2 option: without a twin export the
      // package has no contract-2 graph (magic-link) and stays single-pinned.
      if (twinNames.length > 0) contract2 = mod[twinNames[0]]();
    }
    if (contract2) {
      out.push({
        name: contract2.name,
        dir,
        graph: 'contract2',
        version: contract2.version,
        fingerprint: computeDefinitionFingerprint(surfaceOf(contract2)),
      });
    }
    for (const twinName of twinNames) {
      const twin = mod[twinName]();
      const fingerprint = computeDefinitionFingerprint(surfaceOf(twin));
      if (pinned(twin.name, fingerprint)) continue;
      out.push({
        name: twin.name,
        dir,
        graph: `contract2:${twinName}`,
        version: twin.version,
        fingerprint,
      });
    }
  }
  return out.sort((a, b) => (
    a.name < b.name ? -1 : a.name > b.name ? 1
    : a.graph < b.graph ? -1 : a.graph > b.graph ? 1 : 0
  ));
}

/**
 * Compare a checked-in baseline against the live pins, per package and graph.
 * Old baseline entries without `graph` read as contract1, so the previous
 * format fails forward into a refresh instead of a crash.
 * @param {{ packages?: { name: string, graph?: string, version: number, fingerprint: string }[] }} baseline
 * @param {{ name: string, dir: string, graph: string, version: number, fingerprint: string }[]} live
 * @returns {{ ok: boolean, problems: { package: string, graph: string, code: string, message: string }[] }}
 */
export function compareSurfaces(baseline, live) {
  const normalized = (entry) => `${entry.name}${entry.graph && entry.graph !== 'contract1' ? `:${entry.graph}` : ''}`;
  const where = (entry) => (entry.graph && entry.graph !== 'contract1' ? ` (grafo ${entry.graph})` : '');
  const problems = [];
  const pinned = new Map((baseline.packages ?? []).map((entry) => [normalized(entry), entry]));
  for (const current of live) {
    const pin = pinned.get(normalized(current));
    if (!pin) {
      problems.push({
        package: current.name,
        graph: current.graph,
        code: 'BASELINE_MISSING',
        message: `${current.name}${where(current)}: la baseline non conosce questo pacchetto o questo grafo. `
          + 'Rigenera la baseline con `npm run surface:baseline` nello stesso commit.',
      });
      continue;
    }
    const fingerprintMoved = pin.fingerprint !== current.fingerprint;
    const versionMoved = pin.version !== current.version;
    if (!fingerprintMoved && !versionMoved) continue;
    if (fingerprintMoved && !versionMoved) {
      problems.push({
        package: current.name,
        graph: current.graph,
        code: 'VERSION_BUMP_REQUIRED',
        message: `aumenta la versione di ${current.name}${where(current)}: la superficie è cambiata `
          + `(impronta ${String(pin.fingerprint).slice(0, 12)} → ${current.fingerprint.slice(0, 12)}) `
          + `ma la versione è ancora ${current.version}. Alza version in packages/${current.dir}/src/index.js, `
          + 'poi rigenera la baseline con `npm run surface:baseline` nello stesso commit. '
          + 'Se la superficie non doveva cambiare, annulla il cambio invece di alzare la versione.',
      });
      continue;
    }
    const what = !versionMoved
      ? 'la versione è ferma'
      : !fingerprintMoved
        ? `la versione è passata da ${pin.version} a ${current.version} con la superficie identica`
        : `la superficie è cambiata e la versione è passata da ${pin.version} a ${current.version}`;
    problems.push({
      package: current.name,
      graph: current.graph,
      code: 'BASELINE_STALE',
      message: `${current.name}${where(current)}: ${what}. La baseline è ferma a version ${pin.version} `
        + `(impronta ${String(pin.fingerprint).slice(0, 12)}). Rigenera la baseline con `
        + '`npm run surface:baseline` nello stesso commit, così la diff che cambia la superficie '
        + 'e i nuovi pin viaggiano insieme.',
    });
  }
  for (const pin of pinned.values()) {
    if (!live.some((current) => normalized(current) === normalized(pin))) {
      problems.push({
        package: pin.name,
        graph: pin.graph ?? 'contract1',
        code: 'BASELINE_STALE',
        message: `${pin.name}${where(pin)}: il pacchetto o il grafo non esiste più ma la baseline lo cita ancora. `
          + 'Rigenera la baseline con `npm run surface:baseline` nello stesso commit.',
      });
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Read the checked-in baseline file. */
export function readBaseline() {
  let raw;
  try {
    raw = readFileSync(BASELINE_PATH, 'utf8');
  } catch {
    throw new Error(`package-surface: ${BASELINE_PATH} is missing — run \`npm run surface:baseline\` to create it`);
  }
  return JSON.parse(raw);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.includes('--refresh')) {
    const live = await liveSurfaces();
    const baseline = {
      contract: BASELINE_CONTRACT,
      packages: live.map(({ name, dir, graph, version, fingerprint }) => ({ name, dir, graph, version, fingerprint })),
    };
    const staging = `${BASELINE_PATH}.writing`;
    writeFileSync(staging, `${JSON.stringify(baseline, null, 2)}\n`);
    renameSync(staging, BASELINE_PATH);
    process.stdout.write(`Wrote ${live.length} package surface pins to tests/package-surface-baseline.json\n`
      + 'Review the diff: a moved fingerprint is a behaviour-bearing surface change — decide you meant it before committing.\n');
  } else {
    const baseline = readBaseline();
    const live = await liveSurfaces();
    const listed = new Set(PACKAGES.map((entry) => entry.dir));
    for (const { dir, reasons } of await probePackageDirs()) {
      if (!listed.has(dir)) {
        process.stderr.write(`package-surface: packages/${dir} dichiara un pacchetto ma non è in PACKAGES — aggiungilo in scripts/package-surface.js (${reasons.join('; ')})\n`);
        process.exitCode = 1;
      }
    }
    const { ok, problems } = compareSurfaces(baseline, live);
    if (!ok) {
      for (const problem of problems) process.stderr.write(`package-surface: ${problem.message}\n`);
      process.exitCode = 1;
    } else {
      const packageCount = new Set(live.map((entry) => entry.dir)).size;
      process.stdout.write(`package surfaces match the baseline (${live.length} pins across ${packageCount} packages).\n`);
    }
  }
}
