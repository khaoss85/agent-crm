#!/usr/bin/env node
// @ts-check

import { startMcpStdio } from '../src/stdio.js';

startMcpStdio({
  env: process.env,
  projectRoot: process.cwd(),
}).catch((error) => {
  const code = error && typeof error === 'object' ? String(/** @type {{ code?: unknown }} */ (error).code || '') : '';
  if (code.startsWith('DEPLOYMENT_STORAGE_')
    || code.startsWith('IDENTITY_VERIFIER_')
    || code === 'MCP_PRODUCTION_SURFACE_UNAVAILABLE') {
    console.error(JSON.stringify({
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
    }));
    process.exit(1);
  }
  console.error(`[accordo:mcp] ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
