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
 * The universe is always the spec's nine (C16/C27: «<n> di 9 collegati»),
 * Stripe included even though nothing connects it yet: what may be
 * *invited* is the screen's decision (Oggi names only the connectable lead
 * channels), never a smaller denominator.
 * @param {unknown} rows connection-like rows ({ channel, status })
 * @returns {{ connected: number, total: number, connectedChannels: ReadonlyArray<string>, missing: ReadonlyArray<{ channel: string, label: string }> }}
 */
export function channelConnectionCount(rows) {
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
  const universe = [...NINE_CHANNEL_IDS, ...extras];
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

/**
 * The words and tone of each channel state, the same on every screen that
 * names one (backlog:e381c48581fa): Connettori, its detail, Personalizzazione,
 * Profilo. Tones are the `.bo-profilo-pill-<tone>` pills.
 */
export const CHANNEL_STATE_LABELS = Object.freeze({
  collegato: Object.freeze({ text: 'Collegato', tone: 'ok' }),
  'da-completare': Object.freeze({ text: 'Da completare', tone: 'warn' }),
  'da-collegare': Object.freeze({ text: 'Da collegare', tone: 'muted' }),
  'non-disponibile': Object.freeze({ text: 'Non ancora disponibile', tone: 'muted' }),
});

/** Said for a linked channel this backoffice does not configure itself. */
export const LINKED_ELSEWHERE_NOTE = 'Collegato: i messaggi arrivano nelle schede dei clienti. Da qui non si configura.';

/** Said for a linked channel whose link lives on Profilo (Google, Meta). */
export const LINKED_ON_PROFILE_NOTE = 'Collegato: i messaggi arrivano nelle schede dei clienti. Si gestisce dal Profilo.';

/** Said for a channel nothing here can connect yet. */
export const NOT_AVAILABLE_NOTE = 'Questo canale non si può ancora collegare da Accordo.';

/**
 * Whether one row is a profile link (Google or Meta grant) rather than a
 * package connection: the client merge marks it `source: 'profile'`, the
 * pilot's server merge keys it `profile:<connector>`.
 * @param {any} row
 */
function isProfileRow(row) {
  return row != null && (row.source === 'profile'
    || (typeof row.connectionKey === 'string' && row.connectionKey.startsWith('profile:')));
}

/** Channels of the nine the guided `#/connettori/<channel>` flow never serves. */
const OUTSIDE_GUIDED_FLOW = Object.freeze({ calendar: true, stripe: true });

/** The Meta connectors: their Collega completes only on a configured Meta app. */
const META_CONNECTORS = Object.freeze(['whatsapp', 'instagram', 'messenger']);

/**
 * Whether Profilo can connect this channel now: the profile offers its
 * connector, and for a Meta connector the space's Meta app is configured
 * (Profilo shows «Non ancora attivo» with no Collega otherwise).
 * @param {unknown} profile
 * @param {string} channel
 */
function profileConnects(profile, channel) {
  const meta = /** @type {any} */ (profile)?.connections?.meta;
  return Object.entries(PROFILE_CONNECTOR_CHANNELS).some(([connector, served]) => served === channel
    && profileOffersConnector(profile, connector)
    && (!META_CONNECTORS.includes(connector) || (meta != null && meta.configured === true)));
}

/**
 * The one state of one channel (backlog:e381c48581fa). Before it, WhatsApp
 * read ✓ in Personalizzazione, «Collegato» on Profilo and «Non disponibile
 * qui · Nessun adattatore composto» in its own detail, on the same space:
 * the detail asked «is an adapter composed?» where every other screen asked
 * «is there an active connection?». The answer to «is it linked?» is the
 * shared count's predicate (an active row, profile links merged), so a
 * channel counted in «2 di 9» is `collegato` everywhere.
 *
 * - `collegato`: an active row serves the channel. `managedHere` says
 *   whether this backoffice configures it (an adapter is composed, or the
 *   adapters are unknown); when not, `note` says so in plain words and
 *   `manageRoute` points to Profilo for a profile link.
 * - `da-completare`: rows exist, none active, and an adapter can finish it.
 * - `da-collegare`: nothing linked, and `connectRoute` is where it connects.
 * - `non-disponibile`: nothing linked and nowhere here to connect it.
 *
 * @param {string} channel the counted channel id (NINE_CHANNELS, sms, telegram)
 * @param {{ rows?: unknown, profile?: unknown, adapters?: ReadonlyArray<unknown> | null, guided?: ReadonlyArray<string> }} [input]
 *   `rows` connection-like rows; `profile` the /api/profile answer (merged
 *   like the count); `adapters` the composed adapters serving this channel,
 *   null when the screen did not read them; `guided` the channels the
 *   `#/connettori/<channel>` flow serves.
 */
export function channelState(channel, { rows = [], profile = null, adapters = null, guided = [] } = {}) {
  const id = countedChannel(channel);
  const matching = mergeProfileConnections(rows, profile)
    .filter((row) => countedChannel(row.channel) === id);
  const composed = Array.isArray(adapters) ? adapters.length > 0 : null;
  const active = matching.find((row) => row.status === 'active') ?? null;
  const shape = (state, extra = {}) => Object.freeze({
    channel: id,
    state,
    text: CHANNEL_STATE_LABELS[state].text,
    tone: CHANNEL_STATE_LABELS[state].tone,
    account: null,
    rows: Object.freeze(matching),
    managedHere: false,
    note: null,
    manageRoute: null,
    connectRoute: null,
    ...extra,
  });
  if (active !== null) {
    const account = typeof active.account === 'string' && active.account.trim() !== '' ? active.account.trim() : null;
    // A profile link (Google, Meta) is managed on Profilo, wherever an
    // adapter is composed: only a package row is configured here.
    const onProfile = isProfileRow(active)
      && !matching.some((row) => row.status === 'active' && !isProfileRow(row));
    if (composed !== false && !onProfile) return shape('collegato', { account, managedHere: true });
    return shape('collegato', {
      account,
      note: onProfile ? LINKED_ON_PROFILE_NOTE : LINKED_ELSEWHERE_NOTE,
      manageRoute: onProfile ? '#/profilo' : null,
    });
  }
  if (matching.length > 0 && composed === true && !Object.hasOwn(OUTSIDE_GUIDED_FLOW, id)) {
    return shape('da-completare', { managedHere: true });
  }
  // A composed adapter opens the guided flow only for a channel that flow
  // serves: Google Calendar connects on Profilo, Stripe nowhere (review
  // #782 P3), whatever the schema lists.
  const guidedHere = composed === true && !Object.hasOwn(OUTSIDE_GUIDED_FLOW, id);
  const connectRoute = guidedHere
    ? `#/connettori/${id}`
    : channelConnectRoute(id, { guided: composed === false ? [] : guided, profile })
      ?? (profileConnects(profile, id) ? '#/profilo' : null);
  if (connectRoute !== null) return shape('da-collegare', { managedHere: guidedHere, connectRoute });
  return shape('non-disponibile', { note: NOT_AVAILABLE_NOTE });
}
