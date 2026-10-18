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

/**
 * Module name → revision the framework adopts as its original migration
 * identity, for modules that reached that revision before any history file
 * existed. The composition renders a module with no checked-in history from
 * its current manifest alone, so a revision above 1 without history silently
 * re-renders every bootstrap databases may have recorded at an earlier
 * revision (accordo 61c450a2a1b1: seven modules reached revision 2 in August
 * 2026 with real SQL changes and no history — delivery-milestone,
 * delivery-project and delivery-work-package in 4a1815c, service-obligation
 * in 9d16f01, commercial-contract, contract-activation and contract-version
 * in 0217469 — while their revision 1 existed only before those commits).
 *
 * No released database is evidenced to hold an earlier bootstrap for these
 * seven: the first LIVE customer database (presti-group) dates from October
 * 2026, and the only evidenced revision-1 recordings in this repository are
 * work-activity's b48b09e checksums and data-quality-issue's presti-group
 * recording, which both ship history files above. So no bridge predecessor
 * is pinned for them: shipping history now would change what every database
 * created since the bump recorded, and inventing bridge checksums no
 * database evidenced would widen the ledger's acceptance for nothing.
 *
 * This excuses exactly the declared revision — the manifest guard
 * (tests/module-manifest-revision-guard.test.js) refuses any revision above
 * it without history, and refuses a history chain that does not start at
 * revision 1 and step by one. The next bump of a listed module ships its
 * full revision-1-based history (git retains every revision 1 manifest), at
 * which point its entry here is removed.
 */
export const MODULE_BORN_AT_REVISION = Object.freeze({
  'commercial-contract': 2,
  'contract-activation': 2,
  'contract-version': 2,
  'service-obligation': 2,
  'delivery-milestone': 2,
  'delivery-project': 2,
  'delivery-work-package': 2,
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
 * The revision-history contract the repo-wide manifest guard enforces
 * (tests/module-manifest-revision-guard.test.js): whoever raises a module's
 * revision ships the previous manifests in `<name>.history.json` and
 * registers the file above — otherwise the guard fails. A revision bump that
 * only updates the guard's RECORDED hashes passes the current-SQL check
 * while old databases still fail with MODULE_MIGRATION_CHECKSUM_MISMATCH
 * (the b8266ea recurrence the guard was built to prevent), so the history
 * itself is required, never just matching current SQL.
 *
 * Throws a ValidationError naming the missing history or the malformed
 * chain; returns undefined when the revision is covered. Revision 1 needs
 * nothing. A module declared born above 1 in MODULE_BORN_AT_REVISION is
 * covered exactly at its declared revision; anything above it needs the
 * full history from revision 1.
 *
 * @param {string} moduleName
 * @param {number} revision
 */
export function assertRevisionHistoryContract(moduleName, revision) {
  if (revision <= 1) return;
  const history = recordModuleHistoryFor(moduleName);
  if (history !== undefined) {
    if (history.length !== revision - 1) {
      throw new ValidationError(
        `Selected record module "${moduleName}" is at revision ${revision} but ships ${history.length} revision(s) of history; `
          + `expected ${revision - 1}. Ship the previous manifest in ${moduleName}.history.json and register it in `
          + 'packages/core/src/record-module-history.js.',
      );
    }
    for (let index = 0; index < history.length; index += 1) {
      const entry = history[index];
      const entryRevision = (entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        && typeof /** @type {Record<string, unknown>} */ (entry).revision === 'number')
        ? /** @type {Record<string, unknown>} */ (entry).revision
        : 1;
      if (entryRevision !== index + 1) {
        throw new ValidationError(
          `Selected record module "${moduleName}" history must start at revision 1 and step by one; `
            + `entry ${index} is at revision ${String(entryRevision)}.`,
        );
      }
    }
    return;
  }
  const bornAt = /** @type {Record<string, number>} */ (MODULE_BORN_AT_REVISION)[moduleName] ?? 1;
  if (bornAt !== revision) {
    throw new ValidationError(
      `Selected record module "${moduleName}" is at revision ${revision} without history. `
        + `Ship the previous manifest in ${moduleName}.history.json, register it in `
        + 'packages/core/src/record-module-history.js, and update RECORDED in '
        + 'tests/module-manifest-revision-guard.test.js in the same PR.',
    );
  }
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
