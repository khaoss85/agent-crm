// @ts-check

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { canonicalJson } from '../../core/index.js';
import { inspectApplicationCommand } from './app-inspect-command.js';
import { projectDoctorCommand } from './project-doctor-command.js';
import { discoverCandidatePackages, projectKind } from './project-doctor-checks.js';

/**
 * `crm project verify [--json] [--root <dir>]` — DX5.
 *
 * > **Can you prove this project is healthy enough to hand back after a
 * > coding-agent change?**
 *
 * DX1 answers *what is inconsistent in the source*, cheaply, before you edit.
 * This is the expensive counterpart: it **runs the evidence** and reports which
 * authority refused.
 *
 * ```text
 * crm project doctor    source coherence, read-only, sub-second   DX1
 * crm project verify    orchestrated evidence, minutes            DX5
 * ```
 *
 * **It is an orchestrator, not a task runner.** Every check delegates to
 * something that already decides — the doctor, AX1, Solution Plan binding,
 * package conformance, the project's own *declared* scripts. DX5 owns the
 * sequencing, the evidence and the refusal shape, and nothing else. A
 * user-supplied list of shell commands was rejected during design: it would
 * make two projects' reports share a schema and nothing else.
 *
 * **It never guesses a command.** A project that declares no test script gets
 * `not_applicable` with a reason, not a hopeful `npm test`.
 *
 * **PROVE is still partial.** Scenario evidence is a separate command
 * (`crm scenario run`, DX6) that this one deliberately does not invoke, and
 * requirement-level implementation evidence is another (`crm solution verify`,
 * DX10) that runs *this* command rather than the other way round. The report
 * says so in its own limitations rather than letting a green exit code imply
 * completeness.
 *
 * That separation was re-examined when DX6 gained a second scenario, and it
 * stands. The alternative considered was a bounded applicability contract —
 * scenarios declaring themselves `required` or `current`, the way plans do — so
 * this command could run the declared ones. It was refused for now, on this
 * command's own rules: each scenario composes a *whole application* of its own,
 * so the cost is minutes per scenario and grows with every one a project adds;
 * a new declaration vocabulary is a new agent-facing contract, and the DX
 * Simplicity Gate asks which failure mode it prevents, not which capability it
 * adds; and the failure mode it would prevent — "somebody forgot to run the
 * scenario" — is already named, in machine-readable form, by
 * `SCENARIO_EVIDENCE_NOT_RUN` in this report. A limitation a caller can switch
 * on is a weaker thing than a hidden multi-minute expansion is a cost. What
 * would change the answer is a scenario *registry* with declared applicability
 * that exists for reasons other than this command, or DX10 arriving and making
 * a single final proof genuinely complete.
 */

export const PROJECT_VERIFICATION_CONTRACT = 1;

/** Categories, in report order. Every check belongs to exactly one. */
export const CATEGORIES = Object.freeze(['structure', 'application', 'plans', 'packages', 'suite', 'worktree']);

/** Every status a check may carry. Closed vocabulary. */
export const STATUSES = Object.freeze(['passed', 'failed', 'warning', 'skipped', 'not_applicable']);

/** How long any single delegated command may run before its group is stopped. */
export const STEP_TIMEOUT_MS = 15 * 60_000;
/** How much of a child's output is retained. Beyond this the tail is dropped. */
export const MAX_CAPTURED_OUTPUT = 64 * 1024;
/** How much of a captured stream reaches the report as a summary. */
export const MAX_SUMMARY = 400;
/** After the step's own process exits, how long to collect what it wrote. */
export const DRAIN_MS = 250;

/**
 * Marks a child of this command, so a nested `project verify` can recognise
 * that it is running *inside* one and refuse to run declared scripts again.
 *
 * Without it, a project whose `verify` script calls `accordo project verify`
 * recurses without bound — and because DX5 runs both `verify` and `smoke`, the
 * fan-out is 2^depth, not linear.
 */
export const VERIFY_DEPTH_ENV = 'ACCORDO_PROJECT_VERIFY_DEPTH';

/**
 * The only depth at which this command runs a project's declared scripts.
 *
 * Not a tunable. A verification that verifies itself proves nothing, so there
 * is no honest value above zero and no flag to raise it.
 */
export const MAX_VERIFY_DEPTH = 0;

/** How deep a value taken from a delegated report may nest before it is cut. */
export const MAX_NESTED_DEPTH = 8;
/** How many nodes of such a value are copied before the rest is dropped. */
export const MAX_NESTED_NODES = 512;
/** How long any single string from a delegated report may be. */
export const MAX_NESTED_TEXT = 512;

/**
 * A JSON-safe copy of a value that came from **somewhere else**, bounded in
 * depth, node count and string length.
 *
 * Every delegate here — the doctor, AX1, a nested `project verify` — hands back
 * a report this command then embeds and *fingerprints*, and `canonicalJson`
 * recurses without a cycle guard. So a delegated value that is cyclic, or
 * 200,000 levels deep, does not produce a bad report: it produces
 * `RangeError: Maximum call stack size exceeded` and **no report at all**, which
 * is the one outcome a command whose entire job is producing evidence must not
 * have. A property whose getter throws does the same.
 *
 * The bound is the fix: cut at a depth no honest report reaches, stop after a
 * node budget, truncate long strings, and drop anything that is not a plain
 * JSON shape rather than letting `canonicalJson` refuse it later.
 *
 * @param {unknown} value @param {number} [depth] @param {{left: number}} [budget]
 */
export function boundNested(value, depth = 0, budget = { left: MAX_NESTED_NODES }) {
  if (budget.left <= 0) return null;
  budget.left -= 1;
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') return boundText(value);
  if (type === 'boolean') return value;
  if (type === 'number') return Number.isFinite(value) ? value : null;
  // A function, a symbol or a bigint cannot be canonicalized and is not
  // evidence. Dropping it is the honest answer.
  if (type !== 'object') return null;
  if (depth >= MAX_NESTED_DEPTH) return null;
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      if (budget.left <= 0) break;
      items.push(boundNested(item, depth + 1, budget));
    }
    return items;
  }
  /** @type {Record<string, unknown>} */
  const shape = {};
  let keys;
  try { keys = Object.keys(/** @type {any} */ (value)).sort(); } catch { return null; }
  for (const key of keys) {
    if (budget.left <= 0) break;
    let held;
    // A hostile or merely broken report can put a throwing getter here.
    try { held = /** @type {any} */ (value)[key]; } catch { continue; }
    shape[key] = boundNested(held, depth + 1, budget);
  }
  return shape;
}

/** One delegated string, bounded. Truncation is disclosed, never silent. */
export function boundText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  return text.length > MAX_NESTED_TEXT ? `${text.slice(0, MAX_NESTED_TEXT)}… [truncated]` : text;
}

/** The subset of a delegated list that is usable as a repository-relative path. */
function boundPathList(value) {
  const bounded = boundNested(value ?? []);
  if (!Array.isArray(bounded)) return [];
  return bounded.filter((entry) => typeof entry === 'string' && entry !== '' && !isAbsolute(entry));
}

/**
 * The scripts DX5 will run **if the project declares them**, and the check each
 * one produces. The names are the framework's own conventions; a project that
 * uses different ones simply reports `not_applicable`.
 */
const DECLARED_SCRIPTS = Object.freeze([
  { script: 'verify', code: 'suite.verify', required: true },
  { script: 'smoke', code: 'suite.smoke', required: false },
]);

/**
 * What this command does not prove. Published with every report, because a
 * green exit code that quietly means less than a reader assumes is the failure
 * mode this whole family of commands exists to avoid.
 */
const LIMITATIONS = Object.freeze([
  {
    code: 'BROWSER_EVIDENCE_NOT_AUTOMATED',
    message: 'no browser is driven and no rendered page is checked. Nothing here is evidence about the Admin as a user sees it, and `crm scenario run` does not drive one either',
  },
  {
    code: 'SCENARIO_EVIDENCE_NOT_RUN',
    message: 'no business scenario is executed end to end. A passing suite is not the same as "this works for the customer\'s process" — that is `crm scenario run <scenario> --json`, which is a separate command and is not run from here. Two scenarios ship in examples/scenarios/, each composing a whole application of its own; running every one of them from here would add unbounded minutes to every verification, so which scenarios matter stays an explicit choice',
  },
  {
    code: 'IMPLEMENTATION_EVIDENCE_NOT_MAPPED',
    message: 'nothing here maps a plan\'s requirements to the code that implements them, so a green report never means a plan is finished. That is `crm solution verify <plan.json> --evidence <evidence.json> --json` (DX10), which is a separate command and is not run from here — it references this receipt rather than the other way round',
  },
  {
    code: 'PROJECT_COMMANDS_TRUSTED',
    message: 'declared project scripts are checked-in source and run with the operator\'s authority. Child isolation bounds a hang and captures output; it is not a filesystem, network or OS sandbox',
  },
  {
    code: 'PROVIDER_HEALTH_UNKNOWN',
    message: 'no external provider is contacted, authenticated or health-checked',
  },
  {
    code: 'PRODUCTION_READINESS_NOT_ASSESSED',
    message: 'there is no auth, tenancy or RBAC in this framework, and nothing here assesses deployment, capacity or operational readiness',
  },
]);

/**
 * @param {{code: string, category: string, status: string, authority: string,
 *   required?: boolean, evidence?: string, reason?: string|null, durationMs?: number}} entry
 */
export function check(entry) {
  if (!CATEGORIES.includes(entry.category)) throw new Error(`unknown category: ${entry.category}`);
  if (!STATUSES.includes(entry.status)) throw new Error(`unknown status: ${entry.status}`);
  return {
    code: entry.code,
    category: entry.category,
    status: entry.status,
    authority: entry.authority,
    required: entry.required ?? false,
    // Both fields routinely carry text a delegate produced. Bounding them here
    // — the one place every check is built — keeps an enormous reason out of
    // the report without every call site remembering to.
    evidence: boundText(entry.evidence ?? ''),
    reason: entry.reason === null || entry.reason === undefined ? null : boundText(entry.reason),
    // Diagnostic only. Deliberately excluded from the semantic fingerprint:
    // a report that changes because the machine was busy is not comparable.
    durationMs: entry.durationMs ?? null,
  };
}

/**
 * Run one command in its own process group, bounded in time and output.
 *
 * The process group matters: a test suite that spawns a server and leaks it
 * would otherwise outlive the step and hold the run open. Output is capped so a
 * package that floods stdout cannot exhaust memory — and, because the report is
 * built from structured fields rather than from the log, cannot corrupt the
 * JSON document either.
 *
 * **The step settles on the child's `exit`, not on its streams closing.** A
 * grandchild the script spawned — a dev server, a watcher, a leaked worker —
 * inherits these pipes and holds them open for as long as it lives, so `close`
 * can arrive long after the process we started has already finished and exited
 * 0. Waiting for it made every project whose suite leaks a background process
 * burn the full fifteen-minute timeout and then report a *false* failure. This
 * is the same defect `child-report.js` documents having found in AX1; the fix
 * is the same one: settle on `exit`, drain briefly for what was still in
 * flight, and treat an inherited pipe that never closes as not our problem.
 *
 * @param {{command: string, args: string[], cwd: string, timeoutMs?: number,
 *   env?: NodeJS.ProcessEnv}} options
 */
export function runStep({ command, args, cwd, timeoutMs = STEP_TIMEOUT_MS, env }) {
  return new Promise((resolveStep) => {
    const started = Date.now();
    let out = '';
    let truncated = false;
    let settled = false;
    /** @type {any} */
    let drain = null;
    /** @type {any} */
    let child;
    try {
      child = spawn(command, args, {
        cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}),
      });
    } catch (error) {
      resolveStep({ ok: false, code: null, signal: null, output: '', timedOut: false, truncated: false, durationMs: 0, spawnError: String(/** @type {any} */ (error).message) });
      return;
    }
    const absorb = (chunk) => {
      if (out.length >= MAX_CAPTURED_OUTPUT) { truncated = true; return; }
      out += chunk;
      if (out.length > MAX_CAPTURED_OUTPUT) { out = out.slice(0, MAX_CAPTURED_OUTPUT); truncated = true; }
    };
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      // Decode on the stream, never per chunk: a multi-byte character split
      // across two `data` events becomes U+FFFD twice if each Buffer is
      // stringified on its own, and mojibake in a failure reason is a worse
      // diagnostic than no reason at all.
      stream.setEncoding('utf8');
      stream.on('data', absorb);
      // A stream torn down by the kill is not a diagnostic.
      stream.on('error', () => {});
    }

    const stopGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    };
    /** @param {any} result */
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain) clearTimeout(drain);
      // A grandchild may still hold these pipes. Let go of them, or this
      // command's own event loop stays alive waiting on a process it does not
      // own and never agreed to supervise.
      try { child.stdout?.destroy(); child.stderr?.destroy(); child.unref?.(); } catch { /* already gone */ }
      resolveStep(result);
    };
    const timer = setTimeout(() => {
      stopGroup();
      finish({ ok: false, code: null, signal: 'SIGKILL', output: out, timedOut: true, truncated, durationMs: Date.now() - started, spawnError: null });
    }, timeoutMs);

    child.on('error', (error) => {
      finish({ ok: false, code: null, signal: null, output: out, timedOut: false, truncated, durationMs: Date.now() - started, spawnError: String(error.message) });
    });
    /** @param {number|null} code @param {string|null} signal */
    const done = (code, signal) => finish({
      ok: code === 0, code, signal, output: out, timedOut: false, truncated,
      durationMs: Date.now() - started, spawnError: null,
    });
    // `close` is the happy path and arrives within microseconds of `exit` when
    // nothing leaked; the drain only ever fires when something did.
    child.on('close', done);
    child.on('exit', (code, signal) => {
      if (settled || drain) return;
      drain = setTimeout(() => done(code, signal), DRAIN_MS);
      if (typeof drain.unref === 'function') drain.unref();
    });
  });
}

/**
 * A bounded, safe one-line summary of a failed step.
 *
 * Never the whole log: a megabyte of output in a JSON report is not a
 * diagnostic, it is a denial of service on the reader. Absolute paths are
 * relativized so the report does not carry the machine that produced it.
 *
 * @param {string} output @param {string} rootDir
 */
export function summarize(output, rootDir) {
  const lines = String(output).split('\n').map((line) => line.trim()).filter(Boolean);
  // The last lines are where a runner puts its verdict — usually. A JSON
  // report ends in closing braces, and a suite whose fixtures print ends in
  // fixture noise, so the tail alone published
  // `], | "database": "created empty in a temporary copy" | },` as the reason a
  // package failed. Prefer the lines that actually carry a verdict, and fall
  // back to the tail only when none does.
  const strong = lines.filter((line) => STRONG_VERDICT.test(line));
  const weak = strong.length > 0 ? strong : lines.filter((line) => WEAK_VERDICT.test(line));
  const chosen = (weak.length > 0 ? weak : lines).slice(-6).join(' | ');
  return redact(chosen, rootDir).slice(0, MAX_SUMMARY);
}

/**
 * Two tiers, because one was wrong in both directions.
 *
 * The strong shapes cannot appear in a *passing* line: a TAP `not ok`, the spec
 * reporter's mark and non-zero `fail` count, a thrown error, a JSON report's own
 * `"status": "failed"`. The weak ones are ordinary words that appear in a test
 * *name* as readily as in a verdict — `a hostile name cannot smuggle content`
 * matched a prose rule and became the reason a suite failed — so they are used
 * only when nothing stronger is present.
 */
const STRONG_VERDICT = /✖|\bnot ok\b|AssertionError|\w+Error:|"status":\s*"failed"|\brefused\b|\bfail\s+[1-9]/;
const WEAK_VERDICT = /\b(?:fail(?:ed|ure|s|ing)?|refus(?:ed|es|al)|error|violat)/i;

/**
 * The one pass that decides what a path-shaped run of characters is.
 *
 * Alternation order is the whole design, and each branch is here because
 * attacking the previous version produced a wrong answer:
 *
 * - **`url` is first, and is kept.** `https://example.com/a/b/c` is not machine
 *   layout; it is usually the one actionable thing in a diagnostic. The general
 *   absolute-path rule used to match from the *second* slash of `//` and
 *   publish `https:/<path>` — a mangled URL that helps nobody and still leaks
 *   nothing, the worst of both.
 * - **`unc` and `win`.** A Windows absolute path contains no forward slash at
 *   all, so every earlier rule ignored it: `C:\Users\alice\...` and
 *   `\\fileserver\team\...` travelled into reports untouched. The redactor
 *   claimed to remove absolute machine paths and removed only POSIX ones.
 * - **`home` before `posix`.** A path may legally contain a space, and prose
 *   legally follows a path after one, so no single rule can be right about
 *   both. Under a *home or temp root* the tail is machine layout by
 *   definition — `/home/jose gonzalez/app/x.js` published `gonzalez/app/x.js`
 *   and with it the operator's name. So the continuation is consumed only when
 *   the token after the space itself contains a separator; `/tmp/a/b failed to
 *   load` keeps its prose.
 * - **`posix` last**, unchanged in intent: two or more segments, and only when
 *   what precedes the leading slash cannot make it relative.
 */
const PATH_SHAPES = new RegExp([
  // Any scheme with a **non-empty authority**: `https://host/a/b`,
  // `postgres://host/db`. The authority is what makes it a network location
  // rather than machine layout, which is why `file:///home/u/x` — three
  // slashes, empty authority, a local absolute path — deliberately does not
  // match here and is redacted by the rules below.
  '(?<url>\\b[A-Za-z][A-Za-z0-9+.-]+:\\/\\/[^\\s\'"<>\\/][^\\s\'"<>]*)',
  '(?<unc>\\\\\\\\[^\\s\'"\\\\]+(?:\\\\[^\\s\'"\\\\]+)+)',
  '(?<win>(?<![A-Za-z0-9])[A-Za-z]:(?:[\\\\/][^\\s\'"\\\\/]+)+)',
  '(?<home>(?<![\\w.])\\/(?:home|Users|root|tmp|var\\/folders|var\\/tmp|private\\/var)'
    + '(?:\\/[^\\s\'"]+)*(?:[ ][^\\s\'"]*\\/[^\\s\'"]*)*)',
  '(?<posix>(?<![\\w.])(?:\\/[^\\s\'"/\\\\]+){2,})',
].join('|'), 'g');

/**
 * Remove this machine from a string: the project root becomes `.`, any other
 * absolute path is replaced, and anything shaped like an assignment to a
 * secret-ish name is dropped rather than echoed.
 *
 * A project-relative path is deliberately **kept**: `./packages/core/src/thing.js`
 * tells a reviewer where to look and says nothing about the machine, and a
 * redactor that eats it makes every reason useless to protect nothing.
 *
 * @param {string} text @param {string} rootDir
 */
export function redact(text, rootDir) {
  // The project root first, so everything under it survives as `./a/b` rather
  // than being swallowed by one of the absolute rules below.
  let out = String(text).split(rootDir).join('.');
  out = out.replace(PATH_SHAPES, (match, ...rest) => {
    const groups = rest[rest.length - 1];
    if (!groups || !groups.url) return '<path>';
    // A URL is kept, but a DSN carries its credentials in the authority —
    // `postgres://user:hunter2@host/db` is the commonest secret in a connection
    // error, and no name-shaped rule catches it because the variable is called
    // DATABASE_URL.
    return match.replace(/\/\/[^/@\s]*:[^/@\s]*@/, '//<redacted>@');
  });
  // Two rules, deliberately not one case-insensitive rule.
  //
  // Environment-variable shape is matched case-SENSITIVELY. Folding case here
  // meant `KEY` matched inside `monkey`, `foreign key` and `cache key`, so
  // `foreign key: constraint "fk_order_contract" violated` was published as
  // `foreign key=<redacted> violated` — the redactor eating the one token the
  // reader needed. A lower-case `key:` in prose is not a credential.
  out = out.replace(/\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSPHRASE|KEY|CREDENTIAL)[A-Z0-9_]*)\s*[=:]\s*\S+/g, '$1=<redacted>');
  // Identifier shape (`apiKey`, `accessToken`, `password`) is matched in any
  // case, but only for words that cannot be ordinary English. Bare `key` is
  // absent on purpose: it is the one that produced every false positive.
  out = out.replace(
    /\b(\w*(?:secret|token|password|passphrase|credential|api[_-]?key|access[_-]?key|private[_-]?key|secret[_-]?key)\w*)\s*[=:]\s*\S+/gi,
    '$1=<redacted>',
  );
  return out;
}

/** Every npm script the project declares, as name → command. Never guessed. */
export function scriptCommands(rootDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'));
    return pkg && typeof pkg.scripts === 'object' && pkg.scripts ? pkg.scripts : {};
  } catch {
    return {};
  }
}

/** Which npm scripts the project declares. Never guessed. */
export function declaredScripts(rootDir) {
  return new Set(Object.keys(scriptCommands(rootDir)));
}

/** npm's own aliases, so `npm test` is followed as readily as `npm run test`. */
const NPM_ALIASES = new Set(['test', 'start', 'stop', 'restart']);
/** Shell sequencing this reads. Anything else is left alone rather than guessed at. */
const SCRIPT_SEPARATORS = /&&|\|\||;|\|/;
/** The only tokens treated as a file a script would execute. */
const SCRIPT_FILE = /\.(?:js|mjs|cjs)$/;
/** A script chain deeper than this is not analysed; it is also not a real project. */
const MAX_SCRIPT_CHAIN = 16;

/**
 * The repository-relative files a declared script would execute and that are
 * **not in this project**.
 *
 * A declared script whose target is absent is a different fact from a script
 * that ran and failed, and reporting the second for the first is how the
 * tour-composed project reads: `npm run verify` exits 1 with `MODULE_NOT_FOUND`
 * from deep inside Node's loader, which looks like a suite failure and is not
 * one. `scripts/tour.js` says the project it leaves behind is there to make what
 * is proven *visible* — a read-only inspection demo — and its `package.json`
 * nonetheless declares scripts it has no `scripts/` directory to satisfy. The
 * honest verdict is that the script is not applicable here, said out loud.
 *
 * This reads the declared command; it never guesses one. Only an unambiguous
 * `node <relative>.js` target is resolved, and `npm run x` is followed into the
 * project's own scripts — bounded, and cycle-safe.
 *
 * @param {{rootDir: string, script: string, scripts: Record<string, unknown>, seen?: Set<string>}} input
 * @returns {string[]}
 */
export function missingScriptTargets({ rootDir, script, scripts, seen = new Set() }) {
  if (seen.has(script) || seen.size >= MAX_SCRIPT_CHAIN) return [];
  seen.add(script);
  const command = scripts?.[script];
  if (typeof command !== 'string') return [];
  /** @type {string[]} */
  const missing = [];
  for (const segment of command.split(SCRIPT_SEPARATORS)) {
    const parts = segment.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    if (parts[0] === 'npm') {
      const next = parts[1] === 'run' || parts[1] === 'run-script' ? parts[2]
        : NPM_ALIASES.has(parts[1]) ? parts[1] : null;
      if (next) missing.push(...missingScriptTargets({ rootDir, script: next, scripts, seen }));
      continue;
    }
    if (parts[0] !== 'node' && parts[0] !== process.execPath) continue;
    // The first non-flag token is the entry point. `--test-reporter=spec` and
    // `-e` are flags, not files, and a script that only passes flags names no
    // target at all.
    const target = parts.slice(1).find((token) => !token.startsWith('-'));
    if (!target || isAbsolute(target) || !target.includes('/') || !SCRIPT_FILE.test(target)) continue;
    if (!existsSync(join(rootDir, target))) missing.push(target);
  }
  return [...new Set(missing)].sort();
}

/**
 * Every path git considers dirty right now, or null when this is not a git
 * checkout. Sampled **twice** — once before any delegate runs and once after —
 * because the only interesting question is which of these paths the
 * verification itself is responsible for.
 *
 * @param {string} rootDir @param {(dir: string) => string|null} [run]
 */
export function worktreeState(rootDir, run = defaultGit) {
  const result = run(rootDir);
  if (result === null) return null;
  return [...new Set(String(result).split('\n').map((line) => line.trim()).filter(Boolean))].sort();
}

/**
 * `git status --porcelain`, not `git diff --name-only HEAD`.
 *
 * `git diff` lists only *tracked* files, so a suite that wrote a brand-new
 * file into the project — a scratch database, a generated module, a coverage
 * directory nobody gitignored — left the report saying the worktree was clean.
 * Porcelain reports the untracked ones too, and still says nothing about
 * `.gitignore`d build output, which is exactly the line we want: build output
 * is not source.
 *
 * `-z` rather than the default line format, because git *quotes and escapes* a
 * path containing a space, a quote or a non-ASCII byte in the default one — so
 * `src/caf\303\251.js` and `src/café.js` were two different strings depending
 * on which sample they landed in, and a file with an awkward name could look
 * like it had been created and deleted by the same run.
 *
 * Each entry keeps its two status columns. Comparing paths alone cannot see a
 * file the operator had *modified* and a delegate then *deleted*: the path is
 * in both samples, so the run was reported as having changed nothing at all.
 *
 * @param {string} rootDir
 */
export function defaultGit(rootDir) {
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: rootDir, encoding: 'utf8' });
  if (inside.status !== 0) return null;
  const changed = spawnSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], {
    cwd: rootDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  if (changed.status !== 0) return null;
  const fields = String(changed.stdout ?? '').split('\0');
  const entries = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index];
    if (!field) continue;
    // "XY path". A rename or copy is followed by its source path in its own
    // NUL-separated field, which is consumed here rather than mistaken for a
    // second changed file.
    const status = field.slice(0, 2);
    if (status[0] === 'R' || status[0] === 'C') index += 1;
    entries.push(`${status}\t${field.slice(3)}`);
  }
  return entries.join('\n');
}

/**
 * One sample line as its status and its path. A line with no status column —
 * which is what an injected sampler in a test naturally produces — is a path
 * whose status is simply unknown, and comparing two unknowns by path is the
 * behaviour that was there before.
 *
 * @param {string} line
 */
export function sampled(line) {
  const tab = line.indexOf('\t');
  return tab === -1 ? { status: '', path: line } : { status: line.slice(0, tab), path: line.slice(tab + 1) };
}

/**
 * @param {{rootDir?: string, json?: boolean, out?: (text: string) => void,
 *   inspect?: Function, doctor?: Function, step?: Function, git?: Function}} [options]
 * @returns {Promise<{exitCode: number, report: any}>}
 */
export async function projectVerifyCommand(options = {}) {
  const {
    json = false, out = (text) => process.stdout.write(text),
    inspect = inspectApplicationCommand, doctor = projectDoctorCommand,
    step = runStep, git = defaultGit,
  } = options;
  const rootDir = resolve(options.rootDir ?? process.cwd());

  if (!existsSync(rootDir) || projectKind(rootDir) === 'unknown') {
    return { exitCode: 2, report: null };
  }

  // Am I already running inside a `project verify`? The marker is set on every
  // child this command spawns, so any depth below the first is recognisable.
  const outerDepth = Number.parseInt(process.env[VERIFY_DEPTH_ENV] ?? '', 10);
  const depth = Number.isInteger(outerDepth) && outerDepth > 0 ? outerDepth : 0;
  const nested = depth > MAX_VERIFY_DEPTH;
  const childEnv = { ...process.env, [VERIFY_DEPTH_ENV]: String(depth + 1) };

  /** @type {any[]} */
  const checks = [];
  /** @type {any[]} */
  const problems = [];
  /** @type {any[]} */
  const evidence = [];

  // The worktree as it was *before* this command did anything. Without this
  // sample, "changed since HEAD" cannot distinguish a tree the operator had
  // already edited — the normal state of a coding-agent handover — from a
  // suite writing into the source it is meant to be reading.
  const worktreeBefore = worktreeState(rootDir, git);

  // ---- 1. structural preflight -------------------------------------------
  // A project whose source the doctor refuses is not worth a fifteen-minute
  // suite: the failure is already known and cheaper to read. Warnings are
  // carried forward rather than blocking, because a mirror-coverage warning is
  // not a reason to refuse to verify.
  const doctorResult = await doctor({ rootDir, json: true, capture: true });
  const doctorReport = doctorResult.report;
  if (doctorResult.exitCode === 2 || !doctorReport) {
    return { exitCode: 2, report: null };
  }
  const doctorFailed = (doctorReport.checks ?? []).filter((entry) => entry.status === 'failed');
  const doctorWarned = (doctorReport.checks ?? []).filter((entry) => entry.status === 'warning');
  checks.push(check({
    code: 'structure.doctor',
    category: 'structure',
    status: doctorFailed.length === 0 ? 'passed' : 'failed',
    authority: 'project-doctor',
    required: true,
    evidence: `crm project doctor: ${doctorFailed.length} failure(s), ${doctorWarned.length} warning(s)`,
    reason: doctorFailed.length === 0 ? null : doctorFailed.map((entry) => boundText(entry.id)).sort().join(', '),
  }));
  for (const warned of doctorWarned) {
    checks.push(check({
      code: `structure.carried.${warned.id}`,
      category: 'structure',
      status: 'warning',
      authority: 'project-doctor',
      evidence: 'carried from project doctor; not a verification failure',
      reason: warned.reason ?? null,
    }));
  }
  evidence.push({
    kind: 'doctor',
    status: boundNested(doctorReport.status),
    fingerprint: boundNested(doctorReport.fingerprint ?? null),
  });

  const blocked = doctorFailed.length > 0;
  if (blocked) {
    problems.push({
      code: 'PREFLIGHT_FAILED',
      message: 'project doctor reports a structural failure. Verification is not attempted: the cheaper authority already refused, and running a suite over a broken project produces a second, less useful failure',
    });
  }

  // ---- 2. application ------------------------------------------------------
  let inspectionFingerprint = null;
  if (blocked) {
    checks.push(check({
      code: 'application.inspect', category: 'application', status: 'skipped',
      authority: 'app-inspect', required: true, evidence: 'not attempted', reason: 'PREFLIGHT_FAILED',
    }));
  } else {
    const inspected = await inspect({ rootDir, json: true, capture: true });
    const report = inspected.report;
    inspectionFingerprint = boundNested(report?.inspectionFingerprint ?? null);
    const problemCount = (report?.problems ?? []).length;
    checks.push(check({
      code: 'application.inspect',
      category: 'application',
      status: report && inspected.exitCode === 0 && problemCount === 0 ? 'passed' : 'failed',
      authority: 'app-inspect',
      required: true,
      evidence: report ? `${(report.packages ?? []).length} package(s), ${problemCount} problem(s)` : 'no report',
      reason: problemCount === 0 ? null : (report.problems ?? []).map((p) => boundText(p?.code)).sort().join(', '),
    }));
    evidence.push({ kind: 'inspection', fingerprint: inspectionFingerprint });
  }

  // ---- 3. solution plans ---------------------------------------------------
  // DX1 already decides which plans a project declares as current; a historical
  // or design-only plan going stale is a fact, not a fault, and re-deciding
  // that here would be a second opinion nobody asked for.
  const planChecks = (doctorReport.checks ?? []).filter((entry) => entry.id?.startsWith('plans.'));
  // DX1's vocabulary, used verbatim rather than re-derived: `passed` binds,
  // `failed` is malformed or a declared-**required** plan that no longer binds,
  // `warning` is a declared-**current** plan that no longer binds, and
  // `not_applicable` is a plan nobody declared.
  //
  // Keeping only `passed` and `failed` dropped exactly the declared-current
  // ones. A project that declares a single current plan which has since gone
  // stale reported `not_applicable` — "this project declares no plan as
  // current" — the check denying the very condition it exists to surface, while
  // its evidence called the required plans it *did* grade "declared-current".
  const gradedPlans = planChecks.filter((entry) => entry.status !== 'not_applicable');
  const failedPlans = gradedPlans.filter((entry) => entry.status === 'failed');
  const stalePlans = gradedPlans.filter((entry) => entry.status === 'warning');
  // A malformed plan and a stale *required* plan are both `failed` to DX1, and
  // a reader needs to be told which. DX1 attaches the binding problems it found
  // to a plan it could parse, and cannot attach them to one it could not — so
  // the presence of that array is the distinction, taken from the authority
  // rather than guessed at from the message.
  const malformedPlans = failedPlans.filter((entry) => !Array.isArray(entry.evidence?.problems));
  const staleRequiredPlans = failedPlans.filter((entry) => Array.isArray(entry.evidence?.problems));
  const graded = [
    staleRequiredPlans.length > 0 ? `${staleRequiredPlans.length} declared-required and no longer binding` : null,
    stalePlans.length > 0 ? `${stalePlans.length} declared-current and no longer binding` : null,
    malformedPlans.length > 0 ? `${malformedPlans.length} malformed` : null,
  ].filter(Boolean);
  // Whether the project has plans at all is a different fact from whether it
  // declared any, and conflating them is what produced "this project declares
  // no plan as current" about a project whose single current plan had gone
  // stale. `NO_SOLUTION_PLANS_FOUND` is DX1's own code for the first.
  const noPlansAtAll = planChecks.some((entry) => entry.reason === 'NO_SOLUTION_PLANS_FOUND');
  checks.push(check({
    code: 'plans.current',
    category: 'plans',
    // DX1 decides; this only aggregates. A stale *current* plan stays a warning
    // here because that is what the doctor called it — promoting it would be a
    // second opinion nobody asked for.
    status: gradedPlans.length === 0 ? 'not_applicable'
      : failedPlans.length > 0 ? 'failed'
        : stalePlans.length > 0 ? 'warning' : 'passed',
    authority: 'solution-plan',
    required: true,
    evidence: gradedPlans.length === 0
      ? (noPlansAtAll
        ? 'this project has no solution plan at all'
        : `${planChecks.length} plan(s) found, none declared current or required; an undeclared plan is a historical document and is graded by nobody`)
      : graded.length === 0
        ? `${gradedPlans.length} plan(s) graded, all binding`
        : `${gradedPlans.length} plan(s) graded: ${graded.join(', ')}`,
    reason: gradedPlans.length === 0
      ? (noPlansAtAll ? 'NO_SOLUTION_PLANS_FOUND' : 'NO_DECLARED_PLANS')
      : [...failedPlans, ...stalePlans].map((e) => boundText(e.id)).sort().join(', ') || null,
  }));

  // ---- 4. package conformance ---------------------------------------------
  // Composed packages only. A project-owned core module is not a package and
  // must never be graded as one.
  //
  // The doctor has **already** resolved this: it reads composed package *names*
  // from AX1, locates each one through the composition file, and publishes the
  // resolved *paths* as `project.packagesComposed`. Feeding those paths back
  // into `resolveComposedPackages` — which selects by directory basename —
  // compared `packages/contracts` against `contracts` and matched nothing, so
  // the intersection was empty for every project that composes anything at
  // all. Package conformance then reported `not_applicable` claiming "none
  // with local source in this project" about packages whose source was right
  // there. Use the doctor's answer instead of recomputing it wrongly.
  //
  // There is **no allowlist of package names** anywhere in this selection. Every
  // path the doctor resolved and that exists on disk is graded, whether it is a
  // first-party package under `packages/` or a customer-authored one under
  // `examples/custom-packages/`.
  const composedPaths = boundPathList(doctorReport.project?.packagesComposed);
  const candidates = discoverCandidatePackages(rootDir).map((entry) => entry.path);
  const conformanceTargets = [...composedPaths].sort().filter((path) => existsSync(join(rootDir, path)));
  // Which candidates the project did NOT compose. Comparing the two *lengths*
  // was wrong: a project with two candidates of which one is composed, plus
  // four composed first-party packages, has 2 candidates and 5 targets, so the
  // comparison said "nothing uncomposed" and the inventory evidence vanished
  // exactly when it had something to say. It is a set difference, not a count.
  const uncomposedCandidates = candidates.filter((path) => !conformanceTargets.includes(path)).sort();

  if (blocked) {
    checks.push(check({
      code: 'packages.conformance', category: 'packages', status: 'skipped', authority: 'package-conformance',
      required: true, evidence: 'not attempted', reason: 'PREFLIGHT_FAILED',
    }));
  } else if (conformanceTargets.length === 0) {
    checks.push(check({
      code: 'packages.conformance', category: 'packages', status: 'not_applicable', authority: 'package-conformance',
      required: true,
      evidence: composedPaths.length === 0
        ? 'this project composes no package'
        : `${composedPaths.length} composed package(s), none with local source in this project`,
      reason: composedPaths.length === 0 ? 'NO_PACKAGES_COMPOSED' : 'NO_LOCAL_PACKAGE_SOURCE',
    }));
  } else {
    for (const path of conformanceTargets) {
      const result = await step({
        command: process.execPath,
        args: ['--no-warnings', join(rootDir, 'packages/cli/bin/accordo.js'), 'package', 'test', path, '--json', '--root', rootDir],
        cwd: rootDir,
        env: childEnv,
      });
      checks.push(check({
        code: `packages.conformance.${path}`,
        category: 'packages',
        status: result.ok ? 'passed' : 'failed',
        authority: 'package-conformance',
        required: true,
        evidence: `crm package test ${path}${result.truncated ? ' [output truncated]' : ''}`,
        reason: result.ok ? null : stepReason(result, rootDir),
        durationMs: result.durationMs,
      }));
    }
  }
  if (uncomposedCandidates.length > 0) {
    evidence.push({
      kind: 'packages',
      composed: [...composedPaths].sort(),
      uncomposedCandidates,
      note: 'an uncomposed package is inventory, not a verification target',
    });
  }

  // ---- 5. the project's own declared suites --------------------------------
  const commands = scriptCommands(rootDir);
  const scripts = new Set(Object.keys(commands));
  for (const { script, code, required } of DECLARED_SCRIPTS) {
    if (!scripts.has(script)) {
      checks.push(check({
        code, category: 'suite', status: 'not_applicable', authority: 'project-script', required,
        evidence: `this project declares no "${script}" script`, reason: 'SCRIPT_NOT_DECLARED',
      }));
      continue;
    }
    if (blocked) {
      checks.push(check({
        code, category: 'suite', status: 'skipped', authority: 'project-script', required,
        evidence: 'not attempted', reason: 'PREFLIGHT_FAILED',
      }));
      continue;
    }
    // A project whose declared script calls this command back is a project that
    // cannot be verified: every level runs both declared scripts, so the tree
    // of processes doubles with depth and each level holds its own
    // fifteen-minute timer. Refuse loudly at the first nested level rather than
    // discover the bound the hard way — and never report the recursion as a
    // pass, which is what an unguarded run did.
    if (nested) {
      checks.push(check({
        code, category: 'suite', status: 'failed', authority: 'project-script', required,
        evidence: `npm run ${script}`, reason: 'RECURSIVE_VERIFY_REFUSED',
      }));
      continue;
    }
    // A script whose entry point is not in this project cannot be run, and
    // running it anyway reports a loader error as though the suite had failed.
    // Not applicable, said out loud — and named as a problem, because a
    // `package.json` that declares what it cannot satisfy is a defect in the
    // project, not a silent pass.
    const absentTargets = missingScriptTargets({ rootDir, script, scripts: commands });
    if (absentTargets.length > 0) {
      checks.push(check({
        code, category: 'suite', status: 'not_applicable', authority: 'project-script', required,
        evidence: `npm run ${script} would execute ${absentTargets.join(', ')}, which this project does not contain`,
        reason: 'SCRIPT_TARGET_MISSING',
      }));
      problems.push({
        code: 'DECLARED_SCRIPT_TARGET_MISSING',
        message: `this project's package.json declares a "${script}" script whose entry point (${absentTargets.join(', ')}) is not in the project, so the script cannot run. It was not attempted: a loader error from a file that was never here is not evidence about the suite. Nothing was guessed or substituted`,
      });
      continue;
    }
    const result = await step({ command: 'npm', args: ['run', script, '--silent'], cwd: rootDir, env: childEnv });
    checks.push(check({
      code,
      category: 'suite',
      status: result.ok ? 'passed' : 'failed',
      authority: 'project-script',
      required,
      evidence: `npm run ${script}${result.truncated ? ' [output truncated]' : ''}`,
      reason: result.ok ? null : stepReason(result, rootDir),
      durationMs: result.durationMs,
    }));
  }
  if (nested && DECLARED_SCRIPTS.some(({ script }) => scripts.has(script)) && !blocked) {
    problems.push({
      code: 'RECURSIVE_VERIFY_REFUSED',
      message: `this run is already inside another "project verify" (${VERIFY_DEPTH_ENV}=${outerDepth}), so its declared scripts were not run. A project whose verify or smoke script invokes "accordo project verify" recurses without bound, doubling the process tree at every level; the recursion is refused here rather than bounded, because a verification that verifies itself proves nothing`,
    });
  }

  // ---- 6. the worktree this command promised not to change -----------------
  //
  // The question is not "is the tree dirty" — after a coding-agent change it
  // almost always is, and answering that produced a warning on every real run
  // until a reader learned to skim past it. The question is **what did this
  // command change**, which is a difference between two samples.
  const worktreeAfter = worktreeState(rootDir, git);
  if (worktreeBefore === null || worktreeAfter === null) {
    checks.push(check({
      code: 'worktree.clean', category: 'worktree', status: 'not_applicable', authority: 'git',
      evidence: 'not a git checkout, so "changed while verifying" has no meaning here', reason: 'NOT_A_GIT_CHECKOUT',
    }));
  } else {
    const before = new Map(worktreeBefore.map(sampled).map((entry) => [entry.path, entry.status]));
    const after = new Map(worktreeAfter.map(sampled).map((entry) => [entry.path, entry.status]));
    // A path is the run's doing when it is new, **or** when it was already dirty
    // and the *kind* of dirty changed — a file the operator had modified and a
    // delegate then deleted keeps its path in both samples and is otherwise
    // invisible.
    const caused = [...after.keys()].filter((path) => !before.has(path) || before.get(path) !== after.get(path));
    // A path that was dirty before and is clean now means something *undid* an
    // operator's uncommitted work. That is the failure the "never repaired"
    // promise is about, and until now nothing could have detected it.
    const reverted = [...before.keys()].filter((path) => !after.has(path));
    evidence.push({
      kind: 'worktree',
      dirtyBeforeVerify: [...before.keys()],
      changedByVerify: caused,
      revertedByVerify: reverted,
      note: 'sampled before and after the run; git-ignored build output is excluded by design',
    });

    if (caused.length === 0 && reverted.length === 0) {
      checks.push(check({
        code: 'worktree.clean', category: 'worktree', status: 'passed', authority: 'git',
        evidence: before.size === 0
          ? 'the tree was clean before the run and nothing changed while verifying'
          : `${before.size} path(s) were already modified before the run; verification changed none of them`,
        reason: before.size === 0 ? null : 'DIRTY_BEFORE_VERIFY',
      }));
    } else {
      // Reported, never repaired. A verification command that silently resets
      // the thing it is verifying is worse than one that tells you.
      checks.push(check({
        code: 'worktree.clean', category: 'worktree', status: 'warning', authority: 'git',
        evidence: `${caused.length} path(s) changed and ${reverted.length} reverted while verifying; ${before.size} were already dirty beforehand`,
        reason: [...caused, ...reverted].slice(0, 10).join(', '),
      }));
      if (caused.length > 0) {
        problems.push({
          code: 'WORKTREE_DIRTY_AFTER_VERIFY',
          message: `${caused.length} path(s) that were clean before this run differ from HEAD after it, so something the verification ran writes into the project. Paths already modified beforehand are excluded from this count. Nothing was reset, stashed or hidden`,
        });
      }
      if (reverted.length > 0) {
        problems.push({
          code: 'WORKTREE_REPAIRED_BY_VERIFY',
          message: `${reverted.length} path(s) were modified before this run and match HEAD after it, so something the verification ran discarded uncommitted work. This command never resets, stashes or cleans; a delegate did`,
        });
      }
    }
  }

  const counts = tally(checks);
  const requiredFailed = checks.some((entry) => entry.required && entry.status === 'failed');
  const status = requiredFailed ? 'failed' : counts.warning > 0 ? 'warning' : 'passed';

  const report = {
    projectVerificationContract: PROJECT_VERIFICATION_CONTRACT,
    command: 'project:verify',
    project: {
      kind: projectKind(rootDir),
      packagesComposed: [...composedPaths].sort(),
      declaredScripts: [...scripts].filter((name) => DECLARED_SCRIPTS.some((s) => s.script === name)).sort(),
    },
    inspectionFingerprint,
    status,
    counts,
    checks: sortChecks(checks),
    problems: problems.sort((a, b) => (a.code < b.code ? -1 : 1)),
    limitations: [...LIMITATIONS],
    evidence,
    fingerprint: '',
  };
  report.fingerprint = semanticFingerprint(report);

  if (json) out(`${JSON.stringify(report, null, 2)}\n`);
  else out(render(report));

  return { exitCode: status === 'failed' ? 1 : 0, report };
}

/** @param {any} result @param {string} rootDir */
function stepReason(result, rootDir) {
  if (result.spawnError) return `could not start: ${redact(result.spawnError, rootDir)}`;
  if (result.timedOut) return `timed out after ${STEP_TIMEOUT_MS}ms; its process group was stopped`;
  const summary = summarize(result.output, rootDir);
  const tail = `${summary ? `: ${summary}` : ''}${result.truncated ? ' [output truncated]' : ''}`;
  // A child killed by a signal has no exit code. Reporting that as "exit null"
  // hid the one fact worth knowing: an OOM-killed suite and a suite that
  // returned garbage read identically.
  if (result.code === null && result.signal) return `killed by ${result.signal}${tail}`;
  return `exit ${result.code}${tail}`;
}

/** @param {any[]} checks */
function tally(checks) {
  const counts = { passed: 0, failed: 0, warning: 0, skipped: 0, not_applicable: 0 };
  for (const entry of checks) counts[entry.status] += 1;
  return counts;
}

/** @param {any[]} checks */
export function sortChecks(checks) {
  return [...checks].sort((a, b) => {
    const byCategory = CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category);
    return byCategory !== 0 ? byCategory : (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  });
}

/**
 * The semantic fingerprint: what the run *decided*, never how long it took or
 * where it ran. Two runs of an unchanged project must produce the same value
 * from different directories on different machines.
 *
 * @param {any} report
 */
export function semanticFingerprint(report) {
  const semantic = {
    projectVerificationContract: report.projectVerificationContract,
    status: report.status,
    inspectionFingerprint: report.inspectionFingerprint,
    project: report.project,
    checks: report.checks.map((entry) => ({
      code: entry.code, category: entry.category, status: entry.status,
      authority: entry.authority, required: entry.required,
    })),
    problems: report.problems.map((entry) => entry.code),
  };
  return createHash('sha256').update(canonicalJson(semantic)).digest('hex');
}

/** @param {any} report */
function render(report) {
  const lines = [];
  lines.push(`Accordo project verify (contract ${report.projectVerificationContract})`);
  lines.push(`status: ${report.status}`);
  lines.push('');
  for (const category of CATEGORIES) {
    const rows = report.checks.filter((entry) => entry.category === category);
    if (rows.length === 0) continue;
    lines.push(`${category}:`);
    for (const row of rows) {
      const mark = { passed: 'ok', failed: 'FAIL', warning: 'warn', skipped: 'skip', not_applicable: '-' }[row.status];
      lines.push(`  ${mark.padEnd(5)} ${row.code}${row.reason ? ` — ${row.reason}` : ''}`);
    }
    lines.push('');
  }
  if (report.problems.length > 0) {
    lines.push('problems:');
    for (const problem of report.problems) lines.push(`  ${problem.code}: ${problem.message}`);
    lines.push('');
  }
  lines.push('not proven here:');
  for (const limit of report.limitations) lines.push(`  ${limit.code}`);
  lines.push('');
  return lines.join('\n');
}
