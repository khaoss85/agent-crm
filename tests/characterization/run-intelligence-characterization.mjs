import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBaseline } from './characterization-contract.mjs';
import { ATTACHMENT, BEHAVIOUR_BEARING_SOURCE, INTELLIGENCE_SOURCE, loadNeutralHelpers } from './intelligence-harness.mjs';
import { runIntelligenceCases, runRestartCases, runScaleCases } from './intelligence-cases.mjs';

/**
 * Run every case and assemble a baseline document.
 *
 * The **same** function produces the checked-in baseline and the fresh run the
 * test compares against it. Two implementations would be two things to keep
 * true, and the one that drifted would be the one nobody noticed.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * What this baseline was generated from.
 *
 * Not a git SHA: a baseline must go stale when the *behaviour-bearing source*
 * changes, and a SHA moves for a typo in a README. These are content digests of
 * the files that decide what Lead Intelligence does, so an intentional
 * pre-extraction behaviour change stales the baseline and forces a deliberate
 * regeneration — which is the review moment the whole mechanism exists to
 * create.
 */
export const SOURCE_FILES = BEHAVIOUR_BEARING_SOURCE;

/** @param {string} [rootDir] */
export function sourceFingerprints(rootDir = repoRoot) {
  const out = {};
  for (const relative of SOURCE_FILES) {
    try {
      out[relative] = createHash('sha256').update(readFileSync(join(rootDir, relative))).digest('hex');
    } catch {
      out[relative] = 'absent';
    }
  }
  return out;
}

/**
 * The two neutral helpers, pinned by behaviour rather than by location.
 *
 * `EXTRACTION_PREPARATION.md` recommends moving `computeDefinitionFingerprint`
 * and `withTimeout` into neutral kernel modules in a separate mechanical PR.
 * "Mechanical" is a claim, and this is what makes it checkable: if the move
 * changes a single fingerprint or a single timeout outcome, these observations
 * change and the baseline goes red.
 *
 * They are imported from where they live **today**; after the move, one import
 * line here changes and every value must stay identical.
 *
 * @param {(entry: any) => void} record
 */
export async function runHelperCases(record) {
  const { observation } = await import('./characterization-contract.mjs');
  // Loaded through the harness, which owns every path that knows where
  // Intelligence lives. Importing them here directly made the "one file changes
  // at extraction" claim false.
  const { computeDefinitionFingerprint, withTimeout } = await loadNeutralHelpers();

  // Fingerprints over shapes chosen to exercise ordering, nesting, types and
  // the empty cases — a hash function's contract is every input, not one.
  const SHAPES = [
    ['empty-object', {}],
    ['empty-array', []],
    ['null', null],
    ['scalar-string', 'a'],
    ['scalar-number', 42],
    ['scalar-boolean', true],
    ['flat', { b: 1, a: 2 }],
    ['key-order-swapped', { a: 2, b: 1 }],
    ['nested', { a: { c: [1, 2, { d: 'e' }] }, b: null }],
    ['array-order', [1, 2, 3]],
    ['array-order-reversed', [3, 2, 1]],
    ['unicode', { 'ключ': 'значение', emoji: 'x' }],
    ['deep', { a: { b: { c: { d: { e: { f: 1 } } } } } }],
  ];
  for (const [label, value] of SHAPES) {
    record(observation({
      id: `helpers.computeDefinitionFingerprint.${label}`,
      category: 'helpers',
      classification: 'compatibility_required',
      surface: 'sdk',
      observed: computeDefinitionFingerprint(value),
      note: 'Pinned so the recommended mechanical move of this helper out of an Intelligence file can be proved to change nothing.',
    }));
  }
  // Key order must not matter, and array order must.
  record(observation({
    id: 'helpers.computeDefinitionFingerprint.canonicality',
    category: 'helpers',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: {
      keyOrderIrrelevant: computeDefinitionFingerprint({ a: 1, b: 2 }) === computeDefinitionFingerprint({ b: 2, a: 1 }),
      arrayOrderSignificant: computeDefinitionFingerprint([1, 2]) !== computeDefinitionFingerprint([2, 1]),
    },
    note: 'The two properties every consumer of a declared-definition fingerprint depends on.',
  }));

  const resolved = await withTimeout(Promise.resolve('value'), 1_000, 'probe').then(
    (value) => ({ outcome: 'resolved', value }), (error) => ({ outcome: 'threw', message: error.message }));
  const rejected = await withTimeout(Promise.reject(new Error('inner failure')), 1_000, 'probe').then(
    () => ({ outcome: 'resolved' }), (error) => ({ outcome: 'threw', message: error.message }));
  const timedOut = await withTimeout(new Promise(() => {}), 20, 'probe').then(
    () => ({ outcome: 'resolved' }), (error) => ({ outcome: 'threw', message: error.message }));
  record(observation({
    id: 'helpers.withTimeout.outcomes',
    category: 'helpers',
    classification: 'compatibility_required',
    surface: 'sdk',
    observed: { resolved, rejected, timedOut },
    note: 'Pinned for the same reason: the move must not change which error a caller sees.',
  }));
}

/**
 * Every consumer of `app.intelligence`, measured from source rather than
 * remembered. Evidence for the decision recorded in
 * `docs/architecture/EXTRACTION_PREPARATION.md`; nothing here implements it.
 *
 * @param {(entry: any) => void} record
 */
export async function runArchitectureEvidence(record, rootDir = repoRoot) {
  const { observation } = await import('./characterization-contract.mjs');
  const grep = (pattern) => {
    try {
      return execFileSync('git', ['grep', '-n', '--', pattern], { cwd: rootDir, encoding: 'utf8' })
        .split('\n').filter(Boolean)
        .map((line) => line.split(':').slice(0, 1)[0])
        .filter((file) => !file.startsWith('tests/') && !file.startsWith('docs/'));
    } catch {
      return [];
    }
  };
  record(observation({
    id: 'architecture.app-intelligence-consumers',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: [...new Set(grep(INTELLIGENCE_SOURCE.greps[0]))].sort(),
    note: 'Blocker 2 evidence: every file that reads the ambient field. Measured, not remembered.',
  }));
  record(observation({
    id: 'architecture.intelligence-internal-importers',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'sdk',
    observed: [...new Set([...grep(INTELLIGENCE_SOURCE.greps[1]), ...grep(INTELLIGENCE_SOURCE.greps[2])])].sort(),
    note: 'Blocker 1 evidence: every file importing an Intelligence internal, which is what disproves "no code reads Intelligence internals".',
  }));
  record(observation({
    id: 'architecture.definition-registry-slot',
    category: 'architecture',
    classification: 'pre_extraction_evidence',
    surface: 'app-inspect',
    observed: [...new Set(grep(INTELLIGENCE_SOURCE.greps[3]))].sort(),
    note: 'Blocker 3 evidence: who depends on the fixed project-owned definition slot.',
  }));
}

/** Run everything and assemble the document. */
export async function generateBaseline(t) {
  /** @type {any[]} */
  const observations = [];
  const record = (entry) => observations.push(entry);

  await runIntelligenceCases(t, record);
  await runRestartCases(t, record);
  await runScaleCases(t, record);
  await runHelperCases(record);
  await runArchitectureEvidence(record);

  return buildBaseline({
    domain: 'lead-intelligence',
    attachment: ATTACHMENT,
    source: sourceFingerprints(),
    observations,
  });
}
