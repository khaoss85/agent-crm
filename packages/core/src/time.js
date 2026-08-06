// @ts-check

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Resolve the clock an application runs on. Time is a runtime capability, not
 * a domain concept: an action that decides something *from* the current date
 * (has this term started?) is untestable and non-reproducible while it can
 * only read the wall clock.
 *
 * A supplied clock must return a canonical UTC ISO instant; anything else is a
 * startup-time defect rather than a value that silently propagates into
 * records, audit and trace.
 *
 * @param {unknown} clock
 */
export function resolveClock(clock) {
  if (clock === undefined || clock === null) return nowIso;
  if (typeof clock !== 'function') throw new TypeError('clock must be a function returning an ISO instant');
  return () => {
    const value = clock();
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
      throw new TypeError('clock must return a canonical UTC ISO instant (e.g. 2026-09-01T09:00:00.000Z)');
    }
    return value;
  };
}
