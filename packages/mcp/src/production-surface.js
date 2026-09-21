// @ts-check

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AppError } from '../../core/src/errors.js';

export const MCP_PRODUCTION_SURFACE_UNAVAILABLE = 'MCP_PRODUCTION_SURFACE_UNAVAILABLE';

function refuseProductionSurface() {
  throw new AppError(
    'production MCP stdio is static source context only until authenticated per-request identity exists',
    { code: MCP_PRODUCTION_SURFACE_UNAVAILABLE, status: 403 },
  );
}

/** Allowlisted checked source; no tenant data, traces, schema or scaffolding. */
function staticResources(rootDir) {
  return [
    {
      uri: 'crm://project/architecture',
      name: 'architecture',
      title: 'Accordo Architecture',
      description: 'The repository architecture and extension rules.',
      mimeType: 'text/markdown',
      read: async () => readFile(join(rootDir, 'ARCHITECTURE.md'), 'utf8'),
    },
    {
      uri: 'crm://project/jtbd',
      name: 'jobs-to-be-done',
      title: 'Accordo Jobs To Be Done',
      description: 'Medusa-style use cases translated to CRM.',
      mimeType: 'text/markdown',
      read: async () => readFile(join(rootDir, 'docs', 'JTBD.md'), 'utf8'),
    },
  ];
}

export function createProductionToolRegistry() {
  return {
    list: () => [],
    async call() {
      refuseProductionSurface();
    },
  };
}

export function createProductionPromptRegistry() {
  return {
    list: () => [],
    get() {
      refuseProductionSurface();
    },
  };
}

/** @param {{ rootDir: string }} dependencies */
export function createProductionResourceRegistry({ rootDir }) {
  const resources = staticResources(rootDir);
  const byUri = new Map(resources.map((resource) => [resource.uri, resource]));
  return {
    list: () => resources.map(({ read: _read, ...resource }) => resource),
    async read(uri) {
      const resource = byUri.get(uri);
      if (!resource) refuseProductionSurface();
      return {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: await resource.read(),
      };
    },
  };
}
