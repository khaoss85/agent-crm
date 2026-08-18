// @ts-check

/**
 * The runner. Three verbs, and each one refuses more than it does.
 *
 *   node benchmarks/tool-selection/run.js probe
 *   node benchmarks/tool-selection/run.js run <runDir> --arm <id> --prompt <TS-01> [--model <id>]
 *   node benchmarks/tool-selection/run.js aggregate <runsRoot>
 *
 * `probe` asks the machine which arms exist. It is the first thing an operator runs and
 * the thing whose answer they are least entitled to assume.
 *
 * `run` builds the fixture, proves its isolation, hands the prompt over exactly once,
 * fingerprints the tree again, scores what was observed and writes a receipt. It writes
 * a receipt on **every** path, including the paths where nothing ran: an unavailable
 * arm produces `NOT_RUN_BINARY_MISSING` on disk, because a planned cell with no
 * document is a planned cell that quietly leaves the denominator.
 *
 * `aggregate` reads receipts and rolls them up over the *planned* panel, which the
 * operator states rather than the tool inferring from what happened to work.
 *
 * Bounded by construction: one invocation, a wall-clock timeout, a capped output
 * buffer, and no retry. A retry under the same run id is how a benchmark quietly
 * becomes a best-of-three.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ARMS, DEFAULT_MAX_TURNS, PERMISSION_PROFILES, VENDOR_FACTS, classifyOutcome, claudeCodeInvocation, declaredMcpSurface, hasAdapter, instructionsHookSettings, parseClaudeTranscript, probeAllArms, probeArm, readInstructionsLoaded } from './harness.js';
import { PROSE_NGRAM } from './surface.js';
import { buildRun, canonicalJson, validateRun } from './contract.js';
import { FIXTURES, fingerprintTree, materializeFixture, uncommittedTrackedFiles, verifyIsolation } from './fixtures.js';
import { loadPromptMatrix } from './prompt-matrix.js';
import { aggregateRuns, deriveScoreabilityMatrix, scoreRun } from './score.js';
import { assertProtocolCurrent, componentDigests, instrumentFingerprint, protocolFingerprint } from './freeze.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');

/** One invocation's wall clock. A run that needs longer than this is a TIMEOUT, which is an outcome. */
export const RUN_TIMEOUT_MS = 8 * 60 * 1000;
/** Output cap. Beyond this the transcript is refused rather than silently cut. */
export const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

/**
 * Where a frozen protocol lives when the operator does not name one.
 *
 * The freeze exists to make "this panel measured one thing" checkable after the fact, and
 * for that it has to be **applied on the path that runs a cell** — not defined, exported
 * and called from a test. It was the latter: `requireCurrentProtocol` was reachable only
 * from `agent-tool-selection-scoring.test.js`, the `run` verb never parsed a freeze flag,
 * and every receipt recorded `protocolFingerprint: null`, `instrumentFingerprint: null`
 * and `baseSha: null` on a run the contract then called fully valid. `PROTOCOL_UNFROZEN`
 * could not be reached in production, so a panel could have been run against any state of
 * the tree, mid-panel edits included, and every receipt would have looked the same.
 */
export const FREEZE_DOCUMENT = 'benchmarks/tool-selection/frozen-protocol.json';
export const TOOL_SELECTION_FREEZE_CONTRACT = 1;

/**
 * Every top-level key a freeze document may carry.
 *
 * The suite mutates each of the document's own keys and requires a cell to refuse, which
 * covers every field that is *there* — and covered nothing about a field that is not. A
 * document with an extra key was loaded, used and never mentioned, so a freeze could carry
 * `permissionProfile: "guarded"` **and** `permission_profile: "unguarded"` and the reader
 * of the pair would see whichever one they went looking for. `computeFreeze` asserts its
 * own output against this list, so the two cannot drift apart.
 */
export const FREEZE_DOCUMENT_KEYS = Object.freeze([
  'baseSha', 'componentDigests', 'fixtures', 'frozenAt', 'instrumentFingerprint',
  'permissionProfile', 'promptSetId', 'protocolFingerprint', 'scoreabilityMatrix',
  'toolSelectionFreeze',
]);

/**
 * Fields of the freeze document that do **not** bind a cell, each with the reason it does
 * not have to.
 *
 * The rule this list is the exception to is the whole point of a freeze: *every* field
 * either changes what a cell is allowed to do, or it is named here. The suite enumerates
 * the document's own keys - not a list typed beside them - mutates each one and requires
 * the cell to refuse; a field that is neither named here nor causes a refusal fails the
 * suite on the commit that adds it. That is the property the freeze did not have: the
 * `fixtures` map could be deleted and nothing moved, and nothing was looking for a field
 * with that shape.
 */
export const FREEZE_ADVISORY_FIELDS = Object.freeze([
  {
    field: 'frozenAt',
    why: 'when the freeze was taken. Two freezes of one tree at different times measure the same thing, so '
      + 'binding this would refuse a re-freeze that changed nothing. Every receipt records it for the reader.',
  },
  {
    field: 'componentDigests',
    why: 'the per-component attribution the refusal message uses to name which decision moved. It is derived '
      + 'from the same files instrumentFingerprint covers, so a component that really moved is caught by the '
      + 'fingerprint whatever this map says; editing it only degrades the explanation.',
  },
  {
    field: 'instrumentFingerprint',
    why: 'bound at the aggregate rather than at the cell: aggregateRuns refuses every receipt whose instrument '
      + 'fingerprint is not this value, so a doctored one produces a panel with no admitted runs rather than a '
      + 'wrong number. The cell re-derives its own from the tree and stamps that.',
  },
]);

/**
 * Compute the freeze document for the tree as it stands. This is the *only* supported way
 * to produce one, so a freeze always describes a real checkout rather than a hand-written
 * expectation.
 * @param {string} repoRoot
 */
export function computeFreeze(repoRoot, options = {}) {
  const matrix = loadPromptMatrix(repoRoot);
  if (!matrix.valid) {
    throw new Error(`freeze: the prompt matrix is invalid; refusing to freeze it. ${JSON.stringify(matrix.problems)}`);
  }
  const dirty = uncommittedTrackedFiles(repoRoot);
  if (dirty > 0) {
    throw new Error(
      `WORKTREE_DIRTY: ${dirty} tracked file(s) differ from HEAD, so this freeze could not be rebuilt from the `
      + 'commit it names. Commit or stash before freezing.',
    );
  }
  const scoreabilityMatrix = deriveScoreabilityMatrix();
  // **The panel's permission profile is frozen too.** Which metrics a cell can even fail
  // is a property of the profile — the guarded one denies every shell action, so both
  // restraint metrics come back `not_applicable` — and two profiles pooled into one panel
  // is two experiments reported as one. The freeze names the panel's profile; the
  // aggregate excludes a receipt that ran under another, and says so.
  const permissionProfile = options.profile ?? 'guarded';
  if (!(permissionProfile in PERMISSION_PROFILES)) {
    throw new Error(`freeze: unknown permission profile ${permissionProfile}; the protocol declares ${Object.keys(PERMISSION_PROFILES).join(' and ')}`);
  }
  const fixtures = options.skipFixtures === true ? null : fixtureFingerprints(repoRoot);
  const materialised = materialiseProtocol(repoRoot, matrix, scoreabilityMatrix, { fixtures, permissionProfile });
  const document = {
    toolSelectionFreeze: TOOL_SELECTION_FREEZE_CONTRACT,
    frozenAt: new Date().toISOString(),
    baseSha: headSha(repoRoot),
    promptSetId: matrix.setId,
    scoreabilityMatrix,
    permissionProfile,
    ...materialised,
    // **The tree the fixtures are cut from, bound by the thing that actually varies.**
    //
    // The instrument fingerprint covers ten files. A fixture carries six hundred, and they
    // are not incidental — `AGENTS.md`, `CLAUDE.md`, every Skill *body* (only the
    // `description:` lines were bound), `README.md` and every product source a fixture
    // composes are the surface under test. An uncommitted one-line edit to a package moved
    // a fixture's fingerprint while the protocol, instrument and base-SHA fields stayed
    // byte-identical, because `git rev-parse HEAD` does not move for an uncommitted edit.
    //
    // That is rounds one and two one level down: the freeze was built over the part that
    // was easy to hash, and the thing being measured sat outside it. Each fixture is
    // materialised here and its fingerprint recorded; `executeRun` compares.
    // Bound into `protocolFingerprint` as well as recorded here, so deleting the key does
    // not quietly turn the binding off. It was neither: `executeRun` read a missing entry
    // as a pass, and the fingerprint did not cover the map — so a freeze document with
    // three characters removed unbound the six hundred files under test while every
    // receipt still reported the protocol current.
    fixtures,
  };
  // The producer is checked against the seal the loader enforces, so adding a field here
  // without adding it to `FREEZE_DOCUMENT_KEYS` fails on the commit that adds it rather
  // than the first time somebody freezes.
  const unlisted = Object.keys(document).filter((key) => !FREEZE_DOCUMENT_KEYS.includes(key));
  if (unlisted.length > 0) {
    throw new Error(
      `freeze: this document carries ${unlisted.join(', ')}, which FREEZE_DOCUMENT_KEYS does not list. `
      + 'A field the seal does not know is a field the suite never mutates.',
    );
  }
  return document;
}

/**
 * Materialise every fixture and record what it fingerprints to. Slow on purpose — this
 * runs once per freeze, and the alternative is a protocol that does not cover its own
 * subject.
 * @param {string} repoRoot
 */
export function fixtureFingerprints(repoRoot) {
  /** @type {Record<string, { fingerprint: string, files: number, bytes: number }>} */
  const out = {};
  for (const fixture of FIXTURES) {
    const scratch = mkdtempSync(join(tmpdir(), 'ts-freeze-'));
    try {
      const built = materializeFixture(fixture.id, join(scratch, 'fixture'), { repoRoot });
      out[fixture.id] = { fingerprint: built.fingerprint, files: built.files, bytes: built.bytes };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  return out;
}

/**
 * The commit the freeze and every receipt are bound to. Null only when the checkout is
 * not a git repository, which the contract then refuses for a scoreable run.
 * @param {string} repoRoot
 */
export function headSha(repoRoot) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Load the freeze a run must be verified against. Absence is a refusal, not a default:
 * "no freeze supplied" and "frozen, and current" must never produce the same receipt.
 * @param {string} repoRoot @param {string | undefined} supplied
 */
export function loadFreeze(repoRoot, supplied) {
  const path = supplied ? resolve(supplied) : join(repoRoot, FREEZE_DOCUMENT);
  if (!existsSync(path)) {
    throw new Error(
      `PROTOCOL_UNFROZEN: no frozen protocol document at ${supplied ?? FREEZE_DOCUMENT}. Freeze the `
      + 'protocol before executing cells (`run.js freeze <out.json>`); a panel run against an unfrozen '
      + 'protocol cannot be shown to have measured one thing.',
    );
  }
  const frozen = JSON.parse(readFileSync(path, 'utf8'));
  if (frozen?.toolSelectionFreeze !== TOOL_SELECTION_FREEZE_CONTRACT) {
    throw new Error(`PROTOCOL_UNFROZEN: ${path} is not a tool-selection freeze document (contract ${TOOL_SELECTION_FREEZE_CONTRACT}).`);
  }
  if (frozen === null || typeof frozen !== 'object' || Array.isArray(frozen)) {
    throw new Error(`PROTOCOL_UNFROZEN: ${path} is not a freeze document; it is ${Array.isArray(frozen) ? 'an array' : typeof frozen}.`);
  }
  // Sealed against keys nobody declared. The suite proves that mutating any field the
  // document *has* makes a cell refuse; without this, a field the document should not have
  // is neither mutated nor noticed, and a second spelling of a real key sits beside it
  // waiting for a reader who looks for that spelling.
  const unknown = Object.keys(frozen).filter((key) => !FREEZE_DOCUMENT_KEYS.includes(key)).sort();
  if (unknown.length > 0) {
    throw new Error(
      `PROTOCOL_UNFROZEN: ${path} carries ${unknown.join(', ')}, which this contract does not define. `
      + 'A freeze is refused rather than read past, because a field nothing reads is a field '
      + 'nothing checks.',
    );
  }
  const missing = FREEZE_DOCUMENT_KEYS.filter((key) => !(key in frozen));
  if (missing.length > 0) {
    throw new Error(
      `PROTOCOL_UNFROZEN: ${path} is missing ${missing.join(', ')}. Every field of the freeze either `
      + 'binds a cell or is named in FREEZE_ADVISORY_FIELDS, so a document short of one binds less '
      + 'than the protocol says it does.',
    );
  }
  return frozen;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [verb, ...rest] = process.argv.slice(2);
  try {
    if (verb === 'probe') {
      const report = { arms: probeAllArms(), vendorFacts: VENDOR_FACTS };
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exit(0);
    }
    if (verb === 'run') {
      const [runDir, ...flags] = rest;
      const options = parseFlags(flags);
      const result = executeRun({
        runDir,
        armId: String(options.arm ?? ''),
        promptId: String(options.prompt ?? ''),
        model: options.model ? String(options.model) : null,
        profile: options.profile ? String(options.profile) : 'guarded',
        attempt: requirePositiveInteger(options.attempt ?? 1, '--attempt'),
        repoRoot: REPO_ROOT,
        keepFixture: options['keep-fixture'] === true,
        // Deliberate, and only deliberate: a cell under a profile the freeze does not name.
        offPanel: options['off-panel'] === true,
        freeze: options.freeze ? String(options.freeze) : undefined,
      });
      process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
      process.exit(result.receipt.outcome === 'VALID_RUN' ? 0 : 1);
    }
    if (verb === 'aggregate') {
      const [runsRoot, ...flags] = rest;
      const options = parseFlags(flags);
      const report = aggregateDirectory(runsRoot, {
        repetitions: requirePositiveInteger(options.repetitions ?? 1, '--repetitions'),
        armIds: options.arms ? String(options.arms).split(',').map((id) => id.trim()).filter(Boolean) : ARMS.map((arm) => arm.id),
        freeze: options.freeze ? String(options.freeze) : undefined,
      });
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      process.exit(0);
    }
    if (verb === 'freeze') {
      // `options` was read here and defined in neither this branch nor an enclosing
      // scope — the other two verbs each parse their own — so `run.js freeze` threw
      // `options is not defined` on every invocation it has ever had. The protocol names
      // this verb as **the only supported way to produce a freeze document**, and the
      // suite reached `computeFreeze()` directly, so a gate that refuses to run a cell
      // without a freeze sat behind a command that could not produce one.
      const [out, ...flags] = rest;
      if (!out) throw new Error('usage: run.js freeze <out.json> [--profile <name>]');
      const options = parseFlags(flags);
      const document = computeFreeze(REPO_ROOT, { profile: options.profile ? String(options.profile) : 'guarded' });
      writeFileSync(resolve(out), `${JSON.stringify(document, null, 2)}\n`);
      process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
      process.exit(0);
    }
    if (verb === 'rescore') {
      const [runDir, ...flags] = rest;
      const options = parseFlags(flags);
      const result = rescoreRun(runDir, { freeze: options.freeze ? String(options.freeze) : undefined });
      process.stdout.write(`${JSON.stringify(result.receipt, null, 2)}\n`);
      process.exit(result.receipt.outcome === 'VALID_RUN' ? 0 : 1);
    }
    throw new Error(
      'usage: run.js probe | freeze <out.json> [--profile <name>] | run <runDir> --arm <id> --prompt <id> [--freeze <path>] '
      + '| rescore <runDir> [--freeze <path>] | aggregate <runsRoot> [--freeze <path>]',
    );
  } catch (error) {
    process.stderr.write(`tool-selection: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

/**
 * A count typed on a command line. `Number('two')` is `NaN`, and every arithmetic use of it
 * downstream produces `null` rather than an error — which is how a mistyped flag became a
 * panel with no denominator at all.
 * @param {unknown} value @param {string} flag
 */
function requirePositiveInteger(value, flag) {
  // `Number(true)` is 1, so a bare `--repetitions` with no value silently meant one
  // repetition. A flag that takes a count either carries one or is wrong.
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new Error(`${flag} must be a positive integer, not ${JSON.stringify(value)}`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer, not ${JSON.stringify(value)}`);
  }
  return parsed;
}

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; index += 1; } else flags[key] = true;
  }
  return flags;
}

/**
 * One planned cell, start to finish.
 *
 * @param {{ runDir: string, armId: string, promptId: string, model: string | null, profile?: string, attempt?: number, repoRoot: string, keepFixture?: boolean }} request
 */
/**
 * Materialise the protocol as it stands right now, so it can be compared against what was
 * frozen. Returns the fingerprints and the per-component digests the refusal needs to
 * attribute drift.
 *
 * @param {string} repoRoot
 * @param {any} matrix
 * @param {any} scoreabilityMatrix
 */
export function materialiseProtocol(repoRoot, matrix, scoreabilityMatrix, bindings = {}) {
  const digests = componentDigests(repoRoot);
  const instrument = instrumentFingerprint(digests);
  const surface = matrix.surface;
  return {
    componentDigests: digests,
    instrumentFingerprint: instrument,
    protocolFingerprint: protocolFingerprint({
      promptSetId: matrix.setId,
      prompts: matrix.prompts,
      fixtures: FIXTURES,
      // The fixture *fingerprints* — what the tree under test actually hashes to — and the
      // profile the panel runs under. Both are read back out of the freeze document when a
      // cell verifies itself, so editing either one in the document stales the protocol
      // rather than silently changing what the run is bound to.
      fixtureFingerprints: bindings.fixtures ?? null,
      panelProfile: bindings.permissionProfile ?? null,
      ngramWidth: PROSE_NGRAM,
      cliHelpFingerprint: createHash('sha256').update(surface.cliHelp).digest('hex'),
      skillDescriptionsFingerprint: createHash('sha256').update(canonicalJson(surface.skillDescriptions)).digest('hex'),
      milestoneIdentifiersFingerprint: createHash('sha256').update(canonicalJson(surface.milestoneIdentifiers)).digest('hex'),
      writeSemantics: surface.writeSemanticsSources,
      permissionProfiles: PERMISSION_PROFILES,
      scoreabilityMatrix,
      instrumentFingerprint: instrument,
    }),
  };
}

/**
 * The gate, applied before a cell runs rather than after it is written.
 *
 * **Refusal, never a warning.** A run that proceeds against a drifted protocol produces
 * receipts that look valid and are not, which is worse than no run.
 *
 * @param {{ frozen: any, repoRoot: string, matrix: any, scoreabilityMatrix: any }} input
 */
export function requireCurrentProtocol({ frozen, repoRoot, matrix, scoreabilityMatrix }) {
  if (!frozen || typeof frozen.protocolFingerprint !== 'string') {
    throw new Error(
      'PROTOCOL_UNFROZEN: no frozen protocol fingerprint was supplied, so there is nothing to '
      + 'verify this run against. Freeze the protocol before executing cells; a panel run '
      + 'against an unfrozen protocol cannot be shown to have measured one thing.',
    );
  }
  // Two fields the freeze document states and nothing compared. A freeze naming another
  // prompt set, or another commit, describes another experiment - and every receipt copies
  // both values out of it, so an unchecked one is a claim the receipt makes on the freeze's
  // word. The fingerprint covers the prompt set the *tree* has; this covers the one the
  // document says it froze.
  //
  // Absence is refused as firmly as difference, and that is not a stylistic choice: a guard
  // written `typeof frozen.x === 'string' && ...` is a guard whose off-switch is deleting a
  // key, which is precisely how the fixture binding came to bind nothing.
  if (typeof frozen.promptSetId !== 'string' || frozen.promptSetId === '') {
    throw new Error('PROTOCOL_UNFROZEN: the freeze names no prompt set, so there is nothing to check this tree against.');
  }
  if (frozen.promptSetId !== matrix.setId) {
    throw new Error(
      `PROTOCOL_STALE: the freeze was taken over prompt set ${frozen.promptSetId} and this tree carries `
      + `${matrix.setId}. A cell measured against one prompt set cannot be recorded under another.`,
    );
  }
  if (typeof frozen.baseSha !== 'string' || frozen.baseSha === '') {
    throw new Error(
      'PROTOCOL_UNFROZEN: the freeze names no base commit. Every receipt binds the commit it ran against, '
      + 'and a freeze that names none cannot say which commit that was supposed to be.',
    );
  }
  const head = headSha(repoRoot);
  if (head !== frozen.baseSha) {
    throw new Error(
      `PROTOCOL_STALE: the freeze names commit ${frozen.baseSha.slice(0, 12)} and this checkout is at `
      + `${head === null ? 'no commit at all — it is not a git repository' : head.slice(0, 12)}. A cell run on `
      + 'another commit is excluded from the panel anyway, so it is refused here rather than written and discarded later.',
    );
  }
  const actual = materialiseProtocol(repoRoot, matrix, scoreabilityMatrix, {
    fixtures: frozen.fixtures ?? null,
    permissionProfile: frozen.permissionProfile ?? null,
  });
  assertProtocolCurrent(frozen, actual);
  return actual;
}

export function executeRun(request) {
  const profileName = request.profile ?? 'guarded';
  if (!(profileName in PERMISSION_PROFILES)) {
    throw new Error(`run: unknown permission profile ${profileName}; the protocol declares ${Object.keys(PERMISSION_PROFILES).join(' and ')}`);
  }
  const runDir = resolve(request.runDir ?? '');
  const root = realpathSync(request.repoRoot);
  if (runDir === root || runDir.startsWith(root + sep)) {
    throw new Error(
      `run: refusing a run directory inside the framework checkout (${runDir}). The fixture would dirty `
      + 'the tree its own fingerprint describes.',
    );
  }
  if (existsSync(runDir)) throw new Error(`run: ${runDir} already exists. A run is built, never topped up.`);

  const matrix = loadPromptMatrix(request.repoRoot);
  if (!matrix.valid) throw new Error(`run: the prompt matrix is invalid; refusing to run against it. ${JSON.stringify(matrix.problems)}`);
  const prompt = matrix.prompts.find((entry) => entry.id === request.promptId);
  if (!prompt) throw new Error(`run: unknown prompt ${request.promptId}`);
  const arm = ARMS.find((entry) => entry.id === request.armId);
  if (!arm) throw new Error(`run: unknown arm ${request.armId}`);

  // --- the freeze, applied here rather than described elsewhere ----------------
  //
  // Before the run directory exists, before the arm is probed, before a fixture is
  // built. A drifted or absent protocol is refused for the whole cell, because a cell
  // that ran against an unknown protocol is not a cell whose receipt can be checked
  // later — and every receipt below binds the three values this gate returns.
  const frozen = loadFreeze(request.repoRoot, request.freeze);
  const bound = requireCurrentProtocol({
    frozen,
    repoRoot: request.repoRoot,
    matrix,
    scoreabilityMatrix: frozen.scoreabilityMatrix,
  });
  // **The profile is part of the freeze, so a mismatch is decided here rather than only at
  // the aggregate.** Which metrics a cell can even fail is a property of the profile, and
  // `executeRun` took `request.profile ?? 'guarded'` without ever comparing it to the one
  // the freeze names. The aggregate does exclude such a receipt, so the panel number was
  // right; the cost was a cell that ran a real agent for eight minutes, wrote `VALID_RUN`,
  // and was admissible-looking evidence of nothing.
  //
  // Not a flat refusal, because a supplementary cell under the *other* profile is a
  // legitimate thing to run — it is the only way the restraint metrics are falsifiable at
  // all, since the guarded profile suspends every shell action. It has to be asked for,
  // which is the difference between a deliberate off-panel cell and a typo in a script.
  if (frozen.permissionProfile !== profileName && request.offPanel !== true) {
    throw new Error(
      `PROTOCOL_STALE: the freeze names permission profile ${JSON.stringify(frozen.permissionProfile)} and this `
      + `cell was asked to run under ${JSON.stringify(profileName)}. Two profiles pooled into one panel is two `
      + 'experiments reported as one. Pass --off-panel to run it anyway; the aggregate still excludes it as '
      + 'profileMismatch, and that exclusion is then a choice rather than a surprise.',
    );
  }
  const baseSha = headSha(request.repoRoot);
  const dirty = uncommittedTrackedFiles(request.repoRoot);

  mkdirSync(runDir, { recursive: true });
  const fixtureDir = join(runDir, 'fixture');
  const configDir = join(runDir, 'agent-config');
  mkdirSync(configDir, { recursive: true });

  // Every receipt names the profile its cell was planned under, including the ones that
  // never ran. A panel pools receipts, and a receipt with no profile on it cannot be shown
  // to belong to the same experiment as the one beside it.
  const armIdentity = {
    id: arm.id,
    product: arm.product,
    binary: arm.binary,
    permissionProfile: { name: profileName, ...PERMISSION_PROFILES[profileName] },
  };

  const base = {
    // The attempt index is part of the identity. The protocol runs a prompt more than
    // once on purpose — the first two repetitions this instrument ever recorded
    // disagreed with each other — and two receipts sharing one id would make that
    // disagreement impossible to cite.
    runId: `${prompt.id}-${arm.id}-${matrix.setId}-a${Number(request.attempt ?? 1)}`,
    protocol: {
      document: 'docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md',
      promptSetId: matrix.setId,
      promptSetFingerprint: createHash('sha256').update(JSON.stringify(matrix.prompts)).digest('hex'),
      // Every receipt binds the frozen protocol *and* the instrument that produced it, so
      // a receipt can never be verified against a fingerprint that did not cover the
      // parser, the classifiers or the scorer.
      protocolFingerprint: bound.protocolFingerprint,
      instrumentFingerprint: bound.instrumentFingerprint,
      baseSha,
      frozenAt: frozen.frozenAt ?? null,
      frozenBaseSha: frozen.baseSha ?? null,
    },
    model: { requested: request.model, reported: null },
    prompt: {
      id: prompt.id,
      text: prompt.prompt,
      textDigest: createHash('sha256').update(prompt.prompt).digest('hex'),
      expectedRail: prompt.expectedRail,
      expectedFirstFamilies: prompt.expectedFirstFamilies,
    },
    surfaces: {
      availableFamilies: matrix.surface.families,
      instructionFilesDeclared: arm.instructionFiles,
      // What the session *actually* loaded, or `unresolved`. Every receipt carries this
      // key, including the ones for cells that never ran — a planned cell with no field
      // here would be indistinguishable from one whose apparatus silently failed. The
      // valid path overwrites it with the hook's own answer below.
      instructionsLoaded: {
        status: 'unresolved',
        via: null,
        reason: 'this cell produced no session, so nothing observed what it would have loaded',
        files: [],
        events: 0,
        hookLive: false,
      },
      skillsDirectory: arm.skills,
      // What this repository ships and what the adapter did with it. `mcpServers: []`
      // read as "there is no MCP here", which was false: `.mcp.json` is checked in and
      // nine tools are exposed. The adapter disables them, which is a choice a receipt
      // must record as a choice.
      mcp: declaredMcpSurface(matrix.surface, request.repoRoot),
      toolSearch: {
        setting: process.env.ENABLE_TOOL_SEARCH ?? 'unset',
        applicable: false,
        why: 'the adapter starts with an empty MCP configuration, so no tool schema is ever deferred or searched for; '
          + 'the setting is recorded, not exercised',
      },
    },
    limitations: [
      'The fixture is not installed: no dependency tree is copied and nothing runs an install, so a selected command usually fails to execute. This instrument observes which rail an agent reaches for, not whether the command then succeeded.',
      'The closing-limitation metric is operator-graded and stays unresolved until an operator records a verdict.',
      'Instruction-file loading is observed for this arm through its InstructionsLoaded hook, with a SessionStart liveness marker so that an empty log reads as unresolved rather than as "nothing loaded". It stays declared from vendor documentation for the arms with no adapter, and surfaces.instructionsLoaded says which of the two this receipt carries.',
      `Permission profile "${profileName}": ${PERMISSION_PROFILES[profileName].why}. The metrics it suspends are reported not_applicable, never met.`,
    ],
    evidence: { receipt: 'receipt.json', transcript: 'transcript.txt' },
  };

  // --- is the tree the fixture will be cut from the one the freeze names? ------
  //
  // A receipt rather than an exception, because a planned cell always leaves a document.
  // An uncommitted tracked file moves a fixture's fingerprint while `baseSha` does not,
  // so a run over a dirty tree cannot be rebuilt from the commit its own receipt names.
  if (dirty > 0) {
    return finish(runDir, buildRun({
      ...base,
      arm: { ...armIdentity, version: null, invocation: null, observability: null },
      fixture: { id: prompt.fixture, initialFingerprint: null, finalFingerprint: null, mutated: null, isolation: null },
      observation: { actions: [], approvals: [], transcriptDigest: null, transcriptBytes: 0 },
      outcome: 'NOT_RUN_TREE_DIRTY',
      outcomeDetail: `${dirty} tracked file(s) differ from ${baseSha ?? 'HEAD'}, so this cell could not be rebuilt from the commit it names`,
      scores: null,
    }));
  }

  // --- can this harness drive this arm at all? ---------------------------------
  //
  // First, before the probe and long before the fixture. A missing adapter used to be a
  // `throw` placed *after* the fixture was materialised, so the cell produced no receipt
  // at all — masked today only because `codex` and `gemini` are not on this machine and
  // the probe returns first. The refusal to simulate one arm with another is unchanged;
  // what changes is that the refusal is now recorded rather than raised.
  if (!hasAdapter(arm.id)) {
    return finish(runDir, buildRun({
      ...base,
      arm: { ...armIdentity, version: null, invocation: null, observability: null },
      fixture: { id: prompt.fixture, initialFingerprint: null, finalFingerprint: null, mutated: null, isolation: null },
      observation: { actions: [], approvals: [], transcriptDigest: null, transcriptBytes: 0 },
      outcome: 'NOT_RUN_NO_ADAPTER',
      outcomeDetail: `no adapter is written for ${arm.id}; this harness cannot carry a prompt to ${arm.product}, `
        + 'and there is deliberately no fallback — running one arm\'s prompts through another product and '
        + 'labelling the result with this arm would be a fabrication',
      scores: null,
    }));
  }

  // --- is the arm even here? ---------------------------------------------------
  const probe = probeArm(arm);
  if (!probe.available) {
    return finish(runDir, buildRun({
      ...base,
      arm: { ...armIdentity, version: null, invocation: null, observability: null },
      fixture: { id: prompt.fixture, initialFingerprint: null, finalFingerprint: null, mutated: null, isolation: null },
      observation: { actions: [], approvals: [], transcriptDigest: null, transcriptBytes: 0 },
      outcome: probe.outcome,
      outcomeDetail: probe.detail,
      scores: null,
    }));
  }

  // --- fixture, and the proof it carries no answers ----------------------------
  //
  // A fixture that cannot be built is a receipt, not an exception. The overlay runs a real
  // `app inspect` inside the materialised tree and a dozen file operations before it, and
  // any of them can fail — and a throw here left the cell with no document at all, so it
  // could not even be retried under its own id. `NOT_RUN_TREE_DIRTY` above was already a
  // receipt; this was the half that was not.
  /** @type {any} */
  let fixture;
  try {
    fixture = materializeFixture(prompt.fixture, fixtureDir, { repoRoot: request.repoRoot });
  } catch (error) {
    return finish(runDir, buildRun({
      ...base,
      arm: { ...armIdentity, version: probe.version, invocation: null, observability: null },
      fixture: {
        id: prompt.fixture,
        initialFingerprint: null,
        finalFingerprint: null,
        mutated: null,
        isolation: null,

        frozenFingerprint: frozen.fixtures?.[prompt.fixture]?.fingerprint ?? null,
        bound: false,
      },
      observation: { actions: [], approvals: [], transcriptDigest: null, transcriptBytes: 0 },
      outcome: 'INVALID_FIXTURE',
      outcomeDetail: `the fixture could not be built: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      scores: null,
    }));
  }
  // **Absence is a refusal, not a pass.** `frozen.fixtures?.[id]?.fingerprint ?? null`
  // followed by `frozenFixture !== null &&` meant a freeze document with the `fixtures` key
  // removed bound nothing at all, and every cell ran green over a tree the protocol had
  // never seen. The freeze either names this fixture or the cell does not run.
  const frozenFixture = frozen.fixtures?.[prompt.fixture]?.fingerprint ?? null;
  if (typeof frozenFixture !== 'string' || frozenFixture !== fixture.fingerprint) {
    return finish(runDir, buildRun({
      ...base,
      arm: { ...armIdentity, version: probe.version, invocation: null, observability: null },
      fixture: {
        id: prompt.fixture,
        initialFingerprint: fixture.fingerprint,
        finalFingerprint: fixture.fingerprint,
        mutated: false,
        isolation: null,

        source: fixture.source,
        frozenFingerprint: frozenFixture,
        bound: false,
      },
      observation: { actions: [], approvals: [], transcriptDigest: null, transcriptBytes: 0 },
      outcome: 'INVALID_FIXTURE',
      outcomeDetail: typeof frozenFixture !== 'string'
        ? `the freeze names no fingerprint for fixture ${prompt.fixture}, so the tree under test is bound to nothing`
        : `the materialised fixture fingerprints ${fixture.fingerprint.slice(0, 16)}…, and the freeze names `
          + `${frozenFixture.slice(0, 16)}…; the tree under test is not the one this protocol was frozen against`,
      scores: null,
    }));
  }
  const isolation = verifyIsolation(fixtureDir);
  if (isolation.status !== 'clean') {
    return finish(runDir, buildRun({
      ...base,
      arm: { ...armIdentity, version: probe.version, invocation: null, observability: null },
      fixture: {
        id: prompt.fixture, initialFingerprint: fixture.fingerprint, finalFingerprint: fixture.fingerprint,
        mutated: false,
        isolation: {
          status: isolation.status,
          markersScanned: isolation.markersScanned,
          findings: isolation.findings,
          residualDisclosures: isolation.residualDisclosures,
        },
      },
      observation: { actions: [], approvals: [], transcriptDigest: null, transcriptBytes: 0 },
      outcome: 'INVALID_ISOLATION',
      outcomeDetail: `the materialised fixture carried ${isolation.findings.length} marker(s) of this benchmark's own answers`,
      scores: null,
    }));
  }

  // --- the one invocation ------------------------------------------------------
  //
  // The observation apparatus is written into the scratch config directory rather than
  // into the fixture, and that placement is the whole point: the fixture is fingerprinted
  // and bound to the freeze, so a settings file added to it would change the tree under
  // test and hand the agent a file the real repository does not ship. Here it sits beside
  // the run, outside the agent's working directory, and the fixture stays byte-identical
  // to what the freeze named.
  const instructionsLog = join(runDir, 'instructions-loaded.jsonl');
  const sessionLog = join(runDir, 'session-start.jsonl');
  writeFileSync(
    join(configDir, 'settings.json'),
    `${JSON.stringify(instructionsHookSettings({ instructionsLog, sessionLog }), null, 2)}\n`,
  );
  const invocation = claudeCodeInvocation(
    { prompt: prompt.prompt, model: request.model, profile: /** @type {any} */ (profileName) },
    { configDir, instructionsLog, sessionLog },
  );
  const started = spawnSync(invocation.binary, invocation.args, {
    cwd: fixtureDir,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: MAX_TRANSCRIPT_BYTES,
    env: { ...process.env, ...invocation.env },
  });

  const transcript = `${started.stdout ?? ''}`;
  writeFileSync(join(runDir, 'transcript.txt'), transcript);
  writeFileSync(join(runDir, 'stderr.txt'), `${started.stderr ?? ''}`);

  // The post-run fingerprint runs after the agent has finished and before the receipt
  // exists, so anything it throws costs the whole cell — the observation is already made
  // and would simply be lost. It is bounded here: a fingerprint that cannot be taken
  // becomes an outcome with a reason, and the receipt is still written.
  /** @type {{ fingerprint: string | null, files: number | null, bytes: number | null }} */
  let after = { fingerprint: null, files: null, bytes: null };
  /** @type {string | null} */
  let fingerprintFailure = null;
  try {
    after = fingerprintTree(fixtureDir);
  } catch (error) {
    fingerprintFailure = error instanceof Error ? error.message.slice(0, 300) : String(error);
  }
  // Read back what the session loaded, while the fixture is still on disk — the content
  // digests below are of the files themselves, and the fixture is removed a few lines
  // further down. A failure here is a receipt field that says `unresolved`, never a lost
  // cell: this is an observation *about* the run and the run has already happened.
  /** @type {any} */
  let instructionsLoaded;
  try {
    instructionsLoaded = readInstructionsLoaded({ instructionsLog, sessionLog, fixtureDir });
  } catch (error) {
    instructionsLoaded = {
      status: 'unresolved',
      via: 'InstructionsLoaded hook',
      reason: `the apparatus could not be read back: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}`,
      files: [],
      events: 0,
      hookLive: false,
    };
  }
  const parsed = parseClaudeTranscript(transcript);
  // Canonicalise this benchmark's own scratch locations, and nothing else. A receipt
  // whose actions embed a temporary directory cannot be compared across machines or
  // across runs, and the directory is ours rather than the agent's content.
  //
  // The placeholders carry no shell metacharacters, and that is not cosmetic: the first
  // draft used `<fixture>`, and the mutation classifier then read the closing angle
  // bracket of every path as a redirect — so `Read <fixture>/AGENTS.md` scored as the
  // run's first mutation. A placeholder that changes how the text parses is not a
  // placeholder.
  const canonicalise = (text) => String(text).split(fixtureDir).join('FIXTURE_ROOT').split(runDir).join('RUN_ROOT');
  const observation = {
    ...parsed,
    actions: parsed.actions.map((action) => ({ ...action, raw: canonicalise(action.raw) })),
  };

  // Outcome is decided by `classifyOutcome`, from the harness's own signals only. It
  // lives in `harness.js` because that is the module the instrument fingerprint names as
  // the outcome classifier.
  const completion = observation.completion;
  const { outcome, outcomeDetail, answeredWithoutAction } = (() => {
    const classified = classifyOutcome({
      spawnError: started.error ?? null,
      stderr: String(started.stderr ?? ''),
      transcript,
      observation,
      timeoutMs: RUN_TIMEOUT_MS,
      maxTurns: DEFAULT_MAX_TURNS,
    });
    if (fingerprintFailure !== null && classified.outcome === 'VALID_RUN') {
      // The run happened; what failed is this instrument's ability to say whether the
      // fixture moved, and every restraint metric reads exactly that. Scoring it would be
      // scoring a mutation check that did not run.
      return {
        // Not INVALID_ISOLATION: that means the fixture carried this benchmark's own
        // answers, and the contract refuses it over a clean isolation scan — so the cell
        // used to leave a document its own validator rejected.
        outcome: 'INVALID_FIXTURE',
        outcomeDetail: `the fixture could not be fingerprinted after the run: ${fingerprintFailure}`,
        answeredWithoutAction: classified.answeredWithoutAction,
      };
    }
    return { outcome: classified.outcome, outcomeDetail: classified.detail, answeredWithoutAction: classified.answeredWithoutAction };
  })();

  const fixtureBlock = {
    id: prompt.fixture,
    // What the freeze said this fixture must hash to, and the fact that it did. A published
    // panel has to be able to answer "was the tree under test bound?" from its receipts
    // alone; a receipt that merely omits a refusal answers nothing.
    frozenFingerprint: frozenFixture,
    bound: true,
    // Where the fixture's file set came from, and whether the checkout it was copied from
    // was clean. A fixture built over uncommitted edits cannot be rebuilt from `baseSha`
    // alone, and that is a fact about the receipt rather than a reason to refuse a run.
    source: fixture.source,
    initialFingerprint: fixture.fingerprint,
    finalFingerprint: after.fingerprint,
    // Null, not false, when the after-fingerprint could not be taken: "the fixture did
    // not move" and "nobody could tell" are different observations.
    mutated: after.fingerprint === null ? null : fixture.fingerprint !== after.fingerprint,
    fingerprintFailure,
    // Computed by `verifyIsolation` and published, not dropped. A residual disclosure is
    // a fact about what the agent could see; a receipt that silently discards it is
    // asserting a cleanliness nobody measured — and the shape a hand-written test fixture
    // asserted (`residualDisclosures: []`) was one the runner never produced at all.
    isolation: {
      status: isolation.status,
      markersScanned: isolation.markersScanned,
      findings: isolation.findings,
      residualDisclosures: isolation.residualDisclosures,
    },
  };

  const scores = outcome === 'VALID_RUN'
    ? scoreRun({
      prompt,
      actions: observation.actions,
      approvals: observation.approvals,
      fixture: { initialFingerprint: fixtureBlock.initialFingerprint, finalFingerprint: fixtureBlock.finalFingerprint },
      surface: matrix.surface,
      profile: invocation.profile,
    })
    : null;

  const receipt = buildRun({
    ...base,
    model: { requested: request.model, reported: completion?.models ?? [] },
    // The declared load order stays beside the observed one rather than being replaced by
    // it. They answer different questions — what the vendor documents, and what this
    // session did — and a disagreement between the two is a finding, not a bug to hide by
    // dropping one of them.
    surfaces: { ...base.surfaces, instructionsLoaded },
    arm: {
      id: arm.id,
      product: arm.product,
      binary: arm.binary,
      version: probe.version,
      invocation: invocation.args.filter((token) => token !== prompt.prompt),
      permissionProfile: invocation.profile,
      observability: invocation.observability,
    },
    fixture: fixtureBlock,
    observation: {
      actions: observation.actions,
      approvals: observation.approvals,
      approvalSource: observation.approvalSource,
      secondaryApprovalWitnesses: observation.secondaryApprovalWitnesses,
      completion,
      // A completed run that called no tool at all. Recorded as its own fact rather than
      // folded into an outcome: it is a real observation about the agent — it answered
      // from what it already believed — and the pilot's earlier prose heuristic erased it.
      answeredWithoutAction,
      transcriptDigest: observation.transcriptDigest,
      transcriptBytes: observation.transcriptBytes,
      exitCode: started.status ?? null,
    },
    outcome,
    outcomeDetail,
    scores,
  });

  if (!request.keepFixture) rmSync(fixtureDir, { recursive: true, force: true });
  return finish(runDir, receipt, transcript);
}

/**
 * Write the receipt and its validation. When a transcript is on disk beside it, the
 * receipt is validated *against* that transcript — the digest is a claim about a file
 * that is right there, and a claim nobody checks is a claim.
 * @param {string} runDir @param {any} receipt @param {string} [transcript]
 */
function finish(runDir, receipt, transcript) {
  const validation = validateRun(receipt, typeof transcript === 'string' ? { transcript } : {});
  writeFileSync(join(runDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(join(runDir, 'receipt-validation.json'), `${JSON.stringify(validation, null, 2)}\n`);
  return { receipt, validation };
}

/**
 * Re-score a run that already happened, from its saved transcript.
 *
 * The agent is not invoked again, and nothing about what it did can change: the actions,
 * the approvals and the two fixture fingerprints are read back from the run directory.
 * What changes is the *scorer*, and a benchmark whose scorer improves has to be able to
 * re-read its old evidence — otherwise every fix to a metric silently costs every
 * observation ever recorded, which is a strong incentive not to fix one.
 *
 * The receipt is re-stamped, so its fingerprint changes; the previous document is kept
 * beside it under its own fingerprint rather than overwritten.
 *
 * @param {string} runDirectory
 */
export function rescoreRun(runDirectory, options = {}) {
  const runDir = resolve(runDirectory);
  const repoRoot = options.repoRoot ?? REPO_ROOT;
  const previous = JSON.parse(readFileSync(join(runDir, 'receipt.json'), 'utf8'));
  const transcript = readFileSync(join(runDir, 'transcript.txt'), 'utf8');
  const matrix = loadPromptMatrix(repoRoot);
  // The same gate as a fresh cell. A re-score produces a receipt with scores in it, and a
  // receipt with scores is a measurement — so it is bound to a frozen protocol or it is
  // not written at all.
  const frozen = loadFreeze(repoRoot, options.freeze);
  const bound = requireCurrentProtocol({
    frozen, repoRoot, matrix, scoreabilityMatrix: frozen.scoreabilityMatrix,
  });
  const prompt = matrix.prompts.find((entry) => entry.id === previous.prompt?.id);
  if (!prompt) throw new Error(`rescore: the receipt names prompt ${previous.prompt?.id}, which is not in the current matrix`);

  const parsed = parseClaudeTranscript(transcript);
  const fixtureDir = join(runDir, 'fixture');
  const canonicalise = (text) => String(text).split(fixtureDir).join('FIXTURE_ROOT').split(runDir).join('RUN_ROOT');
  const actions = parsed.actions.map((action) => ({ ...action, raw: canonicalise(action.raw) }));

  const profile = previous.arm?.permissionProfile ?? PERMISSION_PROFILES.guarded;
  const scores = previous.outcome === 'VALID_RUN'
    ? scoreRun({
      prompt,
      actions,
      approvals: parsed.approvals,
      fixture: { initialFingerprint: previous.fixture.initialFingerprint, finalFingerprint: previous.fixture.finalFingerprint },
      surface: matrix.surface,
      profile,
    })
    : null;

  // A re-scored receipt was scored by **this** instrument under **this** protocol, so
  // both fingerprints are re-stamped together.
  //
  // Only the instrument one was, which produced a pair that cannot exist: the protocol
  // fingerprint is computed *over* the instrument fingerprint, so a receipt naming
  // protocol P and instrument I where P was not computed from I describes no state this
  // code can ever be in — and the contract accepted it, and the aggregate admitted it.
  const receipt = buildRun({
    ...previous,
    protocol: {
      ...previous.protocol,
      protocolFingerprint: bound.protocolFingerprint,
      instrumentFingerprint: bound.instrumentFingerprint,
      rescoredFrom: {
        protocolFingerprint: previous.protocol?.protocolFingerprint ?? null,
        instrumentFingerprint: previous.protocol?.instrumentFingerprint ?? null,
      },
      rescoredAt: new Date().toISOString(),
    },
    observation: {
      ...previous.observation,
      actions,
      approvals: parsed.approvals,
      approvalSource: parsed.approvalSource,
      secondaryApprovalWitnesses: parsed.secondaryApprovalWitnesses,
    },
    scores,
  });
  writeFileSync(join(runDir, `receipt-${previous.fingerprint}.json`), `${JSON.stringify(previous, null, 2)}\n`);
  return finish(runDir, receipt, transcript);
}

/**
 * Roll up every receipt under a directory of runs.
 * @param {string} runsRoot
 * The panel's identity comes from the **freeze document**, not from values typed on the
 * command line. `--instrument <fingerprint>` was satisfied by copying the value off the
 * receipts it was meant to check — a guard whose input is the thing under test is not a
 * guard. Reading the freeze also brings the protocol fingerprint and the base commit with
 * it, so all three are compared or none are.
 *
 * @param {{ repetitions: number, armIds: string[], freeze?: string, repoRoot?: string }} plan
 */
export function aggregateDirectory(runsRoot, plan) {
  const root = resolve(runsRoot);
  // The plan is the denominator, and a denominator computed from a typo is worse than no
  // denominator at all. `--repetitions two` made `plannedCells` NaN, so every total
  // reported `"ofPlanned": null`; `--arms clade-code` inflated the plan by a name no arm
  // has and halved every rate — in the tool whose stated discipline is that the
  // denominator never shrinks. Both are refusals now, before a single receipt is read.
  const repetitions = typeof plan.repetitions === 'string' || typeof plan.repetitions === 'number'
    ? Number(plan.repetitions)
    : NaN;
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error(
      `aggregate: --repetitions must be a positive integer, not ${JSON.stringify(plan.repetitions)}. `
      + 'A non-numeric value makes the planned panel NaN, and every rate is taken over the planned panel.',
    );
  }
  const armIds = [...new Set(plan.armIds ?? [])];
  const unknownArms = armIds.filter((id) => !ARMS.some((arm) => arm.id === id));
  if (armIds.length === 0 || unknownArms.length > 0) {
    throw new Error(
      `aggregate: --arms names ${unknownArms.length > 0 ? `no arm this protocol declares: ${unknownArms.join(', ')}` : 'nothing'}. `
      + `The declared arms are ${ARMS.map((arm) => arm.id).join(', ')}. An arm nobody planned still enters the `
      + 'planned panel, so a typo silently halves every rate.',
    );
  }

  /** @type {any[]} */
  const runs = [];
  // The transcript that sits beside each receipt, carried to the validator. The digest
  // check is implemented and is what makes a receipt's claim about its own evidence
  // checkable — and the one place receipts become a number called `validateRun(run)` with
  // the argument left off, so a forged digest was admitted and counted.
  const transcripts = new WeakMap();
  for (const name of readdirSync(root).sort()) {
    const receiptPath = join(root, name, 'receipt.json');
    if (!existsSync(receiptPath)) continue;
    const run = JSON.parse(readFileSync(receiptPath, 'utf8'));
    runs.push(run);
    const transcriptPath = join(root, name, 'transcript.txt');
    if (run && typeof run === 'object' && existsSync(transcriptPath)) {
      transcripts.set(run, readFileSync(transcriptPath, 'utf8'));
    }
  }
  const repoRoot = plan.repoRoot ?? REPO_ROOT;
  const matrix = loadPromptMatrix(repoRoot);
  const promptIds = matrix.prompts.map((prompt) => prompt.id);
  const frozen = loadFreeze(repoRoot, plan.freeze);
  return aggregateRuns(runs, {
    plannedCells: promptIds.length * armIds.length * repetitions,
    promptIds,
    armIds,
    repetitions,
    promptSetId: matrix.setId,
    instrumentFingerprint: frozen.instrumentFingerprint,
    protocolFingerprint: frozen.protocolFingerprint,
    baseSha: frozen.baseSha,
    // The panel's profile, from the freeze rather than from whatever the receipts happen
    // to say. Two profiles suspend different metrics, so pooling them reports two
    // experiments as one.
    permissionProfile: frozen.permissionProfile ?? null,
    transcripts,
    // These receipts came off a disk, so the evidence each one names is either there or it
    // is not, and "not" is a refusal rather than a gap.
    evidenceOnDisk: true,
  });
}
