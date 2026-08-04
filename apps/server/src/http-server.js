// @ts-check

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './router.js';
import { AppError, normalizeError } from '../../../packages/core/src/errors.js';

const DEFAULT_PUBLIC_DIR = resolve(
  fileURLToPath(new URL('../../admin/public', import.meta.url)),
);

/** @param {any} app @param {{publicDir?: string}} [options] */
export function createHttpServer(app, options = {}) {
  const publicDir = resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);
  const router = buildRouter(app);

  return createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const route = router.match(request.method ?? 'GET', url.pathname);

    try {
      if (route) {
        const body = ['POST', 'PUT', 'PATCH'].includes(request.method ?? '')
          ? await readJson(request)
          : null;
        const result = await route.handler({
          request,
          response,
          params: route.params,
          query: Object.fromEntries(url.searchParams.entries()),
          body,
          actor: actorFromRequest(request),
        });
        if (!response.writableEnded) sendJson(response, result?.status ?? 200, result?.body ?? result);
        return;
      }

      if ((request.method ?? 'GET') === 'GET') {
        const served = await serveStatic(publicDir, url.pathname, response);
        if (served) return;
      }

      sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
    } catch (error) {
      const normalizedError = normalizeError(error);
      sendJson(response, normalizedError.status, {
        error: {
          code: normalizedError.code,
          message: normalizedError.message,
          details: normalizedError.details ?? null,
        },
      });
    }
  });
}

/** @param {any} app */
function buildRouter(app) {
  const router = new Router();

  router.add('GET', '/health', async () => ({
    status: 200,
    body: app.doctor(),
  }));

  router.add('GET', '/api/schema', async () => ({
    schema: app.schema,
    modules: app.modules.list(),
    workflows: app.workflows.list(),
    providers: app.providers.list(),
  }));

  router.add('GET', '/api/companies', async ({ query }) => ({
    items: app.services.companies.list({ limit: parseLimit(query.limit) }),
  }));
  router.add('POST', '/api/companies', async ({ body, actor }) => ({
    status: 201,
    body: await app.services.companies.create(body ?? {}, { actor }),
  }));

  router.add('GET', '/api/contacts', async ({ query }) => ({
    items: app.services.contacts.list({
      companyId: query.companyId,
      limit: parseLimit(query.limit),
    }),
  }));
  router.add('POST', '/api/contacts', async ({ body, actor }) => ({
    status: 201,
    body: await app.services.contacts.create(body ?? {}, { actor }),
  }));

  router.add('GET', '/api/opportunities', async ({ query }) => ({
    items: app.services.opportunities.list({
      stage: query.stage,
      type: query.type,
      companyId: query.companyId,
      limit: parseLimit(query.limit),
    }),
  }));
  router.add('POST', '/api/opportunities', async ({ body, actor }) => ({
    status: 201,
    body: await app.services.opportunities.create(body ?? {}, { actor }),
  }));
  router.add('GET', '/api/opportunities/:id', async ({ params }) => (
    app.services.opportunities.get(params.id)
  ));
  router.add('POST', '/api/opportunities/:id/stage', async ({ params, body, actor }) => ({
    status: 200,
    body: await app.workflows.run(
      'request-opportunity-stage-change',
      { opportunityId: params.id, targetStage: body?.targetStage },
      { actor },
    ),
  }));

  router.add('GET', '/api/approvals', async ({ query }) => ({
    items: app.services.approvals.list({
      status: query.status,
      opportunityId: query.opportunityId,
      limit: parseLimit(query.limit),
    }),
  }));
  router.add('POST', '/api/approvals/:id/approve', async ({ params, actor }) => ({
    status: 200,
    body: await app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: params.id, decision: 'approved' },
      { actor },
    ),
  }));
  router.add('POST', '/api/approvals/:id/reject', async ({ params, actor }) => ({
    status: 200,
    body: await app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: params.id, decision: 'rejected' },
      { actor },
    ),
  }));

  router.add('GET', '/api/traces', async ({ query }) => ({
    items: app.workflows.listRuns({
      status: query.status,
      workflowName: query.workflowName,
      limit: parseLimit(query.limit),
    }),
  }));
  router.add('GET', '/api/traces/:id', async ({ params }) => app.workflows.getRun(params.id));

  router.add('GET', '/api/audit', async ({ query }) => ({
    items: app.audit.list({
      entityType: query.entityType,
      entityId: query.entityId,
      limit: parseLimit(query.limit),
    }),
  }));

  router.add('GET', '/api/notifications', async () => ({ items: app.notifications.list() }));

  router.add('POST', '/api/demo/seed', async () => ({
    status: 201,
    body: await app.seedDemo(),
  }));
  router.add('POST', '/api/demo/run', async () => ({
    status: 200,
    body: await app.runDemo(),
  }));

  return router;
}

/** @param {import('node:http').IncomingMessage} request */
function actorFromRequest(request) {
  const typeHeader = request.headers['x-actor-type'];
  const idHeader = request.headers['x-actor-id'];
  const type = typeof typeHeader === 'string' && ['user', 'agent', 'system'].includes(typeHeader)
    ? typeHeader
    : 'user';
  const id = typeof idHeader === 'string' && idHeader.trim() ? idHeader.trim() : 'api-user';
  return { type, id };
}

/** @param {import('node:http').IncomingMessage} request */
async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) {
      throw new AppError('Request body too large', { code: 'PAYLOAD_TOO_LARGE', status: 413 });
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError('Request body must be valid JSON', { code: 'INVALID_JSON', status: 400 });
  }
}

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} body */
function sendJson(response, status, body) {
  if (response.writableEnded) return;
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

/** @param {string} publicDir @param {string} pathname @param {import('node:http').ServerResponse} response */
async function serveStatic(publicDir, pathname, response) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) return false;
  try {
    const data = await readFile(filePath);
    response.writeHead(200, {
      'content-type': mimeType(extname(filePath)),
      'content-length': data.byteLength,
      'cache-control': 'no-cache',
    });
    response.end(data);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/** @param {string | undefined} value */
function parseLimit(value) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/** @param {string} extension */
function mimeType(extension) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
  }[extension] ?? 'application/octet-stream';
}
