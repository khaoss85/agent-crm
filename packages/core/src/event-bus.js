// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * In-process event bus with a transaction-aware outbox (ADR-012).
 *
 * Normally `emit` dispatches immediately. When code runs inside `buffered(fn)`,
 * every `emit` during `fn` is queued in an async-local outbox instead of
 * dispatched, so domain events become externally visible only after the caller
 * commits its transaction and flushes. `AsyncLocalStorage` isolates the outbox
 * per async call chain, so concurrent actions never share a queue.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<(payload: any) => unknown | Promise<unknown>>>} */
    this.handlers = new Map();
    /** @type {AsyncLocalStorage<{queue: Array<{event: string, payload: unknown}>}>} */
    this.outbox = new AsyncLocalStorage();
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
    const store = this.outbox.getStore();
    if (store) {
      // Inside a buffered transaction: queue, do not dispatch yet.
      store.queue.push({ event, payload });
      return;
    }
    await this.#dispatch(event, payload);
  }

  /** @param {string} event @param {unknown} payload */
  async #dispatch(event, payload) {
    const exact = [...(this.handlers.get(event) ?? [])];
    const wildcard = [...(this.handlers.get('*') ?? [])];
    for (const handler of [...exact, ...wildcard]) {
      await handler({ event, payload });
    }
  }

  /**
   * Run `fn` with a transaction-scoped outbox. Events emitted during `fn` are
   * queued. `fn` receives a controller: call `commit()` to flush the queue
   * (dispatch for real) or `discard()` to drop it. If `fn` throws, the queue is
   * dropped automatically. Returns whatever `fn` returns.
   *
   * @template T
   * @param {(controller: {commit: () => Promise<void>, discard: () => void}) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async buffered(fn) {
    /** @type {{queue: Array<{event: string, payload: unknown}>}} */
    const store = { queue: [] };
    let flushed = false;
    const controller = {
      commit: async () => {
        flushed = true;
        const events = store.queue;
        store.queue = [];
        // Dispatch outside the outbox context so a handler that emits does not
        // re-queue into this (now closed) transaction and get lost.
        await this.outbox.exit(async () => {
          for (const { event, payload } of events) {
            await this.#dispatch(event, payload);
          }
        });
      },
      discard: () => {
        flushed = true;
        store.queue = [];
      },
    };
    return this.outbox.run(store, async () => {
      try {
        return await fn(controller);
      } finally {
        if (!flushed) store.queue = []; // safety: never leak un-committed events
      }
    });
  }
}
