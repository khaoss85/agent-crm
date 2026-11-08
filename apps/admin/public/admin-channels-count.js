// @ts-check

// One count of the connected channels for every screen that prints it
// (backlog:5083e7a77c26, backlog:cf365ada15b9).
//
// Oggi said «2 di 9 collegati» beside a list of eight names, and Stato sync
// said «0 di 9» on the same space: Oggi counted the nine Stato sync channels
// plus the profile's Google links, listed the nine *lead* channels of
// CONNECTOR_CATALOG (a different nine: Telegram and SMS in, Google Calendar
// and Stripe out), and Stato sync counted only the activity rows. Three
// answers to one question.
//
// This module is the single answer, pure and DOM-free:
// - the universe is the prototype's nine fixed channels (the Stato sync
//   table rows) plus any channel outside the nine with an active row (a
//   linked SMS or Telegram counts and so does its place: «1 di 10», review
//   #647; a pending one widens nothing, review #680);
// - a channel is connected when one of its rows is `active`; the profile's
//   Google and Meta links (GET /api/profile, the Profilo screen's read) are
//   merged as rows first, so Gmail lights Email and Calendar lights Google
//   Calendar on every screen alike;
// - `missing` is the universe minus the connected channels, in table order,
//   so a screen that prints «x di y» and the names to connect prints
//   numbers and names from the same list: connected + missing = total.
//
// It imports nothing, so any screen may import it without a cycle.

/**
 * The prototype's nine fixed channels (BO-F6-16, fetta 2), in Stato sync
 * order: id, the table name, the tile mark and the fixed direction line.
 * `sms` and `telegram` are connectable in the catalog but outside the nine.
 */
export const NINE_CHANNELS = Object.freeze([
  Object.freeze({ id: 'whatsapp', name: 'WhatsApp', mark: 'WA', direction: '↔ bidirezionale' }),
  Object.freeze({ id: 'instagram', name: 'Instagram', mark: 'IG', direction: '↔ bidirezionale' }),
  Object.freeze({ id: 'facebook', name: 'Facebook', mark: 'FB', direction: '↔ bidirezionale' }),
  Object.freeze({ id: 'tiktok', name: 'TikTok', mark: 'TT', direction: '← in entrata' }),
  Object.freeze({ id: 'email', name: 'Email', mark: '@', direction: '↔ bidirezionale' }),
  Object.freeze({ id: 'voice', name: 'Telefono', mark: 'TEL', direction: '↔ bidirezionale' }),
  Object.freeze({ id: 'site-form', name: 'Form sito', mark: 'WEB', direction: '← in entrata' }),
  Object.freeze({ id: 'calendar', name: 'Google Calendar', mark: 'CAL', direction: '↔ bidirezionale' }),
  Object.freeze({ id: 'stripe', name: 'Stripe', mark: 'S', direction: '↔ pagamenti e link' }),
]);

/** The nine ids, in table order. */
export const NINE_CHANNEL_IDS = Object.freeze(NINE_CHANNELS.map((row) => row.id));

/** Names for channels outside the nine, when one of them is linked. */
const EXTRA_CHANNEL_NAMES = Object.freeze({ sms: 'SMS', telegram: 'Telegram' });

/**
 * Profile connectors (GET /api/profile `connections.items[].connector`,
 * the ids of admin-profilo.js) mapped onto the channel each one serves —
 * the same mapping the pilot applies server-side (src/shared/bo-connectors.js).
 */
export const PROFILE_CONNECTOR_CHANNELS = Object.freeze({
  gmail: 'email',
  calendar: 'calendar',
  whatsapp: 'whatsapp',
  instagram: 'instagram',
  messenger: 'facebook',
});

/**
 * Stored channel spellings that name a counted channel under another word:
 * a Google- or Meta-flavoured adapter may store `google-calendar`, `gmail`
 * or `messenger`. The pilot serves its connectors reads under the shell's
 * key already (src/shared/bo-connectors.js `CHANNEL_ALIASES`), but Oggi
 * reads the raw channel-connection records: without the same aliases one
 * Calendar row would count as a tenth, unknown channel there.
 */
export const CHANNEL_ALIASES = Object.freeze({
  'google-calendar': 'calendar',
  google_calendar: 'calendar',
  gmail: 'email',
  messenger: 'facebook',
});

/**
 * The counted channel id of one stored spelling, '' when blank.
 * @param {unknown} value
 */
export function countedChannel(value) {
  if (typeof value !== 'string' || value === '') return '';
  return Object.hasOwn(CHANNEL_ALIASES, value) ? CHANNEL_ALIASES[value] : value;
}

/**
 * Where a channel connects when the guided `#/connettori/<channel>` flow
 * does not serve it. Google Calendar connects per person on Profilo, where
 * its Collega lives. Stripe has no connect screen in the backoffice (the
 * catalog only reports its state), so it has no destination: a `Collega`
 * for it would land nowhere.
 */
export const CHANNEL_CONNECT_ROUTES = Object.freeze({
  calendar: '#/profilo',
});

/**
 * The readable profile connection items, or null when the profile is
 * unreadable or says its connections are unavailable.
 * @param {unknown} profile the /api/profile payload, null when unreadable
 * @returns {Array<any> | null}
 */
function profileItems(profile) {
  const connections = profile !== null && typeof profile === 'object'
    ? /** @type {any} */ (profile).connections
    : null;
  return connections !== null && typeof connections === 'object'
    && connections.available === true && Array.isArray(connections.items)
    ? connections.items
    : null;
}

/**
 * Whether the profile offers one connector at all (any status): the
 * product can connect it here, so a screen may offer its Collega.
 * @param {unknown} profile
 * @param {string} connector
 */
export function profileOffersConnector(profile, connector) {
  const items = profileItems(profile);
  return items !== null && items.some((item) => item != null && item.connector === connector);
}

/**
 * Connection rows plus one synthetic `active` row per channel the profile
 * says is `connected` and no row already serves as active (a package row
 * wins: it carries the real connection key). Revoked, errored or unknown
 * profile items add nothing; an unreadable profile adds nothing.
 * @param {unknown} rows connection-like rows ({ channel, status, ... })
 * @param {unknown} [profile] the /api/profile payload, null when unreadable
 * @returns {Array<any>}
 */
export function mergeProfileConnections(rows, profile = null) {
  const list = Array.isArray(rows) ? rows.filter((row) => row != null && typeof row === 'object') : [];
  const items = profileItems(profile);
  if (items === null) return list;
  const active = new Set(list
    .filter((row) => row.status === 'active' && countedChannel(row.channel) !== '')
    .map((row) => countedChannel(row.channel)));
  const merged = [...list];
  for (const [connector, channel] of Object.entries(PROFILE_CONNECTOR_CHANNELS)) {
    if (active.has(channel)) continue;
    const item = items.find((candidate) => candidate != null
      && candidate.connector === connector && candidate.status === 'connected');
    if (item === undefined) continue;
    active.add(channel);
    merged.push(Object.freeze({
      connectionKey: `profile:${connector}`,
      channel,
      account: typeof item.account === 'string' && item.account !== '' ? item.account : null,
      status: 'active',
      // The profile says this link is connected: Stato sync paints it
      // `Attivo`, never `In attesa` beside a count that calls it linked
      // (review #680 P2-1). No grant, no import, no tally is implied.
      health: 'ok',
      source: 'profile',
    }));
  }
  return merged;
}

/**
 * The display name of one channel of the universe.
 * @param {string} channel
 */
export function channelCountName(channel) {
  const fixed = NINE_CHANNELS.find((row) => row.id === channel);
  if (fixed) return fixed.name;
  return Object.hasOwn(EXTRA_CHANNEL_NAMES, channel) ? EXTRA_CHANNEL_NAMES[channel] : channel;
}

/**
 * Where one channel connects in this backoffice, or null when nothing here
 * can connect it. A channel of the guided flow (`guided`, the
 * CONNECTOR_CATALOG ids) opens `#/connettori/<channel>`; Google Calendar
 * opens Profilo when the profile offers the Google connector (that is where
 * its Collega lives); Stripe has no connect screen. One answer for the
 * Stato sync `Collega`, the Personalizza card and the Oggi invite.
 * @param {string} channel
 * @param {{ guided?: ReadonlyArray<string>, profile?: unknown }} [options]
 */
export function channelConnectRoute(channel, { guided = [], profile = null } = {}) {
  if (typeof channel !== 'string' || channel === '') return null;
  if (Array.isArray(guided) && guided.includes(channel)) return `#/connettori/${channel}`;
  if (!Object.hasOwn(CHANNEL_CONNECT_ROUTES, channel)) return null;
  const offered = Object.entries(PROFILE_CONNECTOR_CHANNELS)
    .some(([connector, served]) => served === channel && profileOffersConnector(profile, connector));
  return offered ? CHANNEL_CONNECT_ROUTES[channel] : null;
}

/**
 * The one connected-channels count: `connected` of `total`, and the
 * `missing` channels (universe minus connected, table order) with their
 * names. Rows should already carry the profile links
 * (`mergeProfileConnections`).
 *
 * `connectable` decides which unlinked channels belong to the universe
 * (production 08/11: Oggi invited to connect Stripe, which Stato sync and
 * Personalizza call «Non disponibile»): a channel nothing here can connect
 * is neither counted nor invited until it is linked; a linked channel
 * always counts. Without the predicate every fixed channel is connectable.
 * @param {unknown} rows connection-like rows ({ channel, status })
 * @param {{ connectable?: (channel: string) => boolean }} [options]
 * @returns {{ connected: number, total: number, connectedChannels: ReadonlyArray<string>, missing: ReadonlyArray<{ channel: string, label: string }> }}
 */
export function channelConnectionCount(rows, { connectable = () => true } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const active = new Set();
  const extras = [];
  for (const row of list) {
    if (row == null || typeof row !== 'object') continue;
    const channel = countedChannel(row.channel);
    if (channel === '' || row.status !== 'active') continue;
    // Only a linked channel widens the universe (review #680 P2-3): a
    // pending SMS row is not a tenth channel to invite.
    if (!NINE_CHANNEL_IDS.includes(channel) && !extras.includes(channel)) extras.push(channel);
    active.add(channel);
  }
  const canConnect = (channel) => {
    try {
      return connectable(channel) === true;
    } catch {
      return false;
    }
  };
  const universe = [
    ...NINE_CHANNEL_IDS.filter((channel) => active.has(channel) || canConnect(channel)),
    ...extras,
  ];
  const connectedChannels = universe.filter((channel) => active.has(channel));
  const missing = universe
    .filter((channel) => !active.has(channel))
    .map((channel) => Object.freeze({ channel, label: channelCountName(channel) }));
  return Object.freeze({
    connected: connectedChannels.length,
    total: universe.length,
    connectedChannels: Object.freeze(connectedChannels),
    missing: Object.freeze(missing),
  });
}
