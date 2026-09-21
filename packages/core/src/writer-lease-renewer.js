// @ts-check

/**
 * Keep an acquired writer lease alive.
 *
 * `renewWriterLease` has existed since the lease did, correct and
 * compare-and-set, and until now it had **no caller anywhere in this
 * repository**. The consequence was not subtle: `WRITER_LEASE_TTL_MS` is 60
 * seconds, and `assertWriter()` guards `maybeOne` and `many` as well as
 * `execute`, so sixty seconds after bootstrap a PostgreSQL application stopped
 * being able to *read*. Every PostgreSQL test in this repository is shorter
 * than a minute, which is why nothing caught it.
 *
 * This module is the loop and nothing else. It owns no SQL, no pool and no
 * lease state: it is handed a `renewOnce` and decides when to call it and what
 * to do with each outcome. That split is deliberate — the decisions worth
 * testing are all in the scheduling and the failure semantics, and none of them
 * needs a database to test.
 *
 * **It starts nothing on construction.** The framework's rule is that a worker
 * runs because something started it, and this is a worker. Forgetting to start
 * it fails in sixty seconds with `WRITER_LEASE_EXPIRED`, loudly, in the first
 * acceptance anyone runs — which is the failure mode to prefer over a hidden
 * timer that makes every existing composition behave differently.
 */

import { AppError } from './errors.js';

/**
 * Renewals are attempted at a third of the lease's life, so two consecutive
 * failures still leave a whole interval before expiry. Derived, never a second
 * constant: two numbers that must agree eventually do not.
 */
export const RENEWAL_INTERVAL_DIVISOR = 3;

/** @param {number} leaseTtlMs */
export function renewalIntervalMs(leaseTtlMs) {
  if (!Number.isInteger(leaseTtlMs) || leaseTtlMs <= 0) {
    throw new AppError('a lease TTL is a positive whole number of milliseconds', {
      code: 'WRITER_LEASE_RENEWER_INVALID', status: 500,
    });
  }
  return Math.max(1, Math.floor(leaseTtlMs / RENEWAL_INTERVAL_DIVISOR));
}

/**
 * @param {{
 *   renewOnce: () => Promise<unknown>,
 *   leaseTtlMs: number,
 *   schedule?: (fn: () => void, ms: number) => any,
 *   cancel?: (handle: any) => void,
 * }} options
 */
export function createWriterLeaseRenewer(options) {
  if (typeof options?.renewOnce !== 'function') {
    throw new AppError('a lease renewer needs the renewal it is looping over', {
      code: 'WRITER_LEASE_RENEWER_INVALID', status: 500,
    });
  }
  const intervalMs = renewalIntervalMs(options.leaseTtlMs);
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));

  let started = false;
  let stopped = false;
  let timer = null;
  let inFlight = null;
  let renewals = 0;
  let lastOutcome = 'never-run';
  let lastErrorCode = null;

  const clearTimer = () => {
    if (timer !== null) { cancel(timer); timer = null; }
  };

  function armNext() {
    if (!started || stopped) return;
    timer = schedule(() => { void tick(); }, intervalMs);
    // Node keeps the process alive for a pending timer. A renewer must not be
    // the reason a process refuses to exit.
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    if (!started || stopped) return;
    timer = null;
    // Nothing below may reject into the scheduler. An async callback that
    // rejects inside a timer is an unhandled rejection, which is a process
    // exit — a renewer that killed the process it was keeping alive would be
    // worse than the expiry it prevents.
    inFlight = (async () => {
      try {
        await options.renewOnce();
        renewals += 1;
        lastOutcome = 'renewed';
        lastErrorCode = null;
        armNext();
      } catch (error) {
        const code = /** @type {any} */ (error)?.code ?? null;
        lastErrorCode = code;
        // Someone else legitimately holds the lease now, or it expired before
        // this tick reached the database. Renewing harder would be competing
        // with the successor, so this stops and says so. The lease row stays
        // the authority; nothing here overrides it.
        if (code === 'WRITER_LEASE_MISMATCH' || code === 'WRITER_LEASE_EXPIRED') {
          lastOutcome = 'surrendered';
          stopped = true;
          clearTimer();
          return;
        }
        // Anything else is treated as transient — an unreachable database, a
        // deadline — and retried inside the remaining window, which is why the
        // interval is a third of the lease and not most of it.
        lastOutcome = 'retrying';
        armNext();
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  }

  return Object.freeze({
    intervalMs,

    start() {
      if (stopped) {
        throw new AppError('this lease renewer surrendered its lease and does not restart', {
          code: 'WRITER_LEASE_RENEWER_STOPPED', status: 409,
        });
      }
      if (started) return;
      started = true;
      lastOutcome = 'armed';
      armNext();
    },

    /** Bounded: stops arming, and waits only for a renewal already in flight. */
    async stop() {
      stopped = true;
      clearTimer();
      if (inFlight) { try { await inFlight; } catch { /* recorded in status */ } }
    },

    /** Counts, booleans and codes. No lease id, no tenant, no timestamps. */
    status() {
      return Object.freeze({
        started, stopped, intervalMs, renewals, lastOutcome, lastErrorCode,
      });
    },
  });
}
