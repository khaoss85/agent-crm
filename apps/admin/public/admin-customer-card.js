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
  tiktok: 'TikTok',
  email: 'Email',
  gmail: 'Gmail',
  sms: 'SMS',
  phone: 'Telefono',
  voice: 'Telefono',
  tel: 'Telefono',
  mobile: 'Telefono',
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

const STATUS_LABELS = Object.freeze({ cliente: 'Cliente', contatto: 'Contatto' });
const statusLabel = (value) => STATUS_LABELS[String(value ?? '').toLowerCase()]
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
const offerStatusLabel = (status) => OFFER_STATUS_LABELS[String(status ?? '').toLowerCase()] ?? null;

const PACKAGE_STATUS_LABELS = Object.freeze({ active: 'attivo' });
const packageStatusLabel = (status) => PACKAGE_STATUS_LABELS[String(status ?? '').toLowerCase()] ?? null;

const RESOURCE_LABELS = Object.freeze({ contact: 'Contatto', company: 'Azienda' });
const resourceLabel = (resource) => RESOURCE_LABELS[String(resource ?? '').toLowerCase()] ?? 'Scheda';

const ROLE_LABELS = Object.freeze({ canonical: 'scheda principale', alias: 'scheda collegata' });
const roleLabel = (role) => ROLE_LABELS[String(role ?? '').toLowerCase()] ?? null;
const channelLabel = (channel) => CHANNEL_LABELS[String(channel ?? '').toLowerCase()] ?? String(channel ?? 'canale');
const syncLabel = (sync) => SYNC_LABELS[String(sync ?? '').toLowerCase()] ?? String(sync ?? 'stato ignoto');

/**
 * @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void,
 *   spaceId?: string | (() => (string | null | undefined))}} deps
 * `spaceId` is the shell's active space (string or thunk): the calls read
 * stays space-explicit, never inferred. Without it the calls section stays
 * honestly unavailable.
 */
export function createCustomerCardView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client } = deps;
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
    // never an invented meta. The data operation is the follow-up.
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
    titles.appendChild(el('span', 'bo-scheda-badge', statusLabel(card?.status?.value)));
    head.appendChild(titles);
    panel.appendChild(head);
    if (card?.company?.name) panel.appendChild(el('p', 'bo-scheda-sub', card.company.name));
  }

  function quickActions(box, card) {
    box.appendChild(el('h4', undefined, 'Azioni rapide'));
    const row = el('p', 'bo-scheda-actions');
    if (card?.phone?.available === true && card.phone.value) {
      const dialable = String(card.phone.value).replaceAll(/[^\d+]/g, '');
      const call = link(`tel:${dialable === '' ? card.phone.value : dialable}`, `Chiama ${card.phone.value}`, 'call-customer');
      row.appendChild(call);
    } else {
      // Voce 1a066ddfe42a: the API reason stays in the response, never on screen.
      row.appendChild(el('span', 'bo-scheda-disabled', 'Nessun telefono collegato'));
    }
    if (typeof card?.email === 'string' && card.email !== '') {
      row.appendChild(link(`mailto:${card.email}`, `Scrivi a ${card.email}`, 'mail-customer'));
    } else {
      row.appendChild(el('span', 'bo-scheda-disabled', 'email non disponibile'));
    }
    box.appendChild(row);
  }

  function linkedIdentities(box, profile) {
    // Voce 1a066ddfe42a: every identity reads as plain Italian — a resource
    // label and a role label, never a bare id or UUID. The English cluster
    // note stays in the API response, never on screen.
    box.appendChild(el('h4', undefined, 'Identità collegate'));
    const cluster = profile?.canonicalIdentity;
    if (!cluster) {
      box.appendChild(el('p', 'bo-muted', 'identità non leggibili: il profilo non è disponibile'));
      return;
    }
    const members = Array.isArray(cluster.members) ? cluster.members : [];
    box.appendChild(el('p', 'bo-muted',
      cluster.linked === true
        ? `${members.length} schede unite da una persona`
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
  }

  function details(box, card, profile) {
    box.appendChild(el('h4', undefined, 'Dettagli'));
    const fact = (label, value) => {
      const row = el('p', 'bo-scheda-fact');
      row.appendChild(el('span', 'bo-scheda-fact-label', `${label}: `));
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

  function enriched(box, enrichment) {
    // BO-F4-03, ref "05 Scheda cliente": every enriched datum cites the free
    // source that filled it and its observation date; an opted-out customer
    // reads as opted out, never as empty; no row without a recorded source
    // is ever shown. Values are text, never markup.
    box.appendChild(el('h4', undefined, "Arricchito dall'AI"));
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
      const label = ENRICHED_FIELD_LABELS[String(item?.field ?? '')] ?? String(item?.field ?? 'dato');
      const source = ENRICHMENT_SOURCE_LABELS[String(item?.source ?? '')] ?? String(item?.source ?? 'fonte non registrata');
      const when = dateParts(item?.observedAt);
      box.appendChild(el('p', 'bo-scheda-enriched',
        `${label}: ${String(item?.value ?? '—')} (fonte: ${source}${when ? ` · ${when}` : ''})`));
    }
  }

  function timelineBox(box, timeline) {
    box.appendChild(el('h4', undefined, 'Cronologia'));
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
        list.appendChild(el('p', 'bo-muted', channelFilter === 'all'
          ? 'nessun passaggio registrato su nessun canale'
          : `nessun passaggio su ${channelLabel(channelFilter)}`));
        return;
      }
      let currentDay = null;
      for (const item of visible) {
        // Voce 1a066ddfe42a: group and label by the readable Rome day.
        const day = dayParts(item?.occurredAt) ?? 'senza data';
        if (day !== currentDay) {
          currentDay = day;
          list.appendChild(el('h5', 'bo-scheda-day', day));
        }
        const row = el('div', 'bo-scheda-entry');
        row.setAttribute('data-entry', String(item?.id ?? ''));
        const isOutbound = String(item?.direction ?? '') === 'outbound';
        const who = isOutbound
          ? (isHumanHandle(item?.teamAuthorId) ? `inviato da ${String(item.teamAuthorId).trim()}` : 'inviato dal team')
          : (item?.remoteHandle ? `da ${item.remoteHandle}` : 'ricevuto');
        const when = dateTimeParts(item?.occurredAt);
        row.appendChild(el('p', 'bo-scheda-entry-head',
          when ? `${channelLabel(item?.channel)} · ${who} · ${when}` : `${channelLabel(item?.channel)} · ${who}`));
        if (item?.entry === 'call') {
          const dur = item?.durationSec != null ? ` · ${item.durationSec}s` : '';
          row.appendChild(el('p', undefined, `chiamata ${isOutbound ? 'in uscita' : 'in entrata'}${dur}`));
        } else if (typeof item?.body === 'string' && item.body !== '') {
          row.appendChild(el('p', undefined, item.body));
        }
        row.appendChild(el('p', 'bo-scheda-sync', syncLabel(item?.sync)));
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
    box.appendChild(el('p', 'bo-scheda-offer', offerStatus ? `${name} · ${offerStatus}` : name));
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
    box.appendChild(el('h4', undefined, 'Riepilogo AI'));
    const latest = latestSummarized(calls);
    if (!latest) {
      box.appendChild(el('p', 'bo-muted', 'non disponibile: nessun riepilogo registrato per questo cliente'));
      return;
    }
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
        const label = SIGNAL_LABELS[String(signal?.type ?? '')] ?? String(signal?.type ?? 'segnale');
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
      const openable = doc.createElement('details');
      const caption = doc.createElement('summary');
      caption.textContent = 'Trascrizione';
      openable.appendChild(caption);
      const body = doc.createElement('p');
      body.textContent = String(transcript.text ?? '');
      openable.appendChild(body);
      box.appendChild(openable);
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
    const panel = el('div', 'bo-scheda');
    header(panel, card, resource, id);
    const grid = el('div', 'bo-scheda-grid');
    const left = el('div', 'bo-scheda-col');
    const center = el('div', 'bo-scheda-col');
    const right = el('div', 'bo-scheda-col');
    quickActions(left, card);
    linkedIdentities(left, profile);
    details(left, card, profile);
    enriched(left, enrichment);
    timelineBox(center, timeline);
    aiSummary(right, calls);
    callsBox(right, calls);
    nextSteps(right, profile);
    offer(right, profile);
    nextAppointment(right, timeline);
    grid.appendChild(left);
    grid.appendChild(center);
    grid.appendChild(right);
    panel.appendChild(grid);
    mount.appendChild(panel);
  }

  return { renderCard };
}
