import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { awaitChildExit, CHILD_EXIT_HANG_GUARD_MS } from './helpers/child-exit.js';

// Guards the helper behind the MCP «exits on its own after stdin EOF» tests
// (backlog:f835b90af9ad): the cause of the exit is read from the `exit` event, and a
// child that never exits still fails by name (the guard is not weakened into a pass).

function fakeChild(source) {
  const child = spawn(process.execPath, ['--no-warnings', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.end('{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}\n');
  return child;
}

test('a child that exits on its own after stdin EOF resolves with code 0 and no signal', async () => {
  const child = fakeChild("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  assert.deepEqual(await awaitChildExit(child, { label: 'eof-exit' }), { code: 0, signal: null, signalSent: null });
});

test('a child that ignores stdin EOF and never exits is red, named by its label', async () => {
  // Reads stdin, ignores EOF, stays alive on a timer: the shape of a hung MCP.
  const child = fakeChild("process.stdin.resume(); process.stdin.on('end', () => {}); setInterval(() => {}, 1_000);");
  await assert.rejects(
    awaitChildExit(child, { label: 'hung-mcp-fake', hangGuardMs: 500, diagnostics: () => 'stderr-tail' }),
    /^Error: hung-mcp-fake: child never exited within the 500 ms hang guard \(killed with SIGKILL; exit null, signal SIGKILL\): stderr-tail$/,
  );
  assert.equal(child.signalCode, 'SIGKILL', 'the hang guard leaves no process behind');
});

test('an exit caused by a signal from outside is reported, not mistaken for a clean exit', async () => {
  const child = fakeChild('setInterval(() => {}, 1_000);');
  setImmediate(() => child.kill('SIGTERM'));
  assert.deepEqual(await awaitChildExit(child, { label: 'external-signal' }), { code: null, signal: 'SIGTERM', signalSent: null });
});

test('the hang guard is a safety cap well below the 600 s per-file ceiling, not a speed budget', () => {
  assert.ok(CHILD_EXIT_HANG_GUARD_MS >= 60_000, 'a guard this short would be a speed requirement under load');
  assert.ok(CHILD_EXIT_HANG_GUARD_MS * 2 < 600_000, 'two hung children in one file must still fail before the per-file ceiling');
});
