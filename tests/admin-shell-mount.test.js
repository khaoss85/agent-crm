import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccordoApp } from '../packages/app/src/index.js';
import { createAdminShellMount, injectAdminBase } from '../packages/app/src/admin-mount.js';
import { resolveAdminBase } from '../apps/admin/public/admin-base.js';

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

test('injectAdminBase prefixes served HTML, or prepends without a head', () => {
  const withHead = injectAdminBase('<html><head><title>x</title></head><body></body></html>', '/bo');
  assert.match(withHead, /<head><base href="\/bo\/"><meta name="admin-base" content="\/bo"><title>/);
  const noHead = injectAdminBase('<p>hi</p>', '/bo');
  assert.ok(noHead.startsWith('<base href="/bo/"><meta name="admin-base" content="/bo"><p>'));
  const root = injectAdminBase('<html><head></head></html>', '');
  assert.match(root, /<base href="\/"><meta name="admin-base" content="">/);
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
