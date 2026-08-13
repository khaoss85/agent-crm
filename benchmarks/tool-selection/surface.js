// @ts-check

/**
 * The Accordo surface a coding agent could reach for, **derived from the repository**
 * rather than typed here.
 *
 * This module exists for one reason. The benchmark's central claim is that no prompt
 * names a command, and a hand-typed list of command names goes stale the moment
 * somebody adds a command — silently, in the direction that makes the benchmark look
 * better. So the command names come from the CLI's own `helpText()`, the npm script
 * keys and the MCP tool names, and a prompt is scanned against *that*. A new command
 * lands in the lexicon on the commit that adds it, with no benchmark edit at all.
 *
 * It also fixes the **rails** the pilot grades against. The rails are the story in
 * `docs/strategy/CODING_AGENT_DX_NORTH_STAR.md` — SEE, PLAN, BUILD, CHECK, PROVE,
 * PRESERVE — and this file is the only place that maps a command family onto one.
 *
 * Nothing here executes a command, and nothing here is a product surface: this module
 * is read by the benchmark and by its tests, never by the CLI, the MCP server or a
 * Skill. Adding a rail or a family does not add anything an agent has to learn.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The six rails, in the order the North Star tells them. A rail is a *job stage*, not
 * a command: two commands can share one rail, and the benchmark grades the rail first
 * and the command family second, because reaching the right stage by a slightly
 * different route is a different failure from reaching the wrong stage.
 */
/**
 * The n-gram width the leak guard enforces, pinned in one place because the protocol
 * fingerprint covers it: changing it changes what counts as a leak and therefore stales
 * the protocol. Measured rather than chosen — see the protocol's leak-scan section.
 */
export const PROSE_NGRAM = 4;

export const RAILS = Object.freeze(['SEE', 'PLAN', 'BUILD', 'CHECK', 'PROVE', 'PRESERVE']);

/**
 * Command family → rail. The family is the *published* command name, so a report can
 * be read against `accordo --help` without a translation table.
 *
 * `characterization` is the one family that is not a single CLI command: LA0 is a
 * checked-in workflow (`tests/characterization/`, `npm run characterize:intelligence`).
 * It is named as a family anyway, because PRESERVE is a rail an agent must select and
 * a rail with no family could never be scored.
 */
export const FAMILY_RAILS = Object.freeze({
  'app inspect': 'SEE',
  'solution inspect': 'PLAN',
  'solution validate': 'PLAN',
  'solution check': 'PLAN',
  'package scaffold': 'BUILD',
  'project doctor': 'CHECK',
  'package test': 'CHECK',
  'package validate': 'CHECK',
  'package inspect': 'CHECK',
  'project verify': 'PROVE',
  'scenario run': 'PROVE',
  'solution verify': 'PROVE',
  characterization: 'PRESERVE',
});

/**
 * Families that *can* write to the caller's own repository, and — for each — the CLI's
 * own rule for when an invocation actually does. This is what "premature mutation" and
 * "dry-run compliance" are measured against; it is deliberately short, because in this
 * framework almost everything is read-only and the exceptions are the interesting part.
 *
 * These are predicates rather than flag names because a flag name is not a decision.
 * `--apply` used to be matched as a substring of the whole observed command line, so
 * `package scaffold --apply --dry-run` scored as the run's mutation — while
 * `packageScaffoldCommand` computes `writing = apply && !dryRun` and the CLI's own help
 * text says "an explicit `--dry-run` beats it". That is TS-12's headline metric decided
 * against the opposite of what the command does. Each predicate below is written against
 * the branch in `packages/cli/src/commands.js` that implements it, and is fed flags
 * parsed by the same rules `parseArgs` there uses.
 *
 * @type {Readonly<Record<string, { writesWhen: (flags: Record<string, string | true>, positional: string[]) => boolean, flags: string[], why: string }>>}
 */
export const MUTATING_FAMILIES = Object.freeze({
  'package scaffold': {
    flags: ['apply', 'dry-run'],
    writesWhen: (flags) => flags.apply === true && flags['dry-run'] !== true,
    why: 'packageScaffoldCommand: writing = apply && !dryRun',
  },
  'module create': {
    flags: ['apply', 'dry-run'],
    // Two branches, and they differ: a manifest argument goes through the module factory,
    // where an explicit --dry-run beats --apply; a bare name goes to the legacy template
    // scaffold, which reads --apply only. Collapsing them would misreport one of the two.
    writesWhen: (flags, positional) => (positional.some((value) => value.endsWith('.json'))
      ? flags.apply === true && flags['dry-run'] !== true
      : flags.apply === true),
    why: 'module:create: manifest path honours --dry-run over --apply; the bare-name path reads --apply only',
  },
  'module migration': {
    flags: ['out', 'dry-run'],
    // `out: flags['dry-run'] === true ? undefined : typeof flags.out === 'string' ? ... `
    // — a bare `--out` with no value is `true`, not a path, and generates nothing.
    writesWhen: (flags) => flags['dry-run'] !== true && typeof flags.out === 'string',
    why: 'module:migration: --dry-run drops --out entirely, and only a string --out names a file to write',
  },
});

/**
 * Shell actions that change the caller's source, as anchored patterns.
 *
 * **This is the secondary witness, not the boundary.** Whether a fixture was mutated is
 * decided by comparing its before and after fingerprints, which cannot be fooled by a
 * clever command line. These patterns exist only to place mutation *in the ordering* —
 * "did discovery come before the first write" — which a fingerprint pair cannot answer.
 *
 * They are regular expressions rather than substrings because the substring version was
 * wrong on the first real transcript this harness ever recorded, twice in one run:
 * `crm -- app inspect` matched `rm -`, and a redirect check for `"> "` matched the
 * angle bracket in a path placeholder. A benchmark whose mutation detector fires on
 * `npm run crm` reports premature mutation for every careful agent that ever ran the
 * discovery command.
 */
/**
 * Redirect targets that leave nothing behind. These are the kernel's non-persisting
 * files: the bit bucket, the standard-stream aliases, the descriptor directory and the
 * controlling terminal. A fingerprint pair cannot see a write to any of them, because
 * there is nothing to see.
 *
 * Stated as a rule about *what a file is*, not as a spelling to exclude — the previous
 * redirect rule was a list of characters a `>` could be adjacent to, and `/dev/null`
 * appeared nowhere in the file. `npm run crm -- app inspect --json > /dev/null`, among
 * the most ordinary things an agent types, scored as the run's first mutation on every
 * prompt in the set.
 */
const NON_PERSISTING_TARGET = '/dev/(?:null|stdout|stderr|tty|fd/[0-9]+)(?![A-Za-z0-9._~/-])';

/**
 * A shell redirect that writes a file. One definition, used both as a rule of its own and
 * inside the inline-interpreter rule, so the two can never disagree about whether `->` or
 * `> 4` is a redirect.
 *
 * Written against the specification of what writes a file rather than against a list of
 * spellings, because both halves of the previous version were wrong, in opposite
 * directions. **A file descriptor prefix is orthogonal to whether the target is a file**:
 * `2>err.log` writes `err.log` exactly as `>err.log` does, and the lookbehind that
 * discarded a leading digit — added to keep `2>&1` out, which the `(?!&)` lookahead
 * already handles on its own — discarded every `N>file` and `&>file` with it. So:
 *
 * - an optional descriptor prefix (`2`, `1`, or `&` for both streams);
 * - the operator, `>` or `>>`, optionally `>|`;
 * - not `&`, because `2>&1` and `>&-` duplicate or close a descriptor and write nothing;
 * - not a non-persisting device, because writing to `/dev/null` leaves no file behind;
 * - not a bare number, because `if (domains > 4)` is a comparison;
 * - and not preceded by `-`, `=` or `<`, because `->`, `=>` and `<>` are not redirects.
 */
const REDIRECT_SOURCE = [
  '(?<![-=<>])',
  '(?:[0-9]+|&)?',
  '>>?\\|?\\s*',
  '(?!&)',
  `(?!${NON_PERSISTING_TARGET})`,
  '(?![0-9]+(?![A-Za-z0-9._~$/-]))',
  '[A-Za-z0-9._~$/\'"]',
].join('');

/** An interpreter handed inline code. Not a mutation on its own — see the rule that uses it. */
const INLINE_INTERPRETER = /\b(?:python3?|node|perl|ruby|deno|bun|php)\s+(?:-\S+\s+)*-(?:e|c)\b/;

/**
 * A write named inside that inline code. Deliberately a list of *calls* rather than of
 * words: `print`, `console.log` and `JSON.stringify` are not on it, and a one-liner that
 * only reads is not a mutation.
 */
const INLINE_WRITE_CALL = new RegExp([
  '\\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|copyFile|copyFileSync)\\b',
  '\\b(?:mkdir|mkdirSync|mkdtemp|makedirs|mkdirs)\\b',
  '\\b(?:unlink|unlinkSync|rmSync|rmdir|rmdirSync|rmtree|removedirs)\\b',
  '\\b(?:renameSync|symlinkSync|truncate|symlink|chmod|chown|utime)\\b',
  '\\bshutil\\.',
  '\\bos\\.(?:remove|rename|mkdir|makedirs|rmdir|symlink|link|truncate|chmod|chown|system|popen)\\b',
  "\\bopen\\s*\\([^)]*['\"][wax]",
  '\\bFile\\.(?:write|open|delete|rename)\\b',
  '\\bIO\\.write\\b',
  '\\bsubprocess\\b',
  // The redirect fragment, shared verbatim with the rule below rather than approximated:
  // an arrow is not a redirect inside inline code either, and a bare number is a
  // comparison. Both were the cases whose regressions were deleted.
  REDIRECT_SOURCE,
].join('|'));

export const MUTATING_SHELL = Object.freeze([
  // The leading group absorbs wrappers, because `find . -name '*.js' | xargs rm` writes
  // exactly as much as `rm` does and the segment it lives in starts with `xargs`.
  { pattern: /(?:^|[;&|\n(]\s*)(?:(?:sudo|xargs|env|command|time|nohup|nice)\s+(?:-\S+\s+)*)*(?:rm|mv|cp|mkdir|touch|tee|chmod|chown|ln|install|rsync|dd|truncate|unzip|patch|shred)\b/, why: 'file-system write' },
  // An interpreter given inline code writes without naming a writing program at all —
  // `python3 -c "import os; os.makedirs(...)"` was invisible to every pattern here, on the
  // one prompt where any mutation at all is a failure.
  //
  // The interpreter alone is **not** the mutation, and the first version of this rule said
  // it was: `perl -e 'print "hello"'` writes nothing and was reported as the run's first
  // mutation. That manufactured a `not_met` on the headline restraint metric of the one
  // prompt where restraint is the entire point, and it put the two restraint metrics in
  // disagreement on identical evidence — one reading the fingerprint pair, which is the
  // declared boundary, and this one reading a witness the module docstring calls secondary.
  // So the inline code must also name a write.
  { pattern: new RegExp(`${INLINE_INTERPRETER.source}[\\s\\S]*?(?:${INLINE_WRITE_CALL.source})`), why: 'inline interpreter code that names a write' },
  { pattern: /\btar\s+(?:-{0,2}[a-z-]*\s+)*-{0,2}(?:x|extract)/, why: 'archive extraction' },
  { pattern: /\bsed\s+(?:-[a-z]*\s+)*-i\b/, why: 'in-place edit' },
  { pattern: /\bgit\s+(?:commit|add|checkout|switch|apply|restore|reset|clean|rm|mv|stash|worktree|cherry-pick|rebase|merge)\b/, why: 'git write' },
  { pattern: /\bnpm\s+(?:install|ci|i)\b/, why: 'dependency install' },
  // See `REDIRECT_SOURCE`: the rule is derived from what writes a file, and each of its
  // clauses is a real observation. An arrow drawn in a description — `lead -> opportunity`
  // — used to score as the run's first mutation, which is the same class of error as the
  // substring `rm -` that fired on `crm -- app inspect`. `> /dev/null` used to score as
  // one too, which is the same error in the same direction. And `2>err.log`, a real write,
  // used to score as none at all.
  { pattern: new RegExp(REDIRECT_SOURCE), why: 'redirect into a file' },
]);

/**
 * Read the surface out of the repository.
 *
 * @param {string} repoRoot
 * @returns {{
 *   commands: string[],
 *   tokens: string[],
 *   scripts: string[],
 *   mcpTools: string[],
 *   binaries: string[],
 *   families: string[],
 * }}
 */
export function readAccordoSurface(repoRoot) {
  const commandsSource = readFileSync(join(repoRoot, 'packages/cli/src/commands.js'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const mcpSource = readFileSync(join(repoRoot, 'packages/mcp/src/tools.js'), 'utf8');

  // The CLI's own usage block. `accordo <verb>` or `accordo <namespace> <verb>`; the
  // colon spellings (`db:migrate`, `package:scaffold`) are the canonical ones in the
  // help text and the spaced ones are documented aliases, so both are folded to one.
  /** @type {Set<string>} */
  const commands = new Set();
  for (const match of commandsSource.matchAll(/^\s*accordo\s+([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*|\s+[a-z][a-z0-9-]*)?)/gm)) {
    commands.add(match[1].replace(/:/g, ' ').trim());
  }
  if (commands.size === 0) {
    throw new Error(
      'readAccordoSurface: no commands were found in packages/cli/src/commands.js. The lexicon '
      + 'this benchmark scans prompts against would be empty, which would pass every prompt. '
      + 'Refusing rather than scanning against nothing.',
    );
  }

  const scripts = Object.keys(packageJson.scripts ?? {}).sort();
  const mcpTools = [...mcpSource.matchAll(/name:\s*'([a-z_]+)'/g)].map((match) => match[1]).sort();

  /** @type {Set<string>} */
  const tokens = new Set();
  for (const command of commands) for (const token of command.split(/\s+/)) tokens.add(token);
  // The rail vocabulary is part of the surface too: "characterization" names the LA0
  // workflow as surely as `project doctor` names DX1.
  for (const extra of ['characterize', 'characterization', 'conformance']) tokens.add(extra);

  // The framework's own *prose*, not just its identifiers. The token ban pushed prompts
  // away from command names and straight into the vocabulary the help text uses to
  // describe them, which is a stronger hint than the banned token and invisible to a
  // scan that only knows words. TS-05 asked "does it hold up when the framework actually
  // loads it" against help text reading "does it hold up when a real application
  // composes it?" — five words verbatim, every one of them ordinary English.
  const helpMatch = commandsSource.match(/function helpText\(\)[\s\S]*?\n}/);
  const cliHelp = helpMatch ? helpMatch[0] : '';
  /** @type {string[]} */
  const skillDescriptions = [];
  const skillsDir = join(repoRoot, '.claude/skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir).sort()) {
      const skill = join(skillsDir, entry, 'SKILL.md');
      if (!existsSync(skill)) continue;
      const description = readFileSync(skill, 'utf8').match(/^description:\s*(.+)$/m);
      if (description) skillDescriptions.push(description[1]);
    }
  }
  // Kept separate as well as combined: the freeze fingerprints each corpus on its own, so
  // a PR that edits `helpText()` and a PR that edits a Skill description are each
  // detectable as having moved the surface the prompts were checked against.
  const prose = [cliHelp, ...skillDescriptions].filter(Boolean);
  if (prose.length === 0) {
    throw new Error(
      'readAccordoSurface: no help text and no Skill descriptions were found. The n-gram '
      + 'overlap scan would compare prompts against nothing and pass every one of them.',
    );
  }

  return {
    commands: [...commands].sort(),
    tokens: [...tokens].sort(),
    scripts,
    mcpTools,
    prose,
    cliHelp,
    skillDescriptions,
    binaries: ['accordo', 'crm', 'npx', 'npm'],
    families: Object.keys(FAMILY_RAILS).sort(),
    milestoneIdentifiers: readMilestoneIdentifiers(repoRoot),
    // The sources that decide whether a command writes. `MUTATING_FAMILIES` cites these
    // branches by name as its source of truth, and the freeze covered none of them: the
    // help-text corpus is the `helpText()` block alone, which contains neither `parseArgs`
    // nor `packageScaffoldCommand`. A change to `writing = apply && !dryRun` would have
    // moved what a mutation *is* without staling the protocol it was measured under.
    writeSemanticsSources: WRITE_SEMANTICS_SOURCES.map((relativePath) => ({
      path: relativePath,
      digest: createHash('sha256').update(readFileSync(join(repoRoot, relativePath), 'utf8')).digest('hex'),
    })),
  };
}

/** The CLI source that decides what writes. Hashed whole, and named here so a reader can check the list. */
export const WRITE_SEMANTICS_SOURCES = Object.freeze([
  'packages/cli/src/commands.js',
  'packages/cli/src/package-scaffold.js',
]);

/**
 * The milestone identifiers this repository uses for its own work — `AX1`, `DX10`, `LA0`
 * — read out of `docs/` rather than typed into the benchmark.
 *
 * A prompt carrying one names the *feature* the agent is supposed to discover, which is a
 * stronger hint than a command name. The list used to be twelve identifiers typed into
 * `prompt-matrix.js`; by the time anyone counted, the repository had twenty-five, and
 * thirteen of them passed the scan clean. That is the failure mode this module exists to
 * avoid, reappearing one list over — and it fails in the direction that makes the
 * benchmark look better, which is the direction nobody notices.
 *
 * `MK` identifiers are deliberately excluded: they name business scenarios in
 * `docs/benchmarks/CRM_BUILD_BENCHMARK.md`, not framework work, so an `MK` in a prompt
 * points at no rail and no command.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function readMilestoneIdentifiers(repoRoot) {
  /** @type {Set<string>} */
  const found = new Set();
  const docs = join(repoRoot, 'docs');
  if (!existsSync(docs)) {
    throw new Error(
      'readMilestoneIdentifiers: no docs/ directory, so the milestone-identifier ban list would be '
      + 'empty and every prompt naming a milestone would pass. Refusing rather than scanning nothing.',
    );
  }
  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.md')) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(/\b(?:AX|DX|LA)\d{1,2}\b/g)) found.add(match[0]);
    }
  };
  walk(docs);
  if (found.size === 0) {
    throw new Error('readMilestoneIdentifiers: docs/ named no milestone at all, which cannot be true of this repository.');
  }
  return [...found].sort();
}

/**
 * Word n-grams of a text, normalised so that punctuation and casing cannot hide a quote.
 * @param {string} text @param {number} size
 */
export function ngrams(text, size) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const out = new Set();
  for (let index = 0; index + size <= words.length; index += 1) out.add(words.slice(index, index + size).join(' '));
  return out;
}

/**
 * Phrases a prompt shares with the framework's own prose. A prompt is meant to describe a
 * job in the user's words; borrowing the framework's sentence about a command is a hint
 * that no token ban can see.
 * @param {string} promptText @param {{ prose: string[] }} surface @param {number} [size]
 */
export function proseOverlap(promptText, surface, size = PROSE_NGRAM) {
  const promptGrams = ngrams(promptText, size);
  const shared = new Set();
  for (const passage of surface.prose ?? []) {
    for (const gram of ngrams(passage, size)) if (promptGrams.has(gram)) shared.add(gram);
  }
  return [...shared].sort();
}

/**
 * Classify one observed shell action against the surface.
 *
 * Returns the family it names (or `null`), the rail that family belongs to, and
 * whether the action changes the caller's source. A command this framework does not
 * publish is `family: null` with `foreign: true` — which is not automatically a
 * failure, because `ls`, `cat` and `git status` are perfectly reasonable first moves.
 * It is counted, not judged, and `irrelevantCommandsUsed` is what judges it.
 *
 * @param {string} raw the command line as observed
 * @param {{ commands: string[] }} surface
 */
/**
 * Tools that run a command line. Everything else — `Read`, `Grep`, `Glob`, `WebFetch` —
 * captures text *about* code, and for `Grep` the captured text is literally the pattern
 * the agent was searching for.
 */
const EXECUTING_TOOLS = new Set(['bash', 'shell', 'run_command', 'execute']);

/**
 * The programs that can actually start this framework.
 *
 * **An allowlist of runners, not a denylist of readers.** The previous version asked
 * whether the segment's program was one of twenty-four reading programs and treated
 * everything else as an invocation. That is wrong in the only direction this instrument
 * may not err in: `git grep`, `jq`, `cut`, `sort`, `uniq`, `tr` and `paste` were all
 * absent from the list, so a segment that searched for a command name *invented* an
 * Accordo action — the one field the contract says must never be guessed at. Enumerating
 * every program that reads is not a finite task; enumerating the ones that can launch
 * this CLI is, because they are the ones this repository documents.
 *
 * An unknown program therefore means "no action", never "some action".
 */
export const CLI_RUNNERS = Object.freeze([
  // The published binaries.
  'accordo', 'crm',
  // Package runners, because the documented invocation is `npm run crm -- <command>`.
  'npm', 'npx', 'pnpm', 'yarn', 'node', 'deno', 'bun', 'make',
]);
const CLI_RUNNER_SET = new Set(CLI_RUNNERS);

/** Something that can actually start a characterization suite. */
const RUNNER = new RegExp(`(^|[\\s;&|/])(${CLI_RUNNERS.filter((name) => name !== 'accordo' && name !== 'crm').join('|')})([\\s]|$)`);

export function classifyAction(raw, surface, options = {}) {
  const text = String(raw ?? '');
  // Defaults to Bash so a bare shell line classifies as one. `score.js` passes the tool
  // it actually observed, which is the only way to tell running from reading.
  const tool = String(options.tool ?? 'Bash').toLowerCase();
  const executes = EXECUTING_TOOLS.has(tool);

  // One pass over the shell grammar, rather than a sequence of regexes over spellings.
  // `lexShell` returns the code with heredoc bodies removed and the command segments with
  // quoted spans blanked, decided together — see its docstring for why they cannot be
  // decided apart.
  const lexed = lexShell(text);
  // Code handed to a shell as an argument is code. Followed to a bounded depth, because a
  // command line can nest shells and this is a classifier rather than an interpreter.
  /** @type {string[]} */
  const nested = [];
  /** @type {Array<{ text: string, raw: string }>} */
  const segments = [];
  const follow = (lex, depth) => {
    for (const segment of lex.segments) {
      segments.push(segment);
      if (depth >= 3) continue;
      const handed = handedShellCode(segment.raw);
      if (handed === null || handed.trim() === '') continue;
      nested.push(handed);
      follow(lexShell(handed), depth + 1);
    }
  };
  follow(lexed, 0);
  // The mutation witness reads the handed-off code too: `bash -c "rm -rf src"` writes
  // exactly as much as `rm -rf src` does.
  const shellText = [lexed.code, ...nested].join('\n');

  /** @type {string | null} */
  let family = null;
  /**
   * The remainder of the segment the family was found in — the only text the command
   * could actually have read as flags. Scanning the whole observed line instead is what
   * let `--apply` in a *later* segment, or inside a quoted argument, decide whether the
   * run mutated.
   * @type {string}
   */
  let tail = '';
  // Three gates, and each one exists because its absence manufactured a `met`:
  //
  // 1. the tool must execute. For `Grep` and `Glob` the captured text *is* the search
  //    pattern, so without this a search for the answer scores as reaching it — the
  //    self-report shape §2.1 refuses, reappearing inside the observation arm;
  // 2. the segment's program must be one that can start this framework. `grep`, `cat`,
  //    `ls`, `git grep`, `jq` and `cut` take command names as arguments all day, and the
  //    set of programs that read is not enumerable while the set that can launch this CLI
  //    is. The program is `segmentProgram`'s, so a wrapper prefix no longer defeats it;
  // 3. the CLI must actually be invoked. Without it single-token commands turn ordinary
  //    shell into false positives — `ls examples/demo` would become the run's first
  //    Accordo action, the one field in the whole instrument that must not be guessed at.
  if (executes) {
    for (const segment of segments) {
      // The colon spellings (`package:scaffold`) are folded to the spaced ones, and runs of
      // whitespace to one space, so one command has one shape here.
      const trimmed = segment.text.replace(/:/g, ' ').replace(/\s+/g, ' ').trim();
      if (trimmed === '') continue;
      // Matching is case-insensitive because a shell is; the *tail* is sliced out of the
      // original casing, because `parseArgs` in the CLI is not. `--APPLY` is not `--apply`
      // to the command, and a classifier that lower-cased before parsing flags reported a
      // write for an invocation that wrote nothing.
      const lower = trimmed.toLowerCase();
      // Lower-casing is length-preserving for every character this repository's command
      // names contain, but not for every character in Unicode. When it is not, offsets into
      // one string do not address the other, so the tail is taken from the lower-cased text
      // and the flag comparison degrades to the old behaviour rather than slicing at random.
      const sliceable = lower.length === trimmed.length ? trimmed : lower;
      // The masked text is what decides the program, for the same reason it decides the
      // family: the contents of a quoted span are an argument, never command position.
      // The program comes from the **raw** segment, not from the masked or colon-folded
      // one. Quoting a program name does not change which program runs — `"npm" run crm`
      // is npm — and the colon fold that turns `package:scaffold` into `package scaffold`
      // splits an inline `PATH=/x:$PATH` into two words, which read as a program named
      // `$PATH`. The masked text decides the *family*, because a quoted span is an
      // argument; it never decides the program.
      const { program } = segmentProgram(splitShellWords(segment.raw));
      if (!CLI_RUNNER_SET.has(program)) continue;

      // The `.js` spellings too: `package.json` publishes `accordo` as
      // `./packages/cli/bin/accordo.js`, and an agent that runs the entry point directly
      // has invoked the CLI as surely as one that types the bin name.
      if (/(^|[\s;&|/])(accordo|crm)(\.[cm]?js)?([\s:]|$)/.test(lower)) {
        // Longest match wins, so `solution verify` is never read as `solution`.
        for (const command of [...surface.commands].sort((a, b) => b.length - a.length)) {
          const at = lower.indexOf(command);
          if (at >= 0) { family = command; tail = sliceable.slice(at + command.length); break; }
        }
        if (family !== null) break;
      }
      // The PRESERVE rail is a checked-in workflow rather than one CLI command, so it is
      // recognised on its own terms — but it still has to be *run*. `tests/characterization/`
      // exists in every fixture, so a bare substring match scored `ls` on that directory as
      // three met metrics on TS-09: the hardest rail to reach was the easiest to fake.
      if (RUNNER.test(lower) && /characteriz/.test(lower)) {
        family = 'characterization';
        break;
      }
    }
  }

  const rail = family !== null && family in FAMILY_RAILS
    ? /** @type {string} */ (FAMILY_RAILS[/** @type {keyof typeof FAMILY_RAILS} */ (family)])
    : null;

  const writeRule = family !== null && family in MUTATING_FAMILIES
    ? MUTATING_FAMILIES[/** @type {keyof typeof MUTATING_FAMILIES} */ (family)]
    : null;
  const parsedTail = parseCommandTail(tail);
  const mutatingByFlag = writeRule !== null && writeRule.writesWhen(parsedTail.flags, parsedTail.positional);
  // A shell mutation needs a shell. A `Grep` for `rm -rf` is a question about the
  // repository, and reading it as a write is the same defect as reading it as a command.
  const mutatingByShell = executes && MUTATING_SHELL.some((rule) => rule.pattern.test(shellText));

  return {
    raw: text,
    family,
    rail,
    foreign: family === null,
    mutating: mutatingByFlag || mutatingByShell,
    dryRunAvailable: writeRule !== null,
    dryRun: writeRule !== null && !mutatingByFlag,
  };
}

/**
 * Split a segment into shell words, each with the quotes removed and a note of whether it
 * carried any. This is the same word grammar `readShellWord` implements for a heredoc
 * delimiter, applied to a whole command — because the two are the same grammar.
 * @param {string} text
 */
function splitShellWords(text) {
  const source = String(text ?? '');
  /** @type {Array<{ word: string, quoted: boolean }>} */
  const words = [];
  let index = 0;
  while (index < source.length) {
    while (index < source.length && (source[index] === ' ' || source[index] === '\t' || source[index] === '\n')) index += 1;
    if (index >= source.length) break;
    const { word, quoted, end } = readShellWord(source, index);
    if (end === index) { index += 1; continue; }
    words.push({ word, quoted });
    index = end;
  }
  return words;
}

/**
 * Shells that take a command line as an argument. `eval` is in the same set for the same
 * reason: what follows it is code, and the quoting is how it is *carried* rather than
 * what it is.
 */
const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'mksh']);

/**
 * Programs that run another program. They change nothing about what the other one does,
 * so the program of `timeout 60 npm run crm -- app inspect` is `npm`.
 *
 * Each entry carries the wrapper's own grammar, because "skip the wrapper" is not a
 * decision until you know how far it reaches. `valueFlags` are the short options that
 * take a *separate* value — `sudo -u someone`, `nice -n 5` — and `operands` is how many
 * bare words the wrapper takes for itself before the command starts, which is one for
 * `timeout` (its duration) and zero for everything else. Both were previously guessed at
 * by shape (`starts with -`, or `looks like a duration`), which read `sudo -u someone cmd`
 * as running `someone` and was declared a bound rather than fixed.
 *
 * This is a list, and lists are what round four condemned — but it is a list of *shell
 * grammar for a bounded set of wrappers*, not a list of program spellings standing in for
 * a decision. Whether a program execs its own argv is not derivable from the text of a
 * command line, and a program absent from here is simply treated as the command, which is
 * the safe direction.
 *
 * `external` says whether the wrapper reaches its target through `execve`. It matters
 * because `eval` is a shell builtin with no file behind it: `sudo -u x eval "…"` and
 * `xargs eval "…"` run nothing at all, so following the code they appear to hand over
 * would invent an action out of a command that failed to start.
 */
const SHELL_WRAPPERS = new Map([
  ['env', { valueFlags: new Set(['u', 'C']), operands: 0, external: true }],
  ['sudo', { valueFlags: new Set(['u', 'g', 'p', 'C', 'h', 'r', 't', 'U', 'D', 'R']), operands: 0, external: true }],
  ['doas', { valueFlags: new Set(['u', 'C', 'a']), operands: 0, external: true }],
  ['command', { valueFlags: new Set(), operands: 0, external: false }],
  ['builtin', { valueFlags: new Set(), operands: 0, external: false }],
  ['exec', { valueFlags: new Set(['a']), operands: 0, external: true }],
  ['time', { valueFlags: new Set(['o', 'f']), operands: 0, external: false }],
  ['timeout', { valueFlags: new Set(['k', 's']), operands: 1, external: true }],
  ['nohup', { valueFlags: new Set(), operands: 0, external: true }],
  ['nice', { valueFlags: new Set(['n']), operands: 0, external: true }],
  ['ionice', { valueFlags: new Set(['c', 'n', 'p', 't']), operands: 0, external: true }],
  ['setsid', { valueFlags: new Set(), operands: 0, external: true }],
  ['stdbuf', { valueFlags: new Set(['i', 'o', 'e']), operands: 0, external: true }],
  ['xargs', { valueFlags: new Set(['n', 'L', 'I', 'i', 'a', 'd', 'E', 'e', 'P', 's']), operands: 0, external: true }],
]);

/**
 * Shell reserved words that can stand in front of a command inside one segment. The
 * segment splitter breaks at `;`, `&`, `|` and newlines, so `if true; then npm run crm --
 * app inspect; fi` hands the classifier a segment whose first word is `then`. These are
 * the shell's own keywords rather than a taste-based list, and skipping one never skips a
 * program: no keyword is a command.
 */
const SHELL_KEYWORDS = new Set(['!', '{', '}', 'if', 'elif', 'then', 'else', 'while', 'until', 'do', 'coproc']);

/**
 * The program a segment runs, and where its arguments start — **one definition**, used
 * both by the reader gate in `classifyAction` and by the shell-code follower below. The
 * two used to disagree: the gate took `lower.split(' ')[0]`, so any wrapper defeated it
 * (`time echo npm run crm -- app inspect` reported that the discovery command had run,
 * when `echo` had printed it), while the follower forty lines down already skipped
 * wrappers correctly. Two answers to "what is the program of this segment" is one answer
 * too many.
 *
 * @param {Array<{ word: string, quoted: boolean }>} words
 * @returns {{ program: string, start: number, wrappers: string[] }}
 */
function segmentProgram(words) {
  let start = 0;
  /** @type {string[]} */
  const wrappers = [];
  while (start < words.length) {
    const token = words[start].word;
    const name = token.replace(/^.*\//, '').toLowerCase();
    // A leading assignment is part of the invocation's environment, not its program.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { start += 1; continue; }
    if (SHELL_KEYWORDS.has(name)) { start += 1; continue; }
    const wrapper = SHELL_WRAPPERS.get(name);
    if (wrapper === undefined) break;
    wrappers.push(name);
    start += 1;
    // The wrapper's own options, then its own bare operands. `--` ends the options.
    let operands = wrapper.operands;
    while (start < words.length) {
      const token2 = words[start].word;
      if (token2 === '--') { start += 1; break; }
      // A long option consumes only itself. `timeout --preserve-status npm …` takes no
      // value, and consuming the next word would eat the command; the cost is that
      // `sudo --user someone npm …` stops at `someone` and reports no action, which is a
      // miss rather than an invention. That is the only direction this may err in.
      if (/^--/.test(token2)) { start += 1; continue; }
      if (/^-./.test(token2)) {
        start += 1;
        const last = token2.slice(-1);
        if (wrapper.valueFlags.has(last) && start < words.length) start += 1;
        continue;
      }
      if (operands > 0) { operands -= 1; start += 1; continue; }
      break;
    }
  }
  // The extension is dropped, because `./packages/cli/bin/accordo.js app inspect` runs the
  // binary `package.json` publishes as `accordo` and a gate that did not know that would
  // read a real invocation as none.
  const program = (words[start]?.word ?? '')
    .replace(/^.*\//, '')
    .replace(/\.(?:js|mjs|cjs)$/i, '')
    .toLowerCase();
  return { program, start, wrappers };
}

/**
 * The command line a segment hands to a shell, or `null` if it hands none.
 *
 * `bash -c "npm run crm -- app inspect"` runs the discovery command; so does
 * `eval "npm run crm -- app inspect"`. Both were read as an argument and lost, which is
 * the same defect as the phantom heredoc and in the same direction — a real action
 * disappears, on the field the contract says must never be guessed at.
 *
 * Nothing here evaluates anything: the text is taken literally, with quote removal, which
 * is all a shell does to it before parsing. A variable is still not expanded, so
 * `eval "$CMD"` names nothing and is reported as naming nothing.
 *
 * The wrapper grammar is `segmentProgram`'s, shared with the reader gate above, so the
 * two can no longer disagree about where a wrapper ends and the command begins.
 *
 * @param {string} rawSegment
 * @returns {string | null}
 */
function handedShellCode(rawSegment) {
  const words = splitShellWords(rawSegment);
  // Wrappers first. `timeout 60 bash -c "…"` runs the command line as surely as
  // `bash -c "…"` does, and the mutation patterns already absorb the same wrappers for
  // the same reason: the segment a write lives in often starts with `xargs`.
  const { program, start, wrappers } = segmentProgram(words);
  const remaining = words.slice(start);
  if (remaining.length < 2) return null;
  // A wrapper that reaches its target through `execve` cannot reach a shell builtin.
  // `sudo -u x eval "…"` and `xargs eval "…"` exit without running anything, and reading
  // the string they were given as code would invent an action from a failed exec.
  const execed = wrappers.some((name) => SHELL_WRAPPERS.get(name)?.external === true);
  // `eval` concatenates its operands with a space and parses the result as a command.
  if (program === 'eval') return execed ? null : remaining.slice(1).map((entry) => entry.word).join(' ');
  // `trap` is the same rule with a different spelling: its first operand is a command
  // string the shell parses and runs when the signal arrives, and bash confirms it runs.
  // Reading it as an argument lost every command an agent put in a cleanup handler.
  // `trap - EXIT` and `trap '' EXIT` reset and ignore; both hand over no code.
  if (program === 'trap') {
    const operand = remaining.slice(1).find((entry) => entry.quoted || !entry.word.startsWith('-'));
    const code = operand?.word ?? '';
    return code === '' || code === '-' ? null : code;
  }
  if (!SHELL_BINARIES.has(program)) return null;
  for (let index = 1; index < remaining.length; index += 1) {
    const token = remaining[index].word;
    // `-c`, and the combined short-option spellings a shell accepts for it.
    if (/^-[a-z]*c$/i.test(token)) return remaining[index + 1]?.word ?? null;
    if (token === '--') break;
  }
  // `bash <<<"npm run crm -- app inspect"` feeds the shell a here-string, and a shell
  // reading its standard input executes what it finds there. Same inversion as `-c`.
  // Not under `xargs`, which reads that standard input itself and hands the shell the
  // words it found as arguments — the shell then never sees a script at all.
  const hereString = wrappers.includes('xargs') ? -1 : rawSegment.indexOf('<<<');
  if (hereString !== -1) {
    let cursor = hereString + 3;
    while (rawSegment[cursor] === ' ' || rawSegment[cursor] === '\t') cursor += 1;
    const { word } = readShellWord(rawSegment, cursor);
    if (word !== '') return word;
  }
  return null;
}

/** Unquoted characters that end a shell word. */
const WORD_TERMINATORS = new Set([' ', '\t', '\n', ';', '&', '|', '<', '>', '(', ')']);

/**
 * Read one shell **word**, applying quote removal, and say where it ends.
 *
 * This is the grammar a heredoc delimiter obeys, and writing it out is the point. The
 * delimiter after `<<` is not an identifier: it is any word, and quoting *any part of it*
 * — including a single leading backslash — makes the body literal without changing where
 * the body ends. `<<\EOF`, `<<'E-OF'`, `<<EOF.txt`, `<<1EOF` and `<<"EOF"` all terminate
 * at a line reading `EOF`, `E-OF`, `EOF.txt`, `1EOF` and `EOF` respectively, and a
 * recogniser written to a list of spellings misses whichever spelling it was not shown.
 *
 * @param {string} source @param {number} start
 * @returns {{ word: string, quoted: boolean, end: number }}
 */
function readShellWord(source, start) {
  let index = start;
  let word = '';
  let quoted = false;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\' && index + 1 < source.length) { word += source[index + 1]; quoted = true; index += 2; continue; }
    if (char === "'") {
      quoted = true;
      const close = source.indexOf("'", index + 1);
      if (close === -1) { word += source.slice(index + 1); index = source.length; break; }
      word += source.slice(index + 1, close);
      index = close + 1;
      continue;
    }
    if (char === '"') {
      quoted = true;
      index += 1;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\' && index + 1 < source.length) { word += source[index + 1]; index += 2; continue; }
        word += source[index];
        index += 1;
      }
      index += 1;
      continue;
    }
    if (WORD_TERMINATORS.has(char)) break;
    word += char;
    index += 1;
  }
  return { word, quoted, end: index };
}

/**
 * Skip one heredoc body, from the start of the line after the opening line.
 *
 * The terminator is the line that **is** the delimiter — exactly, which is what bash
 * requires; only `<<-` strips leading tabs, and only tabs. A body that is never terminated
 * swallows the rest of the text, which is also what the shell does with it.
 *
 * @param {string} source @param {number} start @param {{ delimiter: string, dashed: boolean }} doc
 * @param {Array<{ delimiter: string, dashed: boolean, terminated: boolean }>} record
 */
function skipHeredocBody(source, start, doc, record) {
  let index = start;
  while (index < source.length) {
    let end = source.indexOf('\n', index);
    const atEnd = end === -1;
    if (atEnd) end = source.length;
    let line = source.slice(index, end);
    if (line.endsWith('\r')) line = line.slice(0, -1);
    index = atEnd ? end : end + 1;
    if ((doc.dashed ? line.replace(/^\t+/, '') : line) === doc.delimiter) {
      record.push({ ...doc, terminated: true });
      return index;
    }
  }
  record.push({ ...doc, terminated: false });
  return index;
}

/**
 * Lex a shell line the way a shell reads it, and return the two views the classifier needs.
 *
 * ## Why one pass, and why the two views come out together
 *
 * Three earlier versions of this decided heredocs with one regex and quoting with another,
 * in that order, and each was correct for the examples it was written to and silent one
 * step outside them. The order alone is a defect: strip heredoc bodies first and a `<<WORD`
 * inside `echo "… <<EOF …"` opens a phantom body that swallows the next real command;
 * strip quotes first and a heredoc body containing an apostrophe unbalances everything
 * after it. Quoting state and heredoc state are the same state, so they are read together
 * or one of them is guessed.
 *
 * Returns:
 *
 * - `code` — the text with heredoc **bodies** removed and everything else, quotes
 *   included, left verbatim. The opening line stays, because `cat <<EOF > notes.md` still
 *   redirects into a file and that is a real write this must not hide. This is what the
 *   mutation patterns read.
 * - `segments` — one entry per command, split at the unquoted separators (`;`, `&`, `|`,
 *   newline, and the boundaries of `$(…)` and backticks). Each carries `text`, with the
 *   *contents* of quoted spans blanked to spaces, and `raw`, the same span verbatim. A
 *   quoted span is an argument, never command position: `grep -rn "npm run crm -- app
 *   inspect" docs/` names the command it is looking for and does not run it. Blanking
 *   rather than deleting keeps offsets stable. `raw` exists for the one case where the
 *   rule inverts — `eval` and `sh -c` are handed a command *line*, and treating it as an
 *   argument loses a real invocation exactly the way a phantom heredoc did.
 * - `heredocs` — what was found, for a test or a reader to inspect.
 *
 * Nothing here expands anything. Expansion cannot change which *program* a segment names
 * without also being able to change it into any program at all, and a classifier that
 * guessed at `$CMD` would be inventing observations rather than reading them.
 *
 * @param {string} text
 * @returns {{ code: string, segments: Array<{ text: string, raw: string }>, heredocs: Array<{ delimiter: string, dashed: boolean, terminated: boolean }> }}
 */
export function lexShell(text) {
  const source = String(text ?? '');
  /** @type {string[]} */
  const code = [];
  /** @type {string[]} */
  const segments = [];
  /** @type {Array<{ delimiter: string, dashed: boolean, terminated: boolean }>} */
  const heredocs = [];
  /** Heredocs opened on the current line, waiting for the newline that starts their bodies. */
  /** @type {Array<{ delimiter: string, dashed: boolean }>} */
  let pending = [];
  /** @type {Array<'code' | 'squote' | 'dquote' | 'ansi' | 'cmdsub' | 'backtick'>} */
  const stack = ['code'];

  let segment = '';
  let raw = '';
  let index = 0;

  const top = () => stack[stack.length - 1];
  const inQuote = () => top() === 'squote' || top() === 'dquote' || top() === 'ansi';
  /** Verbatim into both views. */
  const keep = (chars) => { code.push(chars); segment += chars; raw += chars; };
  /** Verbatim into `code` and into the raw segment, blanked in the masked one. */
  const mask = (chars) => { code.push(chars); segment += chars.replace(/[^\n]/g, ' '); raw += chars; };
  /**
   * Blanked in **both** views, verbatim only in `raw`. Arithmetic is neither a command nor
   * a write: `$(( 1 << 3 ))` names no program and creates no file, and a `>` inside it is
   * a comparison rather than a redirect.
   */
  const drop = (chars) => {
    const blank = chars.replace(/[^\n]/g, ' ');
    code.push(blank);
    segment += blank;
    raw += chars;
  };
  /**
   * The end of a parenthesised span starting at `from`, or -1 if it never closes. Used for
   * arithmetic, which is delimited by balanced parentheses rather than by a token.
   */
  const balancedEnd = (from) => {
    let depth = 0;
    let cursor = from;
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === '\\') { cursor += 2; continue; }
      if (char === '(') depth += 1;
      else if (char === ')') { depth -= 1; if (depth === 0) return cursor + 1; }
      cursor += 1;
    }
    return -1;
  };
  const breakSegment = () => {
    if (segment.trim() !== '') segments.push({ text: segment, raw });
    segment = '';
    raw = '';
  };
  /** Whether a `#` here starts a comment: only at the start of a word. */
  const atWordStart = () => segment === '' || /\s$/.test(segment);

  while (index < source.length) {
    const char = source[index];
    const context = top();

    // A heredoc body begins at the newline that ends the line the operator appeared on —
    // never inside a quoted span, because there the line has not ended yet.
    if (char === '\n' && pending.length > 0 && !inQuote()) {
      keep('\n');
      breakSegment();
      index += 1;
      for (const doc of pending) index = skipHeredocBody(source, index, doc, heredocs);
      pending = [];
      continue;
    }

    if (context === 'squote') {
      if (char === "'") stack.pop();
      mask(char);
      index += 1;
      continue;
    }
    if (context === 'ansi') {
      if (char === '\\' && index + 1 < source.length) { mask(source.slice(index, index + 2)); index += 2; continue; }
      if (char === "'") stack.pop();
      mask(char);
      index += 1;
      continue;
    }
    if (context === 'dquote') {
      if (char === '\\' && index + 1 < source.length) { mask(source.slice(index, index + 2)); index += 2; continue; }
      if (char === '"') { stack.pop(); mask(char); index += 1; continue; }
      // A substitution inside double quotes is code again, and the commands in it run.
      if (char === '`') { stack.push('backtick'); keep(char); breakSegment(); index += 1; continue; }
      if (char === '$' && source[index + 1] === '(' && source[index + 2] === '(') {
        const end = balancedEnd(index + 1);
        if (end !== -1) { drop(source.slice(index, end)); index = end; continue; }
      }
      if (char === '$' && source[index + 1] === '(') { stack.push('cmdsub'); keep('$('); breakSegment(); index += 2; continue; }
      mask(char);
      index += 1;
      continue;
    }

    // --- code, command substitution and backticks: the same rules -----------------
    if (char === '\\' && index + 1 < source.length) {
      // A backslash-escaped character is a literal, never an operator — including a
      // backslash-newline, which joins two lines into one command. `npm run crm -- \` then
      // `app inspect` is one invocation, and reading the second line as a command of its
      // own lost the family entirely.
      keep(source.slice(index, index + 2));
      index += 2;
      continue;
    }
    if (char === "'") { stack.push('squote'); mask(char); index += 1; continue; }
    if (char === '$' && source[index + 1] === "'") { stack.push('ansi'); mask("$'"); index += 2; continue; }
    if (char === '"') { stack.push('dquote'); mask(char); index += 1; continue; }
    // Arithmetic, before command substitution, because `$((` is arithmetic and `$(` is a
    // substitution and the first two characters do not tell them apart. Reaching the `<<`
    // branch inside `$(( 1 << 3 ))` opened a heredoc whose delimiter was `3` and swallowed
    // every following line — the phantom heredoc again, one context over. `(( x <<= 2 ))`
    // is the same expression as a command of its own.
    if (char === '$' && source[index + 1] === '(' && source[index + 2] === '(') {
      const end = balancedEnd(index + 1);
      if (end !== -1) { drop(source.slice(index, end)); index = end; continue; }
    }
    if (char === '(' && source[index + 1] === '(' && atWordStart()) {
      const end = balancedEnd(index);
      if (end !== -1) { drop(source.slice(index, end)); index = end; continue; }
    }
    if (char === '`') {
      if (context === 'backtick') stack.pop(); else stack.push('backtick');
      keep(char);
      breakSegment();
      index += 1;
      continue;
    }
    if (char === '$' && source[index + 1] === '(') { stack.push('cmdsub'); keep('$('); breakSegment(); index += 2; continue; }
    if (char === ')' && context === 'cmdsub') { stack.pop(); keep(char); breakSegment(); index += 1; continue; }
    if (char === '#' && atWordStart()) {
      // A comment is not code in either view. Leaving it in the segment made
      // `# npm run crm -- app inspect` the run's first Accordo action; leaving it in `code`
      // would let a sentence about `rm` decide that the run mutated, which is the defect
      // the mutation patterns already carry three regressions against.
      let end = source.indexOf('\n', index);
      if (end === -1) end = source.length;
      index = end;
      continue;
    }
    if (char === '<' && source[index + 1] === '<') {
      // `<<<` is a here-string: its word *is* the body, and it consumes no following line.
      // Consuming all three characters here is what stops the scan from re-reading the
      // second and third as a `<<` of their own — which turned `cat <<<"…"` into a heredoc
      // whose delimiter was the quoted string, swallowing every command after it.
      if (source[index + 2] === '<') { keep('<<<'); index += 3; continue; }
      let cursor = index + 2;
      const dashed = source[cursor] === '-';
      if (dashed) cursor += 1;
      while (source[cursor] === ' ' || source[cursor] === '\t') cursor += 1;
      const { word, quoted, end } = readShellWord(source, cursor);
      // An empty delimiter is a delimiter. `cat <<''` ends its body at the first empty
      // line, and reading the body as code was the heredoc defect with the shortest
      // possible spelling. `cat <<` followed by nothing at all opens no heredoc, which is
      // why the quoting has to be distinguished from the emptiness.
      if (word !== '' || quoted) {
        pending.push({ delimiter: word, dashed });
        keep(source.slice(index, end));
        index = end;
        continue;
      }
    }
    if (char === ';' || char === '&' || char === '|' || char === '\n' || char === '(' || char === ')') {
      keep(char);
      breakSegment();
      index += 1;
      continue;
    }
    keep(char);
    index += 1;
  }
  breakSegment();

  return { code: code.join(''), segments, heredocs };
}

/**
 * Parse the tokens after a command family the way the CLI's own `parseArgs` does:
 * `--key=value` takes the inline value, a bare `--key` followed by a non-flag takes that
 * token as its value, and only a `--key` with nothing usable after it is boolean `true`.
 *
 * The fidelity matters in both directions. `--apply grants` is `apply: 'grants'` to the
 * real parser and writes nothing; `--apply=false` is the string `'false'` and writes
 * nothing either. A classifier that treated the presence of the characters `--apply` as
 * a write would report a mutation the command never performed.
 *
 * @param {string} tail
 * @returns {{ flags: Record<string, string | true>, positional: string[] }}
 */
export function parseCommandTail(tail) {
  /** @type {Record<string, string | true>} */
  const flags = {};
  /** @type {string[]} */
  const positional = [];
  const tokens = String(tail ?? '').split(/\s+/).filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const [key, inline] = token.slice(2).split('=', 2);
    if (inline !== undefined) { flags[key] = inline; continue; }
    const next = tokens[index + 1];
    if (next && !next.startsWith('--')) { flags[key] = next; index += 1; } else flags[key] = true;
  }
  return { flags, positional };
}
