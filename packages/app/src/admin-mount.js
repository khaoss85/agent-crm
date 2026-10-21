// @ts-check

/**
 * The Admin shell as an embedding mount (backlog:ecdf7dc4).
 *
 * The standalone server (`apps/server`) owns the Admin shell at the domain
 * root: static files plus the `/api/*` routes of `buildRouter`, under the
 * request identity of `requestIdentity`. A host that already serves many
 * tenants — the shared pilot web, one process for every space — cannot put
 * that server on a socket per space. It needs the same shell as a value it
 * can call: same routes, same static files, but under its own path prefix
 * and its own session.
 *
 * That is what this module publishes. `createAdminShellMount(app, options)`
 * binds the composed application once and returns a `handle` function over
 * plain request/response shapes — no socket, no framework session:
 *
 *   const mount = createAdminShellMount(app, {
 *     basePath: '/bo',
 *     identityFor: async ({ cookies }) => spaceIdentity(cookies),
 *   });
 *   const answer = await mount.handle({ method: 'GET', path: '/bo/api/schema', headers: {} });
 *   // answer === null when the path is outside the mount.
 *
 * The contract, kept deliberately narrow:
 *
 * - **Same routes.** API handling is `buildRouter` from `apps/server`, driven
 *   with the same handler context the server builds — `{ params, query,
 *   searchParams, body, rawBody, headers, actor, identity, organizationId }`
 *   — and normalized the same way (explicit envelope or plain payload as
 *   200; `normalizeError` otherwise, so an `AppError` keeps its status and
 *   code). The one deliberate difference: the mount never reads the request
 *   body itself. The embedder owns its transport, so it passes `body`
 *   (parsed) or `rawBody` (bytes) and the mount forwards them untouched.
 * - **Caller-owned identity.** `identityFor` maps the incoming request to
 *   `{ actor, identity, organizationId }`. Omitting it falls back to the
 *   server's own `requestIdentity` (local-development parity). The mount
 *   performs no session check of its own: the embedder gates the whole
 *   `basePath` subtree before calling `handle`, and says so in its own
 *   review. An identity the handlers refuse still fails closed inside them —
 *   every route runs the same `gate` as on the standalone server.
 * - **Reads travel first.** The default `methods` is `['GET', 'HEAD']`.
 *   A host embedding the shell behind another session gets the read shell —
 *   navigation, dashboard, pipeline board, customer card — while anything
 *   that writes is answered `405 ADMIN_METHOD_NOT_ALLOWED`, never half-run.
 *   Pass `methods` explicitly to widen it; the widening is then visible in
 *   the caller's review, where the session that authorizes those writes is.
 * - **Same static files, prefixed.** `GET`/`HEAD` under the base path serves
 *   `apps/admin/public` through the same reader the server uses, with two
 *   injections into served HTML only: `<base href="{basePath}/">` so relative
 *   asset references stay under the mount, and
 *   `<meta name="admin-base" content="{basePath}">` so the shell's API
 *   client prefixes its absolute `/api/*` paths (see
 *   `apps/admin/public/admin-base.js`). At the default `basePath: ''` both
 *   injections are inert (`<base href="/">`, empty meta) and the served
 *   bytes behave exactly as the standalone server's.
 * - **No domain logic.** The mount mounts: it interprets no payload, invents
 *   no identity, and maps no space. A space the caller's `identityFor`
 *   cannot resolve fails inside the framework gates, not here.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeError } from '../../core/src/errors.js';
import { refuseThenableDomainValue } from '../../core/src/async-values.js';
import {
  buildRouter,
  isResponseEnvelope,
  readStaticFile,
  requestIdentity,
} from '../../../apps/server/src/index.js';

const DEFAULT_PUBLIC_DIR = resolve(
  fileURLToPath(new URL('../../../apps/admin/public', import.meta.url)),
);

const DEFAULT_METHODS = Object.freeze(['GET', 'HEAD']);

/**
 * @param {string} basePath
 */
function checkBasePath(basePath) {
  if (basePath === '') return;
  if (
    typeof basePath !== 'string'
    || !basePath.startsWith('/')
    || basePath.endsWith('/')
    || /[\s]/.test(basePath)
  ) {
    throw new Error(
      'ADMIN_MOUNT_BASE_PATH_REFUSED: basePath is "" or a "/bo"-style prefix with no trailing slash',
    );
  }
}

/**
 * @param {string} html
 * @param {string} basePath
 */
export function injectAdminBase(html, basePath) {
  const base = `<base href="${basePath === '' ? '/' : `${basePath}/`}">`;
  const meta = `<meta name="admin-base" content="${basePath}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (head) => `${head}${base}${meta}`);
  return `${base}${meta}${html}`;
}

/**
 * @param {any} app
 * @param {{ basePath?: string, publicDir?: string, identityFor?: Function, methods?: string[] }} [options]
 */
export function createAdminShellMount(app, options = {}) {
  const basePath = options.basePath ?? '';
  checkBasePath(basePath);
  const publicDir = resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);
  const methods = Object.freeze(
    (options.methods ?? [...DEFAULT_METHODS]).map((method) => String(method).toUpperCase()),
  );
  const identityFor = options.identityFor
    ?? (({ headers, method, url }) => requestIdentity(app, { headers, method, url }));
  const router = buildRouter(app);

  return Object.freeze({
    basePath,
    methods,
    /**
     * @param {{ method?: string, path?: string, query?: string|Record<string, string|string[]|undefined>, headers?: Record<string, string|string[]|undefined>, cookies?: Record<string, string|undefined>, body?: unknown, rawBody?: unknown }} request
     */
    async handle(request) {
      const method = String(request?.method ?? 'GET').toUpperCase();
      const fullPath = String(request?.path ?? '/');
      if (basePath !== '') {
        if (fullPath !== basePath && !fullPath.startsWith(`${basePath}/`)) return null;
      }
      const pathname = fullPath.slice(basePath.length) || '/';
      if (!methods.includes(method)) {
        return json(405, {
          error: { code: 'ADMIN_METHOD_NOT_ALLOWED', message: `Method ${method} is not mounted here` },
        });
      }
      const headers = request?.headers ?? {};
      const searchParams = toSearchParams(request?.query);
      const query = Object.fromEntries(searchParams.entries());
      const route = router.match(method === 'HEAD' ? 'GET' : method, pathname);
      if (route) {
        try {
          const { actor, identity, organizationId } = await identityFor({
            headers,
            cookies: request?.cookies ?? {},
            method,
            path: fullPath,
          });
          const result = await route.handler({
            request: { headers, method, url: fullPath },
            response: null,
            params: route.params,
            query,
            searchParams,
            body: request?.body,
            rawBody: request?.rawBody,
            headers,
            actor,
            identity,
            organizationId,
          });
          refuseThenableDomainValue(result, 'http handler result');
          const envelope = isResponseEnvelope(result) ? result : { status: 200, body: result };
          if (isResponseEnvelope(result)) refuseThenableDomainValue(result.body, 'http body');
          if (method === 'HEAD') {
            const serialized = serializeBody(envelope.body);
            return {
              status: envelope.status,
              headers: { ...serialized.headers, ...(envelope.headers ?? {}) },
              body: Buffer.alloc(0),
            };
          }
          return serializeEnvelope(envelope);
        } catch (error) {
          const normalized = normalizeError(error);
          return json(normalized.status, {
            error: {
              code: normalized.code,
              message: normalized.message,
              details: normalized.details ?? null,
            },
          });
        }
      }
      if (method !== 'GET' && method !== 'HEAD') {
        return json(404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
      }
      const found = await readStaticFile(publicDir, pathname);
      if (!found) {
        return json(404, { error: { code: 'NOT_FOUND', message: 'Route not found' } });
      }
      let data = found.data;
      if (found.contentType.startsWith('text/html')) {
        data = Buffer.from(injectAdminBase(found.data.toString('utf8'), basePath), 'utf8');
      }
      const responseHeaders = { 'content-type': found.contentType, 'cache-control': 'no-cache' };
      if (method === 'HEAD') return { status: 200, headers: responseHeaders, body: Buffer.alloc(0) };
      return { status: 200, headers: responseHeaders, body: data };
    },
  });
}

/**
 * @param {string|Record<string, string|string[]|undefined>} [query]
 */
function toSearchParams(query) {
  const params = new URLSearchParams();
  if (typeof query === 'string') {
    const bare = query.startsWith('?') ? query.slice(1) : query;
    return new URLSearchParams(bare);
  }
  if (query && typeof query === 'object') {
    for (const [name, value] of Object.entries(query)) {
      if (Array.isArray(value)) for (const item of value) params.append(name, String(item));
      else if (value !== undefined) params.append(name, String(value));
    }
  }
  return params;
}

/**
 * @param {unknown} body
 */
function serializeBody(body) {
  const payload = JSON.stringify(body);
  return {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    payload,
  };
}

/**
 * @param {{ status: number, body: unknown, headers?: Record<string, string> }} envelope
 */
function serializeEnvelope(envelope) {
  const { headers, payload } = serializeBody(envelope.body);
  return { status: envelope.status, headers: { ...headers, ...(envelope.headers ?? {}) }, body: payload };
}

/**
 * @param {number} status
 * @param {unknown} body
 */
function json(status, body) {
  const { headers, payload } = serializeBody(body);
  return { status, headers, body: payload };
}
