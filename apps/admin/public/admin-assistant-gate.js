// @ts-check

// The assistant gate both admin surfaces read (backlog:b139d83617f3): the
// Assistente panel and the Spazi e accessi master switch ask the same
// question — «is the AI off here?» — over the same `GET
// /api/assistant/status` answer. It used to live in admin-assistant.js, but
// that module already imports the switch truth from admin-spazi-accessi.js,
// so the switch importing the gate back from the panel would close the
// repo's first import cycle. The contract lives here, both import it, and
// admin-assistant.js re-exports it for its existing importers.

/** Probe path for the assistant backend (status + free-question ask). */
export const ASSISTANT_STATUS_PATH = '/api/assistant/status';

/**
 * The Italian sentence for a space the owner ceiling keeps off: what the
 * state is and who can change it. The panel and the composer already say
 * exactly this — the switch reuses it, never a second wording for the same
 * truth (voce a684ecf5: il messaggio da spento non si contraddice).
 */
export const ASSISTANT_SPACE_DISABLED_NOTICE = 'Assistente non attivo in questo spazio: chiedi al titolare di attivarlo per questo spazio.';

/**
 * The same ceiling truth for the titolare themself (backlog:1968c3320cd3:
 * told where to turn it on, never to ask themself). Lives here with the
 * gate sentence above so the switch can branch on the viewer role without
 * importing the panel (that would close an import cycle).
 */
export const ASSISTANT_SPACE_DISABLED_OWNER_NOTICE = 'Assistente non attivo in questo spazio: puoi accenderlo da Spazi e accessi.';

/**
 * The gate code an /api/assistant/status answer (or its rejection) carries,
 * or null. One reader for every surface that asks «is the AI off here?»
 * (the Assistente panel, the composer «Scrivi al cliente», the Spazi e
 * accessi master switch), over both shapes in use: `{ freeQuestions, code
 * | reason }` and the pilot bridge's `{ spaceId, enabled, reason }`
 * (accordo-arvo-pilot src/shared/bo-assistant.js, mapGateObserved). Reads
 * `code`, `reason` and `errorCode`, mirroring packages/llm error codes.
 * @param {unknown} status
 * @returns {string|null}
 */
export function assistantStatusCode(status) {
  if (status === null || typeof status !== 'object') return null;
  const code = /** @type {any} */ (status).code ?? /** @type {any} */ (status).reason ?? /** @type {any} */ (status).errorCode;
  return typeof code === 'string' && code !== '' ? code : null;
}

/**
 * The gate verdict behind a status answer, or null when it says nothing
 * usable. `enabled: true` only on an explicit true (the framework's own
 * `{ freeQuestions }` shape carries no verdict and reads as unknown, never
 * as off); `enabled: false` only beside a named code, so an unshaped
 * answer never locks a switch the stored permission keeps on.
 * @param {unknown} status
 * @returns {{enabled: boolean, code: string|null}|null}
 */
export function assistantGateOf(status) {
  if (status === null || typeof status !== 'object') return null;
  if (/** @type {any} */ (status).enabled === true) return { enabled: true, code: assistantStatusCode(status) };
  const code = assistantStatusCode(status);
  if (code === null) return null;
  return { enabled: false, code };
}
