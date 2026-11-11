import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fileMaxSecFrom } from '../scripts/measure-piece-runner.js';
import {
  assertSyncChildExited, awaitChildExit, FILE_HANG_BUDGET_MS, hangGuardMs, trackSignals,
} from './helpers/child-exit.js';

// Guards the helper behind the MCP «exits on its own after stdin EOF» tests
// (backlog:f835b90af9ad): the cause of the exit is read from the child's events,
// the signals the test sent are reported, output is complete when the wait ends,
// and a child that never exits still fails by name within one budget per file.

const helperUrl = new URL('./helpers/child-exit.js', import.meta.url).href;

function fakeChild(source) {
  const child = spawn(process.execPath, ['--no-warnings', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
  return child;
}

test('a child that exits on its own after stdin EOF resolves with code 0, no signal, none sent', async () => {
  const child = fakeChild("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  assert.deepEqual(await awaitChildExit(child, { label: 'eof-exit' }), { code: 0, signal: null, signalSent: null });
});

test('a child that ignores stdin EOF and never exits is red, named by its label', async () => {
  // Reads stdin, ignores EOF, stays alive on a timer: the shape of a hung MCP.
  const child = fakeChild("process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1_000);");
  await assert.rejects(
    awaitChildExit(child, { label: 'hung-mcp-fake', hangGuardMs: 500, diagnostics: () => 'stderr-tail' }),
    /^Error: hung-mcp-fake: child never exited within its 500 ms hang guard .*killed with SIGKILL; exit null, signal SIGKILL\): stderr-tail$/,
  );
  assert.equal(child.signalCode, 'SIGKILL', 'the hang guard leaves no process behind');
});

test('signalSent reports the signal the test sent, so «none sent» is a real claim', async () => {
  const child = trackSignals(fakeChild("process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1_000);"));
  await new Promise((resolve) => child.stdout.once('data', resolve)); // handler installed
  child.kill('SIGTERM');
  // The child handled SIGTERM and exited 0: without signalSent this would look like a clean exit.
  assert.deepEqual(await awaitChildExit(child, { label: 'sent-sigterm' }), { code: 0, signal: null, signalSent: 'SIGTERM' });
});

test('a signal from outside the test is reported as the cause, and not as sent by the test', async () => {
  const child = fakeChild('setInterval(() => {}, 1_000);');
  const wait = awaitChildExit(child, { label: 'external-signal' });
  process.kill(child.pid, 'SIGTERM');
  assert.deepEqual(await wait, { code: null, signal: 'SIGTERM', signalSent: null });
});

test('output read after the wait is complete: the wait ends on close, not on exit', async () => {
  // The child exits at once, but a grandchild it leaves behind holds the same stdout and
  // writes a moment later: 'exit' fires before that output arrives, 'close' only after
  // the pipe is drained. The delay only makes the old 'exit' wait miss the line; the
  // 'close' wait sees it however long the grandchild takes.
  const grandchild = "setTimeout(() => process.stdout.write('late'), 500);";
  const child = spawn(process.execPath, ['-e', `
    const { spawn } = require('node:child_process');
    process.stdout.write('early ');
    spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 'inherit', 'inherit'] }).unref();
    process.exit(0);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  assert.deepEqual(await awaitChildExit(child, { label: 'late-output' }), { code: 0, signal: null, signalSent: null });
  assert.equal(stdout, 'early late', 'stdout read after the wait was truncated');
});

test('a child whose output nobody reads still ends the wait', async () => {
  const child = spawn(process.execPath, ['-e', "process.stdout.write('x'.repeat(1024 * 1024));"], { stdio: ['ignore', 'pipe', 'pipe'] });
  assert.deepEqual(await awaitChildExit(child, { label: 'unread-output' }), { code: 0, signal: null, signalSent: null });
});

test('awaiting a child that has already closed resolves at once with its cause', async () => {
  const child = trackSignals(fakeChild('setInterval(() => {}, 1_000);'));
  child.kill('SIGKILL');
  await awaitChildExit(child, { label: 'first' });
  assert.deepEqual(await awaitChildExit(child, { label: 'again' }), { code: null, signal: 'SIGKILL', signalSent: 'SIGKILL' });
});

test('a spawnSync child that never exits is red by name, one that exits is untouched', () => {
  const hung = spawnSync(process.execPath, ['-e', 'setInterval(() => {}, 1_000);'], { encoding: 'utf8', timeout: 500 });
  assert.throws(() => assertSyncChildExited(hung, 'hung-cli-fake'), /^Error: hung-cli-fake: child never exited within the hang guard .*killed with SIGTERM\)/);
  const done = spawnSync(process.execPath, ['-e', 'process.exit(3)'], { encoding: 'utf8', timeout: hangGuardMs() });
  assert.doesNotThrow(() => assertSyncChildExited(done, 'exits'));
  assert.equal(done.status, 3);
});

test('the hang budget is one deadline per file, 80% of the measure ceiling, shrinking as the file runs', () => {
  assert.equal(FILE_HANG_BUDGET_MS, fileMaxSecFrom(process.env) * 800, '80% of the per-file ceiling (480 s of the default 600 s)');
  const first = hangGuardMs();
  assert.ok(first > 0 && first < FILE_HANG_BUDGET_MS, 'what is left, never the full budget again');
  const busyUntil = Date.now() + 50;
  while (Date.now() < busyUntil) { /* spend 50 ms of the file */ }
  assert.ok(hangGuardMs() <= first - 45, 'each wait gets only what earlier waits left');
});

test('several hung waits in one file all fail before the per-file ceiling, not one budget each', () => {
  // A file under a 6 s ceiling with three children that never exit, awaited one after
  // another: with a guard per wait they would need more than the ceiling; with one
  // deadline per file all three fail, by name, inside 80% of it.
  const script = `
    import { spawn } from 'node:child_process';
    import { awaitChildExit } from ${JSON.stringify(helperUrl)};
    const errors = [];
    for (const name of ['first', 'second', 'third']) {
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000);'], { stdio: 'ignore' });
      try { await awaitChildExit(child, { label: name }); } catch (error) { errors.push(error.message.split(':')[0]); }
    }
    console.log(JSON.stringify({ errors, elapsedMs: Math.round(performance.now()) }));
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', timeout: hangGuardMs(), env: { ...process.env, MEASURE_FILE_MAX_SEC: '6' },
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  assertSyncChildExited(run, 'budget probe');
  assert.equal(run.status, 0, run.stderr);
  const { errors, elapsedMs } = JSON.parse(run.stdout);
  assert.deepEqual(errors, ['first', 'second', 'third']);
  assert.ok(elapsedMs < 6_000, `three hung waits took ${elapsedMs} ms, past the 6 s ceiling`);
});
