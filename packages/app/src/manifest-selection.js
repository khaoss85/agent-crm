// @ts-check

/**
 * Manifest-selected record modules, loaded from disk with their history.
 *
 * A module composed by manifest selection (`{name, manifest}` in an async-v2
 * selected graph) has no `module.state.json`, so a revised module's history
 * travels in a `<name>.history.json` sidecar next to its `<name>.module.json`
 * (see `docs/MODULE_EVOLUTION.md`). This loader is the production path that
 * attaches it: every composer that builds a selected graph from checked-in
 * manifests — `startPortablePostgresqlApp`, the worker writer composition —
 * loads its entries here instead of reading `*.module.json` alone, so a
 * database an older framework revision migrated keeps composing instead of
 * failing with `MODULE_MIGRATION_CHECKSUM_MISMATCH`.
 *
 * Fail-closed throughout: a manifest that will not parse, a manifest with no
 * name, and a present-but-unreadable sidecar all refuse loudly. A module
 * silently dropped is the defect this seam closes, so a sidecar is never
 * silently ignored — only its absence means "no history", the behavior every
 * module without history relies on, unchanged.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationError } from '../../core/src/errors.js';

function readManifest(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new ValidationError(
      `Module manifest cannot be read as JSON: ${manifestPath} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new ValidationError(`Module manifest must be a JSON object: ${manifestPath}`);
  }
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new ValidationError(`Module manifest carries no name: ${manifestPath}`);
  }
  return manifest;
}

/**
 * The revision history for one manifest-selected module, or `undefined` when
 * the module ships no sidecar. A sidecar that exists but cannot be read as
 * the history refuses loudly rather than composing without it.
 *
 * @param {string} modulesDir
 * @param {string} name
 * @returns {unknown[] | undefined}
 */
function readHistorySidecar(modulesDir, name) {
  const historyPath = join(modulesDir, `${name}.history.json`);
  if (!existsSync(historyPath)) return undefined;
  let sidecar;
  try {
    sidecar = JSON.parse(readFileSync(historyPath, 'utf8'));
  } catch (error) {
    throw new ValidationError(
      `Module "${name}" ships ${historyPath}, which cannot be read as its revision history `
        + `(${error instanceof Error ? error.message : String(error)}). Fix or remove the sidecar: composing without it would re-render an applied migration.`,
    );
  }
  if (sidecar === null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    throw new ValidationError(`Module "${name}" history must be a JSON object: ${historyPath}`);
  }
  if (sidecar.module !== undefined && sidecar.module !== name) {
    throw new ValidationError(
      `Module history ${historyPath} is for "${String(sidecar.module).slice(0, 64)}", not "${name}"`,
    );
  }
  if (!Array.isArray(sidecar.previousManifests)) {
    throw new ValidationError(`Module history ${historyPath} must carry previousManifests as an array`);
  }
  return [...sidecar.previousManifests];
}

/**
 * Every `*.module.json` in a package `modules` directory as selected-graph
 * entries, each carrying its sidecar history when one is checked in beside
 * it. Sorted by module name: filesystem order is not a contract, so every
 * boot composes the same sequence on every machine.
 *
 * @param {string} modulesDir the `modules` directory of one framework package
 * @returns {Array<{name: string, manifest: unknown, previousManifests?: unknown[]}>}
 */
export function loadManifestSelectedEntries(modulesDir) {
  let files;
  try {
    files = readdirSync(modulesDir);
  } catch (error) {
    throw new ValidationError(
      `Manifest-selected modules directory cannot be listed: ${modulesDir} (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  const entries = [];
  for (const file of files.filter((name) => name.endsWith('.module.json')).sort()) {
    const manifest = readManifest(join(modulesDir, file));
    const previousManifests = readHistorySidecar(modulesDir, manifest.name);
    entries.push({
      name: manifest.name,
      manifest,
      ...(previousManifests === undefined ? {} : { previousManifests }),
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries;
}
