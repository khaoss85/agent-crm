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
    const mode = app?.spine?.mode?.mode ?? null;
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

/** @param {any} app */
function buildRouter(app) {
  const router = new Router();

  router.add('GET', '/health', async () => operationalHealth(app), { skipIdentity: true });

  router.add('GET', '/api/admin/metrics', async ({ identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.metrics !== 'function') {
      throw new NotFoundError('Operation', 'admin metrics');
    }
    return { counts: app.metrics() };
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

  router.add('GET', '/api/customer-data/profile/:resource/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    if (typeof app.readCustomerProfile !== 'function') {
      throw new NotFoundError('Operation', 'customer profile');
    }
    return await app.readCustomerProfile({ resource: params.resource, id: params.id });
  });

  // Uniform resource surface for generated modules (ADR-008). Only modules
  // that fully satisfy the generated-module contract are served; anything
  // else — unknown names, handwritten core modules, malformed or hand-edited
  // definitions — fails closed as 404. This is a framework contract against
  // accidental misuse, not a sandbox against malicious source-code changes.
  router.add('GET', '/api/modules/:module', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    const module = resolveGeneratedModule(app, params.module);
    return generatedModuleMetadata(module, app.actions.listForModule(module.name));
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
  router.add('POST', '/api/modules/:module/records', async ({ params, body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'create');
    return respond(201, await module.service.create(recordInput(body), { actor }));
  });
  router.add('GET', '/api/modules/:module/records/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'get');
    return await module.service.get(params.id);
  });
  router.add('PATCH', '/api/modules/:module/records/:id', async ({ params, body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    const module = requireCapability(resolveGeneratedModule(app, params.module), 'update');
    return await module.service.update(params.id, recordInput(body), { actor });
  });

  // Code-first actions over the generic surface (ADR-011/014). The route only
  // resolves the module and delegates to the action runtime — it never writes
  // to the database directly. Eligible targets are exposable generated
  // modules, plus handwritten core modules that have at least one action
  // registered (registration in checked-in source IS the explicit eligibility
  // declaration — core CRUD stays on its dedicated routes and is never served
  // by the generic records surface). Anything else is a 404; unknown action
  // 404; bad input 400; invalid transition a stable 409.
  router.add('POST', '/api/modules/:module/records/:id/actions/:action', async ({ params, body, actor, identity, organizationId }) => {
    resolveActionableModule(app, params.module); // 404 for unknown/ineligible modules
    // The action runtime authorizes with the action's own declared permission;
    // passing the identity through is what makes that possible.
    return await app.runAction({
      module: params.module,
      action: params.action,
      recordId: params.id,
      input: actionInput(body),
      actor,
      identity,
      organizationId,
    });
  });

  router.add('GET', '/api/companies', async ({ query, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return { items: await app.services.companies.list({ limit: parseLimit(query.limit) }) };
  });
  router.add('POST', '/api/companies', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    return respond(201, await app.services.companies.create(body ?? {}, { actor }));
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
  router.add('POST', '/api/contacts', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    return respond(201, await app.services.contacts.create(body ?? {}, { actor }));
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
  router.add('POST', '/api/opportunities', async ({ body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    return respond(201, await app.services.opportunities.create(body ?? {}, { actor }));
  });
  router.add('GET', '/api/opportunities/:id', async ({ params, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.read');
    return await app.services.opportunities.get(params.id);
  });
  router.add('POST', '/api/opportunities/:id/stage', async ({ params, body, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'records.write');
    return await app.workflows.run(
      'request-opportunity-stage-change',
      { opportunityId: params.id, targetStage: body?.targetStage },
      { actor },
    );
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
  router.add('POST', '/api/approvals/:id/approve', async ({ params, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'approvals.decide');
    return await app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: params.id, decision: 'approved' },
      { actor },
    );
  });
  router.add('POST', '/api/approvals/:id/reject', async ({ params, actor, identity, organizationId }) => {
    await gate(app, identity, organizationId, 'approvals.decide');
    return await app.workflows.run(
      'decide-opportunity-approval',
      { approvalId: params.id, decision: 'rejected' },
      { actor },
    );
  });

  // Trace and audit are evidence about everyone in the tenant, so they are
  // read-gated like any other record read. An ungated audit route is a
  // disclosure of who did what, which is precisely what this milestone exists
  // to protect.
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
  if (!app?.spine) return null;
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
 * @param {any} app @param {import('node:http').IncomingMessage} request
 */
async function requestIdentity(app, request) {
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
