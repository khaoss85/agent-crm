// @ts-check

import { resolve } from 'node:path';
import { scaffoldModule } from './scaffold-module.js';
import { validateManifestCommand, generateMigrationCommand, readManifestFile } from './manifest-commands.js';
import { planModule, applyModulePlan } from './module-factory.js';
import { validatePackageCommand, inspectPackageCommand } from './package-commands.js';
import { inspectApplicationCommand } from './app-inspect-command.js';

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
  const dbPath = typeof flags.db === 'string' ? resolve(flags.db) : undefined;

  if (command === 'app:inspect') {
    const result = await inspectApplicationCommand({
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
      case 'help':
      case undefined:
        console.log(helpText());
        break;
      default:
        throw new Error(`Unknown command: ${command}\n\n${helpText()}`);
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
  agent-crm workflow:list [--db path]
  agent-crm trace:list [--limit 20] [--db path]
  agent-crm module:plan <manifest.json> [--root path] [--json]
  agent-crm module:create <manifest.json> [--apply] [--root path]
  agent-crm module:create <name> [--apply] [--root path]
  agent-crm module:validate <manifest.json>
  agent-crm module:migration <manifest.json> [--dry-run] [--out file.sql] [--force]
  agent-crm package:validate <package-directory>
  agent-crm package:inspect <package-directory>
  agent-crm mcp [--db path]

"module plan", "module create", "module validate" and "module migration" are accepted aliases.
module:plan is always read-only. module:create with a manifest generates a complete
runnable module (service, migration, registration, tests) and is a dry-run unless
--apply is explicit; with a bare name it keeps the legacy template scaffold.
Migration generation is a dry-run unless --out is provided; --force allows overwriting.
"package validate" and "package inspect" are accepted aliases. Both are read-only:
they run the same domain-package validator the application runs at startup, write
nothing, open no database and reach no network, and exit non-zero on any problem.
Manifest schema: docs/MODULE_MANIFEST.md — module factory: docs/MODULE_FACTORY.md
Package contract: docs/PACKAGE_AUTHORING.md`;
}
