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
 * Every panel the composed packages cannot feed answers "not available" with
 * its reason — never an empty value that could be mistaken for "none". The
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
 * Commercial state in the operator's words. Quotes (`draft`,
 * `pending_approval`, `approved`, `rejected`) and the opportunity fallback
 * stages share one table; anything unknown reads back raw, never blank.
 */
const OFFER_STATUS_LABELS = Object.freeze({
  draft: 'bozza',
  pending_approval: 'in attesa di approvazione',
  approved: 'approvata',
  rejected: 'rifiutata',
  discovery: 'scoperta',
  qualification: 'qualificazione',
  proposal: 'proposta',
  approval_pending: 'in attesa di approvazione',
  negotiation: 'trattativa',
  won: 'vinta',
  lost: 'persa',
});

const channelLabel = (channel) => CHANNEL_LABELS[String(channel ?? '').toLowerCase()] ?? String(channel ?? 'canale');
const syncLabel = (sync) => SYNC_LABELS[String(sync ?? '').toLowerCase()] ?? String(sync ?? 'stato ignoto');
const offerStatusLabel = (status) => {
  if (status === null || status === undefined || status === '') return null;
  return OFFER_STATUS_LABELS[String(status).toLowerCase()] ?? String(status);
};

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
    titles.appendChild(el('span', 'bo-scheda-badge', card?.status?.value ?? 'contatto'));
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
      row.appendChild(el('span', 'bo-scheda-disabled', card?.phone?.reason ?? 'telefono non disponibile'));
    }
    if (typeof card?.email === 'string' && card.email !== '') {
      row.appendChild(link(`mailto:${card.email}`, `Scrivi a ${card.email}`, 'mail-customer'));
    } else {
      row.appendChild(el('span', 'bo-scheda-disabled', 'email non disponibile'));
    }
    box.appendChild(row);
  }

  function linkedIdentities(box, profile) {
    box.appendChild(el('h4', undefined, 'Identità collegate'));
    const cluster = profile?.canonicalIdentity;
    if (!cluster) {
      box.appendChild(el('p', 'bo-muted', 'identità non leggibili: il profilo non è disponibile'));
      return;
    }
    const members = Array.isArray(cluster.members) ? cluster.members : [];
    box.appendChild(el('p', 'bo-muted',
      cluster.linked === true
        ? `${members.length} record uniti da una persona`
        : 'un solo record: nessuna unione registrata'));
    if (typeof cluster.note === 'string' && cluster.note !== '') {
      box.appendChild(el('p', 'bo-muted', cluster.note));
    }
    for (const member of members) {
      const line = el('p', 'bo-scheda-identity');
      line.setAttribute('data-member', `${member?.resource ?? ''}:${member?.id ?? ''}`);
      line.appendChild(el('strong', undefined, `${member?.resource ?? '?'} ${member?.id ?? '?'}`));
      if (member?.role) line.appendChild(el('span', undefined, ` · ${member.role}`));
      // BO-F1-06: the motivation the decider recorded, with who and when —
      // never a bare id the operator has to trust.
      if (typeof member?.reason === 'string' && member.reason !== '') {
        line.appendChild(el('span', undefined, ` — ${member.reason}`));
      } else {
        line.appendChild(el('span', 'bo-muted', ' — motivazione non registrata'));
      }
      if (member?.decidedBy?.id) {
        const when = typeof member?.decidedAt === 'string' && member.decidedAt !== '' ? ` il ${member.decidedAt}` : '';
        line.appendChild(el('span', 'bo-muted', ` (da ${member.decidedBy.id}${when})`));
      }
      box.appendChild(line);
    }
  }

  function details(box, card) {
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
    fact('Telefono', card?.phone?.available === true ? String(card.phone.value) : (card?.phone?.reason ?? 'non disponibile'));
    fact('Stato', card?.status?.value ?? 'contatto');
    if (card?.status?.reason) box.appendChild(el('p', 'bo-muted', card.status.reason));
    const active = card?.activePackage;
    if (active?.available === true && Array.isArray(active.active) && active.active.length > 0) {
      for (const item of active.active) fact('Pacchetto', `${item?.name ?? item?.id ?? 'pacchetto'}${item?.status ? ` (${item.status})` : ''}`);
    } else {
      box.appendChild(el('p', 'bo-muted', active?.reason ?? 'pacchetto non disponibile'));
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
      const when = String(enrichment.optedOut.optedOutAt ?? '').slice(0, 10);
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
      const when = String(item?.observedAt ?? '').slice(0, 10);
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
        const day = String(item?.occurredAt ?? '').slice(0, 10) || 'senza data';
        if (day !== currentDay) {
          currentDay = day;
          list.appendChild(el('h5', 'bo-scheda-day', day));
        }
        const row = el('div', 'bo-scheda-entry');
        row.setAttribute('data-entry', String(item?.id ?? ''));
        const isOutbound = String(item?.direction ?? '') === 'outbound';
        const who = isOutbound
          ? (item?.teamAuthorId ? `inviato da ${item.teamAuthorId}` : 'inviato dal team')
          : (item?.remoteHandle ? `da ${item.remoteHandle}` : 'ricevuto');
        row.appendChild(el('p', 'bo-scheda-entry-head',
          `${channelLabel(item?.channel)} · ${who} · ${String(item?.occurredAt ?? '')}`));
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
    box.appendChild(el('h4', undefined, 'Prossimi passi'));
    const tasks = profile?.workTasks?.available === true && Array.isArray(profile.workTasks.items)
      ? profile.workTasks.items.filter((item) => item?.status !== 'done' && item?.status !== 'completed')
      : null;
    if (tasks === null) {
      box.appendChild(el('p', 'bo-muted', profile?.workTasks?.reason ?? 'attività non disponibili'));
      return;
    }
    if (tasks.length === 0) {
      box.appendChild(el('p', 'bo-muted', 'nessun passo aperto'));
      return;
    }
    for (const task of tasks.slice(0, 5)) {
      box.appendChild(el('p', 'bo-scheda-step', `${task?.name ?? task?.id ?? 'attività'}${task?.status ? ` (${task.status})` : ''}`));
    }
  }

  function offer(box, profile) {
    // The offer panel shows one commercial line for THIS customer only: the
    // profile behind it is already scoped to the customer (contact-scoped
    // records never leak onto a company-mate's card), so the first row here
    // is this customer's own. A quote carries no human name of its own, so
    // it reads after the opportunity it was made for; the state reads in
    // Italian, never a raw English status.
    box.appendChild(el('h4', undefined, 'Offerta'));
    const quotes = profile?.quotes?.available === true && Array.isArray(profile.quotes.items) ? profile.quotes.items : [];
    const opportunities = profile?.opportunities?.available === true && Array.isArray(profile.opportunities.items)
      ? profile.opportunities.items : [];
    const fromQuote = quotes.length > 0;
    const first = fromQuote ? quotes[0] : (opportunities[0] ?? null);
    if (!first) {
      // No linked offer: when the hop itself was readable (either section
      // available, even empty) the customer plainly has none; otherwise the
      // commercial records cannot be read from here — say so with the reason.
      const canRead = profile?.quotes?.available === true || profile?.opportunities?.available === true;
      box.appendChild(el('p', 'bo-muted', canRead
        ? 'nessuna offerta registrata'
        : (profile?.quotes?.reason ?? profile?.opportunities?.reason ?? 'offerte non disponibili')));
      return;
    }
    const name = fromQuote
      ? (first?.opportunityName ?? first?.name ?? null)
      : (first?.name ?? null);
    const status = offerStatusLabel(first?.status);
    box.appendChild(el('p', 'bo-scheda-offer', `${name ?? first?.id ?? 'offerta'}${status ? ` · ${status}` : ''}`));
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
    // Soonest slot first, like the timeline projection.
    const next = upcoming[0];
    const when = `${next?.startsAt ?? ''}${next?.endsAt ? `–${next.endsAt}` : ''}`;
    box.appendChild(el('p', 'bo-scheda-appt', `${when}${next?.teamMemberId ? ` · ${next.teamMemberId}` : ''}`));
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
    const when = String(latest?.recordedAt ?? '').slice(0, 10);
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
    details(left, card);
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
