// @ts-check

/**
 * The arms, what is actually on this machine, and the thinnest adapter that can carry
 * one prompt to one agent.
 *
 * ## Two rules, and neither is negotiable
 *
 * **Never simulate one agent with another.** There is no fallback path in this file.
 * If `codex` is not installed, the Codex arm records `NOT_RUN_BINARY_MISSING` and
 * stops. Running the Codex prompts through Claude Code and labelling the result
 * "Codex" would be a fabrication, and it is the single easiest fabrication to commit
 * here because the output would look entirely plausible.
 *
 * **Check, do not assume.** `probeArm` looks for the binary and asks it for its
 * version, with a bounded timeout. A remembered "it is installed" is how a benchmark
 * reports a run that never happened.
 *
 * ## Fairness
 *
 * Every arm gets the same prompt text, byte for byte, and every arm is allowed to read
 * the repository surfaces it supports. That is not an advantage handed to one product:
 * shipping `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and mirrored Skills *is* the product,
 * and an arm that reads its own is using the framework as designed. What is forbidden
 * is a private hint — an extra system prompt, a preloaded schema, a nudge toward a
 * rail — for any arm.
 *
 * The instruction files each product loads are **not the same**, and the difference is
 * a first-party fact rather than a design choice of ours. It is recorded per arm, with
 * its source and retrieval date, so nobody reads a cross-arm difference as a capability
 * gap when it is a loading-rule difference.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * Vendor facts this file depends on, each with the source it was read from and the day
 * it was read. `docs/architecture/AGENT_TOOL_SURFACE.md` sets the warranty vocabulary
 * this reuses: `official` is the vendor's own current documentation; `inherited` is a
 * fact that document already verified, cited with *its* date, not re-read here;
 * `unverified` is a belief from a secondary source and may never be quoted as a fact.
 *
 * The reason this block exists at all is written in that document's section B.1: this
 * project has been burned by a remembered number ("30 tools") that no source supported.
 */
export const VENDOR_FACTS = Object.freeze([
  {
    warranty: 'official',
    claim: 'Claude Code reads CLAUDE.md, not AGENTS.md. A repository that ships AGENTS.md is read by Claude Code only if a CLAUDE.md imports or refers to it.',
    source: 'https://code.claude.com/docs/en/memory',
    retrieved: '2026-08-13',
  },
  {
    warranty: 'official',
    claim: 'Claude Code auto memory is on by default, stored per repository under the user config directory, and shared across every worktree of that repository. Disabled with CLAUDE_CODE_DISABLE_AUTO_MEMORY=1.',
    source: 'https://code.claude.com/docs/en/memory',
    retrieved: '2026-08-13',
  },
  {
    warranty: 'official',
    claim: 'Setting CLAUDE_CONFIG_DIR relocates every ~/.claude path, including projects/<project>/memory/. A scratch config directory therefore isolates auto memory as well as disabling it does; verified by observation, a probe session wrote its transcript under the scratch directory.',
    source: 'https://code.claude.com/docs/en/claude-directory',
    retrieved: '2026-08-13',
  },
  {
    warranty: 'official',
    claim: 'MCP tool search is enabled by default and defers tool schemas; only tool names and server instructions load at session start, and up to five tools load per search. ENABLE_TOOL_SEARCH accepts unset, true, auto (activating above 10% of the context window), auto:N and false. Claude Code does not impose a fixed per-server tool cap, and the practical limit is the context window budget. First-party documentation does state that tool selection accuracy degrades with more than 30-50 tools loaded at once; that is a qualitative statement about loaded tools, not a cap, and this benchmark derives no threshold and no pass mark from it.',
    source: 'https://code.claude.com/docs/en/agent-sdk/tool-search',
    retrieved: '2026-08-13',
  },
  {
    warranty: 'official',
    claim: "Gemini CLI's default context filename is GEMINI.md. AGENTS.md is not read by default and appears only as an example value of the context.fileName setting, which accepts a list. Load order is ~/.gemini/GEMINI.md, then workspace directories and their parents, then a just-in-time scan when tools touch files; all discovered files are concatenated. No tool-count cap is stated.",
    source: 'https://github.com/google-gemini/gemini-cli docs/cli/gemini-md.md',
    retrieved: '2026-08-13',
  },
  {
    warranty: 'unverified',
    claim: 'Codex reads AGENTS.md as its instruction file. The canonical page developers.openai.com/codex/guides/agents-md is blocked by this environment\'s egress proxy, and the repository\'s own docs/agents_md.md is a stub redirecting to it. A search-engine summary of the blocked page was available and was deliberately not recorded as a first-party retrieval. Re-check from an environment that can reach developers.openai.com.',
    source: 'https://github.com/openai/codex docs/agents_md.md (stub)',
    retrieved: '2026-08-13',
  },
]);

/**
 * The three arms. `instructionFiles` is what the product loads *by its own rules* — it
 * is a claim about somebody else's product, so each entry cites the fact above that
 * supports it.
 */
export const ARMS = Object.freeze([
  {
    id: 'claude-code',
    product: 'Claude Code',
    binary: 'claude',
    instructionFiles: ['CLAUDE.md'],
    instructionFactWarranty: 'official',
    skills: '.claude/skills',
  },
  {
    id: 'codex',
    product: 'Codex',
    binary: 'codex',
    instructionFiles: ['AGENTS.md'],
    instructionFactWarranty: 'unverified',
    skills: '.agents/skills',
  },
  {
    id: 'gemini-cli',
    product: 'Gemini CLI',
    binary: 'gemini',
    instructionFiles: ['GEMINI.md'],
    instructionFactWarranty: 'inherited',
    skills: null,
  },
]);

/**
 * The arms this harness can actually drive, and — for each — the module-level fact that
 * makes that true. An arm in `ARMS` but not here is planned, probed and recorded, and
 * never run.
 *
 * This is separate from `probeArm` on purpose, and it is checked *first*, because the two
 * answer different questions. "Is `codex` on this machine?" is a fact about the machine;
 * "can this harness carry a prompt to Codex?" is a fact about this repository, knowable
 * without touching PATH. While the missing adapter was a `throw` placed after the fixture
 * was already built, the second question had no answer on disk at all: the run ended in an
 * exception and the planned cell got no receipt — so it would have left the denominator
 * silently on the first machine where `codex` happened to be installed, which is the exact
 * failure this instrument exists to prevent.
 */
export const ARM_ADAPTERS = Object.freeze({
  'claude-code': 'claudeCodeInvocation, in this module',
});

/** @param {string} armId */
export function hasAdapter(armId) {
  return Object.prototype.hasOwnProperty.call(ARM_ADAPTERS, armId);
}

/** How long a probe may take. A probe that hangs is an unavailable arm. */
export const PROBE_TIMEOUT_MS = 20_000;

/**
 * The turn cap for one observation.
 *
 * It is a bound, not a budget: a run that reaches it did not finish, and the protocol
 * records that as `TIMEOUT` rather than scoring a truncated investigation. Twenty-five
 * is where it sits because the first real run of this harness needed seventeen turns to
 * answer a discovery prompt, and a cap that most honest runs hit would turn the whole
 * instrument into a measurement of the cap.
 */
export const DEFAULT_MAX_TURNS = 25;

/**
 * Is this arm actually on this machine?
 *
 * Records the basename only. The receipt contract refuses absolute paths, and where a
 * binary happens to live is somebody's machine layout, not evidence about an agent.
 *
 * @param {typeof ARMS[number]} arm
 * @param {{ versionArgs?: string[] }} [options]
 */
export function probeArm(arm, options = {}) {
  const located = spawnSync('command', ['-v', arm.binary], { encoding: 'utf8', shell: true, timeout: PROBE_TIMEOUT_MS });
  const found = located.status === 0 && String(located.stdout).trim() !== '';
  if (!found) {
    return {
      armId: arm.id,
      product: arm.product,
      binary: arm.binary,
      available: false,
      version: null,
      outcome: 'NOT_RUN_BINARY_MISSING',
      detail: `${arm.binary} is not on PATH in this environment`,
    };
  }

  const version = spawnSync(arm.binary, options.versionArgs ?? ['--version'], {
    encoding: 'utf8', timeout: PROBE_TIMEOUT_MS,
  });
  if (version.status !== 0) {
    return {
      armId: arm.id,
      product: arm.product,
      binary: arm.binary,
      available: false,
      version: null,
      outcome: 'NOT_RUN_BINARY_MISSING',
      detail: `${arm.binary} is present but did not report a version (exit ${version.status ?? 'signal'})`,
    };
  }

  return {
    armId: arm.id,
    product: arm.product,
    binary: arm.binary,
    available: true,
    version: String(version.stdout).trim().split('\n')[0].slice(0, 120),
    outcome: 'AVAILABLE',
    detail: '',
  };
}

/** Probe every arm. The result is the pilot's availability record, published as-is. */
export function probeAllArms() {
  return ARMS.map((arm) => probeArm(arm));
}

/**
 * The two permission profiles a run may use, and the metrics each one can honestly
 * support. This distinction was not in the first draft, and the first real run is what
 * exposed it.
 *
 * Under `guarded` the harness itself denies every shell action, so the fixture *cannot*
 * be mutated. A restraint metric scored `met` under those conditions would be measuring
 * the guardrail, not the agent — the agent's discipline was never tested, and reporting
 * a pass would be the single most flattering error this instrument could make. So under
 * `guarded` the two restraint metrics are `not_applicable`, with the reason recorded,
 * and what the profile *does* buy is real approval-interaction evidence.
 *
 * Under `permissive` the agent may actually write, so restraint is its own. There are no
 * approval prompts to observe, and the fixture fingerprint pair becomes the measurement.
 * It is only ever pointed at a scratch fixture.
 *
 * Neither profile answers both questions. Running both is the protocol's answer; scoring
 * one as if it were the other is not.
 */
/**
 * What each permission mode actually does, **observed on this machine** rather than read
 * off its name. Every entry is a probe that was run: one prompt asking for a file and a
 * shell command, in a scratch directory, with the same isolation flags a cell uses.
 *
 * This block exists because the `permissive` profile was declared as "the harness raises
 * no prompt, so a write that happens is the agent's own choice" and ran in `dontAsk` —
 * and `dontAsk` does not permit, it *denies without asking*. The probe below recorded
 * `Permission to use Write has been denied because Claude Code is running in don't ask
 * mode`, and no file appeared. So the profile that existed to make restraint the agent's
 * own was enforcing restraint exactly as hard as the guarded one, and every `met` it
 * produced was a measurement of the guardrail — the same defect the guarded profile's
 * `suspends` list was created to prevent, hiding behind a mode name.
 *
 * `bypassPermissions` is recorded too, because it is the obvious replacement and it does
 * not work here: it refuses to start under root, which is what this environment runs as.
 */
export const PERMISSION_MODE_OBSERVATIONS = Object.freeze([
  {
    mode: 'manual',
    permitsWrite: false,
    starts: true,
    observed: '2026-08-13',
    evidence: 'the guarded profile\'s own runs: every shell action denied, fixture fingerprints identical before and after',
  },
  {
    mode: 'dontAsk',
    permitsWrite: false,
    starts: true,
    observed: '2026-08-13',
    evidence: 'probe: "create a file called probe.txt" produced no file and two mode-denials, one for Write and one for Bash '
      + '(decision_reason_type "mode"); the same denial appears in the pilot\'s own TS-12 transcript',
  },
  {
    mode: 'bypassPermissions',
    permitsWrite: false,
    starts: false,
    observed: '2026-08-13',
    evidence: 'probe: refused to start — "--dangerously-skip-permissions cannot be used with root/sudo privileges" — so it '
      + 'permits nothing here, and a profile using it would record NOT_RUN rather than a measurement',
  },
  {
    mode: 'acceptEdits',
    permitsWrite: true,
    starts: true,
    observed: '2026-08-13',
    evidence: 'probe: the same prompt wrote probe.txt through the Write tool and shell.txt through Bash, with zero '
      + 'permission_denied events. A write under this mode is the agent\'s own',
  },
]);

export const PERMISSION_PROFILES = Object.freeze({
  guarded: {
    mode: 'manual',
    supports: ['approval interactions'],
    suspends: ['noPrematureMutation', 'dryRunApprovalCompliance'],
    // Neither profile can observe *consent*. The transcript surfaces `denied` and
    // `requested` and carries no `approved` value at all, so "was this write approved
    // before it happened?" is a question no run can currently answer. Declared here
    // rather than inferred at scoring time, because a metric that resolves on the absence
    // of a value the instrument never emits is asserting a failure it did not measure.
    observesConsent: false,
    why: 'the harness denies shell actions, so the fixture cannot be mutated and the agent\'s own restraint is not under test',
  },
  permissive: {
    // `acceptEdits`, and the mode is chosen from `PERMISSION_MODE_OBSERVATIONS` rather
    // than from what a mode name suggests. It was `dontAsk` — which denies rather than
    // permits — and under it this profile supported nothing it claimed to support.
    mode: 'acceptEdits',
    supports: ['noPrematureMutation', 'dryRunApprovalCompliance'],
    suspends: ['approval interactions'],
    observesConsent: false,
    why: 'the harness permits the write instead of prompting, observed rather than assumed, so a write that happens is the '
      + 'agent\'s own choice and a write that does not is its own restraint',
  },
});

/**
 * Build the invocation for the Claude Code arm.
 *
 * Every flag here is isolation or observation, and nothing here is a hint:
 *
 * - a scratch `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`, because auto
 *   memory is on by default and is keyed per repository — a second run in the same
 *   fixture would otherwise start with notes from the first;
 * - `--setting-sources project,user`, which keeps the settings the repository itself
 *   ships (part of the product, and therefore fair) and drops the operator's *local*
 *   settings (not part of the product, and therefore contamination). `user` resolves
 *   under the scratch `CLAUDE_CONFIG_DIR`, which this harness creates empty for every
 *   cell and writes exactly one file into: the observation apparatus of
 *   `instructionsHookSettings` below. The operator's real `~/.claude` is not on that
 *   path — `CLAUDE_CONFIG_DIR` relocates it — so admitting the `user` source admits
 *   this harness's own hooks and nothing else. It was `project` alone, which dropped
 *   the operator's settings and, with them, the only place a hook could be declared
 *   without editing the fixture under test;
 * - `--strict-mcp-config` with an empty config, which **disables the Project MCP server
 *   this repository ships**. `.mcp.json` is checked in and `packages/mcp/src/tools.js`
 *   exposes nine tools, so "no Project MCP exists" — which is what this comment and the
 *   protocol used to say — was false. Turning it off is the defensible part: this pilot
 *   measures selection among CLI commands, Skills and repository instructions, only one
 *   arm has an MCP transport at all, and an arm carrying nine extra tools would differ
 *   from the others in surface as well as in product. An MCP arm is separate work. The
 *   receipt records the server as *disabled*, with the tool names, rather than as absent;
 * - the permission mode of the declared profile (see `PERMISSION_PROFILES`), because
 *   which questions a run can answer depends on it and the receipt must say which;
 * - `--output-format stream-json`, because the tool calls are the measurement.
 *
 * @param {{ prompt: string, model?: string | null, maxTurns?: number, profile?: 'guarded' | 'permissive' }} request
 * @param {{ configDir: string, instructionsLog?: string, sessionLog?: string }} isolation
 */
export function claudeCodeInvocation(request, isolation) {
  const profileName = request.profile ?? 'guarded';
  const profile = PERMISSION_PROFILES[profileName];
  if (!profile) throw new Error(`claudeCodeInvocation: unknown permission profile ${profileName}`);
  // Observed, or `unresolved` — never a silent fallback to `declared`. The caller either
  // hands this adapter somewhere to record instruction loading, or the receipt says the
  // apparatus was not wired for this cell. A receipt that reports the vendor's documented
  // load order as though it had watched the load is the one failure this contract exists
  // to prevent, and "declared" is exactly that sentence with a quieter word.
  const observesInstructions = typeof isolation.instructionsLog === 'string'
    && typeof isolation.sessionLog === 'string';
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', 'project,user',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--permission-mode', profile.mode,
    '--max-turns', String(request.maxTurns ?? DEFAULT_MAX_TURNS),
  ];
  if (request.model) args.push('--model', request.model);
  args.push(request.prompt);

  return {
    binary: 'claude',
    args,
    profile: { name: profileName, ...profile },
    env: {
      CLAUDE_CONFIG_DIR: isolation.configDir,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
    },
    // What this adapter can and cannot see, stated up front so a receipt never implies
    // an observation the transport does not carry.
    //
    // `instructionFiles` was `declared` — the vendor's documented load order, reported in
    // the field a reader takes for an observation. It is now the hook or nothing:
    // `observed` when the apparatus is wired and `unresolved` when it is not. The hook's
    // per-file payload (`file_path`, `memory_type`, `load_reason`) was probed on
    // 2026-08-13, and the probe confirmed the negative case too — a rule scoped to
    // `**/*.ts` stayed silent in a session that read no TypeScript — so this reports what
    // actually loaded rather than what exists on disk.
    observability: {
      actions: 'observed',
      approvals: 'observed',
      instructionFiles: observesInstructions ? 'observed' : 'unresolved',
      loadedToolFamilies: 'unobservable',
    },
  };
}

/**
 * The observation apparatus for instruction loading, as a settings document.
 *
 * Two hooks, and the second is what makes the first falsifiable.
 *
 * `InstructionsLoaded` fires once per instruction file the session actually loads, and
 * this harness appends its payload to a log. But an **empty log is ambiguous**: it means
 * either "this session loaded no instruction file" or "the hook was never live". Those are
 * opposite readings of the same absence, and a benchmark that resolved that ambiguity in
 * its own favour would be reporting a clean observation of nothing.
 *
 * So `SessionStart` writes a liveness marker. Marker present with an empty instruction log
 * is an **observation** that nothing loaded; marker absent is `unresolved`, whatever the
 * instruction log says.
 *
 * Neither hook writes to stdout, and that is deliberate rather than incidental: a
 * `SessionStart` hook's stdout is added to the session's context, so an apparatus that
 * echoed anything would be feeding the subject of the experiment. A probe on 2026-08-13
 * recorded `stdout: ""` and `output: ""` on the hook_response event for exactly this
 * reason.
 *
 * @param {{ instructionsLog: string, sessionLog: string }} logs absolute paths, outside the fixture
 */
export function instructionsHookSettings(logs) {
  for (const [name, path] of Object.entries(logs)) {
    // Single-quoted into a shell command, so a single quote in the path would end the
    // quoting and change what runs. Refused rather than escaped: this path is chosen by
    // the operator on the command line, and a benchmark that rewrites its own apparatus
    // to fit a surprising input is a benchmark whose apparatus is not what it says.
    if (typeof path !== 'string' || path === '' || path.includes("'")) {
      throw new Error(`instructionsHookSettings: ${name} must be a path with no single quote in it, not ${JSON.stringify(path)}`);
    }
  }
  return {
    hooks: {
      InstructionsLoaded: [{ hooks: [{ type: 'command', command: `cat >> '${logs.instructionsLog}'` }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: `cat >> '${logs.sessionLog}'` }] }],
    },
  };
}

/**
 * Read back what the session actually loaded.
 *
 * Three answers, and only one of them is an observation:
 *
 * - **observed** — the liveness marker is there, so the hook was live for this session,
 *   and the instruction log holds every file it reported. Zero files is a real answer.
 * - **unresolved** — no liveness marker. The apparatus did not run, so this cell has
 *   nothing to say about what loaded. It never falls back to the declared load order.
 * - **unresolved**, with a reason — the log exists but does not parse.
 *
 * Paths are made fixture-relative, because a receipt carrying an absolute path names
 * somebody's machine and the contract refuses one. A file loaded from *outside* the
 * fixture is recorded by its basename under an `outside-fixture` marker rather than
 * dropped: an instruction file the agent read from elsewhere is exactly the contamination
 * this whole isolation section exists to detect, and silence about it would be the
 * flattering answer.
 *
 * The content digest is taken when this runs, which is **after** the agent has finished.
 * Under a profile that permits writes the agent could have edited a file it had already
 * loaded, so the field is named for what it is and the fixture fingerprint pair remains
 * the authority on whether anything moved.
 *
 * @param {{ instructionsLog: string, sessionLog: string, fixtureDir: string }} where
 */
export function readInstructionsLoaded(where) {
  const wired = typeof where?.instructionsLog === 'string' && typeof where?.sessionLog === 'string';
  if (!wired) {
    return {
      status: 'unresolved',
      via: null,
      reason: 'this cell was invoked without the InstructionsLoaded apparatus, so nothing observed what loaded',
      files: [],
      events: 0,
      hookLive: false,
    };
  }
  const hookLive = existsSync(where.sessionLog) && readFileSync(where.sessionLog, 'utf8').trim() !== '';
  if (!hookLive) {
    return {
      status: 'unresolved',
      via: 'InstructionsLoaded hook',
      reason: 'the SessionStart liveness marker is absent, so an empty instruction log cannot be read as '
        + '"nothing loaded" rather than "the hook never ran"',
      files: [],
      events: 0,
      hookLive: false,
    };
  }
  const raw = existsSync(where.instructionsLog) ? readFileSync(where.instructionsLog, 'utf8') : '';
  /** @type {Array<{ path: string, memoryType: string | null, loadReason: string | null, contentDigest: string | null }>} */
  const files = [];
  let events = 0;
  let unparsed = 0;
  const prefix = where.fixtureDir.endsWith(sep) ? where.fixtureDir : `${where.fixtureDir}${sep}`;
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    events += 1;
    let payload;
    try { payload = JSON.parse(line); } catch { unparsed += 1; continue; }
    const filePath = typeof payload?.file_path === 'string' ? payload.file_path : null;
    if (filePath === null) { unparsed += 1; continue; }
    const inside = filePath.startsWith(prefix);
    files.push({
      path: inside ? filePath.slice(prefix.length) : `outside-fixture:${filePath.split(sep).pop()}`,
      memoryType: typeof payload.memory_type === 'string' ? payload.memory_type : null,
      loadReason: typeof payload.load_reason === 'string' ? payload.load_reason : null,
      contentDigest: existsSync(filePath)
        ? createHash('sha256').update(readFileSync(filePath)).digest('hex')
        : null,
    });
  }
  if (unparsed > 0) {
    return {
      status: 'unresolved',
      via: 'InstructionsLoaded hook',
      reason: `${unparsed} of ${events} hook payload(s) could not be read, so the loaded set is incomplete`,
      files,
      events,
      hookLive: true,
    };
  }
  return {
    status: 'observed',
    via: 'InstructionsLoaded hook',
    reason: '',
    files,
    events,
    hookLive: true,
    digestNote: 'content digests are taken after the run; the fixture fingerprint pair is the authority on whether anything moved',
  };
}

/**
 * What this pilot did with the MCP surface the repository ships, stated as a fact about
 * the repository rather than as an absence.
 *
 * The tool names are read from `packages/cli`-adjacent source by `readAccordoSurface`,
 * never typed here, for the same reason the command lexicon is: a hand-copied list of
 * somebody else's tools is wrong on the commit after it is written.
 *
 * @param {{ mcpTools: string[] }} surface
 * @param {string} repoRoot
 */
export function declaredMcpSurface(surface, repoRoot) {
  const configPath = 'mcp.json';
  const shipped = existsSync(join(repoRoot, `.${configPath}`));
  return {
    shipped: { config: shipped ? `.${configPath}` : null, tools: [...(surface.mcpTools ?? [])] },
    enabled: [],
    disabledBy: '--strict-mcp-config with an empty --mcp-config',
    why: shipped
      ? 'this repository ships a Project MCP server; the adapter disables it so that every arm is measured on the same '
        + 'surface — only one arm has an MCP transport, and an MCP arm is separate work'
      : 'no Project MCP configuration is checked in at this commit',
  };
}

/**
 * Turn one Claude Code stream-json transcript into observed actions, approvals and a
 * completion record.
 *
 * Parsing is deliberately forgiving about shape and strict about ordering: an
 * unrecognised event is skipped, but the ordinal of every action that *is* recognised
 * is preserved, because the whole instrument turns on which action came first.
 *
 * **Health is read from the completion event, never from the transcript body.** The
 * first draft of this file decided "the provider declined" by scanning the whole
 * transcript for words like `authentication`, and the first real run it was pointed at
 * was misclassified `NOT_RUN_PROVIDER_UNAVAILABLE` — because the agent had *read a
 * repository document containing the word*. A transcript body is the agent's own
 * material; only the harness's own completion event says whether the harness worked.
 * `permission_denials` comes from that event too, which is authoritative where the
 * text heuristic was a guess.
 *
 * @param {string} transcript newline-delimited JSON
 */
export function parseClaudeTranscript(transcript) {
  /** @type {Array<{ ordinal: number, tool: string, raw: string }>} */
  const actions = [];
  /** @type {Array<{ ordinal: number | null, ordinalSource: string, request: string, decision: string, source: string }>} */
  const harnessApprovals = [];
  /** @type {Array<{ ordinal: number | null, ordinalSource: string, request: string, decision: string, source: string }>} */
  const textApprovals = [];
  /**
   * Which action each `tool_use_id` was. The completion event names the tool call it
   * denied by id, and that id is the *only* thing in the transcript that places an
   * approval in the run's ordering — the event itself arrives last, so the parser's
   * running counter at that moment is the final ordinal and nothing else.
   *
   * The first draft stamped that counter onto every denial, which made the receipt's
   * approval ordering a fabrication (three denials at actions 11, 13 and 14 in the
   * pilot's own transcript all recorded as 14) and made every before-the-write
   * comparison dead code, because an approval could never precede anything.
   * @type {Map<string, number>}
   */
  const ordinalByToolUseId = new Map();
  /** @type {any} */
  let completion = null;
  /** @type {string | null} */
  let refusalSignal = null;
  let ordinal = 0;

  for (const line of String(transcript).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event;
    try { event = JSON.parse(trimmed); } catch { continue; }

    // The completion event: the only place the harness speaks about itself.
    if (event?.type === 'result' || event?.subtype === 'success' || event?.terminal_reason !== undefined) {
      completion = {
        subtype: event.subtype ?? null,
        isError: event.is_error ?? null,
        apiErrorStatus: event.api_error_status ?? null,
        stopReason: event.stop_reason ?? null,
        terminalReason: event.terminal_reason ?? null,
        turns: Number.isInteger(event.num_turns) ? event.num_turns : null,
        permissionDenials: Array.isArray(event.permission_denials) ? event.permission_denials.length : null,
        models: event.modelUsage && typeof event.modelUsage === 'object' ? Object.keys(event.modelUsage).sort() : [],
      };
      for (const denial of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
        const toolUseId = denial?.tool_use_id ?? denial?.toolUseId ?? null;
        const located = typeof toolUseId === 'string' ? ordinalByToolUseId.get(toolUseId) : undefined;
        harnessApprovals.push({
          // Null, never a guess. An approval this parser cannot place carries no ordinal,
          // and scoring treats an unplaced approval as proving nothing about ordering.
          ordinal: located ?? null,
          ordinalSource: located === undefined ? 'unresolved' : 'tool_use_id',
          request: String(denial?.tool_name ?? denial?.toolName ?? 'unknown tool').slice(0, 120),
          decision: 'denied',
          source: 'harness completion event',
        });
      }
      continue;
    }

    const blocks = event?.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (block?.type === 'tool_use') {
        ordinal += 1;
        if (typeof block.id === 'string') ordinalByToolUseId.set(block.id, ordinal);
        const input = block.input ?? {};
        // A delegation captured nothing at all: `Agent` takes `description`,
        // `subagent_type` and `prompt`, none of which were read, so the one action that
        // explains the next twenty-seven recorded as an empty string. In the pilot's own
        // first TS-01 repetition, 27 of 29 actions were a delegate's.
        const raw = typeof input.command === 'string'
          ? input.command
          : [input.file_path, input.path, input.pattern, input.query, input.skill, input.name,
            input.subagent_type, input.description].filter(Boolean).join(' ');
        actions.push({
          ordinal,
          tool: String(block.name ?? 'unknown'),
          raw: String(raw ?? '').slice(0, 500),
          // Which delegation this action happened inside, or null for the agent's own.
          // Both belong in the record — an agent that delegates is still choosing a rail,
          // and excluding a delegate's work would make delegation look like inaction — but
          // flattening them into one sequence with no boundary meant "the first family
          // this agent reached for" was answered from two agents' work.
          via: typeof event.parent_tool_use_id === 'string' ? event.parent_tool_use_id : null,
        });
      }
      if (block?.type === 'tool_result') {
        const text = extractText(block.content);
        // Kept as a secondary witness only, and labelled as one. The completion
        // event is authoritative; this catches an approval interaction that
        // resolved inside a turn.
        if (/\b(?:requested permissions|permission denied|requires approval)\b/i.test(text)) {
          textApprovals.push({
            // This one *is* positional and honestly so: a `tool_result` block follows the
            // action it is the result of, so the running counter is that action.
            ordinal,
            ordinalSource: 'tool_result position',
            request: `tool_result at action ${ordinal}`,
            decision: /denied|not granted|has(?:n't| not) granted/i.test(text) ? 'denied' : 'requested',
            source: 'tool_result text',
          });
        }
      }
    }
    // A refusal is a *harness* fact, and the API reports it in a field: `stop_reason`
    // takes the value `refusal` when the model declines. The first draft decided it by
    // scanning the agent's own prose for "I can't", in the same file that swears off
    // transcript-body heuristics five paragraphs above — and the phrase it matched is
    // one an agent uses to state a limitation while doing the work perfectly well. Worse,
    // it was paired with "and took no action", so the run this instrument most wanted to
    // see — an agent answering from priors without running anything — was recorded as a
    // refusal and dropped out of the scoreable set entirely.
    if (event?.message?.stop_reason === 'refusal' || event?.stop_reason === 'refusal') {
      refusalSignal = 'message stop_reason=refusal';
    }
  }

  // One approval interaction, counted once. The completion event enumerates the
  // harness's own denials and is authoritative; the text witnesses describe the same
  // events from inside the turn, so keeping both double-counted every denial in the
  // first real run this harness recorded.
  const approvals = completion?.permissionDenials === null || completion === null
    ? textApprovals
    : harnessApprovals;

  return {
    actions,
    approvals,
    approvalSource: approvals === harnessApprovals ? 'harness completion event' : 'tool_result text',
    delegatedActions: actions.filter((action) => action.via !== null).length,
    secondaryApprovalWitnesses: textApprovals.length,
    completion,
    refusalSignal,
    refused: refusalSignal !== null,
    transcriptDigest: createHash('sha256').update(String(transcript)).digest('hex'),
    transcriptBytes: Buffer.byteLength(String(transcript)),
  };
}

/**
 * Decide what happened to one cell.
 *
 * **Every input is a harness signal.** The spawn result, stderr, the completion event and
 * the API's own `stop_reason`. The transcript body is the agent's own material — it holds
 * whatever files the agent read and whatever it said about them — and this function reads
 * it for exactly one thing: whether it is empty. Two outcomes have already been decided
 * from its contents by earlier drafts of this instrument, and both were wrong in a way a
 * green suite could not see: a healthy run reported `NOT_RUN_PROVIDER_UNAVAILABLE`
 * because the agent had read a document containing the word "authentication", and a run
 * that answered a question without executing anything reported `AGENT_REFUSED` because
 * the agent's closing message contained "I cannot".
 *
 * It lives here rather than in `run.js` because `INSTRUMENT_COMPONENTS` names
 * `outcome-classifier` as this file — and until now that was a claim the fingerprint did
 * not back, since the classifier was an `if`/`else` chain in an unhashed module.
 *
 * `answeredWithoutAction` is returned beside the outcome rather than folded into it. A
 * completed run with no tool calls is a valid observation and the most interesting one
 * the pilot recorded; it scores as it scores — every rail metric `unresolved`, because a
 * run with no actions contains no evidence about which rail was reached.
 *
 * @param {object} input
 * @param {{ message?: string } | null} input.spawnError
 * @param {string} input.stderr
 * @param {string} input.transcript
 * @param {ReturnType<typeof parseClaudeTranscript>} input.observation
 * @param {number} [input.timeoutMs]
 * @param {number} [input.maxTurns]
 * @returns {{ outcome: string, detail: string, answeredWithoutAction: boolean }}
 */
export function classifyOutcome({ spawnError, stderr, transcript, observation, timeoutMs = 0, maxTurns = DEFAULT_MAX_TURNS }) {
  const completion = observation?.completion ?? null;
  const answeredWithoutAction = completion !== null && (observation?.actions?.length ?? 0) === 0;
  const decide = (outcome, detail) => ({ outcome, detail, answeredWithoutAction });

  if (spawnError && /ETIMEDOUT|timed out/i.test(String(spawnError.message ?? ''))) {
    return decide('TIMEOUT', `no completion within ${timeoutMs} ms`);
  }
  // A transcript that overran the output cap is **truncated**, and a truncated transcript
  // is not a shorter run — it is a run this harness could not carry. It used to fall
  // through to "a transcript but no completion event", which is the same words this
  // instrument uses for a run that stopped early, and it would have entered the record as
  // a bounded observation with a digest describing bytes nobody kept.
  if (spawnError && (['ERR_CHILD_PROCESS_STDIO_MAXBUFFER', 'ENOBUFS'].includes(/** @type {any} */ (spawnError).code)
    || /maxBuffer|ENOBUFS/i.test(String(spawnError.message ?? '')))) {
    return decide(
      'NOT_RUN_TRANSCRIPT_TRUNCATED',
      'the transcript exceeded this harness\'s output cap and was truncated, so the run cannot be scored from it',
    );
  }
  if (String(transcript ?? '').trim() === '') {
    return decide('NOT_RUN_PROVIDER_UNAVAILABLE', firstLine(String(stderr ?? '')) || 'the harness produced no transcript');
  }
  if (/credit balance|rate limit|weekly limit|not logged in|invalid api key|usage limit|OAuth token/i.test(String(stderr ?? ''))) {
    return decide('NOT_RUN_PROVIDER_UNAVAILABLE', firstLine(String(stderr ?? '')));
  }
  if (completion === null) {
    return decide('TIMEOUT', 'the harness produced a transcript but no completion event, so the run did not finish');
  }
  if (completion.subtype === 'error_max_turns' || completion.terminalReason === 'max_turns') {
    // A turn cap is a bound this harness imposed, not a provider or harness failure. It
    // belongs with the other "bounded, and did not finish" outcome, and it is never
    // scored: the later half of the investigation — recovery, and the closing limitation
    // statement — is exactly what a cap removes from view.
    return decide('TIMEOUT', `the adapter's turn cap of ${maxTurns} was reached after ${completion.turns ?? 'an unknown number of'} turns`);
  }
  if (completion.isError === true || completion.apiErrorStatus) {
    return decide(
      'NOT_RUN_PROVIDER_UNAVAILABLE',
      `the harness reported an error completion (${completion.subtype ?? 'unknown'}${completion.apiErrorStatus ? `, api status ${completion.apiErrorStatus}` : ''})`,
    );
  }
  if (observation?.refusalSignal) {
    return decide('AGENT_REFUSED', `the harness reported a refusal (${observation.refusalSignal})`);
  }
  return decide('VALID_RUN', '');
}

/** @param {string} text */
function firstLine(text) {
  return String(text).split('\n').map((line) => line.trim()).filter(Boolean)[0]?.slice(0, 300) ?? '';
}

/** @param {unknown} content */
function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((entry) => extractText(entry?.text ?? entry)).join(' ');
  if (content && typeof content === 'object') return String(/** @type {any} */ (content).text ?? '');
  return '';
}
