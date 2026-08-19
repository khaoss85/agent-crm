// @ts-check

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createDocsMcpHttpHandler,
  DOCS_MCP_CURRENT_PROTOCOL,
  DOCS_MCP_MAX_HTTP_BODY_BYTES,
} from '../packages/docs-mcp/src/index.js';
import { assembleDocsMcpRuntime } from '../scripts/assemble-docs-mcp-runtime.js';

const endpoint = 'https://accordo.dev/api/mcp';
const handle = createDocsMcpHttpHandler();

function modernRequest(method, params = {}, headers = {}) {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        ...(params._meta ?? {}),
        'io.modelcontextprotocol/protocolVersion': DOCS_MCP_CURRENT_PROTOCOL,
        'io.modelcontextprotocol/clientInfo': { name: 'accordo-http-test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const requestHeaders = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': DOCS_MCP_CURRENT_PROTOCOL,
    'mcp-method': method,
  };
  if (method === 'tools/call' || method === 'prompts/get') requestHeaders['mcp-name'] = params.name;
  if (method === 'resources/read') requestHeaders['mcp-name'] = params.uri;
  Object.assign(requestHeaders, headers);
  return new Request(endpoint, { method: 'POST', headers: requestHeaders, body: JSON.stringify(body) });
}

test('modern Streamable HTTP lists and calls the same read-only tools', async () => {
  const listedResponse = await handle(modernRequest('tools/list'));
  assert.equal(listedResponse.status, 200);
  assert.equal(listedResponse.headers.get('cache-control'), 'no-store');
  const listed = await listedResponse.json();
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name).sort(),
    ['check_job', 'get_capability', 'search_docs'],
  );
  for (const tool of listed.result.tools) assert.equal(tool.annotations.readOnlyHint, true);

  const called = await handle(modernRequest('tools/call', {
    name: 'get_capability',
    arguments: { id: 'C-01' },
  }));
  assert.equal(called.status, 200);
  const result = await called.json();
  const [capability] = result.result.structuredContent.matches;
  assert.equal(capability.kind, 'capability');
  assert.ok(capability.claim.length > 20);
  assert.ok(capability.limitation.length > 20);
  assert.ok(capability.evidence.tests.length > 0);
});

test('legacy initialize and notifications remain compatible without a session', async () => {
  const initialize = await handle(new Request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
    }),
  }));
  assert.equal(initialize.status, 200);
  assert.equal((await initialize.json()).result.protocolVersion, '2025-11-25');
  assert.equal(initialize.headers.get('mcp-session-id'), null, 'the stateless server must mint no session');

  const notification = await handle(new Request(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  }));
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), '');
});

test('modern routing metadata is required and must match the JSON-RPC body', async () => {
  const missing = modernRequest('tools/list');
  const missingHeaders = new Headers(missing.headers);
  missingHeaders.delete('mcp-method');
  const missingResponse = await handle(new Request(endpoint, {
    method: 'POST', headers: missingHeaders, body: await missing.text(),
  }));
  assert.equal(missingResponse.status, 400);
  assert.equal((await missingResponse.json()).error.code, -32020);

  const mismatch = await handle(modernRequest('tools/call', {
    name: 'search_docs', arguments: { query: 'module' },
  }, { 'mcp-name': 'check_job' }));
  assert.equal(mismatch.status, 400);
  assert.match((await mismatch.json()).error.message, /Mcp-Name/);

  const encoded = `=?base64?${Buffer.from('search_docs').toString('base64')}?=`;
  const accepted = await handle(modernRequest('tools/call', {
    name: 'search_docs', arguments: { query: 'Core rule', limit: 1 },
  }, { 'mcp-name': encoded }));
  assert.equal(accepted.status, 200, 'canonical base64 routing metadata must decode before comparison');
});

test('Origin validation and CORS preflight are explicit', async () => {
  const forbidden = await handle(modernRequest('tools/list', {}, { origin: 'https://evil.example' }));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('access-control-allow-origin'), null);

  const allowed = await handle(modernRequest('tools/list', {}, { origin: 'https://claude.ai' }));
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://claude.ai');

  const preflight = await handle(new Request(endpoint, {
    method: 'OPTIONS',
    headers: { origin: 'https://chatgpt.com' },
  }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://chatgpt.com');
  assert.match(preflight.headers.get('access-control-allow-headers') ?? '', /MCP-Protocol-Version/);

  const missingOrigin = await handle(new Request(endpoint, { method: 'OPTIONS' }));
  assert.equal(missingOrigin.status, 400);
  assert.equal(missingOrigin.headers.get('cache-control'), 'no-store');
  assert.equal(missingOrigin.headers.get('x-content-type-options'), 'nosniff');
});

test('the HTTP envelope fails closed on malformed or oversized input', async () => {
  const cases = [
    [new Request(endpoint, { method: 'GET' }), 405],
    [new Request(endpoint, { method: 'POST', headers: { 'content-type': 'text/plain', accept: 'application/json, text/event-stream' }, body: '{}' }), 415],
    [new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{}' }), 406],
    [new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream;q=0' }, body: '{}' }), 406],
    [new Request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{' }), 400],
    [new Request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(DOCS_MCP_MAX_HTTP_BODY_BYTES + 1),
      },
      body: '{}',
    }), 413],
    [new Request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': '0',
      },
      body: 'x'.repeat(DOCS_MCP_MAX_HTTP_BODY_BYTES + 1),
    }), 413],
  ];
  for (const [request, expected] of cases) {
    const response = await handle(request);
    assert.equal(response.status, expected);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    if (expected === 405) assert.equal(response.headers.get('allow'), 'POST, OPTIONS');
  }
});

test('unknown JSON-RPC methods are HTTP 404 with a JSON-RPC error', async () => {
  const response = await handle(modernRequest('does/not/exist'));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, -32601);
});

test('the Vercel entry and config keep one server authority and include the corpus', () => {
  const entry = readFileSync(new URL('../api/mcp.js', import.meta.url), 'utf8');
  assert.match(entry, /createDocsMcpHttpHandler/);
  assert.doesNotMatch(entry, /tools\/list|search_docs|get_capability|check_job/);

  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  const fn = config.functions?.['api/mcp.js'];
  assert.ok(fn, 'api/mcp.js needs explicit Vercel function configuration');
  assert.equal(
    fn.includeFiles,
    'packages/docs-mcp/runtime-corpus/**',
    'Vercel accepts one includeFiles glob; it must point at the deterministic runtime corpus',
  );
  assert.match(config.buildCommand, /assemble-docs-mcp-runtime\.js/);
});

test('the registry entry points at this endpoint, and never at a published project server', () => {
  const server = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  const brand = JSON.parse(readFileSync(new URL('../site/brand.json', import.meta.url), 'utf8'));

  // ADR-034: the project MCP composes an application from the generated indexes of the tree it
  // runs inside, so a copy published to npm would open a customer's database while answering
  // about a different CRM. The registry gets the documentation server, which is standalone
  // because its corpus is bundled and it opens nothing.
  assert.equal(server.packages, undefined, 'a package entry would offer the registry an installable project server');
  assert.equal(server.remotes.length, 1);
  assert.equal(server.remotes[0].type, 'streamable-http');
  assert.equal(server.remotes[0].url, `https://${brand.domain.value}/api/mcp`);
  assert.ok(existsSync(new URL('../api/mcp.js', import.meta.url)), 'the registered URL has no Function behind it');

  // The description is a first-contact retrieval surface, so it states what the corpus answers
  // about — not what the CRM runtime does. CRM_DB_PATH belonged to the project server and must
  // not survive into an entry that opens no database.
  assert.doesNotMatch(JSON.stringify(server), /CRM_DB_PATH/);
  for (const tool of ['search_docs', 'get_capability', 'check_job']) {
    assert.match(server.description, new RegExp(tool), `the entry omits ${tool}`);
  }
});

test('runtime corpus assembly is deterministic and excludes every ExecPlan', (t) => {
  const firstRoot = mkdtempSync(join(tmpdir(), 'accordo-docs-mcp-runtime-a-'));
  const secondRoot = mkdtempSync(join(tmpdir(), 'accordo-docs-mcp-runtime-b-'));
  const firstDir = join(firstRoot, 'runtime');
  const secondDir = join(secondRoot, 'runtime');
  t.after(() => {
    rmSync(firstRoot, { recursive: true, force: true });
    rmSync(secondRoot, { recursive: true, force: true });
  });
  const first = assembleDocsMcpRuntime({ sourceRoot: process.cwd(), outputDir: firstDir });
  const second = assembleDocsMcpRuntime({ sourceRoot: process.cwd(), outputDir: secondDir });

  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(first.files, second.files);
  assert.ok(first.files.includes('ARCHITECTURE.md'));
  assert.ok(first.files.includes('site/claims.json'));
  assert.ok(first.files.includes('docs/benchmarks/jobs.json'));
  assert.ok(first.files.every((path) => !path.startsWith('docs/plans/')));
  assert.equal(existsSync(join(firstDir, 'docs', 'plans')), false);

  // What this proves is that the copied ledger is the repository's ledger, not that the
  // contract happens to be at any particular version. Pinning the literal made ADR-027's
  // bump to contract 2 look like an assembly defect, which is the wrong failure: the
  // assembler had copied the file faithfully.
  assert.equal(
    JSON.parse(readFileSync(join(firstDir, 'site', 'claims.json'), 'utf8')).claimsContract,
    JSON.parse(readFileSync(join(process.cwd(), 'site', 'claims.json'), 'utf8')).claimsContract,
  );
});

test('runtime corpus assembly never replaces a caller-selected path', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'accordo-docs-mcp-runtime-occupied-'));
  const occupied = join(root, 'runtime');
  const sentinel = join(occupied, 'DO_NOT_DELETE');
  mkdirSync(occupied);
  writeFileSync(sentinel, 'sentinel');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  assert.throws(
    () => assembleDocsMcpRuntime({ sourceRoot: process.cwd(), outputDir: occupied }),
    /must not exist/,
  );
  assert.equal(readFileSync(sentinel, 'utf8'), 'sentinel');
});
