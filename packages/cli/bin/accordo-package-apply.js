#!/usr/bin/env node
// @ts-check

import { relative, resolve, sep } from 'node:path';

/**
 * Batch applier for `crm package test`.
 *
 * One `module create --apply` per manifest used to cost one `node` boot each:
 * a first-party package composes 20–40 manifests, so the applies were the
 * dominant term of every `package test` run (backlog:fb0d1a35: the split
 * shards still summed past the fast gate's 420 s bound under load). This probe
 * applies every manifest in a single process through the same `runCli` entry
 * the per-manifest child used, in the same order, with the same `cwd` and the
 * same `--root`, so each result matches the child it replaces.
 *
 * `module create` never imports the package under test — it only stages
 * generated files — so sharing one process across manifests changes nothing
 * about isolation: the package itself is still only ever imported inside the
 * plan/boot children. `applyModulePlan` is pure filesystem work (stage temp
 * files, rename, update the registry), with no process-global state to leak
 * from one manifest to the next.
 *
 * Protocol: `node accordo-package-apply.js --root <scratch> <manifest>...`
 * prints one JSON array to stdout and exits 0. A manifest that fails is an
 * item with `ok: false`, never a probe failure: like the loop it replaces,
 * the probe keeps applying what follows. Only a probe-level failure (bad
 * arguments) exits nonzero, and the caller then fails every manifest closed
 * rather than trusting a partial list.
 */

const argOf = (flag) => {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : process.argv[index + 1];
};

/**
 * @param {string} message
 * @returns {never}
 */
const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
  throw new Error(message);
};

const root = argOf('--root');
if (typeof root !== 'string' || root.length === 0) {
  fail('Usage: accordo-package-apply.js --root <dir> <manifest>...');
}
const flagIndex = process.argv.indexOf('--root');
const manifests = process.argv.slice(flagIndex + 2);
if (manifests.length === 0 || manifests.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
  fail('Usage: accordo-package-apply.js --root <dir> <manifest>...');
}
process.chdir(root);

const { runCli } = await import('../src/commands.js');

/** @param {string} value */
const posix = (value) => value.split(sep).join('/');

/**
 * Run one manifest through the real `module create` branch and keep exactly
 * what its child process would have reported: exit status and combined
 * output. `runCli` sets `process.exitCode` instead of exiting, so the probe
 * resets it around every item.
 *
 * @param {string} manifestPath
 */
async function applyOne(manifestPath) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const err = [];
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  /** @param {any[]} args */
  const captureOut = (...args) => { out.push(String(args[0])); return true; };
  /** @param {any[]} args */
  const captureErr = (...args) => { err.push(String(args[0])); return true; };
  process.stdout.write = captureOut;
  process.stderr.write = captureErr;
  try {
    process.exitCode = 0;
    await runCli(['module', 'create', manifestPath, '--apply', '--root', root]);
    // Mirrors the old loop's `ok: result.status === 0`, where any nonzero exit
    // — including bin/accordo.js's `process.exitCode = 1` on a named refusal —
    // marked the manifest failed with whatever it printed as evidence.
    if (process.exitCode !== 0 && process.exitCode !== undefined) {
      return { ok: false, output: out.join('') + err.join('') };
    }
    return { ok: true, output: out.join('') };
  } catch (error) {
    // Mirrors bin/accordo.js: a named refusal is an answer, not a stack.
    const code = error && typeof error === 'object' ? String(/** @type {{ code?: unknown }} */ (error).code ?? '') : '';
    const named = error instanceof Error && /^[A-Z][A-Z0-9_]{2,}$/.test(code);
    const text = named && !process.env.ACCORDO_DEBUG
      ? `${error.name}: ${error.message}\n(set ACCORDO_DEBUG=1 to print the stack)\n`
      : `${error instanceof Error ? error.stack ?? error.message : error}\n`;
    err.push(text);
    return { ok: false, output: out.join('') + err.join('') };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.exitCode = 0;
  }
}

/** @type {Array<{manifest: string, ok: boolean, output: string}>} */
const items = [];
const scratchRoot = resolve(root);
for (const manifestPath of manifests) {
  const absolute = resolve(manifestPath);
  // eslint-disable-next-line no-await-in-loop
  const applied = await applyOne(absolute);
  items.push({ manifest: posix(relative(scratchRoot, absolute)), ...applied });
}

process.stdout.write(`${JSON.stringify(items)}\n`);
