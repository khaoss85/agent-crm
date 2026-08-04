// @ts-check

import { ConflictError, NotFoundError } from '../../core/src/errors.js';

export class ProviderRegistry {
  constructor() {
    /** @type {Map<string, {name: string, kind: string, provider: any}>} */
    this.providers = new Map();
  }

  /** @param {{name: string, kind: string, provider: any}} entry */
  register(entry) {
    if (this.providers.has(entry.name)) {
      throw new ConflictError(`Provider already registered: ${entry.name}`);
    }
    this.providers.set(entry.name, entry);
    return entry.provider;
  }

  /** @param {string} name */
  get(name) {
    const entry = this.providers.get(name);
    if (!entry) throw new NotFoundError('Provider', name);
    return entry.provider;
  }

  list() {
    return [...this.providers.values()].map(({ provider: _provider, ...metadata }) => metadata);
  }
}
