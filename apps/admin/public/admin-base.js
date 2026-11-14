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

/**
 * Every /bo in-page link (pilota 12/11: opening a quote went to /bo/#/ and
 * reloaded the app). The mount serves the shell at `/w/<space>/bo` while its
 * `<base href>` names `/w/<space>/bo/`: every in-page link («#/quotes/…»)
 * resolves against the base, lands on another path and reloads the whole
 * shell. When the page path is exactly the base without its trailing slash,
 * the address to settle on is the base itself, with the same query and
 * hash — set once at boot with history.replaceState, so links stay in the
 * page. Null when nothing needs to change.
 * @param {{ pathname?: unknown, search?: unknown, hash?: unknown }} location
 * @param {unknown} baseHref the `<base href>` attribute, as written
 * @returns {string | null}
 */
export function canonicalShellPath(location, baseHref) {
  const path = typeof location?.pathname === 'string' ? location.pathname : '';
  const base = typeof baseHref === 'string' ? baseHref.trim() : '';
  if (path === '' || !base.startsWith('/') || !base.endsWith('/') || base === '/') return null;
  if (path.endsWith('/') || `${path}/` !== base) return null;
  const search = typeof location?.search === 'string' ? location.search : '';
  const hash = typeof location?.hash === 'string' ? location.hash : '';
  return `${base}${search}${hash}`;
}
