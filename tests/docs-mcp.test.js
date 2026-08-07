// @ts-check

/**
 * The Docs MCP server is the surface a stranger's coding agent talks to. It runs
 * in someone else's context, answering "can this framework do X?" for a project
 * this repository will never see, and whatever it says will be relayed to a user
 * as fact.
 *
 * That makes two classes of failure worth testing, and they are not the usual
 * ones:
 *
 *   1. **Overclaim.** A capability served without the limitation that bounds it,
 *      or a job resolved into a status it does not have. `site/claims.json` pairs
 *      every claim with its limitation and `scripts/site-check.js` enforces that
 *      for the website; these tests enforce it for every MCP client, including
 *      the structural version — that there is no way to *construct* a capability
 *      answer without one.
 *
 *   2. **Escape.** This server exists because it holds nothing worth stealing:
 *      no database, no customer record, no write path. Those are properties of
 *      the code, so they are asserted against the code, and the doc root is
 *      tested against the input that has been trying to leave document roots
 *      since 1995.
 *
 * Everything else — ranking quality, excerpt shape — is a matter of taste. These
 * two are matters of honesty.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertLimitationsPresent,
  createDocsMcpServer,
  isWithinRoot,
  resolveWithinRoot,
  toCapability,
} from '../packages/docs-mcp/src/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const binary = join(root, 'packages', 'docs-mcp', 'bin', 'server.js');
const ledger = JSON.parse(readFileSync(join(root, 'site', 'claims.json'), 'utf8'));

/** A limitation shorter than this is not a limitation. Mirrors site-check.js. */
const MINIMUM_LIMITATION_LENGTH = 20;

/** @param {any} server @param {string} name @param {any} [args] */
async function callTool(server, name, args = {}) {
  const response = await server.handle({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });
  return response.result;
}

/** @param {any} server @param {string} method @param {any} [params] */
async function call(server, method, params = {}) {
  return server.handle({ jsonrpc: '2.0', id: 1, method, params });
}

// ------------------------------------------------------------------ it runs

test('the server starts over stdio and lists its tools', async () => {
  const responses = await stdioRoundTrip([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ]);

  assert.equal(responses.messages[0].result.serverInfo.name, 'agent-crm-docs');
  const names = responses.messages[1].result.tools.map((/** @type {any} */ tool) => tool.name);
  assert.deepEqual(names.sort(), ['check_job', 'get_capability', 'search_docs']);

  // stdout is reserved for JSON-RPC (AGENTS.md). Every line must parse.
  for (const line of responses.stdout.trim().split('\n')) JSON.parse(line);
});

test('every tool is read-only and no write tool exists', async () => {
  const server = createDocsMcpServer();
  const listed = (await call(server, 'tools/list')).result.tools;
  assert.ok(listed.length > 0);
  for (const tool of listed) {
    assert.equal(tool.annotations.readOnlyHint, true, `${tool.name} is not annotated read-only`);
    assert.equal(tool.annotations.destructiveHint, false, `${tool.name} is annotated destructive`);
  }
  // The annotation is a promise; this is the promise being kept.
  const forbidden = /create|update|delete|write|scaffold|apply|set_|decide|run_/i;
  const offenders = listed
    .map((/** @type {any} */ tool) => tool.name)
    .filter((/** @type {string} */ name) => forbidden.test(name));
  assert.deepEqual(offenders, [], 'a docs server may not name a mutating tool');
});

test('the package reaches no database, no application and no module service', () => {
  // The strongest guarantee this server can offer a directory reviewer is not a
  // sentence in a README — it is that the import graph cannot get to the CRM.
  const sources = [
    ...readdirSync(join(root, 'packages', 'docs-mcp', 'src')).map((name) => join('src', name)),
    ...readdirSync(join(root, 'packages', 'docs-mcp', 'bin')).map((name) => join('bin', name)),
  ];
  const banned = [
    /node:sqlite/,
    /DatabaseSync/,
    /createAgentCrmApp/,
    /packages\/app/,
    /\.\.\/\.\.\/(app|modules|workflows|actions|providers|commercial|contracts|delivery|intelligence|signature|pipelines|sdk|cli)\//,
    /\bwriteFileSync\b/,
    /\bappendFileSync\b/,
    /\bunlinkSync\b/,
    /\brmSync\b/,
    /\bmkdirSync\b/,
  ];
  const offenders = [];
  for (const relative of sources) {
    const text = readFileSync(join(root, 'packages', 'docs-mcp', relative), 'utf8');
    for (const pattern of banned) {
      if (pattern.test(text)) offenders.push(`${relative} matches ${pattern}`);
    }
  }
  assert.deepEqual(offenders, [], 'the docs server must remain strictly read-only and CRM-free');
});

// ------------------------------------------------------------------ resources

test('resources serve the documentation set, the claims ledger and the jobs index', async () => {
  const server = createDocsMcpServer();
  const listed = (await call(server, 'resources/list')).result.resources;
  const uris = new Set(listed.map((/** @type {any} */ resource) => resource.uri));

  for (const expected of [
    'docs://index',
    'docs://claims',
    'docs://jobs',
    'docs://AGENTS.md',
    'docs://PRODUCT.md',
    'docs://ARCHITECTURE.md',
    'docs://README.md',
    'docs://docs/MCP.md',
  ]) {
    assert.ok(uris.has(expected), `resources/list is missing ${expected}`);
  }

  const architecture = await call(server, 'resources/read', { uri: 'docs://ARCHITECTURE.md' });
  assert.equal(architecture.result.contents[0].mimeType, 'text/markdown');
  assert.match(architecture.result.contents[0].text, /Core rule/);

  const claims = await call(server, 'resources/read', { uri: 'docs://claims' });
  assert.equal(JSON.parse(claims.result.contents[0].text).claimsContract, ledger.claimsContract);
});

test('ExecPlans are not served as documentation', async () => {
  // A plan describes work that is *intended*. An agent that retrieves one and
  // reads it as a capability was misled by us.
  const server = createDocsMcpServer();
  const listed = (await call(server, 'resources/list')).result.resources;
  const plans = listed.filter((/** @type {any} */ resource) => resource.uri.includes('docs/plans/'));
  assert.deepEqual(plans, [], 'docs/plans must stay out of the corpus');

  const index = JSON.parse(
    (await call(server, 'resources/read', { uri: 'docs://index' })).result.contents[0].text,
  );
  assert.ok(
    index.excluded.some((/** @type {any} */ entry) => entry.path === 'docs/plans' && entry.reason),
    'the index must say what it excludes and why, rather than silently omitting it',
  );
});

// ------------------------------------------------------------------ search

test('search returns a known heading', async () => {
  const server = createDocsMcpServer();
  const result = await callTool(server, 'search_docs', { query: 'Core rule' });
  assert.equal(result.isError, false);

  const hit = result.structuredContent.results.find(
    (/** @type {any} */ entry) => entry.path === 'ARCHITECTURE.md',
  );
  assert.ok(hit, 'searching for "Core rule" must find ARCHITECTURE.md');
  assert.equal(hit.heading, 'Core rule');
  assert.equal(hit.uri, 'docs://ARCHITECTURE.md');
  assert.ok(hit.line > 0);
  assert.ok(hit.excerpt.length > 0);
  assert.ok(result.structuredContent.documentsSearched > 20);
});

test('search is deterministic', async () => {
  const server = createDocsMcpServer();
  const first = await callTool(server, 'search_docs', { query: 'deterministic workflow' });
  const second = await callTool(createDocsMcpServer(), 'search_docs', { query: 'deterministic workflow' });
  assert.equal(
    JSON.stringify(first.structuredContent),
    JSON.stringify(second.structuredContent),
    'same input must produce byte-identical output (AGENTS.md)',
  );
});

test('search reports an honest miss rather than a plausible one', async () => {
  const server = createDocsMcpServer();
  const result = await callTool(server, 'search_docs', { query: 'zzzznotawordanywhere' });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent.results, []);
  assert.equal(result.structuredContent.totalMatches, 0);
});

// ------------------------------------------------------------------ capabilities

test('get_capability returns the claim, its evidence and its limitation together', async () => {
  const server = createDocsMcpServer();
  const result = await callTool(server, 'get_capability', { id: 'C-01' });
  assert.equal(result.isError, false);

  const [match] = result.structuredContent.matches;
  assert.equal(match.id, 'C-01');
  assert.equal(match.kind, 'capability');
  assert.ok(match.claim.length > 20, 'the claim sentence must be present');
  assert.ok(match.limitation.length >= MINIMUM_LIMITATION_LENGTH, 'the limitation must be present');
  assert.ok(match.evidence.tests.length > 0, 'the evidence must name the tests that prove it');
  assert.deepEqual(match.evidence.jtbd, ['JTBD-01']);
  assert.equal(match.source, 'site/claims.json');

  // Provenance travels with the answer: a ledger measured against a stale commit
  // is a ledger that lies, and the caller must be able to see which commit.
  assert.equal(result.structuredContent.claimsContract, ledger.claimsContract);
  assert.equal(result.structuredContent.measuredAgainst.sha, ledger.measuredAgainst.sha);
  assert.ok(result.structuredContent.frameworkLimitations.length > 0);
});

test('get_capability refuses an unknown id', async () => {
  const server = createDocsMcpServer();
  for (const id of ['C-999', 'not-an-id', 'C-01x', '__proto__']) {
    const result = await callTool(server, 'get_capability', { id });
    assert.equal(result.isError, true, `${id} must not resolve`);
    assert.equal(result.structuredContent.error.code, 'NOT_FOUND');
    assert.ok(
      !JSON.stringify(result.structuredContent).includes('"kind":"capability"'),
      'a refusal must not carry a capability',
    );
  }
});

test('get_capability needs an id or a topic', async () => {
  const server = createDocsMcpServer();
  const result = await callTool(server, 'get_capability', {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error.code, 'VALIDATION_ERROR');
});

test('no capability response ever lacks a limitation', async () => {
  const server = createDocsMcpServer();

  // Every claim in the ledger, one by one — not a sample.
  for (const claim of ledger.claims) {
    const result = await callTool(server, 'get_capability', { id: claim.id });
    assert.equal(result.isError, false, `${claim.id} failed to resolve`);
    for (const match of result.structuredContent.matches) {
      assert.equal(match.kind, 'capability');
      assert.ok(
        typeof match.limitation === 'string' && match.limitation.length >= MINIMUM_LIMITATION_LENGTH,
        `${claim.id} was served without a limitation`,
      );
    }
  }

  // And through the topic path, which returns many at once.
  for (const topic of ['module', 'quote', 'approval', 'package', 'delivery', 'admin']) {
    const result = await callTool(server, 'get_capability', { topic });
    assert.equal(result.isError, false);
    for (const match of result.structuredContent.matches) {
      assert.ok(
        match.limitation.length >= MINIMUM_LIMITATION_LENGTH,
        `topic "${topic}" served ${match.id} without a limitation`,
      );
    }
  }
});

test('a capability cannot be constructed without its limitation', () => {
  // The structural version of the rule. Remembering to attach the limitation at
  // each call site is the design that eventually ships an overclaim; having no
  // way to build the object without one is the design that cannot.
  assert.throws(
    () => toCapability({ id: 'C-XX', text: 'A capability with no stated boundary.', evidence: {} }),
    (/** @type {any} */ error) => error.code === 'LIMITATION_MISSING',
    'a claim with no limitation must not become an answer',
  );
  assert.throws(
    () => toCapability({ id: 'C-XX', text: 'x', limitation: 'too short', evidence: {} }),
    (/** @type {any} */ error) => error.code === 'LIMITATION_MISSING',
  );
  assert.throws(() => toCapability(null), (/** @type {any} */ error) => error.code === 'VALIDATION_ERROR');

  // And the sweep that catches a response assembled by hand rather than built.
  assert.throws(
    () => assertLimitationsPresent(
      { matches: [{ id: 'C-XX', kind: 'capability', claim: 'anything' }] },
      'test',
    ),
    (/** @type {any} */ error) => error.code === 'LIMITATION_MISSING',
  );
  assert.throws(
    () => assertLimitationsPresent({ nested: { deep: [{ kind: 'job', id: 'JTBD-XX' }] } }, 'test'),
    (/** @type {any} */ error) => error.code === 'LIMITATION_MISSING',
  );
});

test('a standing limitation resolves as a limitation, not a capability', async () => {
  const server = createDocsMcpServer();
  const result = await callTool(server, 'get_capability', { id: 'L-01' });
  assert.equal(result.isError, false);
  const [match] = result.structuredContent.matches;
  assert.equal(match.kind, 'limitation');
  assert.match(match.headline, /authentication|tenancy|RBAC/i);
});

// ------------------------------------------------------------------ jobs

test('check_job answers "not supported" when that is the truth', async () => {
  const server = createDocsMcpServer();
  const result = await callTool(server, 'check_job', { query: 'import records from CSV' });
  assert.equal(result.isError, false);

  const answer = result.structuredContent;
  assert.equal(answer.available, true);
  assert.equal(answer.answer, 'not supported');
  assert.match(answer.answerText, /Not supported/);
  assert.match(answer.answerText, /docs\/benchmarks\/CRM_JTBD_MATRIX\.md/);
  assert.equal(answer.matches[0].id, 'JTBD-DO-01');
  assert.equal(answer.matches[0].status, 'not supported');
});

test('check_job resolves a validated job with the ledger limitation that bounds it', async () => {
  const server = createDocsMcpServer();
  const result = await callTool(server, 'check_job', { query: 'JTBD-CO-01' });
  const answer = result.structuredContent;

  assert.equal(answer.answer, 'validated end to end');
  assert.equal(answer.matches[0].id, 'JTBD-CO-01');
  assert.equal(answer.matches[0].limitationSource, 'site/claims.json C-08.limitation');
  assert.equal(answer.matches[0].claim.id, 'C-08');

  // JTBD-CO-01 is one of the rows marked validated without naming a test in the
  // row itself — a known gap in the matrix, held by tests/jobs-json.test.js. A
  // validated job served with no evidence at all reads as an unproven claim, so
  // the paired claim's tests travel with it.
  assert.deepEqual(answer.matches[0].evidence.tests, []);
  assert.ok(
    answer.matches[0].claim.tests.length > 0,
    'a validated job must show proof from somewhere — the row or the ledger',
  );
  assert.deepEqual(answer.statusVocabulary, [
    'not supported',
    'partially supported',
    'technically supported',
    'validated end to end',
  ]);
});

test('check_job does not resolve a question no job covers into a status', async () => {
  // The regression that matters. Ranking over a loose match set and reporting the
  // strongest status in it made "teleport the customer to mars" answer "validated
  // end to end", because some unrelated validated job shared the word "customer".
  // A tool whose purpose is to stop an agent overclaiming must not be the thing
  // that overclaims.
  const server = createDocsMcpServer();
  for (const query of ['teleport the customer to mars', 'brew the customer a coffee']) {
    const answer = (await callTool(server, 'check_job', { query })).structuredContent;
    assert.equal(answer.answer, 'unknown', `"${query}" must not resolve to a status`);
    assert.match(answer.answerText, /do not read this as support|never assessed/i);
  }

  const absent = (await callTool(server, 'check_job', { query: 'multi-tenancy' })).structuredContent;
  assert.equal(absent.answer, 'unknown');
  assert.deepEqual(absent.matches, []);
  assert.match(absent.answerText, /never assessed/);
});

test('every job returned carries a limitation', async () => {
  const server = createDocsMcpServer();
  const queries = [
    'pipeline stages', 'quote', 'approval', 'delivery project', 'send a marketing email campaign',
    'import records from CSV', 'custom object', 'signature envelope', 'renewal', 'forecast',
  ];
  let seen = 0;
  for (const query of queries) {
    const answer = (await callTool(server, 'check_job', { query, limit: 25 })).structuredContent;
    for (const match of answer.matches) {
      seen += 1;
      assert.equal(match.kind, 'job');
      assert.ok(
        typeof match.limitation === 'string' && match.limitation.length >= MINIMUM_LIMITATION_LENGTH,
        `${match.id} was served without a limitation`,
      );
      assert.ok(match.limitationSource, `${match.id} does not say where its limitation came from`);
    }
  }
  assert.ok(seen > 30, `expected a broad sweep of jobs, saw ${seen}`);
});

test('check_job degrades with a clear message when the jobs index is absent', async (t) => {
  const work = mkdtempSync(join(tmpdir(), 'docs-mcp-nojobs-'));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'site'), { recursive: true });
  mkdirSync(join(work, 'docs', 'benchmarks'), { recursive: true });
  cpSync(join(root, 'site', 'claims.json'), join(work, 'site', 'claims.json'));
  cpSync(join(root, 'ARCHITECTURE.md'), join(work, 'ARCHITECTURE.md'));
  cpSync(join(root, 'docs', 'MCP.md'), join(work, 'docs', 'MCP.md'));

  const server = createDocsMcpServer({ rootDir: work });
  const result = await callTool(server, 'check_job', { query: 'import records from CSV' });

  assert.equal(result.isError, false, 'a missing index must degrade, not throw');
  const answer = result.structuredContent;
  assert.equal(answer.available, false);
  assert.equal(answer.answer, 'unknown');
  assert.deepEqual(answer.matches, []);
  assert.match(answer.answerText, /not present in this checkout/);
  assert.match(answer.answerText, /treat every job as unassessed rather than as supported/);
  assert.equal(answer.remediation, 'node scripts/generate-jobs.js');

  // The resource degrades the same way rather than failing the read.
  const resource = await call(server, 'resources/read', { uri: 'docs://jobs' });
  assert.equal(JSON.parse(resource.result.contents[0].text).available, false);

  // The rest of the server keeps working on a partial checkout.
  const capability = await callTool(server, 'get_capability', { id: 'C-01' });
  assert.equal(capability.isError, false);
});

// ------------------------------------------------------------------ hostile input

test('hostile input is inert', async () => {
  const server = createDocsMcpServer();

  // Null bytes and oversized strings are refused by name, not silently truncated.
  for (const tool of ['search_docs', 'check_job']) {
    const nullByte = await callTool(server, tool, { query: 'quote\u0000/etc/passwd' });
    assert.equal(nullByte.isError, true, `${tool} accepted a null byte`);
    assert.equal(nullByte.structuredContent.error.code, 'VALIDATION_ERROR');
    assert.match(nullByte.structuredContent.error.message, /null byte/);

    const oversized = await callTool(server, tool, { query: 'a'.repeat(5000) });
    assert.equal(oversized.isError, true, `${tool} accepted a 5000-character query`);
    assert.equal(oversized.structuredContent.error.code, 'VALIDATION_ERROR');

    const empty = await callTool(server, tool, { query: '   ' });
    assert.equal(empty.isError, true, `${tool} accepted an empty query`);
  }

  // Prototype keys and markup are ordinary text: searched for, not interpreted.
  for (const query of ['__proto__', 'constructor.prototype', '<script>alert(1)</script>', '${process.env.HOME}']) {
    const result = await callTool(server, 'search_docs', { query });
    assert.equal(result.isError, false, `${query} should be searched, not rejected`);
    assert.ok(Array.isArray(result.structuredContent.results));
    const job = await callTool(server, 'check_job', { query });
    assert.equal(job.isError, false);
  }

  // Nothing above touched the prototype chain.
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
  assert.equal(/** @type {any} */ (Object.prototype).polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);

  // A limit outside the schema is refused rather than coerced.
  const badLimit = await callTool(server, 'search_docs', { query: 'module', limit: -1 });
  assert.equal(badLimit.isError, true);
  const hugeLimit = await callTool(server, 'search_docs', { query: 'module', limit: 10_000 });
  assert.equal(hugeLimit.isError, false, 'an oversized limit is clamped, not an error');
  assert.ok(hugeLimit.structuredContent.results.length <= 100);

  // An unknown tool is an error, not a crash.
  const unknown = await callTool(server, 'crm_create_opportunity', {});
  assert.equal(unknown.isError, true);
  assert.match(unknown.structuredContent.error.message, /Unknown MCP tool/);
});

test('path traversal cannot escape the doc root', async () => {
  const server = createDocsMcpServer();

  // Through the resource URI, which is the only path-shaped input a caller has.
  const escapes = [
    'docs://../../etc/passwd',
    'docs://../package.json',
    'docs:///etc/passwd',
    'docs://docs/../../etc/passwd',
    'docs://..%2F..%2Fetc%2Fpasswd',
    'docs://data/agent-crm.sqlite',
    '../../etc/passwd',
    'file:///etc/passwd',
    '',
  ];
  for (const uri of escapes) {
    const response = await call(server, 'resources/read', { uri });
    assert.ok(response.error, `${uri} must not resolve`);
    assert.equal(response.error.data.code, 'NOT_FOUND');
  }
  for (const uri of [null, 42, { toString: () => 'docs://ARCHITECTURE.md' }, ['docs://ARCHITECTURE.md']]) {
    const response = await call(server, 'resources/read', { uri });
    assert.ok(response.error, `${JSON.stringify(uri)} must not resolve`);
  }

  // And directly against the confinement function, so the property is proven of
  // the function rather than of today's set of callers.
  for (const candidate of [
    '../../etc/passwd', '/etc/passwd', 'docs/../../etc/passwd', '../package.json',
    'a\u0000b', '', '   ', '.', '..', 'C:\\windows\\system32', '\\\\server\\share',
  ]) {
    assert.equal(isWithinRoot(root, candidate), false, `${JSON.stringify(candidate)} escaped the root`);
    assert.throws(() => resolveWithinRoot(root, candidate));
  }
  for (const candidate of ['docs/MCP.md', 'ARCHITECTURE.md', 'docs/benchmarks/jobs.json']) {
    assert.ok(isWithinRoot(root, candidate), `${candidate} should be inside the root`);
    assert.ok(resolveWithinRoot(root, candidate).startsWith(root));
  }

  // Traversal typed into a search box is a search term, not a path.
  const searched = await callTool(server, 'search_docs', { query: '../../etc/passwd' });
  assert.equal(searched.isError, false);
  assert.ok(!JSON.stringify(searched.structuredContent).includes('root:x:0:0'));
});

test('a malformed JSON-RPC request is answered, not thrown', async () => {
  const server = createDocsMcpServer();
  assert.equal((await server.handle(null)).error.code, -32600);
  assert.equal((await server.handle({ jsonrpc: '1.0', id: 1, method: 'ping' })).error.code, -32600);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 1, method: 'nope' })).error.code, -32601);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

/**
 * Drive the real binary over stdio and collect one response line per request.
 *
 * @param {any[]} requests
 * @param {{timeoutMs?: number}} [options]
 */
function stdioRoundTrip(requests, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--no-warnings', binary], {
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (/** @type {(value: any) => void} */ done, /** @type {any} */ value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      child.kill('SIGKILL');
      done(value);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`docs-mcp stdio timed out\nstdout: ${stdout}\nstderr: ${stderr}`)),
      timeoutMs,
    );

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n').filter((line) => line.trim() !== '');
      if (lines.length >= requests.length) {
        finish(resolve, { stdout, stderr, messages: lines.map((line) => JSON.parse(line)) });
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(reject, error));

    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}
