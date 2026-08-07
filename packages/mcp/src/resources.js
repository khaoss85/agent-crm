// @ts-check

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @param {{app: any, rootDir: string}} dependencies */
export function createResourceRegistry({ app, rootDir }) {
  const resources = [
    {
      uri: 'crm://schema',
      name: 'crm-schema',
      title: 'CRM Domain Schema',
      description: 'Current CRM entities, fields, money and state conventions.',
      mimeType: 'application/json',
      read: async () => JSON.stringify(app.schema, null, 2),
    },
    {
      uri: 'crm://modules',
      name: 'crm-modules',
      title: 'Registered CRM Modules',
      description: 'Module metadata available in the running application.',
      mimeType: 'application/json',
      read: async () => JSON.stringify(app.modules.list(), null, 2),
    },
    {
      uri: 'crm://workflows',
      name: 'crm-workflows',
      title: 'Registered CRM Workflows',
      description: 'Deterministic processes and their named steps.',
      mimeType: 'application/json',
      read: async () => JSON.stringify(app.workflows.list(), null, 2),
    },
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
  const byUri = new Map(resources.map((resource) => [resource.uri, resource]));
  return {
    list: () => resources.map(({ read: _read, ...resource }) => resource),
    async read(uri) {
      const resource = byUri.get(uri);
      if (!resource) throw new Error(`Unknown MCP resource: ${uri}`);
      return {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: await resource.read(),
      };
    },
  };
}
