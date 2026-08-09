// @ts-check

/**
 * Stateless Streamable HTTP transport for the read-only Docs MCP server.
 *
 * The protocol implementation remains in `server.js`. This file owns only the
 * HTTP envelope: method/media-type/origin checks, modern MCP routing headers,
 * body bounds and the mapping from a JSON-RPC response to an HTTP response.
 */

import {
  createDocsMcpServer,
  DOCS_MCP_CURRENT_PROTOCOL,
  DOCS_MCP_SUPPORTED_PROTOCOLS,
} from './server.js';

export const DOCS_MCP_MAX_HTTP_BODY_BYTES = 1024 * 1024;

export const DOCS_MCP_PUBLIC_ORIGINS = Object.freeze([
  'https://accordo.dev',
  'https://www.accordo.dev',
  'https://chatgpt.com',
  'https://chat.openai.com',
  'https://claude.ai',
  'https://claude.com',
]);

const JSON_RPC_HEADER_MISMATCH = -32020;

/**
 * @param {{rootDir?: string, allowedOrigins?: string[], server?: ReturnType<typeof createDocsMcpServer>}} [options]
 */
export function createDocsMcpHttpHandler(options = {}) {
  const server = options.server ?? createDocsMcpServer({ rootDir: options.rootDir });
  const allowedOrigins = new Set(options.allowedOrigins ?? DOCS_MCP_PUBLIC_ORIGINS);

  /** @param {Request} request */
  return async function handleDocsMcpHttp(request) {
    const origin = request.headers.get('origin');
    if (origin !== null && !isAllowedOrigin(origin, allowedOrigins)) {
      return withTransportHeaders(jsonRpcResponse(403, null, -32600, 'Forbidden Origin'), null);
    }

    if (request.method === 'OPTIONS') {
      if (origin === null) {
        return withTransportHeaders(
          jsonRpcResponse(400, null, -32600, 'Origin is required for preflight'),
          null,
        );
      }
      return withTransportHeaders(new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name',
          'Access-Control-Max-Age': '600',
        },
      }), origin);
    }

    if (request.method !== 'POST') {
      return withTransportHeaders(jsonRpcResponse(
        405,
        null,
        -32600,
        'Method Not Allowed',
        undefined,
        { Allow: 'POST, OPTIONS' },
      ), origin);
    }

    const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      return withTransportHeaders(jsonRpcResponse(415, null, -32600, 'Content-Type must be application/json'), origin);
    }

    if (!acceptsMcpResponses(request.headers.get('accept'))) {
      return withTransportHeaders(jsonRpcResponse(
        406,
        null,
        -32600,
        'Accept must include application/json and text/event-stream',
      ), origin);
    }

    const declaredLength = parseContentLength(request.headers.get('content-length'));
    if (declaredLength === null) {
      return withTransportHeaders(jsonRpcResponse(400, null, -32600, 'Invalid Content-Length'), origin);
    }
    if (declaredLength > DOCS_MCP_MAX_HTTP_BODY_BYTES) {
      return withTransportHeaders(jsonRpcResponse(413, null, -32600, 'Request body is too large'), origin);
    }

    let text;
    try {
      text = await request.text();
    } catch {
      return withTransportHeaders(jsonRpcResponse(400, null, -32700, 'Parse error'), origin);
    }
    if (new TextEncoder().encode(text).byteLength > DOCS_MCP_MAX_HTTP_BODY_BYTES) {
      return withTransportHeaders(jsonRpcResponse(413, null, -32600, 'Request body is too large'), origin);
    }

    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return withTransportHeaders(jsonRpcResponse(400, null, -32700, 'Parse error'), origin);
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return withTransportHeaders(jsonRpcResponse(400, null, -32600, 'Body must be one JSON-RPC message'), origin);
    }

    const envelopeError = validateRequestMetadata(request.headers, message);
    if (envelopeError) {
      return withTransportHeaders(jsonRpcResponse(
        400,
        message.id ?? null,
        envelopeError.code,
        envelopeError.message,
        envelopeError.details,
      ), origin);
    }

    const response = await server.handle(message);
    if (response === null) {
      return withTransportHeaders(new Response(null, { status: 202 }), origin);
    }

    const status = response.error?.code === -32601 ? 404 : 200;
    return withTransportHeaders(Response.json(response, { status }), origin);
  };
}

/** @param {Headers} headers @param {any} message */
function validateRequestMetadata(headers, message) {
  const protocolHeader = headers.get('mcp-protocol-version');
  const bodyProtocol = message.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  const modern = message.method === 'server/discover'
    || bodyProtocol === DOCS_MCP_CURRENT_PROTOCOL
    || protocolHeader === DOCS_MCP_CURRENT_PROTOCOL;

  if (protocolHeader !== null && !DOCS_MCP_SUPPORTED_PROTOCOLS.includes(protocolHeader)) {
    return metadataError(
      `Unsupported MCP protocol version: ${protocolHeader}`,
      { supported: DOCS_MCP_SUPPORTED_PROTOCOLS },
    );
  }
  if (modern && protocolHeader === null) {
    return metadataError('Missing MCP-Protocol-Version header');
  }
  if (modern && bodyProtocol !== DOCS_MCP_CURRENT_PROTOCOL) {
    return metadataError('MCP-Protocol-Version header does not match body metadata');
  }
  if (modern && protocolHeader !== bodyProtocol) {
    return metadataError('MCP-Protocol-Version header does not match body metadata');
  }

  const methodHeader = headers.get('mcp-method');
  if (modern && methodHeader === null) return metadataError('Missing Mcp-Method header');
  if (methodHeader !== null && methodHeader !== message.method) {
    return metadataError('Mcp-Method header does not match the JSON-RPC method');
  }

  const expectedName = requestName(message);
  const nameHeader = headers.get('mcp-name');
  if (modern && expectedName !== null && nameHeader === null) return metadataError('Missing Mcp-Name header');
  if (nameHeader !== null) {
    let decoded;
    try {
      decoded = decodeHeaderValue(nameHeader);
    } catch {
      return metadataError('Mcp-Name header is malformed');
    }
    if (expectedName === null || decoded !== expectedName) {
      return metadataError('Mcp-Name header does not match the JSON-RPC request');
    }
  }

  return null;
}

/** @param {any} message */
function requestName(message) {
  if (message.method === 'tools/call' || message.method === 'prompts/get') {
    return typeof message.params?.name === 'string' ? message.params.name : null;
  }
  if (message.method === 'resources/read') {
    return typeof message.params?.uri === 'string' ? message.params.uri : null;
  }
  return null;
}

/** @param {string} value */
function decodeHeaderValue(value) {
  if (!value.startsWith('=?base64?') || !value.endsWith('?=')) return value;
  const encoded = value.slice('=?base64?'.length, -2);
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('invalid base64 sentinel');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (Buffer.from(decoded, 'utf8').toString('base64') !== encoded) throw new Error('non-canonical base64');
  return decoded;
}

/** @param {string | null} value */
function acceptsMcpResponses(value) {
  if (value === null) return false;
  const types = new Set(value.split(',').map((entry) => entry.split(';', 1)[0].trim().toLowerCase()));
  return types.has('application/json') && types.has('text/event-stream');
}

/** @param {string | null} value */
function parseContentLength(value) {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** @param {string} origin @param {Set<string>} allowed */
function isAllowedOrigin(origin, allowed) {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:'
      && url.origin === origin
      && allowed.has(url.origin);
  } catch {
    return false;
  }
}

/** @param {string} message @param {unknown} [details] */
function metadataError(message, details) {
  return { code: JSON_RPC_HEADER_MISMATCH, message, details };
}

/**
 * @param {number} status
 * @param {unknown} id
 * @param {number} code
 * @param {string} message
 * @param {unknown} [details]
 * @param {HeadersInit} [headers]
 */
function jsonRpcResponse(status, id, code, message, details, headers) {
  return Response.json({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(details === undefined ? {} : { data: details }) },
  }, { status, headers });
}

/** @param {Response} response @param {string | null} origin */
function withTransportHeaders(response, origin) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Vary', 'Origin');
  if (origin !== null) headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
