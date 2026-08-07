// @ts-check

import { resolve } from 'node:path';
import { scaffoldModule } from './scaffold-module.js';
import { validateManifestCommand, generateMigrationCommand, readManifestFile } from './manifest-commands.js';
import { planModule, applyModulePlan } from './module-factory.js';
import { validatePackageCommand, inspectPackageCommand } from './package-commands.js';
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
  if (command === 'package' && ['validate', 'inspect'].includes(positional[0])) {
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
  const { createAccordoApp } = await import('../../app/src/index.js');
  const app = createAccordoApp({ dbPath });
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
        console.log(`Accordo running at http://${host}:${actualPort}`);
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
  return `Accordo CLI

Usage:
  accordo serve [--port 4000] [--db ./data/accordo.sqlite]
  accordo seed [--db path]
  accordo demo [--db path]
  accordo doctor [--db path]
  accordo db:migrate [--db path]
  accordo app inspect [--json] [--root dir]
  accordo solution inspect <plan.json> [--json]
  accordo solution validate <plan.json> [--json]
  accordo solution check <plan.json> [--json] [--root dir]
  accordo workflow:list [--db path]
  accordo trace:list [--limit 20] [--db path]
  accordo module:plan <manifest.json> [--root path] [--json]
  accordo module:create <manifest.json> [--apply] [--root path]
  accordo module:create <name> [--apply] [--root path]
  accordo module:validate <manifest.json>
  accordo module:migration <manifest.json> [--dry-run] [--out file.sql] [--force]
  accordo package:validate <package-directory>
  accordo package:inspect <package-directory>
  accordo mcp [--db path]

"module plan", "module create", "module validate" and "module migration" are accepted aliases.
module:plan is always read-only. module:create with a manifest generates a complete
runnable module (service, migration, registration, tests) and is a dry-run unless
--apply is explicit; with a bare name it keeps the legacy template scaffold.
Migration generation is a dry-run unless --out is provided; --force allows overwriting.
"package validate" and "package inspect" are accepted aliases. Both are read-only:
they run the same domain-package validator the application runs at startup, write
nothing, open no database and reach no network, and exit non-zero on any problem.
Manifest schema: docs/MODULE_MANIFEST.md — module factory: docs/MODULE_FACTORY.md
"solution inspect|validate|check" read a machine-readable Solution Plan (AX2).
validate reads no project at all; check binds the plan to this project's app
inspect report and reports PLAN_STALE when the composition has moved. None of
them executes a plan, writes source, installs anything or opens a database.
Package contract: docs/PACKAGE_AUTHORING.md
Application inspection: docs/APPLICATION_INSPECTION.md — plans: docs/SOLUTION_PLAN.md`;
}
