// @ts-check

/** @typedef {{method: string, pattern: RegExp, keys: string[], handler: Function}} Route */

export class Router {
  constructor() {
    /** @type {Route[]} */
    this.routes = [];
  }

  /** @param {string} method @param {string} path @param {Function} handler */
  add(method, path, handler) {
    const keys = [];
    const escaped = path
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          keys.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method: method.toUpperCase(),
      pattern: new RegExp(`^${escaped}/?$`),
      keys,
      handler,
    });
    return this;
  }

  /** @param {string} method @param {string} pathname */
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;
      const params = Object.fromEntries(
        route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
      );
      return { handler: route.handler, params };
    }
    return null;
  }
}
