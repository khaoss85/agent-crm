// @ts-check

/**
 * The Docs MCP server.
 *
 * A second, strictly read-only MCP server that serves this framework's
 * documentation, its claims ledger and its jobs index — and nothing else. It is
 * separate from `packages/mcp` on purpose:
 *
 *   - `packages/mcp` opens the CRM database and exposes narrow write tools. It
 *     belongs to a project, needs a database path, and can only run where one
 *     exists.
 *   - this server opens no database, exposes no write tool and holds no customer
 *     record. It answers questions about the framework, which means it is safe to
 *     run anywhere and safe to host — the only kind of server that can be offered
 *     to a directory before a production spine exists.
 *
 * Transport, framing, protocol negotiation and error shape are the same as
 * `packages/mcp/src/server.js`, deliberately: two servers from one repository
 * that disagree about framing are two servers a client has to special-case.
 */

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizeError } from '../../core/src/errors.js';
import { createDocCorpus } from './corpus.js';
import { createClaimsLedger } from './ledger.js';
import { createJobsIndex } from './jobs.js';
import { createToolRegistry } from './tools.js';
import { createResourceRegistry } from './resources.js';

const SERVER_INFO = Object.freeze({ name: 'accordo-docs', version: '0.1.0' });
export const DOCS_MCP_CURRENT_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2025-11-25';
export const DOCS_MCP_SUPPORTED_PROTOCOLS = Object.freeze([
  DOCS_MCP_CURRENT_PROTOCOL,
  LEGACY_PROTOCOL,
  '2025-06-18',
  '2024-11-05',
]);
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

const INSTRUCTIONS =
  'Read-only documentation for an agent-native CRM framework. search_docs finds prose; get_capability returns a '
  + 'proven capability together with the limitation that bounds it; check_job answers whether a CRM job is '
  + 'supported, and answers "not supported" when that is the truth. Never quote a capability without its '
  + 'limitation — the two are one statement. This server holds no customer data and can write nothing.';

/**
 * @param {{rootDir?: string}} [options]
 */
export function createDocsMcpServer({ rootDir = DEFAULT_ROOT } = {}) {
  const corpus = createDocCorpus({ rootDir });
  const ledger = createClaimsLedger({ rootDir, corpus });
  const jobs = createJobsIndex({ rootDir, ledger });
  const tools = createToolRegistry({ corpus, ledger, jobs });
  const resources = createResourceRegistry({ rootDir, corpus });

  return {
    rootDir,
    /** @param {any} request */
    async handle(request) {
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
        return jsonRpcError(request?.id ?? null, -32600, 'Invalid Request');
      }
      const isNotification = request.id === undefined || request.id === null;
      try {
        const modern = isModernRequest(request);
        let result;
        switch (request.method) {
          case 'initialize': {
            const requested = request.params?.protocolVersion;
            const protocolVersion = DOCS_MCP_SUPPORTED_PROTOCOLS.includes(requested) ? requested : LEGACY_PROTOCOL;
            result = {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false, subscribe: false },
              },
              serverInfo: SERVER_INFO,
              instructions: INSTRUCTIONS,
            };
            break;
          }
          case 'server/discover':
            result = {
              resultType: 'complete',
              supportedVersions: [DOCS_MCP_CURRENT_PROTOCOL],
              capabilities: {
                tools: { listChanged: false },
                resources: {},
              },
              _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
              ttlMs: 300_000,
              cacheScope: 'public',
            };
            break;
          case 'notifications/initialized':
          case 'notifications/cancelled':
            return null;
          case 'ping':
            result = {};
            break;
          case 'tools/list':
            result = modern
              ? { resultType: 'complete', tools: tools.list(), ttlMs: 60_000, cacheScope: 'public' }
              : { tools: tools.list() };
            break;
          case 'tools/call': {
            try {
              const output = await tools.call(request.params?.name, request.params?.arguments ?? {});
              result = toolResult(output, false, modern);
            } catch (error) {
              const normalized = normalizeError(error);
              result = toolResult({
                error: {
                  code: normalized.code,
                  message: normalized.message,
                  details: normalized.details ?? null,
                },
              }, true, modern);
            }
            break;
          }
          case 'resources/list':
            result = modern
              ? { resultType: 'complete', resources: resources.list(), ttlMs: 60_000, cacheScope: 'public' }
              : { resources: resources.list() };
            break;
          case 'resources/read': {
            const content = await resources.read(request.params?.uri);
            result = modern
              ? { resultType: 'complete', contents: [content], ttlMs: 60_000, cacheScope: 'public' }
              : { contents: [content] };
            break;
          }
          case 'resources/templates/list':
            result = modern
              ? { resultType: 'complete', resourceTemplates: [], ttlMs: 60_000, cacheScope: 'public' }
              : { resourceTemplates: [] };
            break;
          case 'prompts/list':
            // No prompts are declared in `capabilities`, but clients call this
            // unconditionally often enough that an empty list is friendlier than
            // "method not found".
            result = modern
              ? { resultType: 'complete', prompts: [], ttlMs: 60_000, cacheScope: 'public' }
              : { prompts: [] };
            break;
          default:
            return isNotification ? null : jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
        }
        return isNotification ? null : { jsonrpc: '2.0', id: request.id, result };
      } catch (error) {
        const normalized = normalizeError(error);
        return isNotification ? null : jsonRpcError(
          request.id,
          -32603,
          normalized.message,
          { code: normalized.code, details: normalized.details ?? null },
        );
      }
    },
  };
}

/** @param {any} request */
function isModernRequest(request) {
  const version = request.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
  return version === DOCS_MCP_CURRENT_PROTOCOL || request.method === 'server/discover';
}

/** @param {unknown} output @param {boolean} isError @param {boolean} modern */
function toolResult(output, isError, modern) {
  return {
    ...(modern ? { resultType: 'complete' } : {}),
    content: [{ type: 'text', text: JSON.stringify(output, null, 2) }],
    structuredContent: output,
    isError,
  };
}

/** @param {unknown} id @param {number} code @param {string} message @param {unknown} [data] */
function jsonRpcError(id, code, message, data) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}
