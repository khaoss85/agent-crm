// @ts-check

/**
 * Appends one operator observation to a benchmark run record.
 *
 *   node benchmarks/harness/record.js <runDir> intervention "<what you did by hand>"
 *   node benchmarks/harness/record.js <runDir> approval     "<what you approved>"
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

/** Long enough for a real sentence about what happened, short enough that nothing pastes a log. */
export const REASON_MAX = 500;

/**
 * Control characters that must never enter a record: the C0 block except tab, newline and
 * carriage return, plus DEL and the two Unicode line separators. Written with escapes on purpose —
 * spelling them literally turns this file into a binary blob for git and grep.
 */
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u2028\u2029]/;

export const KINDS = Object.freeze(['intervention', 'approval']);

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [runDir, kind, ...rest] = process.argv.slice(2);
  try {
    if (!runDir) throw new Error('usage: record.js <runDir> intervention|approval "<reason>"  |  record.js <runDir> show');

    if (kind === 'show') {
      const record = readRecord(runDir);
      process.stderr.write(summarise(record));
      process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
    } else {
      const { record, entry } = appendEntry(runDir, kind, rest.join(' '));
      process.stderr.write(
        `\n  Recorded ${kind}: ${entry.reason}\n`
        + `    at ${entry.at}\n`
        + (kind === 'intervention'
          ? `    G1 is now failed for ${record.runId}. It is all-or-nothing, so this run cannot score `
            + 'above 50 of 75 and its prompt verdict is FAILED.\n'
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
  return `\n  ${record.runId ?? 'unnamed run'}: ${interventions} intervention(s), ${approvals} approval(s) — `
    + `G1 ${interventions === 0 ? 'still passing' : 'failed'}\n\n`;
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
  return parsed;
}

/**
 * @param {string} runDir
 * @param {string | undefined} kind
 * @param {string} reason
 * @param {() => string} [clock]
 */
export function appendEntry(runDir, kind, reason, clock = () => new Date().toISOString()) {
  if (!kind || !KINDS.includes(kind)) {
    throw new Error(
      `unknown kind "${kind ?? ''}". Use "intervention" (you did the agent's work — costs G1) or `
      + '"approval" (you answered the agent — costs nothing). The difference is scored, so it is '
      + 'not this tool\'s to guess.',
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
  record[kind === 'intervention' ? 'interventions' : 'approvals'].push(entry);
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);
  return { record, entry };
}
