// @ts-check

import { resolve } from 'node:path';
import { createAgentCrmApp } from '../../app/src/index.js';
import { createHttpServer } from '../../../apps/server/src/index.js';
import { scaffoldModule } from './scaffold-module.js';
import { validateManifestCommand, generateMigrationCommand } from './manifest-commands.js';

/** @param {string[]} argv */
export async function runCli(argv) {
  let { command, positional, flags } = parseArgs(argv);
  // Accept "module validate <path>" as an alias of "module:validate <path>".
  if (command === 'module' && ['validate', 'migration', 'create'].includes(positional[0])) {
    command = `module:${positional[0]}`;
    positional = positional.slice(1);
  }
  const dbPath = typeof flags.db === 'string' ? resolve(flags.db) : undefined;

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

  if (command === 'module:create') {
    const result = scaffoldModule({
      name: positional[0],
      rootDir: typeof flags.root === 'string' ? flags.root : process.cwd(),
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

  const app = createAgentCrmApp({ dbPath });
  let shouldClose = true;
  try {
    switch (command) {
      case 'serve': {
        const port = Number(flags.port ?? process.env.PORT ?? 4000);
        const host = String(flags.host ?? '127.0.0.1');
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
  agent-crm workflow:list [--db path]
  agent-crm trace:list [--limit 20] [--db path]
  agent-crm module:create <name> [--apply] [--root path]
  agent-crm module:validate <manifest.json>
  agent-crm module:migration <manifest.json> [--dry-run] [--out file.sql] [--force]
  agent-crm mcp [--db path]

"module validate" and "module migration" are accepted aliases.
Module scaffolding is a dry-run unless --apply is explicit.
Migration generation is a dry-run unless --out is provided; --force allows overwriting.
Manifest schema: docs/MODULE_MANIFEST.md`;
}
