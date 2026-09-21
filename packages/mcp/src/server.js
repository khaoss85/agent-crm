// @ts-check

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { normalizeError } from '../../core/src/errors.js';
import { createToolRegistry } from './tools.js';
import { createResourceRegistry } from './resources.js';
import { createPromptRegistry } from './prompts.js';
import {
  createProductionPromptRegistry,
  createProductionResourceRegistry,
  createProductionToolRegistry,
} from './production-surface.js';

const SERVER_INFO = Object.freeze({ name: 'accordo', version: '0.1.0' });
const CURRENT_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2025-11-25';
const SUPPORTED_PROTOCOLS = [CURRENT_PROTOCOL, LEGACY_PROTOCOL, '2025-06-18', '2024-11-05'];
const DEFAULT_ROOT = resolve(fileURLToPath(new URL('../../../', import.meta.url)));

/** @param {{app?: any, rootDir?: string, productionStatic?: boolean, publicStorage?: { adapter: string, available: boolean } | null}} dependencies */
export function createMcpServer({ app, rootDir = DEFAULT_ROOT, productionStatic = false, publicStorage = null } = {}) {
  const tools = productionStatic
    ? createProductionToolRegistry()
    : createToolRegistry({ app, rootDir, publicStorage });
  const resources = productionStatic
    ? createProductionResourceRegistry({ rootDir })
    : createResourceRegistry({ app, rootDir });
  const prompts = productionStatic
    ? createProductionPromptRegistry()
    : createPromptRegistry({ app });

  return {
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
            const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : LEGACY_PROTOCOL;
            result = {
              protocolVersion,
              capabilities: {
                tools: { listChanged: false },
                resources: { listChanged: false, subscribe: false },
                prompts: { listChanged: false },
              },
              serverInfo: SERVER_INFO,
              instructions: 'Use resources for project context and tools for controlled CRM operations. Code scaffolding is dry-run unless apply is explicitly true.',
            };
            break;
          }
          case 'server/discover':
            result = {
              resultType: 'complete',
              supportedVersions: [CURRENT_PROTOCOL],
              capabilities: {
                tools: { listChanged: false },
                resources: {},
                prompts: {},
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
              ? { resultType: 'complete', contents: [content], ttlMs: 60_000, cacheScope: 'private' }
              : { contents: [content] };
            break;
          }
          case 'resources/templates/list':
            result = modern
              ? { resultType: 'complete', resourceTemplates: [], ttlMs: 60_000, cacheScope: 'public' }
              : { resourceTemplates: [] };
            break;
          case 'prompts/list':
            result = modern
              ? { resultType: 'complete', prompts: prompts.list(), ttlMs: 60_000, cacheScope: 'public' }
              : { prompts: prompts.list() };
            break;
          case 'prompts/get':
            result = prompts.get(request.params?.name, request.params?.arguments ?? {});
            if (modern) result = { resultType: 'complete', ...result };
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
  return version === CURRENT_PROTOCOL || request.method === 'server/discover';
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
