#!/usr/bin/env node
// @ts-check

import { runCli } from '../src/commands.js';

runCli(process.argv.slice(2)).catch((error) => {
  const code = error && typeof error === 'object' ? String(/** @type {{ code?: unknown }} */ (error).code || '') : '';
  if (code.startsWith('DEPLOYMENT_STORAGE_')
    || code.startsWith('IDENTITY_VERIFIER_')
    || code === 'CLI_VERIFIED_OPERATOR_REQUIRED'
    || code === 'MCP_PRODUCTION_SURFACE_UNAVAILABLE'
    || code === 'POSTGRESQL_HTTP_SPINE_REQUIRED'
    || code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED') {
    console.error(JSON.stringify({
      ok: false,
      code,
      message: error instanceof Error ? error.message : String(error),
    }));
    // A hanging verifier import() keeps the event loop alive after timeout;
    // the entry must still exit nonzero inside the bound.
    process.exit(1);
  }
  // A refusal the framework names — a validation error, a Cloud refusal — is an
  // answer, not a crash: print its name and message, which already say what to
  // do. A stack is printed only for errors nobody named (a bug), or on request.
  const named = error instanceof Error && /^[A-Z][A-Z0-9_]{2,}$/.test(code);
  if (named && !process.env.ACCORDO_DEBUG) {
    console.error(`${error.name}: ${error.message}`);
    console.error('(set ACCORDO_DEBUG=1 to print the stack)');
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
  }
  process.exitCode = 1;
});
