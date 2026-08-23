// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createMcpServer } from '../packages/mcp/src/index.js';
import createWorkPackage from '../packages/work/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'packages/cli/bin/accordo.js');
const actor = { type: 'user', id: 'spine-v2-characterization' };

test('M0 freezes the synchronous SQLite composition and mixed sync/async service contract', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());

  assert.equal(typeof app.then, 'undefined', 'createAccordoApp returns an application, never a Promise');
  assert.equal(app.database.path, ':memory:');
  assert.equal(app.database.plane, 'combined');
  assert.equal(app.tenantBinding, null, 'the historical unbound SQLite composition remains explicit');

  const companyPromise = app.services.companies.create(
    { name: 'M0 Characterization', domain: 'M0.EXAMPLE' },
    { actor },
  );
  assert.equal(typeof companyPromise.then, 'function', 'writes retain their existing Promise contract');
  const company = await companyPromise;
  assert.equal(app.services.companies.get(company.id).domain, 'm0.example');
  assert.deepEqual(app.services.companies.list({ limit: 1 }).map(({ id }) => id), [company.id]);

  const audits = app.database.raw.prepare(
    `SELECT actor_type, actor_id, action, entity_type, entity_id, data_json, created_at
       FROM audit_events WHERE entity_id = ? ORDER BY created_at, id`,
  ).all(company.id);
  assert.deepEqual(audits.map((row) => ({
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    data: JSON.parse(row.data_json),
    createdAtIsUtc: /^\d{4}-\d{2}-\d{2}T.*Z$/.test(row.created_at),
  })), [
    {
      actorType: actor.type,
      actorId: actor.id,
      action: 'company.created',
      entityType: 'company',
      entityId: company.id,
      data: company,
      createdAtIsUtc: true,
    },
  ]);
});

test('M0 freezes package v1 as synchronous declaration and operation metadata', () => {
  const work = createWorkPackage();
  assert.equal(work.packageContract, 1);
  assert.equal(work.operations, undefined, 'Work v1 declares no application operations');
  assert.deepEqual(work.capabilities.map(({ name, version }) => ({ name, version })), [
    { name: 'follow-up', version: 1 },
  ]);
  assert.deepEqual(work.actions.map(({ name, actionContract }) => ({ name, actionContract })), [
    { name: 'complete', actionContract: 1 },
    { name: 'cancel', actionContract: 1 },
    { name: 'add-note', actionContract: 1 },
  ]);
});

test('M0 freezes current SQLite MCP discovery and mutation annotations', async (t) => {
  const app = createAccordoApp({ dbPath: ':memory:' });
  t.after(() => app.close());
  const mcp = createMcpServer({ app });
  const initialized = await mcp.handle({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'm0', version: '1' } },
  });
  assert.equal(initialized.result.serverInfo.name, 'accordo');
  const listed = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const expectedNames = [
    'crm_create_opportunity',
    'crm_decide_approval',
    'crm_doctor',
    'crm_get_trace',
    'crm_list_approvals',
    'crm_list_opportunities',
    'crm_project_context',
    'crm_request_stage_change',
    'crm_scaffold_module',
  ];
  const rawNames = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(rawNames, expectedNames, 'discovery has no missing or duplicate tool names');
  assert.equal(new Set(rawNames).size, rawNames.length, 'tool names are unique before dispatch lookup');
  const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
  for (const [name, tool] of tools) {
    const readOnly = ['crm_doctor', 'crm_get_trace', 'crm_list_approvals', 'crm_list_opportunities', 'crm_project_context'].includes(name);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: readOnly,
      destructiveHint: false,
      idempotentHint: readOnly,
      openWorldHint: false,
    }, name);
  }
  assert.equal(tools.get('crm_project_context').annotations.readOnlyHint, true);
  assert.equal(tools.get('crm_request_stage_change').annotations.readOnlyHint, false);
  assert.equal(tools.get('crm_scaffold_module').annotations.destructiveHint, false);
});

test('M0 freezes every application CLI command on SQLite, including serve shutdown', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-spine-v2-m0-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const command of ['db:migrate', 'seed', 'demo', 'doctor', 'workflow:list', 'trace:list']) {
    const dbPath = join(directory, `${command.replace(':', '-')}.sqlite`);
    const run = spawnSync(process.execPath, ['--no-warnings', cli, command, '--db', dbPath], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(run.status, 0, `${command}: ${run.stderr}`);
    assert.doesNotThrow(() => JSON.parse(run.stdout), `${command} writes one JSON document`);
  }

  const source = readFileSync(new URL('../packages/cli/src/commands.js', import.meta.url), 'utf8');
  assert.match(source, /new Set\(\['serve', 'seed', 'demo', 'doctor', 'db:migrate', 'workflow:list', 'trace:list'\]\)/);

  const servePath = join(directory, 'serve.sqlite');
  const child = spawn(process.execPath, ['--no-warnings', cli, 'serve', '--db', servePath, '--port', '0'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`serve did not start: ${stderr}`));
    }, 10_000);
    child.stdout.on('data', () => {
      if (!stdout.includes('Accordo running at')) return;
      clearTimeout(timeout);
      resolve(undefined);
    });
    child.once('exit', (code) => reject(new Error(`serve exited early (${code}): ${stderr}`)));
  });
  child.kill('SIGTERM');
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`serve did not stop after SIGTERM: ${stderr}`));
    }, 10_000);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  assert.equal(exitCode, 0, stderr);
  assert.match(stdout, /Database: .*serve\.sqlite/);
});
