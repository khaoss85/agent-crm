// @ts-check

/**
 * The resource registry: every document this server will ever hand over, listed
 * by URI ahead of time.
 *
 * A resource is addressed through a `Map` built from the enumerated corpus, so
 * a URI that was not enumerated has nothing to resolve to. `docs://../../etc/passwd`
 * is not a path that gets sanitised — it is a key that is not in the map. That is
 * the difference between defending against traversal and not having the shape of
 * bug traversal exploits.
 *
 * URIs mirror repository-relative paths exactly (`docs://docs/MCP.md`,
 * `docs://ARCHITECTURE.md`), because the claims ledger and the JTBD index cite
 * evidence by repository-relative path. An agent holding `docs/MODULE_FACTORY.md`
 * can address the resource without a lookup table.
 */

import { existsSync, readFileSync } from 'node:fs';
import { NotFoundError } from '../../core/src/errors.js';
import { EXCLUDED_DIRECTORIES } from './corpus.js';
import { CLAIMS_PATH } from './ledger.js';
import { JOBS_GENERATOR, JOBS_PATH, JOBS_SOURCE_PATH } from './jobs.js';
import { resolveWithinRoot } from './paths.js';

/** The index resource: what is served, and what is not. */
export const INDEX_URI = 'docs://index';
export const CLAIMS_URI = 'docs://claims';
export const JOBS_URI = 'docs://jobs';

/**
 * @param {{rootDir: string, corpus: any}} dependencies
 */
export function createResourceRegistry({ rootDir, corpus }) {
  /** @type {Map<string, any> | null} */
  let byUri = null;

  function build() {
    if (byUri) return byUri;
    const map = new Map();

    map.set(INDEX_URI, {
      uri: INDEX_URI,
      name: 'documentation-index',
      title: 'Documentation Index',
      description: 'Every document this server serves, what it is, and what is deliberately excluded.',
      mimeType: 'application/json',
      read: () => JSON.stringify(buildIndex(corpus), null, 2),
    });

    map.set(CLAIMS_URI, {
      uri: CLAIMS_URI,
      name: 'claims-ledger',
      title: 'Claims Ledger',
      description:
        'Every public capability claim bound to the tests that prove it, each paired with the limitation '
        + 'that bounds it, plus the standing limitations of the framework.',
      mimeType: 'application/json',
      read: () => readRepositoryFile(rootDir, CLAIMS_PATH),
    });

    map.set(JOBS_URI, {
      uri: JOBS_URI,
      name: 'jobs-index',
      title: 'CRM Jobs-To-Be-Done Index',
      description:
        `The CRM jobs index generated from ${JOBS_SOURCE_PATH}, each job carrying one of four statuses. `
        + `Absent from a checkout until \`${JOBS_GENERATOR}\` has been run.`,
      mimeType: 'application/json',
      read: () => {
        const absolute = resolveWithinRoot(rootDir, JOBS_PATH);
        if (!existsSync(absolute)) {
          return JSON.stringify({
            available: false,
            source: JOBS_PATH,
            generatedFrom: JOBS_SOURCE_PATH,
            remediation: JOBS_GENERATOR,
            note: 'The index is generated and is not present in this checkout. No job status can be served.',
          }, null, 2);
        }
        return readFileSync(absolute, 'utf8');
      },
    });

    for (const document of corpus.documents()) {
      map.set(document.uri, {
        uri: document.uri,
        name: document.path,
        title: document.title,
        description: document.description,
        mimeType: 'text/markdown',
        read: () => document.text,
      });
    }

    byUri = map;
    return byUri;
  }

  return {
    list: () => [...build().values()].map(({ read: _read, ...resource }) => resource),
    /** @param {unknown} uri */
    async read(uri) {
      const resource = typeof uri === 'string' ? build().get(uri) : undefined;
      if (!resource) throw new NotFoundError('MCP resource', String(uri));
      return {
        uri: resource.uri,
        mimeType: resource.mimeType,
        text: resource.read(),
      };
    },
  };
}

/** @param {any} corpus */
function buildIndex(corpus) {
  const documents = corpus.documents();
  return {
    documentationIndexContract: 1,
    served: 'Markdown documentation and two machine-readable ledgers. This server opens no database and holds no customer record.',
    documentCount: documents.length,
    excluded: EXCLUDED_DIRECTORIES.map((path) => ({
      path,
      reason:
        'ExecPlans describe work that is intended. Serving them would let an agent read a plan as a capability.',
    })),
    ledgers: [
      { uri: CLAIMS_URI, path: CLAIMS_PATH },
      { uri: JOBS_URI, path: JOBS_PATH, generatedFrom: JOBS_SOURCE_PATH },
    ],
    documents: documents.map((/** @type {any} */ document) => ({
      uri: document.uri,
      path: document.path,
      title: document.title,
      description: document.description,
      bytes: document.bytes,
    })),
  };
}

/** @param {string} rootDir @param {string} repoRelativePath */
function readRepositoryFile(rootDir, repoRelativePath) {
  const absolute = resolveWithinRoot(rootDir, repoRelativePath);
  if (!existsSync(absolute)) throw new NotFoundError('repository file', repoRelativePath);
  return readFileSync(absolute, 'utf8');
}
