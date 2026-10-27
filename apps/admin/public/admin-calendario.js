// @ts-check

// Team calendar (BO-F3 \"07 Calendario\"): the week the team holds, the
// \"fissa con una frase\" draft box, the free-slot proposals and the manual
// booking form — over the declared appointments operations, never over a
// second store. Every value renders through textContent/setAttribute, never
// innerHTML, so hostile member identities, notes or subjects are inert text.
//
// Honest states, never a blank screen: when the appointments package is not
// composed the week panel says so (the route answers 404 and the nav voice
// names the story); when no member is named the week asks for at least one
// (a week for nobody would answer with the whole team's bookings); when
// nothing is held the week shows seven empty days, not an error. The human
// confirms every booking: propose plans, confirm creates, and a slot click
// only ever proposes — the confirm click is always the operator's own.
//
// Rome clock: every instant renders with timeZone 'Europe/Rome' through the
// Oggi helpers, never as UTC or ISO.

import { formatMinorUnits } from './admin-core.js';
import { romeDayKey, romeShortDay, romeTime } from './admin-oggi.js';
import { bindAdminMutations } from './admin-submission.js';
import { ACTIVE_SPACE_KEY } from './admin-shell.js';

/** Rome week (Monday..Sunday) containing `now`, as YYYY-MM-DD keys. */
export function romeWeekKeys(now = new Date()) {
  const instant = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const todayKey = romeDayKey(instant);
  if (!todayKey) return [];
  // Noon UTC of the Rome day is afternoon in Rome on the same calendar
  // day, so its UTC weekday is the Rome weekday — no DST arithmetic.
  const monday = new Date(`${todayKey}T12:00:00Z`);
  const dayIndex = (monday.getUTCDay() + 6) % 7;
  monday.setUTCDate(monday.getUTCDate() - dayIndex);
  const keys = [];
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(monday.getTime() + offset * 24 * 3600 * 1000);
    keys.push(day.toISOString().slice(0, 10));
  }
  return keys;
}

/**
 * ISO window covering a Rome week: the Rome Monday 00:00 is Sunday 22:00Z
 * (summer) or 23:00Z (winter), so a day of margin on each side keeps every
 * event of the Rome week inside whatever the offset is.
 * @param {Array<string>} weekKeys
 */
export function weekWindow(weekKeys) {
  if (!Array.isArray(weekKeys) || weekKeys.length === 0) return null;
  const first = Date.parse(`${weekKeys[0]}T00:00:00Z`);
  const last = Date.parse(`${weekKeys[weekKeys.length - 1]}T00:00:00Z`);
  if (Number.isNaN(first) || Number.isNaN(last)) return null;
  return {
    from: new Date(first - 24 * 3600 * 1000).toISOString(),
    to: new Date(last + 2 * 24 * 3600 * 1000).toISOString(),
  };
}

/**
 * Split a member filter line (\"marco, sara\") into identities.
 * @param {unknown} value
 */
export function parseMemberFilter(value) {
  if (typeof value !== 'string') return [];
  return [...new Set(
    value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== ''),
  )];
}

/** Week label for the nav (\"19 – 25 ott 2026\"), null when unparsable. */
export function weekLabel(weekKeys) {
  if (!Array.isArray(weekKeys) || weekKeys.length === 0) return null;
  const first = romeShortDay(`${weekKeys[0]}T12:00:00Z`);
  const last = romeShortDay(`${weekKeys[weekKeys.length - 1]}T12:00:00Z`);
  if (!first || !last) return null;
  // The short day labels carry no year, and a Rome week can straddle New
  // Year: name both years when they differ instead of pinning the first
  // key's year on the January days.
  const firstYear = String(weekKeys[0]).slice(0, 4);
  const lastYear = String(weekKeys[weekKeys.length - 1]).slice(0, 4);
  if (firstYear === lastYear) return `${first} – ${last} ${lastYear}`;
  return `${first} ${firstYear} – ${last} ${lastYear}`;
}

/** @param {any} doc @param {string} tag @param {{text?: string, className?: string, attrs?: Record<string,string>}} [options] */
import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * @param {{doc: any, mount: any, client: {request: (path: string, options?: any) => Promise<any>}, toast?: (message: string, error?: boolean) => void, storage?: any, now?: () => Date}} deps
 */
export function createCalendarioView(deps) {
  const { doc, mount } = deps;
  const { client } = bindAdminMutations(deps.client, deps);
  const toast = deps.toast ?? (() => {});
  const storage = deps.storage ?? null;
  const clock = typeof deps.now === 'function' ? deps.now : () => new Date();
  let renderToken = 0;

  const readSpace = () => {
    try {
      const stored = storage !== null ? storage.getItem(ACTIVE_SPACE_KEY) : null;
      return typeof stored === 'string' ? stored : '';
    } catch {
      return '';
    }
  };

  const state = {
    memberFilter: '',
    weekKeys: romeWeekKeys(clock()),
    /** @type {any} */
    week: null,
    weekError: null,
    unavailable: false,
    /** @type {Array<any>} */
    slots: [],
    slotsNote: '',
    /** @type {any} */
    draft: null,
    draftNote: '',
    bookingNote: '',
    /** @type {any} */
    confirmed: null,
    /** Last manual form values, restored on every re-render. @type {any} */
    manual: null,
    /** Draft absorbed into manual on submit. @type {any} */
    draftFill: null,
  };

  function clear() {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
  }

  /** @param {string} message @param {{retry?: () => void}} [options] */
  function showMessage(message, { retry } = {}) {
    clear();
    const box = el(doc, 'div', { className: 'panel' });
    box.appendChild(el(doc, 'p', { className: 'empty', text: message }));
    if (retry) {
      const button = el(doc, 'button', { className: 'small secondary', text: 'Riprova' });
      button.addEventListener('click', retry);
      box.appendChild(button);
    }
    mount.appendChild(box);
  }

  function shiftWeek(days) {
    const keys = state.weekKeys;
    if (keys.length === 0) return;
    const base = Date.parse(`${keys[0]}T12:00:00Z`);
    if (Number.isNaN(base)) return;
    const next = new Date(base + days * 24 * 3600 * 1000);
    state.weekKeys = romeWeekKeys(next);
    state.week = null;
    state.slots = [];
    state.slotsNote = '';
    // The pager moves the window but keeps the named members: reload for
    // them like the "Questa settimana" button does, so browsing never drops
    // back to the "name someone" prompt mid-week.
    const members = parseMemberFilter(state.memberFilter);
    if (members.length > 0) void loadWeek(members);
    else renderAll();
  }

  /** @param {Array<string>} members */
  async function loadWeek(members) {
    const token = ++renderToken;
    const window = weekWindow(state.weekKeys);
    if (!window) {
      state.weekError = 'Settimana non valida.';
      return;
    }
    try {
      const week = await client.request(
        `/api/appointments/team-week?teamMemberIds=${encodeURIComponent(members.join(','))}`
        + `&from=${encodeURIComponent(window.from)}&to=${encodeURIComponent(window.to)}`,
      );
      if (token !== renderToken) return;
      state.week = week;
      state.weekError = null;
      state.unavailable = false;
    } catch (error) {
      if (token !== renderToken) return;
      if (error?.code === 'NOT_FOUND' || error?.status === 404) {
        state.unavailable = true;
        state.week = null;
        state.weekError = null;
      } else {
        state.weekError = error?.message ?? 'Lettura della settimana fallita.';
      }
    }
    renderAll();
  }

  function renderAll() {
    clear();
    const wrap = el(doc, 'div', { className: 'cal-wrap' });
    wrap.appendChild(renderHeader());
    if (state.unavailable) {
      const box = el(doc, 'div', { className: 'panel' });
      box.appendChild(el(doc, 'p', {
        className: 'empty',
        text: 'Il calendario non è composto in questo spazio: nessun pacchetto appointments, nessuna settimana da mostrare.',
      }));
      wrap.appendChild(box);
      mount.appendChild(wrap);
      return;
    }
    wrap.appendChild(renderWeek());
    wrap.appendChild(renderPhrase());
    wrap.appendChild(renderSlots());
    wrap.appendChild(renderManual());
    mount.appendChild(wrap);
  }

  function renderHeader() {
    const head = el(doc, 'div', { className: 'panel-heading' });
    const titleBox = el(doc, 'div');
    titleBox.appendChild(el(doc, 'p', { className: 'eyebrow', text: 'Backoffice' }));
    titleBox.appendChild(el(doc, 'h2', { text: 'Calendario' }));
    const label = weekLabel(state.weekKeys);
    if (label) titleBox.appendChild(el(doc, 'p', { className: 'lede', text: `La settimana del team · ${label}` }));
    head.appendChild(titleBox);
    const nav = el(doc, 'div', { className: 'actions' });
    const prev = el(doc, 'button', { className: 'secondary small', text: '‹ Settimana prima' });
    prev.addEventListener('click', () => shiftWeek(-7));
    const today = el(doc, 'button', { className: 'secondary small', text: 'Questa settimana' });
    today.addEventListener('click', () => {
      state.weekKeys = romeWeekKeys(clock());
      state.week = null;
      state.slots = [];
      state.slotsNote = '';
      const members = parseMemberFilter(state.memberFilter);
      if (members.length > 0) void loadWeek(members);
      else renderAll();
    });
    const next = el(doc, 'button', { className: 'secondary small', text: 'Settimana dopo ›' });
    next.addEventListener('click', () => shiftWeek(7));
    nav.appendChild(prev);
    nav.appendChild(today);
    nav.appendChild(next);
    head.appendChild(nav);
    const filterRow = el(doc, 'div', { className: 'cal-filter' });
    const input = el(doc, 'input', { attrs: { type: 'text', name: 'members', placeholder: 'Persone del team: marco, sara' } });
    input.value = state.memberFilter;
    input.addEventListener('input', () => { state.memberFilter = String(input.value ?? ''); });
    const show = el(doc, 'button', { className: 'primary small', text: 'Mostra settimana' });
    show.addEventListener('click', () => {
      state.memberFilter = String(input.value ?? '');
      const members = parseMemberFilter(state.memberFilter);
      if (members.length === 0) {
        state.week = null;
        state.weekError = 'Indica almeno una persona del team: la settimana di nessuno resterebbe vuota.';
        renderAll();
        return;
      }
      void loadWeek(members);
    });
    filterRow.appendChild(input);
    filterRow.appendChild(show);
    const box = el(doc, 'div');
    box.appendChild(head);
    box.appendChild(filterRow);
    return box;
  }

  /** Group the loaded week rows by Rome day key, in week order. */
  function weekColumns() {
    /** @type {Map<string, Array<any>>} */
    const byDay = new Map(state.weekKeys.map((key) => [key, []]));
    for (const group of state.week?.members ?? []) {
      for (const row of group?.appointments ?? []) {
        const key = romeDayKey(row.startsAt);
        if (key !== null && byDay.has(key)) byDay.get(key).push({ ...row, teamMemberId: group.teamMemberId });
      }
    }
    for (const rows of byDay.values()) {
      rows.sort((a, b) => String(a.startsAt).localeCompare(String(b.startsAt)));
    }
    return [...byDay.entries()];
  }

  function renderWeek() {
    const panel = el(doc, 'div', { className: 'panel' });
    panel.appendChild(el(doc, 'h2', { text: 'Settimana del team' }));
    if (state.weekError) {
      panel.appendChild(el(doc, 'p', { className: 'empty', text: state.weekError }));
      return panel;
    }
    if (!state.week) {
      panel.appendChild(el(doc, 'p', {
        className: 'empty',
        text: 'Scegli le persone del team e premi «Mostra settimana»: niente settimana senza nomi, mai quella di tutti.',
      }));
      return panel;
    }
    const grid = el(doc, 'div', { className: 'cal-grid' });
    for (const [key, rows] of weekColumns()) {
      const col = el(doc, 'div', { className: 'cal-day' });
      const head = el(doc, 'div', { className: 'cal-day-head' });
      head.appendChild(el(doc, 'strong', { text: dayName(key) }));
      head.appendChild(el(doc, 'span', { text: romeShortDay(`${key}T12:00:00Z`) ?? key }));
      col.appendChild(head);
      if (rows.length === 0) {
        col.appendChild(el(doc, 'p', { className: 'cal-empty', text: '—' }));
      }
      for (const row of rows) {
        col.appendChild(renderEvent(row));
      }
      grid.appendChild(col);
    }
    panel.appendChild(grid);
    return panel;
  }

  /** Italian weekday name for a YYYY-MM-DD key, noon UTC avoids DST edges. */
  function dayName(key) {
    try {
      const text = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', weekday: 'long' })
        .format(new Date(`${key}T12:00:00Z`));
      return text.charAt(0).toUpperCase() + text.slice(1);
    } catch {
      return key;
    }
  }

  function renderEvent(row) {
    const item = el(doc, 'div', { className: `cal-event cal-status-${String(row.status ?? 'booked')}` });
    const time = `${romeTime(row.startsAt) ?? '?'}–${romeTime(row.endsAt) ?? '?'}`;
    item.appendChild(el(doc, 'span', { className: 'cal-time', text: time }));
    item.appendChild(el(doc, 'strong', { text: titleOf(row) }));
    item.appendChild(el(doc, 'span', { className: 'cal-meta', text: String(row.teamMemberId ?? '') }));
    item.appendChild(el(doc, 'span', { className: 'badge', text: String(row.status ?? 'booked') }));
    const subject = row.subject;
    if (subject && typeof subject.id === 'string' && typeof subject.resource === 'string') {
      const link = el(doc, 'a', {
        text: `Scheda ${subject.label ?? subject.id}`,
        attrs: { href: `#/customer-card/${subject.resource}/${subject.id}` },
      });
      item.appendChild(link);
    }
    const detail = el(doc, 'button', { className: 'small secondary', text: 'Dettaglio' });
    detail.addEventListener('click', () => renderDetail(item, row));
    item.appendChild(detail);
    return item;
  }

  /** Event title: the agreed service, never an invented label. */
  function titleOf(row) {
    if (typeof row.notes === 'string' && row.notes.trim() !== '') return row.notes.trim();
    if (typeof row.serviceKey === 'string' && row.serviceKey !== '') return row.serviceKey;
    return 'Appuntamento';
  }

  /** Who, where, origin and sync key — the sync state itself lives in calendar-sync, not here. */
  function renderDetail(anchor, row) {
    let existing = null;
    for (const child of anchor.childNodes) {
      if (child.getAttribute && child.getAttribute('class') === 'cal-detail') existing = child;
    }
    if (existing) {
      anchor.removeChild(existing);
      return;
    }
    const box = el(doc, 'div', { className: 'cal-detail' });
    const subject = row.subject ?? {};
    box.appendChild(el(doc, 'p', { text: `Chi: ${subject.resource ?? '?'} ${subject.id ?? '?'}` }));
    box.appendChild(el(doc, 'p', { text: `Dove: con ${row.teamMemberId ?? '?'}` }));
    box.appendChild(el(doc, 'p', { text: `Stato: ${row.status ?? 'booked'}` }));
    box.appendChild(el(doc, 'p', { text: `Origine: ${row.sourceKey ?? '—'}` }));
    const price = typeof row.priceCents === 'number'
      ? formatMinorUnits(row.priceCents, row.currency ?? 'EUR')
      : '—';
    box.appendChild(el(doc, 'p', { text: `Prezzo concordato: ${price}` }));
    anchor.appendChild(box);
  }

  function renderPhrase() {
    const panel = el(doc, 'div', { className: 'panel' });
    panel.appendChild(el(doc, 'h2', { text: 'Fissa con una frase' }));
    panel.appendChild(el(doc, 'p', {
      className: 'lede',
      text: 'Scrivi come lo diresti: la frase diventa una bozza con data e ora interpretate. La bozza compila il modulo qui sotto — la prenotazione la confermi tu.',
    }));
    const row = el(doc, 'div', { className: 'cal-filter' });
    const input = el(doc, 'input', {
      attrs: { type: 'text', name: 'phrase', placeholder: '«giovedì alle 18 con Marco per il taglio»' },
    });
    const send = el(doc, 'button', { className: 'primary small', text: 'Interpreta' });
    send.addEventListener('click', () => void submitPhrase(String(input.value ?? '')));
    row.appendChild(input);
    row.appendChild(send);
    panel.appendChild(row);
    if (state.draftNote) panel.appendChild(el(doc, 'p', { className: 'empty', text: state.draftNote }));
    if (state.draft) panel.appendChild(renderDraft(state.draft));
    return panel;
  }

  /** @param {string} phrase */
  async function submitPhrase(phrase) {
    if (phrase.trim() === '') {
      state.draft = null;
      state.draftNote = 'Scrivi prima la frase.';
      renderAll();
      return;
    }
    state.draftNote = 'Interpretazione…';
    state.draft = null;
    renderAll();
    try {
      const answer = await client.request('/api/appointments/phrase', {
        method: 'POST',
        body: { spaceId: readSpace(), phrase },
      });
      state.draft = answer?.draft ?? null;
      state.draftNote = state.draft
        ? 'Bozza pronta: controlla i campi nel modulo e conferma.'
        : 'Nessuna bozza dalla frase: usa il modulo qui sotto.';
    } catch (error) {
      state.draft = null;
      state.draftNote = error?.code === 'NOT_FOUND' || error?.status === 404
        ? 'Il calendario non è composto in questo spazio: usa il modulo qui sotto.'
        : (error?.message ?? 'Interpretazione fallita: usa il modulo qui sotto.');
    }
    renderAll();
    if (state.draft) fillManual(state.draft);
  }

  /** @param {any} draft */
  function renderDraft(draft) {
    const box = el(doc, 'div', { className: 'cal-draft' });
    box.appendChild(el(doc, 'p', {
      text: `Bozza: ${draft.teamMemberId ?? '—'} · ${romeShortDay(draft.startsAt) ?? '?'} ${romeTime(draft.startsAt) ?? ''}–${romeTime(draft.endsAt) ?? ''}`,
    }));
    if (draft.notes) box.appendChild(el(doc, 'p', { text: `Nota: ${draft.notes}` }));
    return box;
  }

  function renderSlots() {
    const panel = el(doc, 'div', { className: 'panel' });
    panel.appendChild(el(doc, 'h2', { text: 'Slot liberi' }));
    panel.appendChild(el(doc, 'p', {
      className: 'lede',
      text: 'Fasce lette dalle prenotazioni reali, mai inventate. Un click compila il modulo con quello slot — la conferma resta tua.',
    }));
    const row = el(doc, 'div', { className: 'cal-filter' });
    const member = el(doc, 'input', { attrs: { type: 'text', name: 'slotMember', placeholder: 'Persona: marco' } });
    const day = el(doc, 'input', { attrs: { type: 'date', name: 'slotDay' } });
    const minutes = el(doc, 'input', { attrs: { type: 'number', name: 'slotMinutes', placeholder: '30' } });
    const find = el(doc, 'button', { className: 'secondary small', text: 'Trova slot' });
    find.addEventListener('click', () => void submitSlots(
      String(member.value ?? ''),
      String(day.value ?? ''),
      String(minutes.value ?? ''),
    ));
    row.appendChild(member);
    row.appendChild(day);
    row.appendChild(minutes);
    row.appendChild(find);
    panel.appendChild(row);
    if (state.slotsNote) panel.appendChild(el(doc, 'p', { className: 'empty', text: state.slotsNote }));
    if (state.slots.length > 0) {
      const list = el(doc, 'div', { className: 'cal-slots' });
      for (const slot of state.slots.slice(0, 24)) {
        const pick = el(doc, 'button', {
          className: 'small secondary',
          text: `${romeShortDay(slot.startsAt) ?? ''} ${romeTime(slot.startsAt) ?? ''}–${romeTime(slot.endsAt) ?? ''} · ${slot.teamMemberId ?? ''}`,
        });
        pick.addEventListener('click', () => useSlot(slot));
        list.appendChild(pick);
      }
      panel.appendChild(list);
    }
    return panel;
  }

  async function submitSlots(member, day, minutes) {
    const members = parseMemberFilter(member);
    if (members.length === 0 || day === '') {
      state.slots = [];
      state.slotsNote = 'Indica persona e giorno per cercare gli slot.';
      renderAll();
      return;
    }
    const dayStart = Date.parse(`${day}T00:00:00Z`);
    if (Number.isNaN(dayStart)) {
      state.slots = [];
      state.slotsNote = 'Giorno non valido.';
      renderAll();
      return;
    }
    const slotMinutes = minutes.trim() === '' ? 30 : Number.parseInt(minutes, 10);
    try {
      const answer = await client.request(
        `/api/appointments/suggest-slots?teamMemberIds=${encodeURIComponent(members.join(','))}`
        + `&from=${encodeURIComponent(new Date(dayStart - 2 * 3600 * 1000).toISOString())}`
        + `&to=${encodeURIComponent(new Date(dayStart + 26 * 3600 * 1000).toISOString())}`
        + `&slotMinutes=${encodeURIComponent(String(slotMinutes))}`,
      );
      const groups = Array.isArray(answer?.members) ? answer.members : [];
      const kept = [];
      for (const group of groups) {
        for (const slot of group?.slots ?? []) {
          if (romeDayKey(slot.startsAt) === day) kept.push({ ...slot, teamMemberId: group.teamMemberId });
        }
      }
      state.slots = kept;
      state.slotsNote = kept.length === 0
        ? 'Nessuno slot libero quel giorno: prova un altro giorno o un passo diverso.'
        : '';
    } catch (error) {
      state.slots = [];
      state.slotsNote = error?.code === 'NOT_FOUND' || error?.status === 404
        ? 'Il calendario non è composto in questo spazio.'
        : (error?.message ?? 'Ricerca slot fallita.');
    }
    renderAll();
  }

  /** One click fills the manual form with the slot — confirmation stays manual. */
  function useSlot(slot) {
    fillManual({
      teamMemberId: slot.teamMemberId,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    });
    toast('Slot nel modulo: completa cliente e prezzo, poi conferma.');
  }

  function renderManual() {
    const panel = el(doc, 'div', { className: 'panel' });
    panel.appendChild(el(doc, 'h2', { text: 'Nuovo appuntamento' }));
    panel.appendChild(el(doc, 'p', {
      className: 'lede',
      text: 'Compila e premi «Proponi»: niente è scritto finché non premi «Conferma».',
    }));
    const form = el(doc, 'div', { className: 'cal-form' });
    const fields = [
      ['customerResource', 'text', 'Cliente (risorsa: contact)'],
      ['customerId', 'text', 'Cliente (id)'],
      ['teamMemberId', 'text', 'Persona del team'],
      ['serviceKey', 'text', 'Servizio (chiave listino)'],
      ['price', 'text', 'Prezzo EUR (es. 45.00)'],
      ['date', 'date', 'Giorno'],
      ['start', 'time', 'Inizio'],
      ['end', 'time', 'Fine'],
      ['notes', 'text', 'Note'],
    ];
    const inputs = {};
    for (const [name, type, placeholder] of fields) {
      const input = el(doc, 'input', { attrs: { type, name, placeholder } });
      // Keep what the operator typed: a re-render (propose, slots, week)
      // rebuilds the inputs, so restore the last manual values first — and
      // track every keystroke live, so an unrelated re-render (week load,
      // slot search, phrase draft) never discards unsubmitted edits.
      if (state.manual?.[name] != null) input.value = String(state.manual[name]);
      input.addEventListener('input', () => {
        state.manual = { ...(state.manual ?? {}), [name]: String(input.value ?? '') };
      });
      inputs[name] = input;
      form.appendChild(input);
    }
    if (state.draftFill) {
      const draft = state.draftFill;
      if (draft.teamMemberId) inputs.teamMemberId.value = String(draft.teamMemberId);
      if (draft.serviceKey) inputs.serviceKey.value = String(draft.serviceKey);
      if (draft.notes) inputs.notes.value = String(draft.notes);
      const dayKey = romeDayKey(draft.startsAt);
      if (dayKey) inputs.date.value = dayKey;
      if (romeTime(draft.startsAt)) inputs.start.value = romeTime(draft.startsAt);
      if (romeTime(draft.endsAt)) inputs.end.value = romeTime(draft.endsAt);
      // The draft has been absorbed into the visible form: snapshot it, so
      // a later re-render keeps the draft values instead of replaying them
      // over the operator's own edits.
      state.manual = snapshotManual(inputs);
      state.draftFill = null;
    }
    const propose = el(doc, 'button', { className: 'primary small', text: 'Proponi' });
    propose.addEventListener('click', () => void submitBooking(inputs, false));
    const confirm = el(doc, 'button', { className: 'secondary small', text: 'Conferma' });
    confirm.addEventListener('click', () => void submitBooking(inputs, true));
    form.appendChild(propose);
    form.appendChild(confirm);
    panel.appendChild(form);
    if (state.bookingNote) panel.appendChild(el(doc, 'p', { className: 'empty', text: state.bookingNote }));
    if (state.confirmed) {
      panel.appendChild(el(doc, 'p', {
        className: 'cal-ok',
        text: `Prenotato: ${state.confirmed.teamMemberId ?? ''} · ${romeShortDay(state.confirmed.startsAt) ?? ''} ${romeTime(state.confirmed.startsAt) ?? ''}.`,
      }));
    }
    return panel;
  }

  /** Prefill the manual form from a phrase draft or a picked slot. */
  function fillManual(draft) {
    state.draftFill = draft;
    renderAll();
  }

  /** Live manual values, field by field, as the operator sees them. */
  function snapshotManual(inputs) {
    return Object.fromEntries(
      Object.entries(inputs).map(([name, node]) => [name, String(node?.value ?? '')]),
    );
  }

  /** Build the booking claim from the manual form: Rome day + HH:MM to instants. */
  function claimFrom(inputs) {
    const read = (name) => String(inputs[name]?.value ?? '').trim();
    const day = read('date');
    const start = read('start');
    const end = read('end');
    const startsAt = day !== '' && start !== '' ? romeInstant(day, start) : null;
    const endsAt = day !== '' && end !== '' ? romeInstant(day, end) : null;
    const price = read('price').replace(',', '.');
    const priceCents = price === '' ? null : Math.round(Number(price) * 100);
    const member = read('teamMemberId');
    return {
      claim: {
        spaceId: readSpace(),
        subject: { resource: read('customerResource') || 'contact', id: read('customerId'), owner: 'host' },
        teamMemberId: member,
        serviceKey: read('serviceKey'),
        priceCents,
        currency: 'EUR',
        startsAt,
        endsAt,
        notes: read('notes') === '' ? null : read('notes'),
        sourceKey: member !== '' && startsAt
          ? `calendario:${member}:${startsAt}:${read('customerId') || 'senza-cliente'}`
          : undefined,
        source: { package: 'host', action: 'calendar-book' },
      },
    };
  }

  /** Rome day + HH:MM to an ISO instant, or null when not a real time. */
  function romeInstant(day, hm) {
    const [hour, minute] = String(hm).split(':').map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T12:00:00Z`))) return null;
    return romeWallToIso(day, hour, minute);
  }

  /**
   * Interpret HH:MM on a Rome day as a Rome wall time, returned as ISO.
   * Solved by round-trip: guess UTC, read back the Rome wall datetime,
   * correct the guess. A late-evening guess reads back on the next Rome
   * day, so whole-day drift is corrected separately from minutes — and the
   * answer is accepted only when the full Rome wall datetime (day, hour,
   * minute) matches. A drift that cannot be corrected fails closed (null),
   * never books the wrong date. The server re-checks DST edges on write.
   */
  function romeWallToIso(day, hour, minute) {
    const fmt = (instant) => {
      try {
        const seenDay = romeDayKey(instant);
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
        }).formatToParts(instant);
        const get = (type) => Number(parts.find((part) => part.type === type)?.value);
        if (seenDay === null || Number.isNaN(get('hour')) || Number.isNaN(get('minute'))) return null;
        return { day: seenDay, h: get('hour') % 24, m: get('minute') };
      } catch {
        return null;
      }
    };
    let guess = Date.parse(`${day}T${pad(hour)}:${pad(minute)}:00Z`);
    if (Number.isNaN(guess)) return null;
    for (let pass = 0; pass < 3; pass += 1) {
      const seen = fmt(new Date(guess));
      if (!seen) return null;
      if (seen.day === day && seen.h === hour && seen.m === minute) return new Date(guess).toISOString();
      if (seen.day !== day) {
        const drift = Math.round((Date.parse(`${seen.day}T12:00:00Z`) - Date.parse(`${day}T12:00:00Z`)) / 86400000);
        if (!Number.isFinite(drift) || drift === 0) return null;
        guess -= drift * 86400000;
        continue;
      }
      guess += ((hour * 60 + minute) - (seen.h * 60 + seen.m)) * 60000;
    }
    const seen = fmt(new Date(guess));
    if (!seen || seen.day !== day || seen.h !== hour || seen.m !== minute) return null;
    return new Date(guess).toISOString();
  }

  /** @param {number} value */
  function pad(value) {
    return String(value).padStart(2, '0');
  }

  /** @param {any} inputs @param {boolean} confirm */
  async function submitBooking(inputs, confirm) {
    const { claim } = claimFrom(inputs);
    // The manual form is the source of truth for this submit: remember every
    // raw value (draft-derived ones included) so the re-render after propose
    // shows the same form Conferma will book. The draft has been absorbed.
    state.manual = snapshotManual(inputs);
    state.draftFill = null;
    state.confirmed = null;
    try {
      if (!confirm) {
        const proposed = await client.request('/api/appointments/propose', {
          method: 'POST',
          body: claim,
        });
        state.bookingNote = proposed?.decision === 'proposal'
          ? 'Registrata come proposta: lo spazio non fissa in automatico.'
          : 'Bozza pronta: premi «Conferma» per scriverla davvero.';
        renderAll();
        return;
      }
      // Explicit confirmation rides the idempotent confirm operation
      // directly: the server re-checks the slot and replays the same source
      // key, so a retry after a committed-but-lost confirm reaches the
      // replay instead of dying on propose against the confirmed row.
      const booked = await client.request('/api/appointments/confirm', {
        method: 'POST',
        body: { ...claim, confirmed: true },
      });
      if (booked?.decision === 'booked') {
        state.confirmed = booked.appointment ?? claim;
        state.bookingNote = '';
        state.draftFill = null;
      } else {
        state.bookingNote = 'Registrata come proposta: lo spazio non fissa in automatico.';
      }
    } catch (error) {
      state.bookingNote = error?.code === 'NOT_FOUND' || error?.status === 404
        ? 'Il calendario non è composto in questo spazio.'
        : (error?.message ?? 'Prenotazione fallita.');
    }
    renderAll();
    const members = parseMemberFilter(state.memberFilter);
    if (members.length > 0 && state.confirmed) void loadWeek(members);
  }

  async function render() {
    renderAll();
    const members = parseMemberFilter(state.memberFilter);
    if (members.length > 0) await loadWeek(members);
  }

  return { render };
}
