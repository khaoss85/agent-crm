// @ts-check

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.
import { humanReadError } from './admin-core.js';

/**
 * **The customer scheda (BO-F1-06): one customer, three columns.**
 *
 * A read-only projection over records other packages already hold — the card
 * (`read-customer-card`), the timeline (`read-customer-timeline`) and the
 * consolidated profile (`read-customer-profile`). It creates nothing: no
 * master row, no copy, no new table.
 *
 * Layout, like the backoffice prototype ("05 Scheda cliente"):
 * - left: quick actions, linked identities with their human motivation,
 *   details, "Arricchito dall'AI" with the free source and date of every
 *   datum (BO-F4-03, read from the customer-data enrichment operations);
 * - center: the channel timeline, every passage with channel, direction and
 *   sync state, filterable per channel;
 * - right: AI summary, next steps, offer, next appointment.
 *
 * Every panel the composed packages cannot feed stays in plain Italian: data
 * panels with nothing readable show a short empty state, blocks whose
 * package is not composed at all stay hidden instead of explaining
 * themselves — never an empty value that could be mistaken for "none",
 * never an English system reason, id or ISO date on screen (those live on
 * in the API responses and the logs). The
 * reply composer (BO-F1-07) is deliberately not here: it is its own story
 * with its own gate (approval). The call summary with signals and
 * transcript (BO-F1-08) IS here, read from the call-intelligence
 * operations: a call exists only under a recorded start-of-call notice,
 * and a transcript erased by retention reads as erased, never as missing.
 */

const CHANNEL_LABELS = Object.freeze({
  whatsapp: 'WhatsApp',
  instagram: 'Instagram',
  facebook: 'Messenger',
  // Voce 19c2e22a64a1 (6): every CARD_CHANNEL_MARKS key reads Italian — the
  // scheda never prints a raw channel key. `messenger` follows `facebook`
  // (both paint FB); `calendar` follows the prototype chip (`Google
  // Calendar`); `web`/`form` follow the Oggi tile note (`WEB (Form sito)` in
  // admin-ui.js); `outlook` keeps its product name like `gmail` keeps Gmail.
  // Voce 59def6cb805d: stessa copertura per C15/C17.
  tiktok: 'TikTok',
  email: 'Email',
  gmail: 'Gmail',
  outlook: 'Outlook',
  sms: 'SMS',
  phone: 'Telefono',
  voice: 'Telefono',
  tel: 'Telefono',
  mobile: 'Telefono',
  messenger: 'Messenger',
  calendar: 'Google Calendar',
  web: 'Sito',
  form: 'Form sito',
});

/** Delivery/sync state, inbound or outbound, in the operator's words. */
const SYNC_LABELS = Object.freeze({
  received: 'ricevuto',
  sent: 'inviato',
  delivered: 'consegnato',
  read: 'letto',
  failed: 'non consegnato',
  completed: 'completata',
  missed: 'persa',
  'no-answer': 'senza risposta',
});

/**
 * Voce cc525cd6a3c5: the quote and opportunity-fallback stages share the
 * Italian-only table below (anything unknown reads back as null, never raw
 * English) — kept as one table with the 1a066ddf labels, not two.
 *
 * Voce 1a066ddfe42a: the scheda speaks only plain Italian. The API reasons
 * stay in English in the responses (the honest system phrases live there
 * and in the logs) — the page never prints them. Dates render readable in
 * Europe/Rome, ids and UUIDs never reach visible text.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => UUID_SHAPE.test(String(value ?? '').trim());
/**
 * A handle readable by a human operator (a name or username), never a code:
 * UUIDs, letter-digit codes (`c1`, `user-123`) and long digit runs stay out.
 */
const isHumanHandle = (value) => {
  const text = String(value ?? '').trim();
  if (text === '' || isUuid(text)) return false;
  if (/[0-9]{4,}/.test(text)) return false;
  if (/^[a-zÀ-ÿ]*\d+$/i.test(text)) return false;
  if (/^[a-zÀ-ÿ]+-\d+$/i.test(text)) return false;
  return true;
};

const dateTimeParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms));
};

const dateParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    day: 'numeric', month: 'short', year: 'numeric',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms));
};

const dayParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms));
};

const timeParts = (value) => {
  const ms = Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('it-IT', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Rome',
  }).format(new Date(ms));
};

/**
 * Voce 59def6cb805d (C16): the Rome calendar day of an instant, as
 * `YYYY-MM-DD`, so the timeline can mark the passages of today with the
 * prototype's `OGGI · ` prefix. Day-level only — never an instant on screen.
 */
const romeDayKey = (ms) => {
  if (!Number.isFinite(ms)) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(ms));
};

/**
 * Voce 59def6cb805d (C19): a call duration in `<m:ss>` for the timeline
 * card (`372` → `6:12`). Null when the data holds no usable duration — the
 * card then shows no duration instead of an invented one.
 */
const durationParts = (sec) => {
  const total = typeof sec === 'number' ? Math.floor(sec) : Number.NaN;
  if (!Number.isFinite(total) || total < 0) return null;
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Voce 59def6cb805d (C17): the sync-row arrow of the prototype
 * (`↔/←/→ <canale> · <stato>`). Inbound `←`, outbound `→`; a passage with
 * no recorded direction carries no arrow instead of an invented one.
 */
const syncArrow = (direction) => {
  if (direction === 'inbound') return '← ';
  if (direction === 'outbound') return '→ ';
  return '';
};

/**
 * Own-property label lookup: a hostile or unknown key (`constructor`,
 * `toString`, `__proto__`, …) never reads through to `Object.prototype` —
 * it falls to the caller's fallback, never a function source on screen.
 */
const ownLabel = (map, key) => Object.hasOwn(map, key) ? map[key] : undefined;

const STATUS_LABELS = Object.freeze({ cliente: 'Cliente', contatto: 'Contatto' });
const statusLabel = (value) => ownLabel(STATUS_LABELS, String(value ?? '').toLowerCase())
  ?? String(value ?? 'Contatto').replace(/^./, (first) => first.toUpperCase());

/**
 * The Italian line under the stato: a definitive «none» only when the three
 * evidence sections are readable with exact zero counts — the same
 * absence-proof discipline the API verdict follows. Otherwise the line stays
 * honest about the unreadable checks.
 */
const EVIDENCE_KEYS = Object.freeze(['orders', 'contracts', 'subscriptions']);
const statusMicrocopy = (card, profile) => {
  if (String(card?.status?.value ?? '').toLowerCase() === 'cliente') return 'Attività firmata collegata';
  const proven = EVIDENCE_KEYS.every((key) => profile?.[key]?.available === true
    && (profile[key]?.count ?? 0) === 0
    && profile[key]?.countIsComplete !== false);
  return proven
    ? 'Nessuna attività firmata collegata'
    : 'Nessuna attività firmata visibile (verifiche non complete)';
};

const OFFER_STATUS_LABELS = Object.freeze({
  sent: 'inviata', draft: 'bozza', approved: 'approvata', rejected: 'rifiutata',
  open: 'aperta', won: 'vinta', lost: 'persa', expired: 'scaduta', accepted: 'accettata',
  pending_approval: 'in attesa di approvazione', approval_pending: 'in attesa di approvazione',
  discovery: 'scoperta', qualification: 'qualificazione', proposal: 'proposta', negotiation: 'trattativa',
});
const offerStatusLabel = (status) => ownLabel(OFFER_STATUS_LABELS, String(status ?? '').toLowerCase()) ?? null;

const PACKAGE_STATUS_LABELS = Object.freeze({ active: 'attivo' });
const packageStatusLabel = (status) => ownLabel(PACKAGE_STATUS_LABELS, String(status ?? '').toLowerCase()) ?? null;

const RESOURCE_LABELS = Object.freeze({ contact: 'Contatto', company: 'Azienda' });
const resourceLabel = (resource) => ownLabel(RESOURCE_LABELS, String(resource ?? '').toLowerCase()) ?? 'Scheda';

const ROLE_LABELS = Object.freeze({ canonical: 'scheda principale', alias: 'scheda collegata' });
const roleLabel = (role) => ownLabel(ROLE_LABELS, String(role ?? '').toLowerCase()) ?? null;
const channelLabel = (channel) => ownLabel(CHANNEL_LABELS, String(channel ?? '').toLowerCase()) ?? String(channel ?? 'canale');
const syncLabel = (sync) => ownLabel(SYNC_LABELS, String(sync ?? '').toLowerCase()) ?? String(sync ?? 'stato ignoto');

/**
 * @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void,
 *   spaceId?: string | (() => (string | null | undefined))}} deps
 * `spaceId` is the shell's active space (string or thunk): the calls read
 * stays space-explicit, never inferred. Without it the calls section stays
 * honestly unavailable.
 */
const CARD_CHANNEL_MARKS = Object.freeze({ whatsapp: 'WA', instagram: 'IG', facebook: 'FB', tiktok: 'TT', email: '@', gmail: '@', outlook: '@', phone: 'TEL', tel: 'TEL', mobile: 'TEL', voice: 'TEL', sms: 'SMS', web: 'WEB', form: 'WEB', calendar: 'CAL', messenger: 'FB' });

export function createCustomerCardView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client } = deps;
  // The shell toast, like every sibling admin view: Aggiorna reports through
  // it, never through a bare status line. Without a shell it stays a noop.
  const toast = deps.toast ?? (() => {});
  const activeSpaceId = () => {
    const raw = typeof deps.spaceId === 'function' ? deps.spaceId() : deps.spaceId;
    return typeof raw === 'string' && raw !== '' ? raw : null;
  };
  const el = elFor(doc); // BO-F6-02: shared element builder.
  const link = (href, text, action) => {
    const node = el('a', undefined, text);
    node.setAttribute('href', href);
    if (action) node.setAttribute('data-action', action);
    return node;
  };

  let channelFilter = 'all';

  async function load(resource, id) {
    const encoded = `${encodeURIComponent(resource)}/${encodeURIComponent(id)}`;
    const spaceId = activeSpaceId();
    const [card, timeline, profile, enrichment, calls] = await Promise.all([
      client.request(`/api/customer-hub/card/${encoded}`),
      client.request(`/api/customer-hub/timeline/${encoded}`),
      client.request(`/api/customer-data/profile/${encoded}`),
      // The enrichment read lives in the same package as the profile, so it
      // shares its fate — but an older server that does not serve the route
      // yet answers 404, and the scheda must stay honest about the section
      // instead of failing the whole card. Every other failure still
      // rejects, so the card shows its error.
      client.request(`/api/customer-data/enriched/${encoded}`)
        .catch((error) => {
          if (error && error.status === 404) return null;
          throw error;
        }),
      // Without intelligence composed (honest 404) or without a space the
      // calls read stays unavailable — never a failed card. Every other
      // failure (expired session, network, HTTP 5xx) still rejects, so the
      // card shows its error instead of a misleading "no calls".
      spaceId === null
        ? Promise.resolve(null)
        : client.request(`/api/call-intelligence/calls/${encoded}?spaceId=${encodeURIComponent(spaceId)}`)
          .catch((error) => {
            if (error && error.status === 404) return null;
            throw error;
          }),
    ]);
    return { card, timeline, profile, enrichment, calls };
  }

  /** First Unicode letter of a word, or '?' when the word holds none. */
  function firstLetter(word) {
    const hit = String(word ?? '').match(/\p{L}/u);
    return hit ? hit[0] : '?';
  }

  /**
   * Initials for the header avatar ("Guido Presti" → "GP"): first letter of
   * the first and last word, uppercased. Text only, so a hostile name stays
   * inert text inside the circle.
   */
  function initialsFor(name) {
    const words = String(name ?? '').trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    const last = words.length > 1 ? firstLetter(words[words.length - 1]) : '';
    return `${firstLetter(words[0])}${last}`.toUpperCase();
  }

  function header(panel, card, resource, id) {
    // BO-F6-09 fetta 2a: ghost back button, avatar with initials, H1 name
    // and the stato pill. The meta line (città · provenienza · referente) is
    // NOT rendered: no record holds it yet (the contact record has no city,
    // nothing names a referente), so the header shows the company instead —
    // never an invented meta. Fetta C3 (backlog:f84626a0) renders it now:
    // the origin is the earliest-observed identity the card reports; city
    // and referente have no record yet, so those segments are left out.
    void resource;
    void id;
    const back = el('button', 'bo-scheda-back', '← Clienti');
    back.setAttribute('type', 'button');
    back.setAttribute('data-action', 'back-to-clienti');
    back.addEventListener('click', () => navigate('#/customer-data'));
    panel.appendChild(back);
    const head = el('div', 'bo-scheda-head');
    const avatar = el('span', 'bo-scheda-avatar', initialsFor(card?.name));
    avatar.setAttribute('aria-hidden', 'true');
    head.appendChild(avatar);
    const titles = el('div', 'bo-scheda-titles');
    titles.appendChild(el('h1', 'bo-scheda-name', card?.name ?? 'Scheda cliente'));
    const meta = el('div', 'bo-scheda-meta');
    meta.appendChild(el('span', 'bo-scheda-badge', statusLabel(card?.status?.value)));
    // C3, as the prototype reads it: `<città> · via <canale> · la segue
    // <referente>`. Only what a record holds is shown: a missing segment is
    // left out, never written as `Da raccogliere` three times in a row
    // (that amber word belongs to the profile fields below). With no segment
    // at all the line keeps the company, as before C3. Only a system the
    // prototype names reads as its Italian label; every segment is text.
    const headline = card?.headline ?? null;
    const city = headline?.city?.available === true
      && typeof headline.city.value === 'string' && headline.city.value !== ''
      ? headline.city.value : null;
    const originSystem = headline?.origin?.available === true
      ? String(headline.origin.system ?? '').toLowerCase() : '';
    const origin = ownLabel(CHANNEL_LABELS, originSystem) ?? null;
    const follow = headline?.assignee?.available === true
      && typeof headline.assignee.value === 'string' && headline.assignee.value !== ''
      ? headline.assignee.value : null;
    const segments = [city, origin === null ? null : `via ${origin}`, follow === null ? null : `la segue ${follow}`]
      .filter((segment) => segment !== null);
    if (segments.length > 0) meta.appendChild(el('span', 'bo-scheda-sub', segments.join(' · ')));
    else if (card?.company?.name) meta.appendChild(el('span', 'bo-scheda-sub', card.company.name));
    titles.appendChild(meta);
    head.appendChild(titles);
    panel.appendChild(head);
  }

  function quickActions(box, card) {
    box.appendChild(el('h4', undefined, 'Azioni rapide'));
    const row = el('div', 'bo-scheda-actions');
    if (card?.phone?.available === true && card.phone.value) {
      const dialable = String(card.phone.value).replaceAll(/[^\d+]/g, '');
      const call = link(`tel:${dialable === '' ? card.phone.value : dialable}`, 'Chiama', 'call-customer');
      call.setAttribute('class', 'bo-scheda-tile');
      call.setAttribute('title', `Chiama ${card.phone.value}`);
      row.appendChild(call);
    } else {
      // Voce 1a066ddfe42a: the API reason stays in the response, never on screen.
      row.appendChild(el('span', 'bo-scheda-disabled', 'Nessun telefono collegato'));
    }
    if (typeof card?.email === 'string' && card.email !== '') {
      const mail = link(`mailto:${card.email}`, 'Email', 'mail-customer');
      mail.setAttribute('class', 'bo-scheda-tile');
      mail.setAttribute('title', `Scrivi a ${card.email}`);
      row.appendChild(mail);
    } else {
      row.appendChild(el('span', 'bo-scheda-disabled', 'email non disponibile'));
    }
    box.appendChild(row);
  }

  function linkedIdentities(box, profile) {
    // Voce 1a066ddfe42a: every identity reads as plain Italian — a resource
    // label and a role label, never a bare id or UUID. The English cluster
    // note stays in the API response, never on screen.
    // Voce 59def6cb805d (C10): one row per observed channel — the badge the
    // prototype paints plus the handle the outside world called this customer.
    // Only systems with an Italian label read on screen (the enrichment-only
    // `google-contacts` system and UUID handles never do); a sync direction
    // (`↔ sincronizzato` / `← in entrata`) is NOT printed here because the
    // profile carries no connector direction — that needs the
    // channel-connection exposure of arch fetta 3, noted in the PR.
    box.appendChild(el('h4', undefined, 'Identità collegate'));
    const cluster = profile?.canonicalIdentity;
    if (!cluster) {
      box.appendChild(el('p', 'bo-muted', 'identità non leggibili: il profilo non è disponibile'));
      return;
    }
    const rawIdentities = Array.isArray(profile?.externalIdentities) ? profile.externalIdentities : [];
    const channelRows = rawIdentities.filter((row) => {
      const system = String(row?.system ?? '').toLowerCase();
      if (ownLabel(CHANNEL_LABELS, system) === undefined) return false;
      return !isUuid(row?.externalId);
    });
    const systems = new Set(channelRows.map((row) => String(row.system).toLowerCase()));
    box.appendChild(el('p', 'bo-muted',
      channelRows.length === 0
        ? 'nessun canale osservato'
        : `${systems.size} ${systems.size === 1 ? 'canale' : 'canali'}`));
    for (const row of channelRows) {
      const system = String(row.system).toLowerCase();
      const line = el('p', 'bo-scheda-identity');
      line.setAttribute('data-channel', system);
      const known = Object.hasOwn(CARD_CHANNEL_MARKS, system);
      line.appendChild(el('span', `bo-scheda-chan bo-tile-${known ? system : 'other'}`, known ? CARD_CHANNEL_MARKS[system] : '·'));
      line.appendChild(el('span', undefined, ` ${channelLabel(system)} · ${String(row.externalId)}`));
      box.appendChild(line);
    }
    const members = Array.isArray(cluster.members) ? cluster.members : [];
    box.appendChild(el('p', 'bo-muted',
      cluster.linked === true
        ? `${members.length} ${members.length === 1 ? 'scheda' : 'schede'} della stessa persona`
        : 'una sola scheda: nessuna unione registrata'));
    for (const member of members) {
      const line = el('p', 'bo-scheda-identity');
      line.setAttribute('data-member', `${member?.resource ?? ''}:${member?.id ?? ''}`);
      const role = roleLabel(member?.role);
      line.appendChild(el('strong', undefined,
        role ? `${resourceLabel(member?.resource)} · ${role}` : resourceLabel(member?.resource)));
      // BO-F1-06: the motivation the decider recorded, with who and when —
      // never a bare id the operator has to trust.
      if (typeof member?.reason === 'string' && member.reason !== '') {
        line.appendChild(el('span', undefined, ` — ${member.reason}`));
      } else {
        line.appendChild(el('span', 'bo-muted', ' — motivazione non registrata'));
      }
      const when = dateParts(member?.decidedAt);
      if (isHumanHandle(member?.decidedBy?.id) || when) {
        const who = isHumanHandle(member?.decidedBy?.id) ? `da ${String(member.decidedBy.id).trim()}` : 'da un operatore';
        line.appendChild(el('span', 'bo-muted', ` (${when ? `${who} il ${when}` : who})`));
      }
      box.appendChild(line);
    }
    // Voce 59def6cb805d (C11): the prototype's violet note under the
    // identities — the union motivation the decider recorded, never an
    // invented one. One note per distinct recorded reason; with no linked
    // union, or no recorded reason, no note is shown.
    if (cluster.linked === true) {
      const reasons = [...new Set(members
        .map((member) => (typeof member?.reason === 'string' ? member.reason.trim() : ''))
        .filter((reason) => reason !== ''))];
      for (const reason of reasons) {
        box.appendChild(el('p', 'bo-scheda-union-note', `✦ ${reason}`));
      }
    }
  }

  function details(box, card, profile) {
    box.appendChild(el('h4', undefined, 'Dettagli'));
    const fact = (label, value) => {
      const row = el('p', 'bo-scheda-fact');
      row.appendChild(el('span', 'bo-scheda-fact-label', label));
      row.appendChild(el('span', undefined, value));
      box.appendChild(row);
    };
    fact('Nome', card?.name ?? '—');
    if (card?.company?.name) fact('Azienda', card.company.name);
    fact('Email', card?.email ?? 'non disponibile');
    // Voce 1a066ddfe42a: plain Italian empty states; the English card reasons
    // stay in the API response, never on screen.
    fact('Telefono', card?.phone?.available === true && card.phone.value
      ? String(card.phone.value)
      : 'Nessun telefono collegato');
    fact('Stato', statusLabel(card?.status?.value));
    // Voce 1a066ddfe42a, P2 di review: «nessuna attività» è definitivo solo a
    // prove complete (le tre sezioni leggibili con conteggio esatto a zero),
    // altrimenti l'italiano resta onesto sulle verifiche mancanti.
    box.appendChild(el('p', 'bo-muted', statusMicrocopy(card, profile)));
    const active = card?.activePackage;
    const activeItems = active?.available === true && Array.isArray(active.active) ? active.active : null;
    if (activeItems && activeItems.length > 0) {
      for (const item of activeItems) {
        const itemStatus = packageStatusLabel(item?.status);
        const itemName = typeof item?.name === 'string' && item.name !== '' ? item.name : 'pacchetto';
        fact('Pacchetto', itemStatus ? `${itemName} (${itemStatus})` : itemName);
      }
    } else if (active?.available === true && active.truncated !== true && active.countIsComplete !== false) {
      // A complete readable page with no active row: honestly none.
      // Anything else (not composed, truncated, a floor count) hides the line
      // instead of printing the English reason or a false "none".
      box.appendChild(el('p', 'bo-muted', 'Nessun pacchetto attivo'));
    }
  }

  const ENRICHED_FIELD_LABELS = Object.freeze({
    firstName: 'Nome', lastName: 'Cognome', role: 'Ruolo', companyName: 'Azienda', phone: 'Telefono',
  });
  const ENRICHMENT_SOURCE_LABELS = Object.freeze({
    'google-contacts': 'Contatti Google', 'email-signature': 'firma email',
  });

  function enriched(box, enrichment, reload) {
    // BO-F4-03, ref "05 Scheda cliente": every enriched datum cites the free
    // source that filled it and its observation date; an opted-out customer
    // reads as opted out, never as empty; no row without a recorded source
    // is ever shown. Values are text, never markup.
    // Voce 59def6cb805d (C13): the ghost `Aggiorna` button re-reads the
    // enrichment through the same operation the card load uses and reports
    // through the shell toast — `Dati aggiornati` when the re-read changed
    // the section, `Nessun dato nuovo` when it did not. A failed re-read is
    // the Italian retry sentence, and the section keeps its previous rows.
    box.appendChild(el('h4', undefined, "Arricchito dall'AI"));
    if (typeof reload === 'function') {
      const refresh = el('button', 'bo-scheda-refresh', 'Aggiorna');
      refresh.setAttribute('type', 'button');
      refresh.setAttribute('data-action', 'refresh-enrichment');
      let busy = false;
      refresh.addEventListener('click', async () => {
        if (busy) return;
        busy = true;
        try {
          const fresh = await reload();
          const before = JSON.stringify([enrichment?.optedOut ?? null, enrichment?.items ?? null]);
          const after = JSON.stringify([fresh?.optedOut ?? null, fresh?.items ?? null]);
          while (box.firstChild) box.removeChild(box.firstChild);
          enriched(box, fresh, reload);
          toast(before === after ? 'Nessun dato nuovo' : 'Dati aggiornati');
        } catch (error) {
          toast(humanReadError(error, { failed: 'Qualcosa non ha funzionato. Riprova tra poco.' }), true);
        } finally {
          busy = false;
        }
      });
      box.appendChild(refresh);
    }
    const items = Array.isArray(enrichment?.items) ? enrichment.items : null;
    if (items === null) {
      box.appendChild(el('p', 'bo-muted', 'non disponibile: dati arricchiti non leggibili per questo cliente'));
      return;
    }
    if (enrichment?.optedOut) {
      const when = dateParts(enrichment.optedOut.optedOutAt);
      box.appendChild(el('p', 'bo-muted',
        `arricchimento disattivato${when ? ` il ${when}` : ''} (opt-out): nessun nuovo dato verrà salvato`));
    }
    if (items.length === 0) {
      box.appendChild(el('p', 'bo-muted', 'nessun dato arricchito registrato per questo cliente'));
      return;
    }
    for (const item of items) {
      const label = ownLabel(ENRICHED_FIELD_LABELS, String(item?.field ?? '')) ?? String(item?.field ?? 'dato');
      const source = ownLabel(ENRICHMENT_SOURCE_LABELS, String(item?.source ?? '')) ?? String(item?.source ?? 'fonte non registrata');
      const when = dateParts(item?.observedAt);
      box.appendChild(el('p', 'bo-scheda-enriched',
        `${label}: ${String(item?.value ?? '—')} (fonte: ${source}${when ? ` · ${when}` : ''})`));
    }
  }

  function timelineBox(box, timeline) {
    // Voce 59def6cb805d (C14): the prototype names this section, not the
    // record kind behind it.
    box.appendChild(el('h4', undefined, 'Tutti i contatti'));
    const entries = Array.isArray(timeline?.entries?.items) ? timeline.entries.items : [];
    const channels = [...new Set(entries.map((item) => String(item?.channel ?? '')).filter((channel) => channel !== ''))];
    const chips = el('p', 'bo-scheda-chips');
    const drawChips = () => {
      while (chips.firstChild) chips.removeChild(chips.firstChild);
      for (const key of ['all', ...channels]) {
        const chip = el('button', undefined, key === 'all' ? 'Tutti' : channelLabel(key));
        chip.setAttribute('data-channel', key);
        if (channelFilter === key) chip.setAttribute('data-active', 'true');
        chip.addEventListener('click', () => {
          channelFilter = key;
          drawChips();
          drawList();
        });
        chips.appendChild(chip);
      }
    };
    const list = el('div', 'bo-scheda-timeline');
    const drawList = () => {
      while (list.firstChild) list.removeChild(list.firstChild);
      const visible = entries.filter((item) => channelFilter === 'all' || String(item?.channel ?? '') === channelFilter);
      if (visible.length === 0) {
        // Voce 59def6cb805d (C27): the exact empty state of the prototype,
        // never a technical sentence.
        list.appendChild(el('p', 'bo-scheda-empty-title', 'Nessun messaggio qui'));
        list.appendChild(el('p', 'bo-muted', 'Prova un altro canale oppure scrivi il primo messaggio qui sotto.'));
        return;
      }
      const todayKey = romeDayKey(Date.now());
      let currentDay = null;
      for (const item of visible) {
        // Voce 1a066ddfe42a: group and label by the readable Rome day.
        // Voce 59def6cb805d (C16): the day reads uppercase, like the
        // prototype (`LUNEDÌ 20 OTTOBRE 2026`), with the `OGGI · ` prefix on
        // the passages of today.
        const occurredMs = Date.parse(String(item?.occurredAt ?? ''));
        const dayKey = romeDayKey(occurredMs);
        const day = (dayParts(item?.occurredAt) ?? 'senza data').toUpperCase();
        const dayLabel = dayKey !== null && dayKey === todayKey ? `OGGI · ${day}` : day;
        if (dayLabel !== currentDay) {
          currentDay = dayLabel;
          list.appendChild(el('h5', 'bo-scheda-day', dayLabel));
        }
        const row = el('div', 'bo-scheda-entry');
        row.setAttribute('data-entry', String(item?.id ?? ''));
        const channelKey = String(item?.channel ?? '').trim().toLowerCase();
        const known = Object.hasOwn(CARD_CHANNEL_MARKS, channelKey);
        row.appendChild(el('span', `bo-scheda-chan bo-tile-${known ? channelKey : 'other'}`, known ? CARD_CHANNEL_MARKS[channelKey] : '·'));
        const isOutbound = String(item?.direction ?? '') === 'outbound';
        const who = isOutbound
          ? (isHumanHandle(item?.teamAuthorId) ? `inviato da ${String(item.teamAuthorId).trim()}` : 'inviato dal team')
          : (item?.remoteHandle ? `da ${item.remoteHandle}` : 'ricevuto');
        // Voce 59def6cb805d (C17): the day already heads the group, so the
        // card shows the hour only (`<hh:mm>`) beside channel and direction.
        const when = timeParts(item?.occurredAt);
        row.appendChild(el('p', 'bo-scheda-entry-head',
          when ? `${channelLabel(item?.channel)} · ${who} · ${when}` : `${channelLabel(item?.channel)} · ${who}`));
        if (item?.entry === 'call') {
          // Voce 59def6cb805d (C19): the duration reads `<m:ss>`; with no
          // audio URL in the data no player is rendered (never a dead one).
          const dur = durationParts(item?.durationSec);
          row.appendChild(el('p', undefined,
            dur ? `chiamata ${isOutbound ? 'in uscita' : 'in entrata'} · ${dur}` : `chiamata ${isOutbound ? 'in uscita' : 'in entrata'}`));
        } else if (typeof item?.body === 'string' && item.body !== '') {
          row.appendChild(el('p', undefined, item.body));
        }
        // Voce 59def6cb805d (C17): the sync row of the prototype,
        // `←/→ <canale> · <stato>`.
        row.appendChild(el('p', 'bo-scheda-sync',
          `${syncArrow(item?.direction)}${channelLabel(item?.channel)} · ${syncLabel(item?.sync)}`));
        list.appendChild(row);
      }
    };
    drawChips();
    box.appendChild(chips);
    drawList();
    box.appendChild(list);
  }

  function nextSteps(box, profile) {
    // Voce 1a066ddfe42a: an uncomposed work package hides the whole block
    // instead of printing its English reason.
    if (profile?.workTasks?.available !== true) return false;
    box.appendChild(el('h4', undefined, 'Prossimi passi'));
    const items = Array.isArray(profile.workTasks.items) ? profile.workTasks.items : [];
    const tasks = items.filter((item) => item?.status !== 'done' && item?.status !== 'completed');
    if (tasks.length === 0) {
      box.appendChild(el('p', 'bo-muted', 'nessun passo aperto'));
      return true;
    }
    for (const task of tasks.slice(0, 5)) {
      const name = typeof task?.name === 'string' && task.name !== '' ? task.name : 'attività';
      box.appendChild(el('p', 'bo-scheda-step', name));
    }
    return true;
  }

  function offer(box, profile) {
    // Voce cc525cd6a3c5: the offer panel shows one commercial line for THIS
    // customer only — the profile behind it is already scoped to the customer
    // (contact-scoped records never leak onto a company-mate's card), so the
    // first row here is this customer's own. A quote carries no human name of
    // its own, so it reads after the opportunity it was made for; the state
    // reads in Italian, never a raw English status or a bare record id.
    // Voce 1a066ddfe42a: uncomposed offer packages hide the whole block;
    // a composed-but-empty one reads «Nessuna offerta firmata».
    const quotes = profile?.quotes?.available === true && Array.isArray(profile.quotes.items) ? profile.quotes.items : null;
    const opportunities = profile?.opportunities?.available === true && Array.isArray(profile.opportunities.items)
      ? profile.opportunities.items : null;
    if (quotes === null && opportunities === null) return false;
    box.appendChild(el('h4', undefined, 'Offerta'));
    const fromQuote = (quotes ?? []).length > 0;
    const first = fromQuote ? quotes[0] : ((opportunities ?? [])[0] ?? null);
    if (!first) {
      // No linked offer: only when BOTH commercial sections were readable
      // (even empty) the customer plainly has none. An empty opportunities
      // read never proves there are no quotes when the quotes read itself
      // failed — the unavailable reason reads instead, never a confirmed
      // absence.
      if (quotes !== null && opportunities !== null) {
        box.appendChild(el('p', 'bo-muted', 'Nessuna offerta firmata'));
        return true;
      }
      // The unavailable reason stays in the API response and the logs, never
      // on screen: production reasons are English system phrases, and the
      // scheda reads only fixed Italian (voce 1a066ddf).
      box.appendChild(el('p', 'bo-muted', 'offerte non disponibili'));
      return true;
    }
    const rawName = fromQuote ? (first?.opportunityName ?? first?.name) : first?.name;
    const name = typeof rawName === 'string' && rawName !== '' ? rawName : 'offerta';
    const offerStatus = offerStatusLabel(first?.status);
    // Name and state read as one line for assistive tech and tests («nome · stato»); on screen the state is the prototype's pill.
    const line = el('p', 'bo-scheda-offer');
    line.appendChild(el('span', 'bo-scheda-offer-name', name));
    if (offerStatus) {
      line.appendChild(el('span', 'bo-scheda-sep', ' · '));
      line.appendChild(el('span', 'bo-scheda-offer-state', offerStatus));
    }
    box.appendChild(line);
    return true;
  }

  // Terminal booking states, mirroring APPOINTMENT_TERMINAL in
  // packages/appointments/src/appointments.js (this view ships as a static
  // file, so it names the set instead of importing it).
  const TERMINAL_APPOINTMENT = Object.freeze(['done', 'no-show', 'cancelled']);

  function nextAppointment(box, timeline) {
    box.appendChild(el('h4', undefined, 'Prossimo appuntamento'));
    const items = Array.isArray(timeline?.appointments?.items) ? timeline.appointments.items : [];
    // readSchedule lists every booking soonest-first, past and terminal rows
    // included: the next appointment is the soonest booking that can still
    // happen — a non-terminal row starting now or later.
    const nowMs = Date.now();
    const upcoming = items.filter((item) => {
      if (TERMINAL_APPOINTMENT.includes(String(item?.status ?? ''))) return false;
      const startsMs = Date.parse(String(item?.startsAt ?? ''));
      return Number.isFinite(startsMs) && startsMs >= nowMs;
    });
    if (upcoming.length === 0) {
      box.appendChild(el('p', 'bo-muted', 'nessun appuntamento prenotato'));
      return;
    }
    // Soonest slot first, like the timeline projection. Voce 1a066ddfe42a:
    // the slot reads as a plain Italian date — no ISO instants, no member id.
    const next = upcoming[0];
    const start = dateTimeParts(next?.startsAt);
    if (!start) {
      box.appendChild(el('p', 'bo-scheda-appt', 'data non disponibile'));
      return;
    }
    const endTime = timeParts(next?.endsAt);
    const sameDay = dateParts(next?.startsAt) === dateParts(next?.endsAt);
    const when = endTime && endTime !== timeParts(next?.startsAt)
      ? (sameDay ? `${start}–${endTime}` : `${start} – ${dateTimeParts(next?.endsAt)}`)
      : start;
    box.appendChild(el('p', 'bo-scheda-appt', when));
  }

  const SIGNAL_LABELS = Object.freeze({
    budget: 'Budget', timing: 'Tempi', interest: 'Interesse', doubt: 'Dubbi',
  });

  function latestSummarized(calls) {
    const items = Array.isArray(calls?.calls) ? calls.calls : [];
    return items.find((call) => typeof call?.summary === 'string' && call.summary !== '') ?? null;
  }

  function aiSummary(box, calls) {
    // BO-F1-08: the per-customer AI summary is the latest summarized call.
    // Without a recorded source it stays unavailable — never an invented one.
    // Voce 59def6cb805d (C23): the prototype's `<quando aggiornato>` row —
    // when the summarized call was recorded, never an invented freshness.
    box.appendChild(el('h4', undefined, '✦ Riepilogo AI'));
    const latest = latestSummarized(calls);
    if (!latest) {
      box.appendChild(el('p', 'bo-muted', 'non disponibile: nessun riepilogo registrato per questo cliente'));
      return;
    }
    const updated = dateTimeParts(latest?.recordedAt);
    if (updated) box.appendChild(el('p', 'bo-scheda-summary-when', `Aggiornato ${updated}`));
    box.appendChild(el('p', 'bo-scheda-summary', latest.summary));
  }

  function callsBox(box, calls) {
    // BO-F1-08, ref "05 Scheda cliente": signals (budget/tempi/interesse/
    // dubbi) with their transcript source, and the openable transcript.
    box.appendChild(el('h4', undefined, 'Chiamate'));
    const items = Array.isArray(calls?.calls) ? calls.calls : [];
    if (items.length === 0) {
      box.appendChild(el('p', 'bo-muted',
        calls === null || calls === undefined
          ? 'non disponibile: nessun dato di chiamata registrato per questo cliente'
          : 'nessuna chiamata registrata per questo cliente'));
      return;
    }
    const [latest, ...older] = items;
    const when = dateParts(latest?.recordedAt);
    box.appendChild(el('p', 'bo-scheda-call-head',
      `ultima chiamata${latest?.channel ? ` · ${channelLabel(latest.channel)}` : ''}${when ? ` · ${when}` : ''}`));
    if (typeof latest?.summary === 'string' && latest.summary !== '') {
      box.appendChild(el('p', 'bo-scheda-summary', latest.summary));
    }
    const signals = Array.isArray(latest?.signals) ? latest.signals : [];
    if (signals.length > 0) {
      const list = el('ul', 'bo-scheda-signals');
      for (const signal of signals) {
        const label = ownLabel(SIGNAL_LABELS, String(signal?.type ?? '')) ?? String(signal?.type ?? 'segnale');
        // A purged transcript keeps its signal rows without the quoted words:
        // the label stays as proof of what was found, never an empty quote.
        const line = typeof signal?.excerpt === 'string' && signal.excerpt !== ''
          ? el('li', undefined, `${label}: “${signal.excerpt}”`)
          : el('li', undefined, `${label} (citazione cancellata: retention scaduta)`);
        list.appendChild(line);
      }
      box.appendChild(list);
    } else {
      box.appendChild(el('p', 'bo-muted', 'nessun segnale registrato per questa chiamata'));
    }
    const transcript = latest?.transcript;
    if (transcript?.available === true) {
      // Voce 59def6cb805d (C20): the prototype's toggle with its exact
      // texts — one speaker row per transcript line. The rows mount only
      // while open, so a closed transcript shows nothing of its content.
      const toggle = el('button', 'bo-scheda-transcript-toggle', 'Mostra trascrizione');
      toggle.setAttribute('type', 'button');
      toggle.setAttribute('aria-expanded', 'false');
      const body = el('div', 'bo-scheda-transcript');
      toggle.addEventListener('click', () => {
        const open = toggle.getAttribute('aria-expanded') !== 'true';
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        toggle.textContent = open ? 'Nascondi trascrizione' : 'Mostra trascrizione';
        while (body.firstChild) body.removeChild(body.firstChild);
        if (open) {
          for (const line of String(transcript.text ?? '').split('\n')) {
            if (line.trim() === '') continue;
            body.appendChild(el('p', 'bo-scheda-transcript-row', line));
          }
        }
      });
      box.appendChild(toggle);
      box.appendChild(body);
    } else {
      box.appendChild(el('p', 'bo-muted',
        typeof transcript?.reason === 'string' && transcript.reason !== ''
          ? `trascrizione ${transcript.reason}`
          : 'trascrizione non disponibile per questa chiamata'));
    }
    if (older.length > 0) {
      box.appendChild(el('p', 'bo-muted', `+ ${older.length} chiamate precedenti`));
    }
  }

  async function renderCard(resource, id) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    channelFilter = 'all';
    let loaded;
    try {
      loaded = await load(resource, id);
    } catch (error) {
      const panel = el('div', 'bo-scheda-error');
      panel.appendChild(el('h3', undefined, 'Scheda non disponibile'));
      panel.appendChild(el('p', 'bo-muted', humanReadError(error, {
        failed: 'La scheda non si è potuta leggere. Riprova più tardi.',
      })));
      mount.appendChild(panel);
      return;
    }
    const { card, timeline, profile, enrichment, calls } = loaded;
    // C13: the re-read behind `Aggiorna` — the same enriched route the load
    // uses, with the same honest 404. Anything else still rejects, so the
    // button toasts the Italian retry instead of inventing rows.
    const enrichedPath = `/api/customer-data/enriched/${encodeURIComponent(resource)}/${encodeURIComponent(id)}`;
    const reloadEnrichment = () => client.request(enrichedPath).catch((error) => {
      if (error && error.status === 404) return null;
      throw error;
    });
    const panel = el('div', 'bo-scheda');
    header(panel, card, resource, id);
    const grid = el('div', 'bo-scheda-grid');
    const left = el('div', 'bo-scheda-col');
    const center = el('div', 'bo-scheda-col');
    const right = el('div', 'bo-scheda-col');
    // Supervisor design pass: every section is its own card, like the
    // prototype; a section that hides itself (returns false) leaves no card.
    const section = (col, cls, fn, ...args) => {
      const box = el('section', `bo-scheda-card${cls ? ` ${cls}` : ''}`);
      const shown = fn(box, ...args);
      if (shown !== false && box.childNodes.length > 0) col.appendChild(box);
    };
    section(left, '', quickActions, card);
    section(left, '', linkedIdentities, profile);
    section(left, '', details, card, profile);
    section(left, '', enriched, enrichment, reloadEnrichment);
    section(center, 'bo-scheda-card-timeline', timelineBox, timeline);
    section(right, 'bo-scheda-ai', aiSummary, calls);
    section(right, '', callsBox, calls);
    section(right, '', nextSteps, profile);
    section(right, 'bo-scheda-card-offer', offer, profile);
    section(right, 'bo-scheda-card-appt', nextAppointment, timeline);
    grid.appendChild(left);
    grid.appendChild(center);
    grid.appendChild(right);
    panel.appendChild(grid);
    mount.appendChild(panel);
  }

  return { renderCard };
}
