// @ts-check

/**
 * The prompt matrix, and the mechanical proof that no prompt names a command.
 *
 * The single claim this benchmark rests on is that an agent was given a *job* and
 * chose a rail unaided. One command name anywhere in a prompt destroys that claim for
 * the whole set, and a leak is exactly the kind of thing a careful person reads past
 * on the fourth review. So it is a scan, and the scan runs in the suite.
 *
 * ## The scan is deliberately over-inclusive
 *
 * The lexicon is derived from the CLI's own help text (`surface.js`), and every token
 * of every command name is refused, not just the two-word command phrases. That
 * refuses ordinary English words — `check`, `plan`, `test`, `run`, `create`, `list`,
 * `project`, `package` — and it makes prompts harder to write.
 *
 * That trade is deliberate and it is one-directional. An over-inclusive scan costs
 * prompt-writing effort and nothing else; an under-inclusive one silently invalidates
 * every number the set ever produces. "Is this application healthy?" is a prompt an
 * agent could answer by pattern-matching a word rather than by understanding a job,
 * and the whole instrument is about the difference.
 *
 * Two narrow allowances, each with its reason, because a scan with no allowances
 * becomes a scan people route around:
 *
 * 1. **A backticked path is a location, not a command.** A span in backticks that
 *    looks like a filesystem path and contains a `/` is removed before the token
 *    scan, so a prompt may say where a file is. Any other backticked span is scanned
 *    normally, so `` `accordo app inspect` `` cannot hide inside backticks.
 * 2. **`PROMPT_TOKEN_EXEMPTIONS` is empty on purpose.** It exists so that arguing one
 *    token back is a reviewable edit to this file with a reason attached — the same
 *    mechanism as `DATED_HISTORY` in `scripts/measurement.js` and the ceilings in
 *    `scripts/surface-check.js`. It is empty today because no prompt needed it.
 *
 * The command *phrase* scan runs over the raw text, before any allowance, so neither
 * of the above can be used to smuggle a command name through.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { FAMILY_RAILS, RAILS, proseOverlap, readAccordoSurface } from './surface.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The prompt-set contract. Bumped when the shape changes in a way a reader must notice. */
export const PROMPT_SET_CONTRACT = 1;

/**
 * Tokens argued back into ordinary English. Empty, and an addition needs a reason
 * here — not a quiet edit to a prompt.
 * @type {string[]}
 */
export const PROMPT_TOKEN_EXEMPTIONS = Object.freeze([]);

/**
 * Rail identifiers a prompt must not carry. The six rails are a closed vocabulary this
 * benchmark owns, so they are listed; the milestone identifiers are the repository's and
 * are **read from it** — `surface.milestoneIdentifiers`. They used to be twelve typed in
 * here, against twenty-five in `docs/`, which left thirteen of them passing clean.
 * @param {{ milestoneIdentifiers?: string[] }} surface
 */
function railLeaks(surface) {
  return [...RAILS, ...(surface?.milestoneIdentifiers ?? [])];
}

/** Every way a prompt can name the surface. Closed, so a reader can switch on it. */
export const PROMPT_LEAK_CODES = Object.freeze([
  'PROMPT_NAMES_COMMAND',
  'PROMPT_NAMES_COMMAND_TOKEN',
  'PROMPT_NAMES_BINARY',
  'PROMPT_NAMES_SCRIPT',
  'PROMPT_NAMES_TOOL',
  'PROMPT_NAMES_FLAG',
  'PROMPT_NAMES_RAIL',
]);

/** Every way the matrix itself can be malformed. */
export const PROMPT_SET_PROBLEM_CODES = Object.freeze([
  'PROMPT_SET_CONTRACT_UNSUPPORTED',
  'PROMPT_SET_FIELD_MISSING',
  'PROMPT_SET_FIELD_INVALID',
  'PROMPT_SET_DUPLICATE_ID',
  'PROMPT_SET_UNKNOWN_RAIL',
  'PROMPT_SET_UNKNOWN_FAMILY',
  'PROMPT_SET_RAIL_MISMATCH',
  'PROMPT_SET_LEAK',
]);

/** Bounds. An oversized matrix fails as an explained refusal, never as a hang. */
export const MAX_PROMPT_TEXT = 1_200;
export const MAX_PROMPTS = 100;

/** The mutation expectations a prompt may declare. */
export const MUTATION_EXPECTATIONS = Object.freeze(['none', 'forbidden', 'dry-run-or-approval']);

/**
 * Load and fully validate the checked-in matrix.
 * @param {string} repoRoot
 */
export function loadPromptMatrix(repoRoot) {
  const raw = JSON.parse(readFileSync(join(HERE, 'prompts.json'), 'utf8'));
  const surface = readAccordoSurface(repoRoot);
  return { ...validatePromptMatrix(raw, surface), surface };
}

/**
 * @param {any} document
 * @param {ReturnType<typeof readAccordoSurface>} surface
 */
export function validatePromptMatrix(document, surface) {
  /** @type {Array<{ code: string, promptId: string | null, detail: string }>} */
  const problems = [];
  const push = (code, promptId, detail) => problems.push({ code, promptId, detail });

  if (document?.toolSelectionPromptSet !== PROMPT_SET_CONTRACT) {
    push('PROMPT_SET_CONTRACT_UNSUPPORTED', null, `toolSelectionPromptSet must be ${PROMPT_SET_CONTRACT}`);
    return { setId: null, prompts: [], problems, valid: false };
  }
  const prompts = Array.isArray(document.prompts) ? document.prompts : [];
  if (prompts.length === 0) push('PROMPT_SET_FIELD_MISSING', null, 'prompts[] is empty');
  if (prompts.length > MAX_PROMPTS) push('PROMPT_SET_FIELD_INVALID', null, `more than ${MAX_PROMPTS} prompts`);

  /** @type {Set<string>} */
  const seen = new Set();
  for (const prompt of prompts) {
    const id = typeof prompt?.id === 'string' ? prompt.id : '';
    if (!/^TS-\d{2}$/.test(id)) { push('PROMPT_SET_FIELD_INVALID', id || null, 'id must look like TS-07'); continue; }
    if (seen.has(id)) push('PROMPT_SET_DUPLICATE_ID', id, 'id used twice');
    seen.add(id);

    for (const field of ['job', 'fixture', 'prompt', 'expectedRail', 'justification', 'wrongRailAttractor', 'mutationExpected']) {
      if (typeof prompt[field] !== 'string' || prompt[field].trim() === '') push('PROMPT_SET_FIELD_MISSING', id, field);
    }
    if (typeof prompt.prompt === 'string' && prompt.prompt.length > MAX_PROMPT_TEXT) {
      push('PROMPT_SET_FIELD_INVALID', id, `prompt text over ${MAX_PROMPT_TEXT} characters`);
    }
    if (!MUTATION_EXPECTATIONS.includes(prompt.mutationExpected)) {
      push('PROMPT_SET_FIELD_INVALID', id, `mutationExpected must be one of ${MUTATION_EXPECTATIONS.join(', ')}`);
    }
    if (!RAILS.includes(prompt.expectedRail)) push('PROMPT_SET_UNKNOWN_RAIL', id, String(prompt.expectedRail));

    const families = Array.isArray(prompt.expectedFirstFamilies) ? prompt.expectedFirstFamilies : [];
    if (families.length === 0) push('PROMPT_SET_FIELD_MISSING', id, 'expectedFirstFamilies');
    const alternatives = Array.isArray(prompt.railAlternatives) ? prompt.railAlternatives : [];
    for (const rail of alternatives) {
      if (!RAILS.includes(rail)) push('PROMPT_SET_UNKNOWN_RAIL', id, `railAlternatives: ${rail}`);
    }
    for (const family of families) {
      if (!(family in FAMILY_RAILS)) { push('PROMPT_SET_UNKNOWN_FAMILY', id, String(family)); continue; }
      // A prompt whose declared first family sits on another rail is a contradiction in
      // the matrix, not a finding about an agent — unless the prompt *declares* the
      // second rail in `railAlternatives`. There is deliberately no blanket allowance
      // (an earlier draft let any SEE family through, which would have quietly excused
      // discovery-first on every prompt in the set): two prompts genuinely admit two
      // rails, and both say so and say why in their justification.
      const rail = FAMILY_RAILS[/** @type {keyof typeof FAMILY_RAILS} */ (family)];
      if (rail !== prompt.expectedRail && !alternatives.includes(rail)) {
        push('PROMPT_SET_RAIL_MISMATCH', id, `${family} is a ${rail} family but the prompt expects ${prompt.expectedRail} and declares no alternative`);
      }
    }

    for (const leak of scanPromptForSurfaceLeak(String(prompt.prompt ?? ''), surface)) {
      push('PROMPT_SET_LEAK', id, `${leak.code}: ${leak.phrase}`);
    }
    // The prose guard, **run** rather than merely pinned. The freeze covered its n-gram
    // width and the commit message said it "refuses" a prompt that borrows the framework's
    // sentences — and nothing called it outside a test, which is the third instance of the
    // same shape as the freeze gate itself. A guard the loader does not run is a guard the
    // matrix is not checked by.
    for (const gram of proseOverlap(String(prompt.prompt ?? ''), surface)) {
      push('PROMPT_SET_LEAK', id, `PROMPT_BORROWS_PROSE: ${gram}`);
    }
  }

  return {
    // **Derived from the prompt bytes**, not read from the document. A hand-supplied id is
    // a label the author controls: two different prompt sets could both call themselves
    // `TS-v1` and pool into one panel, and the guard comparing them would agree. The
    // declared value is kept beside it so a mismatch is visible rather than silent.
    setId: derivePromptSetId(prompts),
    declaredSetId: typeof document.setId === 'string' ? document.setId : null,
    prompts,
    problems,
    valid: problems.length === 0,
  };
}

/**
 * The prompt set's identity, computed from what the prompts *say*.
 *
 * `TS-v` plus a short digest over the id, text, expected rail and expected families of
 * every prompt, in order. Editing a prompt changes the set id; renaming the set does not.
 * @param {any[]} prompts
 */
export function derivePromptSetId(prompts) {
  const canonical = (Array.isArray(prompts) ? prompts : []).map((prompt) => [
    String(prompt?.id ?? ''),
    String(prompt?.prompt ?? ''),
    String(prompt?.expectedRail ?? ''),
    (Array.isArray(prompt?.expectedFirstFamilies) ? prompt.expectedFirstFamilies : []).join(','),
    String(prompt?.mutationExpected ?? ''),
  ].join('\u0000'));
  return `TS-${createHash('sha256').update(canonical.join('\u0001')).digest('hex').slice(0, 12)}`;
}

/**
 * Scan one prompt for anything that would tell the agent the answer.
 *
 * @param {string} text
 * @param {ReturnType<typeof readAccordoSurface>} surface
 * @returns {Array<{ code: string, phrase: string }>}
 */
export function scanPromptForSurfaceLeak(text, surface) {
  /** @type {Array<{ code: string, phrase: string }>} */
  const found = [];
  const raw = String(text ?? '');
  const lower = raw.toLowerCase();

  // 1. Command phrases, over the raw text, in every spelling the CLI accepts.
  for (const command of surface.commands) {
    const parts = command.split(' ');
    if (parts.length < 2) continue;
    for (const separator of [' ', ':', '-', '/']) {
      const phrase = parts.join(separator);
      if (lower.includes(phrase)) found.push({ code: 'PROMPT_NAMES_COMMAND', phrase });
    }
  }

  // 2. npm scripts and MCP tools, which are literal identifiers.
  for (const script of surface.scripts) {
    // Every script, not only the namespaced ones. `characterize:intelligence` was scanned
    // and `smoke`, `verify`, `doctor` and `falsify` were not — the short ones are the ones
    // a prompt is most likely to say by accident.
    //
    // On a word boundary, not as a substring: a bare `check` inside `checked` is English,
    // and the token scan refuses the standalone word already. A substring test made
    // "starting point" a script leak.
    if (new RegExp(`\\b${script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower)) {
      found.push({ code: 'PROMPT_NAMES_SCRIPT', phrase: script });
    }
  }
  for (const tool of surface.mcpTools) {
    if (lower.includes(tool)) found.push({ code: 'PROMPT_NAMES_TOOL', phrase: tool });
  }

  // 3. Any command-line flag at all. A prompt has no business carrying one.
  //
  // The boundary is "not preceded by a word character", not "preceded by whitespace". The
  // whitespace version missed every flag somebody wrote as an aside — `(--apply)`,
  // `"--apply"`, `[--json]`, `use --dry-run,` — which is the punctuation a person reaches
  // for precisely when naming a flag inside a sentence. Single-letter flags are included
  // for the same reason: `-h` names the surface as surely as `--help` does, and a scan
  // that only knows the long form teaches the next prompt author to use the short one.
  for (const match of raw.matchAll(/(?<![A-Za-z0-9])--?[A-Za-z][A-Za-z0-9-]*/g)) {
    // A negative number, a range and an em-dash-ish `--` on its own are not flags; the
    // pattern already requires a letter after the dashes, so only the arrow shapes remain.
    if (/^-{1,2}$/.test(match[0])) continue;
    found.push({ code: 'PROMPT_NAMES_FLAG', phrase: match[0] });
  }

  // 4. Rail identifiers, case-sensitively, so ordinary "see" and "build" are untouched.
  for (const rail of railLeaks(surface)) {
    if (new RegExp(`\\b${rail}\\b`).test(raw)) found.push({ code: 'PROMPT_NAMES_RAIL', phrase: rail });
  }

  // 5. Single command tokens and the binaries, over the text with path literals removed.
  const scannable = stripPathLiterals(raw).toLowerCase();
  const words = scannable.split(/[^a-z0-9]+/).filter(Boolean);
  const banned = new Set(surface.tokens.filter((token) => !PROMPT_TOKEN_EXEMPTIONS.includes(token)));
  const binaries = new Set(surface.binaries);
  for (const word of words) {
    for (const candidate of foldWord(word)) {
      if (binaries.has(candidate)) { found.push({ code: 'PROMPT_NAMES_BINARY', phrase: word }); break; }
      if (banned.has(candidate)) { found.push({ code: 'PROMPT_NAMES_COMMAND_TOKEN', phrase: word }); break; }
    }
  }

  return found;
}

/**
 * A word and its singular forms. A scan that missed `inspects` and `doctors` would be
 * a scan that any careless prompt walks straight through.
 * @param {string} word
 */
function foldWord(word) {
  /** @type {string[]} */
  const forms = [word];
  if (word.endsWith('es') && word.length > 3) forms.push(word.slice(0, -2));
  if (word.endsWith('s') && word.length > 2) forms.push(word.slice(0, -1));
  return forms;
}

/**
 * Remove backticked spans that are filesystem paths. A path says *where*, and a
 * benchmark prompt that may not say where is a benchmark prompt nobody can write.
 * The span must contain a `/` and hold nothing but path characters, so a backticked
 * command is not a path and is scanned like any other text.
 * @param {string} text
 */
export function stripPathLiterals(text) {
  return String(text).replace(/`([^`]+)`/g, (whole, inner) => (
    /^[A-Za-z0-9._@/-]+$/.test(inner) && inner.includes('/') ? ' ' : whole
  ));
}
