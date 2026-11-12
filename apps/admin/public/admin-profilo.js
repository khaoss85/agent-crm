// @ts-check

/**
 * Profilo (#/profilo) — the signed-in person and their Google connections,
 * inside /bo. The prototype has no profile screen: this one is the
 * supervisor's design (design pass 8), built from the same pieces as the
 * rest of /bo — the kicker and display title of every screen, the connector
 * card of Personalizzazione (tile, name, line, pill, action) — so it reads
 * as one product with them, not as the old CRM page it replaces.
 *
 * Reads: GET /api/profile (the pilot serves it, backlog:0994cd18347e)
 *   { member: { name, email, role },
 *     connections: { available, reason, items: [{ connector, status, account }],
 *       meta?: { configured } } }
 * The Meta rows (WhatsApp, Instagram, Messenger — backlog:92f993586110)
 * appear only when the answer carries `connections.meta`: an older pilot
 * that never reads the Meta surface shows no Meta group at all, and a
 * space whose control plane has no Meta app shows the rows without an
 * action, never a Collega that cannot complete.
 * Writes: none here. «Collega» is the pilot's own GET ../profile/collega
 * (the server turns the click into the Google consent), «Scollega» its
 * same-origin POST ../profile/scollega: both already exist and both come
 * back here. Without /api/profile the page still shows the session person
 * and says, in Italian, that the connections cannot be read now.
 */

import { CHANNEL_STATE_LABELS } from './admin-channels-count.js';
import { el, uiButton } from './admin-ui.js'; // BO-F6-02: the single component library.
import { sessionRoleLabel } from './admin-session.js';

export const PROFILO_ROUTE = '#/profilo';

/** The two Google connectors, in the order the prototype lists channels. */
export const PROFILO_CONNECTORS = Object.freeze([
  Object.freeze({ connector: 'calendar', tile: 'CAL', chip: 'ui-chip-cal', name: 'Google Calendar',
    line: 'Appuntamenti del team e disponibilità condivisa.' }),
  Object.freeze({ connector: 'gmail', tile: '@', chip: 'ui-chip-at', name: 'Gmail',
    line: 'Conversazioni e invii dalla tua casella, nelle schede dei clienti.' }),
]);

/** The three Meta connectors, in the order the control plane offers them. */
export const META_CONNECTORS = Object.freeze([
  Object.freeze({ connector: 'whatsapp', tile: 'WA', chip: 'ui-chip-wa', name: 'WhatsApp',
    line: 'Messaggi dei clienti dal numero WhatsApp Business dello studio.' }),
  Object.freeze({ connector: 'instagram', tile: 'IG', chip: 'ui-chip-ig', name: 'Instagram',
    line: 'Messaggi diretti del profilo Instagram professionale.' }),
  Object.freeze({ connector: 'messenger', tile: 'FB', chip: 'ui-chip-fb', name: 'Messenger',
    line: 'Messaggi alla Pagina Facebook dello studio.' }),
]);

/** Google connectors only: a Meta account is a number or a page, not the person. */
const GOOGLE_IDS = new Set(PROFILO_CONNECTORS.map((entry) => entry.connector));

// Connected and not connected read the one shared channel words
// (backlog:e381c48581fa), the same as Connettori and Personalizzazione.
const STATUS_LABELS = Object.freeze({
  connected: CHANNEL_STATE_LABELS.collegato,
  disconnected: CHANNEL_STATE_LABELS['da-collegare'],
  revoked: { text: 'Scollegato', tone: 'muted' },
  error: { text: 'Da ricollegare', tone: 'warn' },
});

/** A Meta row on a space whose control plane has no Meta app yet. */
const NOT_ACTIVE = Object.freeze({ text: 'Non ancora attivo', tone: 'muted' });

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * A person field worth showing: a provider subject (`google|1049…`) is the
 * login's internal id, not a name or an address, so it reads as missing.
 * @param {unknown} value
 */
const personText = (value) => {
  const value_ = text(value);
  return value_ !== null && /^[a-z0-9-]+\|\S+$/i.test(value_) ? null : value_;
};

/** Initials for the avatar: two letters from the name, else from the email. */
export function profiloInitials(name, email) {
  const source = text(name) ?? text(email)?.split('@')[0] ?? '';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return letters.toUpperCase() || '··';
}

/**
 * One Google connection row: tile, name, line, status pill and the action
 * (Collega link or Scollega form). Shared by Profilo and the Connettori
 * screens, so the connection reads and acts the same everywhere.
 */
function connectionRow(doc, list, entry, item, readable, active = true) {
  const row = el(doc, 'div', 'bo-profilo-conn');
  row.setAttribute('data-connector', entry.connector);
  row.appendChild(el(doc, 'span', `ui-chip ${entry.chip} bo-profilo-tile`, entry.tile));
  const words = el(doc, 'div', 'bo-profilo-conn-words');
  words.appendChild(el(doc, 'span', 'bo-profilo-conn-name', entry.name));
  const account = readable && active && item?.status === 'connected' ? text(item.account) : null;
  words.appendChild(el(doc, 'span', 'bo-profilo-conn-line', account !== null ? `Collegato come ${account}` : entry.line));
  row.appendChild(words);
  const side = el(doc, 'div', 'bo-profilo-conn-side');
  if (!readable) {
    side.appendChild(el(doc, 'span', 'bo-profilo-pill bo-profilo-pill-muted', 'Non disponibile'));
  } else if (!active) {
    side.appendChild(el(doc, 'span', `bo-profilo-pill bo-profilo-pill-${NOT_ACTIVE.tone}`, NOT_ACTIVE.text));
  } else {
    // Own keys only: a prototype name (toString, __proto__) is an unknown
    // status, read as «Da collegare» like any other (Muse P2 on #453).
    const key = typeof item?.status === 'string' && Object.hasOwn(STATUS_LABELS, item.status) ? item.status : 'disconnected';
    const status = STATUS_LABELS[key];
    side.appendChild(el(doc, 'span', `bo-profilo-pill bo-profilo-pill-${status.tone}`, status.text));
    if (item?.status === 'connected') {
      // Scollega revokes at the provider (Google or Meta): the pilot's
      // same-origin POST, which checks the origin and comes back here.
      const form = el(doc, 'form', 'bo-profilo-form');
      form.setAttribute('method', 'post');
      form.setAttribute('action', '../profile/scollega');
      const field = doc.createElement('input');
      field.setAttribute('type', 'hidden');
      field.setAttribute('name', 'connector');
      field.setAttribute('value', entry.connector);
      form.appendChild(field);
      form.appendChild(uiButton(doc, { variant: 'secondary', label: 'Scollega', small: true,
        attrs: { type: 'submit', 'data-action': `scollega-${entry.connector}` } }));
      side.appendChild(form);
    } else {
      // Collega is a link, not a fetch: the pilot turns the click into the
      // signed Google or Meta consent and the browser follows it.
      const link = el(doc, 'a', 'ui-btn ui-btn-cta ui-btn-small bo-profilo-collega', 'Collega');
      link.setAttribute('href', `../profile/collega?connector=${entry.connector}`);
      link.setAttribute('data-action', `collega-${entry.connector}`);
      side.appendChild(link);
    }
  }
  row.appendChild(side);
  list.appendChild(row);
}

/**
 * Fill `card` with the rows of `entries` for one /api/profile answer:
 * undefined while reading, null when unreadable, the payload otherwise.
 * @param {any} doc
 * @param {any} card
 * @param {any} answer
 * @param {ReadonlyArray<typeof PROFILO_CONNECTORS[number]>} [entries]
 */
export function paintGoogleConnections(doc, card, answer, entries = PROFILO_CONNECTORS) {
  const list = el(doc, 'div', 'bo-profilo-conns');
  card.appendChild(list);
  if (answer === undefined) {
    list.appendChild(el(doc, 'p', 'bo-profilo-loading', 'Leggo i collegamenti…'));
    return;
  }
  const connections = answer?.connections;
  const readable = connections?.available === true && Array.isArray(connections.items);
  for (const entry of entries) {
    const item = readable ? connections.items.find((candidate) => candidate?.connector === entry.connector) : null;
    connectionRow(doc, list, entry, item ?? null, readable);
  }
  if (!readable) {
    card.appendChild(el(doc, 'p', 'bo-profilo-note',
      'Lo stato dei collegamenti non si può leggere in questo momento: niente è stato inventato. Riprova più tardi.'));
  }
}

/**
 * Whether this /api/profile answer speaks about Meta at all, and whether
 * the space's control plane can complete a Meta consent.
 * @param {any} answer
 * @returns {{ reported: boolean, configured: boolean }}
 */
export function metaState(answer) {
  const connections = answer?.connections;
  const readable = connections?.available === true && Array.isArray(connections.items);
  const meta = connections?.meta;
  const reported = readable && meta !== null && typeof meta === 'object';
  return { reported, configured: reported && meta.configured === true };
}

/**
 * Append the Meta rows for one /api/profile answer, or nothing when the
 * answer does not report Meta. `configured` false keeps the rows named
 * with «Non ancora attivo» and no action.
 * @param {any} doc
 * @param {any} card
 * @param {any} answer
 * @returns {boolean} whether rows were painted
 */
export function paintMetaConnections(doc, card, answer) {
  const { reported, configured } = metaState(answer);
  if (!reported) return false;
  const list = el(doc, 'div', 'bo-profilo-conns bo-meta-conns');
  card.appendChild(list);
  for (const entry of META_CONNECTORS) {
    const item = answer.connections.items.find((candidate) => candidate?.connector === entry.connector);
    connectionRow(doc, list, entry, item ?? null, true, configured);
  }
  if (!configured) {
    card.appendChild(el(doc, 'p', 'bo-profilo-note',
      'Il collegamento con Meta non è ancora attivo per questo spazio: per ora niente da collegare qui.'));
  }
  return true;
}

/**
 * Read GET /api/profile; null when it cannot be read.
 * @param {{ request: (path: string) => Promise<any> }} client
 * @param {(...args: any[]) => void} [log]
 */
export async function readProfile(client, log = () => {}) {
  try {
    const answer = await client.request('/api/profile');
    return answer && typeof answer === 'object' ? answer : null;
  } catch (error) {
    log('bo-profilo profile unreadable:', /** @type {any} */ (error)?.status ?? 'Error');
    return null;
  }
}

/**
 * The «Collegamenti Google» card for the Connettori screens: same rows as
 * Profilo, painted first as «Leggo…» and again with the answer. `entries`
 * narrows it (the Email detail shows only Gmail).
 * @param {{ doc: any, client: { request: (path: string) => Promise<any> },
 *   entries?: ReadonlyArray<typeof PROFILO_CONNECTORS[number]>, log?: (...args: any[]) => void }} deps
 */
export function googleConnectionsCard({ doc, client, entries = PROFILO_CONNECTORS, log = () => {} }) {
  const card = el(doc, 'section', 'panel bo-profilo-card bo-google-card');
  card.setAttribute('data-section', 'google-connections');
  const paint = (answer) => {
    while (card.firstChild) card.removeChild(card.firstChild);
    card.appendChild(el(doc, 'h3', 'bo-profilo-card-title', 'Collegamenti Google'));
    card.appendChild(el(doc, 'p', 'bo-profilo-card-lede',
      'Si collegano con il tuo account Google: un clic su Collega e dai il permesso.'));
    paintGoogleConnections(doc, card, answer, entries);
  };
  paint(undefined);
  const answer = readProfile(client, log);
  const ready = answer.then(paint);
  return { node: card, ready, answer };
}

/**
 * The «Collegamenti Meta» card for the Connettori screen, filled from the
 * same /api/profile answer as the Google card (`ready` is that card's read,
 * so the screen reads the profile once). Hidden until the answer reports
 * Meta: an older pilot leaves the screen exactly as it was.
 * @param {{ doc: any, ready: Promise<any> }} deps
 */
export function metaConnectionsCard({ doc, ready }) {
  const card = el(doc, 'section', 'panel bo-profilo-card bo-meta-card');
  card.setAttribute('data-section', 'meta-connections');
  card.setAttribute('hidden', '');
  const done = Promise.resolve(ready).then((answer) => {
    if (!metaState(answer).reported) return;
    card.appendChild(el(doc, 'h3', 'bo-profilo-card-title', 'Collegamenti Meta'));
    card.appendChild(el(doc, 'p', 'bo-profilo-card-lede',
      'WhatsApp, Instagram e Messenger si collegano con il tuo account Facebook: un clic su Collega e dai il permesso.'));
    paintMetaConnections(doc, card, answer);
    card.removeAttribute('hidden');
  });
  return { node: card, ready: done };
}

/**
 * @param {{ doc: any, mount: any, client: { request: (path: string) => Promise<any> },
 *   member?: () => ({ name?: string | null, email?: string | null, role?: string | null } | null),
 *   log?: (...args: any[]) => void }} deps
 */
export function createProfiloView({ doc, mount, client, member = () => null, log = () => {} }) {
  let token = 0;

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  const read = () => readProfile(client, log);

  function header(page, person) {
    const head = el(doc, 'header', 'bo-profilo-head');
    head.appendChild(el(doc, 'span', 'bo-profilo-avatar', profiloInitials(personText(person.name), personText(person.email))));
    const words = el(doc, 'div', 'bo-profilo-words');
    words.appendChild(el(doc, 'p', 'bo-kicker', 'Il tuo profilo'));
    words.appendChild(el(doc, 'h2', 'bo-profilo-name', personText(person.name) ?? personText(person.email) ?? 'Il tuo profilo'));
    const meta = el(doc, 'div', 'bo-profilo-meta');
    const email = personText(person.email);
    if (email !== null && email !== personText(person.name)) meta.appendChild(el(doc, 'span', 'bo-profilo-email', email));
    const role = sessionRoleLabel(person.role ?? undefined);
    if (role !== '') meta.appendChild(el(doc, 'span', 'bo-profilo-pill bo-profilo-pill-role', role));
    if (meta.firstChild) words.appendChild(meta);
    head.appendChild(words);
    page.appendChild(head);
  }

  /**
   * The whole page for one state: `answer` is undefined while reading, null
   * when /api/profile cannot be read, the payload otherwise.
   */
  function paint(session, answer) {
    clear();
    const page = el(doc, 'div', 'bo-profilo');
    mount.appendChild(page);
    const fromServer = answer?.member && typeof answer.member === 'object'
      ? Object.fromEntries(Object.entries(answer.member).filter(([key, v]) => (key === 'role' ? text(v) : personText(v)) !== null)) : {};
    // No readable email (the login carries only its provider subject): the
    // account a Google connection reports is the person's address.
    const linked = Array.isArray(answer?.connections?.items)
      ? answer.connections.items.find((item) => GOOGLE_IDS.has(item?.connector) && item?.status === 'connected'
        && personText(item.account) !== null)
      : null;
    const person = { ...session, ...fromServer };
    if (personText(person.email) === null && linked) person.email = personText(linked.account);
    header(page, person);
    const card = el(doc, 'section', 'panel bo-profilo-card');
    card.appendChild(el(doc, 'h3', 'bo-profilo-card-title', 'I tuoi collegamenti'));
    card.appendChild(el(doc, 'p', 'bo-profilo-card-lede',
      'Collega una volta sola: Accordo legge e scrive solo con il tuo consenso, e puoi scollegare quando vuoi.'));
    page.appendChild(card);
    paintGoogleConnections(doc, card, answer);
    if (metaState(answer).reported) {
      card.appendChild(el(doc, 'p', 'bo-profilo-group', 'Canali Meta'));
      paintMetaConnections(doc, card, answer);
    }
  }

  async function render() {
    const mine = ++token;
    const session = member() ?? {};
    paint(session, undefined);
    const answer = await read();
    if (mine !== token) return;
    paint(session, answer);
  }

  return { render };
}
