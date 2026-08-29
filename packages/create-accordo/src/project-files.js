// @ts-check

/**
 * The files a project bootstrap writes itself, as opposed to the framework
 * source it copies.
 *
 * There are nine of them and none contains a business guess. No Company field,
 * no pipeline stage, no policy threshold, no sample record: a generated domain
 * model is a claim about a business nobody has described, and an agent reads
 * generated code as a decision already taken. What the project gets instead is
 * an identity, its own checks, and a README that states every limitation in the
 * same breath as the capability it belongs to.
 *
 * No repository documentation is emitted. `docs/SKILL_PACKAGING.md` already
 * decides that no Markdown from the framework repository ships into a generated
 * project, and every extra document is one more thing `accordo project doctor`
 * can find a broken link in.
 */

/**
 * @param {{name: string}} params
 * @returns {{relativePath: string, content: string}[]}
 */
export function projectFiles({ name }) {
  return [
    { relativePath: 'package.json', content: packageJson(name) },
    { relativePath: 'README.md', content: readme(name) },
    { relativePath: 'AGENTS.md', content: agents(name) },
    { relativePath: '.gitignore', content: gitignore() },
    { relativePath: '.env.example', content: envExample() },
    { relativePath: '.mcp.json', content: mcpJson() },
    { relativePath: 'data/.gitkeep', content: dataGitkeep() },
    { relativePath: 'scripts/check.js', content: checkScript() },
    { relativePath: 'scripts/smoke.js', content: smokeScript(name) },
    { relativePath: 'tests/project.test.js', content: projectTest(name) },
  ];
}

/**
 * The project manifest.
 *
 * `private: true` because a project built from this framework is somebody's
 * application, not a package they meant to publish, and an accidental
 * `npm publish` of a CRM is not a mistake worth leaving available.
 *
 * The script names deliberately match the framework repository's own — `crm`,
 * `verify`, `smoke`, `check`, `doctor` — so that an agent that knows one knows
 * the other, and so the skills that say `npm run crm -- app inspect --json`
 * work here unchanged.
 *
 * @param {string} name
 */
function packageJson(name) {
  return `${JSON.stringify({
    name,
    version: '0.1.0',
    private: true,
    description: 'An Accordo CRM project. Local development only: no authentication ships, so a deployment must supply the verifier, and it stores data in SQLite on this machine.',
    type: 'module',
    engines: { node: '>=22.16.0' },
    bin: { accordo: './packages/cli/bin/accordo.js' },
    scripts: {
      crm: 'node --no-warnings packages/cli/bin/accordo.js',
      dev: 'node --no-warnings packages/cli/bin/accordo.js serve',
      start: 'node --no-warnings packages/cli/bin/accordo.js serve',
      mcp: 'node --no-warnings packages/mcp/bin/server.js',
      seed: 'node --no-warnings packages/cli/bin/accordo.js seed',
      demo: 'node --no-warnings packages/cli/bin/accordo.js demo',
      doctor: 'node --no-warnings packages/cli/bin/accordo.js doctor',
      check: 'node scripts/check.js',
      // No path argument, exactly as the framework repository does it: Node's
      // own discovery finds `tests/`, and `--test tests/` silently finds
      // nothing on Node 22 while `--test tests` tries to load a directory as a
      // module. A test command that quietly runs zero tests is worse than one
      // that fails.
      test: 'node --no-warnings --test --test-reporter=spec',
      verify: 'npm run check && npm test',
      smoke: 'node --no-warnings scripts/smoke.js',
    },
    license: 'MIT',
  }, null, 2)}\n`;
}

/**
 * The project README. Every capability sentence carries its limitation in the
 * same breath, which is this framework's own documentation rule rather than a
 * style preference.
 *
 * Paths are written as inline code rather than as Markdown links on purpose:
 * `accordo project doctor` checks that every repository-relative link resolves,
 * and a README full of links into a tree the reader may reorganize is a check
 * that fails for no good reason.
 *
 * @param {string} name
 */
function readme(name) {
  return `# ${name}

An Accordo CRM project. The framework source is checked in under \`packages/\`
and \`apps/\` — you own it outright, and you change it the way you change any
other code in this repository.

**It is local-development software.** No authentication ships, and
no role-based access control; it stores data in SQLite on this machine; and
nothing in it is deployable. Read the limitations below before building
anything on top of it that touches money.

## Run it

SQLite is Node's built-in adapter and needs no extra install. PostgreSQL
requires the pinned \`pg@8.23.0\` driver; this generated project does not
select PostgreSQL, so Node 22.16+ and this directory are the whole SQLite
toolchain.

\`\`\`bash
npm run verify     # syntax check, then this project's own tests
npm run smoke      # boot, run the renewal demo, assert the counts
npm run dev        # the local HTTP server and the generated Admin
\`\`\`

## What is here

\`\`\`text
packages/    the framework: kernel, CLI, MCP server, modules, domain packages, SDK
apps/        the local HTTP server and the generated Admin
skills/      agent skills for building on this project
examples/    module manifest examples
scripts/     this project's own check and smoke scripts
tests/       this project's own tests
\`\`\`

**No domain package is composed.** \`packages/domains/generated/index.js\`
exports an empty list, so this project starts as the kernel — Company, Contact,
Opportunity, Approval and the renewal workflow — and nothing else. The optional
domains (lead intelligence, commercial operations, signature and order,
contract activation, delivery, service) are on disk and **inert**: each becomes
part of the application only when you add one import to that file, and deleting
the import removes it again.

## Ask the project what it is

\`\`\`bash
npm run crm -- app inspect --json       # what is composed: packages, records, actions, policies
npm run crm -- project doctor --json    # what is inconsistent or stale, read-only
npm run crm -- package scaffold <name>  # an empty domain package that already conforms
npm run crm -- module create <manifest.json>   # a new record, dry-run unless --apply
\`\`\`

Each of those prints a contract-versioned JSON document with its own
\`limitations\` list. Read the limitations: they are hard boundaries on what the
report proves, not disclaimers.

## Limitations, stated plainly

These are properties of the framework you have just been handed, not of your
code, and none of them is scheduled here.

- **No authentication.** Actor headers are not identity. The HTTP server is
  local-development-only.
- **No tenancy.** There is no data boundary between customers. One database is
  one undivided dataset.
- **No RBAC.** Approval keys are labels; only the actor *type* is enforced —
  which is real (an agent actor cannot take a human approval decision, and this
  project's own tests prove it) and is not authorization.
- **SQLite only.** Storage is \`node:sqlite\`. There is no PostgreSQL adapter.
- **No scheduler and no durable outbox.** Nothing fires on a date, and
  post-commit event delivery dies with the process.
- **Every provider is an offline fixture.** No enrichment, signature or catalog
  provider has ever been contacted over a network.
- **The framework is a copy, not a dependency.** You own it, and upgrading means
  merging changes rather than bumping a version.
- **Nothing here is sandboxed.** Source in this repository is trusted and runs
  with your authority.

## Where the rules are

\`AGENTS.md\` in this directory states the rules a coding agent must keep when
changing this project. It is short on purpose, and the commands above are the
authority it defers to.
`;
}

/**
 * The rules a coding agent must keep in the generated project.
 *
 * Deliberately short, and it never claims a document exists that this bootstrap
 * did not write. `docs/SKILL_PACKAGING.md` records why: a file that instructs an
 * agent to read `ARCHITECTURE.md` first behaves in exactly two ways — inside the
 * framework repository it works, and in a project it produces confident
 * instructions about a codebase it never read.
 *
 * @param {string} name
 */
function agents(name) {
  return `# Repository guidance — ${name}

An Accordo CRM project. The framework source is checked in and is yours to
change; these rules are what keep it coherent while you do.

## Find out what exists before changing it

\`\`\`bash
npm run crm -- app inspect --json
\`\`\`

Read \`valid\`, then \`problems[]\`, then \`limitations[]\`, in that order. Every
problem is fixed or reported before anything is built on top of it, and **every
limitation is a hard boundary on what you may claim.** Then read \`packages[]\`,
\`capabilities[]\`, \`resources[]\`, \`actions[]\`, \`policies[]\` and
\`providers[]\`: that list is what exists. A capability absent from the report
does not exist, whatever a record name, a label or a comment suggests.

\`npm run crm -- project doctor --json\` is the fast read-only check for what is
already inconsistent, and it is cheap enough to run before every change.

## Non-negotiable rules

- All CRM mutations go through module services or named workflows. Never mutate
  a table from API, MCP or UI code.
- Any write keeps validation, actor identity, audit and trace.
- Commercial policy stays deterministic. AI may recommend; it may not silently
  override an approval rule, and a decision that requires a human actor must
  keep requiring one.
- Code-generating and destructive commands stay explicit: dry-run by default,
  \`--apply\` to write.
- A new record is a module (\`crm module create\`). A bounded new domain is a
  package (\`crm package scaffold\`), composed by one deliberate import in
  \`packages/domains/generated/index.js\`.
- Run \`npm run verify\` before considering work complete.

## What this project is not

No authentication ships, SQLite only, no scheduler, no durable
outbox, every provider an offline fixture, and nothing deployable. Do not write
a claim into this repository that these limits contradict — state a capability
and its limitation in the same breath.
`;
}

function gitignore() {
  return `node_modules/
.env
.env.*
!.env.example
data/*.sqlite
data/*.sqlite-shm
data/*.sqlite-wal
coverage/
.DS_Store
*.log
.tmp/

# Staging left behind by an interrupted \`crm package scaffold\`. It holds no
# lock and blocks nothing; the command reports it so a human can remove it.
**/.scaffold-*
`;
}

function envExample() {
  return `PORT=4000
CRM_DB_PATH=./data/accordo.sqlite
APPROVAL_THRESHOLD_CENTS=5000000
`;
}

/**
 * The project's own MCP server, stdio and local. It is not a hosted endpoint
 * and carries no authentication — the framework has none to carry.
 */
function mcpJson() {
  return `${JSON.stringify({
    mcpServers: {
      accordo: {
        type: 'stdio',
        command: 'node',
        args: ['--no-warnings', '${CLAUDE_PROJECT_DIR:-.}/packages/mcp/bin/server.js'],
        env: { CRM_DB_PATH: '${CLAUDE_PROJECT_DIR:-.}/data/accordo.sqlite' },
      },
    },
  }, null, 2)}\n`;
}

function dataGitkeep() {
  return `This directory holds the project's SQLite database, which is ignored by git.
The database is created on first run; nothing in the bootstrap opened one.
`;
}

/** Syntax check over the project's own JavaScript. */
function checkScript() {
  return `// @ts-check

/**
 * Parses every JavaScript file in this project with \`node --check\`.
 *
 * It is the cheap half of \`npm run verify\`: it proves nothing about behaviour
 * and everything about whether the tree still parses, which is the failure that
 * makes every other check unreadable.
 *
 * A file is checked in its own process, so a machine under load can fail to
 * *start* one — and a failed spawn is not a syntax error. Those two outcomes
 * are separated here rather than both reported as "this file does not parse",
 * because a check that blames your source for the machine being busy is a check
 * you learn to ignore.
 */

import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const ignored = new Set(['.git', 'node_modules', 'data', 'coverage']);
const files = walk(root).filter((file) => file.endsWith('.js'));
const failures = [];
const unchecked = [];

for (const file of files) {
  const result = check(file);
  if (result.spawnError) unchecked.push({ file: relative(root, file), error: result.spawnError });
  else if (result.status !== 0) failures.push({ file: relative(root, file), error: result.stderr.trim() });
}

if (failures.length || unchecked.length) {
  for (const failure of failures) console.error(\`\\n\${failure.file}\\n\${failure.error}\`);
  for (const entry of unchecked) console.error(\`\\n\${entry.file}\\ncould not be checked: \${entry.error}\`);
  console.error(\`\\nSyntax check failed: \${failures.length} file(s) do not parse, \${unchecked.length} could not be checked.\`);
  process.exitCode = 1;
} else {
  console.log(\`Syntax check passed for \${files.length} JavaScript files.\`);
}

/** Three attempts, because a transient inability to fork is not a defect in the file. */
function check(file) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (!result.error && typeof result.status === 'number') return result;
    last = result.error ? result.error.message : 'the checking process produced no exit status';
  }
  return { spawnError: last };
}

function walk(directory) {
  const results = [];
  for (const name of readdirSync(directory)) {
    if (ignored.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) results.push(...walk(path));
    else results.push(path);
  }
  return results;
}
`;
}

/**
 * Boot, run the renewal demo, assert the counts, and leave nothing behind.
 * @param {string} name
 */
function smokeScript(name) {
  return `// @ts-check

/**
 * The smallest end-to-end proof this project still works: boot the application
 * on a throwaway database, run the renewal demo, and assert what it produced.
 *
 * It writes nothing to \`data/\` and proves nothing about a business — it proves
 * the application composes, migrates and executes a workflow.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccordoApp } from '../packages/app/src/index.js';

const directory = mkdtempSync(join(tmpdir(), '${name}-smoke-'));
const app = createAccordoApp({ dbPath: join(directory, 'smoke.sqlite') });

try {
  const demo = await app.runDemo();
  assert.equal(demo.opportunities.length, 2);
  assert.equal(demo.opportunities.find((item) => item.valueCents === 2_000_000)?.stage, 'proposal');
  assert.equal(demo.opportunities.find((item) => item.valueCents === 8_000_000)?.stage, 'approval_pending');
  assert.equal(demo.approvals.filter((item) => item.status === 'pending').length, 1);
  console.log(JSON.stringify({
    ok: true,
    summary: 'the application boots, migrates and runs a workflow; one renewal needs a human approval.',
    counts: app.doctor().counts,
  }, null, 2));
} finally {
  app.close();
  rmSync(directory, { recursive: true, force: true });
}
`;
}

/**
 * The project's own declared check.
 *
 * Three assertions, chosen because each would catch a different broken
 * bootstrap: the application does not boot; the human-approval boundary was
 * lost in the copy; or the composition arrived carrying a domain nobody asked
 * for.
 *
 * @param {string} name
 */
function projectTest(name) {
  return `// @ts-check

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createAccordoApp } from '../packages/app/src/index.js';

/** A throwaway database per test. Nothing here touches \`data/\`. */
function boot(t) {
  const directory = mkdtempSync(join(tmpdir(), '${name}-test-'));
  const app = createAccordoApp({ dbPath: join(directory, 'project.sqlite') });
  t.after(() => {
    app.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return app;
}

test('the application boots, migrates and runs the renewal workflow', async (t) => {
  const app = boot(t);
  const demo = await app.runDemo();

  assert.equal(demo.opportunities.length, 2);
  assert.equal(demo.opportunities.find((item) => item.valueCents === 2_000_000)?.stage, 'proposal');
  assert.equal(demo.opportunities.find((item) => item.valueCents === 8_000_000)?.stage, 'approval_pending');
  assert.equal(demo.approvals.filter((item) => item.status === 'pending').length, 1);
  assert.equal(app.workflows.listRuns().length, 2, 'both renewals produced a traced workflow run');
});

test('an agent cannot take the human approval decision, and the record does not move', async (t) => {
  const app = boot(t);
  await app.runDemo();
  const [pending] = app.services.approvals.list({ status: 'pending', limit: 10 });
  assert.ok(pending, 'the demo leaves exactly one approval pending');

  await assert.rejects(
    () => app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: pending.id, decision: 'approved' },
      { actor: { type: 'agent', id: 'agent-1' } },
    ),
    /human actor/i,
    'an agent actor is refused by the workflow, not by a prompt',
  );
  assert.equal(app.services.approvals.get(pending.id).status, 'pending', 'and the approval did not move');

  const decided = await app.workflows.run(
    'decide-opportunity-approval',
    { approvalId: pending.id, decision: 'approved' },
    { actor: { type: 'user', id: 'someone@example.com' } },
  );
  assert.equal(decided.output.outcome, 'approved', 'a human actor is accepted');
  assert.equal(app.services.approvals.get(pending.id).status, 'approved');
});

test('this project composes zero domain packages, which is its declared starting point', async () => {
  const { generatedDomains } = await import('../packages/domains/generated/index.js');
  assert.deepEqual(generatedDomains, [], 'add a domain by importing it here, deliberately, one line at a time');
});
`;
}
