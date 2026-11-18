// @ts-check

// Conteggi canali (backlog:58f27bf6e757): il solo proprietario della sigla
// distintiva di ogni canale e della direzione fissa di presentazione. Stato
// sync e Connettori leggono da qui, così le tessere non si contraddicono:
// ogni canale ha una sigla unica (niente più doppioni fra alias come
// email/gmail o phone/voice) e la direzione dell'SMS è quella che i
// Connettori dichiarano (in arrivo e in uscita, quindi bidirezionale).
//
// Solo funzioni pure e tabelle congelate, niente DOM: i test girano sotto
// node:test senza browser, come in admin-sync.js. Questo file non possiede
// storage e non fa fetch: la direzione resta di presentazione, lo stato
// reale dei binding resta nel payload di attività.

import { CONNECTOR_CATALOG } from './admin-connectors.js';

/**
 * Alias noti verso il canale canonico: lo stesso binding storico può
 * arrivare con l'id vecchio, la sigla resta una sola.
 */
export const CHANNEL_ALIASES = Object.freeze({
  gmail: 'email',
  phone: 'voice',
  web: 'site-form',
  form: 'site-form',
  google_calendar: 'calendar',
});

/**
 * Canale canonico per un id canale: l'alias noto si risolve, tutto il resto
 * passa com'è (minuscolo, senza spazi ai bordi). Valori non stringa o vuoti
 * leggono ''.
 * @param {unknown} channel
 */
export function canonicalChannel(channel) {
  if (typeof channel !== 'string') return '';
  const id = channel.trim().toLowerCase();
  if (id === '') return '';
  const alias = /** @type {Record<string, string>} */ (CHANNEL_ALIASES)[id];
  return typeof alias === 'string' ? alias : id;
}

/**
 * Sigla distintiva per ogni canale noto: una per canale, mai la stessa per
 * due canali diversi. Le sigle dei nove del prototipo restano quelle delle
 * tessere (WA, IG, FB, TT, @, TEL, WEB, CAL, S); fuori dai nove ogni canale
 * ha la sua (TG, SMS, GM, PH, FO, WB, GC), così nessun alias condivide più
 * la sigla del canonico.
 */
export const CHANNEL_SIGLA = Object.freeze({
  whatsapp: 'WA',
  instagram: 'IG',
  telegram: 'TG',
  facebook: 'FB',
  tiktok: 'TT',
  sms: 'SMS',
  email: '@',
  gmail: 'GM',
  voice: 'TEL',
  phone: 'PH',
  'site-form': 'WEB',
  form: 'FO',
  web: 'WB',
  calendar: 'CAL',
  google_calendar: 'GC',
  stripe: 'S',
});

/**
 * Sigla per un id canale: la sigla della tabella per i canali noti, le
 * prime due lettere maiuscole per gli sconosciuti (come syncMark), '·' per
 * i valori vuoti. Non rende mai ''.
 * @param {unknown} channel
 */
export function channelSigla(channel) {
  if (typeof channel !== 'string') return '·';
  const key = channel.trim().toLowerCase();
  if (key === '') return '·';
  const known = /** @type {Record<string, string>} */ (CHANNEL_SIGLA)[key];
  if (typeof known === 'string' && known !== '') return known;
  return key.slice(0, 2).toUpperCase() || '·';
}

/**
 * Direzione fissa di presentazione per i canali connettibili, come la
 * dichiara il catalogo Connettori (syncLines): '↔ bidirezionale' dove il
 * catalogo dice "in arrivo e in uscita" (l'SMS è bidirezionale per la
 * scheda catalogo 'Nuovi SMS in arrivo e in uscita'), '← in entrata' dove
 * il canale non invia mai (TikTok per la matrice canali, Form sito perché
 * apre conversazioni dai soli invii). Stesse righe delle card di Stato sync,
 * così la stessa direzione non si legge in due modi.
 */
export const CHANNEL_DIRECTION = Object.freeze({
  whatsapp: '↔ bidirezionale',
  instagram: '↔ bidirezionale',
  telegram: '↔ bidirezionale',
  facebook: '↔ bidirezionale',
  tiktok: '← in entrata',
  sms: '↔ bidirezionale',
  email: '↔ bidirezionale',
  voice: '↔ bidirezionale',
  'site-form': '← in entrata',
  calendar: '↔ bidirezionale',
  stripe: '↔ pagamenti e link',
});

/**
 * Direzione fissa per un id canale (gli alias leggono il canonico): la riga
 * della tabella per i canali noti, null per gli sconosciuti — il chiamante
 * ripiega sulla direzione del payload, mai su una riga inventata.
 * @param {unknown} channel
 */
export function channelDirection(channel) {
  const id = canonicalChannel(channel);
  if (id === '') return null;
  const fixed = /** @type {Record<string, string>} */ (CHANNEL_DIRECTION)[id];
  return typeof fixed === 'string' ? fixed : null;
}

/**
 * I canali del catalogo Connettori con sigla e direzione già risolte: la
 * riga che le card conteggi leggono per non duplicare le tabelle. Il nome è
 * quello del catalogo, la direzione quella fissa di questo file.
 */
export function connectorChannelCards() {
  return CONNECTOR_CATALOG.map((entry) => ({
    channel: entry.channel,
    label: entry.label,
    sigla: channelSigla(entry.channel),
    direction: channelDirection(entry.channel),
  }));
}
