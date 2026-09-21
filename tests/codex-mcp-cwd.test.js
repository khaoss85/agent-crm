import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Codex launches the project MCP server from the process cwd (the repository
 * root for `codex exec` and factory worktrees), not from `.codex/`.
 * `.codex/config.toml` `cwd = ".."` was written as if it were config-relative
 * (one up from `.codex/` = project root). Resolved against the process cwd it
 * is the parent of the repository, `packages/mcp/bin/server.js` is not there,
 * node exits, and the handshake is `connection closed`.
 *
 * This file is the sanitised reproducer: spawn the configured command the way
 * Codex does from the repository root, and require initialize to answer.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

function accordoStdioLaunch(toml) {
  const lines = [];
  let inTable = false;
  for (const line of toml.split(/\r?\n/)) {
    if (/^\[mcp_servers\.accordo\]\s*$/.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && /^\[/.test(line)) break;
    if (inTable) lines.push(line);
  }
  assert.ok(lines.length > 0, '.codex/config.toml must declare [mcp_servers.accordo]');
  const body = `${lines.join('\n')}\n`;
  const command = body.match(/^command = "([^"]+)"/m)?.[1];
  const argsMatch = body.match(/^args = \[([^\]]*)\]/m);
  const cwd = body.match(/^cwd = "([^"]*)"/m)?.[1];
  assert.ok(command, 'accordo MCP must name a command');
  assert.ok(argsMatch, 'accordo MCP must name args');
  const args = [...argsMatch[1].matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  return { command, args, cwd };
}

test('Codex MCP cwd from the repository root locates the server and answers initialize', { timeout: 20_000 }, async (t) => {
  const config = readFileSync(join(repoRoot, '.codex/config.toml'), 'utf8');
  const launch = accordoStdioLaunch(config);
  assert.ok(launch.cwd, 'accordo MCP declares cwd — an omitted cwd would already be the process cwd');

  // Codex 0.155.1 stores `cwd: ..` and launches relative to the process cwd,
  // which for `codex exec` from the project is the repository root — not
  // `.codex/`. That is the resolution this test uses.
  const processCwd = repoRoot;
  const serverCwd = isAbsolute(launch.cwd) ? launch.cwd : resolve(processCwd, launch.cwd);
  const script = launch.args.find((arg) => arg.endsWith('server.js'));
  assert.ok(script, 'accordo MCP args must name the stdio server');

  const resolvedScript = isAbsolute(script) ? script : join(serverCwd, script);
  assert.equal(
    existsSync(resolvedScript),
    true,
    `Codex cwd ${launch.cwd} resolved from the repository root to ${serverCwd}, which does not contain ${script}`,
  );

  const dataDir = mkdtempSync(join(tmpdir(), 'accordo-codex-mcp-cwd-'));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const child = spawn(launch.command === 'node' ? process.execPath : launch.command, launch.args, {
    cwd: serverCwd,
    env: { ...process.env, CRM_DB_PATH: join(dataDir, 'accordo.sqlite') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'codex-mcp-cwd', version: '1' },
    },
  })}\n`);

  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`MCP handshake hung: ${stderr || stdout}`));
    }, 15_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0, stderr || `spawn exited ${exitCode}`);
  const line = stdout.trim().split('\n').find(Boolean);
  assert.ok(line, `initialize produced no JSON-RPC line (stderr: ${stderr})`);
  const response = JSON.parse(line);
  assert.equal(response.result.serverInfo.name, 'accordo');
});
