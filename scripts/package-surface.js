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
 * Rules the check enforces, per package:
 * - fingerprint changed, version unchanged → fail with
 *   "aumenta la versione di <pacchetto>" (the #662 shape: bump the version
 *   in the package source, never adopt the new surface under the old one);
 * - version changed, fingerprint unchanged, or both changed → fail until the
 *   baseline is regenerated IN THE SAME COMMIT (`npm run surface:baseline`),
 *   so the diff that changed the surface and the new pins travel together
 *   and a reviewer sees both.
 */

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeDefinitionFingerprint } from '../packages/core/src/definition-fingerprint.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export const BASELINE_PATH = join(root, 'tests', 'package-surface-baseline.json');

/**
 * Every composed domain package: the directory under `packages/` and the
 * no-argument factory that builds its default (v1) definition. The v2
 * contract graphs derive from the same declaration, so one fingerprint
 * covers both.
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
 * The live `{ name, version, fingerprint }` triple of every package.
 * @returns {Promise<{ name: string, dir: string, version: number, fingerprint: string }[]>}
 */
export async function liveSurfaces() {
  const out = [];
  for (const { dir, factory } of PACKAGES) {
    const moduleUrl = pathToFileURL(join(root, 'packages', dir, 'src', 'index.js')).href;
    const mod = await import(moduleUrl);
    if (typeof mod[factory] !== 'function') {
      throw new Error(`package-surface: ${dir}/src/index.js no longer exports ${factory} — update scripts/package-surface.js`);
    }
    const definition = mod[factory]();
    out.push({
      name: definition.name,
      dir,
      version: definition.version,
      fingerprint: computeDefinitionFingerprint(surfaceOf(definition)),
    });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Directories under `packages/` whose `src/index.js` declares a package. */
export function declaredPackageDirs() {
  return readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      try {
        return readFileSync(join(root, 'packages', name, 'src', 'index.js'), 'utf8').includes('definePackage(');
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * Compare a checked-in baseline against the live triples.
 * @param {{ packages?: { name: string, version: number, fingerprint: string }[] }} baseline
 * @param {{ name: string, dir: string, version: number, fingerprint: string }[]} live
 * @returns {{ ok: boolean, problems: { package: string, code: string, message: string }[] }}
 */
export function compareSurfaces(baseline, live) {
  const problems = [];
  const pinned = new Map((baseline.packages ?? []).map((entry) => [entry.name, entry]));
  for (const current of live) {
    const pin = pinned.get(current.name);
    if (!pin) {
      problems.push({
        package: current.name,
        code: 'BASELINE_MISSING',
        message: `${current.name}: la baseline non conosce questo pacchetto. `
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
        code: 'VERSION_BUMP_REQUIRED',
        message: `aumenta la versione di ${current.name}: la superficie è cambiata `
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
      code: 'BASELINE_STALE',
      message: `${current.name}: ${what}. La baseline è ferma a version ${pin.version} `
        + `(impronta ${String(pin.fingerprint).slice(0, 12)}). Rigenera la baseline con `
        + '`npm run surface:baseline` nello stesso commit, così la diff che cambia la superficie '
        + 'e i nuovi pin viaggiano insieme.',
    });
  }
  for (const pin of pinned.values()) {
    if (!live.some((current) => current.name === pin.name)) {
      problems.push({
        package: pin.name,
        code: 'BASELINE_STALE',
        message: `${pin.name}: il pacchetto non esiste più ma la baseline lo cita ancora. `
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
      contract: 1,
      packages: live.map(({ name, dir, version, fingerprint }) => ({ name, dir, version, fingerprint })),
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
    for (const dir of declaredPackageDirs()) {
      if (!listed.has(dir)) {
        process.stderr.write(`package-surface: packages/${dir} dichiara un pacchetto ma non è in PACKAGES — aggiungilo in scripts/package-surface.js\n`);
        process.exitCode = 1;
      }
    }
    const { ok, problems } = compareSurfaces(baseline, live);
    if (!ok) {
      for (const problem of problems) process.stderr.write(`package-surface: ${problem.message}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`package surfaces match the baseline (${live.length} packages).\n`);
    }
  }
}
