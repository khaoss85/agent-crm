// @ts-check

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
 *   details, "Arricchito dall'AI" with its source;
 * - center: the channel timeline, every passage with channel, direction and
 *   sync state, filterable per channel;
 * - right: AI summary, next steps, offer, next appointment.
 *
 * Every panel the composed packages cannot feed answers "not available" with
 * its reason — never an empty value that could be mistaken for "none". The
 * reply composer (BO-F1-07) and the call summary with transcript (BO-F1-08)
 * are deliberately not here: they are their own stories with their own
 * gates (approval, consent).
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

const channelLabel = (channel) => CHANNEL_LABELS[String(channel ?? '').toLowerCase()] ?? String(channel ?? 'canale');
const syncLabel = (sync) => SYNC_LABELS[String(sync ?? '').toLowerCase()] ?? String(sync ?? 'stato ignoto');

/** @param {{doc: any, mount: any, client: any, navigate?: (hash: string) => void}} deps */
export function createCustomerCardView(deps) {
  const { doc, mount, navigate = () => {} } = deps;
  const { client } = deps;
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.setAttribute('class', className);
    if (text !== undefined && text !== null) node.textContent = String(text); // safe: text, never HTML
    return node;
  };
  const link = (href, text, action) => {
    const node = el('a', undefined, text);
    node.setAttribute('href', href);
    if (action) node.setAttribute('data-action', action);
    return node;
  };

  let channelFilter = 'all';

  async function load(resource, id) {
    const encoded = `${encodeURIComponent(resource)}/${encodeURIComponent(id)}`;
    const [card, timeline, profile] = await Promise.all([
      client.request(`/api/customer-hub/card/${encoded}`),
      client.request(`/api/customer-hub/timeline/${encoded}`),
      client.request(`/api/customer-data/profile/${encoded}`),
    ]);
    return { card, timeline, profile };
  }

  function header(panel, card, resource, id) {
    const back = link('#/customer-data', '← Clienti', 'back-to-clienti');
    panel.appendChild(back);
    panel.appendChild(el('h3', 'bo-scheda-name', card?.name ?? 'Scheda cliente'));
    const sub = [];
    if (card?.company?.name) sub.push(card.company.name);
    if (card?.status?.value) sub.push(card.status.value);
    if (sub.length) panel.appendChild(el('p', 'bo-scheda-sub', sub.join(' · ')));
    void navigate;
    void resource;
    void id;
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

  function enriched(box) {
    // Q-G1 is still an open owner question (docs/backoffice/OPEN-QUESTIONS.md):
    // enriched fields need a recorded source, a date and an opt-out before
    // they may feed the scheda on real data. No per-customer enrichment source
    // exists in the framework yet (BO-F4-03 owns it), so the section states
    // its rule instead of inventing a value.
    box.appendChild(el('h4', undefined, "Arricchito dall'AI"));
    box.appendChild(el('p', 'bo-muted',
      'non disponibile: nessun dato arricchito registrato per questo cliente (fonte, data e opt-out sono obbligatori)'));
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
    box.appendChild(el('h4', undefined, 'Offerta'));
    const quotes = profile?.quotes?.available === true && Array.isArray(profile.quotes.items) ? profile.quotes.items : [];
    const opportunities = profile?.opportunities?.available === true && Array.isArray(profile.opportunities.items)
      ? profile.opportunities.items : [];
    const first = quotes[0] ?? opportunities[0] ?? null;
    if (!first) {
      const reason = profile?.quotes?.available === true
        ? 'nessuna offerta registrata'
        : (profile?.quotes?.reason ?? 'offerte non disponibili');
      box.appendChild(el('p', 'bo-muted', reason));
      return;
    }
    box.appendChild(el('p', 'bo-scheda-offer', `${first?.name ?? first?.id ?? 'offerta'}${first?.status ? ` · ${first.status}` : ''}`));
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

  function aiSummary(box) {
    // The per-customer AI summary arrives with the call intelligence stories
    // (BO-F1-08, BO-F4-03): without a recorded source it stays unavailable.
    box.appendChild(el('h4', undefined, 'Riepilogo AI'));
    box.appendChild(el('p', 'bo-muted', 'non disponibile: nessun riepilogo registrato per questo cliente'));
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
      panel.appendChild(el('p', 'bo-muted', error?.message ?? 'la scheda non può essere letta'));
      mount.appendChild(panel);
      return;
    }
    const { card, timeline, profile } = loaded;
    const panel = el('div', 'bo-scheda');
    header(panel, card, resource, id);
    const grid = el('div', 'bo-scheda-grid');
    const left = el('div', 'bo-scheda-col');
    const center = el('div', 'bo-scheda-col');
    const right = el('div', 'bo-scheda-col');
    quickActions(left, card);
    linkedIdentities(left, profile);
    details(left, card);
    enriched(left);
    timelineBox(center, timeline);
    aiSummary(right);
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
