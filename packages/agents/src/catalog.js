// @ts-check

/**
 * The ready-made teammate agents (backlog:33782ba68747): the catalogue the
 * backoffice «Agenti» screen offers under «Catalogo». Pure, frozen,
 * function-free data — each entry is exactly the input `create-agent`
 * takes (name, role, instructions) plus a slug and an example phrase for
 * the @mention. Adding one from the catalogue is the `create-agent`
 * operation and nothing else: no execution, no schedule, no hidden write.
 *
 * Deliberately capless: a `spendingCapCents` on a catalogue agent would
 * force every assignment to carry a `costPerRunCents` estimate
 * (`requireCostEstimate`), and the catalogue has no honest number to put
 * there. A deployment that wants a cap sets it when it wires its executor.
 *
 * The copy is user-visible Italian for a small business owner, and it
 * never claims the agent acts on its own: the instructions say what the
 * agent is told; whether it runs is the deployment's `execute` seam.
 */

/**
 * @typedef {{
 *   slug: string,
 *   name: string,
 *   role: string,
 *   instructions: string,
 *   examplePhrase: string,
 * }} AgentCatalogEntry
 */

/** @type {ReadonlyArray<Readonly<AgentCatalogEntry>>} */
export const AGENT_CATALOG = Object.freeze([
  Object.freeze({
    slug: 'riaggancio',
    name: 'Riaggancio',
    role: 'Ricontatta i clienti rimasti senza risposta',
    instructions: 'Trova i clienti arrivati da WhatsApp, Instagram o email a cui nessuno ha risposto, '
      + 'o fermi da qualche giorno, e prepara un messaggio per ciascuno. Ogni messaggio aspetta il tuo ok.',
    examplePhrase: 'occupati dei lead WhatsApp non contattati',
  }),
  Object.freeze({
    slug: 'report-vendite',
    name: 'Report vendite',
    role: 'Prepara il riepilogo delle vendite',
    instructions: 'Raccoglie le offerte aperte, chiuse e perse del periodo e scrive un riepilogo breve, '
      + 'con i numeri che contano.',
    examplePhrase: 'ogni lunedì il report vendite',
  }),
  Object.freeze({
    slug: 'pulizia-contatti',
    name: 'Pulizia contatti',
    role: 'Tiene in ordine i clienti',
    instructions: 'Cerca doppioni e dati mancanti tra i clienti e propone come sistemarli. '
      + 'Non cambia niente senza il tuo ok.',
    examplePhrase: 'ogni venerdì controlla i doppioni',
  }),
  Object.freeze({
    slug: 'solleciti-offerte',
    name: 'Solleciti offerte',
    role: 'Segue le offerte in attesa di risposta',
    instructions: 'Controlla le offerte mandate e ferme da qualche giorno e propone un messaggio di '
      + 'sollecito per ciascuna. Ogni messaggio aspetta il tuo ok.',
    examplePhrase: 'ogni giorno controlla le offerte ferme',
  }),
]);

/**
 * The agent source key a catalogue entry takes in one space. Source keys
 * are unique across the whole table, so the space is part of the key: the
 * same catalogue agent added in two spaces is two agents, and adding it
 * twice in one space replays `create-agent` as `duplicate: true`.
 * @param {string} spaceId @param {string} slug
 */
export function catalogAgentSourceKey(spaceId, slug) {
  return `agent:${spaceId}:${slug}`;
}

/**
 * backlog:1f7cb20d3c30 — an agent written by hand («Nuovo agente»), not
 * taken from the catalogue. Its source key is made here from a caller key
 * (the backoffice issues `v1.<yyyymmdd>.<hex32>`), never from the name, and
 * it can never look like a catalogue key: a deployment that picks its
 * executor from the catalogue slug (`agent:<space>:<slug>`) must never run a
 * hand-written agent as a catalogue one.
 */
export const CUSTOM_AGENT_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,79}$/;

/**
 * The source key of a hand-written agent in one space, or null when the
 * caller key is not a safe key. A retry with the same caller key gets the
 * same source key, so `create-agent` replays it as `duplicate: true`.
 * @param {string} spaceId @param {unknown} key
 */
export function customAgentSourceKey(spaceId, key) {
  if (typeof key !== 'string' || !CUSTOM_AGENT_KEY_PATTERN.test(key)) return null;
  return `custom-agent:${spaceId}:${key}`;
}

/**
 * Whether a source key belongs to a hand-written agent. `update-agent`
 * and `set-agent-status` only touch these: a catalogue key
 * (`agent:<space>:<slug>`) is refused, so a direct POST can never rename,
 * pause or resume a catalogue agent the card gates keep read-only
 * (review #879 giro 2). Mirrored by `isHandAgentKey` in the backoffice.
 * @param {unknown} key
 */
export function isCustomAgentSourceKey(key) {
  return typeof key === 'string' && key.startsWith('custom-agent:');
}

/**
 * The name an agent answers to in an @mention: accents, case and spaces
 * folded, so «@Report vendite» and «@reportvendite» are the same agent.
 * Two agents of one space may never fold to the same name.
 * @param {unknown} name
 */
export function agentMentionName(name) {
  return String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, '');
}
