// @ts-check

/**
 * `crm cloud`: the bridge from a project to its Accordo Cloud workspace.
 *
 * The Cloud here is a recording fake with the real contract's shapes — the
 * control plane's begin/console-session/workspaces/revisions/agent-session
 * answers and the CRM's 303 — because what is under test is the client: that
 * the login only accepts the sign-in it started, that the session is kept
 * private, that a push is one idempotent revision, and that a proposal goes to
 * the CRM as the agent and never as a decision.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCloudCommand } from '../packages/cli/src/cloud-command.js';

const ORIGIN = 'https://cloud.example.test';
const WEB = 'https://crm.example.test';
const WORKSPACE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const HASH = 'a'.repeat(64);

function fakeCloud() {
  const calls = [];
  const revisions = new Map();
  const json = (status, body) => ({ status, ok: status < 400, json: async () => body, text: async () => JSON.stringify(body),
    headers: new Headers() });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const body = init.body ? (String(init.headers?.['content-type'] ?? '').includes('json') ? JSON.parse(init.body) : init.body) : null;
    calls.push({ method: init.method ?? 'GET', path: u.pathname, headers: init.headers ?? {}, body });
    if (u.origin === ORIGIN && u.pathname === '/v1/oauth/console-session') {
      return body?.code === 'grant-code' ? json(201, { ok: true, session: 'operator-session', operatorAccountId: 'op-1' })
        : json(403, { ok: false, error: 'OAUTH_CODE_SPENT' });
    }
    if (init.headers?.authorization !== 'Bearer operator-session' && u.origin === ORIGIN) {
      return json(401, { ok: false, error: 'OPERATOR_AUTH_REQUIRED' });
    }
    if (u.pathname === `/v1/workspaces/${WORKSPACE}`) {
      return json(200, { ok: true, workspace: { id: WORKSPACE, blueprintHash: HASH, blueprint: {
        models: [{ name: 'quote', fields: [{ name: 'discount', type: 'number' }] }],
        approvals: [{ name: 'big_discount', model: 'quote', field: 'discount', above: 20 }] } } });
    }
    if (u.pathname === `/v1/workspaces/${WORKSPACE}/revisions`) {
      const seen = revisions.has(body.requestKey);
      revisions.set(body.requestKey, body);
      return json(seen ? 200 : 201, { ok: true, duplicate: seen,
        revision: { outcome: 'applied', resultingBlueprintHash: 'b'.repeat(64), refusalCode: null } });
    }
    if (u.pathname === `/v1/workspaces/${WORKSPACE}/agent-session`) {
      return json(201, { ok: true, session: 'agent-crm-session', webOrigin: WEB, path: `/w/${WORKSPACE}` });
    }
    if (u.origin === WEB && u.pathname === `/w/${WORKSPACE}/records`) {
      return { status: 303, ok: false, headers: new Headers({ location: '/actions/req-1?returnTo=%2Frecords' }),
        text: async () => '', json: async () => null };
    }
    return json(404, { ok: false, error: 'NOT_FOUND' });
  };
  return { calls, fetchImpl };
}

function project() {
  return { home: mkdtempSync(join(tmpdir(), 'accordo-cloud-home-')), projectRoot: mkdtempSync(join(tmpdir(), 'accordo-cloud-proj-')) };
}

const run = (args, flags, deps) => {
  const printed = [];
  return runCloudCommand(args, { json: true, ...flags }, { ...deps, print: (line) => printed.push(line) })
    .then(() => JSON.parse(printed.at(-1)));
};

/** A browser that follows the begin link: GitHub is skipped, the loopback gets the code. */
const browserReturning = (code, state = null) => (begin) => {
  const returnTo = new URL(new URL(begin).searchParams.get('returnTo'));
  if (state !== null) returnTo.searchParams.set('cli_state', state);
  returnTo.searchParams.set('code', code);
  setImmediate(() => { fetch(returnTo).catch(() => {}); });
};

test('login accepts the sign-in it started and keeps the session private', async () => {
  const cloud = fakeCloud();
  const dirs = project();
  const report = await run(['login'], { origin: ORIGIN },
    { ...dirs, fetchImpl: cloud.fetchImpl, openBrowser: browserReturning('grant-code') });
  assert.equal(report.signedIn, true);
  const path = join(dirs.home, 'cloud-session.json');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).session, 'operator-session');
  assert.equal(statSync(path).mode & 0o777, 0o600, 'nobody else on the machine reads the session');
  assert.equal(cloud.calls[0].path, '/v1/oauth/console-session');
});

test('login refuses a sign-in this terminal did not start', async () => {
  const cloud = fakeCloud();
  await assert.rejects(() => run(['login'], { origin: ORIGIN },
    { ...project(), fetchImpl: cloud.fetchImpl, openBrowser: browserReturning('grant-code', 'f'.repeat(32)) }),
  { code: 'CLOUD_LOGIN_STATE_REFUSED' });
  assert.equal(cloud.calls.length, 0, 'a foreign code is never spent');
});

async function signedInAndLinked(cloud) {
  const dirs = project();
  await run(['login'], { origin: ORIGIN }, { ...dirs, fetchImpl: cloud.fetchImpl, openBrowser: browserReturning('grant-code') });
  await run(['link', WORKSPACE], { origin: ORIGIN }, { ...dirs, fetchImpl: cloud.fetchImpl });
  return dirs;
}

test('status reads the linked workspace\'s Blueprint and gates', async () => {
  const cloud = fakeCloud();
  const dirs = await signedInAndLinked(cloud);
  const report = await run(['status'], {}, { ...dirs, fetchImpl: cloud.fetchImpl });
  assert.equal(report.blueprintHash, HASH);
  assert.deepEqual(report.models, [{ name: 'quote', fields: ['discount:number'] }]);
  assert.equal(report.approvals[0].name, 'big_discount');
});

test('push is one revision from accordo.cloud.json, against the hash it read, and re-running it is the same one', async () => {
  const cloud = fakeCloud();
  const dirs = await signedInAndLinked(cloud);
  const declared = { models: [{ name: 'quote', label: 'Quotes', fields: [{ name: 'discount', label: 'Discount', type: 'number' }] }],
    approvals: [{ name: 'big_discount', label: 'Discount above 20', model: 'quote', field: 'discount', above: 20 }] };
  writeFileSync(join(dirs.projectRoot, 'accordo.cloud.json'), JSON.stringify(declared));
  const first = await run(['push'], {}, { ...dirs, fetchImpl: cloud.fetchImpl });
  assert.equal(first.outcome, 'applied');
  const sent = cloud.calls.find((c) => c.path.endsWith('/revisions')).body;
  assert.equal(sent.expectedBlueprintHash, HASH);
  assert.deepEqual(sent.patch, declared);
  const again = await run(['push'], {}, { ...dirs, fetchImpl: cloud.fetchImpl });
  assert.equal(again.duplicate, true);

  writeFileSync(join(dirs.projectRoot, 'accordo.cloud.json'), JSON.stringify({ ...declared, modules: ['x'] }));
  await assert.rejects(() => run(['push'], {}, { ...dirs, fetchImpl: cloud.fetchImpl }), { code: 'CLOUD_FILE_REFUSED' },
    'the file carries models and approvals, never identity or modules');
});

test('propose goes to the CRM as the agent, and names the status page under the workspace', async () => {
  const cloud = fakeCloud();
  const dirs = await signedInAndLinked(cloud);
  const report = await run(['propose', 'quote', 'q-1'], { values: '{"discount":25,"customer":"Acme"}' }, { ...dirs, fetchImpl: cloud.fetchImpl });
  assert.equal(report.status, `${WEB}/w/${WORKSPACE}/actions/req-1?returnTo=%2Frecords`);
  const post = cloud.calls.find((c) => c.path === `/w/${WORKSPACE}/records`);
  assert.equal(post.headers.cookie, 'accordo_session=agent-crm-session', 'the agent session, never the operator one');
  assert.equal(post.headers.origin, WEB);
  const form = new URLSearchParams(post.body);
  assert.equal(form.get('field.discount'), '25');
  assert.equal(form.get('recordId'), 'q-1');
  await assert.rejects(() => run(['propose', 'quote'], { values: '[1]' }, { ...dirs, fetchImpl: cloud.fetchImpl }),
    { code: 'CLOUD_VALUES_REFUSED' });
});

test('nothing runs against a project that is not linked or a terminal that is not signed in', async () => {
  const cloud = fakeCloud();
  const dirs = project();
  await assert.rejects(() => run(['status'], {}, { ...dirs, fetchImpl: cloud.fetchImpl }), { code: 'CLOUD_NOT_LINKED' });
  await run(['link', WORKSPACE], { origin: ORIGIN }, { ...dirs, fetchImpl: cloud.fetchImpl });
  await assert.rejects(() => run(['status'], {}, { ...dirs, fetchImpl: cloud.fetchImpl }), { code: 'CLOUD_NOT_SIGNED_IN' });
  await assert.rejects(() => run(['approve'], {}, { ...dirs, fetchImpl: cloud.fetchImpl }), { code: 'CLOUD_COMMAND_UNKNOWN' },
    'there is no approve: the owner decides in the CRM');
  await assert.rejects(() => run(['login'], { origin: 'http://cloud.example.test' }, { ...dirs, fetchImpl: cloud.fetchImpl }),
    { code: 'CLOUD_ORIGIN_REFUSED' });
});

test('pull writes the workspace as it is, so a push starts from everything that exists', async () => {
  const cloud = fakeCloud();
  const dirs = await signedInAndLinked(cloud);
  const report = await run(['pull'], {}, { ...dirs, fetchImpl: cloud.fetchImpl });
  assert.equal(report.wrote, 'accordo.cloud.json');
  const written = JSON.parse(readFileSync(join(dirs.projectRoot, 'accordo.cloud.json'), 'utf8'));
  assert.deepEqual(Object.keys(written), ['models', 'approvals']);
  assert.equal(written.models[0].name, 'quote');
  assert.equal(written.approvals[0].name, 'big_discount');
  const pushed = await run(['push'], {}, { ...dirs, fetchImpl: cloud.fetchImpl });
  assert.equal(pushed.outcome, 'applied', 'what pull wrote is a file push accepts');
});
