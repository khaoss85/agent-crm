// «Chiama» when the number is still to choose (Dan 11/11): a window over
// the scheda, in the same frame as «Scrivi» and «Nuova offerta», that asks
// which number to call — one of the numbers the customer is already known
// by, or a new one — and hands it to the scheda, which saves it on the
// contact (POST /api/customer-hub/phone, the write «Aggiungi telefono» used)
// and starts the call with the usual «Chiama» flow. The CRM call route
// dials the number held on the card, so a number is always saved first.

import { elFor, uiHold } from './admin-ui.js'; // BO-F6-02: the single component library.
import { openSchedaWindow } from './admin-scheda-window.js';

/** Identity systems whose handle is a phone number (same list as the card). */
const PHONE_SYSTEMS = Object.freeze(['whatsapp', 'sms', 'voice', 'phone', 'tel', 'mobile']);
const SYSTEM_WORDS = Object.freeze({
  whatsapp: 'WhatsApp', sms: 'SMS', voice: 'chiamate', phone: 'telefono', tel: 'telefono', mobile: 'cellulare',
});

/** How the call starts once the number is chosen (backlog:af43dffdff83). */
export const HOW_THE_CALL_STARTS = 'Poi apro il telefono del computer con questo numero o, se hai collegato un connettore voce, la chiamata dal CRM.';

export const NUMBER_FORMAT_HINT = 'Numero non valido: scrivilo con il prefisso, come +39 333 123 4567, oppure come 333 1234567.';

/**
 * A typed or known number as the E.164 the card dials, or null. Accepts the
 * international form (+39 333 123 4567, 0039 333…) and the Italian national
 * one (333 1234567 mobile, 02 1234567 landline → +39); spaces, dots,
 * dashes, slashes and parentheses are display only.
 * @param {unknown} raw
 */
export function dialableNumber(raw) {
  let text = String(raw ?? '').trim().replace(/[\s.\-()/]/g, '');
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  if (/^3\d{8,9}$/.test(text) || /^0\d{5,10}$/.test(text)) text = `+39${text}`;
  return /^\+[1-9]\d{6,14}$/.test(text) ? text : null;
}

/**
 * The numbers the customer is known by, deduplicated on their dialable
 * form: the one held on the card first, then every phone-bearing identity
 * held beside the record, then the handles observed on its passages. A
 * handle that does not dial is left out, never guessed.
 * @param {{held?: unknown, identities?: unknown, observed?: unknown}} sources
 *   `identities`/`observed` are `{system, externalId}` rows.
 * @returns {Array<{number: string, held: boolean, systems: string[]}>}
 */
export function knownNumbers({ held = null, identities = [], observed = [] } = {}) {
  /** @type {Map<string, {number: string, held: boolean, systems: string[]}>} */
  const byNumber = new Map();
  const add = (value, system, isHeld) => {
    const number = dialableNumber(value);
    if (number === null) return;
    const entry = byNumber.get(number) ?? { number, held: false, systems: [] };
    if (isHeld) entry.held = true;
    const word = system === null ? null : SYSTEM_WORDS[system] ?? null;
    if (word !== null && !entry.systems.includes(word)) entry.systems.push(word);
    byNumber.set(number, entry);
  };
  if (typeof held === 'string' && held.trim() !== '') add(held, null, true);
  for (const list of [identities, observed]) {
    for (const row of Array.isArray(list) ? list : []) {
      const system = String(row?.system ?? '').toLowerCase();
      if (!PHONE_SYSTEMS.includes(system) || typeof row?.externalId !== 'string') continue;
      add(row.externalId, system, false);
    }
  }
  return [...byNumber.values()];
}

/** «+39 333 1234567 · sulla scheda» / «+39 345 … · WhatsApp». @param {{number: string, held: boolean, systems: string[]}} entry */
function numberLabel(entry) {
  const where = entry.held ? ['sulla scheda', ...entry.systems] : entry.systems;
  return where.length === 0 ? entry.number : `${entry.number} · ${where.join(', ')}`;
}

/**
 * Opens the number window.
 *
 * @param {{
 *   doc: any, host: any, customer?: string | null,
 *   numbers: Array<{number: string, held: boolean, systems: string[]}>,
 *   draft?: string | null,
 *   mode?: 'call' | 'save',
 *   onCancel?: (() => void) | null,
 *   choose: (number: string, held: boolean) => Promise<string | null>,
 * }} deps `choose` saves (when needed) and starts the call; it answers
 *   null when done, or the Italian sentence to show in the window. With
 *   `mode: 'save'` the window only saves and closes, never calling.
 */
export function openCallNumberPanel(deps) {
  // backlog:7eb7dc663bbd: the composer reuses this window to add a missing
  // number — in `save` mode it saves and closes, never calling.
  const saveOnly = deps.mode === 'save';
  const el = elFor(deps.doc);
  const { panel, body, foot, shut, gone } = openSchedaWindow({
    doc: deps.doc, host: deps.host, attr: 'data-phone', action: 'phone',
    title: saveOnly ? 'Aggiungi un numero' : 'Chiama', customer: deps.customer ?? null,
  });
  const numbers = Array.isArray(deps.numbers) ? deps.numbers : [];
  const OTHER = 'altro';
  let selected = numbers.length === 0 ? OTHER : (numbers.find((entry) => entry.held)?.number ?? numbers[0].number);

  // backlog:af43dffdff83: say how the call really starts. This window only
  // saves the number; «Chiama dal CRM» then opens the computer's phone app
  // on the number (tel:) or, with a voice connector linked, the form that
  // records the call. In `save` mode there is no call after: the number is
  // saved on the scheda and the window closes.
  body.appendChild(el('p', 'bo-muted', numbers.length === 0
    ? (saveOnly ? 'Il cliente non ha ancora un numero: scrivilo qui.'
      : `Il cliente non ha ancora un numero: scrivilo qui. ${HOW_THE_CALL_STARTS}`)
    : (saveOnly ? 'Quale numero salvo sulla scheda?'
      : `Quale numero chiamo? Un numero nuovo lo salvo sulla scheda. ${HOW_THE_CALL_STARTS}`)));

  const typed = el('input', 'bo-scheda-composer-subject');
  typed.setAttribute('type', 'tel');
  typed.setAttribute('name', 'call-number');
  typed.setAttribute('placeholder', '+39 333 123 4567');
  typed.setAttribute('aria-label', 'Numero di telefono');
  typed.setAttribute('autocomplete', 'tel');
  if (typeof deps.draft === 'string') typed.value = deps.draft;

  /** @type {Array<{value: string, wrap: any, input: any}>} */
  const options = [];
  const paintChoice = () => {
    for (const option of options) {
      const on = option.value === selected;
      option.input.checked = on;
      option.wrap.setAttribute('data-selected', on ? 'true' : 'false');
    }
    if (selected === OTHER) typed.removeAttribute('hidden');
    else typed.setAttribute('hidden', 'hidden');
  };
  if (numbers.length > 0) {
    const group = el('div', 'bo-scheda-composer-channels');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-label', 'Numero da chiamare');
    const choice = (value, label) => {
      const wrap = el('label', 'bo-scheda-composer-channel');
      const input = el('input');
      input.setAttribute('type', 'radio');
      input.setAttribute('name', 'call-number-choice');
      input.setAttribute('value', value);
      input.addEventListener('change', () => {
        selected = value;
        say('');
        paintChoice();
        if (value === OTHER && typeof typed.focus === 'function') typed.focus();
      });
      wrap.appendChild(input);
      wrap.appendChild(el('span', undefined, label));
      wrap.setAttribute('data-number', value);
      group.appendChild(wrap);
      options.push({ value, wrap, input });
    };
    for (const entry of numbers) choice(entry.number, numberLabel(entry));
    choice(OTHER, 'Un altro numero');
    body.appendChild(group);
  }
  body.appendChild(typed);
  const error = el('p', 'field-error', '');
  error.setAttribute('role', 'alert');
  body.appendChild(error);
  const say = (text) => { error.textContent = text; };
  paintChoice();

  const go = el('button', 'primary', saveOnly ? 'Salva numero' : 'Chiama');
  go.setAttribute('type', 'button');
  go.setAttribute('data-action', saveOnly ? 'save-number' : 'call-with-number');
  const cancel = el('button', undefined, 'Annulla');
  cancel.setAttribute('type', 'button');
  cancel.setAttribute('data-action', 'cancel-phone');
  // backlog:28511aa43cc7: from the composer Annulla hands the screen back
  // to the caller's onCancel (the composer reopens with the typed text);
  // everywhere else it only closes the window, like before.
  cancel.addEventListener('click', () => {
    if (typeof deps.onCancel === 'function') deps.onCancel();
    else shut();
  });
  foot.appendChild(go);
  foot.appendChild(cancel);

  let busy = false;
  async function submit() {
    if (busy) return;
    say('');
    let number;
    let held = false;
    if (selected === OTHER) {
      const raw = String(typed.value ?? '').trim();
      if (raw === '') {
        say(saveOnly ? 'Scrivi il numero prima di salvarlo.' : 'Scrivi il numero prima di chiamare.');
        return;
      }
      number = dialableNumber(raw);
      if (number === null) {
        say(NUMBER_FORMAT_HINT);
        return;
      }
      held = numbers.some((entry) => entry.held && entry.number === number);
    } else {
      const entry = numbers.find((candidate) => candidate.number === selected) ?? null;
      if (entry === null) {
        say('Scegli un numero o scrivine uno nuovo.');
        return;
      }
      number = entry.number;
      held = entry.held;
    }
    busy = true;
    const release = uiHold(go, held ? 'Chiamo…' : 'Salvo…');
    try {
      const refusal = await deps.choose(number, held);
      if (refusal !== null && !gone()) say(refusal);
      else if (refusal === null) shut();
    } finally {
      busy = false;
      if (!gone()) release();
    }
  }
  go.addEventListener('click', submit);
  typed.addEventListener('keydown', (event) => {
    if (event?.key === 'Enter') {
      event.preventDefault?.();
      void submit();
    }
  });
  panel.__submit = submit; // test hook

  if (selected === OTHER && typeof typed.focus === 'function') typed.focus();
  return panel;
}
