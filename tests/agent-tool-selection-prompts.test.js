// @ts-check

/**
 * The prompt matrix, and the one claim the whole instrument rests on: that no prompt
 * names a command.
 *
 * These tests are the mechanical form of that claim. Eyeballing thirteen prompts for a
 * leaked command name is exactly the check a careful person passes on the fourth read
 * and fails on the fifth, and a leak in one prompt invalidates the whole set — so the
 * scan runs in the suite, against a lexicon derived from the CLI's own help text rather
 * than from a list somebody maintained by hand.
 *
 * The negative controls matter more than the positive one. A scanner that finds nothing
 * in a clean set proves nothing at all unless it also demonstrably finds the things it
 * is looking for, so every leak code has a prompt written to trip it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readAccordoSurface, CLI_RUNNERS, FAMILY_RAILS, RAILS, classifyAction, MUTATING_SHELL, proseOverlap } from '../benchmarks/tool-selection/surface.js';
import {
  loadPromptMatrix, scanPromptForSurfaceLeak, stripPathLiterals, validatePromptMatrix,
  derivePromptSetId, PROMPT_SET_CONTRACT, PROMPT_TOKEN_EXEMPTIONS,
} from '../benchmarks/tool-selection/prompt-matrix.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the surface is derived from the CLI rather than typed into the benchmark', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // Every rail family the benchmark grades against must be a command the CLI publishes,
  // or the benchmark is grading against something that does not exist. `characterization`
  // is the declared exception: LA0 is a checked-in workflow, not a single command.
  for (const family of Object.keys(FAMILY_RAILS)) {
    if (family === 'characterization') continue;
    assert.ok(surface.commands.includes(family), `${family} is graded but the CLI does not publish it`);
  }
  assert.ok(surface.commands.includes('app inspect'));
  assert.ok(surface.commands.includes('solution verify'));
  assert.ok(surface.tokens.includes('doctor'));
  assert.ok(surface.scripts.includes('verify'));
});

test('the checked-in matrix is valid, and covers every rail', () => {
  const matrix = loadPromptMatrix(REPO_ROOT);
  assert.equal(matrix.problems.length, 0, JSON.stringify(matrix.problems, null, 2));
  assert.ok(matrix.valid);
  assert.ok(matrix.prompts.length >= 12, 'the protocol requires at least twelve prompts');

  const railsCovered = new Set(matrix.prompts.map((prompt) => prompt.expectedRail));
  for (const rail of RAILS) {
    assert.ok(railsCovered.has(rail), `no prompt exercises the ${rail} rail`);
  }
});

test('every prompt covers a distinct job, and every job the protocol names is present', () => {
  const matrix = loadPromptMatrix(REPO_ROOT);
  const jobs = matrix.prompts.map((prompt) => prompt.job);
  assert.equal(new Set(jobs).size, jobs.length, 'two prompts claim the same job');

  for (const required of [
    'inspect before changing',
    'stale plan validation',
    'unfamiliar-project diagnosis',
    'safest custom-package starting point',
    'package conformance',
    'technical project proof',
    'business scenario proof',
    'requirement-level SolutionPlan proof',
    'preservation before refactor',
    'read-only, no mutation',
    'ambiguous goal requiring discovery first',
    'destructive / source-writing request requiring dry-run or approval',
  ]) {
    assert.ok(jobs.includes(required), `the matrix does not cover "${required}"`);
  }
});

test('no prompt names a command, a flag, a script, a tool or a rail', () => {
  const matrix = loadPromptMatrix(REPO_ROOT);
  const surface = readAccordoSurface(REPO_ROOT);
  for (const prompt of matrix.prompts) {
    const leaks = scanPromptForSurfaceLeak(prompt.prompt, surface);
    assert.deepEqual(leaks, [], `${prompt.id} leaks: ${JSON.stringify(leaks)}`);
  }
});

test('every prompt states an expected rail, a justification and a wrong-rail attractor', () => {
  const matrix = loadPromptMatrix(REPO_ROOT);
  for (const prompt of matrix.prompts) {
    assert.ok(prompt.justification.length > 80, `${prompt.id}: the justification is too thin to review`);
    assert.ok(prompt.wrongRailAttractor.length > 20, `${prompt.id}: no wrong-rail attractor is named`);
    // A declared first family must sit on the expected rail or on a declared alternative.
    for (const family of prompt.expectedFirstFamilies) {
      const rail = FAMILY_RAILS[family];
      assert.ok(
        rail === prompt.expectedRail || (prompt.railAlternatives ?? []).includes(rail),
        `${prompt.id}: ${family} is on ${rail}, which the prompt neither expects nor declares`,
      );
    }
  }
});

test('the scanner catches every kind of leak it claims to catch', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  /** @type {Array<[string, string]>} */
  const controls = [
    ['PROMPT_NAMES_COMMAND', 'Please run app inspect on this and tell me what you find.'],
    ['PROMPT_NAMES_COMMAND', 'Please use project:doctor here.'],
    ['PROMPT_NAMES_COMMAND_TOKEN', 'Tell me whether the scaffold is right.'],
    ['PROMPT_NAMES_COMMAND_TOKEN', 'The doctors disagree about this repository.'],
    ['PROMPT_NAMES_BINARY', 'Use accordo for this, please.'],
    ['PROMPT_NAMES_SCRIPT', 'Make sure gtm:check is happy before you finish.'],
    ['PROMPT_NAMES_TOOL', 'Call crm_doctor and report back.'],
    ['PROMPT_NAMES_FLAG', 'Give me the answer with --json please.'],
    ['PROMPT_NAMES_RAIL', 'Start at the SEE stage of the story.'],
    ['PROMPT_NAMES_RAIL', 'This is a DX1 question.'],
  ];
  for (const [code, text] of controls) {
    const leaks = scanPromptForSurfaceLeak(text, surface);
    assert.ok(leaks.some((leak) => leak.code === code), `"${text}" should have produced ${code}, got ${JSON.stringify(leaks)}`);
  }
});

test('a flag is a flag whatever punctuation it is wearing', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // The scan anchored on whitespace, so every flag written as an aside walked through it —
  // and parentheses and quotes are exactly what a person reaches for when naming a flag
  // inside a sentence. A short flag names the surface as surely as a long one.
  for (const text of [
    'Use the (--apply) flag when you are ready.',
    'Use the "--apply" flag when you are ready.',
    "Use the '--dry-run' switch first.",
    'See [--json] output.',
    'Try --apply, then stop.',
    'Pass -h for help.',
    'Everything after --apply/--dry-run is the interesting part.',
  ]) {
    assert.ok(
      scanPromptForSurfaceLeak(text, surface).some((leak) => leak.code === 'PROMPT_NAMES_FLAG'),
      `"${text}" carries a flag and walked through the scan`,
    );
  }
  // And an ordinary hyphenated word is not a flag, in either direction.
  for (const text of [
    'a well-known set-up for a mid-market team',
    'the lead-to-won journey',
    'a first-class, end-to-end account of it',
  ]) {
    assert.deepEqual(
      scanPromptForSurfaceLeak(text, surface).filter((leak) => leak.code === 'PROMPT_NAMES_FLAG'), [],
      `"${text}" contains no flag and the scan invented one`,
    );
  }
});

test('the plural fold means a leak cannot hide behind an "s"', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  for (const text of ['it inspects the tree', 'run the doctors', 'these modules', 'the scaffolds']) {
    assert.ok(scanPromptForSurfaceLeak(text, surface).length > 0, `"${text}" walked through the scan`);
  }
});

test('a backticked path is a location, but a backticked command is still a command', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  assert.deepEqual(scanPromptForSurfaceLeak('It lives under `packages/insurance-claims/`.', surface), []);
  const hidden = scanPromptForSurfaceLeak('Just do `accordo app inspect` for me.', surface);
  assert.ok(hidden.some((leak) => leak.code === 'PROMPT_NAMES_COMMAND'), 'backticks must not launder a command');
  // The stripper only removes things that are unambiguously paths.
  assert.equal(stripPathLiterals('see `docs/a/b.md`').includes('docs'), false);
  assert.equal(stripPathLiterals('see `inspect`').includes('inspect'), true);
});

test('the token exemption list is empty, so nothing is quietly excused', () => {
  // Not a style rule. An exemption is how an over-inclusive scan becomes a scan people
  // route around, so adding one has to be a reviewable edit with an argument attached.
  assert.deepEqual([...PROMPT_TOKEN_EXEMPTIONS], []);
});

test('a matrix with a leaked prompt is refused rather than scored', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  const result = validatePromptMatrix({
    toolSelectionPromptSet: PROMPT_SET_CONTRACT,
    setId: 'broken',
    prompts: [{
      id: 'TS-99',
      job: 'leaky',
      fixture: 'clean-valid',
      prompt: 'Run project doctor and tell me what it says.',
      expectedRail: 'CHECK',
      expectedFirstFamilies: ['project doctor'],
      justification: 'x'.repeat(90),
      wrongRailAttractor: 'a wrong rail attractor that is long enough',
      mutationExpected: 'none',
    }],
  }, surface);
  assert.equal(result.valid, false);
  assert.ok(result.problems.some((problem) => problem.code === 'PROMPT_SET_LEAK'));
});

test('the mutation classifier does not fire on the discovery command itself', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // Both of these were false positives in the first real transcript this harness
  // recorded: `crm -- app` matched a naive `rm -` substring, and a path placeholder
  // written with angle brackets read as a shell redirect.
  const inspect = classifyAction('npm run crm -- app inspect --json 2>&1 | head -150', surface);
  assert.equal(inspect.family, 'app inspect');
  assert.equal(inspect.mutating, false);
  assert.equal(classifyAction('Read FIXTURE_ROOT/AGENTS.md', surface).mutating, false);
  assert.equal(classifyAction('grep -rli "x" . --include="*.js" | grep -v node_modules', surface).mutating, false);

  // And it does fire on the things it is for.
  assert.equal(classifyAction('rm -rf packages/work', surface).mutating, true);
  assert.equal(classifyAction('echo hi > notes.txt', surface).mutating, true);
  assert.equal(classifyAction('git commit -m "wip"', surface).mutating, true);
  assert.ok(MUTATING_SHELL.every((rule) => rule.pattern instanceof RegExp));
});

test('a command name only counts when the CLI is actually invoked', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // `demo`, `seed` and `serve` are single-token commands, so an unguarded scan would
  // read ordinary shell as the run's first Accordo action.
  assert.equal(classifyAction('ls examples/demo', surface).family, null);
  assert.equal(classifyAction('grep -rn "seed" packages/', surface).family, null);
  assert.equal(classifyAction('cat docs/APPLICATION_INSPECTION.md', surface).family, null);
  assert.equal(classifyAction('npm run crm -- demo', surface).family, 'demo');
  assert.equal(classifyAction('accordo app inspect --json', surface).family, 'app inspect');
  // The PRESERVE rail is a checked-in workflow rather than a CLI command, so it is
  // recognised on its own terms.
  assert.equal(classifyAction('npm run characterize:intelligence', surface).family, 'characterization');
  assert.equal(classifyAction('npm run characterize:intelligence', surface).rail, 'PRESERVE');
});

test('no prompt borrows the framework\'s own sentences', () => {
  // The token ban made every command word unusable, and the pressure went somewhere: it
  // pushed prompts toward the vocabulary the help text uses to *describe* those commands.
  // That is a stronger hint than the banned token, because it points at one command
  // rather than at the framework, and the token scan cannot see it — every word in
  // "does it hold up when" is ordinary English.
  //
  // Four words is deliberately strict. Over-inclusion costs prompt-writing effort;
  // under-inclusion silently invalidates every number the set ever produces, which is the
  // same one-directional trade the token ban already takes.
  const surface = readAccordoSurface(REPO_ROOT);
  const borrowed = [];
  for (const entry of loadPromptMatrix(REPO_ROOT).prompts) {
    const shared = proseOverlap(entry.prompt, surface, 4);
    if (shared.length > 0) borrowed.push(`${entry.id}: ${JSON.stringify(shared)}`);
  }
  assert.deepEqual(borrowed, [], `prompts quote the framework's own prose:\n${borrowed.join('\n')}`);
});

test('the prose scan is pointed at something, and can catch a planted quote', () => {
  // The negative control. A scan over an empty corpus passes every prompt, and a scan
  // that cannot catch a known borrowing is decoration.
  const surface = readAccordoSurface(REPO_ROOT);
  assert.ok(surface.prose.length >= 10, 'the prose corpus collapsed');
  const planted = 'I want to know whether it does it hold up when a real application composes it';
  assert.ok(proseOverlap(planted, surface, 4).length > 0, 'a verbatim borrowing went undetected');
});

test('naming the PRESERVE rail is not running it', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // `tests/characterization/` exists in every fixture, so a bare substring match turned
  // listing a directory into three `met` metrics on TS-09 — the rail whose expected
  // value is the hardest to reach was the easiest to fake.
  assert.equal(classifyAction('ls tests/characterization', surface).family, null);
  assert.equal(classifyAction('cat tests/characterization/README.md', surface).family, null);
  assert.equal(
    classifyAction('tests/characterization/renewal.test.js', surface, { tool: 'Read' }).family,
    null,
    'a Read of a characterization file is not a characterization run',
  );
  // Actually running one still counts, by either runner.
  assert.equal(classifyAction('npm run characterize:intelligence', surface).family, 'characterization');
  assert.equal(classifyAction('node --test tests/characterization/renewal.test.js', surface).family, 'characterization');
});

test('searching for a command is not running it', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // The pilot's own TS-01 failure was twenty-nine actions of `find`, `grep` and `sed`
  // without ever running the command. One of those greps containing the command string
  // would have scored it `met` — the observation arm reproducing the self-report shape
  // that §2.1 exists to refuse.
  assert.equal(classifyAction('grep -rn "npm run crm -- app inspect" docs/', surface).family, null);
  assert.equal(classifyAction("rg 'accordo project doctor' --glob '*.md'", surface).family, null);
  assert.equal(classifyAction('grep -rn npm run crm -- app inspect docs/', surface).family, null);
  // For a search tool the captured text *is* the pattern, so it can never be a command.
  assert.equal(
    classifyAction('npm run crm -- app inspect', surface, { tool: 'Grep' }).family,
    null,
    'a Grep pattern is a question, not an invocation',
  );
  // A real invocation in a later segment is still found.
  assert.equal(
    classifyAction('cat README.md && npm run crm -- app inspect --json', surface).family,
    'app inspect',
  );
  // And a real invocation carrying a quoted argument is untouched.
  assert.equal(
    classifyAction('npm run crm -- scenario run "lead to won"', surface).family,
    'scenario run',
  );
});

test('scaffold is a plan unless the writing flag is explicit', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  const planned = classifyAction('npm run crm -- package scaffold grants --json', surface);
  assert.equal(planned.family, 'package scaffold');
  assert.equal(planned.rail, 'BUILD');
  assert.equal(planned.dryRun, true);
  assert.equal(planned.mutating, false);

  const applied = classifyAction('npm run crm -- package scaffold grants --apply', surface);
  assert.equal(applied.dryRun, false);
  assert.equal(applied.mutating, true);
});

test('a flag the CLI would not recognise is not a flag the classifier acts on', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // The classifier lower-cased the whole line before parsing flags; `parseArgs` in the CLI
  // is case-preserving and tests `flags.apply === true`. So `--APPLY` writes nothing and
  // was classified as the run's mutation — a `not_met` on the restraint metric of the one
  // prompt where restraint is the entire point, for an invocation that scaffolds nothing.
  for (const line of [
    'npm run crm -- package scaffold grants --APPLY',
    'npm run crm -- package scaffold grants --Apply',
    'npm run crm -- PACKAGE SCAFFOLD grants --APPLY',
  ]) {
    const classified = classifyAction(line, surface);
    assert.equal(classified.family, 'package scaffold', `${line}: the command is still recognised`);
    assert.equal(classified.mutating, false, `${line}: the CLI writes nothing here, so neither does the classifier`);
  }
  // And the flag the CLI *does* read still decides.
  assert.equal(classifyAction('npm run crm -- package scaffold grants --apply', surface).mutating, true);
});

test('an explicit dry-run beats apply, exactly as the CLI itself decides it', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // `packageScaffoldCommand` computes `writing = apply && !dryRun`, and the help text
  // says so: "It is a plan unless --apply is explicit, and an explicit --dry-run beats
  // it". A classifier that substring-matches `--apply` anywhere in the line scores this
  // as the run's mutation, on the one prompt where mutation is the headline metric.
  const both = classifyAction('npm run crm -- package scaffold grants --apply --dry-run', surface);
  assert.equal(both.family, 'package scaffold');
  assert.equal(both.mutating, false, 'the CLI writes nothing here, so neither does the classifier');
  assert.equal(both.dryRun, true);
});

test('the writing flag counts only where the command that writes could read it', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // A different segment is a different command line.
  const elsewhere = classifyAction('npm run crm -- package scaffold grants && echo --apply', surface);
  assert.equal(elsewhere.family, 'package scaffold');
  assert.equal(elsewhere.mutating, false, '--apply in a later segment is an argument to echo');

  // A quoted span is an argument, never a flag.
  const quoted = classifyAction('npm run crm -- package scaffold "grants --apply"', surface);
  assert.equal(quoted.mutating, false, 'a quoted --apply is a package name, not a flag');

  // `--apply` followed by a value is not a boolean true to the CLI's own parser, so it
  // does not write; `--apply=false` is the string "false" for the same reason.
  const valued = classifyAction('npm run crm -- package scaffold --apply grants', surface);
  assert.equal(valued.mutating, false, "the CLI's parser reads this as apply='grants', which is not true");
  const negated = classifyAction('npm run crm -- package scaffold grants --apply=false', surface);
  assert.equal(negated.mutating, false);
});

test('a migration writes when it is given somewhere to write, and not when it is not', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  const planned = classifyAction('npm run crm -- module migration modules/grant.module.json', surface);
  assert.equal(planned.family, 'module migration');
  assert.equal(planned.mutating, false, 'migration generation is a dry-run unless --out is provided');

  const written = classifyAction('npm run crm -- module migration modules/grant.module.json --out grants.sql', surface);
  assert.equal(written.mutating, true);

  const suppressed = classifyAction('npm run crm -- module migration modules/grant.module.json --out grants.sql --dry-run', surface);
  assert.equal(suppressed.mutating, false, "the CLI drops --out entirely when --dry-run is given");
});

test('an arrow is not a redirect, and neither is a comparison', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  for (const line of [
    // Both of these were deleted in the commit that introduced the inline-interpreter
    // rule, because that rule broke them. They are restored: a read-only one-liner is not
    // a mutation, and removing the cases that proved a rule does not over-fire is how a
    // defect ships green.
    'node -e "console.log(plan.status -> report)"',
    'node -e "if (domains > 4) console.log(\'many\')"',
    'perl -e \'print "hello"\'',
    'npm run crm -- app inspect --json | jq ".domains | map(.name) => sorted"',
    'git log --oneline -5 # lead -> opportunity -> quote',
    'test $count -gt 5 && echo many',
    'grep -rn "if (domains > 4)" packages/',
  ]) {
    assert.equal(
      classifyAction(line, surface).mutating, false,
      `a mutation detector that fires on ${line} reports premature mutation for a run that wrote nothing`,
    );
  }
  // The rule it is meant to catch still fires.
  assert.equal(classifyAction('node scripts/report.js > report.json', surface).mutating, true);
  assert.equal(classifyAction('echo hi >>notes.txt', surface).mutating, true);
  assert.equal(classifyAction('node scripts/report.js > 2026-report.json', surface).mutating, true);
  // An interpreter handed inline code is a write witness in its own right, whatever the
  // rest of the line looks like — that is the point of the `-e`/`-c` rule.
  assert.equal(classifyAction('node -e "require(\'fs\').writeFileSync(\'x\', \'y\')"', surface).mutating, true);
});

test('the milestone identifiers a prompt may not carry are read from the repository', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // What the repository actually calls its milestones, gathered independently of the
  // scanner's own source so the two can disagree.
  const inDocs = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.md')) continue;
      for (const match of readFileSync(path, 'utf8').matchAll(/\b(?:AX|DX|LA)\d{1,2}\b/g)) inDocs.add(match[0]);
    }
  };
  walk(join(REPO_ROOT, 'docs'));
  assert.ok(inDocs.size >= 20, 'this repository names a lot of milestones; a scan that found few is scanning the wrong thing');

  const missed = [...inDocs].filter((identifier) => (
    scanPromptForSurfaceLeak(`Please look at ${identifier} and tell me what it needs.`, surface).length === 0
  ));
  assert.deepEqual(
    missed, [],
    'a hand-typed list of milestone identifiers goes stale the moment somebody adds a milestone, '
    + 'silently and in the direction that makes the benchmark look better',
  );
});


/**
 * ## The shell classifier is checked against bash, over a cross-product rather than a list
 *
 * Three consecutive rounds of review found the same defect in this one function, and each
 * fix was written to the spellings the previous reviewer happened to supply: `<<'EOF'`,
 * then `<<'EOF'`/`<<"EOF"`/`<<EOF`/`<<-EOF`, while bash also accepts `<<\EOF`, `<<EOF.txt`,
 * `<<1EOF` and `<<'E-OF'`. The accompanying tests enumerated exactly the cases that had
 * been named, so a green suite and a false `met` on the primary metric coexisted: **the
 * tests were the examples, so they could not find the boundary.**
 *
 * Round five replaced the examples with a generator and a differential oracle, which was
 * the right instrument and still could not find the boundary — because the generator was
 * written and then extended until it passed, so **the corpus became the set of texts the
 * classifier already agreed with**. Four hundred and forty of its five hundred and sixteen
 * texts were one nested loop over heredoc delimiters; the rest were hand-listed, and the
 * bias in that list was visible once anyone counted: every branch construct was one that
 * executes, every redirect wrote a real file, `/dev/null` appeared nowhere in the file at
 * all, and every wrapper appeared in run position and never in mention position. The
 * enumeration had moved one level up, from the tests to the generator.
 *
 * So the corpus below is not a list of shapes. It is the **cross-product of five
 * independent axes**, each enumerated to its own boundary and combined with every value of
 * every other:
 *
 * | axis | values |
 * | --- | --- |
 * | invocation position | run · mention · quoted argument · heredoc body · comment · `eval` argument · `sh -c` argument · here-string |
 * | redirect | none · `> file` · `>> file` · `> /dev/null` · `2>/dev/null` · `2>err.log` · `&>out` · `1>out` · `> $VAR` · an `->` inside a string |
 * | wrapper | none · `time` · `env FOO=1` · `nice -n 5` · `timeout 60` · `sudo -u x` · `xargs` |
 * | branch | none · taken · `if false` · empty `for` · non-matching `case` · `&&` after failure · `||` after success |
 * | grouping | none · subshell · pipeline · background · function body · `trap` |
 *
 * Nobody chose the combinations, so nobody could choose the easy ones. When this corpus
 * was first driven against the classifier it produced **11,858 disagreements over 23,520
 * cells** — against the 516-text corpus that had been passing, whose only failures were
 * the four a reviewer added by hand.
 *
 * ## The two questions the oracle asks are different questions
 *
 * The instrument's own documented limitation is that fixtures are uninstalled, so a
 * correctly selected command usually fails to execute: this measures **selection**, not
 * execution. An agent that writes `if false; then accordo app inspect; fi` selected the
 * rail, and a benchmark about tool selection has to score that as a selection. So:
 *
 * - the **family and rail** verdict is checked against *command position*, which bash
 *   answers by running the same fragment under a taken guard. `echo accordo app inspect`
 *   is a mention under every guard and must never score;
 * - the **mutation witness** is checked against what bash *actually wrote*, because the
 *   declared boundary for whether a fixture moved is its fingerprint pair and nothing
 *   else. A guard that is not taken writes nothing, so the shell witness is allowed to
 *   over-report there — and only there. It is never allowed to miss a write bash
 *   performed, and never allowed to claim one that no guard would have performed.
 *
 * That asymmetry used to be implicit, which is exactly how a corpus could hide it.
 */
const ORACLE_INVOCATION = 'npm run crm -- app inspect --json';

/**
 * Invocation position: where in the text the command name sits. `lead` precedes the
 * command line, `head` is the command line itself — the wrapper prefixes it and the
 * redirect suffixes it — and `tail` is text belonging to the same construct.
 */
const ORACLE_POSITIONS = {
  run: { lead: '', head: ORACLE_INVOCATION, tail: '' },
  mention: { lead: '', head: `echo ${ORACLE_INVOCATION}`, tail: '' },
  quoted: { lead: '', head: `grep -rn "${ORACLE_INVOCATION}" docs/`, tail: '' },
  heredoc: { lead: '', head: 'cat <<EOF', tail: `\n${ORACLE_INVOCATION}\nEOF` },
  comment: { lead: `# ${ORACLE_INVOCATION}\n`, head: 'true', tail: '' },
  evalArg: { lead: '', head: `eval "${ORACLE_INVOCATION}"`, tail: '' },
  shellDashC: { lead: '', head: `bash -c "${ORACLE_INVOCATION}"`, tail: '' },
  hereString: { lead: '', head: `bash <<<"${ORACLE_INVOCATION}"`, tail: '' },
};

/**
 * Wrappers, applied to whatever program the position puts in command position. The bare
 * assignment is one of them: it is not a program at all, and the colon inside its value is
 * what separated the classifier's idea of "the program of a segment" from the shell's.
 */
const ORACLE_WRAPPERS = {
  none: '', time: 'time ', env: 'env FOO=1 ', nice: 'nice -n 5 ',
  timeout: 'timeout 60 ', sudo: 'sudo -u x ', xargs: 'xargs ',
  assignment: 'ACCORDO_PATH=/opt/bin:/usr/bin ',
};

/** Redirects. Six of these write a file, four do not, and none of them is a special case. */
const ORACLE_REDIRECTS = {
  none: { suffix: '', after: '' },
  file: { suffix: ' > out.txt', after: '' },
  append: { suffix: ' >> out.txt', after: '' },
  devnull: { suffix: ' > /dev/null', after: '' },
  errdevnull: { suffix: ' 2>/dev/null', after: '' },
  errfile: { suffix: ' 2>err.log', after: '' },
  ampout: { suffix: ' &>out', after: '' },
  fdone: { suffix: ' 1>out', after: '' },
  varfile: { suffix: ' > $OUTFILE', after: '' },
  arrowstring: { suffix: '', after: '\necho "lead -> opportunity"' },
};

/** Guards. Five of the seven never run their body; that is the point of listing five. */
const ORACLE_BRANCHES = {
  none: (body) => body,
  taken: (body) => `if true; then\n${body}\nfi`,
  ifFalse: (body) => `if false; then\n${body}\nfi`,
  forEmpty: (body) => `for q in ; do\n${body}\ndone`,
  caseMiss: (body) => `case zz in aa)\n${body}\n;; esac`,
  andAfterFail: (body) => `false && {\n${body}\n}`,
  orAfterOk: (body) => `true || {\n${body}\n}`,
};

/** The guard every position probe wears, so command position is asked of the fragment. */
const ORACLE_TAKEN_GUARD = (body) => `if true; then\n${body}\nfi`;

const ORACLE_GROUPINGS = {
  none: (body) => body,
  subshell: (body) => `(\n${body}\n)`,
  pipeline: (body) => `{\n${body}\n} | cat`,
  background: (body) => `{\n${body}\n} &\nwait`,
  functionBody: (body) => `f() {\n${body}\n}\nf`,
  trap: (body) => `trap '\n${body}\n' EXIT`,
};

/** Quote removal, the way the shell applies it to a heredoc delimiter word. */
function removeQuotes(spelling) {
  let out = '';
  for (let index = 0; index < spelling.length; index += 1) {
    const char = spelling[index];
    if (char === '\\') { out += spelling[index + 1] ?? ''; index += 1; continue; }
    if (char === "'" || char === '"') {
      const close = spelling.indexOf(char, index + 1);
      out += spelling.slice(index + 1, close === -1 ? undefined : close);
      index = close === -1 ? spelling.length : close;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * The heredoc axes, kept as a cross-product of their own because a delimiter spelling has
 * no meaningful interaction with a wrapper or a guard and crossing them would multiply the
 * corpus by twenty-two for nothing. Delimiter spelling × `<<` against `<<-` × the optional
 * gap × where the invocation sits relative to the terminator.
 */
function heredocCrossProduct() {
  /** @type {Array<{ label: string, snippet: string, probe: string }>} */
  const cases = [];
  const run = ORACLE_INVOCATION;
  const delimiters = [
    'EOF', "'EOF'", '"EOF"', '\\EOF', "'E-OF'", 'EOF.txt', '1EOF', '_end_', 'E"OF"',
    "END'S'", 'e\\ nd', '$X', "'$X'", '..', '-', '2', 'EOF\\;', 'a"b"c', "x'y'z", '\\-EOF',
    'É', 'e#f', "''",
  ];
  for (const spelling of delimiters) {
    const terminator = removeQuotes(spelling);
    for (const dash of ['', '-']) {
      for (const gap of ['', ' ']) {
        // `<<` immediately followed by `-` *is* the `<<-` operator, so this one cell of the
        // product spells `cat <<- > notes.md`, which is a syntax error rather than a text
        // about a delimiter. Skipped where the spelling is ambiguous, kept everywhere else.
        if (dash === '' && gap === '' && spelling.startsWith('-')) continue;
        const open = `cat <<${dash}${gap}${spelling} > notes.md`;
        const indent = dash === '-' ? '\t' : '';
        for (const [placement, snippet] of Object.entries({
          body: `${open}\nremember: ${run}\n${indent}${terminator}\n`,
          after: `${open}\nremember\n${indent}${terminator}\n${run}\n`,
          nearMiss: `${open}\nremember\n${indent}${terminator} \n${run}\n`,
          unterminated: `${open}\nremember\n${run}\n`,
          spaceIndent: `${open}\nremember\n  ${terminator}\n${run}\n`,
        })) {
          cases.push({ label: `heredoc/${spelling}/${dash || 'plain'}/${gap ? 'gap' : 'tight'}/${placement}`, snippet, probe: snippet });
        }
      }
    }
  }
  // Arithmetic, which reaches the same `<<` branch of the lexer from a context where it is
  // a shift operator rather than a redirection. A phantom heredoc opened here swallows
  // every line that follows it, which is how an entire transcript entry disappears.
  for (const [name, line] of Object.entries({
    arithmeticShift: 'echo $(( 1 << 3 ))',
    arithmeticAssign: '(( x = 1 )); (( x <<= 2 ))',
    arithmeticInAssignment: 'y=$(( 1 << 3 ))',
    arithmeticQuoted: 'echo "$(( 1 << 3 ))"',
    arithmeticCompare: 'echo $(( 3 > 2 ))',
  })) {
    const snippet = `${line}\n${ORACLE_INVOCATION}\n`;
    cases.push({ label: `arithmetic/${name}`, snippet, probe: snippet });
  }
  return cases;
}

/** The whole corpus: one cross-product for command shape, one for heredoc shape. */
function shellCorpus() {
  /** @type {Array<{ label: string, snippet: string, probe: string }>} */
  const cases = [];
  for (const [positionName, position] of Object.entries(ORACLE_POSITIONS)) {
    for (const [wrapperName, wrapper] of Object.entries(ORACLE_WRAPPERS)) {
      for (const [redirectName, redirect] of Object.entries(ORACLE_REDIRECTS)) {
        const inner = `${position.lead}${wrapper}${position.head}${redirect.suffix}${position.tail}${redirect.after}`;
        for (const [branchName, branch] of Object.entries(ORACLE_BRANCHES)) {
          for (const [groupingName, grouping] of Object.entries(ORACLE_GROUPINGS)) {
            cases.push({
              label: `${positionName}/${wrapperName}/${redirectName}/${branchName}/${groupingName}`,
              snippet: `${grouping(branch(inner))}\n`,
              // The same fragment under a taken guard, in the same grouping. This is what
              // decides command position, so the guard is asked of the guard and never of
              // the fragment inside it.
              probe: `${grouping(ORACLE_TAKEN_GUARD(inner))}\n`,
            });
          }
        }
      }
    }
  }
  return [...cases, ...heredocCrossProduct()];
}

/**
 * The sandbox, and why it is shaped the way it is.
 *
 * Every program the corpus names is a recorder that writes its own argv and exits. Nothing
 * real runs and nothing outside the temporary root is touched. Two details are load-bearing:
 *
 * - **the sandbox directory starts empty and nothing seeds it**, so "did this write a file"
 *   is "is the directory still empty". The previous version seeded four files and
 *   subtracted them by name, which made a write *to* any of those four invisible;
 * - **a recorder logs only when `$0` contains a slash.** A shebang script started from
 *   `PATH` is exec'd by the kernel with its resolved path as `$0`; a file handed to `bash
 *   <name>` is read as a script and gets the bare name. Real programs are not bash scripts,
 *   so `xargs bash <<<"npm run crm …"` runs nothing in a real checkout — and without this
 *   the sandbox's own recorders made it appear to succeed.
 *
 * The corpus is handed to one bash driver per core rather than spawned one text at a time,
 * because 26,880 node→bash round trips is four minutes and 26,880 forks inside bash is
 * under a minute.
 */
const ORACLE_DRIVER = [
  '#!/bin/bash',
  '# $1 cases root  $2 sandbox root  $3 bin dir  $4 log dir  $5 out root  $6 id width  $7 shards',
  'set -u',
  'shopt -s nullglob dotglob',
  'cases=$1; sandroot=$2; bin=$3; logs=$4; outroot=$5; width=$6; shards=$7',
  'worker() {',
  '  local dir=$1 sand=$2 out=$3 index=$4 f id w',
  '  : > "$out"',
  '  rm -rf "$sand"; mkdir -p "$sand"',
  '  for f in "$dir"/*.sh; do',
  '    printf -v id "%0*d" "$width" "$index"',
  '    index=$((index + 1))',
  '    if ! bash -n "$f" 2>/dev/null; then printf \'%s 0 0\\n\' "$id" >> "$out"; continue; fi',
  '    : > "$logs/$id"',
  '    ( cd "$sand" && exec env -i PATH="$bin:/usr/bin:/bin" HOME="$sand" \\',
  '        TS_ORACLE_LOG="$logs/$id" OUTFILE=v.txt FOO=1 \\',
  '        timeout 10 bash "$f" ) >/dev/null 2>&1 </dev/null',
  '    left=("$sand"/*)',
  '    if [ ${#left[@]} -eq 0 ]; then w=0; else w=1; rm -rf "$sand"; mkdir -p "$sand"; fi',
  '    printf \'%s %s 1\\n\' "$id" "$w" >> "$out"',
  '  done',
  '}',
  'k=0',
  'while [ "$k" -lt "$shards" ]; do',
  '  start=$(cat "$cases/$k.start")',
  '  worker "$cases/$k" "$sandroot/$k" "$outroot/$k.txt" "$start" &',
  '  k=$((k + 1))',
  'done',
  'wait',
  '',
].join('\n');

/**
 * Run every text through a real bash and report, for each, whether the invocation reached
 * a recorder and whether anything was left on disk.
 *
 * @param {string[]} snippets @param {string} root
 * @returns {Array<{ ran: boolean, wrote: boolean, parses: boolean }>}
 */
function runThroughBash(snippets, root) {
  const bin = join(root, 'bin');
  const cases = join(root, 'cases');
  const logs = join(root, 'logs');
  const outs = join(root, 'out');
  for (const dir of [bin, cases, logs, outs]) mkdirSync(dir, { recursive: true });
  for (const name of ['npm', 'npx', 'accordo', 'crm', 'pnpm', 'yarn', 'ls', 'cat', 'grep', 'echo', 'printf', 'true']) {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\ncase "$0" in */*) printf '%s\\n' "${name} $*" >> "$TS_ORACLE_LOG" ;; esac\nexit 0\n`);
    chmodSync(path, 0o755);
  }
  // `sudo` is one of the wrappers and is not installed here. A shim that drops the
  // wrapper's own options and execs the rest is exactly what `sudo -u x cmd` does to cmd.
  writeFileSync(join(bin, 'sudo'), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -u|-g|-p|-C) shift 2;; -*) shift;; *) break;; esac; done\nexec "$@"\n');
  chmodSync(join(bin, 'sudo'), 0o755);

  const width = Math.max(1, String(snippets.length).length);
  const shards = Math.max(1, Math.min(availableParallelism(), Math.ceil(snippets.length / 25)));
  const per = Math.ceil(snippets.length / shards);
  for (let shard = 0; shard < shards; shard += 1) {
    const dir = join(cases, String(shard));
    mkdirSync(dir, { recursive: true });
    const start = shard * per;
    writeFileSync(join(cases, `${shard}.start`), String(start));
    for (let index = start; index < Math.min(start + per, snippets.length); index += 1) {
      writeFileSync(join(dir, `${String(index).padStart(width, '0')}.sh`), snippets[index]);
    }
  }
  const driver = join(root, 'driver.sh');
  writeFileSync(driver, ORACLE_DRIVER);
  chmodSync(driver, 0o755);
  const result = spawnSync(
    'bash',
    [driver, cases, join(root, 'sandbox'), bin, logs, outs, String(width), String(shards)],
    { encoding: 'utf8', timeout: 20 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  assert.equal(result.status, 0, `the oracle driver failed: ${result.stderr}`);

  /** @type {Map<string, { wrote: boolean, parses: boolean }>} */
  const observed = new Map();
  for (let shard = 0; shard < shards; shard += 1) {
    for (const line of readFileSync(join(outs, `${shard}.txt`), 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const [id, wrote, parses] = line.split(' ');
      observed.set(id, { wrote: wrote === '1', parses: parses === '1' });
    }
  }
  return snippets.map((_, index) => {
    const id = String(index).padStart(width, '0');
    const entry = observed.get(id) ?? { wrote: false, parses: false };
    const log = entry.parses ? readFileSync(join(logs, id), 'utf8').split('\n').filter(Boolean) : [];
    return { ran: log.includes(ORACLE_INVOCATION), wrote: entry.wrote, parses: entry.parses };
  });
}

test('the shell classifier agrees with bash over the whole cross-product', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  assert.equal(
    spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim(), 'ok',
    'this property is checked against a real shell; without one there is no oracle, and a '
    + 'skipped oracle is how the last three rounds of this defect stayed green',
  );

  const corpus = shellCorpus();
  // The size is asserted against the product of the axes rather than against a number
  // somebody typed, so removing a value from an axis fails here instead of quietly
  // shrinking what is checked.
  const expectedCells = Object.keys(ORACLE_POSITIONS).length
    * Object.keys(ORACLE_WRAPPERS).length
    * Object.keys(ORACLE_REDIRECTS).length
    * Object.keys(ORACLE_BRANCHES).length
    * Object.keys(ORACLE_GROUPINGS).length;
  assert.ok(
    corpus.length > expectedCells,
    `the corpus generated ${corpus.length} texts and the axes alone are ${expectedCells}; an axis has been dropped`,
  );

  const root = mkdtempSync(join(tmpdir(), 'ts-shell-oracle-'));
  try {
    // Position probes are deduplicated: the probe text depends on every axis except the
    // branch, because the branch is the thing it is normalising away.
    const probes = [...new Set(corpus.map((entry) => entry.probe))];
    const probeAt = new Map(probes.map((text, index) => [text, index]));
    const subjectResults = runThroughBash(corpus.map((entry) => entry.snippet), join(root, 'subjects'));
    const probeResults = runThroughBash(probes, join(root, 'probes'));

    /** @type {string[]} */
    const disagreements = [];
    let compared = 0;
    let unparseable = 0;
    let guardedWrites = 0;
    for (let index = 0; index < corpus.length; index += 1) {
      const { label, snippet, probe: probeText } = corpus[index];
      const subject = subjectResults[index];
      if (!subject.parses) { unparseable += 1; continue; }
      const probe = probeResults[/** @type {number} */ (probeAt.get(probeText))];
      compared += 1;
      const classified = classifyAction(snippet, surface);

      // 1. The family is a question about command position, answered by the probe.
      const expectedFamily = probe.ran ? 'app inspect' : null;
      if (classified.family !== expectedFamily) {
        disagreements.push(
          `[${label}] the invocation ${probe.ran ? 'is' : 'is not'} in command position; `
          + `classifier said ${JSON.stringify(classified.family)}: ${JSON.stringify(snippet)}`,
        );
      }

      // 2. The mutation witness is a question about what bash actually wrote, with one
      //    declared and one-directional slack: a write under a guard bash did not take.
      if (subject.wrote && !classified.mutating) {
        disagreements.push(`[${label}] bash wrote a file; classifier said mutating=false: ${JSON.stringify(snippet)}`);
      } else if (!subject.wrote && classified.mutating) {
        if (probe.wrote) guardedWrites += 1;
        else disagreements.push(`[${label}] bash wrote nothing under any guard; classifier said mutating=true: ${JSON.stringify(snippet)}`);
      }
    }

    assert.equal(unparseable, 0, `${unparseable} of ${corpus.length} texts are not shell bash will accept; the generator is producing nonsense`);
    assert.ok(compared > expectedCells, `only ${compared} texts were compared against the shell`);
    assert.ok(
      guardedWrites > 0,
      'not one text in the corpus writes a file under a guard bash does not take; the branch axis '
      + 'has stopped generating non-taken branches, and the slack below is being asserted against nothing',
    );
    assert.deepEqual(
      disagreements, [],
      'the classifier must agree with the shell about what a text does, for every combination of the axes',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The bounds this classifier does not model, asserted rather than described.
 *
 * Each of these is a text where bash and the classifier disagree on purpose, and the
 * direction is always the same: the classifier reports *no* action rather than inventing
 * one, because inventing one is the failure the contract says must never happen. A bound
 * that stops being real fails here, which is the difference between a declared limitation
 * and an undiscovered defect.
 */
test('the classifier errs toward missing an action, and every miss is declared', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  const declared = {
    // Expansion is not modelled at all: a classifier that guessed at `$CMD` could turn any
    // text into any command, which is inventing observations rather than reading them.
    variableExpansion: 'CMD="npm run crm -- app inspect"; $CMD',
    aliasDefinition: 'alias ai="npm run crm -- app inspect"; ai --json',
    functionIndirection: 'go() { npm run crm -- "$@"; }; go app inspect',
    // A long wrapper option that takes a separate value stops the wrapper scan, because
    // consuming the next word would eat the command in the far more common case where the
    // option takes none.
    longWrapperOption: 'sudo --user someone npm run crm -- app inspect --json',
    // A shell reading a script from a file, rather than from `-c` or a here-string.
    scriptFile: 'bash ./inspect.sh',
    scriptFromStdin: 'bash < inspect.sh',
    // A quoted span is an argument, which is what keeps `grep -rn "npm run crm …"` from
    // scoring. The cost is the other side of the same rule: quoting the *script name*
    // hides it, even though the shell would run it.
    quotedArgumentToken: 'npm run "crm" -- app inspect',
  };
  for (const [name, snippet] of Object.entries(declared)) {
    assert.equal(
      classifyAction(snippet, surface).family, null,
      `${name} is a declared bound: the classifier must report no action rather than guess at one`,
    );
  }

  // And the direction is asserted, not assumed: each of these is the same shape with the
  // indirection removed, and each must be found.
  const found = {
    variableExpansion: 'npm run crm -- app inspect',
    // The program itself is read from the raw segment, so quoting it changes nothing, and
    // an inline assignment carrying a colon is still an assignment.
    quotedProgram: '"npm" run crm -- app inspect',
    colonAssignment: 'PATH=/opt/bin:$PATH npm run crm -- app inspect',
    longWrapperOption: 'sudo -u someone npm run crm -- app inspect --json',
    scriptFile: 'bash -c "npm run crm -- app inspect"',
    // The combined short-option spellings a shell accepts for `-c`.
    loginShell: 'bash -lc "npm run crm -- app inspect"',
    scriptFromStdin: 'bash <<<"npm run crm -- app inspect"',
  };
  for (const [name, snippet] of Object.entries(found)) {
    assert.equal(classifyAction(snippet, surface).family, 'app inspect', `${name} without the indirection must be found`);
  }
});


test('what can start this framework is an allowlist, and reading programs are excluded by absence', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // Every way this repository publishes of reaching its own CLI has to be a program the
  // gate recognises, or a real invocation is silently read as none.
  for (const binary of surface.binaries) {
    assert.ok(
      CLI_RUNNERS.includes(binary), `${binary} is published as a way to reach this CLI and the gate does not know it`,
    );
  }
  // The entry point `package.json` publishes counts as the binary it publishes: an agent
  // that runs it directly has invoked the CLI, and reading that as nothing would be the
  // same class of miss as reading `eval "…"` as an argument.
  const [binPath] = Object.values(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).bin ?? {});
  assert.ok(binPath, 'this repository publishes a bin entry; without one this check is vacuous');
  assert.equal(classifyAction(`${binPath} app inspect --json`, surface).family, 'app inspect');
  assert.equal(classifyAction(`node ${binPath.replace(/^\.\//, '')} app inspect --json`, surface).family, 'app inspect');

  // And a reading program is excluded by *not being on the list*, which is why the list of
  // readers no longer has to be complete. Each of these was absent from the twenty-four-name
  // denylist that preceded it, and each therefore invented an Accordo action.
  for (const reader of [
    'git grep -n "npm run crm -- app inspect" docs/',
    'jq -r .scripts.crm package.json # npm run crm -- app inspect',
    'cut -d" " -f1 <<<"npm run crm -- app inspect"',
    'sort <<<"npm run crm -- app inspect"',
    'uniq -c notes.txt # npm run crm -- app inspect',
    'tr -d " " <<<"npm run crm -- app inspect"',
    'paste a b # npm run crm -- app inspect',
    'time echo npm run crm -- app inspect --json',
    'env FOO=1 echo npm run crm -- app inspect --json',
  ]) {
    assert.equal(
      classifyAction(reader, surface).family, null,
      `${reader} looks at a command name; it does not run one`,
    );
  }
});

test('a heredoc body is data, and never the command it mentions', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // Writing a notes file that quotes a CLI command is ordinary behaviour in this
  // repository. Reading the quote as an invocation invents the one observation the
  // contract says must never be guessed at.
  const heredoc = [
    "cat <<'EOF' > notes.md",
    '# What I would do next',
    'We should probably use npm run crm -- app inspect here, then decide.',
    'EOF',
  ].join('\n');
  const written = classifyAction(heredoc, surface);
  assert.equal(written.family, null, 'the body is the file being written, not a command that ran');
  assert.equal(written.mutating, true, 'and the redirect on the opening line is a real write');

  // An indented terminator, and a bare delimiter.
  const dashed = ['cat <<-EOF > notes.md', '\tnpm run crm -- project doctor', '\tEOF'].join('\n');
  assert.equal(classifyAction(dashed, surface).family, null);

  // A command *after* the heredoc closes is still a command.
  const after = ["cat <<'EOF' > notes.md", 'nothing to see', 'EOF', 'npm run crm -- app inspect --json'].join('\n');
  assert.equal(classifyAction(after, surface).family, 'app inspect');
});

test('a continued line is one command, not two halves of none', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  const continued = 'npm run crm -- \\\n  app inspect --json';
  assert.equal(
    classifyAction(continued, surface).family, 'app inspect',
    'the continuation line begins with `app`, which invokes nothing; joining is what the shell does',
  );
});

test('the prompt set is identified by what it says, not by what it calls itself', () => {
  const matrix = loadPromptMatrix(REPO_ROOT);
  assert.match(matrix.setId, /^TS-[0-9a-f]{12}$/);
  assert.equal(matrix.declaredSetId, 'TS-v1', 'the author-supplied label is kept beside it, never instead of it');

  // Two sets that call themselves the same thing are two sets. A hand-supplied id is a
  // label the author controls, and the guard comparing it would have agreed with itself.
  const edited = derivePromptSetId(matrix.prompts.map((prompt, index) => (
    index === 0 ? { ...prompt, prompt: `${prompt.prompt} And check the cache.` } : prompt
  )));
  assert.notEqual(edited, matrix.setId, 'editing a prompt must change the set it belongs to');
});

test('the prose guard runs when the matrix is loaded, not only when a test calls it', () => {
  const surface = readAccordoSurface(REPO_ROOT);
  // The freeze pinned this guard's n-gram width and the commit message said it refuses a
  // prompt that borrows the framework's sentences — while nothing outside a test called
  // it. Same shape as the freeze gate: written, exported, never reached.
  const borrowed = surface.cliHelp.split('\n').find((line) => line.trim().split(/\s+/).length >= 8);
  assert.ok(borrowed, 'the help text must contain a long enough line to borrow');
  const { problems } = validatePromptMatrix({
    toolSelectionPromptSet: PROMPT_SET_CONTRACT,
    setId: 'TS-borrowed',
    prompts: [{
      id: 'TS-01',
      job: 'borrowing',
      fixture: 'clean-valid',
      prompt: `Here is the situation. ${borrowed.trim()} What should I do?`,
      expectedRail: 'SEE',
      expectedFirstFamilies: ['app inspect'],
      justification: 'x',
      wrongRailAttractor: 'y',
      mutationExpected: 'none',
    }],
  }, surface);
  assert.ok(
    problems.some((problem) => problem.detail.includes('PROMPT_BORROWS_PROSE')),
    'a prompt quoting the framework back at the agent has to be refused by the loader',
  );
});
