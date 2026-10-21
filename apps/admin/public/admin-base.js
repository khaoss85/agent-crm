// @ts-check

/**
 * The path prefix the Admin shell is served under (backlog:ecdf7dc4).
 *
 * The standalone server owns the domain root, so the prefix is empty there.
 * An embedding host mounts the same shell under its own subtree (the shared
 * pilot web serves it per space, e.g. `/bo`), and the mount injects
 * `<meta name="admin-base" content="/bo">` into the HTML it serves. The two
 * fetch choke points of the shell (`api` and `moduleClient.request` in
 * `app.js`) read that meta once and prefix every absolute `/api/*` path, so
 * the shell keeps working without per-call edits.
 *
 * Relative imports between shell modules (`./admin-*.js`) are untouched: the
 * mount's `<base href>` keeps those under the mount, while this meta keeps
 * the absolute API paths under it too.
 */

/**
 * @param {{ querySelector?: Function } | undefined} [doc]
 */
export function resolveAdminBase(doc) {
  const source = doc
    ?? (typeof globalThis.document === 'undefined' ? undefined : globalThis.document);
  const meta = source?.querySelector?.('meta[name="admin-base"]');
  const content = typeof meta?.getAttribute === 'function'
    ? meta.getAttribute('content')
    : meta?.content;
  if (typeof content !== 'string' || content === '') return '';
  return content;
}
