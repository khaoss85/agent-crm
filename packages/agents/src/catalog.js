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
