// @ts-check

/**
 * Appends one operator observation to a benchmark run record.
 *
 *   node benchmarks/harness/record.js <runDir> intervention "<what you did by hand>"
 *   node benchmarks/harness/record.js <runDir> approval     "<what you approved>"
 *   node benchmarks/harness/record.js <runDir> verdict pass|fail "<why the model does or does not answer the brief>"
 *   node benchmarks/harness/record.js <runDir> show
 *
 * The protocol's distinction is the whole point of this file, and it is easy to get wrong under
 * time pressure at 2am:
 *
 * - An **intervention** is the operator doing the agent's work — editing a file by hand, running a
 *   fix command the agent did not ask for, restarting a wedged session, correcting a schema after
 *   the fact. It costs G1's 25 points, and G1 is all-or-nothing, so the first one costs all of it.
 * - An **approval** is the operator answering the agent — a clarifying question, a permission
 *   prompt, a pasted credential, "yes, deploy". It costs nothing.
 *
 * So this command **says what it just cost** at the moment of recording. An operator who discovers
 * at scoring time that a run was already dead has been given the wrong tool.
 *
 * Append-only by construction: the file is read, one entry is pushed, and the whole record is
 * written back. There is no flag that removes an entry, because the only reason to want one is to
 * improve a score after the fact.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { observeComposition } from './score.js';

/** Long enough for a real sentence about what happened, short enough that nothing pastes a log. */
export const REASON_MAX = 500;

/**
 * Control characters that must never enter a record: the C0 block except tab, newline and
 * carriage return, plus DEL and the two Unicode line separators. Written with escapes on purpose —
 * spelling them literally turns this file into a binary blob for git and grep.
 */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

export const KINDS = Object.freeze(['intervention', 'approval', 'verdict']);

/**
 * G2 asks whether the composed domain model answers the brief. That is a judgement, and the
 * scorer refuses to make it — correctly. This is where the judgement lands.
 *
 * It is a record, not a lever, and three things keep it one. The scorer decides the mechanical
 * failures first and does not consult a verdict about them, so no reason written here can turn
 * "the project composed nothing" into a pass. The composition the operator judged is captured
 * here, through the same helper the gate uses, so a verdict that no longer describes the project
 * goes stale rather than travelling. And it is append-only like everything else in this file: the
 * only reason to want a verdict removed is to improve a score after the fact.
 */
export const VERDICTS = Object.freeze(['pass', 'fail']);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [runDir, kind, ...rest] = process.argv.slice(2);
  try {
    if (!runDir) throw new Error('usage: record.js <runDir> intervention|approval "<reason>"  |  record.js <runDir> verdict pass|fail "<reason>"  |  record.js <runDir> show');

    if (kind === 'show') {
      const record = readRecord(runDir);
      process.stderr.write(summarise(record));
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      const outcome = kind === 'verdict' ? rest[0] : undefined;
      const reason = (kind === 'verdict' ? rest.slice(1) : rest).join(' ');
      const { record, entry } = appendEntry(runDir, kind, reason, undefined, outcome);
      process.stderr.write(
        `\n  Recorded ${kind}${kind === 'verdict' ? ` ${entry.outcome}` : ''}: ${entry.reason}\n`
        + `    at ${entry.at}\n`
        + (kind === 'intervention'
          ? `    G1 is now failed for ${record.runId}. It is all-or-nothing, so this run cannot score `
            + 'above 50 of 75 and its prompt verdict is FAILED.\n'
          : kind === 'verdict'
            ? `    G2 is now ${entry.outcome} for ${record.runId}, judged against `
              + `${entry.observed.modules} modules, ${entry.observed.resources} resources, `
              + `${entry.observed.actions} actions. If the project changes, judge it again.\n`
            : '    Approvals do not count against any gate.\n')
        + summarise(record),
      );
      process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`record: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

/**
 * @param {any} record
 */
export function summarise(record) {
  const interventions = record.interventions?.length ?? 0;
  const approvals = record.approvals?.length ?? 0;
  const verdicts = record.verdicts?.length ?? 0;
  const latest = verdicts ? record.verdicts[verdicts - 1].outcome : null;
  return `\n  ${record.runId ?? 'unnamed run'}: ${interventions} intervention(s), ${approvals} approval(s) — `
    + `G1 ${interventions === 0 ? 'still passing' : 'failed'}, `
    + `G2 ${latest ? `${latest} (operator)` : 'unjudged'}\n\n`;
}

/**
 * @param {string} runDir
 */
export function readRecord(runDir) {
  const path = join(runDir, 'run.json');
  if (!existsSync(path)) {
    throw new Error(`no run.json in ${runDir}. Prepare the run first: node benchmarks/harness/prepare.js <promptId> ${runDir} --agent … --model …`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    // Refusing beats rewriting: an unparseable record still holds the only copy of whatever the
    // operator logged before it broke.
    throw new Error(`${path} is not valid JSON and will not be overwritten — ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed.interventions) || !Array.isArray(parsed.approvals)) {
    throw new Error(`${path} has no interventions/approvals arrays. It was not written by prepare.js.`);
  }
  // Records written before G2 had anywhere to land are still valid records; they simply carry no
  // verdict, which is exactly what "unjudged" means to the scorer.
  if (!Array.isArray(parsed.verdicts)) parsed.verdicts = [];
  return parsed;
}

/**
 * @param {string} runDir
 * @param {string | undefined} kind
 * @param {string} reason
 * @param {() => string} [clock]
 * @param {string} [outcome] required for kind "verdict": pass or fail
 * @param {(dir: string) => any} [observe] injectable for tests; defaults to the scorer's own helper
 */
export function appendEntry(
  runDir,
  kind,
  reason,
  clock = () => new Date().toISOString(),
  outcome = undefined,
  observe = observeComposition,
) {
  if (!kind || !KINDS.includes(kind)) {
    throw new Error(
      `unknown kind "${kind ?? ''}". Use "intervention" (you did the agent's work — costs G1), `
      + '"approval" (you answered the agent — costs nothing), or "verdict" (your G2 judgement of '
      + 'the domain model). The difference is scored, so it is not this tool\'s to guess.',
    );
  }
  if (kind === 'verdict' && !VERDICTS.includes(outcome ?? '')) {
    throw new Error(
      `a verdict needs an outcome: ${VERDICTS.join(' or ')}. Usage: record.js <runDir> verdict `
      + 'pass|fail "<why the composed model does or does not answer the brief>".',
    );
  }

  const trimmed = (reason ?? '').trim();
  if (trimmed.length === 0) {
    throw new Error('a reason is required. An unexplained entry is not evidence, and G1 turns on this record.');
  }
  if (trimmed.length > REASON_MAX) {
    throw new Error(`the reason is ${trimmed.length} characters; the limit is ${REASON_MAX}. Summarise it — a transcript belongs in the transcript.`);
  }
  if (FORBIDDEN_CONTROL.test(trimmed)) {
    throw new Error('the reason contains control characters. Paste the summary, not the terminal output.');
  }

  const record = readRecord(runDir);
  const entry = { at: clock(), reason: trimmed };

  if (kind === 'verdict') {
    // The composition is captured here rather than typed, and by the scorer's own helper rather
    // than a second reading of the same thing. A verdict that cannot say what it judged is not
    // evidence, so refusing beats recording one.
    const projectDir = existsSync(join(runDir, 'project')) ? join(runDir, 'project') : runDir;
    const observed = observe(projectDir);
    if (!observed || observed.composed === 0) {
      throw new Error(
        'the run project composes nothing this scorer can read, so there is no domain model to '
        + 'judge. G2 fails mechanically here and a verdict would not change it.',
      );
    }
    Object.assign(entry, { gate: 'G2', outcome, observed });
    record.verdicts.push(entry);
  } else {
    record[kind === 'intervention' ? 'interventions' : 'approvals'].push(entry);
  }

  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { record, entry };
}
