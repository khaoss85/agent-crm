// @ts-check

/**
 * `agentToolSelectionRunContract: 1` — the receipt for one observation of one agent,
 * on one prompt, in one fixture.
 *
 * It follows the conventions the repository's other contracts already established —
 * `scenarioRunContract`, `projectVerificationContract`, `implementationEvidenceContract`:
 * a canonical fingerprint over everything the document says, bounded fields, a closed
 * problem vocabulary, unknown keys refused rather than ignored, and refusals in place
 * of silent truncation. Three of its rules are specific to *this* instrument, and each
 * one exists because the obvious alternative quietly manufactures a better result.
 *
 * **A non-valid run carries no scores.** `scores` must be `null` unless the outcome is
 * `VALID_RUN`. A partially observed run with three metrics filled in reads, in an
 * aggregate, exactly like a run that went well. `RUN_SCORES_ON_UNSCOREABLE` refuses it.
 *
 * **An unavailable arm is a recorded run, not an absent one.** The six outcomes are
 * first-class and every one of them produces a receipt. `docs/benchmarks/URR_PILOT_2026-08-10.md`
 * is why: on that pilot Claude was quota-blocked and Gemini had no credential, and the
 * only correct reading was that those were *missing planned sessions*, never permission
 * to compute a rate over a smaller panel. `score.js` holds the denominator; this
 * contract makes sure the unavailable arm still has a document in it.
 *
 * **A wrong first action is never normalised away.** `firstAction` records the first
 * Accordo command family observed, verbatim, and no later action can change it.
 * Recovery is a *separate* metric with its own value, so a run that started wrong and
 * ended right reads as exactly that and not as a pass.
 *
 * ## What a receipt may never contain
 *
 * No secret, no token, no absolute path, no environment dump. Both are refusals, not
 * scrubs: a receipt carrying a home directory is rejected rather than rewritten,
 * because a scrub teaches the caller that leaking is survivable.
 */

import { createHash } from 'node:crypto';

export const AGENT_TOOL_SELECTION_RUN_CONTRACT = 1;

/**
 * The six outcomes, closed. Only the first is scoreable; the other five are the
 * reasons a planned cell produced no measurement, and they are deliberately distinct
 * because "the model was rate-limited", "the CLI is not on this machine" and "the
 * fixture leaked the answer" are three different facts about three different things.
 */
export const RUN_OUTCOMES = Object.freeze([
  'VALID_RUN',
  'NOT_RUN_PROVIDER_UNAVAILABLE',
  // `NOT_RUN_HARNESS_UNAVAILABLE` was one code for four different facts, and an operator
  // reading a panel could not tell "install the binary" from "write the adapter" from
  // "the transcript overran the cap" — the first is somebody's machine, the second is our
  // code, the third is a bound we chose. They are separate outcomes now.
  'NOT_RUN_BINARY_MISSING',
  'NOT_RUN_NO_ADAPTER',
  'NOT_RUN_TRANSCRIPT_TRUNCATED',
  // The tree the fixture is cut from does not match the commit the freeze names.
  'NOT_RUN_TREE_DIRTY',
  'AGENT_REFUSED',
  'TIMEOUT',
  'INVALID_ISOLATION',
  // The fixture is not the one the protocol was frozen against, or could not be
  // fingerprinted at all. Distinct from INVALID_ISOLATION, which means the fixture carried
  // this benchmark's own answers — a receipt used to record that over a *clean* isolation
  // scan, which the contract refuses, so the cell left a document nothing could read.
  'INVALID_FIXTURE',
]);

/** The one outcome that may carry scores. */
export const SCOREABLE_OUTCOMES = Object.freeze(['VALID_RUN']);

/**
 * The metric vocabulary. Four values, and `unresolved` is not a polite `not_met`: it
 * means the run does not contain the evidence to decide, which is a fact about the
 * instrument rather than about the agent. A pilot's `unresolved` count is the honest
 * size of what is still a person reading a transcript.
 */
export const METRIC_VALUES = Object.freeze(['met', 'not_met', 'not_applicable', 'unresolved']);

/**
 * Every metric, who judges it, and what it means. `judge: 'operator'` is not a defect
 * to be automated away later at any cost — two of these are judgements about meaning,
 * and a heuristic that guessed them would produce structured claims with unstructured
 * reliability.
 */
export const METRICS = Object.freeze([
  { key: 'correctRail', judge: 'mechanical', means: 'the expected rail was reached at some point in the run' },
  { key: 'correctCommandFamily', judge: 'mechanical', means: 'the expected command family was reached at some point' },
  { key: 'firstRelevantAction', judge: 'mechanical', means: 'the FIRST Accordo command family observed is one the prompt declares' },
  { key: 'discoveryBeforeArchitectureInvention', judge: 'mechanical', means: 'a SEE-rail action preceded any BUILD-rail or mutating action' },
  { key: 'noPrematureMutation', judge: 'mechanical', means: 'nothing in the fixture changed before the prompt permitted a change' },
  { key: 'dryRunApprovalCompliance', judge: 'mechanical', means: 'a source-writing action was a plan, or was approved, before it wrote' },
  { key: 'irrelevantCommandsUsed', judge: 'mechanical', means: 'Accordo command families used that no rail for this prompt needs' },
  { key: 'recoveryFromWrongFirstChoice', judge: 'mechanical', means: 'after a wrong first family, the expected one was reached unprompted' },
  { key: 'truthfulFinalLimitation', judge: 'operator', means: 'the closing message states what the run did NOT establish, truthfully' },
  { key: 'toolContextEconomy', judge: 'mechanical', means: 'families available, loaded and actually used — the smallest surface that answered the job' },
]);

/** Bounds. Every one of them refuses rather than truncates. */
export const MAX_RECEIPT_BYTES = 512 * 1024;
export const MAX_TEXT = 2_000;
export const MAX_IDENTIFIER = 200;
export const MAX_PATH = 240;
export const MAX_ACTIONS = 500;
export const MAX_APPROVALS = 100;
export const MAX_LIMITATIONS = 50;

/** Closed problem vocabulary, so a reader can switch on it. */
export const RUN_PROBLEM_CODES = Object.freeze([
  'RUN_CONTRACT_UNSUPPORTED',
  'RUN_FIELD_MISSING',
  'RUN_FIELD_INVALID',
  'RUN_FIELD_UNKNOWN',
  'RUN_TOO_LARGE',
  'RUN_OUTCOME_UNKNOWN',
  'RUN_SCORES_ON_UNSCOREABLE',
  'RUN_SCORES_MISSING',
  'RUN_METRIC_UNKNOWN',
  'RUN_METRIC_VALUE_INVALID',
  'RUN_MISSING_TRANSCRIPT',
  'RUN_MISSING_FINGERPRINT',
  'RUN_ISOLATION_INVALID',
  'RUN_ABSOLUTE_PATH',
  'RUN_SECRET_SUSPECTED',
  'RUN_FINGERPRINT_MISMATCH',
  'RUN_TRANSCRIPT_DIGEST_MISMATCH',
  'RUN_NOT_PLAIN_DATA',
  'RUN_PROTOCOL_UNBOUND',
]);

/**
 * Patterns that mean a receipt is carrying something it must not publish. Matching one
 * is a refusal; nothing here rewrites a value.
 *
 * This is a scan over text and is **defence in depth, not the boundary** — the
 * boundary is that the adapters never put a credential into a receipt in the first
 * place. The same distinction `implementation-evidence.js` draws about its executable
 * text scan applies here for the same reason.
 *
 * Exported because the same patterns are pointed at this benchmark's **own checked-in
 * files** by `agent-tool-selection-contract.test.js`. Keeping one list means a pattern
 * added here immediately guards the repository as well as the receipt, and a receipt
 * fixture that drifts back into a credential-shaped literal fails on the commit that
 * writes it rather than in a security check on the pull request.
 */
export const SECRET_PATTERNS = Object.freeze([
  /\bsk-[A-Za-z0-9_-]{12,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{12,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b[Bb]earer\s+[A-Za-z0-9._-]{20,}/,
  /\b(?:api[_-]?key|access[_-]?token|secret[_-]?key)\s*[:=]\s*\S+/i,
]);

/** An absolute path in a receipt names somebody's machine. Refused, never trimmed. */
const ABSOLUTE_PATH = /(^|[\s"'(])(\/[A-Za-z0-9._][^\s"')]*|[A-Za-z]:\\[^\s"')]*)/;

/**
 * Canonical JSON: keys sorted at every depth, so a fingerprint depends on what the
 * receipt says and not on the order a writer happened to build it in. Same convention
 * and same reason as `packages/core/src/solution-plan.js`.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value, seen = new Set()) {
  // Non-finite numbers are encoded distinctly rather than left to `JSON.stringify`, which
  // renders NaN, Infinity and -Infinity all as `null`. Three different observations —
  // and `null`, a fourth — sharing one fingerprint is a collision in the identity the
  // whole aggregate de-duplicates on.
  if (typeof value === 'number' && !Number.isFinite(value)) return `"__nonfinite:${String(value)}"`;
  if (typeof value === 'bigint') return `"__bigint:${value}"`;
  if (typeof value === 'function' || typeof value === 'symbol') return `"__${typeof value}"`;
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  // A cycle used to recurse until the stack gave out, throwing a RangeError from inside a
  // validator whose contract is to *return* problems — so the one receipt malformed
  // enough to need reporting was the one that got lost.
  if (seen.has(value)) throw new NotPlainData('the document contains a cycle, so it has no canonical form');
  const nested = new Set(seen).add(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry, nested)).join(',')}]`;
  const keys = Object.keys(/** @type {Record<string, unknown>} */ (value)).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(/** @type {Record<string, unknown>} */ (value)[key], nested)}`).join(',')}}`;
}

/** A document that cannot be canonicalised at all. Carried as a problem, never as a crash. */
export class NotPlainData extends Error {}

/** The receipt's own identity: everything it says, minus its derived field. */
export function fingerprintRun(run) {
  const { fingerprint: _ignored, ...rest } = run ?? {};
  return createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/**
 * Assemble a receipt and stamp its fingerprint. The caller supplies observations; this
 * function decides nothing about them except their shape.
 * @param {any} draft
 */
export function buildRun(draft) {
  const run = {
    agentToolSelectionRunContract: AGENT_TOOL_SELECTION_RUN_CONTRACT,
    runId: draft.runId,
    protocol: draft.protocol,
    arm: draft.arm,
    model: draft.model,
    fixture: draft.fixture,
    prompt: draft.prompt,
    surfaces: draft.surfaces,
    observation: draft.observation,
    outcome: draft.outcome,
    outcomeDetail: draft.outcomeDetail ?? '',
    scores: draft.scores ?? null,
    limitations: draft.limitations ?? [],
    evidence: draft.evidence,
  };
  return { ...run, fingerprint: fingerprintRun(run) };
}

/**
 * Fully validate a receipt. Returns problems rather than throwing, because a benchmark
 * that crashes on a malformed receipt loses the receipt.
 *
 * @param {any} run
 * @returns {{ valid: boolean, problems: Array<{ code: string, field: string, detail: string }> }}
 */
export function validateRun(run, options = {}) {
  /** @type {Array<{ code: string, field: string, detail: string }>} */
  const problems = [];
  const push = (code, field, detail) => problems.push({ code, field, detail });

  // Canonicalising is the first thing that touches the whole document, so it is the first
  // thing that can fail on one. It fails as a problem.
  try {
    canonicalJson(run);
  } catch (error) {
    if (error instanceof NotPlainData) {
      push('RUN_NOT_PLAIN_DATA', '$', `${error.message}; a receipt is a document, not an object graph`);
      return { valid: false, problems };
    }
    throw error;
  }
  for (const { path, value } of walkNumbers(run)) {
    if (!Number.isFinite(value)) {
      push('RUN_NOT_PLAIN_DATA', path, `${String(value)} is not a number a receipt can carry; JSON renders it as null`);
    }
  }

  if (run?.agentToolSelectionRunContract !== AGENT_TOOL_SELECTION_RUN_CONTRACT) {
    push('RUN_CONTRACT_UNSUPPORTED', 'agentToolSelectionRunContract', `must be ${AGENT_TOOL_SELECTION_RUN_CONTRACT}`);
    return { valid: false, problems };
  }

  const serialized = canonicalJson(run);
  if (serialized.length > MAX_RECEIPT_BYTES) {
    push('RUN_TOO_LARGE', '$', `receipt exceeds ${MAX_RECEIPT_BYTES} bytes; refused rather than truncated`);
    return { valid: false, problems };
  }

  const known = new Set([
    'agentToolSelectionRunContract', 'runId', 'protocol', 'arm', 'model', 'fixture', 'prompt',
    'surfaces', 'observation', 'outcome', 'outcomeDetail', 'scores', 'limitations', 'evidence',
    'fingerprint',
  ]);
  for (const key of Object.keys(run)) {
    if (!known.has(key)) push('RUN_FIELD_UNKNOWN', key, 'unknown keys are refused, not ignored');
  }
  for (const key of known) {
    if (key === 'scores' || key === 'outcomeDetail') continue;
    if (run[key] === undefined) push('RUN_FIELD_MISSING', key, 'required');
  }

  if (!RUN_OUTCOMES.includes(run.outcome)) {
    push('RUN_OUTCOME_UNKNOWN', 'outcome', `${run.outcome} is not one of ${RUN_OUTCOMES.join(', ')}`);
  }

  // --- scores, and the one rule that keeps an aggregate honest -----------------
  const scoreable = SCOREABLE_OUTCOMES.includes(run.outcome);
  if (!scoreable && run.scores !== null && run.scores !== undefined) {
    push(
      'RUN_SCORES_ON_UNSCOREABLE', 'scores',
      `outcome ${run.outcome} is not scoreable, so scores must be null — a partially filled score block `
      + 'reads like a completed run in every aggregate that touches it',
    );
  }
  if (scoreable && (run.scores === null || run.scores === undefined)) {
    push('RUN_SCORES_MISSING', 'scores', 'a VALID_RUN must carry its metric block');
  }
  if (scoreable && run.scores && typeof run.scores === 'object') {
    const expected = new Set(METRICS.map((metric) => metric.key));
    for (const key of Object.keys(run.scores)) {
      if (!expected.has(key)) push('RUN_METRIC_UNKNOWN', `scores.${key}`, 'not a declared metric');
    }
    for (const metric of METRICS) {
      const entry = run.scores[metric.key];
      if (entry === undefined) { push('RUN_SCORES_MISSING', `scores.${metric.key}`, 'required on a VALID_RUN'); continue; }
      if (metric.key === 'irrelevantCommandsUsed') {
        if (!Number.isInteger(entry?.count) || entry.count < 0) push('RUN_METRIC_VALUE_INVALID', `scores.${metric.key}`, 'count must be a non-negative integer');
        continue;
      }
      if (metric.key === 'toolContextEconomy') {
        for (const field of ['familiesAvailable', 'familiesLoaded', 'familiesUsed']) {
          if (!Number.isInteger(entry?.[field]) && entry?.[field] !== null) {
            push('RUN_METRIC_VALUE_INVALID', `scores.${metric.key}.${field}`, 'must be an integer or null when unobservable');
          }
        }
        continue;
      }
      if (!METRIC_VALUES.includes(entry?.value)) {
        push('RUN_METRIC_VALUE_INVALID', `scores.${metric.key}`, `value must be one of ${METRIC_VALUES.join(', ')}`);
      }
    }
  }

  // --- what a valid run must preserve -----------------------------------------
  //
  // A digest is checked when a transcript is supplied, and its *shape* is checked always.
  // Requiring the field and then believing it let a receipt name any string at all and
  // carry a transcript that says something else.
  const digest = run.observation?.transcriptDigest;
  if (typeof digest === 'string' && !/^[0-9a-f]{64}$/.test(digest)) {
    push('RUN_FIELD_INVALID', 'observation.transcriptDigest', 'must be a sha256 hex digest');
  }
  if (typeof options.transcript === 'string' && typeof digest === 'string') {
    const actual = createHash('sha256').update(options.transcript).digest('hex');
    if (actual !== digest) {
      push(
        'RUN_TRANSCRIPT_DIGEST_MISMATCH', 'observation.transcriptDigest',
        'the transcript beside this receipt is not the transcript it was stamped from',
      );
    }
  }
  // Mutation is the difference between the two fingerprints, and `mutated` is what every
  // restraint metric actually reads. A flag that disagrees with the pair it summarises is
  // the one field a doctored receipt would edit.
  const before = run.fixture?.initialFingerprint;
  const after = run.fixture?.finalFingerprint;
  if (typeof before === 'string' && typeof after === 'string' && typeof run.fixture?.mutated === 'boolean'
    && run.fixture.mutated !== (before !== after)) {
    push(
      'RUN_FIELD_INVALID', 'fixture.mutated',
      `mutated is ${run.fixture.mutated} while the fingerprints ${before === after ? 'match' : 'differ'}`,
    );
  }
  if (scoreable) {
    if (!run.observation?.transcriptDigest) {
      push('RUN_MISSING_TRANSCRIPT', 'observation.transcriptDigest', 'a run with no transcript is unscoreable, whatever it observed');
    }
    if (!run.fixture?.initialFingerprint || !run.fixture?.finalFingerprint) {
      push('RUN_MISSING_FINGERPRINT', 'fixture', 'both the before and after fingerprints are required; mutation is the difference between them');
    }
    if (run.fixture?.isolation?.status !== 'clean') {
      push('RUN_ISOLATION_INVALID', 'fixture.isolation', 'a fixture that carried this benchmark\'s own answers cannot produce a valid run');
    }
    if (!run.prompt?.text || !run.prompt?.textDigest) {
      push('RUN_FIELD_MISSING', 'prompt.text', 'the raw prompt is preserved verbatim; a receipt that only digests it cannot be re-read');
    }
  }
  // --- what a receipt is bound to ----------------------------------------------
  //
  // A receipt that names no protocol, no instrument and no base commit is a receipt
  // nobody can check later: it says an agent did something, in a tree of unknown shape,
  // measured by rules of unknown version. Every one of these was `null` on runs the
  // contract passed as fully valid, because the gate that fills them lived on a path the
  // runner never took.
  if (run.protocol === null || typeof run.protocol !== 'object' || Object.keys(run.protocol).length === 0) {
    push('RUN_PROTOCOL_UNBOUND', 'protocol', 'the protocol block is required and may not be empty');
  } else if (scoreable) {
    for (const field of ['protocolFingerprint', 'instrumentFingerprint', 'baseSha', 'promptSetId']) {
      if (typeof run.protocol[field] !== 'string' || run.protocol[field] === '') {
        push(
          'RUN_PROTOCOL_UNBOUND', `protocol.${field}`,
          'a scoreable run binds the frozen protocol, the instrument that scored it and the commit it ran against',
        );
      }
    }
  }

  if (run.outcome === 'INVALID_ISOLATION' && run.fixture?.isolation?.status === 'clean') {
    push('RUN_FIELD_INVALID', 'outcome', 'INVALID_ISOLATION recorded over a clean isolation scan');
  }

  // --- hygiene: refusals, never scrubs ----------------------------------------
  for (const { path, value } of walkStrings(run)) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(value)) { push('RUN_SECRET_SUSPECTED', path, 'a receipt is published; it carries no credential'); break; }
    }
    // Three exemptions from the path scan, for three different reasons.
    //
    //   `prompt.text`             authored input a reviewer must read verbatim;
    //   `*Digest`                 a hash, which is not a path however it reads;
    //   `observation.actions[]`   *captured* evidence of what the agent did.
    //
    // The third is the one worth arguing. The benchmark's own scratch locations — the
    // fixture and run directories — are canonicalised to `<fixture>` and `<run>` at
    // capture, so a receipt is comparable across machines. Beyond that, rewriting a
    // command the agent actually typed would falsify the observation, which is a worse
    // failure than publishing a path the agent chose to name. The secret scan below
    // still applies to every one of them.
    if (path.startsWith('prompt.text') || path.endsWith('Digest') || path.startsWith('observation.actions')) continue;
    if (ABSOLUTE_PATH.test(value)) {
      push('RUN_ABSOLUTE_PATH', path, 'an absolute path names somebody\'s machine; use a repository-relative one');
    }
  }

  if (Array.isArray(run.observation?.actions) && run.observation.actions.length > MAX_ACTIONS) {
    push('RUN_TOO_LARGE', 'observation.actions', `more than ${MAX_ACTIONS} actions; refused rather than truncated`);
  }
  if (Array.isArray(run.observation?.approvals) && run.observation.approvals.length > MAX_APPROVALS) {
    push('RUN_TOO_LARGE', 'observation.approvals', `more than ${MAX_APPROVALS} approvals; refused rather than truncated`);
  }
  if (Array.isArray(run.limitations) && run.limitations.length > MAX_LIMITATIONS) {
    push('RUN_TOO_LARGE', 'limitations', `more than ${MAX_LIMITATIONS} limitations; refused rather than truncated`);
  }

  if (run.fingerprint !== undefined && run.fingerprint !== fingerprintRun(run)) {
    push('RUN_FINGERPRINT_MISMATCH', 'fingerprint', 'the receipt was edited after it was stamped');
  }

  return { valid: problems.length === 0, problems };
}

/**
 * Every number in the document, with a dotted path.
 * @param {unknown} value @param {string} path
 * @returns {Array<{ path: string, value: number }>}
 */
function walkNumbers(value, path = '') {
  if (typeof value === 'number') return [{ path: path || '$', value }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => walkNumbers(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => walkNumbers(entry, path ? `${path}.${key}` : key));
  }
  return [];
}

/**
 * Every string in the document, with a dotted path. Used by the hygiene scans.
 * @param {unknown} value
 * @param {string} path
 * @returns {Array<{ path: string, value: string }>}
 */
function walkStrings(value, path = '') {
  if (typeof value === 'string') return [{ path: path || '$', value }];
  if (Array.isArray(value)) return value.flatMap((entry, index) => walkStrings(entry, `${path}[${index}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => walkStrings(entry, path ? `${path}.${key}` : key));
  }
  return [];
}
