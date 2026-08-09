// @ts-check

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createDocsMcpHttpHandler } from '../packages/docs-mcp/src/index.js';

const bundledRoot = join(process.cwd(), 'packages', 'docs-mcp', 'runtime-corpus');
const handle = createDocsMcpHttpHandler({ rootDir: existsSync(bundledRoot) ? bundledRoot : undefined });

export default {
  /** @param {Request} request */
  async fetch(request) {
    const started = performance.now();
    const response = await handle(request);
    console.error(
      `[accordo:docs-mcp:http] ${request.method} ${response.status} ${Math.round(performance.now() - started)}ms`,
    );
    return response;
  },
};
