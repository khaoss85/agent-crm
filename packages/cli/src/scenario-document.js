// @ts-check

import { createHash } from 'node:crypto';
import { canonicalJson, EXECUTABLE_SHAPES } from '../../core/index.js';

/**
 * The **scenario document** — DX6's checked-in, declarative description of one
 * business scenario and the JTBD rows it claims to exercise.
 *
 * A scenario is a *document*, not a script. That is not a style preference: this
 * repository refuses executable commands as trusted content
 * (`docs/CODER_TOOLING_ROADMAP.md` → "Deliberately refused" — *a format that can
 * describe execution invites a runtime, and the first runtime that reads a plan
 * is one edit away from applying it*), and the Solution Plan validator already
 * refuses a plan that carries one. This refuses the same thing, for the same
 * reason, using **the same constant** — `EXECUTABLE_SHAPES` — rather than a
 * second copy that gets fixed once.
 *
 * The refusal has three independent layers, and each is tested:
 *
 * 1. **Shape.** No field in this contract could hold a command. Every object is
 *    checked against a closed key allow-list, so `{"run": "npm test"}` is
 *    refused as `SCENARIO_FIELD_UNKNOWN` *before its value is read*.
 * 2. **Content.** Every string at every depth goes through `EXECUTABLE_SHAPES`:
 *    a shell command, a command substitution, shell chaining, a remote address
 *    or a script tag is `SCENARIO_EXECUTABLE_CONTENT`.
 * 3. **Path.** There is no code path from a document value to an invocation.
 *    The only thing DX6 spawns is a journey chosen by **id** from a frozen
 *    registry in DX6's own source. A scenario cannot name a path, a script, an
 *    argument, an interpreter or an environment variable. The single field that
 *    names a file — a plan citation — is read and validated as a document,
 *    never executed, and is refused if it escapes the project root.
 *
 * This module decides nothing about a project. It parses, refuses and
 * normalizes. Running is `scenario-run-command.js`'s job.
 */

/** The document contract this module understands. */
export const SCENARIO_CONTRACT = 1;

/** A scenario is a document. A runaway one is a defect, not a stream. */
export const MAX_SCENARIO_BYTES = 64 * 1024;
/** Bounds on the text a scenario may publish into a report. */
export const MAX_TEXT = 2_000;
export const MAX_IDENTIFIER = 120;
export const MAX_PATH = 200;
export const MAX_STEPS = 60;
export const MAX_OBSERVATIONS = 40;
export const MAX_CLAIMS = 200;

/**
 * Every problem this module can report. Closed, so a reader can switch on it
 * rather than matching prose.
 */
export const SCENARIO_PROBLEM_CODES = Object.freeze([
  'SCENARIO_UNREADABLE',
  'SCENARIO_TOO_LARGE',
  'SCENARIO_CONTRACT_UNSUPPORTED',
  'SCENARIO_FIELD_INVALID',
  'SCENARIO_FIELD_UNKNOWN',
  'SCENARIO_EXECUTABLE_CONTENT',
  'SCENARIO_VOCABULARY_UNKNOWN',
  'SCENARIO_DUPLICATE_ID',
  'SCENARIO_CITATION_UNRESOLVED',
  'SCENARIO_PATH_REFUSED',
]);

/**
 * The observation vocabulary. **Closed, and owned by DX6, not by the document.**
 *
 * A scenario selects a kind by name and supplies declarative arguments; DX6
 * decides what that means and which authority answers it. This is the same
 * shape DX5 uses for declared scripts — the project declares a name, the
 * framework owns the list — and it is what keeps a scenario from becoming a
 * program.
 *
 * `args` is the closed argument allow-list for the kind. `required` names the
 * arguments that must be present; `oneOf` names groups where exactly one member
 * must be present.
 */
export const OBSERVATION_KINDS = Object.freeze({
  'journey.completed': {
    authority: 'journey',
    args: {},
    required: [],
    oneOf: [],
    describes: 'the journey ran to completion and reported success',
  },
  'journey.count': {
    authority: 'journey',
    args: { metric: 'metric', atLeast: 'count', equals: 'count' },
    required: ['metric'],
    oneOf: [['atLeast', 'equals']],
    describes: 'a numeric metric the journey itself reported',
  },
  'package.composed': {
    authority: 'app-inspect',
    args: { package: 'name' },
    required: ['package'],
    oneOf: [],
    describes: 'the composed application includes this domain package',
  },
  'resource.present': {
    authority: 'app-inspect',
    args: { resource: 'name' },
    required: ['resource'],
    oneOf: [],
    describes: 'a domain package in this composition owns this resource',
  },
  'module.present': {
    authority: 'app-inspect',
    args: { module: 'name' },
    required: ['module'],
    oneOf: [],
    describes: 'the composed application has this record module — a project\'s own generated record, '
      + 'or a package-owned one. Distinct from resource.present, which is specifically package ownership',
  },
  'action.present': {
    authority: 'app-inspect',
    args: { action: 'qualified-name' },
    required: ['action'],
    oneOf: [],
    describes: 'the composed application publishes this module.action',
  },
  'capability.available': {
    authority: 'app-inspect',
    args: { capability: 'name', version: 'count' },
    required: ['capability'],
    oneOf: [],
    describes: 'a declared cross-package capability resolved in this composition',
  },
  'policy.present': {
    authority: 'app-inspect',
    args: { policy: 'name', version: 'count' },
    required: ['policy'],
    oneOf: [],
    describes: 'a versioned policy this composition registered',
  },
  'plan.valid': {
    authority: 'solution-plan',
    args: { plan: 'path' },
    required: ['plan'],
    oneOf: [],
    describes: 'a checked-in Solution Plan this scenario is the evidence run for',
  },
});

/** Keys that pollute a prototype if a document is ever spread into an object. */
const FORBIDDEN_KEYS = Object.freeze(['__proto__', 'constructor', 'prototype']);

/** Closed key allow-lists. A key outside one of these is refused by name. */
const TOP_KEYS = Object.freeze(['scenarioContract', 'id', 'title', 'summary', 'journey', 'steps', 'claims']);
const STEP_KEYS = Object.freeze(['id', 'narrative', 'observe']);
const CLAIM_KEYS = Object.freeze(['job', 'steps', 'note']);

/**
 * Control characters and the two Unicode line separators that break a line in a
 * JSON document without looking like they did. Same set the Solution Plan
 * refuses.
 */
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

/** Value grammars, one per argument type named in `OBSERVATION_KINDS`. */
const GRAMMAR = Object.freeze({
  slug: /^[a-z0-9][a-z0-9-]{0,63}$/,
  name: /^[a-z0-9][a-z0-9._-]{0,63}$/,
  'qualified-name': /^[a-z0-9][a-z0-9-]{0,63}\.[a-z0-9][a-z0-9-]{0,63}$/,
  metric: /^[a-zA-Z][a-zA-Z0-9]{0,63}$/,
  job: /^[A-Z][A-Za-z0-9]{0,15}(?:-[A-Za-z0-9]{1,15}){1,3}$/,
});

/**
 * A repository-relative POSIX path, and nothing that could leave the project.
 * Refused: an absolute path, a `..` segment, a backslash, a drive letter, a null
 * byte, a URL scheme, a leading `~`, or anything over `MAX_PATH`.
 *
 * @param {string} value
 */
export function safeRelativePath(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH) return null;
  if (value.includes('\0') || value.includes('\\')) return null;
  if (value.startsWith('/') || value.startsWith('~') || /^[A-Za-z]:/.test(value)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return null;
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  if (segments.some((segment) => FORBIDDEN_KEYS.includes(segment))) return null;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)) return null;
  return value;
}

/** @typedef {{code: string, path: string, message: string}} ScenarioProblem */

/** @param {ScenarioProblem[]} problems @param {string} code @param {string} path @param {string} message */
function report(problems, code, path, message) {
  problems.push({ code, path, message });
}

/**
 * Parse the document text. Bounded before anything else, so an enormous file is
 * a size refusal rather than a process that grows until something else kills it.
 *
 * @param {string} source
 * @returns {{raw: any, problems: ScenarioProblem[]}}
 */
export function parseScenarioDocument(source) {
  /** @type {ScenarioProblem[]} */
  const problems = [];
  if (typeof source !== 'string') {
    report(problems, 'SCENARIO_UNREADABLE', 'scenario', 'the document is not text');
    return { raw: null, problems };
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SCENARIO_BYTES) {
    report(problems, 'SCENARIO_TOO_LARGE', 'scenario',
      `a scenario document must be at most ${MAX_SCENARIO_BYTES} bytes`);
    return { raw: null, problems };
  }
  let raw;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    report(problems, 'SCENARIO_UNREADABLE', 'scenario',
      `not valid JSON: ${String(/** @type {any} */ (error).message).slice(0, 200)}`);
    return { raw: null, problems };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    report(problems, 'SCENARIO_UNREADABLE', 'scenario', 'a scenario document must be a JSON object');
    return { raw: null, problems };
  }
  return { raw, problems };
}

/**
 * A bounded string with no control character and no executable shape.
 *
 * @param {unknown} value @param {string} path @param {ScenarioProblem[]} problems
 * @param {{max?: number, required?: boolean}} [options]
 * @returns {string|null}
 */
function text(value, path, problems, { max = MAX_TEXT, required = true } = {}) {
  if (value === undefined || value === null) {
    if (required) report(problems, 'SCENARIO_FIELD_INVALID', path, 'is required');
    return null;
  }
  if (typeof value !== 'string') {
    report(problems, 'SCENARIO_FIELD_INVALID', path, 'must be a string');
    return null;
  }
  if (value.trim() === '') {
    report(problems, 'SCENARIO_FIELD_INVALID', path, 'must not be empty');
    return null;
  }
  if (value.length > max) {
    report(problems, 'SCENARIO_FIELD_INVALID', path, `must be at most ${max} characters`);
    return null;
  }
  if (CONTROL_CHARACTERS.test(value)) {
    report(problems, 'SCENARIO_FIELD_INVALID', path, 'must not contain control characters');
    return null;
  }
  for (const shape of EXECUTABLE_SHAPES) {
    if (shape.re.test(value)) {
      report(problems, 'SCENARIO_EXECUTABLE_CONTENT', path,
        `must not contain ${shape.name}. A scenario describes what was observed and the authority that answers it; `
        + 'it never carries something to run, and nothing in this framework would run it');
      return null;
    }
  }
  return value;
}

/**
 * A value matching one of the closed grammars. Grammar first, then the same
 * executable-content refusal — an identifier that somehow satisfies a grammar
 * and still looks like a command is refused twice rather than once.
 *
 * @param {unknown} value @param {string} path @param {keyof GRAMMAR|string} grammar
 * @param {ScenarioProblem[]} problems
 */
function token(value, path, grammar, problems) {
  const raw = text(value, path, problems, { max: MAX_IDENTIFIER });
  if (raw === null) return null;
  const pattern = GRAMMAR[grammar];
  if (!pattern.test(raw)) {
    report(problems, 'SCENARIO_FIELD_INVALID', path, `must match ${String(pattern)}`);
    return null;
  }
  return raw;
}

/** A non-negative integer, refused rather than coerced. */
function count(value, path, problems) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    report(problems, 'SCENARIO_FIELD_INVALID', path, 'must be a non-negative safe integer at most 1000000');
    return null;
  }
  return value;
}

/**
 * Refuse every key outside the allow-list, and every prototype-polluting key,
 * before any value is read.
 *
 * @param {any} node @param {readonly string[]} allowed @param {string} path
 * @param {ScenarioProblem[]} problems
 */
function keysWithin(node, allowed, path, problems) {
  for (const key of Object.keys(node)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      report(problems, 'SCENARIO_FIELD_UNKNOWN', `${path}.${key}`,
        'is a prototype key and is never read');
      continue;
    }
    if (!allowed.includes(key)) {
      report(problems, 'SCENARIO_FIELD_UNKNOWN', `${path}.${key}`,
        `is not part of this contract. A scenario carries only ${allowed.join(', ')} here — `
        + 'there is deliberately no field that could hold something to run');
    }
  }
}

/**
 * Validate and normalize a parsed document.
 *
 * Normalization is total: the returned scenario is a fresh object with a fixed
 * key order and every list in the order the author wrote it (order is meaning in
 * a scenario — steps happen in sequence). Nothing from the input object is
 * carried by reference, so a hostile key cannot ride along.
 *
 * @param {any} raw
 * @returns {{valid: boolean, scenario: any, problems: ScenarioProblem[]}}
 */
export function validateScenarioDocument(raw) {
  /** @type {ScenarioProblem[]} */
  const problems = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    report(problems, 'SCENARIO_UNREADABLE', 'scenario', 'a scenario document must be a JSON object');
    return { valid: false, scenario: null, problems };
  }
  if (raw.scenarioContract !== SCENARIO_CONTRACT) {
    report(problems, 'SCENARIO_CONTRACT_UNSUPPORTED', 'scenario.scenarioContract',
      `must be ${SCENARIO_CONTRACT}; this runner understands no other contract`);
    return { valid: false, scenario: null, problems };
  }
  keysWithin(raw, TOP_KEYS, 'scenario', problems);

  const id = token(raw.id, 'scenario.id', 'slug', problems);
  const title = text(raw.title, 'scenario.title', problems, { max: 200 });
  const summary = text(raw.summary, 'scenario.summary', problems);
  const journey = token(raw.journey, 'scenario.journey', 'slug', problems);

  const steps = readSteps(raw.steps, problems);
  const stepIds = new Set(steps.map((step) => step.id).filter(Boolean));
  const claims = readClaims(raw.claims, stepIds, problems);

  const scenario = {
    scenarioContract: SCENARIO_CONTRACT,
    id: id ?? '',
    title: title ?? '',
    summary: summary ?? '',
    journey: journey ?? '',
    steps,
    claims,
  };
  return { valid: problems.length === 0, scenario, problems };
}

/** @param {unknown} value @param {ScenarioProblem[]} problems */
function readSteps(value, problems) {
  if (!Array.isArray(value)) {
    report(problems, 'SCENARIO_FIELD_INVALID', 'scenario.steps', 'must be an array');
    return [];
  }
  if (value.length === 0) {
    report(problems, 'SCENARIO_FIELD_INVALID', 'scenario.steps',
      'must contain at least one step. A scenario with no step observes nothing and can earn nothing');
    return [];
  }
  if (value.length > MAX_STEPS) {
    report(problems, 'SCENARIO_FIELD_INVALID', 'scenario.steps', `must contain at most ${MAX_STEPS} steps`);
    return [];
  }
  const seen = new Set();
  const steps = [];
  value.forEach((entry, index) => {
    const path = `scenario.steps[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      report(problems, 'SCENARIO_FIELD_INVALID', path, 'must be an object');
      return;
    }
    keysWithin(entry, STEP_KEYS, path, problems);
    const id = token(entry.id, `${path}.id`, 'slug', problems);
    const narrative = text(entry.narrative, `${path}.narrative`, problems);
    if (id !== null) {
      if (seen.has(id)) {
        report(problems, 'SCENARIO_DUPLICATE_ID', `${path}.id`, `step id "${id}" is used more than once`);
      }
      seen.add(id);
    }
    steps.push({
      id: id ?? '',
      narrative: narrative ?? '',
      observe: readObservations(entry.observe, `${path}.observe`, problems),
    });
  });
  return steps;
}

/** @param {unknown} value @param {string} path @param {ScenarioProblem[]} problems */
function readObservations(value, path, problems) {
  if (!Array.isArray(value)) {
    report(problems, 'SCENARIO_FIELD_INVALID', path, 'must be an array');
    return [];
  }
  if (value.length === 0) {
    report(problems, 'SCENARIO_FIELD_INVALID', path,
      'must declare at least one observation. A step that observes nothing is narration, not evidence');
    return [];
  }
  if (value.length > MAX_OBSERVATIONS) {
    report(problems, 'SCENARIO_FIELD_INVALID', path, `must declare at most ${MAX_OBSERVATIONS} observations`);
    return [];
  }
  const observations = [];
  value.forEach((entry, index) => {
    const at = `${path}[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      report(problems, 'SCENARIO_FIELD_INVALID', at, 'must be an object');
      return;
    }
    const kind = typeof entry.kind === 'string' ? entry.kind : null;
    if (kind === null || !Object.prototype.hasOwnProperty.call(OBSERVATION_KINDS, kind)) {
      report(problems, 'SCENARIO_VOCABULARY_UNKNOWN', `${at}.kind`,
        `must be one of ${Object.keys(OBSERVATION_KINDS).join(', ')}. `
        + 'The vocabulary belongs to the runner, not to the document');
      return;
    }
    const spec = OBSERVATION_KINDS[kind];
    keysWithin(entry, ['kind', ...Object.keys(spec.args)], at, problems);

    /** @type {Record<string, any>} */
    const args = {};
    for (const [name, grammar] of Object.entries(spec.args)) {
      if (!Object.prototype.hasOwnProperty.call(entry, name)) continue;
      const argPath = `${at}.${name}`;
      const parsed = grammar === 'count' ? count(entry[name], argPath, problems)
        : grammar === 'path' ? readPath(entry[name], argPath, problems)
          : token(entry[name], argPath, grammar, problems);
      if (parsed !== null) args[name] = parsed;
    }
    for (const name of spec.required) {
      if (!(name in args)) {
        report(problems, 'SCENARIO_FIELD_INVALID', `${at}.${name}`, `is required for ${kind}`);
      }
    }
    for (const group of spec.oneOf) {
      const present = group.filter((name) => name in args);
      if (present.length !== 1) {
        report(problems, 'SCENARIO_FIELD_INVALID', at,
          `${kind} needs exactly one of ${group.join(' or ')}; found ${present.length}`);
      }
    }
    observations.push({ kind, ...sortedArgs(args) });
  });
  return observations;
}

/** A file citation: repository-relative, refused if it could leave the project. */
function readPath(value, path, problems) {
  const raw = text(value, path, problems, { max: MAX_PATH });
  if (raw === null) return null;
  const safe = safeRelativePath(raw);
  if (safe === null) {
    report(problems, 'SCENARIO_PATH_REFUSED', path,
      'must be a repository-relative POSIX path with no "..", no absolute prefix, no backslash and no URL scheme. '
      + 'It is read as a document and never executed');
    return null;
  }
  return safe;
}

/** @param {Record<string, any>} args */
function sortedArgs(args) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of Object.keys(args).sort()) out[key] = args[key];
  return out;
}

/** @param {unknown} value @param {Set<string>} stepIds @param {ScenarioProblem[]} problems */
function readClaims(value, stepIds, problems) {
  if (!Array.isArray(value)) {
    report(problems, 'SCENARIO_FIELD_INVALID', 'scenario.claims', 'must be an array');
    return [];
  }
  if (value.length === 0) {
    report(problems, 'SCENARIO_FIELD_INVALID', 'scenario.claims',
      'must contain at least one claim. A scenario that claims no JTBD row produces no evidence anybody asked for');
    return [];
  }
  if (value.length > MAX_CLAIMS) {
    report(problems, 'SCENARIO_FIELD_INVALID', 'scenario.claims', `must contain at most ${MAX_CLAIMS} claims`);
    return [];
  }
  const seen = new Set();
  const claims = [];
  value.forEach((entry, index) => {
    const path = `scenario.claims[${index}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      report(problems, 'SCENARIO_FIELD_INVALID', path, 'must be an object');
      return;
    }
    keysWithin(entry, CLAIM_KEYS, path, problems);
    const job = token(entry.job, `${path}.job`, 'job', problems);
    const note = text(entry.note, `${path}.note`, problems, { required: false });
    if (job !== null) {
      if (seen.has(job)) {
        report(problems, 'SCENARIO_DUPLICATE_ID', `${path}.job`, `job "${job}" is claimed more than once`);
      }
      seen.add(job);
    }
    const cited = [];
    if (!Array.isArray(entry.steps) || entry.steps.length === 0) {
      report(problems, 'SCENARIO_FIELD_INVALID', `${path}.steps`,
        'must cite at least one step. A claim with no cited step is an assertion, not evidence');
    } else if (entry.steps.length > MAX_STEPS) {
      report(problems, 'SCENARIO_FIELD_INVALID', `${path}.steps`, `must cite at most ${MAX_STEPS} steps`);
    } else {
      entry.steps.forEach((stepId, at) => {
        const parsed = token(stepId, `${path}.steps[${at}]`, 'slug', problems);
        if (parsed === null) return;
        if (!stepIds.has(parsed)) {
          report(problems, 'SCENARIO_CITATION_UNRESOLVED', `${path}.steps[${at}]`,
            `cites step "${parsed}", which this scenario does not declare`);
          return;
        }
        cited.push(parsed);
      });
    }
    claims.push({ job: job ?? '', steps: cited, note: note ?? '' });
  });
  return claims;
}

/**
 * The document's own fingerprint: what the scenario *says*, canonically
 * ordered. It travels in the report so a reader can tell "the same scenario ran
 * again" from "the scenario changed".
 *
 * @param {any} scenario a normalized scenario
 */
export function scenarioFingerprint(scenario) {
  return createHash('sha256').update(canonicalJson(scenario)).digest('hex');
}

/**
 * The published vocabulary, for a caller that wants to render or check a
 * scenario without importing this module's internals.
 */
export function scenarioVocabulary() {
  return {
    scenarioContract: SCENARIO_CONTRACT,
    problemCodes: [...SCENARIO_PROBLEM_CODES],
    observationKinds: Object.entries(OBSERVATION_KINDS).map(([kind, spec]) => ({
      kind,
      authority: spec.authority,
      describes: spec.describes,
      args: Object.keys(spec.args).sort(),
      required: [...spec.required].sort(),
    })),
    rule: 'a scenario is non-executable by contract: no field in the shape could hold a command, '
      + 'every string is refused if it looks like one, and there is no code path from a document value to an invocation',
    refusedShapes: EXECUTABLE_SHAPES.map((shape) => shape.name),
  };
}
