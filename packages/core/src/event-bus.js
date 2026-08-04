// @ts-check

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<(payload: any) => unknown | Promise<unknown>>>} */
    this.handlers = new Map();
  }

  /** @param {string} event @param {(payload: any) => unknown | Promise<unknown>} handler */
  subscribe(event, handler) {
    const handlers = this.handlers.get(event) ?? new Set();
    handlers.add(handler);
    this.handlers.set(event, handlers);
    return () => handlers.delete(handler);
  }

  /** @param {string} event @param {unknown} payload */
  async emit(event, payload) {
    const exact = [...(this.handlers.get(event) ?? [])];
    const wildcard = [...(this.handlers.get('*') ?? [])];
    for (const handler of [...exact, ...wildcard]) {
      await handler({ event, payload });
    }
  }
}
