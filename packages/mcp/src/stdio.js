// @ts-check

import { createInterface } from 'node:readline';
import { createAccordoApp } from '../../app/src/index.js';
import {
  DEPLOYMENT_STORAGE_ENV,
} from '../../core/src/deployment-storage.js';
import { prepareDeploymentPreconnect } from '../../core/src/identity-verifier.js';
import { MODE_ENV } from '../../core/src/runtime-mode.js';
import { createMcpServer } from './server.js';

/**
 * @param {{
 *   dbPath?: string,
 *   configPath?: string,
 *   env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   projectRoot?: string,
 * }} [options]
 */
export async function startMcpStdio(options = {}) {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? process.cwd();

  // Production MCP is static source-only: do not load deployment storage,
  // compose, connect, migrate or attest. A FIFO at the config env must not hang.
  if (env[MODE_ENV] === 'production') {
    await serveStdio(createMcpServer({ productionStatic: true }), null);
    return;
  }

  const prepared = await prepareDeploymentPreconnect({
    ...loaderOptions(options, env),
    projectRoot,
    env,
  });

  if (prepared.selection.spine?.mode === 'production') {
    await serveStdio(createMcpServer({ productionStatic: true }), null);
    return;
  }

  const dbPath = sqliteFactoryPath(prepared.selection);
  const app = createAccordoApp({ dbPath });
  const server = createMcpServer({ app });
  await serveStdio(server, app);
}

/**
 * @param {{ dbPath?: string, configPath?: string }} options
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
function loaderOptions(options, env) {
  const configPath = typeof options.configPath === 'string' ? options.configPath : undefined;
  const dbFlag = typeof options.dbPath === 'string' ? options.dbPath : undefined;
  const envPath = env && typeof env[DEPLOYMENT_STORAGE_ENV] === 'string' && env[DEPLOYMENT_STORAGE_ENV] !== ''
    ? env[DEPLOYMENT_STORAGE_ENV]
    : null;
  if (configPath || envPath) {
    return { configPath, dbPath: dbFlag };
  }
  return { dbPath: dbFlag ?? env.CRM_DB_PATH ?? './data/accordo.sqlite' };
}

/** @param {{ adapter?: unknown, connection?: { path?: unknown } }} selection */
function sqliteFactoryPath(selection) {
  if (selection.adapter !== 'sqlite') return undefined;
  return typeof selection.connection?.path === 'string' ? selection.connection.path : undefined;
}

/**
 * @param {{ handle: (request: any) => Promise<any> }} server
 * @param {{ close: () => void } | null} app
 */
async function serveStdio(server, app) {
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    app?.close();
  };

  process.once('SIGINT', () => { close(); process.exit(0); });
  process.once('SIGTERM', () => { close(); process.exit(0); });
  process.once('exit', close);

  for await (const line of readline) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (Array.isArray(message)) {
        const responses = (await Promise.all(message.map((item) => server.handle(item))))
          .filter(Boolean);
        if (responses.length) process.stdout.write(`${JSON.stringify(responses)}\n`);
        continue;
      }
      const response = await server.handle(message);
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      console.error(`[accordo:mcp] ${error instanceof Error ? error.message : String(error)}`);
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })}\n`);
    }
  }
  close();
}
