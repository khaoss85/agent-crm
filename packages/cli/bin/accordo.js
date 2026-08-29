#!/usr/bin/env node
// @ts-check

import { runCli } from '../src/commands.js';

runCli(process.argv.slice(2)).catch((error) => {
  const code = error && typeof error === 'object' ? String(/** @type {{ code?: unknown }} */ (error).code || '') : '';
  if (code.startsWith('DEPLOYMENT_STORAGE_')
    || code.startsWith('IDENTITY_VERIFIER_')
    || code === 'CLI_VERIFIED_OPERATOR_REQUIRED'
    || code === 'MCP_PRODUCTION_SURFACE_UNAVAILABLE') {
    console.error(JSON.stringify({
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
    }));
    // A hanging verifier import() keeps the event loop alive after timeout;
    // the entry must still exit nonzero inside the bound.
    process.exit(1);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
