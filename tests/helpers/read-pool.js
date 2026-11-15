// @ts-check

/**
 * backlog:94eabbd4762f — a host that serves `readers` reads at a time, on a
 * virtual clock: every read waits for a free reader, holds it for its own
 * latency, then answers what `base` answers. The order reads are sent in is
 * the order they are served, like the pilot's pool of one or two readers.
 * `cached` paths answer at once without a reader (the shell's schema cache).
 * Deterministic and instant: `settle(promise)` advances the clock read by
 * read until the promise has settled and returns the virtual time it took.
 *
 * @param {{ request: (path: string, options?: any) => Promise<any> }} base
 * @param {{ readers?: number, latency: (path: string) => number, cached?: (path: string) => boolean }} options
 */
export function createReadPool(base, { readers = 2, latency, cached = () => false }) {
  let now = 0;
  /** @type {Array<{path: string, options: any, resolve: (value: any) => void, reject: (error: any) => void, end?: number}>} */
  const queue = [];
  /** @type {typeof queue} */
  const running = [];
  /** @type {Array<{path: string, start: number, end: number}>} */
  const served = [];
  const pump = () => {
    while (running.length < readers && queue.length > 0) {
      const job = /** @type {any} */ (queue.shift());
      job.start = now;
      job.end = now + latency(job.path);
      running.push(job);
    }
  };
  const flush = async (rounds = 6) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return {
    served,
    /** Virtual milliseconds since the pool opened. */
    now: () => now,
    request(path, options = {}) {
      if (cached(path)) return base.request(path, options);
      return new Promise((resolve, reject) => {
        queue.push({ path, options, resolve, reject });
        pump();
      });
    },
    /**
     * Serve reads until `promise` settles; the virtual time it settled at.
     * @param {Promise<unknown>} promise
     */
    async settle(promise) {
      let doneAt = null;
      void Promise.resolve(promise).then(() => { doneAt = now; }, () => { doneAt = now; });
      for (;;) {
        await flush();
        if (doneAt !== null) return doneAt;
        if (running.length === 0) throw new Error('the pool is idle and the promise never settled');
        running.sort((a, b) => /** @type {number} */ (a.end) - /** @type {number} */ (b.end));
        const job = /** @type {any} */ (running.shift());
        now = job.end;
        served.push({ path: job.path, start: job.start, end: job.end });
        base.request(job.path, job.options).then(job.resolve, job.reject);
        pump();
      }
    },
  };
}
