// @ts-check

/**
 * Same-fd no-follow nonblock open for deployment-storage documents and
 * identity-verifier modules. Path-based stat/read is the TOCTOU the tests
 * exist to forbid, so every descriptor operation goes through this namespace.
 */

import fs from 'node:fs';
import { AppError } from './errors.js';

/**
 * @param {{ expectedUid?: unknown }} [options]
 * @returns {number | null}
 */
export function resolveExpectedUid(options = {}) {
  if (options && typeof options === 'object' && !Array.isArray(options)
    && Object.getPrototypeOf(options) === Object.prototype
    && Object.hasOwn(options, 'expectedUid')) {
    return Number.isInteger(options.expectedUid) ? /** @type {number} */ (options.expectedUid) : null;
  }
  if (typeof process.getuid !== 'function') return null;
  return process.getuid();
}

/**
 * @param {fs.Stats} first
 * @param {fs.Stats} second
 */
export function sameTrustedIdentity(first, second) {
  return second.ino === first.ino
    && second.dev === first.dev
    && second.uid === first.uid
    && second.mode === first.mode
    && second.size === first.size
    && second.isFile() === true;
}

/**
 * Open a path with O_RDONLY|O_NOFOLLOW|O_NONBLOCK, fstat THAT fd, and require
 * a regular owner-only file within maxBytes.
 *
 * @param {string} filePath
 * @param {{
 *   expectedUid?: unknown,
 *   maxBytes: number,
 *   untrusted: () => never,
 * }} options
 * @returns {{ fd: number, stat: fs.Stats }}
 */
export function openTrustedRegularFile(filePath, options) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  if (typeof O_NOFOLLOW !== 'number' || typeof O_NONBLOCK !== 'number') options.untrusted();
  const expectedUid = resolveExpectedUid(options);
  if (!Number.isInteger(expectedUid)) options.untrusted();

  let fd;
  try {
    fd = fs.openSync(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch {
    options.untrusted();
  }

  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > options.maxBytes || stat.size < 0) options.untrusted();
    if (stat.uid !== expectedUid) options.untrusted();
    if ((stat.mode & 0o077) !== 0) options.untrusted();
    return { fd, stat };
  } catch (error) {
    try { fs.closeSync(fd); } catch { /* the refusal already owns the outcome */ }
    if (error instanceof AppError) throw error;
    options.untrusted();
  }
}

/**
 * Read bounded bytes from the same descriptor that was opened and fstat'd.
 *
 * @param {string} filePath
 * @param {{
 *   expectedUid?: unknown,
 *   maxBytes: number,
 *   untrusted: () => never,
 * }} options
 * @returns {string}
 */
export function readTrustedRegularFile(filePath, options) {
  const opened = openTrustedRegularFile(filePath, options);
  try {
    const buffer = Buffer.alloc(opened.stat.size);
    const bytesRead = opened.stat.size === 0 ? 0 : fs.readSync(opened.fd, buffer, 0, opened.stat.size, 0);
    if (bytesRead !== opened.stat.size) options.untrusted();
    const second = fs.fstatSync(opened.fd);
    if (!sameTrustedIdentity(opened.stat, second)) options.untrusted();
    return buffer.toString('utf8');
  } finally {
    try { fs.closeSync(opened.fd); } catch { /* the refusal already owns the outcome */ }
  }
}

/**
 * Close a descriptor opened by {@link openTrustedRegularFile}.
 *
 * @param {number} fd
 */
export function closeTrustedFile(fd) {
  try { fs.closeSync(fd); } catch { /* the refusal already owns the outcome */ }
}

/**
 * Re-fstat the still-open fd. Used after a later operation (dynamic import)
 * to refuse a swapped inode.
 *
 * @param {number} fd
 * @param {fs.Stats} first
 * @param {() => never} untrusted
 */
export function assertTrustedFdUnchanged(fd, first, untrusted) {
  let second;
  try {
    second = fs.fstatSync(fd);
  } catch {
    untrusted();
  }
  if (!sameTrustedIdentity(first, second)) untrusted();
}
