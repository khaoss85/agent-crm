// @ts-check

import { createInterface } from 'node:readline';
import { createAgentCrmApp } from '../../app/src/index.js';
import { createMcpServer } from './server.js';

/** @param {{dbPath?: string}} [options] */
export async function startMcpStdio(options = {}) {
  const app = createAgentCrmApp({ dbPath: options.dbPath });
  const server = createMcpServer({ app });
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    app.close();
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
      console.error(`[agent-crm:mcp] ${error instanceof Error ? error.message : String(error)}`);
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })}\n`);
    }
  }
  close();
}
