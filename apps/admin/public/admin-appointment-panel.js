// «Nuovo appuntamento» from the scheda cliente, in a window over the page
// (Dan 11/11): the appointment is booked where the customer is, like
// «Scrivi» and «Nuova offerta», with the customer already chosen.
//
// The window asks for the service (the listino singles the booking worker
// accepts), the duration, the team person, then shows that person's free
// slots and books one with Conferma. Every step is the Calendario's own:
// `catalogBookingServices` for the menu, `personRows` for the team,
// `suggest-slots` read through `personFreeSlots`/`filterPhraseProposals`/
// `rankPhraseProposals`, and the claim built by `bookingClaim` and sent to
// `/api/appointments/confirm` like the Calendario's Conferma. No AI is
// involved: the window works the same with the AI switched off.

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.
import { humanReadError, humanWriteError, isNotComposedFailure } from './admin-core.js';
import {
  BOOKING_MINUTES, bookingClaim, calendarRefusalText, catalogBookingServices, filterPhraseProposals,
  formatPriceCents, personFreeSlots, personRows, rankPhraseProposals, servicePresendError, slotInGrid, slotLabel,
  suggestSlotsPath,
} from './admin-calendario.js';
import { holdButton, openSchedaWindow } from './admin-scheda-window.js';

/** Days ahead the window searches for free slots. */
export const APPOINTMENT_SEARCH_DAYS = 7;
/** Free slots shown at most: the first ones inside the working hours. */
export const APPOINTMENT_SLOTS_SHOWN = 12;
export const APPOINTMENT_CONFIRM_PATH = '/api/appointments/confirm';

/** «30 min», «1 ora», «1 ora e 30», «2 ore». @param {number} minutes */
export function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${rest} min`;
  const head = hours === 1 ? '1 ora' : `${hours} ore`;
  return rest === 0 ? head : `${head} e ${rest}`;
}

/**
 * Opens the appointment window over the scheda.
 *
 * @param {{
 *   doc: any, host: any, client: any, issueKey: () => string,
 *   customer: {resource: string, id: string, name: string},
 *   spaceId: string | null, toast?: (text: string, error?: boolean) => void,
 *   onBooked?: (answer: any) => void, now?: () => Date,
 * }} deps
 */
export function openAppointmentPanel(deps) {
  const { doc, client, customer } = deps;
  const toast = typeof deps.toast === 'function' ? deps.toast : () => {};
  const now = typeof deps.now === 'function' ? deps.now : () => new Date();
  const el = elFor(doc);
  const { panel, body, foot, shut, gone } = openSchedaWindow({
    doc, host: deps.host, attr: 'data-appointment-panel', action: 'appointment',
    title: 'Nuovo appuntamento', customer: customer.name, extraClass: 'bo-offer-panel',
  });
  body.setAttribute('class', 'bo-composer-body bo-offer-body');

  const cancel = el('button', undefined, 'Annulla');
  cancel.setAttribute('type', 'button');
  cancel.setAttribute('data-action', 'appointment-cancel');
  cancel.addEventListener('click', shut);

  if (deps.spaceId === null) {
    body.appendChild(el('p', 'bo-offer-blocked', 'Scegli uno spazio in alto, poi prenota l’appuntamento.'));
    foot.appendChild(cancel);
    return panel;
  }

  // ---- Fields --------------------------------------------------------
  const fields = el('div', 'bo-offer-fields');
  /** @type {Record<string, any>} */
  const errors = {};
  const field = (name, label, control, wide = false) => {
    const wrap = el('label', `bo-offer-field${wide ? ' bo-offer-field-wide' : ''}`);
    wrap.appendChild(el('span', 'bo-offer-label', label));
    wrap.appendChild(control);
    const error = el('small', 'field-error', '');
    wrap.appendChild(error);
    errors[name] = error;
    fields.appendChild(wrap);
  };
  const select = (name, first) => {
    const node = el('select', 'bo-offer-input');
    node.setAttribute('name', `appointment-${name}`);
    const option = el('option', undefined, first);
    option.setAttribute('value', '');
    node.appendChild(option);
    return node;
  };
  const service = select('service', 'Carico il listino…');
  const duration = el('select', 'bo-offer-input');
  duration.setAttribute('name', 'appointment-duration');
  for (const minutes of BOOKING_MINUTES) {
    const option = el('option', undefined, durationLabel(minutes));
    option.setAttribute('value', String(minutes));
    if (minutes === 30) option.setAttribute('selected', 'selected');
    duration.appendChild(option);
  }
  duration.value = '30';
  const person = select('person', 'Carico il team…');
  field('service', 'Servizio', service, true);
  field('duration', 'Durata', duration);
  field('person', 'Persona del team', person);
  body.appendChild(fields);

  const slotBox = el('div', 'bo-offer-catalog');
  slotBox.appendChild(el('p', 'bo-offer-catalog-title', 'Slot liberi'));
  const slotLine = el('p', 'bo-muted', 'Scegli la persona del team per vedere gli orari liberi.');
  slotLine.setAttribute('aria-live', 'polite');
  slotBox.appendChild(slotLine);
  const chips = el('div', 'bo-offer-chips');
  slotBox.appendChild(chips);
  body.appendChild(slotBox);

  const generalError = el('p', 'field-error', '');
  generalError.setAttribute('role', 'alert');
  body.appendChild(generalError);

  const confirm = el('button', 'primary', 'Conferma');
  confirm.setAttribute('type', 'button');
  confirm.setAttribute('data-action', 'appointment-confirm');
  foot.appendChild(confirm);
  foot.appendChild(cancel);
  foot.appendChild(el('span', 'bo-composer-limit', 'Compare anche in Calendario'));

  /** @type {ReadonlyArray<{key: string, name: string, priceCents: number}>} */
  let services = [];
  /** @type {Array<{ids: string[], label: string}>} */
  let people = [];
  /** @type {null | {teamMemberId: string, startsAt: string, endsAt: string}} */
  let chosen = null;
  let searchSeq = 0;
  // One key per chosen slot: a retry or a double click books once.
  let submissionKey = null;
  let booking = false;

  const say = (node, text) => { node.textContent = text; };

  // ---- Listino ---------------------------------------------------------
  client.request('/api/catalog/products?limit=200').then(
    (answer) => {
      if (gone()) return;
      services = catalogBookingServices(answer);
      fillServices();
    },
    (error) => {
      if (gone()) return;
      services = [];
      fillServices(isNotComposedFailure(error)
        ? 'Il listino non è attivo in questo spazio: aggiungi un servizio in Catalogo.'
        : humanReadError(error, { failed: 'Il listino non si è potuto leggere. Riprova più tardi.' }));
    },
  );
  function fillServices(failure = null) {
    while (service.firstChild) service.removeChild(service.firstChild);
    const first = el('option', undefined, services.length === 0 ? 'Nessun servizio' : 'Scegli il servizio');
    first.setAttribute('value', '');
    service.appendChild(first);
    for (const entry of services) {
      const price = formatPriceCents(entry.priceCents);
      const option = el('option', undefined, price === null ? entry.name : `${entry.name} · ${price.replace('.', ',')} €`);
      option.setAttribute('value', entry.key);
      service.appendChild(option);
    }
    service.value = services.length === 1 ? services[0].key : '';
    if (failure !== null) say(errors.service, failure);
    else if (services.length === 0) say(errors.service, 'Nessun servizio prenotabile nel listino: aggiungine uno in Catalogo.');
    else say(errors.service, '');
  }
  service.addEventListener('change', () => { say(errors.service, ''); say(generalError, ''); });

  // ---- Team -------------------------------------------------------------
  client.request('/api/spine/memberships').then(
    (answer) => {
      if (gone()) return;
      people = personRows([], [], Array.isArray(answer?.items) ? answer.items : [])
        .map((row) => ({ ids: [...row.ids], label: row.label }));
      fillPeople(people.length === 0 ? 'Nessuna persona nel team di questo spazio.' : null);
    },
    (error) => {
      if (gone()) return;
      people = [];
      fillPeople(humanReadError(error, {
        failed: 'Il team non si è potuto leggere. Riprova più tardi.',
        notComposed: 'Il team non è disponibile in questo spazio.',
      }));
    },
  );
  function fillPeople(failure) {
    while (person.firstChild) person.removeChild(person.firstChild);
    const first = el('option', undefined, people.length === 0 ? 'Nessuna persona' : 'Scegli la persona');
    first.setAttribute('value', '');
    person.appendChild(first);
    people.forEach((row, index) => {
      const option = el('option', undefined, row.label);
      option.setAttribute('value', String(index));
      person.appendChild(option);
    });
    say(errors.person, failure ?? '');
    if (people.length === 1) {
      person.value = '0';
      void searchSlots();
    } else {
      person.value = '';
      if (failure !== null) say(slotLine, 'Senza una persona del team non ci sono orari da proporre.');
    }
  }
  person.addEventListener('change', () => { say(errors.person, ''); void searchSlots(); });
  duration.addEventListener('change', () => { void searchSlots(); });

  // ---- Slots -------------------------------------------------------------
  const clearChips = () => { while (chips.firstChild) chips.removeChild(chips.firstChild); };
  async function searchSlots() {
    const seq = (searchSeq += 1);
    chosen = null;
    submissionKey = null;
    clearChips();
    say(generalError, '');
    const row = people[Number(person.value)] ?? null;
    if (person.value === '' || row === null) {
      say(slotLine, 'Scegli la persona del team per vedere gli orari liberi.');
      return;
    }
    const minutes = BOOKING_MINUTES.includes(Number(duration.value)) ? Number(duration.value) : 30;
    const start = now();
    const from = start.toISOString();
    const to = new Date(start.getTime() + APPOINTMENT_SEARCH_DAYS * 86400000).toISOString();
    say(slotLine, 'Cerco gli orari liberi…');
    try {
      const found = await client.request(suggestSlotsPath(row.ids, from, to, minutes));
      if (gone() || seq !== searchSeq) return;
      const groups = Array.isArray(found?.members) ? found.members : [];
      const free = rankPhraseProposals(filterPhraseProposals(personFreeSlots(groups, row.ids, row.ids[0]), start.getTime()))
        .filter((slot) => slotInGrid(slot.startsAt, slot.endsAt))
        .slice(0, APPOINTMENT_SLOTS_SHOWN);
      if (free.length === 0) {
        say(slotLine, `Nessun orario libero nei prossimi ${APPOINTMENT_SEARCH_DAYS} giorni: prova un’altra durata o un’altra persona.`);
        return;
      }
      say(slotLine, '');
      for (const slot of free) {
        const chip = el('button', 'bo-offer-chip', slotLabel(slot));
        chip.setAttribute('type', 'button');
        chip.setAttribute('aria-pressed', 'false');
        chip.setAttribute('data-slot', String(slot.startsAt));
        chip.addEventListener('click', () => {
          for (const other of chips.childNodes) other.setAttribute('aria-pressed', 'false');
          chip.setAttribute('aria-pressed', 'true');
          chosen = { teamMemberId: String(slot.teamMemberId), startsAt: String(slot.startsAt), endsAt: String(slot.endsAt) };
          submissionKey = null;
          say(generalError, '');
        });
        chips.appendChild(chip);
      }
    } catch (error) {
      if (gone() || seq !== searchSeq) return;
      say(slotLine, humanReadError(error, {
        failed: 'Gli orari liberi non si sono potuti leggere. Riprova tra poco.',
        notComposed: 'Il calendario non è attivo in questo spazio.',
      }));
    }
  }

  // ---- Conferma ----------------------------------------------------------
  async function submit() {
    if (booking) return;
    say(generalError, '');
    const picked = services.find((entry) => entry.key === service.value) ?? null;
    let bad = false;
    if (picked === null) {
      say(errors.service, services.length === 0
        ? 'Nessun servizio prenotabile nel listino: aggiungine uno in Catalogo.'
        : 'Scegli il servizio.');
      bad = true;
    }
    if (person.value === '' || people[Number(person.value)] === undefined) {
      say(errors.person, people.length === 0 ? 'Nessuna persona del team da scegliere.' : 'Scegli la persona del team.');
      bad = true;
    }
    if (!bad && chosen === null) {
      say(generalError, 'Scegli uno degli orari liberi.');
      bad = true;
    }
    if (bad || picked === null || chosen === null) return;
    const slot = chosen;
    const claim = bookingClaim({
      spaceId: deps.spaceId,
      customer: { resource: customer.resource, id: customer.id },
      teamMemberId: slot.teamMemberId,
      serviceKey: picked.key,
      priceCents: picked.priceCents,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
    });
    const presend = servicePresendError(claim.serviceKey);
    if (presend !== null) {
      say(errors.service, presend);
      return;
    }
    booking = true;
    const release = holdButton(confirm, 'Prenoto…');
    if (submissionKey === null) submissionKey = deps.issueKey();
    try {
      const answer = await client.request(APPOINTMENT_CONFIRM_PATH, {
        method: 'POST',
        idempotencyKey: submissionKey,
        body: JSON.stringify({ ...claim, confirmed: true }),
      });
      submissionKey = null;
      shut();
      toast(answer?.decision === 'booked'
        ? `Appuntamento fissato: ${slotLabel(slot)}`
        : 'Registrato come proposta: lo spazio non fissa in automatico.');
      if (typeof deps.onBooked === 'function') deps.onBooked(answer);
    } catch (error) {
      // Like the offer window: the cause is logged (code, status, space —
      // never the customer), and a closed window still says it as a toast.
      if (typeof console !== 'undefined' && typeof console.error === 'function') {
        console.error('[bo] appuntamento non fissato', {
          code: error?.code ?? null,
          status: typeof error?.status === 'number' ? error.status : null,
          spaceId: deps.spaceId ?? null,
        });
      }
      if (gone()) {
        toast('Appuntamento non fissato: riapri «Nuovo appuntamento» e riprova.', true);
        return;
      }
      const status = typeof error?.status === 'number' ? error.status : 0;
      if (status >= 400 && status < 500 && ![408, 425, 429].includes(status)) submissionKey = null;
      const code = error?.code ?? null;
      if (code === 'APPOINTMENTS_OVERLAP') {
        void searchSlots().then(() => {
          if (!gone()) say(generalError, 'Quell’orario è appena stato occupato: scegline un altro.');
        });
      } else if (code === 'BO_APPOINTMENT_SERVICE_REFUSED' || error?.details?.field === 'serviceKey') {
        say(errors.service, calendarRefusalText(error) ?? 'Scegli un servizio dal listino.');
      } else {
        say(generalError, humanWriteError(error, {
          failed: 'Appuntamento non fissato. Riprova tra poco: non verrà fissato due volte.',
          notComposed: 'Il calendario non è attivo in questo spazio.',
        }));
      }
    } finally {
      booking = false;
      if (!gone()) release();
    }
  }
  confirm.addEventListener('click', submit);
  panel.__submit = submit; // test hook
  panel.__search = searchSlots; // test hook

  if (typeof service.focus === 'function') service.focus();
  return panel;
}
