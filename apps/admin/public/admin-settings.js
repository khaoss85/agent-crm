// @ts-check

/**
 * Backoffice settings header (backlog:ef0888bf5a3f).
 *
 * The header the Impostazioni index, Personalizzazione and Spazi e accessi
 * paint — one component (title plus subtitle), so the three pages keep the
 * same title, the same subtitle and the same hero size, and the subtitle
 * stays visible on all three. Lives here instead of `admin-shell.js` so the
 * screens import it without pulling the whole shell.
 */

import { el } from './admin-ui.js';

/**
 * Paint the settings header: the page title and the one line saying what the
 * page holds. The subtitle uses the backoffice muted text (never a visually
 * hidden placeholder): it reads on every page using this component.
 * @param {any} doc
 * @param {any} box the node the header opens
 * @param {{ title?: string, subtitle?: string }} [options]
 */
export function paintSettingsHead(doc, box, { title = '', subtitle = '' } = {}) {
  const head = el(doc, 'div', { cls: 'bo-settings-head' });
  head.appendChild(el(doc, 'h2', { text: title, cls: 'panel-title' }));
  // The subtitle keeps the historical `muted` class (older tests read it)
  // plus `bo-settings-sub`, which is the class styles.css paints visible —
  // never a visually-hidden placeholder.
  head.appendChild(el(doc, 'p', { text: subtitle, cls: 'muted bo-settings-sub' }));
  box.appendChild(head);
}
