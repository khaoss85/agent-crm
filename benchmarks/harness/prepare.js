// @ts-check

/**
 * Prepares one Edition L benchmark run directory.
 *
 *   node benchmarks/harness/prepare.js <promptId> <runDir> --agent <product> --model <version>
 *
 * A benchmark number is worth exactly what its provenance is worth, so this script's whole job is
 * to make the provenance impossible to omit. Three refusals do most of that work.
 *
 * **A run is stamped with the commit it ran against, and a dirty tree is not a commit.** The
 * framework SHA is the only thing that lets a result be reproduced, and `git rev-parse HEAD` on a
 * modified tree names a commit whose contents were not what the agent saw. So a dirty tree is
 * refused; `--allow-dirty` permits it and stamps `treeDirty: true` into the record, where every
 * report carries it. There is no way to record a clean SHA over an unclean tree.
 *
 * **A run with no agent identity cannot be compared to anything**, so `--agent` and `--model` are
 * required rather than defaulted. A default here would produce runs that silently pool results
 * from different models — the single most expensive mistake this instrument could make.
 *
 * **The run id is derived, not invented.** `<promptId>-<sha>-<attempt>` is stable across machines
 * and operators, so the same prompt at the same commit on attempt 2 has one name everywhere. The
 * protocol runs each prompt three times; the attempt number is that index, not a counter.
 *
 * The brief is written to disk verbatim as `brief.md`. The operator pastes that file and nothing
 * else: a benchmark whose prompt was retyped, trimmed or "clarified" is measuring the operator.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

/** The record contract. Bumped when the shape changes in a way a reader must notice. */
export const RUN_RECORD_CONTRACT = 1;

const HERE = dirname(fileURLToPath(import.meta.url));
const PROMPTS_PATH = join(HERE, 'prompts.json');

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const result = prepareRun(parseArgs(process.argv.slice(2)));
    process.stderr.write(
      `\n  Prepared ${result.record.runId}\n`
      + `    prompt    ${result.record.promptId} (${result.record.difficulty === 'C' ? 'complex' : 'standard'}) — ${result.record.category}\n`
      + `    framework ${result.record.frameworkSha}${result.record.treeDirty ? '  ** dirty tree **' : ''}\n`
      + `    agent     ${result.record.agentProduct} / ${result.record.modelVersion}\n`
      + `    brief     ${result.briefPath}\n`
      + `    project   ${result.projectDir}\n\n`
      + '  Paste brief.md verbatim. Record every hand edit with record.js as it happens:\n'
      + `    node benchmarks/harness/record.js ${result.runDir} intervention "<what you did>"\n\n`,
    );
    process.stdout.write(`${JSON.stringify(result.record, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`prepare: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

/**
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'allow-dirty') {
      flags.allowDirty = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} needs a value`);
    flags[key] = value;
    index += 1;
  }

  return {
    promptId: positional[0],
    runDir: positional[1],
    agentProduct: typeof flags.agent === 'string' ? flags.agent : undefined,
    modelVersion: typeof flags.model === 'string' ? flags.model : undefined,
    attempt: typeof flags.attempt === 'string' ? Number.parseInt(flags.attempt, 10) : 1,
    allowDirty: flags.allowDirty === true,
    repoRoot: typeof flags.repo === 'string' ? flags.repo : process.cwd(),
  };
}

/**
 * @param {ReturnType<typeof parseArgs>} options
 */
export function prepareRun(options) {
  const { promptId, runDir, agentProduct, modelVersion, attempt, allowDirty, repoRoot } = options;

  if (!promptId || !runDir) {
    throw new Error('usage: prepare.js <promptId> <runDir> --agent <product> --model <version> [--attempt N] [--allow-dirty]');
  }
  if (!agentProduct || !modelVersion) {
    throw new Error(
      'both --agent and --model are required. A run with no agent identity cannot be compared to '
      + 'another run, and a default here would silently pool results from different models.',
    );
  }
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new Error(`--attempt must be an integer from 1 to 99, not "${attempt}"`);
  }

  const prompt = findPrompt(promptId);
  if (!prompt) {
    const known = loadPrompts().prompts.map((/** @type {any} */ entry) => entry.id).join(', ');
    throw new Error(`unknown prompt "${promptId}". The set is: ${known}`);
  }

  // A run inside the framework checkout dirties the tree it is supposed to be measured against,
  // so the second run of the same session could never be prepared cleanly — and the agent would
  // be building inside the framework's own composition, which `app inspect` would then read.
  //
  // Checked before the not-empty guard: "you put it in the repository" is the diagnosis, and
  // pointing at the repository root would otherwise be reported as a crowded directory.
  if (isInside(runDir, repoRoot)) {
    throw new Error(
      `${runDir} is inside the framework checkout at ${repoRoot}. Put run directories outside it: `
      + 'a run built in the repository dirties the tree its own SHA claims to describe, and the '
      + 'agent would be composing on top of the framework instead of from it.',
    );
  }

  if (existsSync(runDir) && readdirSync(runDir).length > 0) {
    throw new Error(
      `${runDir} already exists and is not empty. A run directory is written once; scoring a `
      + 'directory that accumulated two attempts reports neither of them.',
    );
  }

  const { sha, dirty } = frameworkRevision(repoRoot);
  if (dirty && !allowDirty) {
    throw new Error(
      `the tree at ${repoRoot} has uncommitted changes, so ${sha} does not describe what the agent `
      + 'would see. Commit, stash, or pass --allow-dirty to record the run as unreproducible.',
    );
  }

  const record = {
    runRecordContract: RUN_RECORD_CONTRACT,
    runId: `${prompt.id}-${sha}-${attempt}`,
    promptId: prompt.id,
    attempt,
    difficulty: prompt.difficulty,
    category: prompt.category,
    edition: 'L',
    gateSet: 'G1-G4',
    frameworkSha: sha,
    treeDirty: dirty,
    agentProduct,
    modelVersion,
    // Append-only, and the only witness G1 has. Written by record.js, never by hand.
    interventions: [],
    approvals: [],
    note:
      'Edition L scores G1–G4 locally. G5 and G6 need a public deployment this framework cannot '
      + 'honestly reach, and are not run, not estimated and never omitted from a report. G1 is '
      + 'operator-attested: it is read from the interventions array below, not measured.',
  };

  mkdirSync(runDir, { recursive: true });
  const projectDir = join(runDir, 'project');
  mkdirSync(projectDir, { recursive: true });

  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify(record, null, 2)}\n`);

  const briefPath = join(runDir, 'brief.md');
  writeFileSync(
    briefPath,
    `# ${prompt.id} — ${prompt.category} (${prompt.difficulty === 'C' ? 'complex' : 'standard'})\n\n`
    + `${prompt.brief}\n\n`
    + '---\n\n'
    + `Paste the paragraph above verbatim and nothing else. The expected-output note — "${prompt.expect}" — `
    + 'is a reviewer\'s aid and is deliberately not part of the brief: showing it to the agent would '
    + 'measure how well it follows a hint rather than how well it reads a business problem.\n',
  );

  return { runDir, projectDir, briefPath, record };
}

function loadPrompts() {
  return JSON.parse(readFileSync(PROMPTS_PATH, 'utf8'));
}

/** @param {string} promptId */
function findPrompt(promptId) {
  return loadPrompts().prompts.find((/** @type {any} */ entry) => entry.id === promptId) ?? null;
}

/**
 * Whether `candidate` sits at or under `parent`, compared on resolved paths so `..` and a symlink
 * spelled differently cannot walk past the check.
 *
 * @param {string} candidate
 * @param {string} parent
 */
function isInside(candidate, parent) {
  const from = realish(parent);
  const to = realish(candidate);
  return to === from || to.startsWith(from.endsWith(sep) ? from : `${from}${sep}`);
}

/**
 * `realpathSync` on the nearest existing ancestor, so a run directory that does not exist yet is
 * still compared against the same filesystem the repository lives on.
 *
 * @param {string} path
 */
function realish(path) {
  let current = resolve(path);
  for (;;) {
    if (existsSync(current)) return realpathSync(current);
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * The commit the run is measured against, and whether the tree matching it was clean.
 *
 * `git` failing at all is fatal rather than defaulted: a run stamped `unknown` would compare
 * against every other run stamped `unknown`, which is worse than not producing a run.
 *
 * @param {string} repoRoot
 */
export function frameworkRevision(repoRoot) {
  const rev = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' });
  if (rev.status !== 0) {
    throw new Error(`git rev-parse failed in ${repoRoot}: ${(rev.stderr ?? '').trim() || 'no output'}`);
  }
  const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' });
  if (status.status !== 0) {
    throw new Error(`git status failed in ${repoRoot}: ${(status.stderr ?? '').trim() || 'no output'}`);
  }
  return { sha: rev.stdout.trim(), dirty: status.stdout.trim().length > 0 };
}
