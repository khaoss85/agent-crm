// @ts-check

/**
 * Trace redaction for bearer-shaped action data (quote-share public links).
 *
 * An action whose input or result carries a credential it must never persist
 * declares `traceRedact: { input?: (input) => unknown, output?: (result) =>
 * unknown }`. The runtime applies it to the COPIES written into
 * `workflow_runs`/`trace_spans` (and, on PostgreSQL, the write-outcome rows
 * the idempotent envelope persists); the live return value keeps the raw
 * value, and `execute` always sees the raw validated input. A throwing
 * redactor fails the trace write — best-effort and swallowed at the call
 * site — instead of persisting the raw value.
 *
 * One function, every trace-writing caller: the SQLite action runner, the
 * PostgreSQL idempotent envelope and the external-operation runner all call
 * this, never a copy of it.
 *
 * @param {{ input?: (value: unknown) => unknown, output?: (value: unknown) => unknown } | undefined} redact
 * @param {'input' | 'output'} kind
 * @param {unknown} value
 */
export function applyTraceRedact(redact, kind, value) {
  const fn = redact && typeof redact === 'object' ? redact[kind] : undefined;
  if (typeof fn !== 'function') return value;
  return fn(value);
}
