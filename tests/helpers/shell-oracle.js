// @ts-check

/**
 * The shell-oracle corpus and driver, shared by the six oracle slices
 * (tests/shell-oracle-a/b/c/d/e/f.test.js, backlog:664d5f481a96).
 *
 * The oracle used to live in one test file, so one measure piece held the
 * whole 26,880-cell full corpus and needed a 1,800 s lock maximum while
 * every other piece declared the common maximum. The independent verifier failed that
 * exception (every piece must declare the same maximum), so the corpus is sliced here
 * by grouping singleton — each slice about a sixth of the cells, the
 * heaviest full slice holding documented margin under the common maximum — and each
 * slice file lands in its own measure piece under the same maximum (1800 s)
 * as everything else. The cells are unchanged: the union of the six slices
 * is exactly the corpus the single file generated.
 *
 * A test slice must never import a `*.test.js` file (importing one
 * registers its tests in the importing run), so everything the slices share
 * lives here, in a helper no test runner discovers.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

import { classifyAction, readAccordoSurface } from '../../benchmarks/tool-selection/surface.js';

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
export const ORACLE_POSITIONS = {
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
export const ORACLE_BRANCHES = {
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

export const ORACLE_GROUPINGS = {
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
export const HEREDOC_DELIMITER_SPELLINGS = [
  'EOF', "'EOF'", '"EOF"', '\\EOF', "'E-OF'", 'EOF.txt', '1EOF', '_end_', 'E"OF"',
  "END'S'", 'e\\ nd', '$X', "'$X'", '..', '-', '2', 'EOF\\;', 'a"b"c', "x'y'z", '\\-EOF',
  'É', 'e#f', "''",
];

/**
 * @param {string[]} [spellings] delimiter spellings to cross; the whole list by
 * default, the local sample in the default oracle run.
 */
function heredocCrossProduct(spellings = HEREDOC_DELIMITER_SPELLINGS) {
  /** @type {Array<{ label: string, snippet: string, probe: string }>} */
  const cases = [];
  const run = ORACLE_INVOCATION;
  for (const spelling of spellings) {
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
          cases.push({ label: `heredoc-delim/${spelling}/${dash || 'plain'}/${gap ? 'gap' : 'tight'}/${placement}`, snippet, probe: snippet });
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

/**
 * ## How much of the corpus runs
 *
 * The full product below is 8 positions x 8 wrappers x 10 redirects x 7
 * branches x 6 groupings (26,880 cells) plus the heredoc delimiter corpus,
 * and the oracle forks a shell per cell: too slow for `npm test` on any Mac
 * anyone actually works on. So the default run keeps every position, every
 * branch and every grouping — those are the questions the oracle asks — and
 * crosses them with one representative per wrapper-grammar path and per
 * redirect clause, plus a heredoc-delimiter sample. That is 8 x 5 x 6 x 7 x 6
 * (10,080 cells) plus 120 heredoc cells (6 spellings x 2 `<<` forms x 2 gaps
 * x 5 placements): a few minutes anywhere.
 *
 * Wrapper representatives: `none` (the baseline), `timeout` (the only
 * operands:1 wrapper — it eats a bare operand), `assignment` (the only
 * non-program prefix), `xargs` (external, and the here-string rule keys off
 * it) and `sudo` (a short option with a separate value, external). Left out:
 * `time` (a bare transparent prefix, the same path as `none`), `env` (an
 * assignment after an operands:0 wrapper behaves the same under every such
 * wrapper, so `sudo` pins it) and `nice` (a short option with a value, the
 * same path as `sudo`).
 *
 * Redirect representatives: `none` (the baseline), `file` (the `>` operator
 * into a filename — the write boundary the witness is about), `devnull` (the
 * non-persisting device), `errfile` (a descriptor prefix into a real file),
 * `ampout` (the `&` descriptor prefix) and `arrowstring` (the `->`
 * exclusion). Left out: `append` (the same operator clause as `file`),
 * `errdevnull` (the descriptor-prefix and non-persisting clauses combined),
 * `fdone` (the same digit-prefix alternative as `errfile`) and `varfile`
 * (the same target-character class as `file`). Each of those runs in the full
 * mode below; none of them is a documented past defect on its own.
 *
 * Heredoc sample: one spelling per delimiter-quoting path (bare,
 * single-quoted, double-quoted, backslash-escaped, expansion-shaped bare and
 * quoted), crossed with both `<<` forms, both gaps and every placement. The
 * exotic spellings run in the full mode below.
 *
 * The complete product runs wherever `ACCORDO_FULL_SHELL_ORACLE=1` is set —
 * CI sets it, so Linux coverage is exactly what it was. A local full run is
 * legitimate but slow: give it its own timeout and never hold the shared
 * machine lock for it.
 *
 * The driver runs in every measurement: scripts/measure-suite.js forces
 * `ACCORDO_ORACLE_DRIVER=1` on every piece and count it runs (beside the
 * full flag for the complete product on the scheduled main measurement),
 * so no record can publish over skipped oracle tests. A direct `node
 * --test` run — the pre-push hook, the PR gate, a developer timing one
 * slice — never goes through the measurement and runs only the slices'
 * wiring (imports, corpus shape, counts — seconds): a skipped driver shows
 * as skipped, never as green.
 */
export const SHELL_ORACLE_FULL = process.env.ACCORDO_FULL_SHELL_ORACLE === '1';
/** One representative per wrapper-grammar path; every name must be a key of ORACLE_WRAPPERS. */
const SHELL_ORACLE_WRAPPER_SUBSET = ['none', 'timeout', 'assignment', 'xargs', 'sudo'];
/** One representative per redirect clause; every name must be a key of ORACLE_REDIRECTS. */
const SHELL_ORACLE_REDIRECT_SUBSET = ['none', 'file', 'devnull', 'errfile', 'ampout', 'arrowstring'];
/** One spelling per delimiter-quoting path; every entry must be in HEREDOC_DELIMITER_SPELLINGS. */
export const SHELL_ORACLE_HEREDOC_SPELLINGS = ['EOF', "'EOF'", '"EOF"', '\\EOF', '$X', "'$X'"];
export const SHELL_ORACLE_WRAPPERS = SHELL_ORACLE_FULL
  ? Object.keys(ORACLE_WRAPPERS)
  : SHELL_ORACLE_WRAPPER_SUBSET;
export const SHELL_ORACLE_REDIRECTS = SHELL_ORACLE_FULL
  ? Object.keys(ORACLE_REDIRECTS)
  : SHELL_ORACLE_REDIRECT_SUBSET;
for (const name of SHELL_ORACLE_WRAPPER_SUBSET) {
  assert.ok(
    Object.hasOwn(ORACLE_WRAPPERS, name),
    `SHELL_ORACLE_WRAPPER_SUBSET names ${JSON.stringify(name)}, which is not a wrapper axis value: `
    + 'a renamed value must fail here, not silently sample nothing',
  );
}
for (const name of SHELL_ORACLE_REDIRECT_SUBSET) {
  assert.ok(
    Object.hasOwn(ORACLE_REDIRECTS, name),
    `SHELL_ORACLE_REDIRECT_SUBSET names ${JSON.stringify(name)}, which is not a redirect axis value: `
    + 'a renamed value must fail here, not silently sample nothing',
  );
}
for (const spelling of SHELL_ORACLE_HEREDOC_SPELLINGS) {
  assert.ok(
    HEREDOC_DELIMITER_SPELLINGS.includes(spelling),
    `SHELL_ORACLE_HEREDOC_SPELLINGS names ${JSON.stringify(spelling)}, which is not a full-corpus delimiter: `
    + 'a renamed spelling must fail here, not silently sample nothing',
  );
}

/**
 * The whole corpus: one cross-product for command shape, one for heredoc shape.
 *
 * Sliced by grouping singleton for the six oracle test files (each about a
 * sixth of the cells, each in its own measure piece under the common maximum):
 * `groupings` names the grouping values this slice covers, `withHeredoc`
 * carries the heredoc/arithmetic cells (only one slice sets it, so no cell
 * runs twice). An unknown grouping name fails here, not as a silently
 * smaller corpus.
 *
 * @param {{ groupings?: string[], withHeredoc?: boolean }} [options]
 */
export function shellCorpus(options) {
  const { groupings = Object.keys(ORACLE_GROUPINGS), withHeredoc = true } = options ?? {};
  const wanted = new Set(groupings);
  for (const name of wanted) {
    assert.ok(
      Object.hasOwn(ORACLE_GROUPINGS, name),
      `shellCorpus: unknown grouping ${JSON.stringify(name)} — a renamed value must fail here, not silently slice nothing`,
    );
  }
  /** @type {Array<{ label: string, snippet: string, probe: string }>} */
  const cases = [];
  for (const [positionName, position] of Object.entries(ORACLE_POSITIONS)) {
    for (const wrapperName of SHELL_ORACLE_WRAPPERS) {
      const wrapper = ORACLE_WRAPPERS[wrapperName];
      for (const redirectName of SHELL_ORACLE_REDIRECTS) {
        const redirect = ORACLE_REDIRECTS[redirectName];
        const inner = `${position.lead}${wrapper}${position.head}${redirect.suffix}${position.tail}${redirect.after}`;
        for (const [branchName, branch] of Object.entries(ORACLE_BRANCHES)) {
          for (const [groupingName, grouping] of Object.entries(ORACLE_GROUPINGS)) {
            if (!wanted.has(groupingName)) continue;
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
  const heredoc = withHeredoc
    ? heredocCrossProduct(SHELL_ORACLE_FULL ? HEREDOC_DELIMITER_SPELLINGS : SHELL_ORACLE_HEREDOC_SPELLINGS)
    : [];
  return [...cases, ...heredoc];
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

  // The driver runs each snippet inside `env -i PATH="$bin:/usr/bin:/bin"`, so the oracle sees
  // whatever userland the host ships. CI is GNU; macOS is not, and the difference does not make
  // the oracle fail — it makes it answer a different question while still looking like data:
  //   - macOS has no timeout(1), so every snippet failed to start, the sandbox stayed empty,
  //     and the oracle reported that nothing in the corpus writes anything;
  //   - BSD xargs does not run its command on empty input while GNU xargs does, so every
  //     xargs-wrapped invocation looked like it was never in command position.
  // Each tool is chosen by the behaviour the oracle depends on, never by its name, and a host
  // that cannot supply it is refused by name instead of silently answering the wrong question.
  const shimGnuTool = (name, candidates, behaves, requirement) => {
    for (const candidate of candidates) {
      const path = spawnSync('command', ['-v', candidate], { encoding: 'utf8', shell: true }).stdout?.trim();
      if (path && behaves(path)) {
        writeFileSync(join(bin, name), `#!/bin/sh\nexec ${path} "$@"\n`);
        chmodSync(join(bin, name), 0o755);
        return;
      }
    }
    assert.fail(requirement);
  };
  shimGnuTool(
    'timeout', ['timeout', 'gtimeout'],
    (path) => spawnSync(path, ['1', 'true']).status === 0,
    'the oracle bounds each snippet with timeout(1) and no working timeout is on PATH; without one '
    + 'every snippet fails to start and the oracle reports zero writes. On macOS: brew install coreutils',
  );
  shimGnuTool(
    'xargs', ['gxargs', 'xargs'],
    (path) => spawnSync(path, ['echo', 'ok'], { input: '', encoding: 'utf8' }).stdout?.trim() === 'ok',
    'the corpus wraps invocations in xargs and expects GNU semantics: the command runs once even on '
    + 'empty input. BSD xargs skips it, which reads as "not in command position" for every wrapped '
    + 'case. On macOS: brew install findutils',
  );

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
    // 40 minutes, not 20: the driver takes about 13 on an idle machine and exceeded 20 inside a
    // full `npm run verify`, where it competes with the rest of the suite. A budget tight enough
    // to depend on what else is running turns a load spike into a repository defect.
    { encoding: 'utf8', timeout: 40 * 60_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  // `status` is null when the driver was killed rather than exited — on timeout, spawnSync leaves
  // stderr empty, so `the oracle driver failed:` with nothing after it read as a driver defect
  // when the driver had simply been stopped. Say which of the two happened.
  assert.ok(
    result.status === 0,
    result.status === null
      ? 'the oracle driver was killed before it finished, most likely by its own 40-minute budget '
        + `under a loaded machine (signal ${String(result.signal)}); the corpus was not compared`
      : `the oracle driver failed with status ${String(result.status)}: ${result.stderr}`,
  );

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

/**
 * Drive one corpus slice against bash and assert the classifier agrees on
 * every cell. This is the body the three oracle slices share: the slice
 * files only choose their grouping pairs and their heredoc minimum.
 *
 * @param {Array<{ label: string, snippet: string, probe: string }>} corpus
 * @param {{ repoRoot: string, expectedCells: number, minHeredocCells: number }} options
 */
export function assertShellOracleAgreement(corpus, { repoRoot, expectedCells, minHeredocCells }) {
  const surface = readAccordoSurface(repoRoot);
  assert.equal(
    spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' }).stdout?.trim(), 'ok',
    'this property is checked against a real shell; without one there is no oracle, and a '
    + 'skipped oracle is how the last three rounds of this defect stayed green',
  );

  // The size is asserted against the product of the axes rather than against a number
  // somebody typed, so removing a value from an axis fails here instead of quietly
  // shrinking what is checked.
  // The active product, not the full one: in default mode the wrapper and
  // redirect lists are the documented subset, and the full mode carries the
  // heredoc min-corpus on top — so the bound is "at least", never "exactly".
  assert.ok(
    corpus.length >= expectedCells,
    `the corpus generated ${corpus.length} texts and the axes alone are ${expectedCells}; an axis has been dropped`,
  );
  // The heredoc sample rides on top of the axis product, so the bound above cannot
  // see it go missing: a dropped heredoc wiring still clears `>=`. The sample list
  // is validated against the full list at load; this pins the carried count to the
  // active list, so removing the sample fails here too. A slice that carries no
  // heredoc cells must carry exactly none: otherwise a cell runs in two slices.
  const heredocCells = corpus.filter((entry) => entry.label.startsWith('heredoc-delim/')).length;
  if (minHeredocCells === 0) {
    assert.equal(heredocCells, 0, `this slice must carry no heredoc cells, found ${heredocCells}: a cell would run twice`);
  } else {
    assert.ok(
      heredocCells >= minHeredocCells,
      `the corpus carries ${heredocCells} heredoc cells against a ${minHeredocCells}-entry delimiter list; the heredoc wiring has been dropped`,
    );
  }

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
    assert.ok(compared >= expectedCells, `only ${compared} texts were compared against the shell`);
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
}
