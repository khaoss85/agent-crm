// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * **`crm cloud` — the bridge from a project to its Accordo Cloud workspace.**
 *
 * A coding agent builds and checks the CRM here, in source the customer owns;
 * the free Cloud workspace runs what a Project Blueprint can express — record
 * types, fields and approval gates — on shared capacity. These commands carry
 * the one into the other, and carry nothing else:
 *
 *   cloud login                       GitHub sign-in through the browser, back to a
 *                                     loopback port (RFC 8252); keeps an operator
 *                                     session in the user's config, mode 0600
 *   cloud link <workspaceId>          remembers which workspace this project is
 *   cloud status                      the linked workspace's Blueprint, hash and gates
 *   cloud push [--file <path>]        one Blueprint revision from accordo.cloud.json:
 *                                     `models` (additive only) and `approvals`
 *   cloud propose <model> [<id>] --values '<json>'
 *                                     one record change, as the agent: written, or
 *                                     held for the owner's decision in the CRM
 *
 * There is no `approve`. The agent proposes and the owner decides, in the CRM,
 * with a session the agent does not have: the Cloud refuses a decision from an
 * agent session and from the direct operator path alike.
 *
 * Every network answer is reported with its code; nothing is retried blind and
 * no credential is printed.
 */

export const CLOUD_DEFAULT_ORIGIN = 'https://cloud.accordo.dev';
export const CLOUD_FILE = 'accordo.cloud.json';

export class CloudRefused extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'CloudRefused';
    this.code = code;
  }
}

/**
 * @typedef {object} CloudDeps
 * @property {typeof fetch} fetchImpl
 * @property {(url: string) => void} openBrowser
 * @property {string} home         Where the operator session is kept.
 * @property {string} projectRoot  Where the link and accordo.cloud.json live.
 * @property {(line: string) => void} print
 * @property {() => number} [now]
 * @property {typeof createServer} [listen]
 */

/** @param {string[]} positional @param {Record<string, unknown>} flags @param {Partial<CloudDeps>} [overrides] */
export async function runCloudCommand(positional, flags, overrides = {}) {
  /** @type {CloudDeps} */
  const deps = {
    fetchImpl: globalThis.fetch,
    openBrowser: defaultOpenBrowser,
    home: process.env.ACCORDO_CLOUD_HOME ?? join(homedir(), '.config', 'accordo'),
    projectRoot: typeof flags.root === 'string' ? resolve(String(flags.root)) : process.cwd(),
    print: (line) => console.log(line),
    now: () => Date.now(),
    ...overrides,
  };
  const [sub, ...rest] = positional;
  const json = flags.json === true;
  const emit = (report) => deps.print(json ? JSON.stringify(report, null, 2) : human(report));
  switch (sub) {
    case 'login': return emit(await login(deps, originFrom(flags)));
    case 'link': return emit(link(deps, rest[0], originFrom(flags)));
    case 'status': return emit(await status(deps));
    case 'push': return emit(await push(deps, typeof flags.file === 'string' ? flags.file : CLOUD_FILE));
    case 'propose': return emit(await propose(deps, rest[0], rest[1], flags.values));
    default:
      throw new CloudRefused('CLOUD_COMMAND_UNKNOWN',
        'use one of: cloud login | link <workspaceId> | status | push | propose <model> [<id>] --values <json>');
  }
}

function originFrom(flags) {
  const origin = String(flags.origin ?? process.env.ACCORDO_CLOUD_URL ?? CLOUD_DEFAULT_ORIGIN).replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new CloudRefused('CLOUD_ORIGIN_REFUSED', 'the Cloud origin is not a URL');
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1') {
    throw new CloudRefused('CLOUD_ORIGIN_REFUSED', 'the Cloud origin must be https');
  }
  return parsed.origin;
}

// ---------------------------------------------------------------- login

async function login(deps, origin) {
  const cliState = randomBytes(16).toString('hex');
  const listen = deps.listen ?? createServer;
  const received = await new Promise((resolveCode, reject) => {
    const server = listen((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        response.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('cli_state');
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        .end(state === cliState && code ? 'Signed in. You can close this tab and return to your terminal.'
          : 'This sign-in did not come from your terminal; nothing was accepted.');
      server.close();
      if (state !== cliState || !code) reject(new CloudRefused('CLOUD_LOGIN_STATE_REFUSED',
        'the browser returned a sign-in this terminal did not start'));
      else resolveCode(code);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const returnTo = `http://127.0.0.1:${port}/callback?cli_state=${cliState}`;
      const begin = `${origin}/v1/oauth/github/begin?returnTo=${encodeURIComponent(returnTo)}`;
      deps.print(`Opening your browser to sign in with GitHub. If it does not open, visit:\n  ${begin}`);
      deps.openBrowser(begin);
    });
  });
  const answer = await call(deps, `${origin}/v1/oauth/console-session`, { method: 'POST', body: { code: received } });
  const session = { origin, session: answer.session, operatorAccountId: answer.operatorAccountId };
  writePrivate(join(deps.home, 'cloud-session.json'), session);
  return { ok: true, command: 'cloud login', origin, signedIn: true };
}

// ---------------------------------------------------------------- link / status

function link(deps, workspaceId, origin) {
  if (typeof workspaceId !== 'string' || !/^[0-9a-f-]{36}$/.test(workspaceId)) {
    throw new CloudRefused('CLOUD_WORKSPACE_REQUIRED', 'name the workspace id shown in the Cloud Console');
  }
  const path = join(deps.projectRoot, '.accordo', 'cloud.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ origin, workspaceId }, null, 2)}\n`);
  return { ok: true, command: 'cloud link', origin, workspaceId, wrote: '.accordo/cloud.json' };
}

async function status(deps) {
  const { origin, workspaceId, bearer } = linked(deps);
  const { workspace } = await call(deps, `${origin}/v1/workspaces/${workspaceId}`, { bearer });
  return {
    ok: true, command: 'cloud status', origin, workspaceId,
    blueprintHash: workspace.blueprintHash,
    models: (workspace.blueprint?.models ?? []).map((m) => ({ name: m.name, fields: m.fields.map((f) => `${f.name}:${f.type}`) })),
    approvals: workspace.blueprint?.approvals ?? [],
  };
}

// ---------------------------------------------------------------- push

async function push(deps, file) {
  const { origin, workspaceId, bearer } = linked(deps);
  const path = resolve(deps.projectRoot, file);
  if (!existsSync(path)) throw new CloudRefused('CLOUD_FILE_MISSING', `${file} does not exist; it declares models and approvals`);
  let declared;
  try {
    declared = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new CloudRefused('CLOUD_FILE_REFUSED', `${file} is not JSON`);
  }
  const patch = {};
  for (const key of Object.keys(declared ?? {})) {
    if (!['models', 'approvals'].includes(key)) {
      throw new CloudRefused('CLOUD_FILE_REFUSED', `${file} may declare models and approvals, not ${key}`);
    }
    patch[key] = declared[key];
  }
  if (Object.keys(patch).length === 0) throw new CloudRefused('CLOUD_FILE_REFUSED', `${file} declares nothing`);
  const { workspace } = await call(deps, `${origin}/v1/workspaces/${workspaceId}`, { bearer });
  // The request key is the patch and the Blueprint it was computed against:
  // re-running the same push is the same revision, not a second one.
  const requestKey = `cli-${createHash('sha256').update(workspace.blueprintHash + JSON.stringify(patch)).digest('hex').slice(0, 40)}`;
  const answer = await call(deps, `${origin}/v1/workspaces/${workspaceId}/revisions`, {
    method: 'POST', bearer, allow: [409],
    body: { expectedBlueprintHash: workspace.blueprintHash, requestKey, patch },
  });
  const revision = answer.revision;
  return {
    ok: revision?.outcome === 'applied', command: 'cloud push', workspaceId,
    outcome: revision?.outcome, refusalCode: revision?.refusalCode ?? null,
    blueprintHash: revision?.resultingBlueprintHash ?? workspace.blueprintHash, duplicate: answer.duplicate === true,
  };
}

// ---------------------------------------------------------------- propose

async function propose(deps, model, recordId, rawValues) {
  const { origin, workspaceId, bearer } = linked(deps);
  if (typeof model !== 'string' || model === '') throw new CloudRefused('CLOUD_MODEL_REQUIRED', 'name the record type');
  let values;
  try {
    values = JSON.parse(String(rawValues ?? ''));
  } catch {
    throw new CloudRefused('CLOUD_VALUES_REFUSED', '--values is a JSON object, for example {"discount":25}');
  }
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new CloudRefused('CLOUD_VALUES_REFUSED', '--values is a JSON object, for example {"discount":25}');
  }
  const agent = await call(deps, `${origin}/v1/workspaces/${workspaceId}/agent-session`, { method: 'POST', bearer, body: {} });
  if (!agent.webOrigin) throw new CloudRefused('CLOUD_WORKSPACE_WEB_UNKNOWN', 'the workspace has no CRM address yet');
  const form = new URLSearchParams({ model, recordId: recordId ?? '' });
  for (const [name, value] of Object.entries(values)) form.set(`field.${name}`, String(value));
  const target = `${agent.webOrigin}${agent.path}/records`;
  const response = await deps.fetchImpl(target, {
    method: 'POST', redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `accordo_session=${agent.session}`,
      origin: agent.webOrigin,
    },
    body: form.toString(),
  });
  if (response.status !== 303) {
    const text = (await response.text().catch(() => '')).slice(0, 300);
    const code = /^([A-Z][A-Z0-9_]+):/.exec(text)?.[1] ?? `HTTP_${response.status}`;
    throw new CloudRefused(code, text || 'the CRM did not accept the change');
  }
  const location = response.headers.get('location') ?? '';
  return {
    ok: true, command: 'cloud propose', workspaceId, model,
    // The CRM answers with a path under its own root; behind the shared
    // web it lives under the workspace mount, so the mount is put back.
    status: `${agent.webOrigin}${location.startsWith(agent.path) ? '' : agent.path}${location}`,
    note: 'The workspace validates the change and either writes it or holds it for the owner on /approvals.',
  };
}

// ---------------------------------------------------------------- plumbing

function linked(deps) {
  const linkPath = join(deps.projectRoot, '.accordo', 'cloud.json');
  if (!existsSync(linkPath)) throw new CloudRefused('CLOUD_NOT_LINKED', 'run `crm cloud link <workspaceId>` in this project first');
  const { origin, workspaceId } = JSON.parse(readFileSync(linkPath, 'utf8'));
  const sessionPath = join(deps.home, 'cloud-session.json');
  if (!existsSync(sessionPath)) throw new CloudRefused('CLOUD_NOT_SIGNED_IN', 'run `crm cloud login` first');
  const saved = JSON.parse(readFileSync(sessionPath, 'utf8'));
  if (saved.origin !== origin) {
    throw new CloudRefused('CLOUD_ORIGIN_MISMATCH', `signed in to ${saved.origin}, but this project is linked to ${origin}`);
  }
  return { origin, workspaceId, bearer: saved.session };
}

async function call(deps, url, { method = 'GET', bearer = null, body = undefined, allow = [] } = {}) {
  let response;
  try {
    response = await deps.fetchImpl(url, {
      method,
      redirect: 'error',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new CloudRefused('CLOUD_UNREACHABLE', `${new URL(url).origin} did not answer`);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok && !allow.includes(response.status)) {
    const code = typeof data?.error === 'string' ? data.error : `HTTP_${response.status}`;
    if (code === 'SESSION_EXPIRED' || code === 'OPERATOR_AUTH_REQUIRED') {
      throw new CloudRefused(code, 'sign in again with `crm cloud login`');
    }
    throw new CloudRefused(code, 'the Cloud refused the request');
  }
  return data ?? {};
}

function writePrivate(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function human(report) {
  const lines = [`${report.command}: ${report.ok ? 'ok' : 'refused'}`];
  for (const [key, value] of Object.entries(report)) {
    if (['ok', 'command'].includes(key)) continue;
    lines.push(`  ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

function defaultOpenBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  import('node:child_process').then(({ spawn }) => {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }).catch(() => {});
}
