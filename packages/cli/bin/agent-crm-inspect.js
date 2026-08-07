#!/usr/bin/env node
// @ts-check

import { inspectApplication } from '../src/app-inspect.js';

/**
 * The isolated loader for `crm app inspect`.
 *
 * Inspection has to import the project's checked-in composition, and importing
 * a code-first definition runs its module body. That is the framework's normal
 * trust boundary — repository source is trusted — but it is still a body of
 * code whose import-time behaviour nobody promised anything about: it may
 * mutate globals, monkey-patch a built-in, install a handler or simply never
 * return.
 *
 * Running it here, in a child process that exists only to produce one JSON
 * document and exit, means none of that reaches the process the operator
 * invoked. The parent applies the timeout. **This is isolation, not a sandbox:**
 * the child has this user's full authority, and the report says so.
 *
 * One JSON document on stdout, diagnostics on stderr, and an exit code that
 * distinguishes "your composition is broken" from "I could not read it".
 */

const rootIndex = process.argv.indexOf('--root');
const rootDir = rootIndex === -1 ? process.cwd() : process.argv[rootIndex + 1];

try {
  const { report } = await inspectApplication({ rootDir });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.valid ? 0 : 1;
} catch (error) {
  // A project that cannot be read at all is a different outcome from a project
  // whose composition is wrong, and it gets its own exit code so a caller never
  // mistakes one for the other.
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
