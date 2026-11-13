// @ts-check

// Screen switching on the shared mount (#view-module).
//
// Every backoffice view paints straight into the one shared mount, and most
// of them read the network before their first paint. Two things follow,
// both seen in production on a slow or sleeping web service:
//
// - the breadcrumb moved at once, while the old screen stayed under it for
//   the whole read (5–25 s). `paintScreenLoading` clears the mount
//   synchronously on every navigation and shows a neutral loading line for
//   the new screen; the view's own paint replaces it.
// - a slow view resolving after the operator moved on painted over the
//   screen just opened. A few views guard themselves (invalidate(), render
//   tokens), most do not. `createMountGate` gives every view its own handle
//   on the mount: while the view is not the routed one, the handle is inert
//   (it sees an empty mount and every write is dropped), so a late paint
//   lands nowhere. The routed view's handle passes straight through.

import { uiButton, uiEmpty, uiLoading } from './admin-ui.js';

/**
 * backlog:94eabbd4762f — what the shell reads for itself (the sidebar
 * badges) waits for the screen the person opened: on a cold deep link the
 * badge reads used to leave with the screen's first answer and queue in
 * front of its reads on a host that serves one or two at a time (pilota
 * 13/11: the offer page 4,6-5,9 s from a direct link). Resolves when
 * `screen` settles, either way, or after `capMs` — a screen that never
 * finishes never keeps the badges away for good. Never rejects.
 *
 * @param {Promise<unknown> | null | undefined} screen the routed screen's render
 * @param {{ capMs?: number, wait?: (ms: number) => Promise<unknown> }} [options]
 * @returns {Promise<void>}
 */
export function afterScreen(screen, { capMs = 5000, wait = (ms) => new Promise((done) => setTimeout(done, ms)) } = {}) {
  const settled = Promise.resolve(screen).then(() => {}, () => {});
  return Promise.race([settled, Promise.resolve(wait(capMs)).then(() => {}, () => {})]);
}

/**
 * Clear the mount and show the loading state for `label` (the screen name
 * the breadcrumb already shows).
 *
 * @param {{ doc: any, mount: any, label?: unknown }} options
 */
export function paintScreenLoading({ doc, mount, label }) {
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const node = uiLoading(doc, { label });
  mount.appendChild(node);
  return node;
}

/**
 * The routed screen failed before painting: while the mount still holds
 * the loading line painted for it, that line gives way to an honest note
 * with a retry, so «Carico…» never hangs over data that will not come.
 * A screen that already painted (or a newer navigation) is left alone.
 * Returns true when the note was painted.
 *
 * @param {{ doc: any, mount: any, loading: any, label?: unknown, onRetry?: () => void }} options
 */
export function paintScreenFailure({ doc, mount, loading, label, onRetry }) {
  if (!loading || !Array.from(mount.childNodes ?? []).includes(loading)) return false;
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const name = typeof label === 'string' && label.trim() !== '' ? label.trim() : 'questa schermata';
  const note = uiEmpty(doc, { title: `Non riesco ad aprire ${name}.`, text: 'Controlla la connessione e riprova.' });
  note.setAttribute('role', 'alert');
  if (typeof onRetry === 'function') {
    const retry = uiButton(doc, { label: 'Riprova', attrs: { type: 'button' } });
    retry.addEventListener('click', () => onRetry());
    note.appendChild(retry);
  }
  mount.appendChild(note);
  return true;
}

/**
 * What an inert handle answers: an empty mount that accepts nothing — no
 * child, no text, no listener. Any other property reads the real node.
 */
const INERT = Object.freeze({
  firstChild: null,
  lastChild: null,
  firstElementChild: null,
  lastElementChild: null,
  textContent: '',
  innerHTML: '',
  innerText: '',
  childElementCount: 0,
});
const INERT_METHODS = Object.freeze({
  appendChild: (child) => child,
  insertBefore: (child) => child,
  removeChild: (child) => child,
  replaceChild: (_next, old) => old,
  append: () => {},
  prepend: () => {},
  replaceChildren: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  contains: () => false,
  hasChildNodes: () => false,
  getElementsByTagName: () => [],
  getElementsByClassName: () => [],
  addEventListener: () => {},
  removeEventListener: () => {},
  insertAdjacentElement: () => null,
  insertAdjacentHTML: () => {},
  insertAdjacentText: () => {},
});
const INERT_LISTS = new Set(['childNodes', 'children']);

/**
 * One gate over the shared mount. `owned(views)` returns the handle a view
 * is created with; `activate(view)` names the routed view (null for screens
 * the router paints itself). A handle passes through while the routed view
 * is one of its `views`, and is inert otherwise.
 *
 * @param {any} mount
 */
export function createMountGate(mount) {
  /** @type {string | null} */
  let active = null;
  return {
    /** @param {string | null} view */
    activate(view) {
      active = typeof view === 'string' ? view : null;
    },
    /** @param {string} view */
    isActive(view) {
      return active === view;
    },
    /**
     * @param {string | string[]} views the router views this handle paints
     */
    owned(views) {
      const own = new Set(Array.isArray(views) ? views : [views]);
      const live = () => active !== null && own.has(active);
      return new Proxy(mount, {
        get(target, prop) {
          if (!live() && typeof prop === 'string') {
            if (Object.prototype.hasOwnProperty.call(INERT, prop)) return INERT[prop];
            if (Object.prototype.hasOwnProperty.call(INERT_METHODS, prop)) return INERT_METHODS[prop];
            if (INERT_LISTS.has(prop)) return [];
          }
          const value = Reflect.get(target, prop, target);
          // DOM methods need the real node as `this`, never the proxy.
          return typeof value === 'function' ? value.bind(target) : value;
        },
        set(target, prop, value) {
          if (live()) Reflect.set(target, prop, value, target);
          return true;
        },
      });
    },
  };
}
