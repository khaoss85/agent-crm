// @ts-check

/**
 * Path confinement for the documentation server.
 *
 * This server reads files and nothing else, which makes the only interesting
 * attack the oldest one: a caller who supplies `../../etc/passwd` and gets it
 * back. Two independent defences sit between a caller and the filesystem:
 *
 *   1. every readable thing is enumerated ahead of time and addressed by URI
 *      through a `Map`, so an unlisted path has no name to be asked for;
 *   2. every path that is ever joined to the root goes through
 *      `resolveWithinRoot`, which rejects absolute paths, null bytes and any
 *      path whose resolved form lands outside the root.
 *
 * The second exists because the first is a property of today's code and the
 * second is a property of the function. A future tool that takes a path is
 * still confined.
 */

import { isAbsolute, relative, resolve } from 'node:path';
import { ValidationError } from '../../core/src/errors.js';

/** Windows drive-letter prefixes are absolute even where `isAbsolute` is POSIX. */
const DRIVE_LETTER = /^[A-Za-z]:/;

/**
 * Resolve a repository-relative path against a root, refusing anything that
 * escapes it.
 *
 * @param {string} rootDir absolute path of the documentation root
 * @param {unknown} candidate a repository-relative path supplied by a caller
 * @returns {string} the absolute path, guaranteed to be strictly inside rootDir
 */
export function resolveWithinRoot(rootDir, candidate) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ValidationError('a document path is required', { field: 'path' });
  }
  if (candidate.includes('\0')) {
    throw new ValidationError('a document path may not contain a null byte', { field: 'path' });
  }
  if (isAbsolute(candidate) || DRIVE_LETTER.test(candidate) || candidate.startsWith('\\')) {
    throw new ValidationError(
      'a document path must be relative to the documentation root',
      { field: 'path', path: candidate },
    );
  }
  const root = resolve(rootDir);
  const target = resolve(root, candidate);
  const inside = relative(root, target);
  if (inside === '' || inside === '..' || inside.startsWith(`..${'/'}`) || inside.startsWith('..\\') || isAbsolute(inside)) {
    throw new ValidationError(
      'a document path may not escape the documentation root',
      { field: 'path', path: candidate },
    );
  }
  return target;
}

/**
 * True when a path is inside the root. The predicate form, for callers that
 * filter rather than throw.
 *
 * @param {string} rootDir
 * @param {unknown} candidate
 */
export function isWithinRoot(rootDir, candidate) {
  try {
    resolveWithinRoot(rootDir, candidate);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalise a path for use in a URI: repository-relative, POSIX separators.
 *
 * @param {string} repoRelativePath
 */
export function toPosixPath(repoRelativePath) {
  return repoRelativePath.split('\\').join('/');
}
