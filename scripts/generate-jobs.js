// @ts-check

/**
 * Turns the JTBD matrix into a machine-readable index.
 *
 * `docs/benchmarks/CRM_JTBD_MATRIX.md` is the honest answer to "can this CRM
 * framework do X?" — but it is 400 lines of prose in two different row shapes,
 * which is the same as having no answer at all for anything that is not a human
 * reading top to bottom. `app inspect` says so itself: its EVIDENCE_NOT_AGGREGATED
 * limitation records that JTBD status lives in Markdown maintained by people and
 * is "referenced by path and never parsed into structured claims".
 *
 * This script parses it. The output, `docs/benchmarks/jobs.json`, is one fetch:
 * every job with its id, its title, one of exactly four status values, a summary
 * and the test files that prove it.
 *
 * Two rules make it trustworthy rather than merely convenient:
 *
 *   1. A row this parser cannot classify is a hard error naming the line. A
 *      silently dropped job is a job we would then be claiming by omission —
 *      an absent "not supported" row reads as "no limitation stated".
 *   2. A status outside the four-value vocabulary is a hard error, as is a test
 *      or doc named as evidence that does not exist on disk. The matrix says a
 *      row moves only with linked evidence; this checks the link resolves.
 *
 * Two row shapes exist and both are handled:
 *
 *   section rows   ## JTBD-01 — Title
 *                  - **Status**: **validated end to end** (Milestone 4).
 *                  - **Evidence**: `tests/…test.js`, `docs/….md`
 *
 *   table rows     | JTBD-XX-NN | Title | **status** | evidence and limits |
 *
 * Known non-row: the Cloud operations section states in prose that all fifteen
 * operator jobs CL-01…CL-15 are not supported, without enumerating them as rows.
 * They are specified in `docs/strategy/CLOUD_JTBD.md` under their own ids (not
 * `JTBD-` ids) and are deliberately not in this index. Nothing here claims them.
 *
 * Usage:
 *   node scripts/generate-jobs.js            write docs/benchmarks/jobs.json
 *   node scripts/generate-jobs.js --check    fail if the committed file is stale
 *   node scripts/generate-jobs.js --stdout   emit the JSON on stdout, write nothing
 *
 * Diagnostics go to stderr; stdout carries machine-readable output only.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** The only statuses the matrix is allowed to use. Order is the vocabulary's own. */
const STATUS_VOCABULARY = [
  'not supported',
  'partially supported',
  'technically supported',
  'validated end to end',
];

const SOURCE = 'docs/benchmarks/CRM_JTBD_MATRIX.md';
const TARGET = 'docs/benchmarks/jobs.json';
const JOBS_CONTRACT = 1;

const root = process.cwd();

// ---------------------------------------------------------------- entry point

main();

function main() {
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) {
    if (flag !== '--check' && flag !== '--stdout') {
      process.stderr.write(`generate-jobs: unknown flag ${flag}\n`);
      process.exit(2);
    }
  }

  const index = buildIndex(readFileSync(join(root, SOURCE), 'utf8'));
  const serialized = serialize(index);

  if (flags.has('--check')) {
    process.exit(check(serialized));
  } else if (flags.has('--stdout')) {
    process.stdout.write(serialized);
    process.stderr.write(`${summaryLine(index)}\n`);
  } else {
    writeFileSync(join(root, TARGET), serialized);
    process.stderr.write(`${summaryLine(index)} → ${TARGET}\n`);
  }
}

// ---------------------------------------------------------------- parsing

/**
 * Parses the matrix into the jobs index. Throws on anything ambiguous.
 *
 * @param {string} source raw Markdown
 * @returns {{jobsContract: number, generatedFrom: string, statusVocabulary: string[],
 *            counts: Record<string, number>, jobs: Job[]}}
 */
function buildIndex(source) {
  const lines = source.split('\n');

  /** @type {Job[]} */
  const jobs = [];
  /** @type {string[]} */
  const problems = [];

  /** Nearest heading that is not itself a job heading — the job's section. */
  let section = '';
  /** The job whose bullet list we are currently inside, if any. */
  let openSection = null;
  /** Whether the previous line was part of a table body. */
  let inTable = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const at = `${SOURCE}:${i + 1}`;

    const heading = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (heading) {
      inTable = false;
      openSection = null;
      const text = normalize(heading[2]);
      const jobHeading = parseJobHeading(text);
      if (jobHeading) {
        openSection = { id: jobHeading.id, title: jobHeading.title, section, at, bullets: [] };
        jobs.push(/** @type {any} */ (openSection));
      } else {
        // The document title is the section of the jobs that precede any H2.
        section = text;
      }
      continue;
    }

    if (line.startsWith('|')) {
      const cells = splitRow(line);
      if (isSeparatorRow(cells)) {
        // A separator only ever follows the header row, which was consumed below.
        inTable = true;
        continue;
      }
      if (!inTable && isSeparatorRow(splitRow(lines[i + 1] ?? ''))) {
        continue; // header row of a new table
      }
      const row = parseTableRow(cells, section, at, problems);
      if (row) jobs.push(row);
      continue;
    }

    inTable = false;

    if (openSection) {
      if (line.trim() === '') {
        openSection = null;
      } else {
        openSection.bullets.push(line);
      }
      continue;
    }

    // A status bullet outside a job block means a third row shape appeared and
    // this parser would have dropped it. Refuse rather than under-report.
    if (/^\s*-\s*\*\*Status\*\*\s*:/.test(line)) {
      problems.push(`${at}: a **Status** bullet outside any job heading — unclassifiable row\n    ${line}`);
    }
  }

  for (const job of jobs) {
    if (/** @type {any} */ (job).bullets) finishSectionJob(/** @type {any} */ (job), problems);
  }

  const byId = new Map();
  for (const job of jobs) {
    if (byId.has(job.id)) {
      problems.push(`${job.at}: duplicate job id ${job.id} (first seen at ${byId.get(job.id).at})`);
      continue;
    }
    byId.set(job.id, job);
  }

  for (const job of jobs) {
    for (const path of job.tests) {
      if (!existsSync(join(root, path))) {
        problems.push(`${job.at}: ${job.id} names a test that does not exist — ${path}`);
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `${SOURCE} could not be parsed into a jobs index:\n  - ${problems.join('\n  - ')}\n`
      + '  Fix the matrix, or teach scripts/generate-jobs.js the shape. A dropped row is a claim by omission.',
    );
  }

  const sorted = [...byId.values()].sort((a, b) => compare(a.id, b.id));

  /** @type {Record<string, number>} */
  const counts = { total: sorted.length };
  for (const status of STATUS_VOCABULARY) counts[status] = 0;
  for (const job of sorted) counts[job.status] += 1;

  return {
    jobsContract: JOBS_CONTRACT,
    generatedFrom: SOURCE,
    statusVocabulary: [...STATUS_VOCABULARY],
    counts,
    jobs: sorted.map((job) => ({
      id: job.id,
      title: job.title,
      status: job.status,
      summary: job.summary,
      tests: job.tests,
      docs: job.docs,
      section: job.section,
    })),
  };
}

/**
 * `## JTBD-01 — Manage a custom CRM business object end to end`
 *
 * @param {string} text heading text without the leading hashes
 * @returns {{id: string, title: string} | null}
 */
function parseJobHeading(text) {
  const match = /^(JTBD-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\s*[—–-]\s*(.+)$/.exec(text);
  if (!match) return null;
  return { id: match[1], title: normalize(match[2]) };
}

/**
 * Completes a job declared as a heading plus a bullet list.
 *
 * @param {any} job
 * @param {string[]} problems
 */
function finishSectionJob(job, problems) {
  const bullets = job.bullets.join('\n');
  delete job.bullets;

  const statusLine = /^\s*-\s*\*\*Status\*\*\s*:\s*(.*)$/m.exec(bullets);
  if (!statusLine) {
    problems.push(`${job.at}: ${job.id} has no **Status** bullet — status cannot be guessed`);
    job.status = STATUS_VOCABULARY[0];
    job.summary = job.title;
    job.tests = [];
    job.docs = [];
    return;
  }

  const classified = classifyStatus(statusLine[1], job.at, job.id, problems);
  job.status = classified.status;

  // `**partially supported** — narrowly: …` leaves a dangling dash once the status
  // itself has moved into its own field.
  const qualifier = normalize(classified.rest).replace(/^[—–-]\s*/, '');
  const desiredOutcome = /^\s*-\s*\*\*Desired outcome\*\*\s*:\s*(.*)$/m.exec(bullets);
  // The qualifier is what an agent needs ("partial — only the first follow-up Task").
  // When it carries nothing but a milestone reference, the stated outcome says more.
  const substantive = qualifier.replace(/^\(Milestone[^)]*\)/i, '').replace(/^[\s,.;:—–-]+/, '');
  if (substantive.length >= 25) job.summary = qualifier;
  else if (desiredOutcome) job.summary = normalize(desiredOutcome[1]);
  else job.summary = qualifier || job.title;

  job.tests = extractTests(bullets);
  job.docs = extractDocs(bullets, job.at, problems);
}

/**
 * `| JTBD-XX-NN | Job | **status** | evidence and limits |`
 *
 * @param {string[]} cells
 * @param {string} section
 * @param {string} at
 * @param {string[]} problems
 * @returns {Job | null}
 */
function parseTableRow(cells, section, at, problems) {
  if (cells.length !== 4 || !/^JTBD-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(cells[0])) {
    problems.push(`${at}: table row is neither a header, a separator nor a job row\n    | ${cells.join(' | ')} |`);
    return null;
  }
  const id = cells[0];
  const classified = classifyStatus(cells[2], at, id, problems);
  const evidence = `${cells[1]}\n${cells[3]}`;
  return {
    id,
    title: normalize(cells[1]),
    status: classified.status,
    summary: normalize(cells[3]) || normalize(cells[1]),
    tests: extractTests(evidence),
    docs: extractDocs(evidence, at, problems),
    section,
    at,
  };
}

/**
 * Normalises a status expression to exactly one vocabulary value and returns
 * whatever prose followed it. Anything else is a hard error.
 *
 * @param {string} text e.g. `**validated end to end** (Milestone 4).`
 * @param {string} at
 * @param {string} id
 * @param {string[]} problems
 * @returns {{status: string, rest: string}}
 */
function classifyStatus(text, at, id, problems) {
  const bold = /^\s*\*\*([^*]+)\*\*\s*(.*)$/s.exec(text);
  const candidate = normalize(bold ? bold[1] : text).toLowerCase().replace(/[.,;:]+$/, '');
  if (!STATUS_VOCABULARY.includes(candidate)) {
    problems.push(
      `${at}: ${id} has status "${candidate}", which is not one of `
      + `${STATUS_VOCABULARY.map((value) => `"${value}"`).join(', ')}\n    ${text.trim()}`,
    );
    return { status: STATUS_VOCABULARY[0], rest: '' };
  }
  return { status: candidate, rest: bold ? bold[2] : '' };
}

// ---------------------------------------------------------------- evidence

/**
 * @param {string} text
 * @returns {string[]} repo-relative test paths, deduplicated and sorted
 */
function extractTests(text) {
  return unique(text.match(/tests\/[A-Za-z0-9_./-]+\.test\.js/g) ?? []);
}

/**
 * Doc references appear three ways: repo-relative (`docs/ADMIN.md`), relative to
 * the matrix itself (`../strategy/CLOUD_JTBD.md`) and as a bare filename in prose
 * (`DATA_GOVERNANCE.md`). All three are resolved to a repo-relative path; a
 * reference that resolves to nothing is a hard error, because a doc cited as
 * evidence that is not there is the failure this whole gate exists to catch.
 *
 * @param {string} text
 * @param {string} at
 * @param {string[]} problems
 * @returns {string[]}
 */
function extractDocs(text, at, problems) {
  const matches = text.match(/(?:\.\.\/)?[A-Za-z0-9_][A-Za-z0-9_./-]*\.md/g) ?? [];
  /** @type {string[]} */
  const resolved = [];
  for (const reference of matches) {
    const candidates = reference.startsWith('../')
      ? [join('docs', reference.slice(3))]
      : [reference, join('docs', reference), join('docs', 'strategy', reference)];
    const hit = candidates.find((candidate) => existsSync(join(root, candidate)));
    if (hit) resolved.push(hit);
    else problems.push(`${at}: names a document that does not exist — ${reference}`);
  }
  return unique(resolved);
}

// ---------------------------------------------------------------- text helpers

/**
 * Splits a Markdown table row on unescaped pipes. `\|` inside a cell (the matrix
 * writes `crm package validate\|inspect`) is a literal pipe, not a boundary.
 *
 * @param {string} line
 * @returns {string[]}
 */
function splitRow(line) {
  const cells = [];
  let current = '';
  for (let i = 1; i < line.length; i += 1) {
    const character = line[i];
    if (character === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (character === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim() !== '') cells.push(current.trim());
  return cells;
}

/** @param {string[]} cells */
function isSeparatorRow(cells) {
  return cells.length > 0 && cells.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * Markdown prose to one plain line: emphasis, code ticks and links removed,
 * whitespace collapsed. Nothing is truncated — a limitation half-stated is worse
 * than no limitation.
 *
 * @param {string} text
 */
function normalize(text) {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** @param {string[]} values */
function unique(values) {
  return [...new Set(values)].sort(compare);
}

/**
 * Code-unit comparison. `localeCompare` is locale-dependent and would make the
 * output machine-dependent, which the determinism rule forbids.
 *
 * @param {string} a
 * @param {string} b
 */
function compare(a, b) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// ---------------------------------------------------------------- output

/**
 * Canonical JSON: keys sorted at every level, 2-space indent, trailing newline.
 *
 * @param {unknown} value
 * @returns {string}
 */
function serialize(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

/**
 * @param {any} value
 * @returns {any}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== 'object') return value;
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const key of Object.keys(value).sort(compare)) out[key] = sortKeys(value[key]);
  return out;
}

/** @param {ReturnType<typeof buildIndex>} index */
function summaryLine(index) {
  const parts = STATUS_VOCABULARY.map((status) => `${index.counts[status]} ${status}`);
  return `generate-jobs: ${index.counts.total} jobs — ${parts.join(', ')}`;
}

/**
 * Regenerates in memory and reports whether the committed file still matches.
 *
 * @param {string} expected
 * @returns {number} process exit code
 */
function check(expected) {
  const path = join(root, TARGET);
  if (!existsSync(path)) {
    process.stderr.write(`generate-jobs --check: ${TARGET} does not exist. Run: node scripts/generate-jobs.js\n`);
    return 1;
  }
  const actual = readFileSync(path, 'utf8');
  if (actual === expected) {
    process.stderr.write(`generate-jobs --check: ${TARGET} is in sync with ${SOURCE}\n`);
    return 0;
  }
  process.stderr.write(`generate-jobs --check: ${TARGET} is stale.\n${describeDrift(actual, expected)}`);
  process.stderr.write(`  Run: node scripts/generate-jobs.js\n`);
  return 1;
}

/**
 * A human-readable account of what moved, so a stale file is actionable without
 * diffing 149 objects by eye.
 *
 * @param {string} committed
 * @param {string} regenerated
 * @returns {string}
 */
function describeDrift(committed, regenerated) {
  /** @type {any} */
  let previous;
  try {
    previous = JSON.parse(committed);
  } catch {
    return '  the committed file is not valid JSON\n';
  }
  const next = JSON.parse(regenerated);
  const before = new Map((previous.jobs ?? []).map((job) => [job.id, job]));
  const after = new Map(next.jobs.map((/** @type {any} */ job) => [job.id, job]));

  const lines = [];
  if (previous.jobsContract !== next.jobsContract) {
    lines.push(`  contract: ${previous.jobsContract} → ${next.jobsContract}`);
  }
  const added = [...after.keys()].filter((id) => !before.has(id));
  const removed = [...before.keys()].filter((id) => !after.has(id));
  if (added.length > 0) lines.push(`  added (${added.length}): ${added.join(', ')}`);
  if (removed.length > 0) lines.push(`  removed (${removed.length}): ${removed.join(', ')}`);

  const changed = [];
  for (const [id, job] of after) {
    const old = before.get(id);
    if (!old) continue;
    if (old.status !== job.status) changed.push(`  status ${id}: "${old.status}" → "${job.status}"`);
    else if (serialize(old) !== serialize(job)) changed.push(`  details ${id}`);
  }
  lines.push(...changed);

  for (const status of STATUS_VOCABULARY.concat('total')) {
    const was = previous.counts?.[status];
    const now = next.counts[status];
    if (was !== now) lines.push(`  count "${status}": ${was} → ${now}`);
  }

  if (lines.length === 0) lines.push('  same jobs, different bytes (formatting or key order)');
  return `${lines.join('\n')}\n`;
}

/**
 * @typedef {object} Job
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {string} summary
 * @property {string[]} tests
 * @property {string[]} docs
 * @property {string} section
 * @property {string} [at] source location, dropped before serialization
 */
