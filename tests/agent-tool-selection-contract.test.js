// @ts-check

/**
 * `agentToolSelectionRunContract: 1`, and the refusals that make an aggregate over it
 * mean something.
 *
 * Three of these tests exist because the opposite behaviour would silently improve a
 * result: scores on an unscoreable run, a valid run with no transcript, and a receipt
 * that was edited after it was stamped. The others are the hygiene the repository's
 * other contracts already enforce — bounded fields, unknown keys refused, no secret and
 * no absolute path.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

import {
  AGENT_TOOL_SELECTION_RUN_CONTRACT, METRICS, METRIC_VALUES, RUN_OUTCOMES, SCOREABLE_OUTCOMES,
  SECRET_PATTERNS, buildRun, canonicalJson, fingerprintRun, validateRun,
} from '../benchmarks/tool-selection/contract.js';
import { DENY } from '../benchmarks/tool-selection/fixtures.js';
import { aggregateRuns } from '../benchmarks/tool-selection/score.js';
import {
  EXCLUDED_FROM_INSTRUMENT, INSTRUMENT_COMPONENTS, assertProtocolCurrent,
  componentDigests, instrumentFingerprint, protocolFingerprint,
} from '../benchmarks/tool-selection/freeze.js';

/** A minimal receipt that validates, so each test can break exactly one thing. */
function validReceipt(overrides = {}) {
  return buildRun({
    runId: 'TS-01-claude-code-TS-v1',
    protocol: {
      document: 'docs/benchmarks/AGENT_TOOL_SELECTION_PROTOCOL.md',
      promptSetId: 'TS-v1',
      promptSetFingerprint: 'a'.repeat(64),
      // Bound, because the contract now refuses a scoreable run that names no protocol,
      // no instrument and no commit. Every one of these was null on receipts the runner
      // actually wrote, and this fixture asserted a shape production never produced.
      protocolFingerprint: 'f'.repeat(64),
      instrumentFingerprint: 'e'.repeat(64),
      baseSha: '9'.repeat(40),
    },
    arm: { id: 'claude-code', product: 'Claude Code', binary: 'claude', version: '2.1.229', invocation: ['--print'], permissionProfile: { name: 'guarded' }, observability: { actions: 'observed' } },
    model: { requested: null, reported: ['claude-sonnet-5'] },
    fixture: {
      id: 'clean-valid',
      initialFingerprint: 'b'.repeat(64),
      finalFingerprint: 'b'.repeat(64),
      mutated: false,
      isolation: { status: 'clean', markersScanned: 7, findings: [], residualDisclosures: [] },
      // Null, as the runner writes it: nothing resets a fixture during a cell, and
      // `true` was a value production never produced.
    },
    prompt: { id: 'TS-01', text: 'Where do we stand?', textDigest: 'c'.repeat(64), expectedRail: 'SEE', expectedFirstFamilies: ['app inspect'] },
    // The shape the runner emits: an `mcp` block that names what ships and what was
    // disabled. `mcpServers: []` was this fixture's invention, and it said the opposite of
    // what production says — the same defect as the `residualDisclosures: []` fixture.
    surfaces: {
      availableFamilies: ['app inspect'],
      instructionFilesDeclared: ['CLAUDE.md'],
      skillsDirectory: '.claude/skills',
      mcp: { shipped: { config: '.mcp.json', tools: ['crm_doctor'] }, enabled: [], disabledBy: '--strict-mcp-config with an empty --mcp-config', why: 'measured on the same surface as every other arm' },
      toolSearch: { setting: 'unset', applicable: false, why: 'no MCP server is configured' },
    },
    observation: { actions: [], approvals: [], transcriptDigest: 'd'.repeat(64), transcriptBytes: 10, exitCode: 0 },
    outcome: 'VALID_RUN',
    outcomeDetail: '',
    scores: Object.fromEntries(METRICS.map((metric) => {
      if (metric.key === 'irrelevantCommandsUsed') return [metric.key, { count: 0, families: [] }];
      if (metric.key === 'toolContextEconomy') return [metric.key, { familiesAvailable: 13, familiesLoaded: null, familiesUsed: 1 }];
      return [metric.key, { value: 'met' }];
    })),
    limitations: ['the fixture is not installed'],
    evidence: { receipt: 'receipt.json', transcript: 'transcript.txt' },
    ...overrides,
  });
}

test('the contract is version 1, and its vocabularies are closed', () => {
  assert.equal(AGENT_TOOL_SELECTION_RUN_CONTRACT, 1);
  assert.deepEqual([...RUN_OUTCOMES], [
    'VALID_RUN', 'NOT_RUN_PROVIDER_UNAVAILABLE',
    'NOT_RUN_BINARY_MISSING', 'NOT_RUN_NO_ADAPTER', 'NOT_RUN_TRANSCRIPT_TRUNCATED', 'NOT_RUN_TREE_DIRTY',
    'AGENT_REFUSED', 'TIMEOUT', 'INVALID_ISOLATION', 'INVALID_FIXTURE',
  ]);
  assert.deepEqual([...SCOREABLE_OUTCOMES], ['VALID_RUN']);
  assert.deepEqual([...METRIC_VALUES], ['met', 'not_met', 'not_applicable', 'unresolved']);
});

test('a well-formed receipt validates', () => {
  const result = validateRun(validReceipt());
  assert.deepEqual(result.problems, []);
  assert.ok(result.valid);
});

test('an unscoreable outcome may not carry scores', () => {
  for (const outcome of RUN_OUTCOMES.filter((entry) => entry !== 'VALID_RUN')) {
    const result = validateRun(validReceipt({ outcome }));
    assert.ok(
      result.problems.some((problem) => problem.code === 'RUN_SCORES_ON_UNSCOREABLE'),
      `${outcome} was allowed to carry a score block`,
    );
  }
});

test('an unavailable arm still produces a complete, valid receipt', () => {
  // The whole denominator rule depends on this: a planned cell that produces no
  // document is a planned cell that quietly leaves the panel.
  const receipt = buildRun({
    ...validReceipt(),
    fingerprint: undefined,
    outcome: 'NOT_RUN_BINARY_MISSING',
    outcomeDetail: 'codex is not on PATH in this environment',
    scores: null,
  });
  const result = validateRun(receipt);
  assert.deepEqual(result.problems, []);
  assert.equal(receipt.outcome, 'NOT_RUN_BINARY_MISSING');
  assert.equal(receipt.scores, null);
});

test('a valid run without a transcript is refused', () => {
  const result = validateRun(validReceipt({
    observation: { actions: [], approvals: [], transcriptDigest: null, transcriptBytes: 0, exitCode: 0 },
  }));
  assert.ok(result.problems.some((problem) => problem.code === 'RUN_MISSING_TRANSCRIPT'));
});

test('a valid run without both fixture fingerprints is refused', () => {
  const result = validateRun(validReceipt({
    fixture: { id: 'clean-valid', initialFingerprint: 'b'.repeat(64), finalFingerprint: null, mutated: null, isolation: { status: 'clean', markersScanned: 7, findings: [] } },
  }));
  assert.ok(result.problems.some((problem) => problem.code === 'RUN_MISSING_FINGERPRINT'));
});

test('a leaked fixture cannot produce a valid run', () => {
  const result = validateRun(validReceipt({
    fixture: {
      id: 'clean-valid', initialFingerprint: 'b'.repeat(64), finalFingerprint: 'b'.repeat(64), mutated: false,
      isolation: { status: 'leaked', markersScanned: 7, findings: [{ marker: 'expectedFirstFamilies', path: 'x.json' }] },
    },
  }));
  assert.ok(result.problems.some((problem) => problem.code === 'RUN_ISOLATION_INVALID'));
});

test('the raw prompt is preserved, not merely digested', () => {
  const result = validateRun(validReceipt({
    prompt: { id: 'TS-01', text: '', textDigest: 'c'.repeat(64), expectedRail: 'SEE', expectedFirstFamilies: ['app inspect'] },
  }));
  assert.ok(result.problems.some((problem) => problem.field === 'prompt.text'));
});

test('unknown keys are refused rather than ignored', () => {
  const receipt = { ...validReceipt(), sneaky: 'value' };
  const result = validateRun(receipt);
  assert.ok(result.problems.some((problem) => problem.code === 'RUN_FIELD_UNKNOWN' && problem.field === 'sneaky'));
});

test('a secret anywhere in a receipt is a refusal, never a scrub', () => {
  // Assembled at runtime rather than written out. A credential-shaped literal in a
  // checked-in file is a secret scanner's problem whether or not it is real, and a
  // test that trips the repository's own security check to prove a point has cost more
  // than it proved.
  const filler = 'abcdefghijklmnopqrstuvwxyz012345';
  for (const value of [
    `sk${'-'}${filler}`,
    `ghp${'_'}${filler}`,
    `Authorization: Bearer ${filler}`,
    `api${'_'}key=${filler}`,
  ]) {
    const result = validateRun(validReceipt({ outcomeDetail: value, outcome: 'TIMEOUT', scores: null }));
    assert.ok(result.problems.some((problem) => problem.code === 'RUN_SECRET_SUSPECTED'), `${value} was allowed through`);
  }
});

test('an absolute path is refused everywhere except captured action text', () => {
  const refused = validateRun(validReceipt({ outcome: 'TIMEOUT', scores: null, outcomeDetail: 'failed under /home/someone/checkout' }));
  assert.ok(refused.problems.some((problem) => problem.code === 'RUN_ABSOLUTE_PATH'));

  // A command the agent actually typed is quoted evidence. Rewriting it would falsify
  // the observation, so the path scan skips it — and the secret scan still does not.
  const captured = validateRun(validReceipt({
    observation: {
      actions: [{ ordinal: 1, tool: 'Bash', raw: 'ls -la /usr/local/lib' }],
      approvals: [], transcriptDigest: 'd'.repeat(64), transcriptBytes: 10, exitCode: 0,
    },
  }));
  assert.deepEqual(captured.problems, []);
});

test('a receipt edited after it was stamped fails its own fingerprint', () => {
  const receipt = validReceipt();
  const tampered = { ...receipt, outcomeDetail: 'edited later' };
  assert.ok(validateRun(tampered).problems.some((problem) => problem.code === 'RUN_FINGERPRINT_MISMATCH'));
});

test('the fingerprint depends on what the receipt says, not on key order', () => {
  const receipt = validReceipt();
  const reordered = Object.fromEntries(Object.entries(receipt).reverse());
  assert.equal(fingerprintRun(reordered), fingerprintRun(receipt));
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  // And it does depend on the content.
  assert.notEqual(fingerprintRun({ ...receipt, outcome: 'TIMEOUT' }), fingerprintRun(receipt));
});

test('a metric with a value outside the vocabulary is refused', () => {
  const receipt = validReceipt();
  const broken = { ...receipt, scores: { ...receipt.scores, correctRail: { value: 'probably' } } };
  assert.ok(validateRun(broken).problems.some((problem) => problem.code === 'RUN_METRIC_VALUE_INVALID'));
});

test('every declared metric names who judges it, and at least one is a person', () => {
  const judges = new Set(METRICS.map((metric) => metric.judge));
  assert.ok(judges.has('mechanical'));
  assert.ok(judges.has('operator'), 'a benchmark that claims to judge meaning mechanically is claiming too much');
});

/** A complete set of protocol inputs, so each test can move exactly one of them. */
function protocolInputs(overrides = {}) {
  return {
    promptSetId: 'TS-v1',
    prompts: [{ id: 'TS-01', text: 'a job', expectedRail: 'SEE', expectedFirstFamilies: ['app inspect'] }],
    fixtures: [{ id: 'clean-valid', composition: ['contracts', 'service'] }],
    ngramWidth: 4,
    cliHelpFingerprint: 'a'.repeat(64),
    skillDescriptionsFingerprint: 'b'.repeat(64),
    permissionProfiles: { guarded: { observesConsent: false } },
    scoreabilityMatrix: { guarded: { noPrematureMutation: 'suspended' } },
    instrumentFingerprint: 'e'.repeat(64),
    milestoneIdentifiersFingerprint: 'm'.repeat(64),
    writeSemantics: [{ path: 'packages/cli/src/commands.js', digest: 'w'.repeat(64) }],
    fixtureFingerprints: { 'clean-valid': { fingerprint: 'a'.repeat(64), files: 616, bytes: 1 } },
    panelProfile: 'guarded',
    ...overrides,
  };
}

/** A value of the same shape that says something else. Used to move an input, whatever it is. */
function moved(value) {
  if (typeof value === 'string') return `${value}-moved`;
  if (typeof value === 'number') return value + 1;
  if (typeof value === 'boolean') return !value;
  if (Array.isArray(value)) return [...value, { moved: true }];
  if (value && typeof value === 'object') return { ...value, moved: true };
  return 'moved';
}

test('every input to the protocol fingerprint moves it, and none of them may be omitted', () => {
  // Derived from the inputs themselves rather than from a list typed beside them. A list
  // is a set of examples, and an input added tomorrow that nobody adds to the list is an
  // input free to change mid-run — which is exactly what happened to the fixture map: the
  // freeze recorded it, the fingerprint did not cover it, and deleting the key moved
  // nothing at all.
  const inputs = protocolInputs();
  const base = protocolFingerprint(inputs);
  assert.ok(Object.keys(inputs).length >= 13, 'the fingerprint has lost inputs');

  for (const key of Object.keys(inputs)) {
    const without = { ...inputs };
    delete without[key];
    assert.throws(
      () => protocolFingerprint(without), new RegExp(key),
      `omitting ${key} was computed rather than refused, which silently declares it free to change mid-run`,
    );
    assert.notEqual(
      protocolFingerprint({ ...inputs, [key]: moved(inputs[key]) }), base,
      `changing ${key} did not stale the protocol`,
    );
  }

  // The two corpus rows are the sharp ones: a future PR that edits `helpText()` or a Skill
  // description moves the surface every prompt was checked against, and a prompt clean
  // against the old text has not been checked against the new one.
  for (const key of ['cliHelpFingerprint', 'skillDescriptionsFingerprint', 'milestoneIdentifiersFingerprint', 'writeSemantics', 'fixtureFingerprints', 'panelProfile']) {
    assert.ok(key in inputs, `${key} is no longer an input to the protocol fingerprint`);
  }

  // And it is stable: same inputs, same value, whatever order they were built in.
  const reordered = Object.fromEntries(Object.entries(protocolInputs()).reverse());
  assert.equal(protocolFingerprint(reordered), base);
});

test('the instrument itself is frozen, not just its inputs', () => {
  // Everything frozen before this covered *input* to the instrument. None of it was the
  // instrument: the parser could change between cell 3 and cell 4 and every receipt would
  // still verify against a fingerprint that never noticed.
  const digests = componentDigests(REPO_ROOT);
  for (const component of Object.keys(INSTRUMENT_COMPONENTS)) {
    assert.match(digests[component] ?? '', /^[a-f0-9]{64}$/, `${component} has no digest`);
  }
  const base = instrumentFingerprint(digests);

  // Any decision-making component moving must move the value.
  for (const component of Object.keys(INSTRUMENT_COMPONENTS)) {
    assert.notEqual(
      instrumentFingerprint({ ...digests, [component]: '0'.repeat(64) }), base,
      `changing ${component} did not move the instrument fingerprint`,
    );
  }
  // A missing digest is refused rather than hashed as absent.
  const incomplete = { ...digests };
  delete incomplete.scoring;
  assert.throws(() => instrumentFingerprint(incomplete), /scoring/);
});

test('the fingerprint module is excluded from its own digest, and says so', () => {
  // Hashing the hasher is circular; hashing it from outside is arbitrary. The choice is
  // declared rather than silent, which is the only version a reviewer can argue with.
  assert.equal(EXCLUDED_FROM_INSTRUMENT.length, 1);
  assert.equal(EXCLUDED_FROM_INSTRUMENT[0].path, 'benchmarks/tool-selection/freeze.js');
  assert.match(EXCLUDED_FROM_INSTRUMENT[0].reason, /circular/i);
  assert.ok(EXCLUDED_FROM_INSTRUMENT[0].reason.length > 80, 'an exclusion needs a reason, not a label');
  // The exclusion list is itself hashed, so quietly adding an exclusion moves the value.
  assert.equal(
    Object.values(INSTRUMENT_COMPONENTS).includes('benchmarks/tool-selection/freeze.js'), false,
    'the fingerprint module must not be inside its own digest set',
  );
  // And the module that decides receipt validity IS inside it, which is why the
  // fingerprint had to move out of contract.js.
  assert.equal(INSTRUMENT_COMPONENTS['run-contract'], 'benchmarks/tool-selection/contract.js');
});

test('a drifted protocol refuses the run and names what moved', () => {
  const digests = componentDigests(REPO_ROOT);
  const frozen = { protocolFingerprint: 'a'.repeat(64), componentDigests: digests };

  // Identical: no refusal.
  assert.doesNotThrow(() => assertProtocolCurrent(frozen, { ...frozen }));

  // A component moved: refused, and the message attributes it, because an unattributed
  // refusal is one the next operator routes around.
  const scoringMoved = { protocolFingerprint: 'b'.repeat(64), componentDigests: { ...digests, scoring: '9'.repeat(64) } };
  assert.throws(() => assertProtocolCurrent(frozen, scoringMoved), (error) => {
    assert.match(error.message, /PROTOCOL_STALE/);
    assert.match(error.message, /scoring/);
    assert.match(error.message, /refused rather than recorded/);
    return true;
  });

  // Inputs drifted but no component moved: the message says so, and names the corpora,
  // because a help-text edit moves the surface every prompt was checked against.
  const inputsMoved = { protocolFingerprint: 'c'.repeat(64), componentDigests: digests };
  assert.throws(() => assertProtocolCurrent(frozen, inputsMoved), /Skill description|corpora|corpus/);
});

/**
 * The repository's generated state and weight. Everything else `DENY` names is an
 * artifact of this benchmark, and is therefore a file this benchmark is responsible for
 * keeping clean. Taking the complement rather than a second hand-written list means a
 * benchmark file added to `DENY` tomorrow is scanned on the commit that adds it.
 */
const NOT_OURS = Object.freeze(['.git', 'node_modules', 'data', '.github', 'site/dist', 'coverage']);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every checked-in file this benchmark owns, as repository-relative paths. */
function ownedFiles() {
  const found = [];
  const walk = (absolute) => {
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute)) walk(join(absolute, entry));
      return;
    }
    found.push(relative(REPO_ROOT, absolute));
  };
  for (const entry of DENY) {
    if (NOT_OURS.includes(entry)) continue;
    walk(join(REPO_ROOT, entry));
  }
  return found.sort();
}

/**
 * The durable form of a lesson that cost this branch a red security check.
 *
 * The contract test proves a receipt *refuses* a credential, and the first draft proved
 * it with credential-shaped literals written into this file. A secret scanner cannot
 * tell a synthetic literal from a real one — GitGuardian read the branch history, found
 * `Authorization: Bearer …` at this file's line 137, and was right to. Assembling those
 * strings at runtime fixed it, but assembly is a convention, and a convention is exactly
 * what a future edit undoes without noticing.
 *
 * So the same patterns the receipt validator uses are pointed at the benchmark's own
 * checked-in files. A literal comes back, this fails, and it fails locally on the commit
 * that writes it rather than in a check run on a pull request.
 */
test('no file this benchmark checks in carries a credential-shaped literal', () => {
  const files = ownedFiles();

  // Anti-vacuity. A scan set that quietly shrank to nothing would pass forever, so the
  // file that actually regressed must be in it, and the set must not collapse.
  assert.ok(
    files.includes(join('tests', 'agent-tool-selection-contract.test.js')),
    'the file that carried the literal is not in its own scan set',
  );
  assert.ok(files.length >= 8, `only ${files.length} benchmark files scanned; the scan set has collapsed`);

  const findings = [];
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      const match = pattern.exec(text);
      if (match) findings.push(`${file}: ${pattern} matched ${JSON.stringify(match[0].slice(0, 40))}`);
    }
  }
  assert.deepEqual(findings, [], `credential-shaped literals are checked in:\n${findings.join('\n')}`);
});

test('the checked-in scan would catch the literal that was removed', () => {
  // The positive control for the test above. Without it, a `SECRET_PATTERNS` edit that
  // neutered every pattern would leave a green scan over a dirty tree. This is the exact
  // string GitGuardian reported, assembled rather than written.
  const filler = 'abcdefghijklmnopqrstuvwxyz';
  const reintroduced = `Authorization: Bearer ${filler}`;
  assert.ok(
    SECRET_PATTERNS.some((pattern) => pattern.test(reintroduced)),
    'the scan no longer detects the literal this test exists because of',
  );
});

// --- plain-data attacks on the receipt ----------------------------------------

test('a transcript digest is checked against the transcript when there is one to check', () => {
  const receipt = validReceipt();
  // Nothing ever verified this. `transcriptDigest` was required to be present and was
  // then believed — a receipt could name any 64 characters and carry a transcript that
  // says something else entirely.
  const problems = validateRun(receipt, { transcript: 'not the transcript this digest describes' }).problems;
  assert.ok(problems.some((problem) => problem.code === 'RUN_TRANSCRIPT_DIGEST_MISMATCH'), JSON.stringify(problems));

  const honest = validReceipt({
    observation: { actions: [], approvals: [], transcriptDigest: createHash('sha256').update('hello').digest('hex'), transcriptBytes: 5, exitCode: 0 },
  });
  assert.deepEqual(validateRun(honest, { transcript: 'hello' }).problems, []);
});

test('a digest that is not a digest is refused', () => {
  const receipt = validReceipt({
    observation: { actions: [], approvals: [], transcriptDigest: 'yes there was a transcript', transcriptBytes: 10, exitCode: 0 },
  });
  assert.ok(validateRun(receipt).problems.some((problem) => problem.field === 'observation.transcriptDigest'));
});

test('a receipt may not disagree with itself about whether the fixture moved', () => {
  const receipt = validReceipt({
    fixture: {
      id: 'clean-valid',
      initialFingerprint: 'b'.repeat(64),
      finalFingerprint: 'e'.repeat(64),
      mutated: false,
      isolation: { status: 'clean', markersScanned: 7, findings: [], residualDisclosures: [] },
      // Null, as the runner writes it: nothing resets a fixture during a cell, and
      // `true` was a value production never produced.
    },
  });
  const problems = validateRun(receipt).problems;
  assert.ok(
    problems.some((problem) => problem.field === 'fixture.mutated'),
    'mutation is the difference between the two fingerprints; a flag that contradicts them is the flag every restraint metric reads',
  );
});

test('two receipts claiming to be the same cell are not two observations', () => {
  const plan = { plannedCells: 2, promptIds: ['TS-01'], armIds: ['claude-code'], repetitions: 2 };
  const first = validReceipt({ runId: 'TS-01-claude-code-TS-v1-a1' });
  // Same cell, different bytes — a re-score, a hand edit, a second attempt written over
  // the first. Both are contract-valid and their fingerprints differ, so a
  // fingerprint-only guard admits both and the panel reports two observations of a cell
  // that ran once.
  const second = validReceipt({ runId: 'TS-01-claude-code-TS-v1-a1', outcomeDetail: 're-scored' });
  assert.notEqual(first.fingerprint, second.fingerprint);
  assert.deepEqual(validateRun(second).problems, []);
  const report = aggregateRuns([first, second], plan);
  assert.equal(report.admission.admitted, 1);
  assert.equal(report.admission.excluded.duplicate, 1);
});

test('two receipts that differ only in a value JSON cannot tell apart are still two receipts', () => {
  const nan = canonicalJson({ turns: Number.NaN });
  const infinite = canonicalJson({ turns: Number.POSITIVE_INFINITY });
  const absent = canonicalJson({ turns: null });
  assert.notEqual(nan, absent, 'NaN and null are not the same observation');
  assert.notEqual(nan, infinite);
});

test('a receipt that is not plain data is a problem, not a stack trace', () => {
  const cyclic = validReceipt();
  // The docstring promises problems rather than exceptions, "because a benchmark that
  // crashes on a malformed receipt loses the receipt". A cycle made it throw a RangeError
  // out of the canonicaliser, losing exactly that receipt.
  cyclic.observation.self = cyclic;
  const result = validateRun(cyclic);
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.code === 'RUN_NOT_PLAIN_DATA'), JSON.stringify(result.problems));

  const nonFinite = validReceipt();
  nonFinite.observation.transcriptBytes = Number.POSITIVE_INFINITY;
  assert.ok(validateRun(nonFinite).problems.some((problem) => problem.code === 'RUN_NOT_PLAIN_DATA'));
});

test('no file this benchmark checks in carries a byte a reviewer cannot see', () => {
  // A raw NUL was sitting inside a template literal in the fixture builder, as the
  // separator between a path and its digest. It is invisible when the file is read, and
  // it is worse than invisible to tooling: `grep -r` classifies the file as binary and
  // *skips* it, so a repository-wide scan silently excluded the module that decides what
  // a fixture is. The separator is still a NUL; it is now spelled `\0`, which is the same
  // byte on disk and a character a reviewer can see.
  const offenders = [];
  for (const file of ownedFiles()) {
    if (!/\.(js|json|md)$/.test(file)) continue;
    const bytes = readFileSync(join(REPO_ROOT, file));
    for (const byte of [0x00, 0x0b, 0x0c, 0x1b, 0x7f]) {
      if (bytes.includes(byte)) offenders.push(`${file}: 0x${byte.toString(16).padStart(2, '0')}`);
    }
  }
  assert.deepEqual(offenders, []);
});
