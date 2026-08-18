// @ts-check

/**
 * The freeze: what must not move between the protocol fingerprint and the last cell.
 *
 * ## Why this module exists separately
 *
 * Everything the protocol froze first — prompts, corpora, profiles, fixtures — is *input*
 * to the instrument. None of it is the instrument. Frozen that way, the parser could
 * change between cell 3 and cell 4 and every receipt would still verify against a
 * fingerprint that never noticed: a guarantee written over the part that was easy to
 * hash. So `instrumentFingerprint` covers the modules that **decide outcomes**, and
 * `protocolFingerprint` carries it.
 *
 * ## The circularity, decided deliberately rather than left implicit
 *
 * The fingerprint function cannot hash itself without circularity, and hashing it from
 * outside would be arbitrary. **This file is excluded from `instrumentFingerprint`, and
 * is named as excluded** in `EXCLUDED_FROM_INSTRUMENT` with the reason. A silent
 * exclusion would be the defect; a declared one is a boundary a reviewer can argue with.
 *
 * That exclusion is why the fingerprint lives here rather than in `contract.js`:
 * `contract.js` decides whether a receipt is valid, which is an outcome, so it must be
 * *inside* the digest set. Keeping both in one module would have forced a choice between
 * excluding the validator or hashing the hasher.
 *
 * ## Granularity, and why over-staleness is the right side to err on
 *
 * Components are hashed whole, so editing a comment stales the protocol. That is
 * accepted: over-staleness costs a re-run, under-staleness costs a silently wrong
 * measurement, and the trade only runs one way. To keep it workable the staleness is
 * **attributed** — `assertProtocolCurrent` names which components moved, so an operator
 * can tell a comment edit from a scoring change and re-run the affected cells rather
 * than the panel. "The protocol is stale" with no attribution is a message the next
 * person works around.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson } from './contract.js';

/**
 * The modules that decide outcomes. The key is the decision the component makes, because
 * that is what a reader needs when the runner refuses — not a filename.
 */
export const INSTRUMENT_COMPONENTS = Object.freeze({
  'transcript-parser': 'benchmarks/tool-selection/harness.js',
  'outcome-classifier': 'benchmarks/tool-selection/harness.js',
  'permission-event-interpretation': 'benchmarks/tool-selection/harness.js',
  'claude-code-adapter': 'benchmarks/tool-selection/harness.js',
  'mutation-classifier': 'benchmarks/tool-selection/surface.js',
  'leak-scan': 'benchmarks/tool-selection/prompt-matrix.js',
  'scoring': 'benchmarks/tool-selection/score.js',
  'scoreability-derivation': 'benchmarks/tool-selection/score.js',
  'run-contract': 'benchmarks/tool-selection/contract.js',
  'fixture-builder': 'benchmarks/tool-selection/fixtures.js',
  // The runner decides which cell is scored at all, canonicalises the observed action
  // text before anything classifies it, and is what turns a fixture pair into the
  // `mutated` flag. It was outside the digest set while `outcome-classifier` was listed
  // as `harness.js` and the outcome `if`/`else` chain actually lived here — a fingerprint
  // that named a decision it did not cover. The chain has moved into `harness.js`, and
  // this entry closes the rest of the gap.
  'run-orchestration': 'benchmarks/tool-selection/run.js',
});

/**
 * Declared, not silent. This module computes the fingerprint, so including it would be
 * circular; excluding it without saying so would be the same defect one level up.
 */
export const EXCLUDED_FROM_INSTRUMENT = Object.freeze([
  {
    path: 'benchmarks/tool-selection/freeze.js',
    reason: 'computes the fingerprint; hashing the hasher is circular, and hashing it from '
      + 'outside would be arbitrary. It decides no outcome — it only compares digests — so '
      + 'a change here cannot move a cell result without also moving one of the components above.',
  },
]);

/** @param {string} text */
function digest(text) {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Digest every component, by decision name. One file backing several decisions yields the
 * same digest under each name, which is honest: the decisions are not separable today,
 * and pretending otherwise would let a reader think a scoring change had been isolated
 * from a parser change when both live in one module.
 *
 * @param {string} repoRoot
 * @returns {Record<string, string>}
 */
export function componentDigests(repoRoot) {
  /** @type {Record<string, string>} */
  const digests = {};
  for (const [component, path] of Object.entries(INSTRUMENT_COMPONENTS)) {
    digests[component] = digest(readFileSync(join(repoRoot, path), 'utf8'));
  }
  return digests;
}

/**
 * One value over every component digest, plus the declared exclusions so that removing an
 * exclusion — or quietly adding one — moves the fingerprint too.
 * @param {Record<string, string>} digests
 */
export function instrumentFingerprint(digests) {
  const components = Object.keys(INSTRUMENT_COMPONENTS);
  for (const component of components) {
    if (typeof digests?.[component] !== 'string') {
      throw new Error(
        `instrumentFingerprint: missing digest for ${component}. A fingerprint that omits a `
        + 'component silently declares that component free to change mid-run.',
      );
    }
  }
  return digest(canonicalJson({
    components: Object.fromEntries(components.map((name) => [name, digests[name]])),
    excluded: EXCLUDED_FROM_INSTRUMENT,
  }));
}

/**
 * The protocol fingerprint. Inputs *and* instrument: everything a cell result depends on.
 *
 * @param {object} inputs
 * @param {string} inputs.promptSetId
 * @param {unknown} inputs.prompts prompt bytes, rails, first families, alternatives
 * @param {unknown} inputs.fixtures fixture definitions including the composition baseline
 * @param {unknown} inputs.fixtureFingerprints what each fixture actually hashes to, or null when unbuilt
 * @param {unknown} inputs.panelProfile the permission profile the panel runs under
 * @param {number} inputs.ngramWidth the leak guard's n-gram width
 * @param {string} inputs.cliHelpFingerprint sha256 of the CLI help corpus
 * @param {string} inputs.skillDescriptionsFingerprint sha256 of the Skill-description corpus
 * @param {string} inputs.milestoneIdentifiersFingerprint sha256 of the milestone identifiers read from docs/
 * @param {unknown} inputs.writeSemantics digests of the CLI source that decides what writes
 * @param {unknown} inputs.permissionProfiles
 * @param {unknown} inputs.scoreabilityMatrix which metrics can resolve under which profile
 * @param {string} inputs.instrumentFingerprint digest of the modules that decide outcomes
 */
export function protocolFingerprint(inputs) {
  const required = [
    'promptSetId', 'prompts', 'fixtures', 'fixtureFingerprints', 'panelProfile', 'ngramWidth',
    'cliHelpFingerprint', 'skillDescriptionsFingerprint', 'milestoneIdentifiersFingerprint', 'writeSemantics',
    'permissionProfiles', 'scoreabilityMatrix', 'instrumentFingerprint',
  ];
  for (const key of required) {
    if (inputs?.[key] === undefined) {
      throw new Error(
        `protocolFingerprint: missing ${key}. A fingerprint that omits one of its inputs `
        + 'silently declares that input free to change mid-run, which is the one thing the '
        + 'freeze exists to prevent.',
      );
    }
  }
  return digest(canonicalJson(Object.fromEntries(required.map((key) => [key, inputs[key]]))));
}

/**
 * The gate. **Refusal, never a warning**: a run that proceeds against a drifted protocol
 * writes receipts that look valid and are not, which is worse than no run at all.
 *
 * The thrown message attributes the drift, because an unattributed refusal is one the
 * next operator routes around.
 *
 * @param {{ protocolFingerprint: string, componentDigests: Record<string, string> }} frozen
 * @param {{ protocolFingerprint: string, componentDigests: Record<string, string> }} actual
 */
export function assertProtocolCurrent(frozen, actual) {
  if (frozen.protocolFingerprint === actual.protocolFingerprint) return;

  const moved = Object.keys(INSTRUMENT_COMPONENTS)
    .filter((component) => frozen.componentDigests?.[component] !== actual.componentDigests?.[component]);

  const attribution = moved.length > 0
    ? `Components that moved: ${moved.join(', ')}. Re-run the cells those decisions affect.`
    : 'No instrument component moved, so the drift is in the frozen inputs — prompts, '
      + 'fixture definitions, the recorded fixture fingerprints, the panel\'s permission profile, '
      + 'the permission profiles themselves, the scoreability matrix, the n-gram width, or one of '
      + 'the leak-guard corpora (the CLI help text, a Skill description, or the milestone '
      + 'identifiers read from docs/), or the CLI source that decides what writes. An edit to a '
      + 'corpus moves the surface every prompt was checked against; an edit to the write semantics '
      + 'moves what a mutation is; removing the fixture fingerprints unbinds the tree under test. '
      + 'Any of them needs re-checking before any cell runs.';

  throw new Error(
    'PROTOCOL_STALE: the materialised protocol does not match the frozen fingerprint, so this '
    + `run is refused rather than recorded. Frozen ${frozen.protocolFingerprint.slice(0, 16)}…, `
    + `now ${actual.protocolFingerprint.slice(0, 16)}…. ${attribution}`,
  );
}
