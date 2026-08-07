// @ts-check

/**
 * stdio transport for the Docs MCP server.
 *
 * Identical framing to `packages/mcp/src/stdio.js` — newline-delimited JSON-RPC,
 * batches supported, parse errors answered rather than thrown. The differences
 * are the two things this server does not have: a database to open and a handle
 * to close.
 *
 * stdout carries JSON-RPC and nothing else. Diagnostics go to stderr.
 */

import { createInterface } from 'node:readline';
import { createDocsMcpServer } from './server.js';

/** @param {{rootDir?: string}} [options] */
export async function startDocsMcpStdio(options = {}) {
  const server = createDocsMcpServer({ rootDir: options.rootDir });
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity });

  process.once('SIGINT', () => process.exit(0));
  process.once('SIGTERM', () => process.exit(0));

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
      console.error(`[accordo:docs-mcp] ${error instanceof Error ? error.message : String(error)}`);
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      })}\n`);
    }
  }
}
