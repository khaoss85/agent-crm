// @ts-check

/**
 * Shared stub composition for the concurrent share-link mint proof
 * (backlog:a3b394dd, P1 giro 6). The parent test and each mint worker process
 * boot from here so both sides run the identical graph: only the
 * `quote` stub and the real `quote-share` manifest, with the production
 * share-link action.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShareLinkAction } from '../../packages/commercial/src/quote-share.js';
import { createAccordoAppAsync } from '../../packages/app/src/index.js';
import { GADGET_MIGRATION } from './postgresql-application.js';
import { createTestVerifier } from './identity-verifier-fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_DIR = join(here, '..', '..', 'packages', 'commercial', 'modules');

function readManifest(name) {
  return JSON.parse(readFileSync(join(MANIFEST_DIR, name), 'utf8'));
}

/** Minimal quote shape: only what share-link reads (status gate + version pointer). */
export function quoteStubManifest() {
  return {
    manifestVersion: 1,
    name: 'quote',
    description: 'Test stub: the approved-version pointer share-link mints for.',
    fields: [
      { name: 'status', type: 'string' },
      { name: 'currentVersionId', type: 'string' },
      { name: 'currentVersionNumber', type: 'integer' },
      { name: 'draftRevision', type: 'integer' },
    ],
  };
}

export function stubShareSelected() {
  // The portable PostgreSQL path requires a contract-2 graph; share-link
  // ships contract 1 on the sync path. The mint logic under test is
  // identical — only the envelope version differs.
  return {
    packageContract: 2,
    packages: [],
    actions: [{ ...buildShareLinkAction(), actionContract: 2 }],
    modules: [
      { name: 'quote', manifest: quoteStubManifest() },
      { name: 'quote-share', manifest: readManifest('quote-share.module.json') },
    ],
  };
}

/**
 * Boot the stub composition on already-open planes (no test context: the
 * caller owns teardown). Mirrors `bootPostgresqlApp` minus its `t` hooks.
 */
export async function bootStubShareApp({ control, data, tenantId = 'acme' }) {
  const identityVerifier = createTestVerifier({ tenantId });
  return createAccordoAppAsync({
    adapter: 'postgresql',
    testHarness: {
      loopback: true,
      control,
      data,
    },
    spine: { mode: 'local-development', tenant: { id: tenantId } },
    identityVerifier,
    selected: stubShareSelected(),
    moduleMigrations: [GADGET_MIGRATION],
  });
}
