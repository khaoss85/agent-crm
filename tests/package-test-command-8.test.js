import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageTestCommand } from '../packages/cli/src/package-test-command.js';
import {
  AUTHORITIES, runCompositionChecks, runDeclarationChecks,
} from '../packages/cli/src/package-test-checks.js';
import { importSpecifiers, importsPrivateKernelPath, stripComments } from '../packages/cli/src/package-sources.js';
import {
  HANGS, HOSTILE_PACKAGES, SCRATCH_PROBES, SPAWNS_LONG_LIVED_CHILD, WELL_FORMED, consumer,
  fixtureProject, manifestFor, provider, writeFixturePackage,
} from './helpers/package-test-fixtures.js';

/**
 * `crm package test` — DX4.
 *
 * The command answers one question: does a package satisfy the framework's
 * generic package contract and integration invariants? These tests hold it to
 * three standards.
 *
 * **It must be honest.** A check that cannot run reports `skipped` or
 * `not_applicable` with a reason, never `passed`. Nothing here may be made
 * green by demoting a failure to a limitation.
 * **It must be deterministic.** The same package produces byte-identical JSON
 * across runs, processes, working directories and paths containing spaces.
 * **It must be safe.** The caller's project is never written to, the scratch
 * copy is always removed, and no absolute path reaches the report.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const run = (packagePath, options = {}) =>
  packageTestCommand({ packagePath, rootDir: repoRoot, capture: true, ...options });

/** The three first-party packages, which conform. */
const OFFICIAL = [
  ['packages/contracts', 'contracts'],
  ['packages/delivery', 'delivery'],
  ['packages/service', 'service'],
];

test('a forged, doubled or truncated child report never becomes a conformance answer', async (t) => {
  const { runReportingChild } = await import('../packages/cli/src/child-report.js');
  const loaderFor = (t2, body) => {
    const dir = mkdtempSync(join(tmpdir(), 'accordo-loader-'));
    t2.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'loader.mjs');
    writeFileSync(file, body);
    return file;
  };

  // Two JSON documents on fd 3: the concatenation is not valid JSON, so it is
  // refused rather than half-parsed into a verdict.
  const doubled = await runReportingChild({
    loader: loaderFor(t, `import { writeSync } from 'node:fs';
writeSync(3, JSON.stringify({ read: true, package: { name: 'forged' } }) + '\\n');
writeSync(3, JSON.stringify({ read: true, package: { name: 'second' } }) + '\\n');
`),
  });
  assert.equal(doubled.report, null);
  assert.match(doubled.diagnostic, /not valid JSON/);

  // A truncated document is refused, not repaired.
  const truncated = await runReportingChild({
    loader: loaderFor(t, `import { writeSync } from 'node:fs';
writeSync(3, '{"read": true, "package": {"name": "trunc');
`),
  });
  assert.equal(truncated.report, null);
  assert.match(truncated.diagnostic, /not valid JSON/);

  // Nothing at all on fd 3 is a stated outcome, not an empty pass.
  const silent = await runReportingChild({ loader: loaderFor(t, 'process.exitCode = 0;\n') });
  assert.equal(silent.report, null);
  assert.ok(silent.diagnostic.trim().length > 0);

  // stdout is not the report channel: a package printing a whole JSON document
  // to stdout cannot become the answer.
  const impostor = await runReportingChild({
    loader: loaderFor(t, `console.log(JSON.stringify({ read: true, package: { name: 'impostor' } }));\n`),
  });
  assert.equal(impostor.report, null, 'stdout is package noise, never the contract');
  assert.match(impostor.noise, /impostor/, 'and it is returned as noise instead');
  assert.ok(t);
});

/**
 * REGRESSION (Wave 2A) — the reporting child settles on **exit**, and the drain
 * window is what makes that safe.
 *
 * `close` arrives only when every copy of the pipe is gone, so a grandchild the
 * package spawned holds it for as long as it lives and the run waits out its
 * whole timeout on a process that finished in milliseconds. Settling on `exit`
 * fixes that and creates the opposite risk: a report written immediately before
 * the process exits must still be collected. Both halves are pinned here.
 */
test('a reporting child settles on exit, and what it wrote just before exiting still arrives', async (t) => {
  const { runReportingChild } = await import('../packages/cli/src/child-report.js');
  const loaderFor = (body) => {
    const dir = mkdtempSync(join(tmpdir(), 'accordo-drain-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, 'loader.mjs');
    writeFileSync(file, body);
    return file;
  };

  // 1 · report written and the process exits in the same tick: the drain window
  //     is the only thing that collects it.
  const raced = await runReportingChild({
    loader: loaderFor(`import { writeSync } from 'node:fs';
writeSync(3, JSON.stringify({ read: true, package: { name: 'raced' } }));
process.exit(0);
`),
    timeoutMs: 10_000,
  });
  assert.equal(raced.report?.package?.name, 'raced', 'a report written immediately before exit is not lost');

  // 2 · a grandchild inherits fd 3 and never lets go. The reporting process has
  //     exited and its report is complete, so the run must not wait for the
  //     pipe to close.
  const started = Date.now();
  const leakyLoader = loaderFor(`import { writeSync } from 'node:fs';
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 1, 2, 3] }).unref();
writeSync(3, JSON.stringify({ read: true, package: { name: 'leaked' } }));
process.exit(0);
`);
  const leaked = await runReportingChild({ loader: leakyLoader, timeoutMs: 20_000 });
  const elapsed = Date.now() - started;
  assert.equal(leaked.report?.package?.name, 'leaked', 'the report survives the leak');
  assert.ok(elapsed < 15_000, `settled on exit rather than on the pipe closing (${elapsed}ms)`);
  // And the pipes are released, not merely stopped being read. An open stream
  // is a ref'd handle: without this the promise resolved in 300ms and the
  // process that called it could never exit, so `crm package test` printed its
  // report and hung — and DX5's package stage, which spawns that command, saw a
  // conforming package as a fifteen-minute timeout.
  const child = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', `
    import { runReportingChild } from ${JSON.stringify(join(repoRoot, 'packages/cli/src/child-report.js'))};
    const r = await runReportingChild({ loader: ${JSON.stringify(leakyLoader)}, timeoutMs: 20000 });
    process.stdout.write(JSON.stringify(r.report));
  `], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(child.signal, null, 'the calling process exits on its own; it is not killed by the timeout');
  assert.equal(child.status, 0);
  assert.match(child.stdout, /leaked/);

  // 3 · a process that exits before writing anything is a stated outcome, never
  //     an empty pass.
  const early = await runReportingChild({
    loader: loaderFor('process.exit(0);\n'),
    timeoutMs: 10_000,
    hints: { empty: 'No report was produced.' },
  });
  assert.equal(early.report, null);
  assert.match(early.diagnostic, /No report was produced/);
});

test('a package applies its manifests reference-targets first, whatever the alphabet says', async () => {
  // `quote-term.module.json` sorts BEFORE `quote.module.json`, and its
  // `quoteId` reference targets the `quotes` table — applied alphabetically
  // the factory refuses it ("apply the target module first"). The order must
  // honour the rail's own doctrine: a manifest is never applied before the
  // records its foreign keys point at.
  const { packageManifests } = await import('../packages/cli/src/package-test-project.js');
  const order = packageManifests(join(repoRoot, 'packages/commercial')).map((path) => path.split('/').pop());
  const quote = order.indexOf('quote.module.json');
  const quoteTerm = order.indexOf('quote-term.module.json');
  assert.ok(quote !== -1 && quoteTerm !== -1, `both manifests are listed: ${order.join(', ')}`);
  assert.ok(quote < quoteTerm, `quote must apply before quote-term (got: ${order.join(', ')})`);
  // And the order stays a permutation of the alphabetical set — nothing is
  // dropped or invented by the dependency pass.
  assert.deepEqual([...order].sort(), readdirSync(join(repoRoot, 'packages/commercial/modules')).filter((name) => name.endsWith('.module.json')).sort());
});

/**
 * The boundary rules read **code**, not prose.
 *
 * Both rules are regular expressions over source text, and the customer-data
 * package caught them being wrong in both directions at once. A doc comment
 * that writes a path in backticks after the word "from" — *"the signer policy
 * from `packages/signature/src/operations.js`"* — was matched as an import, and
 * a conforming package failed conformance for the sentence that explained why
 * it was conforming. That is a false accusation from an authority: worse than a
 * missed one, and unfixable except by deleting the explanation.
 *
 * Stripping comments naively invents the opposite bug, so these hold both ends:
 * a `//` inside a string or a regular expression must not blind the scanner to
 * the imports that follow it.
 */
test('a path written in a comment is not an import, and a path in code still is', () => {
  const commented = [
    '// see packages/signature/src/operations.js for the signer policy',
    '/**',
    ' * Reuses the control-character policy from `packages/signature/src/operations.js`,',
    ' * and the date rules from "packages/contracts/src/dates.js".',
    ' */',
    "import { thing } from '../../core/index.js';",
    'export const value = thing;',
  ].join('\n');
  assert.deepEqual(importSpecifiers(commented), ['../../core/index.js'],
    'prose is prose, however it is punctuated');
  assert.equal(importsPrivateKernelPath('// do not import from `packages/core/src/database.js`'), false);

  const real = "import { x } from '../../signature/src/operations.js';";
  assert.deepEqual(importSpecifiers(real), ['../../signature/src/operations.js']);
  assert.equal(importsPrivateKernelPath("import { d } from '../../core/src/database.js';"), true);
  assert.equal(importsPrivateKernelPath("const d = await import('../../core/src/database.js');"), true);
});

test('stripping comments never swallows a string or a regular expression', () => {
  const tricky = [
    "const url = 'https://example.test/a//b';",
    'const pattern = /https?:\\/\\/[^ ]+/g;',
    'const template = `a // not a comment ${url}`;',
    "import { after } from '../../delivery/src/thing.js';",
  ].join('\n');
  assert.deepEqual(importSpecifiers(tricky), ['../../delivery/src/thing.js'],
    'an import after a URL, a regex or a template must still be seen');

  const stripped = stripComments(tricky);
  assert.ok(stripped.includes('https://example.test/a//b'), 'a URL in a string survives');
  assert.ok(stripped.includes('a // not a comment'), 'a template literal survives');
  assert.equal(stripComments('a; /* b */ c;').split('\n').length, 1, 'line structure is preserved');
  assert.equal(stripComments('a\n// x\nb').split('\n').length, 3);
});

/**
 * Review finding, added rather than found broken: this scanner is a hand-rolled
 * lexer sitting *inside* a conformance authority, so the question is not
 * whether it parses JavaScript but what it does when it is wrong. Only the two
 * comment branches replace anything — every string, template and regular
 * expression is copied through verbatim — so a mis-lex can raise a false
 * accusation but can never hide a real violation. These are the inputs designed
 * to blind it, and the rule they pin is that direction.
 */
test('a mis-lex can only over-report: no construct hides a real kernel import', () => {
  const violation = "import { x } from '../../core/src/kernel.js';";
  const decoys = [
    ["a URL string", "const u = 'https://x.test//y';"],
    ['a regex holding escaped slashes', 'const re = /a\\/\\/b/g;'],
    ['a regex character class holding quotes', "const re = /['\"\\/]/;"],
    ['a chain of divisions', 'const n = a / b / c;'],
    ['an apostrophe inside a line comment', "// don't do this"],
    ['a template with a nested expression and a slash pair', "const s = `a ${b ? 'c' : 'd'} //e`;"],
    ['a nested template literal', 'const s = `a ${`b`} c`;'],
    ['a string holding a block-comment opener', "const s = '/*';"],
    ['a trailing comment on a code line', 'const a = 1; // note'],
    ['a regex that never closes on its line', 'const re = /abc'],
  ];
  for (const [what, decoy] of decoys) {
    assert.equal(importsPrivateKernelPath(`${decoy}\n${violation}`), true,
      `${what} must not blind the scanner to the import on the next line`);
    assert.deepEqual(importSpecifiers(`${decoy}\n${violation}`), ['../../core/src/kernel.js'],
      `${what} must not swallow the specifier either`);
  }

  // And the other direction still holds: prose is prose, in either comment form.
  assert.equal(importsPrivateKernelPath(`/* import { x } from '../../core/src/kernel.js'; */`), false);
  assert.equal(importsPrivateKernelPath(`// import { x } from '../../core/src/kernel.js';`), false);
});
