// @ts-check

import { ConflictError, NotFoundError } from './errors.js';

export class ModuleRegistry {
  constructor() {
    /** @type {Map<string, {name: string, version: string, description: string, entities: unknown[], service: unknown}>} */
    this.modules = new Map();
  }

  /** @param {{name: string, version: string, description: string, entities: unknown[], service: unknown}} module */
  register(module) {
    if (this.modules.has(module.name)) {
      throw new ConflictError(`Module already registered: ${module.name}`);
    }
    this.modules.set(module.name, module);
    return module;
  }

  /** @param {string} name */
  get(name) {
    const module = this.modules.get(name);
    if (!module) throw new NotFoundError('Module', name);
    return module;
  }

  list() {
    return [...this.modules.values()].map(({ service: _service, ...metadata }) => metadata);
  }

  schema() {
    return this.list().flatMap((module) => module.entities);
  }
}
