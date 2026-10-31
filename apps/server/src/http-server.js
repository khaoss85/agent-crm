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
import { refuseThenableDomainValue } from '../../../packages/core/src/async-values.js';
import { isExposableGeneratedModule } from '../../../packages/core/src/generated-module-contract.js';
import { stripServerControlledKeys } from '../../../packages/core/src/actor.js';
import { assertBindAddress } from '../../../packages/core/src/tenant-binding.js';
import { requireIdempotencyKey } from '../../../packages/core/src/idempotency.js';
import { connectionSecretRef } from '../../../packages/channels/src/connection.js';
import { SPACE_PACKAGE_CATALOG } from '../../../packages/space-permissions/src/composition.js';
import { compileReport, runReport } from '../../../packages/analytics/src/compiler.js';
import {
  buildDashboardModel,
  dashboardSpecs,
  parseDashboardQuery,
} from '../../../packages/analytics/src/dashboard.js';

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
const RESPONSE_ENVELOPE = Symbol('accordo.responseEnvelope');

/** @param {number} status @param {unknown} body @param {Record<string, string>} [headers] */
function respond(status, body, headers = {}) {
  return { [RESPONSE_ENVELOPE]: true, status, body, headers };
}

/**
 * @param {import('node:http').IncomingHttpHeaders | undefined} headers
 */
function readIdempotencyHeader(headers) {
  const raw = headers?.['idempotency-key'];
  if (raw == null || raw === '') return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return requireIdempotencyKey(value);
}

/**
 * @param {any} app
 * @param {{ actor?: unknown, identity?: any, organizationId?: string | null, headers?: import('node:http').IncomingHttpHeaders }} ctx
 */
function writeContext(app, ctx) {
  const tenantId = ctx.identity?.organizationId
    ?? ctx.identity?.tenantId
    ?? ctx.organizationId
    ?? null;
  return {
    actor: ctx.actor,
    identity: ctx.identity,
    tenantId,
    idempotencyKey: readIdempotencyHeader(ctx.headers),
  };
}

// Connectors (BO-F1-02): one finish request pulls at most this many history
// pages of this many events. Exported so the bound test pins the exact page
// budget instead of a magic number.
/** @type {number} */
export const CONNECTORS_FINISH_PAGE_LIMIT = 50;
/** @type {number} */
export const CONNECTORS_FINISH_MAX_PAGES = 5;

/**
 * Whether a handler return value is an explicit `{ status, body }` envelope.
 * Exported for embedding mounts (backlog:ecdf7dc4), which normalize handler
 * results exactly the way the standalone server does.
 *
 * @param {unknown} value */
export function isResponseEnvelope(value) {
  return typeof value === 'object' && value !== null && /** @type {any} */ (value)[RESPONSE_ENVELOPE] === true;
}

/** @param {any} app @param {{publicDir?: string}} [options] */
export function createHttpServer(app, options = {}) {
  const publicDir = resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);
  const router = buildRouter(app);

  const server = createServer(async (request, response) => {
    // Counted here, synchronously, before the first await: the reap decision in
    // reapIdleConnection runs one phase later and asks this exact question.
    // `started` never decreases, so a request that both began AND finished
    // within that phase is still visible to the reap.
    const counters = requestCounters(request.socket);
    counters.started += 1;
    counters.inFlight += 1;
    response.once('close', () => { counters.inFlight -= 1; });

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
        // GET /health is process liveness. Shared request identity in
        // local-development spine mode reads memberships and can bootstrap an
        // owner plus audit — a liveness probe must not mutate tenant or
        // control-plane state. Bound to the matched route so `/health/` and
        // `/health?…` follow the same skip as `/health` (the router already
        // treats a trailing slash as the same path).
        const skipIdentity = route.options?.skipIdentity === true;
        const result = await route.handler({
          request,
          response,
          params: route.params,
          query: Object.fromEntries(url.searchParams.entries()),
          searchParams: url.searchParams,
          body,
          rawBody,
          headers: request.headers,
          ...(skipIdentity
            ? { actor: null, identity: null, organizationId: null }
            : await requestIdentity(app, request)),
        });
        if (!response.writableEnded) {
          // A handler either returns a tagged envelope (explicit status) or a
          // plain payload served as 200. The tag is a Symbol, never a plain
          // "status"/"body" property, so a domain object that happens to carry
          // its own `status` field — a lead with status "qualified", say — can
          // never be mistaken for an envelope and turned into an HTTP status.
          // A thenable standing in for that payload is the Promise-as-domain-
          // value failure: JSON.stringify would silently emit `{}`.
          refuseThenableDomainValue(result, 'http handler result');
          const envelope = isResponseEnvelope(result) ? result : { status: 200, body: result };
          if (isResponseEnvelope(result)) {
            refuseThenableDomainValue(result.body, 'http body');
          }
          sendJson(response, envelope.status, envelope.body, envelope.headers);
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

  // Node's own reap would destroy a request this server has already accepted.
  server.on('timeout', reapIdleConnection);

  /**
   * **A local-development runtime may only listen on loopback.**
   *
   * Local mode accepts asserted, unverified identities — anyone who can reach
   * the socket can claim to be anyone. That is a reasonable trade on a loopback
   * interface and a catastrophe on any other, so the address is checked at the
   * moment of binding rather than trusted at the moment of configuring.
   *
   * An omitted host means "every interface", which is the worst case and not
   * the safe one, so it is refused in local mode too. Wrapping `listen` rather
   * than asking callers to check keeps the guard on the one path every server
   * must take.
   */
  const listen = server.listen.bind(server);
  server.listen = /** @type {any} */ ((...args) => {
    const mode = app?.spine?.mode?.mode ?? app?.listenMode ?? null;
    if (mode) {
      const host = args.find((arg, index) => index > 0 && typeof arg === 'string')
        ?? (typeof args[0] === 'object' && args[0] !== null ? /** @type {any} */ (args[0]).host : undefined);
      assertBindAddress(mode, host);
    }
    return listen(...args);
  });

  return server;
}

/**
 * Per-socket request counters the reap reads. `inFlight` is a count rather than
 * a flag because a pipelining client can have more than one; `started` only
 * ever grows, which is what makes a request that began and finished inside a
 * single loop phase still visible to a reap decision taken at the end of it.
 */
const REQUESTS = Symbol('accordo.requestCounters');

/** @param {import('node:net').Socket} socket */
function requestCounters(socket) {
  const existing = /** @type {any} */ (socket)[REQUESTS];
  if (existing) return existing;
  const created = { started: 0, inFlight: 0 };
  /** @type {any} */ (socket)[REQUESTS] = created;
  return created;
}

/**
 * Reap an idle keep-alive connection without resetting a request that has
 * already arrived.
 *
 * Node's default is `socket.destroy()` the instant the keep-alive timer fires.
 * The event loop runs TIMERS BEFORE POLL, so when that timer is *overdue* the
 * reap runs before the poll phase delivers request bytes that are already
 * sitting in the socket's receive queue — and `close(2)` on a socket with
 * unread data answers RST. The client then loses an accepted request as
 * ECONNRESET instead of receiving either a response or a clean close. A timer
 * is overdue whenever the loop has been blocked for longer than the keep-alive
 * window, which is also exactly when a pooling client cannot tell that the
 * window has passed: its own idle clock is driven by the same loop.
 *
 * Registering this listener takes the reap away from Node — its default only
 * runs when nothing handled `timeout` — so the decision is deferred by one
 * phase. `setImmediate` runs in the CHECK phase, after this iteration's POLL
 * phase, by which time a request that was already in the receive queue has been
 * read, parsed and dispatched, and `IN_FLIGHT` says so. If a request is in
 * flight the connection is kept, and Node re-arms the keep-alive timer when that
 * response finishes. If none is, the connection really is idle and is destroyed
 * exactly as before.
 *
 * The question asked here is deliberately "is a request in flight", not "did
 * bytes arrive". Bytes are only a proxy, and a wrong one: a half-sent request
 * head moves `bytesRead` without ever becoming a request, and keeping the
 * connection for it means relying on Node to re-arm the keep-alive timer. Node
 * does not do that consistently — on v22.16 the arriving bytes clear the timer
 * (`socket.timeout` becomes 0) and the connection then lives until the
 * `headersTimeout` sweep, ~30s rather than ~1s, while on v22.22 the timer is
 * refreshed and the reap re-fires a window later. Counting requests removes the
 * dependency: an incomplete head is reaped on the original deadline on both.
 *
 * This changes how a connection is reaped, never when. The residual window —
 * bytes still on the wire, not yet in the receive queue, when the socket is
 * destroyed — is inherent to HTTP/1.1 keep-alive and belongs to the client.
 *
 * @param {import('node:net').Socket} socket
 */
function reapIdleConnection(socket) {
  const startedWhenIdle = requestCounters(socket).started;
  setImmediate(() => {
    if (socket.destroyed) return;
    const counters = requestCounters(socket);
    // Still serving one; `requestTimeout` bounds a request that never completes.
    if (counters.inFlight > 0) return;
    // Or one arrived and was answered within this phase, which is the whole
    // point: the connection is healthy again and Node has re-armed the reap.
    if (counters.started !== startedWhenIdle) return;
    socket.destroy();
  });
}

/**
 * Bounded process liveness. Never doctor, never tenant services, never
 * business tables. Storage posture is `{adapter, available}` only.
 *
 * @param {any} app
 */
function operationalHealth(app) {
  if (typeof app?.health === 'function') return app.health();
  return {
    ok: true,
    ready: true,
    storage: publicStorageDescriptor(app),
  };
}

/**
 * Project the frozen public storage descriptor. Never a path, URL, handle or
 * credential. HTTP must not inspect `app.database`.
 *
 * @param {any} app
 * @returns {{ adapter: 'sqlite' | 'postgresql', available: boolean }}
 */
function publicStorageDescriptor(app) {
  const project = (value) => {
    if (!value || typeof value !== 'object') return null;
    const adapter = value.adapter;
    const available = value.available;
    if ((adapter === 'sqlite' || adapter === 'postgresql') && typeof available === 'boolean') {
      return { adapter, available };
    }
    return null;
  };
  return project(app?.storage)
    ?? project(typeof app?.health === 'function' ? app.health()?.storage : null)
    ?? { adapter: 'sqlite', available: true };
}

/**
 * The route table of the Admin server, exported so an embedder can mount the
 * same routes under its own session and path prefix (backlog:ecdf7dc4). The
 * handlers are pure request/response functions: they never touch the socket,
 * so both the standalone server above and an embedding mount can drive them.
 *
 * @param {any} app */
export function buildRouter(app) {
  const router = new Router();

  router.add('GET', '/health', async () => operationalHealth(app), { skipIdentity: true });

  router.add('GET', '/api/admin/metrics', async ({ identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.metrics !== 'function') {
      throw new NotFoundError('Operation', 'admin metrics');
    }
    return { counts: await Promise.resolve(app.metrics()) };
  });

  router.add('GET', '/api/schema', async () => ({
    schema: app.schema,
    storage: publicStorageDescriptor(app),
    generatedResourceContract: 1,
    // Production Spine v1 (ADR-038). Published in BOTH states on purpose: an
    // application with no spine says so, in the same field, rather than simply
    // omitting it. A reader who has to infer the absence of a security boundary
    // from a missing key will eventually infer wrong.
    spine: app.spine ? app.spine.describe() : {
      spineContract: null,
      enabled: false,
      warning: 'NO PRODUCTION SPINE — this application performs no identity verification, no tenant '
        + 'isolation and no authorization. Actor identity is whatever the caller claimed. Never expose it, '
        + 'and never read its audit trail as proof that a particular person did anything.',
    },
    modules: app.modules.list(),
    generatedModules: app.modules
      .list()
      .filter((module) => isExposableGeneratedModule(app.modules.get(module.name)))
      .map((module) => generatedModuleMetadata(
        app.modules.get(module.name),
        app.actions.listForModule(module.name),
        isCustomModule(app, module.name) ? 'bundle' : 'kernel',
      )),
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
    // Optional domain packages (ADR-018 addendum). Additive and function-free;
    // absent entirely when no domain is registered.
    ...(app.domains && app.domains.size > 0 ? { domains: app.domains.metadata() } : {}),
  }));

  // Catalog synchronization (ADR-016). Local-development surface like every
  // other write route; the provider call runs outside the write transaction.
  router.add('POST', '/api/catalog/sync', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.syncCatalog !== 'function') {
      throw new NotFoundError('Operation', 'catalog sync');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    if (typeof input.provider !== 'string' || input.provider === '') {
      throw new ValidationError('provider is required', { field: 'provider' });
    }
    return await app.syncCatalog({ provider: input.provider, input: input.input, actor });
  });

  // Manual catalog (BO-F2-05). Enumerated adapters over the commercial manual
  // operations — the kernel owns the paths and gates the role boundary, the
  // package owns the writes. Without the package composed each answers an
  // honest 404. Reads gate `records.read`, writes gate `records.write` like
  // every other write route. Query flags arrive as strings and are parsed
  // here; bodies pass through (server-controlled keys stripped) because the
  // operations validate their own input fail-closed.
  router.add('GET', '/api/catalog/products', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.listCatalogProducts !== 'function') {
      throw new NotFoundError('Operation', 'manual catalog');
    }
    if (query.active !== undefined && query.active !== 'true' && query.active !== 'false') {
      throw new ValidationError('active must be true or false', { field: 'active' });
    }
    return await app.listCatalogProducts({
      category: query.category,
      active: query.active === undefined ? undefined : query.active === 'true',
      source: query.source,
      limit: parseLimit(query.limit),
    });
  });
  router.add('POST', '/api/catalog/products', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.createManualProduct !== 'function') {
      throw new NotFoundError('Operation', 'manual catalog');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    return respond(201, await app.createManualProduct({ ...stripServerControlledKeys(input) }, actor));
  });
  router.add('POST', '/api/catalog/products/:id', async ({ params, body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.updateManualProduct !== 'function') {
      throw new NotFoundError('Operation', 'manual catalog');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    return await app.updateManualProduct({ ...stripServerControlledKeys(input), productId: params.id }, actor);
  });
  router.add('POST', '/api/catalog/products/:id/prices', async ({ params, body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.setManualPrices !== 'function') {
      throw new NotFoundError('Operation', 'manual catalog');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    return await app.setManualPrices({ ...stripServerControlledKeys(input), productId: params.id }, actor);
  });
  router.add('POST', '/api/catalog/products/:id/active', async ({ params, body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.setManualProductActive !== 'function') {
      throw new NotFoundError('Operation', 'manual catalog');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    return await app.setManualProductActive({ ...stripServerControlledKeys(input), productId: params.id }, actor);
  });

  // Team calendar (BO-F3 \"07 Calendario\"). Reads and the booking flow over
  // the declared appointments operations — the kernel owns the paths and
  // gates the role boundary, the package owns the reads and writes. Without
  // the package composed each answers an honest 404. Reads gate
  // `records.read`, writes gate `records.write` like every other write
  // route. Query flags arrive as strings and are parsed here; bodies pass
  // through (server-controlled keys stripped) because the operations
  // validate their own input fail-closed.
  router.add('GET', '/api/appointments/team-week', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readAppointmentTeamWeek !== 'function') {
      throw new NotFoundError('Operation', 'team week');
    }
    return await app.readAppointmentTeamWeek({
      teamMemberIds: parseMemberList(query.teamMemberIds),
      from: query.from,
      to: query.to,
    });
  });
  router.add('GET', '/api/appointments/suggest-slots', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.suggestAppointmentSlots !== 'function') {
      throw new NotFoundError('Operation', 'suggested slots');
    }
    const slotMinutes = query.slotMinutes === undefined
      ? undefined
      : Number.parseInt(String(query.slotMinutes), 10);
    return await app.suggestAppointmentSlots({
      teamMemberIds: parseMemberList(query.teamMemberIds),
      from: query.from,
      to: query.to,
      ...(slotMinutes === undefined ? {} : { slotMinutes }),
    });
  });
  router.add('POST', '/api/appointments/propose', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.proposeAppointmentBooking !== 'function') {
      throw new NotFoundError('Operation', 'appointment proposal');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    return await app.proposeAppointmentBooking({ ...stripServerControlledKeys(input) }, actor);
  });
  router.add('POST', '/api/appointments/confirm', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.confirmAppointmentBooking !== 'function') {
      throw new NotFoundError('Operation', 'appointment confirmation');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    return await app.confirmAppointmentBooking({ ...stripServerControlledKeys(input) }, actor);
  });
  router.add('POST', '/api/appointments/phrase', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.parseBookingPhrase !== 'function') {
      throw new NotFoundError('Operation', 'booking phrase');
    }
    const input = body && typeof body === 'object' && !Array.isArray(body) ? /** @type {any} */ (body) : {};
    return await app.parseBookingPhrase({ ...stripServerControlledKeys(input) }, actor);
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
    return await app.ingestSignatureEvent({
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
  router.add('POST', '/api/signature/envelopes/:id/reconcile', async ({ params, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'signature.reconcile');
    if (typeof app.reconcileSignature !== 'function') {
      throw new NotFoundError('Operation', 'signature reconciliation');
    }
    return await app.reconcileSignature({ envelopeId: params.id, actor });
  });

  // Customer Data Foundation (ADR-037). Three enumerated routes, the same
  // adapter pattern the signature routes follow: the kernel owns the path and
  // delegates to the composed application operation, and without the package
  // composed each answers an honest 404. ADR-032 deliberately refused to build
  // arbitrary path registration for packages, so an enumerated adapter is the
  // sanctioned shape rather than a shortcut around one.
  router.add('POST', '/api/customer-data/import/preview', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.previewCustomerImport !== 'function') {
      throw new NotFoundError('Operation', 'customer data import');
    }
    // A preview writes nothing, so it needs no human boundary — but it is
    // still recorded as the actor who asked.
    // The caller's own `actor` (or tenant, or identity) is REMOVED, not
    // overridden. Overriding works only while this spread stays in this order,
    // and a security property that depends on the order of an object literal is
    // one refactor away from being gone.
    return await app.previewCustomerImport({ ...stripServerControlledKeys(body), actor });
  });

  router.add('POST', '/api/customer-data/import/apply', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.applyCustomerImport !== 'function') {
      throw new NotFoundError('Operation', 'customer data import');
    }
    return await app.applyCustomerImport({ ...stripServerControlledKeys(body), actor });
  });

  // Manual channel identity link/unlink (backlog:826e377c) was split into a
  // follow-up voce by the owner: this PR keeps only the read of observed
  // identities, so the link and unlink routes return with that voce.
  router.add('GET', '/api/customer-data/profile/:resource/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readCustomerProfile !== 'function') {
      throw new NotFoundError('Operation', 'customer profile');
    }
    return await app.readCustomerProfile({ resource: params.resource, id: params.id });
  });

  // Customer enrichment (BO-F4-03): the "Arricchito dall'AI" section of the
  // scheda cliente reads the active enriched fields of the customer's whole
  // cluster — linked identities included — each with the free source that
  // filled it and its observation date, plus the opt-out state. The same
  // enumerated-adapter shape as the profile route above: the kernel owns the
  // path, gates the role boundary, and delegates to the composed application
  // operation; without the package composed each answers an honest 404.
  // Creates nothing: no save happens without the enrichment action, which
  // refuses opted-out subjects before writing.
  router.add('GET', '/api/customer-data/enriched/:resource/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readCustomerEnrichment !== 'function') {
      throw new NotFoundError('Operation', 'customer enrichment');
    }
    return await app.readCustomerEnrichment({ resource: params.resource, id: params.id });
  });

  // Customer list (BO-F1-05): one server page over the host records with
  // views-as-saved-queries, channel and status filters, sorting and the
  // AI budget column. Same enumerated-adapter shape as the profile route:
  // without the package composed each answers an honest 404. Query values
  // arrive as strings and are validated by the operation, which refuses
  // unknown values fail-closed rather than answering a page nobody asked.
  router.add('GET', '/api/customer-data/customers', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.listCustomers !== 'function') {
      throw new NotFoundError('Operation', 'customer list');
    }
    return await app.listCustomers({
      q: query.q,
      canale: query.canale,
      stato: query.stato,
      sort: query.sort,
      vista: query.vista,
      page: query.page,
      pageSize: query.pageSize,
      spaceId: query.spaceId,
    });
  });

  // Customer Hub (BO-F1-06): the scheda cliente reads the card and the
  // timeline through two enumerated adapters, the same shape as the profile
  // route above. The kernel owns the path, gates the role boundary, and
  // delegates to the composed application operations: without the hub
  // composed each answers an honest 404. No new table, no new record —
  // both operations are read-only projections over records other packages
  // already hold.
  router.add('GET', '/api/customer-hub/card/:resource/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readCustomerCard !== 'function') {
      throw new NotFoundError('Operation', 'customer card');
    }
    return await app.readCustomerCard({ resource: params.resource, id: params.id });
  });

  router.add('GET', '/api/customer-hub/timeline/:resource/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readCustomerTimeline !== 'function') {
      throw new NotFoundError('Operation', 'customer timeline');
    }
    return await app.readCustomerTimeline({ resource: params.resource, id: params.id });
  });

  // Voce 714433c2: the scheda cliente's "Aggiungi nota". The note is a
  // work-activity row of kind `note` on the customer subject (same row, kind
  // and human-actor boundary as the task `add-note` action, without the
  // task), so it reads back on the scheda cronologia through the timeline
  // the hub already shapes. Without the work package composed the honest
  // 404 names the missing operation; a note on a ghost record refuses with
  // the record's own NotFoundError, never a dangling row.
  router.add('POST', '/api/customer-hub/notes', async ({ body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.recordSubjectNote !== 'function') {
      throw new NotFoundError('Operation', 'subject note');
    }
    const input = recordInput(body);
    if (input.resource === 'contact') {
      await app.services.contacts.get(String(input.id ?? ''));
    } else if (input.resource === 'company') {
      await app.services.companies.get(String(input.id ?? ''));
    } else {
      throw new ValidationError('a subject note needs resource contact or company', { field: 'resource' });
    }
    return respond(201, await app.recordSubjectNote({ ...stripServerControlledKeys(input), actor }));
  });

  // Scheda cliente composer «Scrivi» (backlog:e9b4fc2f): the quick-action
  // mailto: link is gone — the operator writes inside the /bo, choosing the
  // channel among the customer's own (Email via the linked Gmail, WhatsApp,
  // Instagram, Messenger, SMS), with the recipient preselected, and the
  // message goes through the durable-jobs outbox (the worker sends, then
  // logs the proven send as the subject's outbound timeline row, so it
  // reads back in the scheda cronologia). Same enumerated-adapter shape as
  // the routes above: the kernel owns the path, gates records.write, and
  // delegates to the composed operations — without channels or the hub
  // composed each answers an honest 404. The recipient is ALWAYS
  // server-derived from the card: a caller-supplied `to` is ignored, never
  // trusted, so the composer cannot be turned into an arbitrary send tool.
  // No attachment in v1: no outbound adapter carries one, so an attachment
  // field would either lie or silently drop — it rides a follow-up voce.
  router.add('POST', '/api/customer-hub/messages', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.queueChannelSend !== 'function') {
      throw new NotFoundError('Operation', 'channel send');
    }
    if (typeof app.readCustomerCard !== 'function') {
      throw new NotFoundError('Operation', 'customer card');
    }
    if (typeof app.readSyncState !== 'function') {
      throw new NotFoundError('Operation', 'connector sync state');
    }
    const input = recordInput(body);
    if (input.resource === 'contact') {
      await app.services.contacts.get(String(input.id ?? ''));
    } else if (input.resource === 'company') {
      await app.services.companies.get(String(input.id ?? ''));
    } else {
      throw new ValidationError('a composed message needs resource contact or company', { field: 'resource' });
    }
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
    if (spaceId.trim() === '') {
      throw new ValidationError('a composed message needs its spaceId', { field: 'spaceId' });
    }
    const channel = typeof input.channel === 'string' ? input.channel.trim().toLowerCase() : '';
    if (!COMPOSER_CHANNELS.includes(channel)) {
      throw new ValidationError(`channel must be one of ${COMPOSER_CHANNELS.join(', ')}`, { field: 'channel' });
    }
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.trim() === '' || text.length > 30000) {
      throw new ValidationError('a composed message needs non-empty text (at most 30000 chars)', { field: 'text' });
    }
    let subject;
    if (input.subject !== undefined && input.subject !== null) {
      if (channel !== 'email') {
        throw new ValidationError('only email carries a subject line', { field: 'subject' });
      }
      if (typeof input.subject !== 'string' || input.subject.trim() === ''
        || input.subject.length > 256 || /[\r\n]/.test(input.subject)) {
        throw new ValidationError('subject must be bounded single-line text when present', { field: 'subject' });
      }
      subject = input.subject.trim();
    }
    const messageKey = typeof input.messageKey === 'string' ? input.messageKey : '';
    if (messageKey === '' || messageKey.length > 128 || COMPOSER_CONTROL_RE.test(messageKey)) {
      throw new ValidationError('messageKey must be bounded single-line text: one fresh key per send', { field: 'messageKey' });
    }
    const wantedKey = typeof input.connectionKey === 'string' && input.connectionKey !== ''
      ? input.connectionKey : null;

    const card = await app.readCustomerCard({ resource: input.resource, id: String(input.id ?? '') });
    const to = composerRecipient(card, channel);
    if (to === null) {
      throw new AppError(`This customer has no address on ${channel}: link it before writing`, {
        code: 'CHANNEL_COMPOSER_NO_RECIPIENT', status: 409,
      });
    }
    const sync = await app.readSyncState({ spaceId });
    const candidates = Array.isArray(sync?.connectors) ? sync.connectors.filter((entry) => entry
      && typeof entry === 'object' && entry.channel === channel && entry.status === 'active'
      && typeof entry.connectionKey === 'string' && entry.connectionKey !== '') : [];
    let connection = null;
    if (wantedKey !== null) {
      connection = candidates.find((entry) => entry.connectionKey === wantedKey) ?? null;
      if (connection === null) {
        throw new AppError('Unknown channel connection for this space and channel', {
          code: 'CHANNEL_CONNECTION_UNKNOWN', status: 404,
        });
      }
    } else if (candidates.length === 1) {
      connection = candidates[0];
    } else if (candidates.length === 0) {
      throw new AppError(`No linked ${channel} connection in this space: open Connettori first`, {
        code: 'CHANNEL_CONNECTION_NOT_ACTIVE', status: 409,
      });
    } else {
      throw new AppError(`Several linked ${channel} connections: name its connectionKey`, {
        code: 'CHANNEL_CONNECTION_AMBIGUOUS', status: 409,
      });
    }

    // Email stays in the customer's thread: the latest email passage names
    // it, so the reply the worker sends lands in the same Gmail thread and
    // the logged row groups with it. Without one the provider opens a new
    // thread and the row names the assigned message instead.
    let conversationId;
    let threadId;
    if (channel === 'email' && typeof app.readCustomerTimeline === 'function') {
      const found = await latestEmailThread(app, { resource: input.resource, id: String(input.id ?? '') });
      conversationId = found?.conversationId;
      threadId = found?.threadId;
    }
    const message = { to, text };
    if (subject !== undefined) message.subject = subject;
    if (threadId !== undefined) message.threadId = threadId;
    const queued = await app.queueChannelSend({
      actor,
      spaceId,
      connectionKey: connection.connectionKey,
      message,
      messageKey,
      timeline: {
        subject: { resource: input.resource, id: String(input.id ?? ''), owner: 'host' },
        ...(conversationId === undefined ? {} : { conversationId }),
      },
    });
    return respond(201, {
      channel,
      to,
      connectionKey: connection.connectionKey,
      jobId: queued.jobId,
      idempotencyKey: queued.idempotencyKey,
      state: queued.state,
    });
  });

  // Call intelligence (BO-F1-08): the notice, the transcript, its summary
  // and the customer calls read for the scheda cliente. The same
  // enumerated-adapter shape as the hub routes above: the kernel owns the
  // path, gates the role boundary, and delegates to the composed
  // application operations — without intelligence composed each answers an
  // honest 404. The space stays explicit on every call, never inferred.
  router.add('POST', '/api/call-intelligence/notice', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.recordCallNotice !== 'function') {
      throw new NotFoundError('Operation', 'call notice');
    }
    return await app.recordCallNotice({ ...stripServerControlledKeys(body), actor });
  });

  router.add('POST', '/api/call-intelligence/transcript', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.saveCallTranscript !== 'function') {
      throw new NotFoundError('Operation', 'call transcript');
    }
    return await app.saveCallTranscript({ ...stripServerControlledKeys(body), actor });
  });

  router.add('POST', '/api/call-intelligence/summarize', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.summarizeCall !== 'function') {
      throw new NotFoundError('Operation', 'call summary');
    }
    return await app.summarizeCall({ ...stripServerControlledKeys(body), actor });
  });

  // The explicit operator path for the retention purge (BO-F1-08): the same
  // operation the scheduled sweep runs, triggerable by hand when no beat is
  // seeded. Without intelligence composed it answers the honest 404 above.
  // The instant is server-controlled: a caller-supplied `now` could erase
  // every transcript early by naming a far-future date, so only the space
  // scope is read from the body and `now` is never forwarded.
  router.add('POST', '/api/call-intelligence/purge', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.purgeExpiredTranscripts !== 'function') {
      throw new NotFoundError('Operation', 'call purge');
    }
    const input = stripServerControlledKeys(body);
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : undefined;
    return await app.purgeExpiredTranscripts(spaceId === undefined ? { actor } : { spaceId, actor });
  });

  router.add('GET', '/api/call-intelligence/calls/:resource/:id', async ({ params, searchParams, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readCustomerCalls !== 'function') {
      throw new NotFoundError('Operation', 'customer calls');
    }
    return await app.readCustomerCalls({
      spaceId: searchParams.get('spaceId'),
      subjectResource: params.resource,
      subjectId: params.id,
    });
  });
  // Connectors (BO-F1-02): the backoffice 3-step connect flow. The same
  // enumerated-adapter shape as the routes above: the kernel owns the path,
  // gates the role boundary, and delegates to the composed application
  // operations — without the channels package composed each answers an
  // honest 404. No new table, no new record: every write below runs through
  // the package's own register operation and its audited status action, so
  // validation, audit and trace stay exactly where they already are.
  router.add('GET', '/api/connectors', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readSyncState !== 'function') {
      throw new NotFoundError('Operation', 'connector sync state');
    }
    return await app.readSyncState({ spaceId: query.spaceId });
  });

  // Stato sync (BO-F1-03): the screen reads one activity payload — real
  // inbox tallies, the open dead letters, the newest-first feed and the
  // needsFix badge count — and "Sincronizza ora" pulls one bounded page
  // through the same route. Same enumerated shape as the routes above:
  // the kernel gates the role boundary and delegates to the composed
  // application operations; without the channels package composed each
  // answers an honest 404. The pull is a human decision, so sync-now
  // gates `records.write` like authorize and finish.
  router.add('GET', '/api/connectors/activity', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readSyncActivity !== 'function') {
      throw new NotFoundError('Operation', 'connector sync activity');
    }
    const feedLimit = query.feedLimit === undefined ? undefined : Number(query.feedLimit);
    return await app.readSyncActivity({
      spaceId: query.spaceId,
      ...(feedLimit === undefined ? {} : { feedLimit }),
    });
  });

  router.add('POST', '/api/connectors/sync-now', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.syncNowChannel !== 'function') {
      throw new NotFoundError('Operation', 'connector sync now');
    }
    const input = stripServerControlledKeys(body);
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
    try {
      return await app.syncNowChannel({
        spaceId,
        connectionKey: typeof input.connectionKey === 'string' ? input.connectionKey : '',
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        actor,
      });
    } catch (error) {
      // A 5xx here would otherwise reach the top-level serializer unlogged:
      // log the normalized code with the workspace id — never the body, a
      // secret or provider text — so a production sync failure stays
      // diagnosable, then let the error travel unchanged.
      const normalized = normalizeError(error);
      if (normalized.status >= 500) {
        const loggedSpace = /^[a-z][a-z0-9-]{0,62}$/.test(spaceId) ? spaceId : 'unknown';
        console.error(`sync-now failed code=${normalized.code} spaceId=${loggedSpace}`);
      }
      throw error;
    }
  });

  router.add('POST', '/api/connectors/authorize', async ({ body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.registerChannelConnection !== 'function' || typeof app.readSyncState !== 'function') {
      throw new NotFoundError('Operation', 'connector authorize');
    }
    const input = stripServerControlledKeys(body);
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
    const channel = typeof input.channel === 'string' ? input.channel : '';
    const account = typeof input.account === 'string' ? input.account : '';
    const adapter = typeof input.adapter === 'string' ? input.adapter : '';
    const adapterVersion = Number.isSafeInteger(input.adapterVersion) ? input.adapterVersion : 0;
    // The secret itself is never collected here and never stored anywhere:
    // authorize records the vault slot the deployment fills later — one slot
    // per space+channel+account, so two accounts on one channel in one space
    // never share a credential. Resolution happens at call time through the
    // deployment's resolver — a fake-backed adapter never dials anything
    // real (MEM_ACC_DECISIONS).
    const secretRef = connectionSecretRef({ spaceId, channel, account });
    const reg = await app.registerChannelConnection({
      spaceId, channel, account, adapter, adapterVersion, secretRef, actor,
    });
    const state = await app.readSyncState({ spaceId });
    const entry = state.connectors.find((row) => row.connectionKey === reg.connection.sourceKey) ?? null;
    if (entry !== null && (entry.status === 'pending' || entry.status === 'suspended')) {
      const context = writeContext(app, { actor, identity, organizationId, headers });
      await app.runAction({
        module: 'channel-connection',
        action: 'activate-connection',
        recordId: reg.connection.id,
        input: { reason: 'connected from the guided Connectors flow (BO-F1-02)' },
        actor,
        identity,
        organizationId,
        tenantId: context.tenantId,
        idempotencyKey: context.idempotencyKey,
      });
      const next = await app.readSyncState({ spaceId });
      return {
        duplicate: reg.duplicate,
        connection: next.connectors.find((row) => row.connectionKey === reg.connection.sourceKey) ?? entry,
      };
    }
    if (entry !== null && entry.status === 'revoked') {
      throw new AppError('This connection was revoked: register a new account to reconnect', {
        code: 'CHANNEL_CONNECTION_REVOKED', status: 409,
      });
    }
    return { duplicate: reg.duplicate, connection: entry };
  });

  router.add('POST', '/api/connectors/finish', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    const input = stripServerControlledKeys(body);
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
    const connectionKey = typeof input.connectionKey === 'string' ? input.connectionKey : '';
    // Passo 2 "cosa sincronizzare": nuovi messaggi fluiscono sempre una
    // volta che la connessione è attiva; la cronologia passata è la scelta.
    // Skipping it starts nothing — there is no import row to resume — and
    // conflicts found later still become duplicate candidates, never merges.
    if (input.history === false) {
      return { started: false, skipped: 'history', connectionKey };
    }
    if (typeof app.startInitialImport !== 'function' || typeof app.advanceInitialImport !== 'function') {
      throw new NotFoundError('Operation', 'connector initial import');
    }
    const started = await app.startInitialImport({ spaceId, connectionKey, actor });
    // Pulling starts with the first advance call, and no scheduler advances
    // running imports — but one HTTP request cannot pull an unbounded past:
    // at most CONNECTORS_FINISH_MAX_PAGES pages of CONNECTORS_FINISH_PAGE_LIMIT
    // events each, so one request costs at most a few provider round-trips
    // (one timeout each) and always fits inside gateway timeouts. A large past
    // needs several fatto continuations; every continuation resumes from the
    // stored cursor, and the reply carries done:false plus the progress so far
    // instead of an unconditional done:true. A transient failure aborts with
    // the cursor unmoved, and retrying finish resumes from the stored cursor.
    let advance = null;
    for (let page = 0; page < CONNECTORS_FINISH_MAX_PAGES; page += 1) {
      advance = await app.advanceInitialImport({ spaceId, connectionKey, limit: CONNECTORS_FINISH_PAGE_LIMIT });
      if (advance?.done === true) break;
    }
    return {
      started: started.started,
      resumed: started.resumed ?? false,
      connectionKey,
      done: advance?.done === true,
      import: advance?.state ?? started.state ?? null,
    };
  });

  // Personalizzazione (BO-F4-01): per-space activation of framework packages
  // and agent skills, recorded in `space-package`, plus the read-only
  // "Prova" preview over the space's real rows. The same enumerated shape as
  // the connectors routes above: the kernel gates the role boundary and
  // delegates to the composed application operations; without the
  // space-permissions package composed each answers an honest 404. The
  // catalog is the checked-in composition catalog — static, function-free,
  // additive. Preview performs zero writes by construction; activation names
  // its actor and replays identically.
  router.add('GET', '/api/space-packages/catalog', async ({ identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.previewSpacePackage !== 'function') {
      throw new NotFoundError('Operation', 'space packages');
    }
    return { units: SPACE_PACKAGE_CATALOG };
  });

  router.add('GET', '/api/space-packages/preview', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.previewSpacePackage !== 'function') {
      throw new NotFoundError('Operation', 'space packages');
    }
    const spaceId = typeof query.spaceId === 'string' ? query.spaceId : '';
    const unit = typeof query.unit === 'string' ? query.unit : '';
    return await app.previewSpacePackage({ spaceId, unit });
  });

  router.add('POST', '/api/space-packages/activate', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.activateSpacePackage !== 'function') {
      throw new NotFoundError('Operation', 'space packages');
    }
    const input = stripServerControlledKeys(body);
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
    const unit = typeof input.unit === 'string' ? input.unit : '';
    return await app.activateSpacePackage({ spaceId, unit, actor });
  });

  router.add('POST', '/api/space-packages/deactivate', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.deactivateSpacePackage !== 'function') {
      throw new NotFoundError('Operation', 'space packages');
    }
    const input = stripServerControlledKeys(body);
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
    const unit = typeof input.unit === 'string' ? input.unit : '';
    return await app.deactivateSpacePackage({ spaceId, unit, actor });
  });

  // Space AI permission read (BO-F0-06, backoffice "08 Spazi e accessi"). The
  // screen's only switch read: the generic records surface cannot filter the
  // override module by space (its filterableFields are index-backed only, so
  // `filter.spaceId` is refused), and an unfiltered page would hand every
  // space's rows to the browser. This route scopes server-side through the
  // composed operation instead — without the package composed the method is
  // absent and the route answers an honest 404, like the flip route below.
  router.add('GET', '/api/space-permissions/effective', async ({ searchParams, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.effectiveSpaceAiPermissions !== 'function') {
      throw new NotFoundError('Operation', 'space AI permissions');
    }
    const spaceId = searchParams?.get?.('spaceId') ?? '';
    return await app.effectiveSpaceAiPermissions({ spaceId });
  });

  // Space AI permission flip (BO-F0-06, backoffice "08 Spazi e accessi"). The
  // same delegation shape as the space-package routes above: the kernel owns
  // the path, gates the write boundary, and delegates to the composed
  // application operation — without the package composed the method is
  // absent and the route answers an honest 404. The operation runs the
  // human-only `set-permission` record action, so anonymous, agent and
  // system callers are refused with the same codes there.
  router.add('POST', '/api/space-permissions/set-permission', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.setSpaceAiPermission !== 'function') {
      throw new NotFoundError('Operation', 'space AI permissions');
    }
    const input = stripServerControlledKeys(body);
    const spaceId = typeof input.spaceId === 'string' ? input.spaceId : '';
    const permission = typeof input.permission === 'string' ? input.permission : '';
    const enabled = typeof input.enabled === 'string' ? input.enabled : '';
    return await app.setSpaceAiPermission({ spaceId, permission, enabled, actor });
  });

  // Customer Data Operations v2: bulk decisions and scale-safe export. The
  // same enumerated-adapter shape as the import routes above: the kernel
  // owns the path, gates the role boundary, and delegates to the composed
  // application operation — without the package composed each answers an
  // honest 404. Bulk applies human decisions, so it gates `records.write`
  // like the import apply; export reads managed evidence, so it gates
  // `records.read` like the preview and the profile.
  router.add('POST', '/api/customer-data/bulk/apply', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.applyBulkCustomerAction !== 'function') {
      throw new NotFoundError('Operation', 'customer data bulk apply');
    }
    return await app.applyBulkCustomerAction({ ...stripServerControlledKeys(body), actor });
  });

  router.add('POST', '/api/customer-data/export', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.exportCustomerRecords !== 'function') {
      throw new NotFoundError('Operation', 'customer data export');
    }
    return await app.exportCustomerRecords({ ...stripServerControlledKeys(body), actor });
  });

  // Uniform resource surface for generated modules (ADR-008). Only modules
  // that fully satisfy the generated-module contract are served; anything
  // else — unknown names, handwritten core modules, malformed or hand-edited
  // definitions — fails closed as 404. This is a framework contract against
  // accidental misuse, not a sandbox against malicious source-code changes.
  router.add('GET', '/api/modules/:module', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    const module = resolveGeneratedModule(app, params.module);
    return generatedModuleMetadata(
      module,
      app.actions.listForModule(module.name),
      isCustomModule(app, module.name) ? 'bundle' : 'kernel',
    );
  });
  router.add('GET', '/api/modules/:module/records', async ({ params, searchParams, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'list');
    return {
      items: await module.service.list({
        limit: strictLimit(searchParams),
        where: strictCollectionFilter(searchParams, module),
      }),
    };
  });
  router.add('POST', '/api/modules/:module/records', async ({ params, body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'create');
    return respond(201, await module.service.create(recordInput(body), writeContext(app, { actor, identity, organizationId, headers })));
  });
  router.add('GET', '/api/modules/:module/records/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'get');
    return await module.service.get(params.id);
  });
  router.add('PATCH', '/api/modules/:module/records/:id', async ({ params, body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'update');
    return await module.service.update(params.id, recordInput(body), writeContext(app, { actor, identity, organizationId, headers }));
  });

  // Code-first actions over the generic surface (ADR-011/014). The route only
  // resolves the module and delegates to the action runtime — it never writes
  // to the database directly. Eligible targets are exposable generated
  // modules, plus handwritten core modules that have at least one action
  // registered (registration in checked-in source IS the explicit eligibility
  // declaration — core CRUD stays on its dedicated routes and is never served
  // by the generic records surface). Anything else is a 404; unknown action
  // 404; bad input 400; invalid transition a stable 409.
  router.add('POST', '/api/modules/:module/records/:id/actions/:action', async ({ params, body, actor, identity, organizationId, headers }) => {
    resolveActionableModule(app, params.module); // 404 for unknown/ineligible modules
    const context = writeContext(app, { actor, identity, organizationId, headers });
    return await app.runAction({
      module: params.module,
      action: params.action,
      recordId: params.id,
      input: actionInput(body),
      actor,
      identity,
      organizationId,
      tenantId: context.tenantId,
      idempotencyKey: context.idempotencyKey,
    });
  });

  router.add('GET', '/api/companies', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return { items: await app.services.companies.list({ limit: parseLimit(query.limit) }) };
  });
  router.add('POST', '/api/companies', async ({ body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    return respond(201, await app.services.companies.create(body ?? {}, writeContext(app, { actor, identity, organizationId, headers })));
  });

  router.add('GET', '/api/contacts', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return {
      items: await app.services.contacts.list({
        companyId: query.companyId,
        limit: parseLimit(query.limit),
      }),
    };
  });
  router.add('POST', '/api/contacts', async ({ body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    return respond(201, await app.services.contacts.create(body ?? {}, writeContext(app, { actor, identity, organizationId, headers })));
  });
  // Voce 714433c2: the scheda cliente edits Dettagli in place. Only the four
  // editable keys reach the service — anything else (companyId included) is
  // refused rather than silently dropped, so a caller cannot move a contact
  // between companies through this route.
  router.add('PATCH', '/api/contacts/:id', async ({ params, body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    const input = recordInput(body);
    const patch = {};
    for (const key of ['firstName', 'lastName', 'email', 'role']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    const unknown = Object.keys(input).filter((key) => !['firstName', 'lastName', 'email', 'role'].includes(key));
    if (unknown.length > 0) {
      throw new ValidationError(`Contact update refuses unknown fields: ${unknown.join(', ')}`, { field: unknown[0] });
    }
    return await app.services.contacts.update(params.id, patch, writeContext(app, { actor, identity, organizationId, headers }));
  });

  router.add('GET', '/api/opportunities', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return {
      items: await app.services.opportunities.list({
        stage: query.stage,
        type: query.type,
        companyId: query.companyId,
        limit: parseLimit(query.limit),
      }),
    };
  });
  router.add('POST', '/api/opportunities', async ({ body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    return respond(201, await app.services.opportunities.create(body ?? {}, writeContext(app, { actor, identity, organizationId, headers })));
  });
  router.add('GET', '/api/opportunities/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return await app.services.opportunities.get(params.id);
  });
  // Voce 96e7b579: the pipeline card edits importo, data di chiusura and
  // referente in place. Only the three editable keys reach the service —
  // anything else (companyId, stage, pipeline-managed keys included) is
  // refused rather than silently dropped, so an edit can never move the
  // customer, the lifecycle stage or the pipeline position of an offer.
  router.add('PATCH', '/api/opportunities/:id', async ({ params, body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    const input = recordInput(body);
    const patch = {};
    for (const key of ['valueCents', 'expectedCloseDate', 'owner']) {
      if (input[key] !== undefined) patch[key] = input[key];
    }
    const unknown = Object.keys(input).filter((key) => !['valueCents', 'expectedCloseDate', 'owner'].includes(key));
    if (unknown.length > 0) {
      throw new ValidationError(`Opportunity update refuses unknown fields: ${unknown.join(', ')}`, { field: unknown[0] });
    }
    return await app.services.opportunities.update(params.id, patch, writeContext(app, { actor, identity, organizationId, headers }));
  });
  router.add('POST', '/api/opportunities/:id/stage', async ({ params, body, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    return await app.workflows.run(
      'request-opportunity-stage-change',
      { opportunityId: params.id, targetStage: body?.targetStage },
      writeContext(app, { actor, identity, organizationId, headers }),
    );
  });

  // Reporting dashboard (BO-F5-02): the pipeline half of the "09 Reporting"
  // screen, read-only. Every number comes from the declared analytics
  // registry — compileReport/runReport over pipeline_value_by_stage and
  // pipeline_close_schedule — plus the operator's own obiettivo row from the
  // reporting bundle when composed. No storage query of its own, no write
  // surface: there is deliberately no POST under /api/reporting/*, so the
  // "Cosa noto" proposal the model carries can never reassign by itself.
  // Portable compositions (backlog:0e3e67eb: the production /bo reader)
  // carry no `database` handle, so the report specs execute through the
  // application's closed-over runReportFromSpec instead — same registry,
  // same numbers, empty data answering 200 with an empty model, never a
  // 500. Specs cross the boundary, never pre-compiled descriptors: each
  // executor compiles the spec itself, so a forged descriptor cannot reach
  // storage through this route or through the facade.
  router.add('GET', '/api/reporting/dashboard', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    const dashboardQuery = parseDashboardQuery({
      period: query.period,
      owner: query.owner,
      currency: query.currency,
    });
    const specs = dashboardSpecs(dashboardQuery);
    const executeReport = typeof app.runReportFromSpec === 'function'
      ? (spec) => app.runReportFromSpec(spec)
      : (spec) => runReport(app.database, compileReport(spec));
    const byStage = await executeReport(specs.byStage);
    const schedule = await executeReport(specs.schedule);
    let bundleRows = [];
    try {
      const reporting = requireCapability(resolveGeneratedModule(app, 'reporting'), 'list');
      const listed = await reporting.service.list({ limit: 500 });
      bundleRows = Array.isArray(listed) ? listed : listed?.items ?? [];
    } catch (error) {
      // The bundle is optional: without it the forecast simply has no
      // target. Anything that is NOT "not composed here" still throws —
      // a broken bundle read must not masquerade as "no obiettivo".
      if (!(error instanceof NotFoundError)) throw error;
    }
    // Channel origins (BO-F6-13, slice 2): the customer-data package is
    // optional like the bundle above — without it the channel card reads
    // empty, never invented. A present-but-broken read still throws.
    let channelOrigins = [];
    if (typeof app.countCustomerChannelOrigins === 'function') {
      const counted = await app.countCustomerChannelOrigins({});
      if (Array.isArray(counted?.origins)) channelOrigins = counted.origins;
    }
    return buildDashboardModel({ byStage, schedule }, bundleRows, dashboardQuery, undefined, channelOrigins);
  });

  router.add('GET', '/api/approvals', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return {
      items: await app.services.approvals.list({
        status: query.status,
        opportunityId: query.opportunityId,
        limit: parseLimit(query.limit),
      }),
    };
  });
  router.add('POST', '/api/approvals/:id/approve', async ({ params, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'approvals.decide');
    return await app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: params.id, decision: 'approved' },
      writeContext(app, { actor, identity, organizationId, headers }),
    );
  });
  router.add('POST', '/api/approvals/:id/reject', async ({ params, actor, identity, organizationId, headers }) => {
    await gate(app, identity, organizationId, 'approvals.decide');
    return await app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: params.id, decision: 'rejected' },
      writeContext(app, { actor, identity, organizationId, headers }),
    );
  });

  // Trace and audit are evidence about everyone in the tenant, so they are
  // read-gated like any other record read. An ungated audit route is a
  // disclosure of who did what, which is precisely what this milestone exists
  // to protect.
  router.add('GET', '/api/write-outcomes', async ({ identity, organizationId, actor }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.listUnacknowledgedWrites !== 'function') {
      throw new NotFoundError('Operation', 'write outcomes');
    }
    return {
      items: await app.listUnacknowledgedWrites(writeContext(app, { actor, identity, organizationId })),
    };
  });
  router.add('GET', '/api/write-outcomes/:key', async ({ params, identity, organizationId, actor }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.lookupWrite !== 'function') {
      throw new NotFoundError('Operation', 'write outcomes');
    }
    return await app.lookupWrite({
      ...writeContext(app, { actor, identity, organizationId }),
      idempotencyKey: requireIdempotencyKey(params.key),
    });
  });
  router.add('POST', '/api/write-outcomes/:key/ack', async ({ params, identity, organizationId, actor, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.acknowledgeWrite !== 'function') {
      throw new NotFoundError('Operation', 'write outcomes');
    }
    return await app.acknowledgeWrite({
      ...writeContext(app, { actor, identity, organizationId, headers }),
      idempotencyKey: requireIdempotencyKey(params.key),
    });
  });
  router.add('POST', '/api/write-outcomes/:key/reconcile', async ({ params, body, identity, organizationId, actor, headers }) => {
    await gate(app, identity, organizationId, 'records.write');
    if (typeof app.reconcileWrite !== 'function') {
      throw new NotFoundError('Operation', 'write outcomes');
    }
    const context = writeContext(app, { actor, identity, organizationId, headers });
    if (typeof body?.operation !== 'string' || body.operation.trim() === '') {
      throw new ValidationError('operation is required to reconcile a write', { field: 'operation' });
    }
    return await app.reconcileWrite({
      ...context,
      idempotencyKey: requireIdempotencyKey(params.key),
      operation: body.operation,
      target: typeof body?.target === 'string' ? body.target : '',
      contractVersion: typeof body?.contractVersion === 'string' ? body.contractVersion : 'write.v1',
      input: body?.input ?? null,
    });
  });

  router.add('GET', '/api/traces', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return {
      items: await app.workflows.listRuns({
        status: query.status,
        workflowName: query.workflowName,
        limit: parseLimit(query.limit),
      }),
    };
  });
  router.add('GET', '/api/traces/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return await app.workflows.getRun(params.id);
  });

  router.add('GET', '/api/audit', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return {
      items: await app.audit.list({
        entityType: query.entityType,
        entityId: query.entityId,
        limit: parseLimit(query.limit),
      }),
    };
  });

  // ---- Production Spine (ADR-038) --------------------------------------
  // Bounded on purpose: who am I, which tenant, who else is a member, and what
  // the roles mean. No token, no secret, no password, no invitation flow.
  router.add('GET', '/api/spine/context', async ({ identity, organizationId }) => {
    if (!app.spine) {
      throw new NotFoundError('Operation', 'production spine');
    }
    const organization = organizationId ? await app.spine.organizations.get(organizationId) : null;
    const membership = (identity?.subject && organizationId)
      ? await app.spine.memberships.find({ organizationId, subject: identity.subject })
      : null;
    return {
      ...app.spine.describe(),
      identity: app.spine.identityEvidence(identity),
      organization,
      membership,
      permissions: membership ? membership.permissions : [],
    };
  });

  router.add('GET', '/api/spine/memberships', async ({ identity, organizationId }) => {
    if (!app.spine) throw new NotFoundError('Operation', 'production spine');
    await gate(app, identity, organizationId, 'admin.memberships.manage');
    return { items: await app.spine.memberships.listFor({ organizationId }) };
  });

  router.add('POST', '/api/spine/memberships', async ({ body, identity, organizationId }) => {
    if (!app.spine) throw new NotFoundError('Operation', 'production spine');
    // The store authorizes and applies the no-self-grant and last-administrator
    // rules; the route does not get to decide any of that.
    return respond(201, await app.spine.memberships.grant({
      organizationId,
      subject: body?.subject,
      role: body?.role,
      issuer: body?.issuer ?? null,
      reason: body?.reason,
      identity,
      mode: app.spine.mode,
    }));
  });

  router.add('POST', '/api/spine/memberships/:subject/suspend', async ({ params, body, identity, organizationId }) => {
    if (!app.spine) throw new NotFoundError('Operation', 'production spine');
    return await app.spine.memberships.suspend({
      organizationId,
      subject: params.subject,
      reason: body?.reason,
      identity,
      mode: app.spine.mode,
    });
  });

  router.add('GET', '/api/notifications', async ({ identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return { items: await app.notifications.list() };
  });

  router.add('POST', '/api/demo/seed', async ({ identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    return respond(201, await app.seedDemo());
  });
  router.add('POST', '/api/demo/run', async ({ identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    return await app.runDemo();
  });

  return router;
}

/**
 * Refuse a request that the composed spine does not permit.
 *
 * A no-op when no spine is composed — and `app inspect` publishes that fact, so
 * the no-op is never a silent one.
 *
 * `authorize` refuses another tenant with **404** before it considers a
 * permission at all, so this one call carries both the tenant boundary and the
 * permission boundary and they cannot be applied in the wrong order.
 *
 * @param {any} app @param {any} identity @param {string|null} organizationId @param {string} permission
 */
async function gate(app, identity, organizationId, permission) {
  if (!app?.spine) {
    if (app?.listenMode === 'production') {
      throw new AppError(
        'PostgreSQL HTTP serve in production requires a composed request spine',
        { code: 'POSTGRESQL_HTTP_SPINE_REQUIRED', status: 403 },
      );
    }
    return null;
  }
  const decision = await app.spine.authorize({ identity, organizationId, permission });
  refuseThenableDomainValue(decision, 'authorization');
  return decision;
}

/**
 * The identity and tenant a request acts under (ADR-038).
 *
 * ### What this replaced, and why it had to go
 *
 * The previous `actorFromRequest` read `x-actor-type` and `x-actor-id` and,
 * when they were missing, invented `{type: 'user', id: 'api-user'}`. Any caller
 * was any user, and an absent header produced a *valid-looking* one. Every "a
 * human decided" recorded through this server rested on that.
 *
 * ### The rule
 *
 * When the spine is composed, the **verifier** decides who the caller is. The
 * headers are still read in local-development mode, because that mode has
 * explicitly declared assertions acceptable and says so loudly — but the
 * resulting identity is marked `asserted-local`, never `verified-user`, so
 * nothing downstream can mistake one for the other.
 *
 * ### The organization is never taken from the client
 *
 * There is deliberately no `x-organization-id` header. The tenant comes from
 * the verified identity, and a caller who supplies one anyway is attempting the
 * override that C9 forbids — so a mismatch is refused by the authorizer rather
 * than resolved in the caller's favour.
 *
 * The request may be a live `IncomingMessage` or a plain `{ headers, method,
 * url }` triple — an embedding mount passes the latter, and only the three
 * fields above are ever read.
 *
 * @param {any} app @param {{ headers?: any, method?: string, url?: string }} request
 */
export async function requestIdentity(app, request) {
  const spine = app?.spine ?? null;

  if (!spine) {
    // No spine composed: the historical behaviour, unchanged. `app inspect`
    // publishes that this composition authorizes nothing.
    return { actor: legacyActorFromHeaders(request), identity: null, organizationId: null };
  }

  // A configured verifier is always used, in either mode. Ignoring one because
  // the mode is local would silently discard explicit operator configuration —
  // and an operator who wired up a verifier in development did so precisely to
  // exercise it.
  const verifier = typeof spine.verifyRequest === 'function' ? spine.verifyRequest : null;
  let identity = null;
  if (verifier) {
    // The adapter verifies. Anything it throws, or fails to return, is treated
    // as "not verified" — never as "probably fine". A thenable identity is not
    // "not verified": it is a Promise used as the identity value, and that
    // refusal must not be swallowed as anonymous.
    try {
      const verified = await verifier({ headers: request.headers, method: request.method, url: request.url });
      refuseThenableDomainValue(verified, 'identity');
      identity = verified == null ? null : await spine.defineIdentity(verified);
      refuseThenableDomainValue(identity, 'identity');
    } catch (error) {
      if (error && typeof error === 'object' && /** @type {any} */ (error).code === 'PACKAGE_ASYNC_CONTRACT_REQUIRED') {
        throw error;
      }
      identity = null;
    }
  }

  if (!identity) {
    // Nothing verified. In local-development mode the header pair becomes an
    // explicitly ASSERTED identity; in production it becomes anonymous, which
    // authorizes nothing. `identityFor` owns that difference so there is one
    // place it is decided.
    identity = await spine.identityFor({ actor: legacyActorFromHeaders(request) });
    refuseThenableDomainValue(identity, 'identity');
  }

  return {
    actor: identityToActor(identity),
    identity,
    organizationId: identity?.organizationId ?? null,
  };
}

/** The legacy header pair — asserted, and only ever trusted in local mode. */
function legacyActorFromHeaders(request) {
  const typeHeader = request.headers['x-actor-type'];
  const idHeader = request.headers['x-actor-id'];
  const type = typeof typeHeader === 'string' && ['user', 'agent', 'system'].includes(typeHeader)
    ? typeHeader
    : 'user';
  const id = typeof idHeader === 'string' && idHeader.trim() ? idHeader.trim() : 'api-user';
  return { type, id };
}

/** @param {any} identity */
function identityToActor(identity) {
  if (!identity || identity.kind === 'anonymous') return { type: 'user', id: 'anonymous' };
  if (identity.kind === 'system') return { type: 'system', id: identity.subject };
  return { type: 'user', id: identity.subject };
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

/** @param {import('node:http').ServerResponse} response @param {number} status @param {unknown} body @param {Record<string, string>} [extraHeaders] */
function sendJson(response, status, body, extraHeaders = {}) {
  if (response.writableEnded) return;
  const payload = JSON.stringify(body);
  /** @type {Record<string, string>} */
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(payload)),
    'cache-control': 'no-store',
    ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
  };
  const key = headers['idempotency-key']
    ?? (body && typeof body === 'object' ? /** @type {any} */ (body).idempotencyKey : undefined)
    ?? (body && typeof body === 'object' && /** @type {any} */ (body).error?.details?.idempotencyKey);
  if (typeof key === 'string' && key !== '') headers['idempotency-key'] = key;
  response.writeHead(status, headers);
  response.end(payload);
}

/**
 * Read a static file of the Admin shell without touching a socket. Returns
 * `{ data, contentType }`, or `null` when the path escapes the directory or
 * names no file — the same two cases `serveStatic` answers `false` for.
 * Anything else (an unreadable-but-present file) throws, as before.
 *
 * @param {string} publicDir @param {string} pathname
 */
export async function readStaticFile(publicDir, pathname) {
  const requestPath = pathname === '/' ? '/index.html' : pathname;
  const safePath = normalize(requestPath).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(join(publicDir, safePath));
  if (!filePath.startsWith(publicDir)) return null;
  try {
    const data = await readFile(filePath);
    return { data, contentType: mimeType(extname(filePath)) };
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** @param {string} publicDir @param {string} pathname @param {import('node:http').ServerResponse} response */
async function serveStatic(publicDir, pathname, response) {
  const found = await readStaticFile(publicDir, pathname);
  if (!found) return false;
  response.writeHead(200, {
    'content-type': found.contentType,
    'content-length': found.data.byteLength,
    'cache-control': 'no-cache',
  });
  response.end(found.data);
  return true;
}

/** @param {string | undefined} value */
function parseLimit(value) {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

/**
 * Parse a comma-separated team member list from a query flag (BO-F3). The
 * team is named per call — there is no roster to scan — so an empty or
 * missing list fails closed here, never as a whole-team read. Duplicates
 * are dropped, order kept.
 * @param {unknown} value
 */
function parseMemberList(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(
    value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''),
  )];
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

// eslint-disable-next-line no-control-regex
const COMPOSER_CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * The channels the scheda composer «Scrivi» offers (backlog:e9b4fc2f): Email
 * sends through the linked Gmail connection, the others through their own
 * connection. `facebook` is the Messenger connection channel, like the
 * scheda labels it; `sms` has no adapter yet, so it always reads
 * unconnected until one exists.
 */
const COMPOSER_CHANNELS = Object.freeze(['email', 'whatsapp', 'instagram', 'facebook', 'sms']);

/**
 * The customer's own recipient for one composer channel, read from the
 * card — never from the request body. Null when the customer holds no
 * address there: the route refuses instead of inventing one.
 * @param {any} card the frozen card from `read-customer-card`
 * @param {string} channel one of COMPOSER_CHANNELS
 * @returns {string|null} the preselected recipient, or null when missing
 */
function composerRecipient(card, channel) {
  if (channel === 'email') {
    return typeof card?.email === 'string' && card.email.trim() !== '' ? card.email.trim() : null;
  }
  if (channel === 'whatsapp' || channel === 'sms') {
    return card?.phone?.available === true && typeof card.phone.value === 'string' && card.phone.value.trim() !== ''
      ? card.phone.value.trim() : null;
  }
  const system = channel === 'instagram' ? 'instagram' : 'facebook';
  const socials = Array.isArray(card?.socials) ? card.socials : [];
  const found = socials.find((row) => String(row?.system ?? '').toLowerCase() === system
    && typeof row?.handle === 'string' && row.handle.trim() !== '');
  return found ? found.handle.trim() : null;
}

/**
 * The customer's latest email thread, newest passage first
 * (backlog:e9b4fc2f): the composer reply stays in the same Gmail thread
 * instead of opening one per send. Null when the customer has no email
 * passage yet — the provider then opens a new thread.
 */
async function latestEmailThread(app, subject) {
  const timeline = await app.readCustomerTimeline({ resource: subject.resource, id: subject.id });
  const items = Array.isArray(timeline?.entries?.items) ? timeline.entries.items : [];
  const mails = items
    .filter((row) => row?.entry === 'message' && row?.channel === 'email'
      && typeof row.conversationId === 'string' && row.conversationId.startsWith('email:'))
    .sort((left, right) => String(right.occurredAt ?? '').localeCompare(String(left.occurredAt ?? '')));
  const newest = mails[0] ?? null;
  if (newest === null) return null;
  const threadId = newest.conversationId.slice('email:'.length);
  if (threadId === '' || threadId.length > 128 || /\s/.test(threadId)) return null;
  return { conversationId: newest.conversationId, threadId };
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

/**
 * Whether a registered module came from an opt-in bundle (BO-F6-01): the
 * sidebar lists bundles but never kernel tables. Read from the application's
 * bundle registry; unknown stays kernel fail-closed.
 * @param {any} app @param {unknown} name
 */
function isCustomModule(app, name) {
  return typeof name === 'string'
    && Array.isArray(app?.customModuleNames)
    && app.customModuleNames.includes(name);
}

/** @param {any} module @param {any[]} [actions] @param {'bundle' | 'kernel'} [origin] */
function generatedModuleMetadata(module, actions = [], origin = 'kernel') {
  return {
    name: module.name,
    description: module.description ?? null,
    kind: module.kind,
    // BO-F6-01: where the module came from — 'bundle' for opt-in user
    // modules, 'kernel' for framework tables. Additive under
    // generatedResourceContract 1: an older client simply ignores it, and the
    // sidebar treats a missing origin as kernel (never lists it).
    origin,
    manifestVersion: module.manifestVersion ?? 1,
    capabilities: module.capabilities,
    // ADR-008 addendum 2. Additive: a client that does not know about it simply
    // never sends a filter, and an older generated module that does not publish
    // it cannot be filtered at all.
    filterableFields: module.filterableFields ?? [],
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
 * **Strict `filter.<field>=<value>` parsing for a collection read** (ADR-008
 * addendum 2).
 *
 * The collection read is a *display* read with a page bound, and until now it
 * had no way to say *which* rows it wanted a page of. A client that needed one
 * parent's rows had to fetch the newest N of the whole table and filter them
 * itself — which shows an empty list for a parent whose rows are older than that
 * page, while the page-bound notice beside it claims the bound was about the
 * screen. Both statements are then false at once, and the second one is the
 * dangerous kind of false because it sounds like a disclosure.
 *
 * The grammar is deliberately tiny, and everything it refuses it refuses with a
 * 400 rather than a silent behaviour change:
 *
 *   - only `filter.<field>`; every other query parameter is left alone;
 *   - only a field the module publishes in `filterableFields`, which is only its
 *     **indexed and unique** fields plus `id`, so a routed filter is always
 *     index-backed and no client can turn a page request into a table scan;
 *   - equality on a single non-empty scalar, at most 200 characters, never
 *     repeated, at most four at once. There is no `IN`, no range, no `OR` and no
 *     ordering control: this narrows a page, it is not a query language;
 *   - a module generated before this addendum publishes no `filterableFields`,
 *     and any filter against it is refused. It is never answered *unfiltered*,
 *     which would be the same false-completeness bug one layer down.
 *
 * `listWhere` stays in-process and unrouted: it is unbounded and complete, and a
 * correctness decision still must not be made from an HTTP page.
 *
 * @param {URLSearchParams} searchParams @param {any} module
 */
function strictCollectionFilter(searchParams, module) {
  /** @type {Record<string, string>} */
  const where = {};
  const allowed = Array.isArray(module.filterableFields) ? module.filterableFields : null;
  for (const key of new Set(searchParams.keys())) {
    if (!key.startsWith('filter.')) continue;
    const field = key.slice('filter.'.length);
    const values = searchParams.getAll(key);
    if (values.length > 1) {
      throw new ValidationError(`filter.${field} must not be repeated`, { field });
    }
    if (allowed === null) {
      throw new ValidationError(
        `Module "${module.name}" was generated before filtered collection reads and publishes no filterable fields. `
          + 'Regenerate it with `accordo module create --apply` rather than reading it unfiltered.',
        { field },
      );
    }
    if (!allowed.includes(field)) {
      throw new ValidationError(
        `filter.${field} is not a filterable field on "${module.name}". A filter must be index-backed; `
          + `filterable: ${allowed.join(', ')}`,
        { field },
      );
    }
    const value = values[0];
    if (value === '') throw new ValidationError(`filter.${field} must not be empty`, { field });
    if (value.length > 200) throw new ValidationError(`filter.${field} must be at most 200 characters`, { field });
    where[field] = value;
  }
  const fields = Object.keys(where);
  if (fields.length === 0) return undefined;
  if (fields.length > 4) {
    throw new ValidationError('At most four filters may be combined on a collection read', { fields });
  }
  return where;
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
    '.woff2': 'font/woff2',
  }[extension] ?? 'application/octet-stream';
}
