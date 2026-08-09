// @ts-check

/**
 * The document corpus: which files this server serves, and the linear scan that
 * searches them.
 *
 * There is no index and no dependency. At roughly a megabyte of Markdown a full
 * scan costs single-digit milliseconds, and an index would be a second copy of
 * the truth that can go stale — the failure mode this repository spends most of
 * its gates preventing.
 *
 * What is in the corpus:
 *   - every `*.md` at the repository root (README, AGENTS, PRODUCT, ARCHITECTURE,
 *     DECISIONS, ROADMAP, SECURITY, CONTRIBUTING, TASKS, CLAUDE);
 *   - every `*.md` under `docs/`, recursively.
 *
 * What is deliberately excluded, and why:
 *   - `docs/plans/` — ExecPlans describe work that is *intended*. An agent that
 *     retrieves a plan and reads it as a capability has been misled by us, not
 *     by itself. Plans are working documents; they are not the documentation set.
 *   - symbolic links — a link is a way out of the root, and nothing in this
 *     repository needs one.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { ValidationError } from '../../core/src/errors.js';
import { resolveWithinRoot, toPosixPath } from './paths.js';

/** Directories under the root that are never served, as repository-relative paths. */
export const EXCLUDED_DIRECTORIES = Object.freeze([
  'docs/plans',
]);

/** Directories walked for Markdown, in addition to the repository root itself. */
const WALKED_DIRECTORIES = Object.freeze(['docs']);

/** An excerpt is clipped here so one long line cannot dominate a result set. */
const EXCERPT_LIMIT = 220;

/** A query longer than this is not a query. */
export const MAX_QUERY_LENGTH = 200;

/** Terms beyond this are ignored; a caller pasting a paragraph gets the first few words. */
const MAX_TERMS = 8;

/** No single document may flood a result set. */
const MAX_HITS_PER_DOCUMENT = 3;

const ATX_HEADING = /^(#{1,6})\s+(.+?)\s*$/;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * @typedef {object} CorpusDocument
 * @property {string} path repository-relative path, POSIX separators
 * @property {string} uri the `docs://` URI this document answers to
 * @property {string} title the first H1, or the file name
 * @property {string} description the first prose line, clipped
 * @property {number} bytes
 * @property {string} text
 * @property {string[]} lines
 */

/**
 * Build the corpus. Files are read once, on first use, and cached for the life
 * of the process: this server is read-only and a stdio session is short.
 *
 * @param {{rootDir: string}} options
 */
export function createDocCorpus({ rootDir }) {
  /** @type {CorpusDocument[] | null} */
  let documents = null;
  /** @type {Map<string, CorpusDocument>} */
  const byUri = new Map();
  /** @type {Map<string, CorpusDocument>} */
  const byPath = new Map();

  function load() {
    if (documents) return documents;
    const loaded = discover(rootDir).map((repoRelativePath) => readDocument(rootDir, repoRelativePath));
    loaded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const document of loaded) {
      byUri.set(document.uri, document);
      byPath.set(document.path, document);
    }
    documents = Object.freeze(loaded);
    return documents;
  }

  return {
    rootDir,
    /** @returns {readonly CorpusDocument[]} */
    documents: () => load(),
    /** @param {string} uri */
    byUri: (uri) => {
      load();
      return byUri.get(uri) ?? null;
    },
    /** @param {string} path */
    byPath: (path) => {
      load();
      return byPath.get(toPosixPath(String(path))) ?? null;
    },
    /**
     * @param {string} query
     * @param {number} limit
     */
    search: (query, limit) => searchDocuments(load(), query, limit),
  };
}

/**
 * The document URI for a repository-relative path. Deliberately the same string
 * the claims ledger and the JTBD index use for evidence, so an agent holding
 * `docs/MODULE_FACTORY.md` can address the resource without a lookup table.
 *
 * @param {string} repoRelativePath
 */
export function documentUri(repoRelativePath) {
  return `docs://${toPosixPath(repoRelativePath)}`;
}

/**
 * Enumerate the corpus paths, sorted, without reading file contents.
 *
 * @param {string} rootDir
 * @returns {string[]} repository-relative POSIX paths
 */
export function discover(rootDir) {
  /** @type {string[]} */
  const found = [];
  for (const entry of safeReadDir(rootDir)) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (!entry.name.endsWith('.md')) continue;
    found.push(entry.name);
  }
  for (const directory of WALKED_DIRECTORIES) {
    walk(rootDir, directory, found);
  }
  return found.sort();
}

/**
 * @param {string} rootDir
 * @param {string} repoRelativeDir
 * @param {string[]} found
 */
function walk(rootDir, repoRelativeDir, found) {
  if (EXCLUDED_DIRECTORIES.includes(repoRelativeDir)) return;
  let absolute;
  try {
    absolute = resolveWithinRoot(rootDir, repoRelativeDir);
  } catch {
    return;
  }
  for (const entry of safeReadDir(absolute)) {
    if (entry.isSymbolicLink()) continue;
    const child = `${repoRelativeDir}/${entry.name}`;
    if (entry.isDirectory()) {
      walk(rootDir, child, found);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.md')) found.push(child);
  }
}

/** @param {string} absoluteDir */
function safeReadDir(absoluteDir) {
  try {
    return readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * @param {string} rootDir
 * @param {string} repoRelativePath
 * @returns {CorpusDocument}
 */
function readDocument(rootDir, repoRelativePath) {
  const absolute = resolveWithinRoot(rootDir, repoRelativePath);
  const text = readFileSync(absolute, 'utf8');
  const lines = text.split('\n');
  const path = toPosixPath(relative(rootDir, absolute));
  return Object.freeze({
    path,
    uri: documentUri(path),
    title: firstHeading(lines) ?? path,
    description: firstProseLine(lines),
    bytes: statSync(absolute).size,
    text,
    lines: Object.freeze(lines),
  });
}

/** @param {readonly string[]} lines */
function firstHeading(lines) {
  for (const line of lines) {
    const match = ATX_HEADING.exec(line);
    if (match) return sanitize(match[2]);
  }
  return null;
}

/** @param {readonly string[]} lines */
function firstProseLine(lines) {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || ATX_HEADING.test(trimmed)) continue;
    if (trimmed.startsWith('<!--') || trimmed.startsWith('```')) continue;
    return clip(sanitize(trimmed.replace(/^>\s*/, '')), 160);
  }
  return '';
}

/**
 * Words carrying no signal in a question about a CRM framework. Dropping them
 * matters more than it looks: "can the customer do this" scored a match against
 * every job in the index through "customer" and "the", which is how a search
 * tool ends up confidently answering a question nobody asked.
 */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'do', 'does', 'for', 'from',
  'has', 'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on', 'or',
  'our', 'that', 'the', 'their', 'this', 'to', 'we', 'what', 'when', 'which', 'will',
  'with', 'you', 'your',
]);

/**
 * Split a query into search terms. Punctuation that carries meaning in this
 * repository's vocabulary is kept: `JTBD-CO-01`, `docs/MCP.md` and `C-08` must
 * survive tokenisation intact.
 *
 * Stopwords are dropped — unless that would leave nothing, in which case the
 * caller genuinely did search for "the" and gets what they asked for.
 *
 * @param {string} query
 * @returns {string[]}
 */
export function tokenize(query) {
  /** @type {string[]} */
  const all = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9_./:-]+/)) {
    const term = raw.replace(/^[.:/-]+|[.:/-]+$/g, '');
    if (term === '' || all.includes(term)) continue;
    all.push(term);
    if (all.length === MAX_TERMS) break;
  }
  const meaningful = all.filter((term) => !STOPWORDS.has(term));
  return meaningful.length > 0 ? meaningful : all;
}

/**
 * Reject a query this server will not process. Hostile input is refused here
 * rather than defused later, so the refusal names the reason.
 *
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function normalizeQuery(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ValidationError(`${field} is required`, { field });
  }
  if (value.includes('\0')) {
    throw new ValidationError(`${field} may not contain a null byte`, { field });
  }
  if (value.length > MAX_QUERY_LENGTH) {
    throw new ValidationError(
      `${field} may be at most ${MAX_QUERY_LENGTH} characters`,
      { field, length: value.length, maxLength: MAX_QUERY_LENGTH },
    );
  }
  return value.trim();
}

/**
 * Linear scan. Deterministic: same corpus and same query produce byte-identical
 * output, because ties are broken by path and then by line number.
 *
 * @param {readonly CorpusDocument[]} documents
 * @param {string} query
 * @param {number} limit
 */
export function searchDocuments(documents, query, limit) {
  const terms = tokenize(query);
  const phrase = query.trim().toLowerCase();
  /** @type {{score: number, path: string, line: number, result: object}[]} */
  const hits = [];
  let totalMatches = 0;

  if (terms.length === 0) {
    return { terms, totalMatches: 0, truncated: false, results: [] };
  }

  for (const document of documents) {
    let heading = document.title;
    let hitsInDocument = 0;
    for (let index = 0; index < document.lines.length; index += 1) {
      const line = document.lines[index];
      const headingMatch = ATX_HEADING.exec(line);
      const isHeading = headingMatch !== null;
      if (isHeading) heading = sanitize(headingMatch[2]);

      const haystack = line.toLowerCase();
      if (!terms.every((term) => haystack.includes(term))) continue;

      totalMatches += 1;
      if (hitsInDocument >= MAX_HITS_PER_DOCUMENT) continue;
      hitsInDocument += 1;

      hits.push({
        score: (isHeading ? 2 : 0) + (haystack.includes(phrase) ? 1 : 0),
        path: document.path,
        line: index + 1,
        result: {
          uri: document.uri,
          path: document.path,
          title: document.title,
          heading,
          line: index + 1,
          excerpt: clip(sanitize(line.trim()), EXCERPT_LIMIT),
        },
      });
    }
  }

  hits.sort((a, b) => (
    b.score - a.score
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    || a.line - b.line
  ));

  return {
    terms,
    totalMatches,
    truncated: hits.length > limit,
    results: hits.slice(0, limit).map((hit) => hit.result),
  };
}

/**
 * Strip control characters and null bytes from anything that leaves this server.
 * The corpus is trusted, so this is belt and braces — but an excerpt is text a
 * model will read, and a document that ever gains a stray control byte should
 * not be able to smuggle it into a tool result.
 *
 * @param {string} value
 */
export function sanitize(value) {
  return value.replace(CONTROL_CHARACTERS, ' ');
}

/** @param {string} value @param {number} max */
function clip(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
