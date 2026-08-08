// @ts-check

import { resolve } from 'node:path';
import { scaffoldModule } from './scaffold-module.js';
import { validateManifestCommand, generateMigrationCommand, readManifestFile } from './manifest-commands.js';
import { planModule, applyModulePlan } from './module-factory.js';
import { validatePackageCommand, inspectPackageCommand } from './package-commands.js';
import { packageTestCommand } from './package-test-command.js';
import { packageScaffoldCommand } from './package-scaffold.js';
import { inspectApplicationCommand } from './app-inspect-command.js';
import { solutionCommand } from './solution-command.js';

/** @param {string[]} argv */
export async function runCli(argv) {
  let { command, positional, flags } = parseArgs(argv);
  // Accept "module validate <path>" as an alias of "module:validate <path>".
  if (command === 'module' && ['validate', 'migration', 'create', 'plan'].includes(positional[0])) {
    command = `module:${positional[0]}`;
    positional = positional.slice(1);
  }
  // "package validate|inspect <dir>" reads the domain-package contract with the
  // same validator the application runs at startup. Both are read-only.
  // "package test <dir>" additionally composes the package into a throwaway
  // copy of this project and boots it; it never touches the caller's own
  // application or database.
  // "package scaffold <name>" is the only one of the four that can write, and
  // only with an explicit --apply. It writes source and stops: no composition,
  // no migration, no database.
  if (command === 'package' && ['validate', 'inspect', 'test', 'scaffold'].includes(positional[0])) {
    command = `package:${positional[0]}`;
    positional = positional.slice(1);
  }
  // "app inspect" reads the checked-in composition and answers "what is this
  // application". It opens no database, so it is handled before the app is
  // constructed — the same place `package validate|inspect` sits.
  if (command === 'app' && positional[0] === 'inspect') {
    command = 'app:inspect';
    positional = positional.slice(1);
  }
  // "solution inspect|validate|check <plan.json>" reads a machine-readable
  // Solution Plan (AX2). Like `app inspect`, none of it constructs the
  // application or opens a database, and none of it executes the plan.
  if (command === 'solution' && ['inspect', 'validate', 'check'].includes(positional[0])) {
    command = `solution:${positional[0]}`;
    positional = positional.slice(1);
  }
  const dbPath = typeof flags.db === 'string' ? resolve(flags.db) : undefined;

  // Help is not a database operation. It used to fall through to the branch
  // that constructs the application, so asking for help created a SQLite file;
  // now that the app import is lazy, there is no reason for it to.
  if (command === 'help' || command === undefined) {
    console.log(helpText());
    return;
  }

  if (command === 'app:inspect') {
    const result = await inspectApplicationCommand({
      rootDir: typeof flags.root === 'string' ? flags.root : process.cwd(),
      json: flags.json === true,
    });
    process.exitCode = result.exitCode;
    return;
  }

  if (command === 'solution:inspect' || command === 'solution:validate' || command === 'solution:check') {
    const result = await solutionCommand({
      planPath: positional[0],
      mode: /** @type {'inspect'|'validate'|'check'} */ (command.slice('solution:'.length)),
      json: flags.json === true,
      rootDir: typeof flags.root === 'string' ? flags.root : process.cwd(),
    });
    process.exitCode = result.exitCode;
    return;
  }

  if (command === 'package:scaffold') {
    const result = packageScaffoldCommand({
      name: positional[0],
      rootDir: typeof flags.root === 'string' ? flags.root : process.cwd(),
      into: typeof flags.into === 'string' ? flags.into : undefined,
      // An explicit --dry-run always wins over --apply, matching module:create.
      apply: flags.apply === true && flags['dry-run'] !== true,
      json: flags.json === true,
    });
    process.exitCode = result.exitCode;
    return;
  }

  if (command === 'package:test') {
    const result = await packageTestCommand({
      packagePath: positional[0],
      rootDir: typeof flags.root === 'string' ? flags.root : process.cwd(),
      json: flags.json === true,
    });
    process.exitCode = result.exitCode;
    return;
  }

  if (command === 'package:validate' || command === 'package:inspect') {
    const run = command === 'package:validate' ? validatePackageCommand : inspectPackageCommand;
    const result = await run({ packagePath: positional[0] });
    print(result);
    // A deterministic non-zero exit is what makes this usable in CI and by an
    // agent that checks its own work.
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === 'module:validate') {
    print(validateManifestCommand({ manifestPath: positional[0] }));
    return;
  }

  if (command === 'module:migration') {
    print(
      generateMigrationCommand({
        manifestPath: positional[0],
        out: flags['dry-run'] === true ? undefined : typeof flags.out === 'string' ? flags.out : undefined,
        force: flags.force === true,
      }),
    );
    return;
  }

  if (command === 'module:plan') {
    const { manifest } = readManifestFile(positional[0]);
    const plan = planModule({
      manifest,
      rootDir: typeof flags.root === 'string' ? flags.root : process.cwd(),
    });
    print({ ok: true, mode: 'plan', ...withoutFileContents(plan) });
    return;
  }

  if (command === 'module:create') {
    const rootDir = typeof flags.root === 'string' ? flags.root : process.cwd();
    // A .json argument selects the manifest-driven module factory; a bare name
    // keeps the legacy template scaffold from Milestone 0.
    if (typeof positional[0] === 'string' && positional[0].endsWith('.json')) {
      const { manifest } = readManifestFile(positional[0]);
      const plan = planModule({ manifest, rootDir });
      // An explicit --dry-run always wins over --apply, matching module:migration.
      if (flags.apply === true && flags['dry-run'] !== true) {
        print({ ok: true, mode: 'applied', ...applyModulePlan(plan), nextSteps: factoryNextSteps() });
      } else {
        print({ ok: true, mode: 'dry-run', ...withoutFileContents(plan), nextSteps: factoryNextSteps() });
      }
      return;
    }
    const result = scaffoldModule({
      name: positional[0],
      rootDir,
      apply: flags.apply === true,
    });
    print(result);
    return;
  }

  if (command === 'mcp') {
    const { startMcpStdio } = await import('../../mcp/src/stdio.js');
    await startMcpStdio({ dbPath });
    return;
  }

  // Only these commands need a running application. Checking first means an
  // unknown command reports itself instead of quietly creating a database on
  // the way to saying it does not exist.
  const APP_COMMANDS = new Set(['serve', 'seed', 'demo', 'doctor', 'db:migrate', 'workflow:list', 'trace:list']);
  if (!APP_COMMANDS.has(String(command))) {
    throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
  }

  // The application is imported here, not at the top of this file, because
  // `packages/app` statically imports the project's checked-in composition. A
  // top-level import made every CLI command — including the read-only ones —
  // fail to load when the composition was broken, which is precisely when
  // `app inspect` and `package validate` are the commands you need.
  const { createAgentCrmApp } = await import('../../app/src/index.js');
  const app = createAgentCrmApp({ dbPath });
  let shouldClose = true;
  try {
    switch (command) {
      case 'serve': {
        const port = Number(flags.port ?? process.env.PORT ?? 4000);
        const host = String(flags.host ?? '127.0.0.1');
        const { createHttpServer } = await import('../../../apps/server/src/index.js');
        const server = createHttpServer(app);
        await new Promise((resolveListen, reject) => {
          server.once('error', reject);
          server.listen(port, host, resolveListen);
        });
        const address = server.address();
        const actualPort = typeof address === 'object' && address ? address.port : port;
        console.log(`Agent CRM running at http://${host}:${actualPort}`);
        console.log(`Database: ${app.database.path}`);
        shouldClose = false;
        const shutdown = () => {
          server.close(() => {
            app.close();
            process.exit(0);
          });
        };
        process.once('SIGINT', shutdown);
        process.once('SIGTERM', shutdown);
        return;
      }
      case 'seed':
        print(await app.seedDemo());
        break;
      case 'demo':
        print(await app.runDemo());
        break;
      case 'doctor':
        print(app.doctor());
        break;
      case 'db:migrate':
        print({ ok: true, database: app.database.path, message: 'Migrations are current.' });
        break;
      case 'workflow:list':
        print({ items: app.workflows.list() });
        break;
      case 'trace:list':
        print({ items: app.workflows.listRuns({ limit: Number(flags.limit ?? 20) }) });
        break;
    }
  } finally {
    if (shouldClose) app.close();
  }
}

/** @param {unknown} value */
function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

/** @param {ReturnType<import('./module-factory.js').planModule>} plan */
function withoutFileContents(plan) {
  return { ...plan, files: plan.files.map(({ content: _content, ...file }) => file) };
}

function factoryNextSteps() {
  return [
    'Run npm run verify to execute the generated module test.',
    'Start the app (npm run dev); the module is migrated and registered automatically.',
    'Edit the generated service to add domain rules; keep audit and events on every mutation.',
  ];
}

/** @param {string[]} argv */
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  let command;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--') && !command) {
      command = value;
      continue;
    }
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const [rawKey, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      flags[rawKey] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[rawKey] = next;
      index += 1;
    } else {
      flags[rawKey] = true;
    }
  }
  return { command, positional, flags };
}

function helpText() {
  return `Agent CRM CLI

Usage:
  agent-crm serve [--port 4000] [--db ./data/agent-crm.sqlite]
  agent-crm seed [--db path]
  agent-crm demo [--db path]
  agent-crm doctor [--db path]
  agent-crm db:migrate [--db path]
  agent-crm app inspect [--json] [--root dir]
  agent-crm solution inspect <plan.json> [--json]
  agent-crm solution validate <plan.json> [--json]
  agent-crm solution check <plan.json> [--json] [--root dir]
  agent-crm workflow:list [--db path]
  agent-crm trace:list [--limit 20] [--db path]
  agent-crm module:plan <manifest.json> [--root path] [--json]
  agent-crm module:create <manifest.json> [--apply] [--root path]
  agent-crm module:create <name> [--apply] [--root path]
  agent-crm module:validate <manifest.json>
  agent-crm module:migration <manifest.json> [--dry-run] [--out file.sql] [--force]
  agent-crm package:scaffold <package-name> [--into dir] [--apply] [--json] [--root dir]
  agent-crm package:validate <package-directory>
  agent-crm package:inspect <package-directory>
  agent-crm package:test <package-directory> [--json] [--root dir]
  agent-crm mcp [--db path]

"module plan", "module create", "module validate" and "module migration" are accepted aliases.
module:plan is always read-only. module:create with a manifest generates a complete
runnable module (service, migration, registration, tests) and is a dry-run unless
--apply is explicit; with a bare name it keeps the legacy template scaffold.
Migration generation is a dry-run unless --out is provided; --force allows overwriting.
"package scaffold", "package validate", "package inspect" and "package test" are
accepted aliases, and they answer four different questions:

  scaffold  give me an empty package that already conforms
  validate  is this package declaration structurally valid?
  inspect   what does this package declare, own, offer and need?
  test      does it hold up when a real application composes it?

scaffold takes a package NAME, not a directory, and is the only one that can write.
It is a plan unless --apply is explicit, it never overwrites, and it writes exactly
two files: an empty-but-valid package definition and a README. It invents no record,
action, policy, capability, provider, Admin section or MCP tool; it does not compose
the package, run a migration, open a database, or install or publish anything.
Its output passes validate, inspect and test with no manual edit — which proves
framework conformance and nothing at all about a domain it does not yet model.

validate and inspect are read-only: they run the same domain-package validator the
application runs at startup, write nothing, open no database and reach no network.
test additionally copies this project to a temporary directory, composes the package
into that copy, applies its module manifests and boots an application twice — once
with the package and once without it. It never writes to your project and never
opens your database; the scratch copy is destroyed on success, failure and timeout.

All three IMPORT the package, and test also boots it, so the package's own code runs
with this process's authority. That is the framework's normal trust boundary —
repository source is trusted — but it is isolation in a child process, NOT a
filesystem, network or OS sandbox. Point them only at a package you would boot.

test proves framework conformance: declaration, boundaries, composition, refusals,
records and migrations, attach and detach, and agreement with app inspect. It
proves NOTHING about whether the domain logic is correct — that is what the
package's own tests are for, and the report lists every such limitation by code.
Exit codes: 0 conforms, 1 conformance failures, 2 package or project unreadable.
Manifest schema: docs/MODULE_MANIFEST.md — module factory: docs/MODULE_FACTORY.md
"solution inspect|validate|check" read a machine-readable Solution Plan (AX2).
validate reads no project at all; check binds the plan to this project's app
inspect report and reports PLAN_STALE when the composition has moved. None of
them executes a plan, writes source, installs anything or opens a database.
Package contract: docs/PACKAGE_AUTHORING.md
Application inspection: docs/APPLICATION_INSPECTION.md — plans: docs/SOLUTION_PLAN.md`;
}
