// @ts-check

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from './router.js';
import {
  AppError,
  NotFoundError,
  ValidationError,
  normalizeError,
} from '../../../packages/core/src/errors.js';
import { isExposableGeneratedModule } from '../../../packages/core/src/generated-module-contract.js';

const DEFAULT_PUBLIC_DIR = resolve(
  fileURLToPath(new URL('../../admin/public', import.meta.url)),
);

/**
 * Marks a handler return value as an explicit {status, body} envelope.
 *
 * Handlers may return any domain object directly (served as 200). Tagging the
 * envelope with a Symbol — rather than sniffing for `status`/`body` properties —
 * keeps that ambiguity impossible: a generated module is free to have fields
 * literally named `status` or `body` without hijacking the HTTP response.
 */
const RESPONSE_ENVELOPE = Symbol('agent-crm.responseEnvelope');

/** @param {number} status @param {unknown} body */
function respond(status, body) {
  return { [RESPONSE_ENVELOPE]: true, status, body };
}

/** @param {unknown} value */
function isResponseEnvelope(value) {
  return typeof value === 'object' && value !== null && /** @type {any} */ (value)[RESPONSE_ENVELOPE] === true;
}

/** @param {any} app @param {{publicDir?: string}} [options] */
export function createHttpServer(app, options = {}) {
  const publicDir = resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);
  const router = buildRouter(app);

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const route = router.match(request.method ?? 'GET', url.pathname);

      if (route) {
        const writesBody = ['POST', 'PUT', 'PATCH'].includes(request.method ?? '');
        // A route may opt into the RAW body (ADR-017): a signature-verified
        // payload must be checked as the exact bytes the provider signed, so
        // parsing-then-reserializing is not an option.
        const rawBody = writesBody && route.options?.rawBody
          ? await readRawBody(request, route.options.maxBodyBytes ?? 65_536)
          : null;
        const body = writesBody && !route.options?.rawBody ? await readJson(request) : null;
        const result = await route.handler({
          request,
          response,
          params: route.params,
          query: Object.fromEntries(url.searchParams.entries()),
          searchParams: url.searchParams,
          body,
          rawBody,
          headers: request.headers,
          actor: actorFromRequest(request),
        });
        if (!response.writableEnded) {
          // A handler either returns a tagged envelope (explicit status) or a
          // plain payload served as 200. The tag is a Symbol, never a plain
          // "status"/"body" property, so a domain object that happens to carry
          // its own `status` field — a lead with status "qualified", say — can
          // never be mistaken for an envelope and turned into an HTTP status.
          const envelope = isResponseEnvelope(result) ? result : { status: 200, body: result };
          sendJson(response, envelope.status, envelope.body);
        }
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

  router.add('GET', '/health', async () => app.doctor());

  router.add('GET', '/api/schema', async () => ({
    schema: app.schema,
    generatedResourceContract: 1,
    modules: app.modules.list(),
    generatedModules: app.modules
      .list()
      .filter((module) => isExposableGeneratedModule(app.modules.get(module.name)))
      .map((module) => generatedModuleMetadata(app.modules.get(module.name), app.actions.listForModule(module.name))),
    workflows: app.workflows.list(),
    providers: app.providers.list(),
    // Code-first pipelines (ADR-014). Additive: an older client ignores it.
    pipelineContract: 1,
    pipelines: app.pipelines.list(),
    // Actions registered on action-eligible CORE modules (ADR-014) — generated
    // modules carry theirs inside generatedModules[].actions.
    coreModuleActions: Object.fromEntries(
      (app.actionEligibleCoreModules ?? [])
        .filter((name) => app.actions.listForModule(name).length > 0)
        .map((name) => [name, app.actions.listForModule(name)]),
    ),
    // Lead Intelligence registries (ADR-015): safe, function-free metadata —
    // provider/model/policy identities, fingerprints and target data, never
    // executable rules. Additive: an older client ignores it.
    ...(app.intelligence ? { intelligence: app.intelligence.metadata() } : {}),
    // Commercial Operations registries (ADR-016): catalog providers, discount
    // policies, money/discount contract. Additive; function-free.
    ...(app.commercial ? { commercial: app.commercial.metadata() } : {}),
    // Signature providers and the envelope/order contract (ADR-017). Never a
    // verification secret, an executable handler, a raw provider payload or an
    // internal storage path. Additive; function-free.
    ...(app.signature ? { signature: app.signature.metadata() } : {}),
  }));

  // Catalog synchronization (ADR-016). Local-development surface like every
  // other write route; the provider call runs outside the write transaction.
  router.add('POST', '/api/catalog/sync', async ({ body, actor }) => {
    if (typeof app.syncCatalog !== 'function') {
      throw new NotFoundError('Operation', 'catalog sync');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    if (typeof input.provider !== 'string' || input.provider === '') {
      throw new ValidationError('provider is required', { field: 'provider' });
    }
    return app.syncCatalog({ provider: input.provider, input: input.input, actor });
  });

  // Signature provider events (ADR-017). A dedicated route, NOT a record
  // action: the payload arrives from outside, must be verified as the exact
  // bytes the provider signed before any state is touched, and its identity
  // is a provider event id rather than a CRM record id. The raw body is
  // bounded to 64 KiB, the provider is selected canonically from the path,
  // and a verification failure is a stable 401 that never echoes the payload,
  // the signature or the key.
  router.add('POST', '/api/signature/providers/:provider/events', async ({ params, rawBody, headers, actor }) => {
    if (typeof app.ingestSignatureEvent !== 'function') {
      throw new NotFoundError('Operation', 'signature events');
    }
    return app.ingestSignatureEvent({
      provider: params.provider,
      rawBody: rawBody ?? Buffer.alloc(0),
      headers: safeSignatureHeaders(headers),
      // The webhook is not an authenticated CRM user: it is the provider
      // integration acting, and it is recorded as such.
      actor: { type: 'system', id: `signature:${params.provider}` },
    });
  }, { rawBody: true, maxBodyBytes: 65_536 });

  // Explicit envelope reconciliation (ADR-017). No background scheduler ships
  // in this milestone: recovery is always an explicit, audited operation.
  router.add('POST', '/api/signature/envelopes/:id/reconcile', async ({ params, actor }) => {
    if (typeof app.reconcileSignature !== 'function') {
      throw new NotFoundError('Operation', 'signature reconciliation');
    }
    return app.reconcileSignature({ envelopeId: params.id, actor });
  });

  // Uniform resource surface for generated modules (ADR-008). Only modules
  // that fully satisfy the generated-module contract are served; anything
  // else — unknown names, handwritten core modules, malformed or hand-edited
  // definitions — fails closed as 404. This is a framework contract against
  // accidental misuse, not a sandbox against malicious source-code changes.
  router.add('GET', '/api/modules/:module', async ({ params }) => {
    const module = resolveGeneratedModule(app, params.module);
    return generatedModuleMetadata(module, app.actions.listForModule(module.name));
  });
  router.add('GET', '/api/modules/:module/records', async ({ params, searchParams }) => {
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'list');
    return { items: module.service.list({ limit: strictLimit(searchParams) }) };
  });
  router.add('POST', '/api/modules/:module/records', async ({ params, body, actor }) => {
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'create');
    return respond(201, await module.service.create(recordInput(body), { actor }));
  });
  router.add('GET', '/api/modules/:module/records/:id', async ({ params }) => {
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'get');
    return module.service.get(params.id);
  });
  router.add('PATCH', '/api/modules/:module/records/:id', async ({ params, body, actor }) => {
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'update');
    return module.service.update(params.id, recordInput(body), { actor });
  });

  // Code-first actions over the generic surface (ADR-011/014). The route only
  // resolves the module and delegates to the action runtime — it never writes
  // to the database directly. Eligible targets are exposable generated
  // modules, plus handwritten core modules that have at least one action
  // registered (registration in checked-in source IS the explicit eligibility
  // declaration — core CRUD stays on its dedicated routes and is never served
  // by the generic records surface). Anything else is a 404; unknown action
  // 404; bad input 400; invalid transition a stable 409.
  router.add('POST', '/api/modules/:module/records/:id/actions/:action', async ({ params, body, actor }) => {
    resolveActionableModule(app, params.module); // 404 for unknown/ineligible modules
    return app.runAction({
      module: params.module,
      action: params.action,
      recordId: params.id,
      input: actionInput(body),
      actor,
    });
  });

  router.add('GET', '/api/companies', async ({ query }) => ({
    items: app.services.companies.list({ limit: parseLimit(query.limit) }),
  }));
  router.add('POST', '/api/companies', async ({ body, actor }) => (
    respond(201, await app.services.companies.create(body ?? {}, { actor }))
  ));

  router.add('GET', '/api/contacts', async ({ query }) => ({
    items: app.services.contacts.list({
      companyId: query.companyId,
      limit: parseLimit(query.limit),
    }),
  }));
  router.add('POST', '/api/contacts', async ({ body, actor }) => (
    respond(201, await app.services.contacts.create(body ?? {}, { actor }))
  ));

  router.add('GET', '/api/opportunities', async ({ query }) => ({
    items: app.services.opportunities.list({
      stage: query.stage,
      type: query.type,
      companyId: query.companyId,
      limit: parseLimit(query.limit),
    }),
  }));
  router.add('POST', '/api/opportunities', async ({ body, actor }) => (
    respond(201, await app.services.opportunities.create(body ?? {}, { actor }))
  ));
  router.add('GET', '/api/opportunities/:id', async ({ params }) => (
    app.services.opportunities.get(params.id)
  ));
  router.add('POST', '/api/opportunities/:id/stage', async ({ params, body, actor }) => (
    app.workflows.run(
      'request-opportunity-stage-change',
      { opportunityId: params.id, targetStage: body?.targetStage },
      { actor },
    )
  ));

  router.add('GET', '/api/approvals', async ({ query }) => ({
    items: app.services.approvals.list({
      status: query.status,
      opportunityId: query.opportunityId,
      limit: parseLimit(query.limit),
    }),
  }));
  router.add('POST', '/api/approvals/:id/approve', async ({ params, actor }) => (
    app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: params.id, decision: 'approved' },
      { actor },
    )
  ));
  router.add('POST', '/api/approvals/:id/reject', async ({ params, actor }) => (
    app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: params.id, decision: 'rejected' },
      { actor },
    )
  ));

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

  router.add('POST', '/api/demo/seed', async () => respond(201, await app.seedDemo()));
  router.add('POST', '/api/demo/run', async () => app.runDemo());

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

/**
 * Read the exact request bytes for a signature-verified route, bounded. The
 * body is returned as a Buffer and never decoded or parsed here: a decode
 * would replace invalid UTF-8 and the MAC must cover exactly the bytes the
 * provider signed.
 * @param {import('node:http').IncomingMessage} request @param {number} maxBytes
 */
async function readRawBody(request, maxBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new AppError('Request body too large', { code: 'PAYLOAD_TOO_LARGE', status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Only the bounded header values a signature provider is allowed to see. The
 * whole header bag is never handed to provider code, and nothing here is ever
 * logged or echoed back.
 * @param {import('node:http').IncomingHttpHeaders} headers
 */
function safeSignatureHeaders(headers) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of ['x-signature-256', 'x-signature-timestamp', 'x-provider-event-id']) {
    const value = headers?.[name];
    if (typeof value === 'string' && value.length <= 512) out[name] = value;
  }
  return out;
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

/**
 * Resolve a module for the generic generated-module surface. Anything that
 * does not fully satisfy the generated-module contract — unknown names,
 * handwritten core modules, malformed or hand-edited definitions — fails
 * closed as 404 on this surface. The ModuleRegistry is Map-backed, so names
 * like __proto__ or constructor can never resolve to inherited properties.
 *
 * @param {any} app @param {string} name
 */
function resolveGeneratedModule(app, name) {
  let module;
  try {
    module = app.modules.get(name);
  } catch {
    throw new NotFoundError('Generated module', name);
  }
  if (module.name !== name || !isExposableGeneratedModule(module)) {
    throw new NotFoundError('Generated module', name);
  }
  return module;
}

/**
 * Resolve a module for the ACTION surface only (ADR-014): an exposable
 * generated module, or a core module with at least one registered action —
 * explicit registration in checked-in source is the eligibility declaration.
 * Everything else fails closed as 404. Never used for the CRUD records routes.
 *
 * @param {any} app @param {string} name
 */
function resolveActionableModule(app, name) {
  try {
    return resolveGeneratedModule(app, name);
  } catch (generatedError) {
    let module;
    try {
      module = app.modules.get(name);
    } catch {
      throw generatedError;
    }
    if (module.name === name && app.actions.listForModule(name).length > 0) return module;
    throw generatedError;
  }
}

/** @param {any} module @param {string} capability */
function requireCapability(module, capability) {
  if (!module.capabilities.includes(capability)) {
    throw new NotFoundError(`Generated module operation ${capability}`, module.name);
  }
  return module;
}

/**
 * Record input on the generic surface must be a plain JSON object; arrays and
 * primitives are a 400 instead of confusing downstream validation errors.
 *
 * @param {unknown} body
 */
function recordInput(body) {
  if (body === null || body === undefined) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object');
  }
  return body;
}

/**
 * Action input on the generic surface: an omitted body is an empty input; a
 * present body must be a plain JSON object. The action runtime performs the
 * field-level validation, but rejecting arrays/primitives here keeps the 400
 * message about the shape rather than a confusing per-field error.
 *
 * @param {unknown} body
 */
function actionInput(body) {
  if (body === null || body === undefined) return {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Action input must be a JSON object');
  }
  return body;
}

/** @param {any} module @param {any[]} [actions] */
function generatedModuleMetadata(module, actions = []) {
  return {
    name: module.name,
    description: module.description ?? null,
    kind: module.kind,
    manifestVersion: module.manifestVersion ?? 1,
    capabilities: module.capabilities,
    fields: module.fields ?? [],
    immutableFields: module.immutableFields ?? ['id', 'createdAt', 'updatedAt'],
    // Code-first actions available on this module (ADR-011). Additive under
    // generatedResourceContract 1: an older client simply ignores it.
    actions,
    paths: {
      metadata: `/api/modules/${module.name}`,
      collection: `/api/modules/${module.name}/records`,
      record: `/api/modules/${module.name}/records/:id`,
    },
  };
}

/**
 * Strict limit parsing for the generated-module surface. Canonical accepted
 * syntax: a single base-10 positive integer between 1 and 500 — no sign, no
 * exponent, no hex, no whitespace, no duplicates. Anything else is a 400
 * instead of a silent behavior change. (Core endpoints keep their historical
 * lenient parsing; the generated service itself remains the final boundary.)
 *
 * @param {URLSearchParams} searchParams
 */
function strictLimit(searchParams) {
  const values = searchParams.getAll('limit');
  if (values.length === 0) return undefined;
  if (values.length > 1) {
    throw new ValidationError('limit must not be repeated', { limit: values });
  }
  const value = values[0];
  if (value === '') return undefined;
  if (!/^\d+$/.test(value)) {
    throw new ValidationError('limit must be a base-10 positive integer', { limit: value });
  }
  const parsed = Number(value);
  if (parsed < 1 || parsed > 500) {
    throw new ValidationError('limit must be between 1 and 500', { limit: parsed });
  }
  return parsed;
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
