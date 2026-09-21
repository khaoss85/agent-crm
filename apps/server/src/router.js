// @ts-check

/** @typedef {{method: string, pattern: RegExp, keys: string[], handler: Function, options: {rawBody?: boolean, maxBodyBytes?: number, skipIdentity?: boolean}}} Route */

export class Router {
  constructor() {
    /** @type {Route[]} */
    this.routes = [];
  }

  /**
   * @param {string} method @param {string} path @param {Function} handler
   * @param {{rawBody?: boolean, maxBodyBytes?: number, skipIdentity?: boolean}} [options] Per-route
   *   body policy. `rawBody` hands the handler the exact bytes instead of
   *   parsed JSON — required wherever a payload must be signature-verified
   *   before it is trusted (ADR-017), because re-serializing JSON would not
   *   reproduce what the provider signed. `skipIdentity` is for process
   *   liveness: the matcher already accepted the request, so identity must
   *   follow that match rather than a second pathname string compare.
   */
  add(method, path, handler, options = {}) {
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
      options,
    });
    return this;
  }

  /** @param {string} method @param {string} pathname */
  match(method, pathname) {
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      const match = pathname.match(route.pattern);
      if (!match) continue;
      // Malformed percent-encoding must never crash the request: a segment
      // that cannot be decoded simply does not match any route (safe 404).
      try {
        const params = Object.fromEntries(
          route.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]),
        );
        return { handler: route.handler, params, options: route.options ?? {} };
      } catch {
        return null;
      }
    }
    return null;
  }
}
