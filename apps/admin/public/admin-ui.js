// @ts-check

// BO-F6-02 — the one component library for the /bo backoffice
// (`apps/admin/public`). Every backoffice view renders its controls through
// `el`/`elFor` below or through the builders, so every button, select, input
// and textarea on screen carries a `ui-*` system class from the single
// stylesheet (`styles.css`, `/* BO-F6-02 visual system */` section).
//
// The geometry follows the approved prototype (shots-2026-10-24, 24/10):
// dark primary for the main action, green CTA for the accord-producing
// action, secondary for ordinary work, refusal/danger for rejections and
// faults; underlined tabs, the I tuoi/Scopri segmented control, channel
// chips, cards, tables, search with icon, selects, switches, authority
// badges (agent/policy/human/evidence/accord — red for faults only), toasts
// and empty states. Sidebar icons ship here too (BO-F6-01 owns the shell
// look; the icons are pure additions).
//
// Migration contract: views keep their legacy classes as hooks (tests and
// layout rely on them). `normalizeControlClass` maps each legacy control
// class to its system class and appends the system default when a control
// arrives with none, so a legacy call site can never render a raw control
// again. New code uses the builders directly. Like every admin view: values
// travel as text, never HTML, so hostile data stays inert text.

// System classes, frozen: the enforcement test pins the `ui-` prefix.
export const UI_PREFIX = 'ui-';

const CONTROL_TAGS = new Set(['button', 'select', 'input', 'textarea']);

/** Button variants the prototype settles. */
export const UI_BUTTON_VARIANTS = Object.freeze(['primary', 'cta', 'secondary', 'refusal', 'danger']);

/** Authorities that own a record: agent, policy(pending), human, evidence, accord. Red is faults only. */
export const UI_AUTHORITIES = Object.freeze(['agent', 'pending', 'human', 'evidence', 'accord', 'data']);

/** Channel chips of the prototype: IG WA TEL @ CAL S FB TT WEB (Form sito). */
export const UI_CHANNELS = Object.freeze(['IG', 'WA', 'TEL', '@', 'CAL', 'S', 'FB', 'TT', 'WEB']);

const CHANNEL_TINT = Object.freeze({
  IG: 'ui-chip-ig',
  WA: 'ui-chip-wa',
  TEL: 'ui-chip-tel',
  '@': 'ui-chip-at',
  CAL: 'ui-chip-cal',
  S: 'ui-chip-s',
  FB: 'ui-chip-fb',
  TT: 'ui-chip-tt',
  WEB: 'ui-chip-web',
});

/**
 * Legacy control classes mapped to their system class. A legacy call site
 * keeps its own classes (hooks + layout); the system class is added beside
 * them. Only paint-equivalent mappings live here: the accord-producing
 * actions map to CTA green, the ordinary main action to dark primary,
 * everything else to secondary, rejections to refusal. Sites the table
 * does not name get the safe default (secondary), never an invented green.
 */
const LEGACY_BUTTON_MAP = Object.freeze({
  // Plain 'primary' is the ordinary main action (dark), never the
  // accord-producing CTA: only uiButton({ variant: 'cta' }) paints green.
  primary: 'ui-btn ui-btn-primary',
  approve: 'ui-btn ui-btn-cta',
  accept: 'ui-btn ui-btn-cta',
  'marketing-approve': 'ui-btn ui-btn-cta',
  secondary: 'ui-btn ui-btn-secondary',
  retry: 'ui-btn ui-btn-secondary',
  resolve: 'ui-btn ui-btn-secondary',
  complete: 'ui-btn ui-btn-secondary',
  activate: 'ui-btn ui-btn-secondary',
  'apply-decisions': 'ui-btn ui-btn-secondary',
  'bo-assistant-send': 'ui-btn ui-btn-primary',
  danger: 'ui-btn ui-btn-danger',
  reject: 'ui-btn ui-btn-refusal',
  small: 'ui-btn-small',
  'icon-button': 'ui-btn ui-btn-icon',
  'bo-clienti-item': 'ui-chip',
  'bo-clienti-chipx': 'ui-chip',
  'bo-clienti-view': 'ui-tab',
  'bo-clienti-menubutton': 'ui-btn ui-btn-secondary',
  'bo-clienti-page': 'ui-btn ui-btn-secondary',
  'bo-clienti-size': 'ui-btn ui-btn-secondary',
  'bo-clienti-clear': 'ui-btn ui-btn-secondary',
  'bo-clienti-ai': 'ui-btn ui-btn-secondary',
});

const DEFAULT_BUTTON_CLASS = 'ui-btn ui-btn-secondary';
const DEFAULT_FIELD_CLASS = 'ui-field';

/**
 * Normalize the class list of a control tag: keep every incoming class,
 * translate known legacy classes, and guarantee at least one `ui-*`
 * control class. An explicit system class is never doubled.
 *
 * @param {string} tag
 * @param {unknown} className
 */
export function normalizeControlClass(tag, className) {
  const incoming = String(className ?? '').split(/\s+/).filter(Boolean);
  const out = [...incoming];
  const hasSystem = (prefix) => out.some((cls) => cls === 'ui' || cls.startsWith(prefix));
  if (tag === 'button') {
    for (const cls of incoming) {
      const mapped = LEGACY_BUTTON_MAP[cls];
      if (mapped) {
        for (const piece of mapped.split(' ')) {
          if (piece && !out.includes(piece)) out.push(piece);
        }
      }
    }
    if (out.some((cls) => cls.startsWith('ui-btn-')) && !out.includes('ui-btn')) out.unshift('ui-btn');
    if (!hasSystem('ui-btn') && !hasSystem('ui-chip') && !hasSystem('ui-tab') && !hasSystem('ui-seg')) {
      out.push(...DEFAULT_BUTTON_CLASS.split(' '));
    }
  } else if (CONTROL_TAGS.has(tag)) {
    if (!hasSystem('ui-')) out.push(DEFAULT_FIELD_CLASS);
  }
  return out.join(' ');
}

function optionClass(options) {
  return options.className ?? options.class ?? options.cls;
}

function applyOptions(node, options) {
  if (optionClass(options)) node.setAttribute('class', optionClass(options));
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  return node;
}

/**
 * Create an element, normalizing controls onto the visual system. Accepts
 * the (doc, tag, className, text) shape and the (doc, tag, options) shape
 * used across the migrated views.
 *
 * @param {any} doc
 * @param {string} tag
 * @param {string | { text?: unknown, className?: unknown, class?: unknown, cls?: unknown, attrs?: Record<string, unknown> } | null | undefined} classNameOrOptions
 * @param {unknown} [text]
 */
export function el(doc, tag, classNameOrOptions, text) {
  const node = doc.createElement(tag);
  const name = String(tag).toLowerCase();
  if (classNameOrOptions !== null && typeof classNameOrOptions === 'object') {
    const options = classNameOrOptions;
    const cls = CONTROL_TAGS.has(name)
      ? normalizeControlClass(name, optionClass(options))
      : String(optionClass(options) ?? '');
    applyOptions(node, { ...options, className: cls || undefined });
    return node;
  }
  if (CONTROL_TAGS.has(name)) {
    const cls = normalizeControlClass(name, classNameOrOptions);
    if (cls) node.setAttribute('class', cls);
  } else if (classNameOrOptions) {
    node.setAttribute('class', String(classNameOrOptions));
  }
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

/**
 * Closure form for views whose local helper captured `doc`:
 * `const el = elFor(doc)` then `el('button', 'legacy-class', 'Label')`.
 *
 * @param {any} doc
 */
export function elFor(doc) {
  return (tag, className, text) => el(doc, tag, className, text);
}

// ---------------------------------------------------------------------------
// Icons (sidebar + search + chevrons + states). Decorative, always
// aria-hidden: the visible label beside them names the action.
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = Object.freeze({
  oggi: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  clienti: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  pipeline: '<path d="M3 5h18l-7 8v6l-4 2v-8L3 5z"/>',
  calendario: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
  sequenze: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  reporting: '<path d="M12 20V10M18 20V4M6 20v-4"/>',
  nuovo: '<circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/>',
  impostazioni: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5M21 12H9"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>',
  chevron: '<path d="M6 9l6 6 6-6"/>',
  check: '<path d="M20 6L9 17l-5-5"/>',
  x: '<path d="M18 6L6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
});

export const UI_ICONS = Object.freeze(Object.keys(ICON_PATHS));

/**
 * Decorative stroke icon. Uses createElementNS where the document offers it
 * (real browsers paint SVG); the dependency-free fake DOM has no namespace
 * API, so tests assert the element contract and the browser asserts paint.
 *
 * @param {any} doc
 * @param {string} name
 */
export function uiIcon(doc, name) {
  // Unknown ids (custom modules) get the neutral 'new' glyph, never another
  // screen's icon: reusing Oggi's sun would paint a false meaning.
  const paths = ICON_PATHS[name] ?? ICON_PATHS.nuovo;
  const canNamespace = doc && typeof doc.createElementNS === 'function';
  const svg = canNamespace
    ? doc.createElementNS(SVG_NS, 'svg')
    : doc.createElement('svg');
  svg.setAttribute('class', `ui-icon ui-icon-${name}`);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  if (canNamespace) {
    const wrap = doc.createElementNS(SVG_NS, 'g');
    for (const part of paths.match(/<(circle|rect|path)[^>]*\/>/g) ?? []) {
      const tag = part.startsWith('<circle') ? 'circle' : part.startsWith('<rect') ? 'rect' : 'path';
      const piece = doc.createElementNS(SVG_NS, tag);
      for (const [, key, value] of part.matchAll(/([\w-]+)="([^"]*)"/g)) piece.setAttribute(key, value);
      wrap.appendChild(piece);
    }
    svg.appendChild(wrap);
  } else {
    svg.setAttribute('data-paths', paths);
  }
  return svg;
}

// ---------------------------------------------------------------------------
// Builders: new code calls these directly; migrated views reach the same
// classes through `el` normalization.
// ---------------------------------------------------------------------------

/**
 * @param {any} doc
 * @param {{ variant?: string, label?: unknown, small?: boolean, attrs?: Record<string, unknown> }} [options]
 */
export function uiButton(doc, options = {}) {
  const variant = UI_BUTTON_VARIANTS.includes(options.variant) ? options.variant : 'secondary';
  const node = doc.createElement('button');
  node.setAttribute('class', `ui-btn ui-btn-${variant}${options.small ? ' ui-btn-small' : ''}`);
  if (options.label !== undefined && options.label !== null) node.textContent = String(options.label);
  for (const [key, value] of Object.entries(options.attrs ?? {})) {
    if (value !== undefined && value !== null) node.setAttribute(key, String(value));
  }
  return node;
}

/** @param {any} doc @param {unknown} label */
export function uiSecondaryButton(doc, label) {
  return uiButton(doc, { variant: 'secondary', label });
}

/**
 * Underlined tabs (prototype: Personalizzazione active, the rest plain).
 *
 * @param {any} doc
 * @param {Array<{ id: string, label: unknown, active?: boolean }>} items
 */
export function uiTabs(doc, items) {
  const bar = doc.createElement('div');
  bar.setAttribute('class', 'ui-tabs');
  bar.setAttribute('role', 'tablist');
  for (const item of items) {
    const tab = el(doc, 'button', `ui-tab${item.active ? ' active' : ''}`, item.label);
    tab.setAttribute('role', 'tab');
    tab.setAttribute('data-tab', item.id);
    if (item.active) tab.setAttribute('aria-selected', 'true');
    bar.appendChild(tab);
  }
  return bar;
}

/**
 * Segmented control (prototype: I tuoi / Scopri).
 *
 * @param {any} doc
 * @param {Array<{ id: string, label: unknown, active?: boolean }>} items
 */
export function uiSegmented(doc, items) {
  const group = doc.createElement('div');
  group.setAttribute('class', 'ui-segmented');
  group.setAttribute('role', 'group');
  for (const item of items) {
    const option = el(doc, 'button', `ui-seg${item.active ? ' active' : ''}`, item.label);
    option.setAttribute('data-seg', item.id);
    if (item.active) option.setAttribute('aria-pressed', 'true');
    group.appendChild(option);
  }
  return group;
}

/**
 * @param {any} doc
 * @param {string} channel one of UI_CHANNELS
 */
export function uiChannelChip(doc, channel) {
  const tint = CHANNEL_TINT[channel] ?? 'ui-chip-plain';
  const chip = doc.createElement('span');
  chip.setAttribute('class', `ui-chip ${tint}`);
  chip.textContent = String(channel);
  return chip;
}

/**
 * @param {any} doc
 * @param {{ authority?: string, text?: unknown }} [options]
 */
export function uiBadge(doc, options = {}) {
  const authority = UI_AUTHORITIES.includes(options.authority) ? options.authority : 'pending';
  const badge = doc.createElement('span');
  badge.setAttribute('class', `ui-badge ui-badge-${authority}`);
  if (options.text !== undefined && options.text !== null) badge.textContent = String(options.text);
  return badge;
}

/**
 * @param {any} doc
 * @param {{ title?: unknown, children?: Array<any>, className?: unknown }} [options]
 */
export function uiCard(doc, options = {}) {
  const card = doc.createElement('section');
  let cls = 'ui-card';
  if (options.className) cls += ` ${options.className}`;
  card.setAttribute('class', cls);
  if (options.title !== undefined && options.title !== null) {
    const heading = doc.createElement('h2');
    heading.setAttribute('class', 'ui-card-title');
    heading.textContent = String(options.title);
    card.appendChild(heading);
  }
  for (const child of options.children ?? []) card.appendChild(child);
  return card;
}

/**
 * @param {any} doc
 * @param {{ columns?: Array<unknown>, rows?: Array<Array<unknown>>, caption?: unknown }} [options]
 */
export function uiTable(doc, options = {}) {
  const table = doc.createElement('table');
  table.setAttribute('class', 'ui-table');
  if (options.caption !== undefined && options.caption !== null) {
    const caption = doc.createElement('caption');
    caption.textContent = String(options.caption);
    table.appendChild(caption);
  }
  const head = doc.createElement('thead');
  const headRow = doc.createElement('tr');
  for (const column of options.columns ?? []) {
    const cell = doc.createElement('th');
    cell.setAttribute('scope', 'col');
    cell.textContent = String(column ?? '');
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  table.appendChild(head);
  const body = doc.createElement('tbody');
  for (const row of options.rows ?? []) {
    const line = doc.createElement('tr');
    for (const cell of row ?? []) {
      const data = doc.createElement('td');
      data.textContent = String(cell ?? '');
      line.appendChild(data);
    }
    body.appendChild(line);
  }
  table.appendChild(body);
  return table;
}

/**
 * Search field with icon (prototype: Cerca with magnifier).
 *
 * @param {any} doc
 * @param {{ placeholder?: unknown, value?: unknown, name?: string }} [options]
 */
export function uiSearchField(doc, options = {}) {
  const wrap = doc.createElement('div');
  wrap.setAttribute('class', 'ui-search');
  wrap.appendChild(uiIcon(doc, 'search'));
  const input = el(doc, 'input', 'ui-field ui-search-input', undefined);
  input.setAttribute('type', 'search');
  if (options.name) input.setAttribute('name', options.name);
  if (options.placeholder !== undefined && options.placeholder !== null) {
    input.setAttribute('placeholder', String(options.placeholder));
  }
  if (options.value !== undefined && options.value !== null) input.value = String(options.value);
  wrap.appendChild(input);
  return wrap;
}

/**
 * @param {any} doc
 * @param {{ name?: string, options?: Array<{ value: string, label: unknown }>, value?: string }} [options]
 */
export function uiSelect(doc, options = {}) {
  const wrap = doc.createElement('span');
  wrap.setAttribute('class', 'ui-select');
  const select = el(doc, 'select', 'ui-field', undefined);
  if (options.name) select.setAttribute('name', options.name);
  for (const option of options.options ?? []) {
    const item = doc.createElement('option');
    item.setAttribute('value', option.value);
    item.textContent = String(option.label ?? option.value);
    if (option.value === options.value) item.setAttribute('selected', 'selected');
    select.appendChild(item);
  }
  wrap.appendChild(select);
  wrap.appendChild(uiIcon(doc, 'chevron'));
  return wrap;
}

/**
 * Switch (prototype: the toggle). A labelled checkbox: the input carries
 * the system class, so form sweeps never flag it.
 *
 * @param {any} doc
 * @param {{ name?: string, checked?: boolean, label?: unknown }} [options]
 */
export function uiSwitch(doc, options = {}) {
  const label = doc.createElement('label');
  label.setAttribute('class', 'ui-switch');
  const input = el(doc, 'input', 'ui-switch-input', undefined);
  input.setAttribute('type', 'checkbox');
  if (options.name) input.setAttribute('name', options.name);
  if (options.checked) input.setAttribute('checked', 'checked');
  label.appendChild(input);
  const track = doc.createElement('span');
  track.setAttribute('class', 'ui-switch-track');
  track.setAttribute('aria-hidden', 'true');
  label.appendChild(track);
  if (options.label !== undefined && options.label !== null) {
    const text = doc.createElement('span');
    text.setAttribute('class', 'ui-switch-label');
    text.textContent = String(options.label);
    label.appendChild(text);
  }
  return label;
}

/**
 * @param {any} doc
 * @param {{ title?: unknown, text?: unknown }} [options]
 */
export function uiEmpty(doc, options = {}) {
  const box = doc.createElement('div');
  box.setAttribute('class', 'ui-empty');
  const title = doc.createElement('strong');
  title.textContent = String(options.title ?? '');
  box.appendChild(title);
  if (options.text !== undefined && options.text !== null) {
    const text = doc.createElement('span');
    text.textContent = String(options.text);
    box.appendChild(text);
  }
  return box;
}

/**
 * @param {any} doc
 * @param {{ text?: unknown, error?: boolean }} [options]
 */
export function uiToast(doc, options = {}) {
  const toast = doc.createElement('div');
  toast.setAttribute('class', `ui-toast${options.error ? ' error' : ''}`);
  toast.textContent = String(options.text ?? '');
  return toast;
}

/**
 * @param {any} doc
 * @param {{ title?: unknown }} [options]
 */
export function uiSection(doc, options = {}) {
  const section = doc.createElement('section');
  section.setAttribute('class', 'ui-section');
  const heading = doc.createElement('h2');
  heading.setAttribute('class', 'ui-section-title');
  heading.textContent = String(options.title ?? '');
  section.appendChild(heading);
  return section;
}

/**
 * Labelled secret field (tokens travel as password inputs, never text).
 *
 * @param {any} doc
 * @param {{ name?: string, label?: unknown, hint?: unknown }} [options]
 */
export function uiSecretField(doc, options = {}) {
  const wrap = doc.createElement('div');
  wrap.setAttribute('class', 'ui-field-row');
  if (options.label !== undefined && options.label !== null) {
    const label = doc.createElement('label');
    label.setAttribute('class', 'ui-label');
    label.textContent = String(options.label);
    wrap.appendChild(label);
  }
  const input = el(doc, 'input', 'ui-field', undefined);
  input.setAttribute('type', 'password');
  input.setAttribute('autocomplete', 'new-password');
  if (options.name) input.setAttribute('name', options.name);
  wrap.appendChild(input);
  if (options.hint !== undefined && options.hint !== null) {
    const hint = doc.createElement('span');
    hint.setAttribute('class', 'ui-hint');
    hint.textContent = String(options.hint);
    wrap.appendChild(hint);
  }
  return wrap;
}
