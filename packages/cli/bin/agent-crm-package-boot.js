#!/usr/bin/env node
// @ts-check

import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The isolated boot probe for `crm package test`.
 *
 * AX1 answers "does this composition resolve" without opening a database.
 * That is not the same question as "does an application carrying this package
 * actually start". Three things only happen at `createAgentCrmApp`:
 *
 * - every module migration runs against a real (throwaway) database;
 * - every declared action is checked against a real generated module, which is
 *   where `action "<m>.<n>": target module "<m>" is not a generated module`
 *   comes from — the failure a package with undeclared record coupling hits;
 *   and
 * - the package's capabilities are constructed for real consumers.
 *
 * So this probe boots. It writes one JSON document to **file descriptor 3** and
 * exits, for exactly the reasons `agent-crm-inspect.js` does: a package may
 * print during import, and stdout is its stream, not the report's.
 *
 * **Isolation, not a sandbox.** The child holds this user's authority. The
 * scratch project it boots is a throwaway copy, and its database lives inside
 * that copy — but a package's module body can still do whatever any checked-in
 * source can do.
 */

const REPORT_FD = 3;

/** @param {string} text */
function writeReport(text) {
  try {
    writeSync(REPORT_FD, text);
  } catch (error) {
    process.stderr.write(
      'This probe writes its report to file descriptor 3, which is not open. '
        + 'Run `crm package test` instead of invoking it directly.\n',
    );
    throw error;
  }
}

const rootIndex = process.argv.indexOf('--root');
const rootDir = rootIndex === -1 ? process.cwd() : process.argv[rootIndex + 1];
const dbIndex = process.argv.indexOf('--db');
const dbPath = dbIndex === -1 ? join(rootDir, 'data', 'package-test.sqlite') : process.argv[dbIndex + 1];
const nameIndex = process.argv.indexOf('--package');
const packageName = nameIndex === -1 ? null : process.argv[nameIndex + 1];

/** A stable, sorted view of one package as the running application sees it. */
function describe(app, name) {
  const registry = app.domains;
  if (!registry || typeof registry.names !== 'function' || !registry.names().includes(name)) return null;
  const summary = registry.get(name);
  return {
    name: summary.name,
    version: summary.version,
    resources: [...(summary.resources ?? [])].sort(),
    actions: [...(summary.actions ?? [])].sort(),
    requires: (summary.requires ?? [])
      .map((entry) => `${entry.package}/${entry.capability}@${entry.version}`).sort(),
    provides: (summary.provides ?? []).map((entry) => `${entry.name}@${entry.version}`).sort(),
  };
}

let app = null;
try {
  const { createAgentCrmApp } = await import(pathToFileURL(join(rootDir, 'packages/app/src/index.js')).href);
  // A fixed clock so nothing in the report can derive from the wall clock.
  app = createAgentCrmApp({ dbPath, clock: () => '2026-01-01T00:00:00.000Z' });

  const registry = app.domains;
  const composed = typeof registry?.names === 'function' ? [...registry.names()].sort() : [];
  const modules = app.modules.list().map((entry) => entry.name).sort();

  /** Every action the application actually registered, per module. */
  const registered = [];
  for (const moduleName of modules) {
    for (const action of app.actions.listForModule(moduleName)) {
      registered.push(`${moduleName}.${action.name}`);
    }
  }
  for (const coreModule of app.actionEligibleCoreModules ?? []) {
    for (const action of app.actions.listForModule(coreModule)) {
      registered.push(`${coreModule}.${action.name}`);
    }
  }

  /** Each declared requirement, opened exactly as the package itself would. */
  const capabilities = [];
  const summary = packageName ? describe(app, packageName) : null;
  for (const entry of summary?.requires ?? []) {
    const [providerAndCapability, version] = entry.split('@');
    const [, capability] = providerAndCapability.split('/');
    let status = 'resolved';
    let detail = null;
    try {
      const opened = registry.capability({
        consumer: packageName,
        capability,
        version: Number(version),
        context: { modules: app.modules, actor: { type: 'system', id: 'package-test' }, now: app.now },
      });
      if (!opened || typeof opened !== 'object') {
        status = 'invalid';
        detail = 'the capability did not return an object';
      }
    } catch (error) {
      status = 'failed';
      detail = error instanceof Error ? error.message : String(error);
    }
    capabilities.push({ requirement: entry, status, detail });
  }

  writeReport(`${JSON.stringify({
    booted: true,
    composedPackages: composed,
    modules,
    registeredActions: registered.sort(),
    package: summary,
    capabilities,
  })}\n`);
  process.exitCode = 0;
} catch (error) {
  // A project that will not boot is a real answer, not a crash: it travels as a
  // report so the caller can attribute it, rather than as an exit code alone.
  writeReport(`${JSON.stringify({
    booted: false,
    error: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
} finally {
  try { app?.close(); } catch { /* a failed boot has nothing to close */ }
}
