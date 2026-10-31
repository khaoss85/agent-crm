import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createAdminShellMount, injectAdminBase, injectSessionProfile, serializeEnvelope } from '../packages/app/src/admin-mount.js';
import { resolveAdminBase } from '../apps/admin/public/admin-base.js';
import { DEMO_STRINGS } from '../apps/admin/public/admin-oggi.js';

/**
 * The Admin shell as an embedding mount (backlog:ecdf7dc4): the same static
 * files and the same `/api/*` routes the standalone server owns, served under
 * a path prefix with a caller-supplied identity. These tests drive `handle`
 * directly — no socket — against a real in-memory application, so the routes
 * prove they run without the server around them.
 */

const jsonBody = (answer) => JSON.parse(typeof answer.body === 'string' ? answer.body : answer.body.toString('utf8'));

const readApp = () => createAccordoApp({ dbPath: ':memory:' });

test('basePath is "" or a "/bo"-style prefix with no trailing slash', () => {
  const app = readApp();
  try {
    assert.equal(createAdminShellMount(app, {}).basePath, '');
    assert.equal(createAdminShellMount(app, { basePath: '/bo' }).basePath, '/bo');
    for (const bad of ['bo', '/bo/', '/', '/bo/x/', '/bo x', ' /bo']) {
      assert.throws(() => createAdminShellMount(app, { basePath: bad }), /ADMIN_MOUNT_BASE_PATH_REFUSED/);
    }
  } finally {
    app.close();
  }
});

test('paths outside the mount are not mine (null, for the embedder to route)', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    assert.equal(await mount.handle({ method: 'GET', path: '/api/schema', headers: {} }), null);
    assert.equal(await mount.handle({ method: 'GET', path: '/box/api/schema', headers: {} }), null);
  } finally {
    app.close();
  }
});

test('the shell HTML carries the mount prefix for assets and API calls', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    for (const path of ['/bo', '/bo/']) {
      const answer = await mount.handle({ method: 'GET', path, headers: {} });
      assert.equal(answer.status, 200);
      assert.match(answer.headers['content-type'], /text\/html/);
      const html = answer.body.toString('utf8');
      assert.match(html, /<base href="\/bo\/">/);
      assert.match(html, /<meta name="admin-base" content="\/bo">/);
    }
    const rootMount = createAdminShellMount(app, {});
    const root = await rootMount.handle({ method: 'GET', path: '/', headers: {} });
    assert.match(root.body.toString('utf8'), /<base href="\/">/);
    assert.match(root.body.toString('utf8'), /<meta name="admin-base" content="">/);
  } finally {
    app.close();
  }
});

test('served shell HTML carries no demo text, mounted or standalone', async () => {
  const app = readApp();
  try {
    for (const basePath of ['/bo', '']) {
      const mount = createAdminShellMount(app, basePath === '' ? {} : { basePath });
      const answer = await mount.handle({ method: 'GET', path: `${basePath}/`, headers: {} });
      assert.equal(answer.status, 200);
      assert.match(answer.headers['content-type'], /text\/html/);
      const html = answer.body.toString('utf8');
      // The demo lives in JS-rendered chrome (standalone only): the served
      // bytes a space user receives never contain it (backlog:7eee63a5).
      for (const banned of DEMO_STRINGS) {
        assert.ok(!html.includes(banned), `${basePath === '' ? '/' : basePath} serves no demo text: ${banned}`);
      }
      assert.match(html, /id="boSidebar"/);
      assert.match(html, /id="boTopbar"/);
      // backlog:3f74a2f296ec: the shell loads one content-hashed bundle,
      // not the 30+ module cascade.
      assert.match(html, /src="bo-[0-9a-f]+\.js"/);
    }
  } finally {
    app.close();
  }
});

test('the space mount strips the technical footer; standalone keeps it', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const answer = await mount.handle({ method: 'GET', path: '/bo/', headers: {} });
    assert.equal(answer.status, 200);
    const html = answer.body.toString('utf8');
    assert.ok(!html.includes('<footer'), 'no footer element under the mount');
    assert.ok(!html.includes('Same services behind Admin'), 'no technical line under the mount');
    assert.ok(!html.includes('Accordo v0.1.0'), 'no version line under the mount');
    // The shell itself still renders: base, mount flag, chrome mounts.
    assert.match(html, /<meta name="admin-base" content="\/bo">/);
    assert.match(html, /id="boSidebar"/);

    const rootMount = createAdminShellMount(app, {});
    const root = await rootMount.handle({ method: 'GET', path: '/', headers: {} });
    assert.equal(root.status, 200);
    const standalone = root.body.toString('utf8');
    assert.ok(standalone.includes('<footer data-bo-technical>'), 'standalone keeps the footer');
    assert.ok(standalone.includes('Same services behind Admin'), 'standalone keeps the technical line');
    assert.ok(standalone.includes('Accordo v0.1.0'), 'standalone keeps the version line');
  } finally {
    app.close();
  }
});

test('static files keep their types; traversal and misses are 404', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const js = await mount.handle({ method: 'GET', path: '/bo/app.js', headers: {} });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    const css = await mount.handle({ method: 'GET', path: '/bo/styles.css', headers: {} });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
    const font = await mount.handle({
      method: 'GET',
      path: '/bo/fonts/bricolage-grotesque-latin-var.woff2',
      headers: {},
    });
    assert.equal(font.status, 200);
    assert.match(font.headers['content-type'], /font/);
    for (const missing of ['/bo/nope.js', '/bo/../packages/app/src/index.js', '/bo/%2e%2e/x']) {
      const answer = await mount.handle({ method: 'GET', path: missing, headers: {} });
      assert.equal(answer.status, 404, missing);
      assert.equal(jsonBody(answer).error.code, 'NOT_FOUND');
    }
  } finally {
    app.close();
  }
});

test('HEAD serves headers with an empty body, for API and static alike', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const api = await mount.handle({ method: 'HEAD', path: '/bo/api/schema', headers: {} });
    assert.equal(api.status, 200);
    assert.match(api.headers['content-type'], /application\/json/);
    assert.equal(api.body.byteLength, 0);
    const js = await mount.handle({ method: 'HEAD', path: '/bo/app.js', headers: {} });
    assert.equal(js.status, 200);
    assert.equal(js.body.byteLength, 0);
  } finally {
    app.close();
  }
});

test('API reads run through the mount with the real application state', async () => {
  const app = readApp();
  try {
    await app.runDemo();
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const schema = await mount.handle({ method: 'GET', path: '/bo/api/schema', headers: {} });
    assert.equal(schema.status, 200);
    assert.ok(jsonBody(schema).schema, 'the schema payload travels through the mount');
    const opportunities = await mount.handle({
      method: 'GET',
      path: '/bo/api/opportunities',
      headers: {},
    });
    assert.equal(opportunities.status, 200);
    assert.equal(jsonBody(opportunities).items.length, 2);
    const pending = await mount.handle({
      method: 'GET',
      path: '/bo/api/approvals',
      query: '?status=pending',
      headers: {},
    });
    assert.equal(pending.status, 200);
    assert.equal(jsonBody(pending).items.length, 1);
    const pendingObjectQuery = await mount.handle({
      method: 'GET',
      path: '/bo/api/approvals',
      query: { status: 'pending' },
      headers: {},
    });
    assert.equal(pendingObjectQuery.status, 200);
    assert.equal(jsonBody(pendingObjectQuery).items.length, 1);
  } finally {
    app.close();
  }
});

test('writes are refused by default and run only when the embedder widens them', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const refused = await mount.handle({
      method: 'POST',
      path: '/bo/api/demo/run',
      headers: { 'content-type': 'application/json' },
      body: {},
    });
    assert.equal(refused.status, 405);
    assert.equal(jsonBody(refused).error.code, 'ADMIN_METHOD_NOT_ALLOWED');
    const widened = createAdminShellMount(app, { basePath: '/bo', methods: ['GET', 'HEAD', 'POST'] });
    const ran = await widened.handle({
      method: 'POST',
      path: '/bo/api/demo/run',
      headers: { 'content-type': 'application/json' },
      body: {},
    });
    assert.equal(ran.status, 200);
  } finally {
    app.close();
  }
});

test('the caller-supplied identity reaches the handlers', async () => {
  const app = readApp();
  try {
    await app.runDemo();
    const seen = [];
    const mount = createAdminShellMount(app, {
      basePath: '/bo',
      methods: ['GET', 'HEAD', 'POST'],
      identityFor: async ({ headers, cookies, method, path }) => {
        seen.push({ method, path, session: cookies?.space_session, actor: headers['x-actor-id'] });
        return { actor: { type: 'user', id: 'space-owner' }, identity: { organizationId: 'org-1' }, organizationId: 'org-1' };
      },
    });
    const approvals = await mount.handle({ method: 'GET', path: '/bo/api/approvals', headers: {} });
    assert.equal(approvals.status, 200);
    const first = jsonBody(approvals).items[0];
    const decided = await mount.handle({
      method: 'POST',
      path: `/bo/api/approvals/${first.id}/approve`,
      headers: { 'content-type': 'application/json' },
      cookies: { space_session: 'session-1' },
      body: {},
    });
    assert.equal(decided.status, 200);
    assert.equal(app.services.approvals.get(first.id).decidedBy, 'space-owner');
    assert.deepEqual(seen[1], {
      method: 'POST',
      path: `/bo/api/approvals/${first.id}/approve`,
      session: 'session-1',
      actor: undefined,
    });
  } finally {
    app.close();
  }
});

test('without identityFor the mount falls back to the server identity', async () => {
  const app = readApp();
  try {
    await app.runDemo();
    const mount = createAdminShellMount(app, { basePath: '' });
    const answer = await mount.handle({
      method: 'GET',
      path: '/api/opportunities',
      headers: { 'x-actor-type': 'user', 'x-actor-id': 'admin-ui' },
    });
    assert.equal(answer.status, 200);
    assert.equal(jsonBody(answer).items.length, 2);
  } finally {
    app.close();
  }
});

test('framework errors keep their status and code through the mount', async () => {
  const mount = createAdminShellMount({}, { basePath: '/bo' });
  const answer = await mount.handle({ method: 'GET', path: '/bo/api/admin/metrics', headers: {} });
  assert.equal(answer.status, 404);
  assert.equal(jsonBody(answer).error.code, 'NOT_FOUND');
});

test('thrown errors echo the idempotency key like the standalone server', async () => {
  const { AppError } = await import('../packages/core/src/errors.js');
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, {
      basePath: '/bo',
      identityFor: () => {
        throw new AppError('denied', { code: 'FORBIDDEN', status: 403, details: { idempotencyKey: 'k-9' } });
      },
    });
    const answer = await mount.handle({ method: 'GET', path: '/bo/api/schema', headers: {} });
    assert.equal(answer.status, 403);
    assert.equal(jsonBody(answer).error.code, 'FORBIDDEN');
    assert.equal(answer.headers['idempotency-key'], 'k-9');
    assert.equal(answer.headers['content-length'], String(Buffer.byteLength(answer.body)));
  } finally {
    app.close();
  }
});

test('injectAdminBase strips only the marked footer under a mount', () => {
  const withFooter = '<html><head></head><body><footer data-bo-technical><span>Accordo v0.1.0</span></footer></body></html>';
  const stripped = injectAdminBase(withFooter, '/bo');
  assert.ok(!stripped.includes('<footer'), 'marked footer goes under the mount');
  assert.ok(!stripped.includes('Accordo v0.1.0'), 'its text goes with it');
  const kept = injectAdminBase(withFooter, '');
  assert.ok(kept.includes('<footer data-bo-technical>'), 'standalone keeps the marked footer');
  // An unmarked footer is never stripped: the marker is the whole contract.
  const plain = injectAdminBase('<html><head></head><body><footer><span>x</span></footer></body></html>', '/bo');
  assert.ok(plain.includes('<footer>'), 'unmarked footer stays');
  assert.match(plain, /<meta name="admin-base" content="\/bo">/);
});

test('injectAdminBase prefixes served HTML, or prepends without a head', () => {
  const withHead = injectAdminBase('<html><head><title>x</title></head><body></body></html>', '/bo');
  assert.match(withHead, /<head><base href="\/bo\/"><meta name="admin-base" content="\/bo"><title>/);
  const noHead = injectAdminBase('<p>hi</p>', '/bo');
  assert.ok(noHead.startsWith('<base href="/bo/"><meta name="admin-base" content="/bo"><p>'));
  const root = injectAdminBase('<html><head></head></html>', '');
  assert.match(root, /<base href="\/"><meta name="admin-base" content="">/);
});

test('liveness skips the identity path, like the standalone server', async () => {
  const app = readApp();
  try {
    let calls = 0;
    const mount = createAdminShellMount(app, {
      basePath: '/bo',
      identityFor: async () => {
        calls += 1;
        return { actor: null, identity: null, organizationId: null };
      },
    });
    const get = await mount.handle({ method: 'GET', path: '/bo/health', headers: {} });
    assert.equal(get.status, 200);
    assert.equal(jsonBody(get).ok, true);
    const head = await mount.handle({ method: 'HEAD', path: '/bo/health', headers: {} });
    assert.equal(head.status, 200);
    assert.equal(calls, 0);
  } finally {
    app.close();
  }
});

test('query strings embedded in path route and merge with explicit query', async () => {
  const app = readApp();
  try {
    await app.runDemo();
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const embedded = await mount.handle({
      method: 'GET',
      path: '/bo/api/approvals?status=pending',
      headers: {},
    });
    assert.equal(embedded.status, 200);
    assert.equal(jsonBody(embedded).items.length, 1);
    const fragment = await mount.handle({
      method: 'GET',
      path: '/bo/api/approvals?status=pending#section',
      headers: {},
    });
    assert.equal(fragment.status, 200);
    assert.equal(jsonBody(fragment).items.length, 1);
    const explicitWins = await mount.handle({
      method: 'GET',
      path: '/bo/api/approvals?status=all',
      query: { status: 'pending' },
      headers: {},
    });
    assert.equal(explicitWins.status, 200);
    assert.equal(jsonBody(explicitWins).items.length, 1);
    const explicitStringAppends = await mount.handle({
      method: 'GET',
      path: '/bo/api/approvals',
      query: '?status=pending',
      headers: {},
    });
    assert.equal(explicitStringAppends.status, 200);
    assert.equal(jsonBody(explicitStringAppends).items.length, 1);
  } finally {
    app.close();
  }
});

test('identity receives the mount path without the query and the URL with it', async () => {
  const app = readApp();
  try {
    const seen = [];
    const mount = createAdminShellMount(app, {
      basePath: '/bo',
      identityFor: async (input) => {
        seen.push(input);
        return { actor: { type: 'user', id: 'space-owner' }, identity: null, organizationId: null };
      },
    });
    const answer = await mount.handle({
      method: 'GET',
      path: '/bo/api/schema?x=1',
      query: { y: '2' },
      headers: {},
    });
    assert.equal(answer.status, 200);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].path, '/bo/api/schema');
    assert.equal(seen[0].url, '/bo/api/schema?x=1&y=2');
  } finally {
    app.close();
  }
});

test('the default identity forwards the URL to the verifier, like the server', async () => {
  const seen = [];
  const stubApp = {
    spine: {
      verifyRequest: async (request) => {
        seen.push(request);
        return null;
      },
      identityFor: async () => ({ kind: 'anonymous' }),
    },
  };
  const mount = createAdminShellMount(stubApp, { basePath: '/bo' });
  await mount.handle({
    method: 'GET',
    path: '/bo/api/schema?status=pending',
    headers: { 'x-actor-id': 'probe' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/bo/api/schema?status=pending');
});

test('JSON body policy mirrors the standalone server', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo', methods: ['GET', 'HEAD', 'POST'] });
    const parsed = await mount.handle({
      method: 'POST',
      path: '/bo/api/demo/run',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
    });
    assert.equal(parsed.status, 200);
    const fromBytes = await mount.handle({
      method: 'POST',
      path: '/bo/api/demo/run',
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from('{"ok":true}', 'utf8'),
    });
    assert.equal(fromBytes.status, 200);
    const invalid = await mount.handle({
      method: 'POST',
      path: '/bo/api/demo/run',
      headers: { 'content-type': 'application/json' },
      body: '{"broken"',
    });
    assert.equal(invalid.status, 400);
    assert.equal(jsonBody(invalid).error.code, 'INVALID_JSON');
    const invalidBytes = await mount.handle({
      method: 'POST',
      path: '/bo/api/demo/run',
      headers: { 'content-type': 'application/json' },
      rawBody: Buffer.from('not json', 'utf8'),
    });
    assert.equal(invalidBytes.status, 400);
    assert.equal(jsonBody(invalidBytes).error.code, 'INVALID_JSON');
    const oversized = await mount.handle({
      method: 'POST',
      path: '/bo/api/demo/run',
      headers: { 'content-type': 'application/json' },
      body: `{"pad":"${'x'.repeat(1_000_001)}"}`,
    });
    assert.equal(oversized.status, 413);
    assert.equal(jsonBody(oversized).error.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    app.close();
  }
});

test('rawBody routes require the exact bytes instead of coercing', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo', methods: ['GET', 'HEAD', 'POST'] });
    const parsedOnly = await mount.handle({
      method: 'POST',
      path: '/bo/api/signature/providers/acme/events',
      headers: { 'content-type': 'application/json' },
      body: { id: 'evt-1' },
    });
    assert.equal(parsedOnly.status, 400);
    assert.equal(jsonBody(parsedOnly).error.code, 'INVALID_JSON');
    // Bytes reach the handler: the in-memory app has no signature intake,
    // so the route answers its honest 404 instead of a body-shape error.
    const bytes = await mount.handle({
      method: 'POST',
      path: '/bo/api/signature/providers/acme/events',
      headers: { 'content-type': 'application/octet-stream' },
      rawBody: Buffer.from('{"id":"evt-1"}', 'utf8'),
    });
    assert.equal(bytes.status, 404);
    assert.equal(jsonBody(bytes).error.code, 'NOT_FOUND');
    const oversized = await mount.handle({
      method: 'POST',
      path: '/bo/api/signature/providers/acme/events',
      headers: { 'content-type': 'application/octet-stream' },
      rawBody: Buffer.alloc(65_537),
    });
    assert.equal(oversized.status, 413);
    assert.equal(jsonBody(oversized).error.code, 'PAYLOAD_TOO_LARGE');
  } finally {
    app.close();
  }
});

test('API and static responses carry content-length and the idempotency echo', async () => {
  const app = readApp();
  try {
    const mount = createAdminShellMount(app, { basePath: '/bo' });
    const api = await mount.handle({ method: 'GET', path: '/bo/api/schema', headers: {} });
    assert.equal(api.status, 200);
    assert.equal(api.headers['content-length'], String(Buffer.byteLength(api.body)));
    const js = await mount.handle({ method: 'GET', path: '/bo/app.js', headers: {} });
    assert.equal(js.status, 200);
    assert.equal(js.headers['content-length'], String(js.body.byteLength));
    const head = await mount.handle({ method: 'HEAD', path: '/bo/api/schema', headers: {} });
    assert.equal(head.status, 200);
    assert.ok(Number(head.headers['content-length']) > 0);
    assert.equal(head.body.byteLength, 0);
    const echoed = serializeEnvelope({ status: 200, body: { idempotencyKey: 'k-1', ok: true } });
    assert.equal(echoed.headers['idempotency-key'], 'k-1');
    assert.equal(echoed.headers['content-length'], String(Buffer.byteLength(echoed.body)));
    const nested = serializeEnvelope({
      status: 409,
      body: { error: { code: 'CONFLICT', message: 'no', details: { idempotencyKey: 'k-2' } } },
    });
    assert.equal(nested.headers['idempotency-key'], 'k-2');
    const explicit = serializeEnvelope({ status: 200, body: { ok: true }, headers: { 'idempotency-key': 'k-0' } });
    assert.equal(explicit.headers['idempotency-key'], 'k-0');
  } finally {
    app.close();
  }
});

test('basePath grammar refuses markup and injectAdminBase escapes attributes', () => {
  const app = readApp();
  try {
    for (const bad of [
      '/bo"><script>alert(1)</script>',
      '/bo[0]',
      "/bo'",
      '/bo?x=1',
      '/bo#frag',
      '/bo&x',
      '/bo|pipe',
    ]) {
      assert.throws(() => createAdminShellMount(app, { basePath: bad }), /ADMIN_MOUNT_BASE_PATH_REFUSED/, bad);
    }
    assert.equal(createAdminShellMount(app, { basePath: '/bo/v2' }).basePath, '/bo/v2');
    const injected = injectAdminBase('<html><head></head></html>', '/bo&w"<>');
    assert.match(injected, /<base href="\/bo&amp;w&quot;&lt;&gt;\/">/);
    assert.match(injected, /<meta name="admin-base" content="\/bo&amp;w&quot;&lt;&gt;">/);
  } finally {
    app.close();
  }
});

test('resolveAdminBase reads the injected meta, defaulting to ""', () => {
  const doc = (content) => ({
    querySelector: (selector) => {
      assert.equal(selector, 'meta[name="admin-base"]');
      return content === undefined ? null : { getAttribute: (name) => (name === 'content' ? content : null) };
    },
  });
  assert.equal(resolveAdminBase(doc('/bo')), '/bo');
  assert.equal(resolveAdminBase(doc('')), '');
  assert.equal(resolveAdminBase(doc(undefined)), '');
  assert.equal(resolveAdminBase({ querySelector: () => null }), '');
});

test('injectSessionProfile serializes the session display profile, escaped', () => {
  const html = '<html><head><title>x</title></head><body></body></html>';
  const injected = injectSessionProfile(html, {
    space: { id: 'presti-group', name: 'Presti Group' },
    role: 'owner',
    name: 'Elena Rinaldi',
    email: 'elena@studioaurora.it',
    logoutUrl: '/w/presti-group/auth/logout',
  });
  assert.match(injected, /<script id="bo-session" type="application\/json">/);
  assert.ok(injected.includes('"Presti Group"'));
  assert.ok(!injected.includes('</script><script'));
  const hostile = injectSessionProfile(html, { name: '</script><script>alert(1)</script>', space: { id: 'x', name: 'y' } });
  assert.ok(!hostile.includes('</script><script>'), 'hostile values never close the tag');
  assert.equal(injectSessionProfile(html, null), html);
  assert.equal(injectSessionProfile(html, 'nope'), html);
  assert.equal(injectSessionProfile(html, [1]), html);
});

test('the mount injects the embedder session profile into served HTML only', async () => {
  const app = readApp();
  try {
    const seen = [];
    const mount = createAdminShellMount(app, {
      basePath: '/bo',
      sessionFor: async ({ cookies, path }) => {
        seen.push({ path, session: cookies?.space_session });
        return {
          space: { id: 'presti-group', name: 'Presti Group' },
          role: 'operator',
          name: 'Elena Rinaldi',
          email: 'elena@studioaurora.it',
          logoutUrl: '/w/presti-group/auth/logout',
        };
      },
    });
    const page = await mount.handle({
      method: 'GET', path: '/bo/', headers: {}, cookies: { space_session: 's1' },
    });
    assert.equal(page.status, 200);
    const html = page.body.toString('utf8');
    assert.deepEqual(seen, [{ path: '/bo/', session: 's1' }]);
    assert.match(html, /<script id="bo-session" type="application\/json">/);
    assert.ok(html.includes('Presti Group'));
    // Non-HTML assets carry no profile.
    const js = await mount.handle({ method: 'GET', path: '/bo/app.js', headers: {} });
    assert.equal(js.status, 200);
    assert.ok(!js.body.toString('utf8').includes('id="bo-session"'));
  } finally {
    app.close();
  }
});

test('per-user session HTML leaves with private headers; shared HTML is no-store (backlog:3f74a2f296ec)', async () => {
  const app = readApp();
  try {
    const profile = {
      space: { id: 'aurora', name: 'Studio Aurora' },
      role: 'owner',
      name: 'Elena Rinaldi',
      email: 'elena@studioaurora.it',
      logoutUrl: '/w/aurora/auth/logout',
    };
    const sessioned = createAdminShellMount(app, {
      basePath: '/bo',
      sessionFor: async () => profile,
    });
    const personal = await sessioned.handle({ method: 'GET', path: '/bo/', headers: {}, cookies: {} });
    assert.equal(personal.status, 200);
    assert.ok(personal.body.toString('utf8').includes('id="bo-session"'));
    assert.equal(personal.headers['cache-control'], 'private, no-store');
    assert.equal(personal.headers.vary, 'Cookie');
    const personalHead = await sessioned.handle({ method: 'HEAD', path: '/bo/', headers: {}, cookies: {} });
    assert.equal(personalHead.headers['cache-control'], 'private, no-store');
    assert.equal(personalHead.headers.vary, 'Cookie');
    assert.equal(personalHead.body.byteLength, 0);
    // Non-HTML assets carry no profile, so they keep the shared policy.
    const js = await sessioned.handle({ method: 'GET', path: '/bo/app.js', headers: {} });
    assert.equal(js.headers['cache-control'], 'no-cache');
    assert.equal(js.headers.vary, undefined);
    // No sessionFor: the bytes are identical for every viewer, but HTML
    // entry points are no-store — they name the current content-hashed
    // bundle — while the hashed bundles themselves carry the long cache.
    const plain = createAdminShellMount(app, { basePath: '/bo' });
    const shared = await plain.handle({ method: 'GET', path: '/bo/', headers: {}, cookies: {} });
    assert.ok(!shared.body.toString('utf8').includes('id="bo-session"'));
    assert.equal(shared.headers['cache-control'], 'no-store');
    assert.equal(shared.headers.vary, undefined);
    // A profile failure degrades to the shared page, never to per-user bytes.
    const failing = createAdminShellMount(app, {
      basePath: '/bo',
      sessionFor: async () => { throw new Error('down'); },
    });
    const originalWarn = console.warn;
    console.warn = () => {};
    let degraded;
    try {
      degraded = await failing.handle({ method: 'GET', path: '/bo/', headers: {}, cookies: {} });
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(!degraded.body.toString('utf8').includes('id="bo-session"'));
    assert.equal(degraded.headers['cache-control'], 'no-store');
    assert.equal(degraded.headers.vary, undefined);
  } finally {
    app.close();
  }
});

test('without sessionFor the served shell carries no profile; a failure degrades to none', async () => {
  const app = readApp();
  try {
    const plain = createAdminShellMount(app, { basePath: '/bo' });
    const page = await plain.handle({ method: 'GET', path: '/bo/', headers: {}, cookies: {} });
    assert.equal(page.status, 200);
    assert.ok(!page.body.toString('utf8').includes('id="bo-session"'));
    const failing = createAdminShellMount(app, {
      basePath: '/bo',
      sessionFor: async () => { throw Object.assign(new Error('down'), { code: 'PROFILE_DOWN' }); },
    });
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };
    let degraded;
    try {
      degraded = await failing.handle({ method: 'GET', path: '/bo/', headers: {}, cookies: {} });
    } finally {
      console.warn = originalWarn;
    }
    assert.equal(degraded.status, 200, 'a display failure never fails the shell');
    assert.ok(!degraded.body.toString('utf8').includes('id="bo-session"'));
    assert.equal(warnings.length, 1, 'one diagnostic, never silent');
    assert.ok(warnings[0].includes('bo-session profile unreadable'));
    assert.ok(warnings[0].includes('Error'));
    assert.ok(warnings[0].includes('path=/bo/'));
    assert.ok(!warnings[0].includes('down'), 'no error text, no profile data');
  } finally {
    app.close();
  }
});
