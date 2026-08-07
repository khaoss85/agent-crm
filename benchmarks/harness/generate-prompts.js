// @ts-check

/**
 * Extracts the canonical benchmark prompt set from the protocol into machine-readable form.
 *
 * `docs/strategy/CRM_BUILD_BENCHMARK.md` § The prompts is the authority. Transcribing 22
 * briefs by hand into a second file would guarantee they drift, and a benchmark whose prompts
 * differ from its published protocol is a benchmark whose number means nothing. So the JSON is
 * generated, and `--check` fails when the committed copy no longer matches the document.
 *
 *   node benchmarks/harness/generate-prompts.js           write benchmarks/harness/prompts.json
 *   node benchmarks/harness/generate-prompts.js --check   exit 1 if the committed copy is stale
 *   node benchmarks/harness/generate-prompts.js --stdout  print the JSON, write nothing
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PROTOCOL = 'docs/strategy/CRM_BUILD_BENCHMARK.md';
const OUTPUT = 'benchmarks/harness/prompts.json';

const flags = process.argv.slice(2);
for (const flag of flags) {
  if (!['--check', '--stdout'].includes(flag)) {
    process.stderr.write(`generate-prompts: unknown flag ${flag}\n`);
    process.exit(2);
  }
}
const checkOnly = flags.includes('--check');
const toStdout = flags.includes('--stdout');

const root = process.cwd();
const source = readFileSync(join(root, PROTOCOL), 'utf8');

// The prompt section runs from "## The prompts" to the next top-level heading.
const section = source.match(/^## The prompts\n([\s\S]*?)(?=^## )/m);
if (!section) {
  process.stderr.write(`generate-prompts: could not find "## The prompts" in ${PROTOCOL}\n`);
  process.exit(2);
}

/** @type {{id: string, difficulty: string, category: string, brief: string, expect: string}[]} */
const prompts = [];
let category = null;
const problems = [];

for (const line of section[1].split('\n')) {
  const heading = line.match(/^### (.+)$/);
  if (heading) {
    category = heading[1].trim();
    continue;
  }

  // - **P01 (S)** — "brief" *Expect: highlights.*
  if (!/^- \*\*P\d+/.test(line)) continue;

  const parsed = line.match(/^- \*\*(P\d+) \(([SC])\)\*\* — ["“](.+?)["”]\s*\*Expect:\s*(.+?)\.?\*\s*$/);
  if (!parsed) {
    // A prompt line the parser cannot read is a hard error. Silently skipping one
    // shrinks the benchmark without anyone deciding to, and the success rate is a
    // fraction whose denominator would quietly change.
    problems.push(line.trim());
    continue;
  }

  const [, id, difficulty, brief, expect] = parsed;
  if (!category) problems.push(`${id} appears before any category heading`);
  prompts.push({
    id,
    difficulty,
    category: category ?? 'uncategorised',
    brief: brief.trim(),
    expect: expect.trim(),
  });
}

if (problems.length) {
  process.stderr.write('generate-prompts: could not parse these prompt lines —\n');
  for (const problem of problems) process.stderr.write(`  ${problem}\n`);
  process.stderr.write('Fix the document or the parser. A dropped prompt changes the denominator.\n');
  process.exit(2);
}

const ids = prompts.map((prompt) => prompt.id);
const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
if (duplicates.length) {
  process.stderr.write(`generate-prompts: duplicate prompt ids — ${[...new Set(duplicates)].join(', ')}\n`);
  process.exit(2);
}

prompts.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const document = {
  promptsContract: 1,
  generatedFrom: PROTOCOL,
  counts: {
    total: prompts.length,
    standard: prompts.filter((prompt) => prompt.difficulty === 'S').length,
    complex: prompts.filter((prompt) => prompt.difficulty === 'C').length,
    categories: new Set(prompts.map((prompt) => prompt.category)).size,
  },
  note:
    'Generated from the protocol. `expect` is the document\'s own expected-output highlight, which '
    + 'is prose written for a human reviewer — it is a scoring aid, not a machine-checkable '
    + 'specification, and benchmarks/harness/score.js treats anything it cannot verify as '
    + 'needs-operator rather than as a pass.',
  prompts,
};

const rendered = `${JSON.stringify(document, null, 2)}\n`;

if (toStdout) {
  process.stdout.write(rendered);
  process.exit(0);
}

const outputPath = join(root, OUTPUT);

if (checkOnly) {
  const committed = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  if (committed !== rendered) {
    process.stderr.write(
      `generate-prompts: ${OUTPUT} is stale against ${PROTOCOL}. Run \`node ${'benchmarks/harness/generate-prompts.js'}\`.\n`,
    );
    process.exit(1);
  }
  process.stderr.write(`generate-prompts: ${OUTPUT} is in sync (${prompts.length} prompts).\n`);
  process.exit(0);
}

writeFileSync(outputPath, rendered);
process.stderr.write(
  `generate-prompts: ${prompts.length} prompts — ${document.counts.standard} standard, `
  + `${document.counts.complex} complex, across ${document.counts.categories} categories → ${OUTPUT}\n`,
);
