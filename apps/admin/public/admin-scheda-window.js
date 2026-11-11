// The window frame the scheda cliente opens over the page (Dan 06/11 and
// 11/11): the same dark head as «Scrivi» and «Nuova offerta» — the purpose
// and the customer, Riduci and Chiudi — then a body and a foot. Escape
// closes it. One window per purpose: opening it again replaces the old one.
//
// Used by «Nuovo appuntamento» and by «Chiama» when the number is still to
// choose. Text only (textContent/setAttribute), never markup.

import { elFor } from './admin-ui.js'; // BO-F6-02: the single component library.

/**
 * @param {{
 *   doc: any, host: any, attr: string, action: string, title: string,
 *   customer?: string | null, extraClass?: string,
 * }} options `attr` marks the open window (`data-…="open"`), `action`
 *   prefixes the head buttons' data-action.
 * @returns {{ panel: any, body: any, foot: any, shut: () => void, gone: () => boolean }}
 */
export function openSchedaWindow(options) {
  const { doc, host, attr, action, title } = options;
  const el = elFor(doc);
  const old = host.querySelector(`div[${attr}="open"]`);
  if (old && old.parentNode) old.parentNode.removeChild(old);
  const panel = el('div', `bo-scheda-composer${options.extraClass ? ` ${options.extraClass}` : ''}`);
  panel.setAttribute(attr, 'open');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', title);
  host.appendChild(panel);
  const gone = () => panel.parentNode == null;
  const shut = () => { if (panel.parentNode) panel.parentNode.removeChild(panel); };

  const head = el('div', 'bo-composer-head');
  const heading = el('h4', 'bo-composer-title', title);
  const customer = typeof options.customer === 'string' ? options.customer.trim() : '';
  if (customer !== '') heading.appendChild(el('span', 'bo-composer-to-name', ` · ${customer}`));
  head.appendChild(heading);
  const minimize = el('button', 'bo-composer-icon', '–');
  minimize.setAttribute('type', 'button');
  minimize.setAttribute('aria-label', 'Riduci');
  minimize.setAttribute('data-action', `${action}-minimize`);
  minimize.addEventListener('click', () => {
    if (panel.getAttribute('data-minimized') === 'true') panel.removeAttribute('data-minimized');
    else panel.setAttribute('data-minimized', 'true');
  });
  const close = el('button', 'bo-composer-icon', '✕');
  close.setAttribute('type', 'button');
  close.setAttribute('aria-label', 'Chiudi');
  close.setAttribute('data-action', `${action}-close`);
  close.addEventListener('click', shut);
  panel.addEventListener('keydown', (event) => {
    if (event?.key === 'Escape') shut();
  });
  head.appendChild(minimize);
  head.appendChild(close);
  panel.appendChild(head);

  const body = el('div', 'bo-composer-body');
  panel.appendChild(body);
  const foot = el('div', 'bo-composer-foot');
  panel.appendChild(foot);
  return { panel, body, foot, shut, gone };
}

/**
 * The waiting state of a confirm button while its write is in flight: no
 * second click, `aria-busy`, and a word that says what is happening
 * («Prenoto…», «Salvo…»). The returned function puts the button back.
 * @param {any} button @param {string} busyText
 */
export function holdButton(button, busyText) {
  const idle = button.textContent;
  button.setAttribute('disabled', 'disabled');
  button.setAttribute('aria-busy', 'true');
  button.textContent = busyText;
  return () => {
    button.removeAttribute('disabled');
    button.setAttribute('aria-busy', 'false');
    button.textContent = idle;
  };
}
