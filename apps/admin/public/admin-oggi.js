// @ts-check

// Home under a space mount (backlog:7eee63a5).
//
// When the shell is served at the domain root the home is the framework demo
// dashboard (apps/admin/public/admin-demo.js). When the same shell is mounted
// for a space (createAdminShellMount with a basePath such as `/bo`), a space
// user must never see that demo: until BO-F3-04 delivers the real Oggi, the
// home is the Oggi frame from the approved prototype — a greeting plus links
// to the screens that are already delivered — with no invented data.
//
// Conventions follow apps/admin/public/admin-shell.js: the model builders are
// pure and DOM-free (unit-tested under node:test without a browser) and the
// renderer uses DOM APIs only — createElement + textContent/setAttribute —
// never innerHTML with data, so hostile space names are inert text.

/**
 * Framework demo strings. None of them may reach a space user: the mount
 * serves no demo markup (see admin-demo.js) and the Oggi frame below renders
 * none of them. Tests assert both.
 */
export const DEMO_STRINGS = Object.freeze([
  'Commercial logic',
  'Run demo',
  'Opportunities',
  'Approvals',
  'Workflow traces',
]);

/**
 * Whether the shell runs mounted for a space. The mount injects
 * `<meta name="admin-base" content="/bo">` (or the fuller public path);
 * the standalone server owns the domain root, so the prefix is empty there.
 * @param {unknown} adminBase
 */
export function isSpaceMount(adminBase) {
  return typeof adminBase === 'string' && adminBase !== '';
}

/**
 * Time-aware Italian greeting for the given hour of day (0-23).
 * @param {unknown} hour
 */
export function greetingForHour(hour) {
  if (typeof hour !== 'number' || !Number.isFinite(hour)) return 'Buongiorno';
  if (hour >= 5 && hour < 12) return 'Buongiorno';
  if (hour >= 12 && hour < 18) return 'Buon pomeriggio';
  return 'Buonasera';
}

/**
 * The date line above the greeting, in Italian ("Lunedì 19 ottobre").
 * Always the real current date — never a fixed showcase date.
 * @param {Date} [now]
 */
export function oggiDateLine(now = new Date()) {
  const text = new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Links to the screens that are already delivered: the shell's available
 * voices, minus Oggi itself (the open screen). Disabled voices stay out —
 * they name the story that delivers them in the sidebar already, and the
 * home must never link a screen that is not there.
 * @param {Array<{ id?: unknown, label?: unknown, route?: unknown, available?: unknown }>} shellItems
 */
export function buildOggiLinks(shellItems) {
  if (!Array.isArray(shellItems)) return [];
  const links = [];
  for (const item of shellItems) {
    if (item == null || item.id === 'oggi') continue;
    if (item.available !== true) continue;
    if (typeof item.route !== 'string' || item.route === '') continue;
    if (typeof item.label !== 'string' || item.label === '') continue;
    links.push({ id: item.id, label: item.label, route: item.route });
  }
  return links;
}

/**
 * @param {object} doc DOM document (real or fake).
 * @param {string} tag
 * @param {string} [className]
 * @param {string} [text]
 */
function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.setAttribute('class', className);
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Render the Oggi frame into the given mount: date line, greeting with the
 * space name, and one link per delivered screen. No counts, no recap, no
 * tasks — everything BO-F3-04 has not delivered yet stays out, instead of
 * showing invented data.
 *
 * @param {{
 *   doc: object,
 *   mount: object,
 *   spaceName?: unknown,
 *   links?: Array<{ id: unknown, label: string, route: string }>,
 *   navigate?: (hash: string) => void,
 *   now?: Date,
 * }} options
 */
export function renderOggi({
  doc,
  mount,
  spaceName = '',
  links = [],
  navigate = () => {},
  now = new Date(),
} = {}) {
  while (mount.firstChild) mount.removeChild(mount.firstChild);
  const name = typeof spaceName === 'string' && spaceName !== '' ? spaceName : 'il tuo spazio';
  const hour = now instanceof Date ? now.getHours() : NaN;

  mount.appendChild(el(doc, 'p', 'bo-kicker', oggiDateLine(now)));
  mount.appendChild(el(doc, 'h2', undefined, `${greetingForHour(hour)}, ${name}`));
  mount.appendChild(el(
    doc,
    'p',
    'bo-muted',
    'Le schermate pronte del tuo spazio, in un posto solo.',
  ));

  // Same rows as the Impostazioni screen: no new stylesheet needed, and the
  // home automatically matches the backoffice look.
  const list = el(doc, 'div', 'bo-settings');
  for (const link of links) {
    if (link == null || typeof link.label !== 'string' || typeof link.route !== 'string') continue;
    const row = el(doc, 'div', 'bo-setting-row');
    row.appendChild(el(doc, 'span', 'bo-setting-label', link.label));
    const anchor = el(doc, 'a', 'bo-setting-link', 'Apri');
    anchor.setAttribute('href', link.route);
    anchor.addEventListener('click', (event) => {
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      navigate(link.route);
    });
    row.appendChild(anchor);
    list.appendChild(row);
  }
  if (list.childNodes.length === 0) {
    list.appendChild(el(
      doc,
      'p',
      'bo-muted',
      'Nessuna schermata pronta oltre a questa: le voci in arrivo sono nella barra laterale.',
    ));
  }
  mount.appendChild(list);
}
