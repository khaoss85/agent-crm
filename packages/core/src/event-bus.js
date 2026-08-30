// @ts-check

import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';

/**
 * In-process event bus with a transaction-scoped event buffer (ADR-012).
 *
 * Normally `emit` dispatches immediately. When code runs inside `buffered(fn)`,
 * every `emit` during `fn` is queued in an async-local buffer instead of
 * dispatched, so domain events become externally visible only after the caller
 * commits its transaction and flushes. `AsyncLocalStorage` isolates the buffer
 * per async call chain, so concurrent actions never share a queue.
 *
 * This is an in-process buffer, NOT a durable outbox: a process crash after the
 * database commit but before the flush loses delivery. Do not rely on these
 * events for remote integrations without a persistent outbox (future work).
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
   * Run `fn` with a transaction-scoped buffer. Events emitted during `fn` are
   * queued. `fn` receives a controller: call `commit()` to flush the queue
   * (dispatch for real) or `discard()` to drop it. If `fn` throws, the queue is
   * dropped automatically. Returns whatever `fn` returns.
   *
   * Nesting is not supported: a `buffered` call inside an active buffered scope
   * fails closed, because an inner flush would make events visible while the
   * outer transaction is still open. Actions therefore cannot invoke actions.
   *
   * Flush failure policy (documented in ADR-012): the flush dispatches every
   * queued event even if a handler fails — a failing handler stops dispatch of
   * ITS event's remaining handlers, but later events still dispatch. Handler
   * errors are collected and reported as one EVENT_DISPATCH_FAILED error after
   * the loop, so the caller can distinguish "business writes failed" from
   * "business writes committed but a subscriber failed".
   *
   * @template T
   * @param {(controller: {commit: () => Promise<void>, discard: () => void, peek: () => Array<{event: string, payload: unknown}>}) => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async buffered(fn) {
    if (this.outbox.getStore()) {
      throw new AppError(
        'Nested buffered event scopes are not supported: an inner commit would make events visible while the outer transaction is still open. Actions must not invoke other actions.',
        { code: 'NESTED_ACTION', status: 500 },
      );
    }
    /** @type {{queue: Array<{event: string, payload: unknown}>}} */
    const store = { queue: [] };
    let flushed = false;
    const controller = {
      commit: async () => {
        flushed = true;
        const events = store.queue;
        store.queue = [];
        /** @type {string[]} */
        const failures = [];
        // Dispatch outside the buffer context so a handler that emits does not
        // re-queue into this (now closed) transaction and get lost.
        await this.outbox.exit(async () => {
          for (const { event, payload } of events) {
            try {
              await this.#dispatch(event, payload);
            } catch (error) {
              failures.push(`${event}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        });
        if (failures.length) {
          throw new AppError(
            `${failures.length} event handler failure(s) after commit`,
            { code: 'EVENT_DISPATCH_FAILED', status: 500, details: { failures } },
          );
        }
      },
      discard: () => {
        flushed = true;
        store.queue = [];
      },
      peek: () => store.queue.map((entry) => ({ event: entry.event, payload: entry.payload })),
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
