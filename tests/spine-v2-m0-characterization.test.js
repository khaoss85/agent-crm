// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createMcpServer } from '../packages/mcp/src/index.js';
import { CORE_MIGRATIONS_FOR_CHARACTERIZATION } from '../packages/core/src/database.js';
import createWorkPackage from '../packages/work/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'packages/cli/bin/accordo.js');
const mcpBin = join(root, 'packages/mcp/bin/server.js');
const actor = { type: 'user', id: 'spine-v2-characterization' };
const MCP_TOOL_NAMES = [
  'crm_create_opportunity', 'crm_decide_approval', 'crm_doctor', 'crm_get_trace',
  'crm_list_approvals', 'crm_list_opportunities', 'crm_project_context',
  'crm_request_stage_change', 'crm_scaffold_module',
];

function assertMigrated(dbPath, label) {
  assert.equal(existsSync(dbPath), true, `${label} creates its fresh SQLite database`);
  const database = new DatabaseSync(dbPath);
  try {
    const migrations = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all();
    const baselineMigrations = [
      { version: 1, name: 'initial_crm_schema' },
      { version: 2, name: 'opportunity_source_key' },
      { version: 3, name: 'opportunity_pipeline_state' },
      { version: 4, name: 'definition_versions' },
      { version: 5, name: 'production_spine_identity' },
    ];
    assert.deepEqual(
      migrations.slice(0, baselineMigrations.length).map((row) => ({ ...row })),
      baselineMigrations,
      `${label} preserves and applies the complete released M0 migration prefix`,
    );
    assert.ok(migrations.length >= baselineMigrations.length, `${label} may append only forward migrations`);
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    const tableNames = new Set(tables.map(({ name }) => name));
    for (const name of [
      'approvals', 'audit_events', 'companies', 'contacts', 'definition_versions',
      'module_migrations', 'opportunities', 'schema_migrations', 'spine_memberships',
      'spine_organizations', 'trace_spans', 'workflow_runs',
    ]) assert.equal(tableNames.has(name), true, `${label} retains M0 table ${name}`);
  } finally {
    database.close();
  }
}

test('M0 pins the released core migration SQL checksums', () => {
  const migrations = CORE_MIGRATIONS_FOR_CHARACTERIZATION
    .filter(({ version }) => version <= 5)
    .map(({ plane, version, name, sql }) => ({
      plane, version, name, checksum: createHash('sha256').update(sql).digest('hex'),
    }));
  assert.deepEqual(migrations, [
    { plane: 'data', version: 1, name: 'initial_crm_schema', checksum: '2d386db73f44bc6da6e76942ba8dba2ee37d6799e5442e9c894d035848a2555e' },
    { plane: 'data', version: 2, name: 'opportunity_source_key', checksum: 'deed722482124ab96deb2f884ab4e0fb9308318f9411cc8b67e1bf5552d0093a' },
    { plane: 'data', version: 3, name: 'opportunity_pipeline_state', checksum: 'fccd2e6dd49aa73245b301b08bfc7f4dc167e7154a24cd5c56fcb66e444a8c6b' },
    { plane: 'data', version: 4, name: 'definition_versions', checksum: 'f2b4daf5f0dbee756ae2b04087c28c0debafcfe474fb78f976ac1dfdfde744a8' },
    { plane: 'control', version: 5, name: 'production_spine_identity', checksum: 'dd5ab2cc2a946e2f573bd1536952e18974c19a776b71074f4335602a47cc04fc' },
  ]);
});

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
    createdAtIsUtc: Number.isFinite(Date.parse(row.created_at)) && new Date(row.created_at).toISOString() === row.created_at,
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
  assert.equal(
    Object.hasOwn(work.capabilities[0], 'capabilityContract'),
    false,
    'the current synchronous capability declaration predates capabilityContract',
  );
  const opened = work.capabilities[0].create({
    modules: { get: () => ({ service: { listWhere: () => [] } }) },
  });
  assert.deepEqual(Object.keys(opened).sort(), ['createFollowUp', 'findBySourceKey']);
  const exactRead = opened.findBySourceKey('m0:missing');
  assert.equal(exactRead, null);
  assert.equal(typeof exactRead?.then, 'undefined', 'v1 capability exact reads are synchronous');
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
  const rawNames = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(rawNames, MCP_TOOL_NAMES, 'discovery has no missing or duplicate tool names');
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

test('M0 freezes the MCP stdio executable composition and JSON-line transport', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'accordo-spine-v2-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'm0-stdio', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((message) => JSON.stringify(message)).join('\n') + '\n';
  const run = spawnSync(process.execPath, ['--no-warnings', mcpBin], {
    cwd: directory, input, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const responses = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(responses.map(({ id }) => id), [1, 2]);
  assert.equal(responses[0].result.serverInfo.name, 'accordo');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name).sort(), MCP_TOOL_NAMES);
  assertMigrated(join(directory, 'data/accordo.sqlite'), 'MCP stdio');
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
    const receipt = JSON.parse(run.stdout);
    assert.equal(typeof receipt, 'object', `${command} writes one JSON object`);
    if (command === 'db:migrate') assert.equal(receipt.ok, true);
    if (command === 'seed') assert.ok(receipt.company?.id);
    if (command === 'demo') {
      assert.ok(receipt.seeded?.company?.id);
      assert.equal(receipt.results?.length, 2);
    }
    if (command === 'doctor') assert.equal(receipt.ok, true);
    if (command === 'workflow:list' || command === 'trace:list') assert.ok(Array.isArray(receipt.items));
    assertMigrated(dbPath, command);
  }

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
  const advertised = stdout.match(/Accordo running at (http:\/\/[^\s]+)/)?.[1];
  assert.ok(advertised, stdout);
  const response = await fetch(`${advertised}/api/schema`, { signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).generatedResourceContract, 1);
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
  assertMigrated(servePath, 'serve');
});
