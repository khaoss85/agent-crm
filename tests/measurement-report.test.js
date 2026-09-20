import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assertMeasurementUnchanged, parseMeasurementReport } from '../scripts/measurement-report.js';

const measurer = fileURLToPath(new URL('../scripts/measure-suite.js', import.meta.url));
const counts = (passed = 2) => ({ tests: passed + 2, suites: 1, passed, failed: 0, cancelled: 0, skipped: 1, todo: 1 });
const summary = (file, passed = 2) => ({ measurementSummary: 1, success: true, counts: counts(passed), ...(file ? { file } : {}) });
const encode = (rows) => rows.map((row) => JSON.stringify(row)).join('\n') + '\n';

test('summary map uses runner passed counts, not total including skips and todo', () => {
  const report = parseMeasurementReport(encode([summary('/repo/tests/a.test.js'), summary()]), '/repo', ['tests/a.test.js']);
  assert.deepEqual(report, { pass: 2, fail: 0, files: { 'tests/a.test.js': { tests: 2 } } });
});

test('summary parser refuses missing, extra, duplicate, red, truncated and inconsistent reports', () => {
  const file = summary('/repo/tests/a.test.js');
  for (const rows of [
    [file], [summary()], [file, file, summary()],
    [summary('/repo/tests/unknown.test.js'), summary()],
    [{ ...file, success: false }, summary()],
    [{ ...file, counts: { ...file.counts, cancelled: 1 } }, summary()],
    [file, summary(undefined, 3)], [file, summary(), file],
  ]) {
    assert.throws(() => parseMeasurementReport(encode(rows), '/repo', ['tests/a.test.js']));
  }
  assert.throws(() => parseMeasurementReport(encode([file]) + '{', '/repo', ['tests/a.test.js']));
});

test('publishing refuses a changed head, dirty tree and failed git read', () => {
  for (const [head, status, code] of [['other', '', 0], ['same', ' M source.js', 0], ['same', '', 1]]) {
    assert.throws(() => assertMeasurementUnchanged((args) => ({ status: code, stdout: args[0] === 'rev-parse' ? head : status }), 'same'));
  }
});

function fixture(t, extra = '') {
  const root = mkdtempSync(join(tmpdir(), 'accordo-single-measure-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const run = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'measurement@example.invalid');
  git('config', 'user.name', 'measurement');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'tests'));
  mkdirSync(join(root, 'site'));
  writeFileSync(join(root, '.gitignore'), 'calls.log\n');
  writeFileSync(join(root, 'site/claims.json'), '{"measuredAgainst":{"note":"unchanged until proven"}}\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: {
    check: 'node --check tests/a.test.js', test: 'node --test --test-reporter=spec', verify: 'npm run check && npm test',
  } }));
  writeFileSync(join(root, 'tests/a.test.js'), `
import test, { describe, it } from 'node:test';
import { appendFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
appendFileSync('calls.log', 'a\\n');
describe('nested suite', () => { it('one pass', () => {}); it.skip('skip', () => {}); it.todo('todo'); });
test('parent test', async (t) => { await t.test('child', () => {}); });
${extra}
`);
  writeFileSync(join(root, 'tests/b.test.js'), "import test from 'node:test'; import { appendFileSync } from 'node:fs'; appendFileSync('calls.log', 'b\\n'); test('pass', () => {});\n");
  git('add', '-A'); git('commit', '--quiet', '-m', 'fixture');
  const sha = git('rev-parse', 'HEAD');
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = () => spawnSync(process.execPath, [measurer, '--apply'], { cwd: root, encoding: 'utf8', env });
  return { root, git, sha, run };
}

test('one real npm verify yields exact per-file counts without rerunning any file', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(readFileSync(join(f.root, 'site/claims.json'), 'utf8')).measuredAgainst;
  assert.equal(record.command, 'npm run verify');
  assert.equal(record.sha, f.sha.slice(0, 7));
  assert.equal(record.tests, 4);
  assert.deepEqual(record.files, { 'tests/a.test.js': { tests: 3 }, 'tests/b.test.js': { tests: 1 } });
  assert.deepEqual(readFileSync(join(f.root, 'calls.log'), 'utf8').trim().split('\n').sort(), ['a', 'b']);
});

for (const [name, extra] of [
  ['suite failure', "test('red', () => { throw new Error('intentional'); });"],
  ['dirty tree', "writeFileSync('uncommitted.txt', 'changed');"],
  ['moved HEAD', "execFileSync('git', ['commit', '--allow-empty', '--quiet', '-m', 'tip moved']);"],
]) {
  test(`full measurement records nothing after ${name}`, (t) => {
    const f = fixture(t, extra);
    const path = join(f.root, 'site/claims.json');
    const before = readFileSync(path, 'utf8');
    const result = f.run();
    assert.equal(result.status, 1, result.stderr);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
}
