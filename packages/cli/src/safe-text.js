// @ts-check

import { relative, sep } from 'node:path';

/**
 * The two rules every read-only CLI report in this repository follows about
 * text it publishes: never an absolute path, never a stack.
 *
 * They were written for AX1 and were module-private there. `crm package test`
 * needs exactly the same guarantee, and a second copy of a scrubber is a second
 * place for a leak to be fixed only once.
 */

/**
 * A repository-relative POSIX path. Never an absolute one: this JSON is written
 * for agents and pasted into issues, and an absolute path carries the
 * operator's home directory and machine layout with it for no diagnostic gain.
 *
 * @param {string} rootDir @param {string} path
 */
export function repoRelative(rootDir, path) {
  return relative(rootDir, path).split(sep).join('/');
}

/**
 * A message safe to publish: bounded, single-line, and free of the absolute
 * paths a stack trace is made of.
 *
 * `roots` are scrubbed to `<project>` before the generic path rule runs, so a
 * caller with more than one interesting root — a real project and a throwaway
 * scratch copy of it — can hide both.
 *
 * @param {unknown} error @param {string|string[]} roots
 */
export function safeMessage(error, roots) {
  const raw = error instanceof Error ? error.message : String(error);
  // Longest first: a scratch root nested inside a project root must be replaced
  // before its parent, or the parent match leaves the tail behind.
  const list = (Array.isArray(roots) ? roots : [roots])
    .filter((value) => typeof value === 'string' && value !== '')
    .sort((a, b) => b.length - a.length);
  let text = raw.split('\n')[0];
  for (const root of list) text = text.replaceAll(root, '<project>');
  return text
    .replace(/(file:\/\/)?\/[^\s'"]+/g, (match) => (match.includes('/') ? '<path>' : match))
    .slice(0, 400);
}
