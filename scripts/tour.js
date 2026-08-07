// @ts-check

/**
 * `npm run tour` — the first sixty seconds.
 *
 * The repository's default composition is deliberately empty: `packages/domains/generated/`
 * and `packages/modules/generated/` ship with no imports, because a project writes the
 * composition it wants. That is correct engineering and a terrible first impression —
 * `crm app inspect --json` on a fresh clone reports six empty arrays, so the flagship
 * command, run in the flagship repository, shows nothing.
 *
 * The fully composed application is not missing. It is built, applied and driven end to end
 * by the starter installer on every push. This script runs that installer into a directory it
 * keeps, then inspects the result and narrates what the framework actually contains — so a
 * person, or an agent evaluating whether to recommend this, can see the whole thing in one
 * command instead of assembling it from prose.
 *
 * It proves nothing the test suite does not already prove. It makes what is proven visible.
 *
 *   npm run tour                 build, inspect, narrate, clean up
 *   npm run tour -- --keep DIR   leave the composed project in DIR to explore
 *   npm run tour -- --json       machine-readable receipt on stdout, narration on stderr
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const wantsJson = argv.includes('--json');
const keepIndex = argv.indexOf('--keep');
const keepDir = keepIndex !== -1 ? resolve(argv[keepIndex + 1] ?? '') : null;
if (keepIndex !== -1 && !keepDir) {
  process.stderr.write('--keep needs a directory\n');
  process.exit(2);
}

const root = process.cwd();
const projectDir = keepDir ?? mkdtempSync(join(tmpdir(), 'agent-crm-tour-'));
const startedAt = process.hrtime.bigint();

/** Narration goes to stderr so `--json` keeps stdout clean for a machine. */
const say = (line = '') => process.stderr.write(`${line}\n`);

say();
say('  Composing a CRM application from manifests: catalog, quoting, signature,');
say('  order activation, delivery and its economics.');
say('  This is the starter installer, the same one CI runs on every push.');
say();

const install = spawnSync(
  process.execPath,
  ['--no-warnings', join(root, 'examples/starters/b2b-lead-qualification/install.mjs')],
  { encoding: 'utf8', env: { ...process.env, AGENT_CRM_KEEP_ROOT: projectDir }, cwd: root },
);

if (install.status !== 0) {
  say('  The installer failed. That is a real failure, not a tour problem:');
  say(indent(install.stderr || install.stdout));
  cleanup();
  process.exit(1);
}

/** The installer prints a JSON summary of what the journey produced. */
const journey = parseTrailingJson(install.stdout);

const inspect = spawnSync(
  process.execPath,
  ['--no-warnings', join(projectDir, 'packages/cli/bin/agent-crm.js'), 'app', 'inspect', '--json', '--root', projectDir],
  { encoding: 'utf8', cwd: projectDir },
);

if (inspect.status !== 0 && inspect.status !== 1) {
  say(`  app inspect could not read the generated project (exit ${inspect.status}):`);
  say(indent(inspect.stderr));
  cleanup();
  process.exit(1);
}

const report = parseTrailingJson(inspect.stdout);
if (!report) {
  say('  app inspect returned no parseable report.');
  cleanup();
  process.exit(1);
}

const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

const counts = {
  modules: report.modules?.length ?? 0,
  packages: report.packages?.length ?? 0,
  capabilities: report.capabilities?.length ?? 0,
  resources: report.resources?.length ?? 0,
  actions: report.actions?.length ?? 0,
  policies: report.policies?.length ?? 0,
  providers: report.providers?.length ?? 0,
};

say('  Done.');
say();
say(`  ${pad('modules', 14)}${counts.modules}`);
say(`  ${pad('packages', 14)}${counts.packages}`);
say(`  ${pad('capabilities', 14)}${counts.capabilities}`);
say(`  ${pad('resources', 14)}${counts.resources}`);
say(`  ${pad('actions', 14)}${counts.actions}`);
say(`  ${pad('policies', 14)}${counts.policies}`);
say(`  ${pad('providers', 14)}${counts.providers}`);
say();

if (journey) {
  say('  What the journey produced, driven end to end:');
  for (const [key, value] of Object.entries(journey.counts ?? journey)) {
    if (typeof value === 'number') say(`  ${pad(key, 20)}${value}`);
  }
  say();
}

say(`  Composed and inspected in ${(elapsedMs / 1000).toFixed(1)}s.`);
say();
say('  What this does NOT show, and you should read before believing any of it:');
say(`    · production posture — ${report.application?.productionPosture ?? 'unknown'}`);
for (const limitation of report.limitations ?? []) {
  say(`    · ${limitation.code}`);
}
say();
say('  Every one of those is a hard boundary on what may be claimed. The full list with');
say('  evidence is docs/benchmarks/CRM_JTBD_MATRIX.md, where "not supported" is the default.');
say();

if (keepDir) {
  say(`  The composed project is in ${keepDir}`);
  say('  Explore it:');
  say(`    cd ${keepDir} && node --no-warnings packages/cli/bin/agent-crm.js app inspect --json`);
  say();
}

const receipt = {
  tourContract: 1,
  ok: true,
  elapsedMs: Math.round(elapsedMs),
  counts,
  productionPosture: report.application?.productionPosture ?? null,
  limitations: (report.limitations ?? []).map((limitation) => limitation.code),
  journey: journey?.counts ?? journey ?? null,
  projectDir: keepDir,
};

if (wantsJson) process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);

cleanup();

// A composed application with nothing in it is the failure this script exists to catch.
// Exit non-zero so CI notices if the composition ever silently empties out.
const composed = counts.modules + counts.resources + counts.actions;
if (composed === 0) {
  say('  The composed application is empty. That is a regression, not a tour.');
  process.exit(1);
}

function cleanup() {
  if (!keepDir && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
}

/**
 * The installer and the CLI both print human lines before their JSON. Take the last
 * balanced JSON document in the stream rather than assuming the whole stream is JSON.
 * @param {string} text
 */
function parseTrailingJson(text) {
  if (!text) return null;
  const start = text.lastIndexOf('\n{');
  const candidates = [text.slice(start === -1 ? text.indexOf('{') : start + 1), text];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** @param {string} value @param {number} width */
function pad(value, width) {
  return `${value}${' '.repeat(Math.max(1, width - value.length))}`;
}

/** @param {string} text */
function indent(text) {
  return String(text ?? '').split('\n').map((line) => `    ${line}`).join('\n');
}
