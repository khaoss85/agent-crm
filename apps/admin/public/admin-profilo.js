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
 *     connections: { available, reason, items: [{ connector, status, account }] } }
 * Writes: none here. «Collega» is the pilot's own GET ../profile/collega
 * (the server turns the click into the Google consent), «Scollega» its
 * same-origin POST ../profile/scollega: both already exist and both come
 * back here. Without /api/profile the page still shows the session person
 * and says, in Italian, that the connections cannot be read now.
 */

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

const STATUS_LABELS = Object.freeze({
  connected: { text: 'Collegato', tone: 'ok' },
  disconnected: { text: 'Da collegare', tone: 'muted' },
  revoked: { text: 'Scollegato', tone: 'muted' },
  error: { text: 'Da ricollegare', tone: 'warn' },
});

/** @param {unknown} value */
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** Initials for the avatar: two letters from the name, else from the email. */
export function profiloInitials(name, email) {
  const source = text(name) ?? text(email)?.split('@')[0] ?? '';
  const words = source.split(/[\s._-]+/).filter(Boolean);
  const letters = words.length > 1 ? words[0][0] + words[1][0] : source.slice(0, 2);
  return letters.toUpperCase() || '··';
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

  async function read() {
    try {
      const answer = await client.request('/api/profile');
      return answer && typeof answer === 'object' ? answer : null;
    } catch (error) {
      log('bo-profilo profile unreadable:', /** @type {any} */ (error)?.status ?? 'Error');
      return null;
    }
  }

  function header(page, person) {
    const head = el(doc, 'header', 'bo-profilo-head');
    head.appendChild(el(doc, 'span', 'bo-profilo-avatar', profiloInitials(person.name, person.email)));
    const words = el(doc, 'div', 'bo-profilo-words');
    words.appendChild(el(doc, 'p', 'bo-kicker', 'Il tuo profilo'));
    words.appendChild(el(doc, 'h2', 'bo-profilo-name', text(person.name) ?? text(person.email) ?? 'Il tuo profilo'));
    const meta = el(doc, 'div', 'bo-profilo-meta');
    const email = text(person.email);
    if (email !== null && email !== text(person.name)) meta.appendChild(el(doc, 'span', 'bo-profilo-email', email));
    const role = sessionRoleLabel(person.role ?? undefined);
    if (role !== '') meta.appendChild(el(doc, 'span', 'bo-profilo-pill bo-profilo-pill-role', role));
    if (meta.firstChild) words.appendChild(meta);
    head.appendChild(words);
    page.appendChild(head);
  }

  function connectionRow(list, entry, item, readable) {
    const row = el(doc, 'div', 'bo-profilo-conn');
    row.setAttribute('data-connector', entry.connector);
    row.appendChild(el(doc, 'span', `ui-chip ${entry.chip} bo-profilo-tile`, entry.tile));
    const words = el(doc, 'div', 'bo-profilo-conn-words');
    words.appendChild(el(doc, 'span', 'bo-profilo-conn-name', entry.name));
    const account = readable && item?.status === 'connected' ? text(item.account) : null;
    words.appendChild(el(doc, 'span', 'bo-profilo-conn-line', account !== null ? `Collegato come ${account}` : entry.line));
    row.appendChild(words);
    const side = el(doc, 'div', 'bo-profilo-conn-side');
    if (!readable) {
      side.appendChild(el(doc, 'span', 'bo-profilo-pill bo-profilo-pill-muted', 'Non disponibile'));
    } else {
      // Own keys only: a prototype name (toString, __proto__) is an unknown
      // status, read as «Da collegare» like any other (Muse P2 on #453).
      const key = typeof item?.status === 'string' && Object.hasOwn(STATUS_LABELS, item.status) ? item.status : 'disconnected';
      const status = STATUS_LABELS[key];
      side.appendChild(el(doc, 'span', `bo-profilo-pill bo-profilo-pill-${status.tone}`, status.text));
      if (item?.status === 'connected') {
        // Scollega revokes at Google: the pilot's same-origin POST, which
        // checks the origin and comes back to this screen.
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
        // signed Google consent and the browser follows it.
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
   * The whole page for one state: `answer` is undefined while reading, null
   * when /api/profile cannot be read, the payload otherwise.
   */
  function paint(session, answer) {
    clear();
    const page = el(doc, 'div', 'bo-profilo');
    mount.appendChild(page);
    const fromServer = answer?.member && typeof answer.member === 'object'
      ? Object.fromEntries(Object.entries(answer.member).filter(([, v]) => text(v) !== null)) : {};
    header(page, { ...session, ...fromServer });
    const card = el(doc, 'section', 'panel bo-profilo-card');
    card.appendChild(el(doc, 'h3', 'bo-profilo-card-title', 'I tuoi collegamenti'));
    card.appendChild(el(doc, 'p', 'bo-profilo-card-lede',
      'Collega una volta sola: Accordo legge e scrive solo con il tuo consenso, e puoi scollegare quando vuoi.'));
    const list = el(doc, 'div', 'bo-profilo-conns');
    card.appendChild(list);
    page.appendChild(card);
    if (answer === undefined) {
      list.appendChild(el(doc, 'p', 'bo-profilo-loading', 'Leggo i collegamenti…'));
      return;
    }
    const connections = answer?.connections;
    const readable = connections?.available === true && Array.isArray(connections.items);
    for (const entry of PROFILO_CONNECTORS) {
      const item = readable ? connections.items.find((candidate) => candidate?.connector === entry.connector) : null;
      connectionRow(list, entry, item ?? null, readable);
    }
    if (!readable) {
      card.appendChild(el(doc, 'p', 'bo-profilo-note',
        'Lo stato dei collegamenti non si può leggere in questo momento: niente è stato inventato. Riprova più tardi.'));
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
