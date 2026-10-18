// @ts-check

/**
 * Framework-internal revision history for manifest-selected record modules.
 *
 * A module composed by manifest selection (`{name, manifest}` in an async-v2
 * selected graph) has no `module.state.json`, so when its manifest is revised
 * the original migration must still render byte-identical — otherwise every
 * database the previous revision migrated fails with
 * `MODULE_MIGRATION_CHECKSUM_MISMATCH`. The history travels with the
 * framework: a `<name>.history.json` file checked in beside the manifest,
 * read here, in the one place that renders a module's migrations
 * (`record-module-runtime.js`). No composer has to remember anything: an
 * entry built from `*.module.json` alone — `startPortablePostgresqlApp`,
 * `createAccordoAppAsync`, the pilot writer composition — composes the
 * original migration plus one additive `pg_evolve_<table>_r<N>` per later
 * revision.
 *
 * A caller-supplied `previousManifests` is never trusted for rendering: when
 * the framework ships checked-in history for the module it must match it
 * exactly, otherwise the composition refuses. Passing history for a module
 * with no checked-in history refuses too — ship the history file and register
 * it below instead.
 *
 * When a revision ships a new `<name>.history.json`, register it in
 * `MODULE_HISTORY_FILES` in the same PR. Fail-closed throughout: a registered
 * file that is missing or unreadable refuses loudly, never composes without
 * the history.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from './errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Module name → checked-in `<name>.history.json`, paths resolved from this
 * file so every checkout of the framework reads its own history.
 */
const MODULE_HISTORY_FILES = Object.freeze({
  'work-activity': join(HERE, '../../work/modules/work-activity.history.json'),
  'data-quality-issue': join(HERE, '../../customer-data/modules/data-quality-issue.history.json'),
  'calendar-sync-state': join(HERE, '../../calendar-sync/modules/calendar-sync-state.history.json'),
});

/** @type {Map<string, unknown[]>} */
const historyCache = new Map();

/**
 * The checked-in file for a registered module, or `undefined` when the
 * module ships no history. Refuses loudly when a registered file is missing
 * or unreadable: the registry claims history exists, so composing without it
 * would re-render an applied migration.
 *
 * @param {string} moduleName
 * @returns {string | undefined}
 */
export function recordModuleHistoryPath(moduleName) {
  const historyPath = /** @type {Record<string, string>} */ (MODULE_HISTORY_FILES)[moduleName];
  if (historyPath === undefined) return undefined;
  if (!existsSync(historyPath)) {
    throw new ValidationError(
      `Selected record module "${moduleName}" is registered with checked-in history at ${historyPath}, `
+      'but the file is missing. Restore it from version control: composing without it would re-render an applied migration.',
    );
  }
  return historyPath;
}

/**
 * @param {string} moduleName
 * @param {string} historyPath
 * @returns {unknown[]}
 */
function readHistoryFile(moduleName, historyPath) {
  let sidecar;
  try {
    sidecar = JSON.parse(readFileSync(historyPath, 'utf8'));
  } catch (error) {
    throw new ValidationError(
      `Selected record module "${moduleName}" ships ${historyPath}, which cannot be read as its revision history `
        + `(${error instanceof Error ? error.message : String(error)}). Fix or remove the sidecar and its registry entry: `
        + 'composing without it would re-render an applied migration.',
    );
  }
  if (sidecar === null || typeof sidecar !== 'object' || Array.isArray(sidecar)) {
    throw new ValidationError(
      `Selected record module "${moduleName}" history must be a JSON object: ${historyPath}`,
    );
  }
  if (sidecar.module !== undefined && sidecar.module !== moduleName) {
    throw new ValidationError(
      `Selected record module history ${historyPath} is for "${String(sidecar.module).slice(0, 64)}", not "${moduleName}"`,
    );
  }
  if (!Array.isArray(sidecar.previousManifests)) {
    throw new ValidationError(
      `Selected record module "${moduleName}" history must carry previousManifests as an array: ${historyPath}`,
    );
  }
  return Object.freeze([...sidecar.previousManifests]);
}

/**
 * The checked-in revision history for a module — the exact manifests previous
 * revisions shipped, oldest first — or `undefined` when the module ships no
 * history. Frozen: callers must not mutate what every composition shares.
 *
 * @param {string} moduleName
 * @returns {unknown[] | undefined}
 */
export function recordModuleHistoryFor(moduleName) {
  if (!historyCache.has(moduleName)) {
    const historyPath = recordModuleHistoryPath(moduleName);
    historyCache.set(moduleName, historyPath === undefined ? undefined : readHistoryFile(moduleName, historyPath));
  }
  return historyCache.get(moduleName);
}

/**
 * Canonical JSON: object keys sorted recursively, so two manifests that say
 * the same thing compare equal whatever key order they were written in.
 * Exported for the migration renderer, which resolves history relative to
 * the entry's own revision.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {Record<string, unknown>} */ (value)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A caller-supplied `previousManifests` must be exactly the checked-in
 * history — it is an assertion, never the source of the rendered migrations.
 * Refuses when the module ships no checked-in history (ship the file and
 * register it instead of hand-building the chain) and when the supplied chain
 * differs from it (a stale or forged chain would render the wrong original
 * migration).
 *
 * @param {string} moduleName
 * @param {unknown} callerPrevious
 */
export function assertCallerHistoryMatchesRegistry(moduleName, callerPrevious) {
  const registered = recordModuleHistoryFor(moduleName);
  if (registered === undefined) {
    throw new ValidationError(
      `Selected record module "${moduleName}" carries previousManifests but ships no checked-in ${moduleName}.history.json. `
        + 'Revision history travels with the framework: add the history file beside the manifest and register it in '
        + 'packages/core/src/record-module-history.js, then omit previousManifests.',
    );
  }
  if (canonicalJson(callerPrevious) !== canonicalJson(registered)) {
    const historyPath = recordModuleHistoryPath(moduleName);
    throw new ValidationError(
      `Selected record module "${moduleName}": previousManifests does not match the checked-in revision history `
        + `(${historyPath}). The framework always composes the checked-in history; omit previousManifests, or pass `
        + 'exactly the checked-in history.',
    );
  }
}
