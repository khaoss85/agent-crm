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
 *   code). The mount never reads the request body itself — the embedder owns
 *   its transport, so it passes `body` (parsed) or `rawBody` (bytes) and the
 *   mount applies the route's own body policy: JSON routes parse/validate
 *   with the same size limits and `INVALID_JSON`/`PAYLOAD_TOO_LARGE` errors
 *   as the standalone server; `rawBody` routes require the exact bytes.
 * - **Caller-owned identity.** `identityFor` maps the incoming request to
 *   `{ actor, identity, organizationId }`. Omitting it falls back to the
 *   server's own `requestIdentity` (local-development parity), called with
 *   the same `{ headers, method, url }` triple the server passes, where `url`
 *   is the mount-relative pathname plus the merged query string. Routes that
 *   opt into `skipIdentity` (process liveness, e.g. `/health`) resolve to
 *   `{ actor: null, identity: null, organizationId: null }` without calling
 *   `identityFor` at all, exactly as the standalone server skips
 *   `requestIdentity` for them. The mount performs no session check of its
 *   own: the embedder gates the whole `basePath` subtree before calling
 *   `handle`, and says so in its own review. An identity the handlers refuse
 *   still fails closed inside them — every route runs the same `gate` as on
 *   the standalone server. `identityFor` receives
 *   `{ headers, cookies, method, path, url }`: `path` is the full mount path
 *   without the query string, `url` adds the merged query string, so
 *   verifiers that sign or log the URL see the same shape the standalone
 *   server passes its own `requestIdentity`.
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
 *   bytes behave exactly as the standalone server's. Responses carry the
 *   same `content-length` and `idempotency-key` propagation `sendJson`
 *   guarantees, including the static branch.
 * - **No domain logic.** The mount mounts: it interprets no payload, invents
 *   no identity, and maps no space. A space the caller's `identityFor`
 *   cannot resolve fails inside the framework gates, not here.
 * - **Session display profile (BO-F6-03).** An embedder behind a real session
 *   passes `sessionFor`, an async function of `{ headers, cookies, path }`
 *   returning the display profile the shell shows — the contract of
 *   `apps/admin/public/admin-session.js`
 *   (`{ space: { id, name }, role, name, email, logoutUrl }`), or nullish
 *   when there is none. The mount serializes it (never validating its
 *   content — the embedder built it from its verified session) into served
 *   HTML as `<script id="bo-session" type="application/json">`, with `<`
 *   escaped so a hostile value cannot close the tag. A `sessionFor` failure
 *   serves the page without a profile — the shell keeps its local
 *   development identity — never a failed shell. Omitting `sessionFor`
 *   (the standalone server) changes nothing.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppError, normalizeError } from '../../core/src/errors.js';
import { refuseThenableDomainValue } from '../../core/src/async-values.js';
import {
  buildRouter,
  isResponseEnvelope,
  readStaticFile,
  requestIdentity,
  staticCacheControl,
} from '../../../apps/server/src/index.js';

const DEFAULT_PUBLIC_DIR = resolve(
  fileURLToPath(new URL('../../../apps/admin/public', import.meta.url)),
);

const DEFAULT_METHODS = Object.freeze(['GET', 'HEAD']);

// The standalone server caps streamed JSON bodies at 1 MiB (`readJson`) and
// raw provider bytes at the route's `maxBodyBytes` (64 KiB where the route
// sets one). The mount enforces the same caps on the embedder-supplied
// values, because the handlers behind them were reviewed against those
// bounds.
const JSON_BODY_LIMIT = 1_000_000;
const RAW_BODY_DEFAULT_LIMIT = 65_536;

// Mount prefixes live inside served HTML and are matched against request
// paths, so they keep the tightest grammar that still reads as a path:
// segments of unreserved characters, no trailing slash, and none of
// `"'<>&?#` or whitespace — anything that could break out of an attribute
// or smuggle a second path is refused at construction.
const BASE_PATH_GRAMMAR = /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

/**
 * @param {string} basePath
 */
function checkBasePath(basePath) {
  if (basePath === '') return;
  if (typeof basePath !== 'string' || !BASE_PATH_GRAMMAR.test(basePath)) {
    throw new Error(
      'ADMIN_MOUNT_BASE_PATH_REFUSED: basePath is "" or a "/bo"-style prefix of [A-Za-z0-9._~-] segments with no trailing slash',
    );
  }
}

/**
 * @param {string} value
 */
function escapeHtmlAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The framework-technical footer of the Admin shell (version and the
 * "same services" line, marked `data-bo-technical` in index.html). A space
 * user under a mount never sees it (backlog:42fd49b8); the standalone
 * server path serves the shell unchanged, footer included. Only the marked
 * footer is ever removed, so an unmarked footer stays put even if the
 * markup moves.
 */
const TECHNICAL_FOOTER_RE = /<footer\b[^>]*\bdata-bo-technical\b[^>]*>[\s\S]*?<\/footer\s*>/i;

/**
 * @param {string} html
 * @param {string} basePath
 */
export function injectAdminBase(html, basePath) {
  const escaped = escapeHtmlAttr(basePath);
  const base = `<base href="${escaped === '' ? '/' : `${escaped}/`}">`;
  const meta = `<meta name="admin-base" content="${escaped}">`;
  const injected = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (head) => `${head}${base}${meta}`)
    : `${base}${meta}${html}`;
  if (basePath === '') return injected;
  return injected.replace(TECHNICAL_FOOTER_RE, '');
}

/**
 * Serialize a session display profile into served HTML (BO-F6-03). A
 * non-object profile injects nothing; `<` is escaped so a hostile value
 * cannot close the script tag. The reader (`admin-session.js`) validates
 * the shape and drops anything it does not recognize.
 * @param {string} html
 * @param {unknown} profile
 */
export function injectSessionProfile(html, profile) {
  if (typeof html !== 'string') return html;
  if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) return html;
  let json;
  try {
    json = JSON.stringify(profile);
  } catch {
    return html;
  }
  if (typeof json !== 'string' || json === '') return html;
  const script = `<script id="bo-session" type="application/json">${json.replace(/</g, '\\u003c')}</script>`;
  if (/<\/head\s*>/i.test(html)) return html.replace(/<\/head\s*>/i, (head) => `${script}${head}`);
  return `${script}${html}`;
}

/**
 * @param {any} app
 * @param {{ basePath?: string, publicDir?: string, identityFor?: Function, sessionFor?: Function, methods?: string[] }} [options]
 */
export function createAdminShellMount(app, options = {}) {
  const basePath = options.basePath ?? '';
  checkBasePath(basePath);
  const sessionFor = typeof options.sessionFor === 'function' ? options.sessionFor : null;
  const publicDir = resolve(options.publicDir ?? DEFAULT_PUBLIC_DIR);
  const methods = Object.freeze(
    (options.methods ?? [...DEFAULT_METHODS]).map((method) => String(method).toUpperCase()),
  );
  const identityFor = options.identityFor
    ?? (({ headers, method, url, path }) => requestIdentity(app, { headers, method, url: url ?? path }));
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
      // The embedder may forward the raw target with its query string and
      // fragment (`/bo/api/approvals?status=pending`). Routing and the
      // static reader both see the pathname only; the embedded query string
      // merges with the explicit `query` below. Nothing is decoded or
      // normalized here: `router.match` and `readStaticFile` own decoding,
      // and normalizing first would turn a traversal attempt into a
      // different path than the standalone server 404s.
      const queryIndex = fullPath.search(/[?#]/);
      const rawPath = queryIndex === -1 ? fullPath : fullPath.slice(0, queryIndex);
      let embeddedQuery = '';
      if (queryIndex !== -1 && fullPath[queryIndex] === '?') {
        const hashIndex = fullPath.indexOf('#', queryIndex + 1);
        embeddedQuery = fullPath.slice(queryIndex + 1, hashIndex === -1 ? undefined : hashIndex);
      }
      if (basePath !== '') {
        if (rawPath !== basePath && !rawPath.startsWith(`${basePath}/`)) return null;
      }
      const pathname = rawPath.slice(basePath.length) || '/';
      if (!methods.includes(method)) {
        return json(405, {
          error: { code: 'ADMIN_METHOD_NOT_ALLOWED', message: `Method ${method} is not mounted here` },
        });
      }
      const searchParams = mergeQuery(new URLSearchParams(embeddedQuery), request?.query);
      const query = Object.fromEntries(searchParams.entries());
      // The verifier behind the default `identityFor` may sign or log the
      // URL, so it sees the same value the standalone server passes its own
      // `requestIdentity`: the mount-relative pathname plus the merged
      // query string.
      const requestUrl = searchParams.size > 0 ? `${pathname}?${searchParams.toString()}` : pathname;
      const route = router.match(method === 'HEAD' ? 'GET' : method, pathname);
      if (route) {
        try {
          // Liveness routes opt out of identity on the standalone server so
          // a probe never bootstraps tenant state; the mount honors the same
          // flag instead of running the embedder's identity path.
          const skipIdentity = route.options?.skipIdentity === true;
          const { actor, identity, organizationId } = skipIdentity
            ? { actor: null, identity: null, organizationId: null }
            : await identityFor({
              headers: request?.headers ?? {},
              cookies: request?.cookies ?? {},
              method,
              path: `${basePath}${pathname}`,
              url: `${basePath}${requestUrl}`,
            });
          const writesBody = method === 'POST' || method === 'PUT' || method === 'PATCH';
          let body = null;
          let rawBody = null;
          if (writesBody) {
            const maxBytes = route.options?.maxBodyBytes
              ?? (route.options?.rawBody ? RAW_BODY_DEFAULT_LIMIT : JSON_BODY_LIMIT);
            if (route.options?.rawBody) {
              rawBody = toRawBytes(request?.rawBody, request?.body, maxBytes);
            } else {
              body = parseJsonBody(request?.body, request?.rawBody, maxBytes);
            }
          }
          const result = await route.handler({
            request: { headers: request?.headers ?? {}, method, url: `${basePath}${requestUrl}` },
            response: null,
            params: route.params,
            query,
            searchParams,
            body,
            rawBody,
            headers: request?.headers ?? {},
            actor,
            identity,
            organizationId,
          });
          refuseThenableDomainValue(result, 'http handler result');
          const envelope = isResponseEnvelope(result) ? result : { status: 200, body: result };
          if (isResponseEnvelope(result)) refuseThenableDomainValue(result.body, 'http body');
          if (method === 'HEAD') {
            const answered = serializeEnvelope(envelope);
            return {
              status: answered.status,
              headers: answered.headers,
              body: Buffer.alloc(0),
            };
          }
          return serializeEnvelope(envelope);
        } catch (error) {
          const normalized = normalizeError(error);
          // The standalone server answers handler errors with `sendJson`,
          // which echoes the idempotency key — the mount serializes the same
          // envelope shape instead of the bare `json` helper.
          return serializeEnvelope({
            status: normalized.status,
            body: {
              error: {
                code: normalized.code,
                message: normalized.message,
                details: normalized.details ?? null,
              },
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
      // Per-user bytes must never ride a shared cache: once a session
      // profile is injected the HTML differs per operator and space, so it
      // leaves with private headers. Untouched HTML is `no-store` anyway —
      // it names the current content-hashed bundle — while the hashed
      // bundle files themselves are the shared-cacheable ones.
      let profileInjected = false;
      if (found.contentType.startsWith('text/html')) {
        let html = injectAdminBase(found.data.toString('utf8'), basePath);
        if (sessionFor !== null) {
          try {
            const profile = await sessionFor({
              headers: request?.headers ?? {},
              cookies: request?.cookies ?? {},
              path: rawPath,
            });
            html = injectSessionProfile(html, profile);
            profileInjected = html.includes('<script id="bo-session"');
          } catch (error) {
            // Display-only: a profile failure serves the page without one —
            // the shell keeps its local identity — never a failed shell. The
            // cause still stays diagnosable (review gate: only the error name
            // and the mount path, never bodies, cookies or profile data), so
            // a broken integration reads differently from an absent profile.
            try {
              console.warn('bo-session profile unreadable:', error instanceof Error ? error.name : 'unknown', `path=${rawPath}`);
            } catch {
              // Logging must never break the shell.
            }
          }
        }
        data = Buffer.from(html, 'utf8');
      }
      // `content-length` is measured after the HTML injection above, and
      // `HEAD` answers the same headers with an empty body — the static
      // branch mirrors `serveStatic`, which always sends it. The cache
      // policy is the server's own (`staticCacheControl`, backlog:3f74a2f296ec):
      // content-hashed bundles are immutable, HTML entry points are
      // no-store, and only a per-operator profile forces private headers.
      const responseHeaders = {
        'content-type': found.contentType,
        'content-length': String(data.byteLength),
        'cache-control': profileInjected ? 'private, no-store' : staticCacheControl(pathname),
        ...(profileInjected ? { vary: 'Cookie' } : {}),
      };
      if (method === 'HEAD') return { status: 200, headers: responseHeaders, body: Buffer.alloc(0) };
      return { status: 200, headers: responseHeaders, body: data };
    },
  });
}

/**
 * Merge the embedder's explicit `query` over the parameters already present
 * (embedded in `path`). Explicit object values win per name; an explicit
 * query string appends deterministically after the embedded pairs.
 *
 * @param {URLSearchParams} params
 * @param {string|Record<string, string|string[]|undefined>} [query]
 */
function mergeQuery(params, query) {
  if (typeof query === 'string') {
    const bare = query.startsWith('?') ? query.slice(1) : query;
    for (const [name, value] of new URLSearchParams(bare)) params.append(name, value);
    return params;
  }
  if (query && typeof query === 'object') {
    for (const [name, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        params.delete(name);
        for (const item of value) params.append(name, String(item));
      } else if (value !== undefined) {
        params.set(name, String(value));
      }
    }
  }
  return params;
}

/**
 * The exact bytes for a `rawBody` route (ADR-017): a signature can only be
 * checked against the bytes the provider signed, so a parsed object with no
 * raw bytes is refused instead of re-serialized, and the route's size cap
 * applies before anything else reads them.
 *
 * @param {unknown} rawBody @param {unknown} body @param {number} maxBytes
 */
function toRawBytes(rawBody, body, maxBytes) {
  if (rawBody === undefined || rawBody === null) {
    // Parity with an empty request stream, which the server reads as zero
    // bytes — but a parsed body alone can never reproduce signed bytes.
    if (body === undefined || body === null) return Buffer.alloc(0);
    throw new AppError('Request body must be raw bytes for this route', {
      code: 'INVALID_JSON',
      status: 400,
    });
  }
  const bytes = Buffer.isBuffer(rawBody)
    ? rawBody
    : ArrayBuffer.isView(rawBody)
      ? Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength)
      : rawBody instanceof ArrayBuffer
        ? Buffer.from(rawBody)
        : typeof rawBody === 'string'
          ? Buffer.from(rawBody, 'utf8')
          : null;
  if (!bytes) {
    throw new AppError('Request body must be raw bytes for this route', {
      code: 'INVALID_JSON',
      status: 400,
    });
  }
  if (bytes.byteLength > maxBytes) {
    throw new AppError('Request body too large', { code: 'PAYLOAD_TOO_LARGE', status: 413 });
  }
  return bytes;
}

/**
 * The parsed body for a JSON route, mirroring `readJson`: empty input is
 * `{}`, malformed JSON is `INVALID_JSON`, oversized input is
 * `PAYLOAD_TOO_LARGE`. The embedder may pass either the parsed value or the
 * raw bytes — never neither on a write, never a parsed value where bytes
 * belong (see `toRawBytes`).
 *
 * @param {unknown} body @param {unknown} rawBody @param {number} maxBytes
 */
function parseJsonBody(body, rawBody, maxBytes) {
  if (body !== undefined && body !== null) {
    if (typeof body !== 'string') return body;
    if (Buffer.byteLength(body) > maxBytes) {
      throw new AppError('Request body too large', { code: 'PAYLOAD_TOO_LARGE', status: 413 });
    }
    if (body.length === 0) return {};
    try {
      return JSON.parse(body);
    } catch {
      throw new AppError('Request body must be valid JSON', { code: 'INVALID_JSON', status: 400 });
    }
  }
  if (rawBody !== undefined && rawBody !== null) {
    const bytes = toRawBytes(rawBody, undefined, maxBytes);
    if (bytes.byteLength === 0) return {};
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new AppError('Request body must be valid JSON', { code: 'INVALID_JSON', status: 400 });
    }
  }
  return {};
}

/**
 * @param {unknown} body
 */
function serializeBody(body) {
  const payload = JSON.stringify(body);
  return {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(Buffer.byteLength(payload)),
      'cache-control': 'no-store',
    },
    payload,
  };
}

/**
 * Serialize a handler envelope the way `sendJson` answers it: JSON with
 * `content-length`, plus the `idempotency-key` echo — an explicit envelope
 * header first, then `body.idempotencyKey`, then
 * `body.error.details.idempotencyKey` — so polling and retry clients behind
 * the mount see exactly what the standalone server sends.
 *
 * @param {{ status: number, body: unknown, headers?: Record<string, string> }} envelope
 */
export function serializeEnvelope(envelope) {
  const { headers, payload } = serializeBody(envelope.body);
  const merged = { ...headers, ...(envelope.headers ?? {}) };
  const key = merged['idempotency-key']
    ?? (envelope.body && typeof envelope.body === 'object'
      ? /** @type {any} */ (envelope.body).idempotencyKey
      : undefined)
    ?? (envelope.body && typeof envelope.body === 'object'
      && /** @type {any} */ (envelope.body).error?.details?.idempotencyKey);
  if (typeof key === 'string' && key !== '') merged['idempotency-key'] = key;
  return { status: envelope.status, headers: merged, body: payload };
}

/**
 * @param {number} status
 * @param {unknown} body
 */
function json(status, body) {
  const { headers, payload } = serializeBody(body);
  return { status, headers, body: payload };
}
