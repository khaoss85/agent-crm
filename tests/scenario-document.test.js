import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  MAX_SCENARIO_BYTES, OBSERVATION_KINDS, SCENARIO_CONTRACT, SCENARIO_PROBLEM_CODES,
  parseScenarioDocument, safeRelativePath, scenarioFingerprint, scenarioVocabulary,
  validateScenarioDocument,
} from '../packages/cli/src/scenario-document.js';
import { EXECUTABLE_SHAPES } from '../packages/core/index.js';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * DX6's document contract. A scenario is a *document*, not a script, and this
 * file is mostly about what it refuses: the repository refuses executable
 * commands as trusted content, and a contract that merely documents that
 * refusal has not made it.
 */

/** A minimal document that passes, used as the base every hostile case mutates. */
const base = () => ({
  scenarioContract: 1,
  id: 'sample',
  title: 'A sample scenario',
  summary: 'One business process, observed.',
  journey: 'b2b-lead-qualification',
  steps: [{ id: 'first', narrative: 'something happens', observe: [{ kind: 'journey.completed' }] }],
  claims: [{ job: 'JTBD-04', steps: ['first'], note: 'narrow' }],
});

/** @param {any} document */
function validate(document) {
  const parsed = parseScenarioDocument(JSON.stringify(document));
  if (parsed.raw === null) return { valid: false, scenario: null, problems: parsed.problems };
  return validateScenarioDocument(parsed.raw);
}

/** @param {any} document */
function codes(document) {
  return [...new Set(validate(document).problems.map((problem) => problem.code))].sort();
}

test('a well-formed scenario normalizes, and its fingerprint is stable', () => {
  const result = validate(base());
  assert.equal(result.valid, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.scenario.scenarioContract, SCENARIO_CONTRACT);
  assert.equal(result.scenario.steps.length, 1);
  // Normalization is total: nothing rides along from the input object.
  assert.deepEqual(Object.keys(result.scenario), ['scenarioContract', 'id', 'title', 'summary', 'journey', 'steps', 'claims']);
  assert.equal(scenarioFingerprint(result.scenario), scenarioFingerprint(validate(base()).scenario));
});

test('the fingerprint changes when the scenario says something different', () => {
  const one = scenarioFingerprint(validate(base()).scenario);
  const other = validate({ ...base(), claims: [{ job: 'JTBD-05', steps: ['first'], note: 'narrow' }] });
  assert.notEqual(scenarioFingerprint(other.scenario), one);
});

// --- layer 1: shape. No field could hold a command. -------------------------

test('a field that could hold a command is refused by NAME, before its value is read', () => {
  for (const field of ['run', 'command', 'script', 'exec', 'shell', 'cmd', 'args', 'env']) {
    const document = { ...base(), [field]: 'npm test' };
    assert.deepEqual(codes(document), ['SCENARIO_FIELD_UNKNOWN'], `${field} must be refused by name`);
  }
});

test('the closed key allow-list holds at every depth', () => {
  assert.deepEqual(codes({ ...base(), steps: [{ id: 'first', narrative: 'n', observe: [{ kind: 'journey.completed' }], run: 'x' }] }),
    ['SCENARIO_FIELD_UNKNOWN']);
  assert.deepEqual(codes({ ...base(), claims: [{ job: 'JTBD-04', steps: ['first'], run: 'x' }] }),
    ['SCENARIO_FIELD_UNKNOWN']);
  assert.deepEqual(codes({ ...base(), steps: [{ id: 'first', narrative: 'n', observe: [{ kind: 'journey.completed', command: 'x' }] }] }),
    ['SCENARIO_FIELD_UNKNOWN']);
});

// --- layer 2: content. Every string is refused if it looks like a command. ---

test('every executable shape the Solution Plan refuses, this refuses too — from the same constant', () => {
  const hostile = {
    'shell command': 'first run npm run verify and then look',
    'command substitution': 'the total is $(rm -rf /) leads',
    'shell chaining': 'do this && then that',
    'a remote address': 'evidence at https://example.com/proof',
    'a script tag': 'a <script>alert(1)</script> tag',
  };
  // The list is not transcribed here: it comes from the one authority.
  assert.deepEqual(EXECUTABLE_SHAPES.map((shape) => shape.name).sort(), Object.keys(hostile).sort());
  for (const [name, value] of Object.entries(hostile)) {
    assert.deepEqual(codes({ ...base(), summary: value }), ['SCENARIO_EXECUTABLE_CONTENT'], name);
    assert.deepEqual(codes({ ...base(), title: value }), ['SCENARIO_EXECUTABLE_CONTENT'], `${name} in title`);
    assert.deepEqual(
      codes({ ...base(), steps: [{ id: 'first', narrative: value, observe: [{ kind: 'journey.completed' }] }] }),
      ['SCENARIO_EXECUTABLE_CONTENT'], `${name} in a narrative`,
    );
    assert.deepEqual(
      codes({ ...base(), claims: [{ job: 'JTBD-04', steps: ['first'], note: value }] }),
      ['SCENARIO_EXECUTABLE_CONTENT'], `${name} in a claim note`,
    );
  }
});

test('control characters and Unicode line separators are refused', () => {
  for (const character of ['\u0000', '\u001b', '\u2028', '\u2029', '\u007f']) {
    assert.deepEqual(codes({ ...base(), summary: `lead${character}injected` }), ['SCENARIO_FIELD_INVALID'],
      `U+${character.codePointAt(0).toString(16)}`);
  }
});

test('oversized strings and oversized documents are refused rather than truncated', () => {
  assert.deepEqual(codes({ ...base(), title: 'x'.repeat(5_000) }), ['SCENARIO_FIELD_INVALID']);
  const huge = JSON.stringify({ ...base(), summary: 'y'.repeat(MAX_SCENARIO_BYTES) });
  assert.deepEqual(parseScenarioDocument(huge).problems.map((p) => p.code), ['SCENARIO_TOO_LARGE']);
});

// --- layer 3: path. Nothing may leave the project, and nothing is executed. --

test('a plan citation may not escape the project, and may not be a URL', () => {
  const cite = (plan) => codes({
    ...base(),
    steps: [{ id: 'first', narrative: 'n', observe: [{ kind: 'plan.valid', plan }] }],
  });
  for (const hostile of ['../../../etc/passwd', '/etc/passwd', 'C:\\windows\\system32', 'plans\\..\\..\\x.json', '~/secrets.json']) {
    assert.ok(cite(hostile).includes('SCENARIO_PATH_REFUSED'), hostile);
  }
  // A URL is caught one layer earlier, by the executable-content refusal.
  assert.ok(cite('https://example.com/plan.json').includes('SCENARIO_EXECUTABLE_CONTENT'));
  assert.deepEqual(cite('examples/solution-plans/lead-to-won.plan.json'), []);
});

test('safeRelativePath refuses every traversal shape and accepts an ordinary path', () => {
  for (const hostile of ['/abs', '../up', 'a/../b', 'a//b', './a', 'a\\b', 'file:///x', '~/x', 'a/__proto__/b', '', 'x'.repeat(500)]) {
    assert.equal(safeRelativePath(hostile), null, hostile);
  }
  assert.equal(safeRelativePath('examples/scenarios/lead-to-won.scenario.json'), 'examples/scenarios/lead-to-won.scenario.json');
});

// --- prototype safety --------------------------------------------------------

test('prototype keys are refused and nothing is polluted', () => {
  const raw = JSON.parse('{"scenarioContract":1,"id":"x","title":"T","summary":"S",'
    + '"journey":"b2b-lead-qualification","__proto__":{"polluted":true},'
    + '"steps":[{"id":"a","narrative":"n","observe":[{"kind":"journey.completed"}]}],'
    + '"claims":[{"job":"JTBD-04","steps":["a"],"note":"n"}]}');
  const result = validateScenarioDocument(raw);
  assert.ok(result.problems.some((problem) => problem.code === 'SCENARIO_FIELD_UNKNOWN'));
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  // And as a value, not only as a key.
  for (const field of ['id', 'journey']) {
    assert.deepEqual(codes({ ...base(), [field]: '__proto__' }), ['SCENARIO_FIELD_INVALID'], field);
  }
});

// --- the vocabulary is closed and owned by the runner ------------------------

test('an observation kind outside the vocabulary is refused, with the vocabulary named', () => {
  const result = validate({
    ...base(),
    steps: [{ id: 'first', narrative: 'n', observe: [{ kind: 'shell.exec', command: 'ls' }] }],
  });
  const problem = result.problems.find((entry) => entry.code === 'SCENARIO_VOCABULARY_UNKNOWN');
  assert.ok(problem, 'an unknown kind must be refused');
  assert.match(problem.message, /journey\.completed/);
  assert.match(problem.message, /belongs to the runner/);
});

test('every declared kind states an authority, and the vocabulary is published', () => {
  const published = scenarioVocabulary();
  assert.equal(published.scenarioContract, SCENARIO_CONTRACT);
  assert.deepEqual(published.observationKinds.map((entry) => entry.kind).sort(), Object.keys(OBSERVATION_KINDS).sort());
  for (const entry of published.observationKinds) {
    assert.ok(['journey', 'app-inspect', 'solution-plan'].includes(entry.authority), entry.kind);
  }
  assert.deepEqual(published.refusedShapes.sort(), EXECUTABLE_SHAPES.map((shape) => shape.name).sort());
  assert.match(published.rule, /no code path from a document value to an invocation/);
});

test('an observation argument is checked against its own grammar', () => {
  const observe = (entry) => codes({ ...base(), steps: [{ id: 'first', narrative: 'n', observe: [entry] }] });
  assert.deepEqual(observe({ kind: 'journey.count', metric: 'leads', atLeast: '3' }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'journey.count', metric: 'leads', atLeast: -1 }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'journey.count', metric: 'leads', atLeast: 1.5 }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'journey.count', metric: 'leads' }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'journey.count', metric: 'leads', atLeast: 3, equals: 3 }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'action.present', action: 'not-qualified' }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'action.present', action: 'lead.qualify' }), []);
});

// --- the argument the second consumer needed ----------------------------------

test('a stated fact takes one lower-case token, and nothing that reads as a sentence or a command', () => {
  const observe = (entry) => codes({ ...base(), steps: [{ id: 'first', narrative: 'n', observe: [entry] }] });
  assert.deepEqual(observe({ kind: 'journey.fact', fact: 'slaState', is: 'breached' }), []);
  assert.deepEqual(observe({ kind: 'journey.fact', fact: 'notified', is: 'false' }), []);
  // Both arguments are required: a fact with no expected value observes nothing,
  // and a value with no fact names nothing.
  assert.deepEqual(observe({ kind: 'journey.fact', fact: 'slaState' }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'journey.fact', is: 'breached' }), ['SCENARIO_FIELD_INVALID']);
  // The value grammar is one token, so a sentence, a capital, a number and a
  // path are refused — and a command is refused twice, by grammar and by shape.
  assert.deepEqual(observe({ kind: 'journey.fact', fact: 'slaState', is: 'at risk' }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'journey.fact', fact: 'slaState', is: 'Breached' }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'journey.fact', fact: 'slaState', is: 3 }), ['SCENARIO_FIELD_INVALID']);
  assert.deepEqual(observe({ kind: 'journey.fact', fact: 'slaState', is: '../etc/passwd' }), ['SCENARIO_FIELD_INVALID']);
  assert.ok(observe({ kind: 'journey.fact', fact: 'slaState', is: '$(id)' }).includes('SCENARIO_EXECUTABLE_CONTENT'));
  // And the kind's own key allow-list still holds: nothing else may ride along.
  assert.deepEqual(
    observe({ kind: 'journey.fact', fact: 'slaState', is: 'breached', shell: 'sh' }),
    ['SCENARIO_FIELD_UNKNOWN'],
  );
});

// --- citations fail closed ----------------------------------------------------

test('a claim that cites a step the scenario does not declare is refused', () => {
  assert.deepEqual(codes({ ...base(), claims: [{ job: 'JTBD-04', steps: ['missing'] }] }),
    ['SCENARIO_CITATION_UNRESOLVED']);
  assert.deepEqual(codes({ ...base(), claims: [{ job: 'JTBD-04', steps: [] }] }),
    ['SCENARIO_FIELD_INVALID']);
});

test('a duplicated step id or job is refused rather than silently collapsed', () => {
  assert.deepEqual(codes({
    ...base(),
    steps: [
      { id: 'first', narrative: 'a', observe: [{ kind: 'journey.completed' }] },
      { id: 'first', narrative: 'b', observe: [{ kind: 'journey.completed' }] },
    ],
  }), ['SCENARIO_DUPLICATE_ID']);
  assert.deepEqual(codes({
    ...base(),
    claims: [{ job: 'JTBD-04', steps: ['first'] }, { job: 'JTBD-04', steps: ['first'] }],
  }), ['SCENARIO_DUPLICATE_ID']);
});

test('a scenario with no step, or no claim, is refused: it could only produce silence', () => {
  assert.ok(codes({ ...base(), steps: [] }).includes('SCENARIO_FIELD_INVALID'));
  assert.deepEqual(codes({ ...base(), claims: [] }), ['SCENARIO_FIELD_INVALID']);
  assert.ok(codes({ ...base(), steps: [{ id: 'first', narrative: 'n', observe: [] }] })
    .includes('SCENARIO_FIELD_INVALID'));
});

test('an unsupported contract and an unreadable document are distinguished', () => {
  assert.deepEqual(codes({ ...base(), scenarioContract: 2 }), ['SCENARIO_CONTRACT_UNSUPPORTED']);
  assert.deepEqual(parseScenarioDocument('not json {').problems.map((p) => p.code), ['SCENARIO_UNREADABLE']);
  assert.deepEqual(parseScenarioDocument('[]').problems.map((p) => p.code), ['SCENARIO_UNREADABLE']);
});

test('every code this module can report is in the published list', () => {
  const published = new Set(SCENARIO_PROBLEM_CODES);
  const observed = [
    codes({ ...base(), scenarioContract: 2 }),
    codes({ ...base(), run: 'x' }),
    codes({ ...base(), summary: 'run npm test now' }),
    codes({ ...base(), title: '' }),
    codes({ ...base(), steps: [{ id: 'a', narrative: 'n', observe: [{ kind: 'nope' }] }] }),
    codes({ ...base(), claims: [{ job: 'JTBD-04', steps: ['gone'] }] }),
    codes({ ...base(), steps: [{ id: 'a', narrative: 'n', observe: [{ kind: 'plan.valid', plan: '/etc/passwd' }] }] }),
    parseScenarioDocument('nope').problems.map((p) => p.code),
  ].flat();
  for (const code of observed) assert.ok(published.has(code), `${code} must be published`);
});

// --- the shipped scenario ------------------------------------------------------

test('every shipped scenario is a valid document, and carries nothing runnable', () => {
  const shipped = readdirSync(new URL('../examples/scenarios/', import.meta.url)).sort();
  assert.deepEqual(shipped, [
    'contract-renewal-execution.scenario.json',
    'lead-to-won.scenario.json',
    'service-sla-escalation.scenario.json',
  ], 'a contract validated by exactly one consumer is not validated');

  for (const file of shipped) {
    const source = readFileSync(new URL(`../examples/scenarios/${file}`, import.meta.url), 'utf8');
    const parsed = parseScenarioDocument(source);
    assert.deepEqual(parsed.problems, [], file);
    const result = validateScenarioDocument(parsed.raw);
    assert.deepEqual(result.problems, [], `${file} must validate`);
    assert.equal(result.valid, true);
    // Every claim cites a declared step, and every observation uses a declared kind.
    const stepIds = new Set(result.scenario.steps.map((step) => step.id));
    for (const claim of result.scenario.claims) {
      assert.ok(claim.steps.length > 0, `${claim.job} must cite a step`);
      for (const id of claim.steps) assert.ok(stepIds.has(id), `${claim.job} cites ${id}`);
    }
    for (const step of result.scenario.steps) {
      for (const observation of step.observe) {
        assert.ok(Object.prototype.hasOwnProperty.call(OBSERVATION_KINDS, observation.kind), observation.kind);
      }
    }
    // The whole document, serialized, contains nothing an executable-shape refusal
    // would accept — belt and braces over the field-by-field check.
    assert.ok(!source.includes('"command"'), file);
    assert.ok(!source.includes('"script"'), file);
    assert.ok(!source.includes('"env"'), file);
    assert.ok(!source.includes(repoRoot), `${file} must not carry a machine path`);
  }
});
