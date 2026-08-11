// @ts-check

/**
 * Assemble the exact read-only corpus a hosted Docs MCP needs at runtime.
 *
 * Vercel traces JavaScript imports but the Docs MCP discovers Markdown through
 * the filesystem. One deterministic directory gives the Function a single
 * includeFiles glob and, importantly, reuses createDocCorpus's exclusions
 * instead of inventing another list of documents at the deployment layer.
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDocCorpus } from '../packages/docs-mcp/src/corpus.js';
import { CLAIMS_PATH } from '../packages/docs-mcp/src/ledger.js';
import { JOBS_PATH } from '../packages/docs-mcp/src/jobs.js';

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const DOCS_MCP_RUNTIME_DIR = join(repositoryRoot, 'packages', 'docs-mcp', 'runtime-corpus');

/**
 * @param {{sourceRoot?: string, outputDir?: string}} [options]
 */
export function assembleDocsMcpRuntime(options = {}) {
  const sourceRoot = resolve(options.sourceRoot ?? repositoryRoot);
  const outputDir = resolve(options.outputDir ?? DOCS_MCP_RUNTIME_DIR);
  const callerSelectedOutput = options.outputDir !== undefined;
  const relativeOutput = relative(sourceRoot, outputDir);
  const outputIsOutsideSource = relativeOutput === '..' || relativeOutput.startsWith(`..${sep}`);
  if (callerSelectedOutput && !outputIsOutsideSource) {
    // The canonical generated directory is intentionally inside the source
    // checkout. Any caller-selected output must be outside so tests and other
    // tooling cannot overwrite arbitrary repository paths.
    throw new Error('A caller-selected Docs MCP runtime directory must be outside the source root');
  }

  const corpus = createDocCorpus({ rootDir: sourceRoot });
  const files = corpus.documents().map((document) => ({ path: document.path, bytes: document.text }));
  for (const path of [CLAIMS_PATH, JOBS_PATH]) {
    files.push({ path, bytes: readFileSync(join(sourceRoot, path), 'utf8') });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));

  const fingerprint = createHash('sha256');
  for (const file of files) {
    fingerprint.update(file.path);
    fingerprint.update('\0');
    fingerprint.update(createHash('sha256').update(file.bytes).digest('hex'));
    fingerprint.update('\n');
  }

  const parent = dirname(outputDir);
  const staging = `${outputDir}.assembling`;
  if (callerSelectedOutput && (existsSync(outputDir) || existsSync(staging))) {
    throw new Error('A caller-selected Docs MCP runtime directory and its staging path must not exist');
  }
  mkdirSync(parent, { recursive: true });
  if (!callerSelectedOutput) rmSync(staging, { recursive: true, force: true });
  for (const file of files) {
    const target = join(staging, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.bytes);
  }
  const manifest = {
    docsMcpRuntimeCorpusContract: 1,
    fileCount: files.length,
    bytes: files.reduce((total, file) => total + Buffer.byteLength(file.bytes), 0),
    fingerprint: fingerprint.digest('hex'),
    files: files.map((file) => file.path),
    exclusions: ['docs/plans/**'],
  };
  writeFileSync(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  if (!callerSelectedOutput) rmSync(outputDir, { recursive: true, force: true });
  renameSync(staging, outputDir);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = assembleDocsMcpRuntime();
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
}
