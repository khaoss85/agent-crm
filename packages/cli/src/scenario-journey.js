// @ts-check

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The **journey**: the only thing DX6 ever executes.
 *
 * A scenario names a journey by **id**. This registry — frozen, in DX6's own
 * source — is what an id resolves to. A scenario cannot name a path, a script,
 * an interpreter, an argument or an environment variable, so there is no code
 * path from document content to an invocation. That is the same discipline DX5
 * uses for declared scripts (the project declares a *name*; the framework owns
 * the list) and the same one `docs/CODER_TOOLING_ROADMAP.md` requires when it
 * refuses "executable commands as trusted content".
 *
 * A journey is checked-in repository source and runs with the operator's
 * authority. The child is bounded in time, output and process group. That is
 * **isolation, not a sandbox**, and the report says so (`JOURNEY_SOURCE_TRUSTED`).
 */

/**
 * Every journey DX6 knows how to run.
 *
 * There is one, deliberately: the starter installer CI already runs on every
 * push. Reusing it means DX6 introduces no second, weaker authority on what the
 * CRM does — the installer's own in-process assertions stay the strong claim,
 * and DX6 adds the mapping nobody has.
 */
export const JOURNEYS = Object.freeze({
  'b2b-lead-qualification': Object.freeze({
    installer: 'examples/starters/b2b-lead-qualification/install.mjs',
    describes: 'the checked-in B2B lead-qualification starter installer: it composes an application '
      + 'from manifests through the real module factory and drives capture → qualify → convert → '
      + 'pipeline → enrich/score/route → catalog → quote → approval → signature → order → contract '
      + 'activation → delivery handover in process, asserting each guarantee as it goes',
  }),
});

/** A journey that has not finished in this long is a defect, not a slow machine. */
export const JOURNEY_TIMEOUT_MS = 10 * 60_000;
/** Journey chatter is diagnostic; a journey that floods it is not. */
export const MAX_JOURNEY_OUTPUT = 256 * 1024;
/** Between asking the process group to stop and insisting. */
export const KILL_GRACE_MS = 2_000;
/** After the journey process exits, how long to collect what it wrote. */
export const DRAIN_MS = 250;

/**
 * The environment variable that makes a re-entrant run refuse.
 *
 * DX5 shipped without one and a project whose `verify` script re-invoked the
 * command recursed 2^depth. Nothing a journey does today can re-enter DX6 — but
 * "nothing can today" is exactly the assumption that stopped being true there,
 * and the guard costs one string.
 */
export const RECURSION_ENV = 'ACCORDO_SCENARIO_RUN';

/** @param {string} id */
export function journeyById(id) {
  if (typeof id !== 'string' || !Object.prototype.hasOwnProperty.call(JOURNEYS, id)) return null;
  return JOURNEYS[id];
}

/**
 * Run a journey to completion, bounded, and bring back its receipt.
 *
 * Four details are deliberate, each of them a defect found in this repository's
 * own child runners before:
 *
 * - **it settles on `exit`, never on stream `close`.** A grandchild the journey
 *   spawned inherits these pipes and holds them open for as long as it lives,
 *   so `close` can arrive minutes after the process we started has finished and
 *   written its receipt. Waiting for it makes every journey that spawns
 *   anything take the full timeout and then report a false failure.
 *   `packages/cli/src/child-report.js` documents finding and fixing exactly this.
 * - **streams are decoded with `setEncoding('utf8')`**, so a multi-byte
 *   character split across two chunks is reassembled rather than corrupted.
 * - **truncation is explicit.** Output past the bound sets `truncated: true`
 *   and the report carries it. Output that silently disappears is worse than
 *   output that is refused.
 * - **a signal-killed child reports its signal.** `exit null` is not a
 *   diagnostic; `killed by SIGKILL` is.
 *
 * @param {{
 *   rootDir: string,
 *   installer: string,
 *   projectDir: string,
 *   timeoutMs?: number,
 *   maxOutput?: number,
 *   env?: Record<string, string|undefined>,
 * }} options
 * @returns {Promise<{
 *   ok: boolean, code: number|null, signal: string|null, receipt: any,
 *   output: string, truncated: boolean, timedOut: boolean,
 *   spawnError: string|null, durationMs: number,
 * }>}
 */
export function runJourney({
  rootDir, installer, projectDir,
  timeoutMs = JOURNEY_TIMEOUT_MS, maxOutput = MAX_JOURNEY_OUTPUT, env = process.env,
}) {
  return new Promise((settle) => {
    const started = Date.now();
    const installerPath = join(rootDir, installer);
    if (!existsSync(installerPath)) {
      settle({
        ok: false, code: null, signal: null, receipt: null, output: '', truncated: false,
        timedOut: false, spawnError: `the journey's installer is not in this project: ${installer}`,
        durationMs: 0,
      });
      return;
    }

    /** @type {any} */
    let child;
    try {
      child = spawn(process.execPath, ['--no-warnings', installerPath], {
        cwd: rootDir,
        // Its own process group, so a timeout stops the group rather than only
        // the process we started. A journey that *deliberately* detaches into a
        // new group still outlives the run; reaching that would mean tracking
        // descendants, which is neither attempted nor a sandbox.
        detached: true,
        // No stdin: a reader never prompts, so a journey that reads it gets EOF
        // instead of stalling a CI job.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...env,
          ACCORDO_KEEP_ROOT: projectDir,
          // The recursion guard. A journey that somehow reached back into
          // `crm scenario run` finds this already set and is refused.
          [RECURSION_ENV]: '1',
        },
      });
    } catch (error) {
      settle({
        ok: false, code: null, signal: null, receipt: null, output: '', truncated: false,
        timedOut: false, spawnError: String(/** @type {any} */ (error).message), durationMs: Date.now() - started,
      });
      return;
    }

    /** @type {string[]} */
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    const absorb = (stream) => {
      if (!stream) return;
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        if (truncated) return;
        const size = Buffer.byteLength(chunk, 'utf8');
        if (bytes + size <= maxOutput) {
          bytes += size;
          chunks.push(chunk);
          return;
        }
        // Keep the part that fits rather than dropping the chunk.
        //
        // The first draft discarded any chunk that crossed the bound, which
        // meant a journey whose *first* write was larger than the whole budget
        // left nothing at all — output that vanishes instead of output that is
        // bounded. Characters are appended whole, so the prefix is still valid
        // UTF-8, and the loop stops as soon as the room is used.
        const room = maxOutput - bytes;
        let kept = '';
        let used = 0;
        for (const character of chunk) {
          const width = Buffer.byteLength(character, 'utf8');
          if (used + width > room) break;
          kept += character;
          used += width;
        }
        if (kept !== '') { chunks.push(kept); bytes += used; }
        truncated = true;
      });
      stream.on('error', () => { /* a stream torn down by the kill is not a diagnostic */ });
    };
    absorb(child.stdout);
    absorb(child.stderr);

    let timedOut = false;
    /** @type {any} */
    let insist = null;
    const stop = () => {
      if (timedOut) return;
      timedOut = true;
      killGroup(child, 'SIGTERM');
      insist = setTimeout(() => killGroup(child, 'SIGKILL'), KILL_GRACE_MS);
      if (typeof insist.unref === 'function') insist.unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    let settled = false;
    /** @type {any} */
    let drain = null;
    /** @type {{code: number|null, signal: string|null}} */
    let exited = { code: null, signal: null };

    const finish = (spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (insist) clearTimeout(insist);
      if (drain) clearTimeout(drain);
      const output = chunks.join('');
      settle({
        ok: !spawnError && !timedOut && exited.code === 0,
        code: exited.code,
        signal: exited.signal,
        receipt: spawnError ? null : parseTrailingJson(output),
        output,
        truncated,
        timedOut,
        spawnError: spawnError ? String(spawnError.message) : null,
        durationMs: Date.now() - started,
      });
    };

    child.once('error', (error) => finish(error));
    // `close` still settles — it is the cheap, common case where nothing leaked.
    child.once('close', (code, signal) => {
      exited = { code: code ?? exited.code, signal: signal ?? exited.signal };
      finish(null);
    });
    child.once('exit', (code, signal) => {
      exited = { code: code ?? null, signal: signal ?? null };
      if (settled || drain) return;
      drain = setTimeout(() => finish(null), DRAIN_MS);
      if (typeof drain.unref === 'function') drain.unref();
    });
  });
}

/** Signal the child's whole process group, tolerating a group that is already gone. */
export function killGroup(child, signal) {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch { /* already gone */ }
  }
}

/**
 * A journey prints human lines before its JSON receipt. Take the last balanced
 * JSON document in the stream rather than assuming the whole stream is JSON —
 * the same rule `scripts/tour.js` uses on the same installer.
 *
 * @param {string} text
 */
export function parseTrailingJson(text) {
  if (!text) return null;
  const start = text.lastIndexOf('\n{');
  const candidates = [text.slice(start === -1 ? text.indexOf('{') : start + 1), text];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/**
 * The numeric facts a journey reported about itself, in canonical order.
 *
 * Numbers only, and only the receipt's own enumerable keys: a journey's prose
 * summary is for a person, and letting it into the evidence would make the
 * fingerprint change every time somebody improved a sentence.
 *
 * @param {any} receipt
 */
export function journeyMetrics(receipt) {
  /** @type {Record<string, number>} */
  const metrics = {};
  if (!receipt || typeof receipt !== 'object') return metrics;
  for (const key of Object.keys(receipt).sort()) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const value = receipt[key];
    if (typeof value === 'number' && Number.isFinite(value)) metrics[key] = value;
  }
  return metrics;
}
