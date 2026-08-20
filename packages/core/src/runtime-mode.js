// @ts-check

import { AppError, ValidationError } from './errors.js';

/**
 * **The runtime mode (ADR-038): explicit, never inferred.**
 *
 * The tempting design is "if it looks like localhost, be permissive". Every
 * version of that idea is a vulnerability with a friendly face: a reverse proxy,
 * a container network, an SSH tunnel or a misread `X-Forwarded-For` all make a
 * production request look local. Host, port, `NODE_ENV` and interface address
 * are **not** consulted here, and that is the whole point.
 *
 * There are exactly two modes and no default:
 *
 * - `local-development` — asserted actors are accepted, one explicit local
 *   organization exists, and the schema and the Admin both say so loudly.
 * - `production` — asserted actors are refused, and the application **fails to
 *   start** without an identity verifier and a tenant strategy. It does not warn
 *   and continue: a process that boots half-secured is worse than one that does
 *   not boot, because only one of them gets noticed.
 *
 * An unset mode is an **error**, not a guess. "I forgot to configure it" and "I
 * meant the permissive one" must not be the same input.
 */

export const RUNTIME_MODES = Object.freeze(['local-development', 'production']);

/** The environment variable that selects the mode. Explicit by name. */
export const MODE_ENV = 'ACCORDO_MODE';

/**
 * Resolve the runtime mode and enforce what it requires.
 *
 * @param {{
 *   mode?: unknown,
 *   env?: Record<string, string|undefined>,
 *   identityVerifier?: unknown,
 *   tenantStrategy?: unknown,
 * }} [options]
 */
export function resolveRuntimeMode(options = {}) {
  const env = options.env ?? process.env;
  const raw = options.mode ?? env[MODE_ENV];

  if (raw === undefined || raw === null || raw === '') {
    throw new ValidationError(
      `${MODE_ENV} must be set explicitly to one of ${RUNTIME_MODES.join(' | ')}. `
      + 'There is no default: an unconfigured runtime is not assumed to be a local one, '
      + 'because a production deployment that forgot to set it would inherit the permissive mode.',
      { field: MODE_ENV },
    );
  }
  if (typeof raw !== 'string' || !RUNTIME_MODES.includes(raw)) {
    throw new ValidationError(
      `${MODE_ENV} must be exactly one of ${RUNTIME_MODES.join(' | ')}`,
      { field: MODE_ENV },
    );
  }

  const mode = /** @type {'local-development'|'production'} */ (raw);

  if (mode === 'production') {
    // Fail startup, not the first request. A refused boot is investigated; a
    // refused request at 3am is retried.
    if (typeof options.identityVerifier !== 'function') {
      throw new AppError(
        'production mode requires an identity verifier: the framework does not authenticate '
        + 'requests itself, so without an adapter to verify them nothing can be trusted and '
        + 'nothing will be authorized',
        { code: 'SPINE_VERIFIER_REQUIRED', status: 500, details: { mode } },
      );
    }
    if (!options.tenantStrategy) {
      throw new AppError(
        'production mode requires a tenant strategy: without one there is no authoritative '
        + 'organization for a request, and an ambient tenant fallback is exactly what this '
        + 'milestone refuses to ship',
        { code: 'SPINE_TENANT_STRATEGY_REQUIRED', status: 500, details: { mode } },
      );
    }
  }

  return Object.freeze({
    mode,
    /** Whether an unverified, developer-asserted actor may be accepted. */
    allowsAssertedActors: mode === 'local-development',
    /** Rendered by the Admin and published in the schema block. */
    warning: mode === 'local-development'
      ? 'LOCAL DEVELOPMENT MODE — actor identity is asserted, not verified. Anyone who can reach '
        + 'this server can claim to be anyone. Never expose it, and never treat its audit trail as '
        + 'proof that a particular person did anything.'
      : null,
  });
}
