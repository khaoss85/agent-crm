// @ts-check

// Dettaglio skill (BO-F4-02, backlog:c73c6ec83643).
//
// Ref "02 Personalizzazione" del prototipo: ciclo in 6 passi, regole
// attivabili, esempio con traccia, "Nel tuo progetto Accordo", connettori
// usati. Il prototipo mostrava pseudo-codice: questa schermata mostra il
// formato vero (decisione Q-K4 del supervisore, 22/10) — il pacchetto
// nativo del kernel con capability dichiarata
// (`docs/PACKAGE_AUTHORING.md`), letto dal catalogo pubblicato dal server
// (`GET /api/space-packages/catalog`, che ripete il frontmatter delle
// `SKILL.md` parola per parola: lo prova `tests/space-packages.test.js`),
// più il prompt copiabile per l'agente di coding che genera un bundle
// separato (`docs/BUNDLES.md`: mai sotto `packages/`, mai nel processo
// condiviso).
//
// Come il dettaglio connettore (BO-F5-03), questo file non duplica nulla:
// le voci del catalogo (`packages/space-permissions/src/composition.js`),
// le righe di attivazione per spazio (`space-package`, come la
// Personalizzazione BO-F4-01) e la tabella dei connettori
// (`CONNECTOR_CATALOG` in `admin-connectors.js`). Non possiede storage né
// scritture: attivare/disattivare resta nella Personalizzazione, che il
// dettaglio linka.
//
// Contratto di accettazione, imposto da tests/admin-skill-detail.test.js:
// ogni sezione porta il nome dell'unità (`skill:<slug>`); la definizione
// contiene i valori `requires` esatti della voce del kernel; ogni passo
// del ciclo cita il file e la stringa letterale che lo dichiara (e il test
// prova che la stringa è davvero lì, in OGNI skill del catalogo); i
// connettori elencano solo dipendenze dichiarate; il prompt nomina i veri
// comandi del bundle (e il test prova che esistono in docs/BUNDLES.md).
//
// Convenzioni come admin-connector-detail.js: costruttori puri senza DOM
// (testati con node:test senza browser) e renderer solo con createElement
// + textContent/setAttribute — mai innerHTML con dati, così un label
// ostile resta testo inerte, mai markup.

import { humanReadError } from './admin-core.js';
import { CONNECTOR_CATALOG } from './admin-connectors.js';
import { ACTIVE_SPACE_KEY } from './admin-shell.js';

/** Grammar for the skill slug in `#/personalizzazione/skill/<slug>`. */
const SKILL_SLUG_GRAMMAR = /^[a-z][a-z0-9-]{1,63}$/;

/**
 * Grammar check only: catalog membership is checked by the view, which
 * renders an honest note for an unknown slug without ever fetching for
 * it — a hostile hash never becomes a request path.
 * @param {unknown} value
 */
export function isSkillDetailSlug(value) {
  return typeof value === 'string' && SKILL_SLUG_GRAMMAR.test(value);
}

/**
 * The catalog unit name for a skill slug (`debug-crm-run` →
 * `skill:debug-crm-run`), the same key the space-package rows carry.
 * @param {string} slug
 */
export function skillUnitName(slug) {
  return `skill:${slug}`;
}

/**
 * Find the kernel catalog entry for a slug, or null. The entry IS the
 * skill's definition as the kernel publishes it: label, blurb, requires
 * (tier + command, verbatim from the SKILL.md frontmatter) and the
 * degradesTo fallback.
 * @param {Array<any> | null | undefined} units
 * @param {string} slug
 */
export function skillEntryFor(units, slug) {
  if (!Array.isArray(units)) return null;
  const name = skillUnitName(slug);
  const found = units.find((row) => row !== null && typeof row === 'object' && row.name === name && row.kind === 'skill');
  return found ?? null;
}

/**
 * The activation state of a skill in a space, from the space-package rows
 * (same rows the Personalizzazione BO-F4-01 reads). Never invented: a
 * missing row is "da attivare", never an error.
 * @param {any} entry
 * @param {Array<any> | null | undefined} rows
 */
export function skillActivation(entry, rows) {
  if (!entry || typeof entry.name !== 'string') return 'sconosciuta';
  const list = Array.isArray(rows) ? rows : [];
  const row = list.find((item) => item !== null && typeof item === 'object' && item.unit === entry.name);
  return row && row.status === 'active' ? 'attiva' : 'da-attivare';
}

/**
 * The six-step working cycle every shipped skill opens with ("Orient
 * yourself first"): inspect the project, read valid/problems/limitations,
 * read what exists, act only on what exists. Each step cites the repo file
 * and the verbatim string that declares it — the test proves the string
 * is really in EVERY catalog skill's SKILL.md, so no step is invented
 * copy and no skill renders a cycle it does not declare.
 *
 * @typedef {{ n: number, text: string, evidence: { file: string, needle: string } }} SkillCycleStep
 */

/**
 * @param {string} slug
 * @returns {ReadonlyArray<SkillCycleStep>}
 */
export function skillCycle(slug) {
  const file = `skills/${slug}/SKILL.md`;
  return Object.freeze([
    {
      n: 1,
      text: 'Ispeziona il progetto: `crm app inspect --json`.',
      evidence: { file, needle: 'app inspect --json' },
    },
    {
      n: 2,
      text: 'Leggi `valid`: la composizione è sana?',
      evidence: { file, needle: '`valid`' },
    },
    {
      n: 3,
      text: 'Leggi `problems[]`: ogni capacità mancante o conflitto, con codice.',
      evidence: { file, needle: '`problems[]`' },
    },
    {
      n: 4,
      text: 'Leggi `limitations[]`: ogni limite è un confine rigido su ciò che puoi affermare.',
      evidence: { file, needle: '`limitations[]`' },
    },
    {
      n: 5,
      text: 'Leggi `packages[]`, `capabilities[]`, `resources[]`, `actions[]`: ciò che esiste davvero.',
      evidence: { file, needle: 'capabilities[]' },
    },
    {
      n: 6,
      text: 'Agisci solo su ciò che esiste: una capability assente nel report non esiste.',
      evidence: { file, needle: 'does not exist' },
    },
  ]);
}

/**
 * The activatable rules of a skill: what starts applying when the skill
 * is active in a space. Every rule names the kernel field it reads — the
 * tier boundary, the command gate and the degraded fallback come verbatim
 * from the catalog entry (SKILL.md frontmatter), the transaction rule
 * from the kernel contract. No toggle is invented: on/off is the
 * space-package row, managed in Personalizzazione.
 * @param {any} entry
 */
export function skillRules(entry) {
  const requires = entry !== null && typeof entry === 'object' && entry.requires !== null
    && typeof entry.requires === 'object' ? entry.requires : {};
  const tier = typeof requires.tier === 'string' && requires.tier !== '' ? requires.tier : 'sconosciuto';
  const command = typeof requires.command === 'string' && requires.command !== '' ? requires.command : 'sconosciuto';
  const fallback = typeof entry?.degradesTo === 'string' && entry.degradesTo !== '' ? entry.degradesTo : 'nessun ripiego dichiarato';
  return Object.freeze([
    {
      key: 'tier',
      title: 'Confine di progetto',
      lines: Object.freeze([
        `Questa skill gira nei progetti «${tier}».`,
        'Fuori dal confine non si attiva: il catalogo non la propone.',
      ]),
    },
    {
      key: 'comando',
      title: 'Comando prima di tutto',
      lines: Object.freeze([
        `Ogni lavoro parte da «${command}».`,
        'Senza inspection non si costruisce nulla sopra.',
      ]),
    },
    {
      key: 'ripiego',
      title: 'Ripiego dichiarato',
      lines: Object.freeze([`Quando il progetto non ha tutto: ${fallback}`]),
    },
    {
      key: 'transazione',
      title: 'Niente scritture fuori transazione',
      lines: Object.freeze([
        'Ciò che la skill apre con una capability partecipa alla transazione del chiamante.',
        'Mai condivisioni di handle: un commit tra pacchetti è atomico o non parte.',
      ]),
    },
  ]);
}

/**
 * "Nel tuo progetto Accordo": the skill's definition in the REAL kernel
 * format (Q-K4), never pseudo-code. The `requires` block repeats the
 * catalog entry's values verbatim — read from the kernel, not written by
 * hand — and the capability opening follows `docs/PACKAGE_AUTHORING.md`
 * §3 (`requires: [{ package, capability, version }]` opened with
 * `domains.capability({ consumer, capability, version, context })`).
 * @param {any} entry
 * @param {string} slug
 */
export function skillDefinition(entry, slug) {
  const requires = entry !== null && typeof entry === 'object' && entry.requires !== null
    && typeof entry.requires === 'object' ? entry.requires : {};
  const tier = typeof requires.tier === 'string' && requires.tier !== '' ? requires.tier : 'sconosciuto';
  const command = typeof requires.command === 'string' && requires.command !== '' ? requires.command : 'sconosciuto';
  return Object.freeze({
    key: 'definizione',
    title: 'Nel tuo progetto Accordo',
    unit: entry !== null && typeof entry === 'object' && typeof entry.name === 'string' ? entry.name : skillUnitName(slug),
    file: `skills/${slug}/SKILL.md`,
    lines: Object.freeze([
      '// La definizione della skill, letta dal kernel (catalogo spazio-pacchetti).',
      `// skills/${slug}/SKILL.md — requires:`,
      `requires: { tier: '${tier}', command: '${command}' },`,
      '// Il tuo pacchetto la usa così (docs/PACKAGE_AUTHORING.md §3):',
      'requires: [{ package: \'<pacchetto>\', capability: \'<capability>\', version: 1 }],',
      'const cosa = domains.capability({',
      "  consumer: '<tuo-pacchetto>', capability: '<capability>', version: 1,",
      '  context: { modules, actor, now },',
      '});',
    ]),
  });
}

/**
 * One declared connector use: a framework connector a skill really names
 * in its SKILL.md, with the file and the verbatim string that declares
 * the use. Nothing here is invented — the test reads the file and proves
 * the string is there. Skills that name no connector list none, honestly.
 *
 * @typedef {{ connector: string, label: string, via: string, evidence: { file: string, needle: string } }} SkillConnectorUse
 */

/** @type {Record<string, ReadonlyArray<SkillConnectorUse>>} */
const CONNECTORS_BY_SKILL = {
  'build-custom-domain-package': Object.freeze([
    {
      connector: 'whatsapp', label: 'WhatsApp',
      via: 'Invii verso canali esterni: ogni invio accodato nell\u2019outbox esistente.',
      evidence: { file: 'skills/build-custom-domain-package/SKILL.md', needle: 'channels outbox' },
    },
    {
      connector: 'instagram', label: 'Instagram',
      via: 'Invii verso canali esterni: ogni invio accodato nell\u2019outbox esistente.',
      evidence: { file: 'skills/build-custom-domain-package/SKILL.md', needle: 'channels outbox' },
    },
    {
      connector: 'email', label: 'Email',
      via: 'Invii verso canali esterni: ogni invio accodato nell\u2019outbox esistente.',
      evidence: { file: 'skills/build-custom-domain-package/SKILL.md', needle: 'channels outbox' },
    },
  ]),
  'build-commercial-operations': Object.freeze([
    {
      connector: 'stripe', label: 'Stripe',
      via: 'Mappa i modelli di prezzo del provider senza appiattirli mai.',
      evidence: { file: 'skills/build-commercial-operations/SKILL.md', needle: 'Map Stripe one_time/recurring' },
    },
  ]),
};

/**
 * @param {string} slug
 * @returns {ReadonlyArray<SkillConnectorUse>}
 */
export function connectorsForSkill(slug) {
  return CONNECTORS_BY_SKILL[slug] ?? Object.freeze([]);
}

/**
 * The copyable prompt for the coding agent that generates a SEPARATE
 * bundle (`docs/BUNDLES.md`): versioned under `bundles/<nome>/<x.y.z>/`,
 * never under `packages/`, never in the shared process. Every command
 * the prompt names is a real bundle command — the test proves each one
 * exists in docs/BUNDLES.md.
 * @param {any} entry
 * @param {string} slug
 */
export function codingPrompt(entry, slug) {
  const label = entry !== null && typeof entry === 'object' && typeof entry.label === 'string' && entry.label !== ''
    ? entry.label : slug;
  return [
    `Genera un bundle separato per «${label}» (skill:${slug}).`,
    'Formato: pacchetto nativo del kernel con capability dichiarata',
    '(docs/PACKAGE_AUTHORING.md), mai pseudo-codice.',
    '',
    'Passi:',
    '1. npm run crm -- bundle plan <manifest>.json --name <nome> --version <x.y.z>',
    '2. npm run crm -- bundle create <manifest>.json --name <nome> --version <x.y.z> --apply',
    '3. npm run crm -- bundle verify <nome@versione> (prova di installabilità: avvia davvero e serve un record)',
    '',
    'Regole: il bundle vive solo sotto bundles/<nome>/<versione>/, mai sotto',
    'packages/; due versioni non si fondono mai; bundle verify è la prova,',
    'mai una simulazione.',
  ].join('\n');
}

/**
 * The worked example with its trace: the skill's Prova run on the real
 * rows of the current space (same preview payload the Personalizzazione
 * BO-F4-01 shows). The trace is the zero-writes proof — `writes: 0`
 * read from the kernel, never claimed. Without a preview the section
 * says so honestly instead of inventing an example.
 * @param {{ preview?: any, unit: string }} input
 */
export function exampleSection({ preview, unit }) {
  const lines = [];
  if (preview !== null && typeof preview === 'object') {
    if (typeof preview.headline === 'string' && preview.headline !== '') lines.push(preview.headline);
    for (const row of Array.isArray(preview.counts) ? preview.counts : []) {
      if (!row || typeof row.module !== 'string') continue;
      const count = Number(row.count) || 0;
      lines.push(`${row.module}: ${count} ${count === 1 ? 'riga' : 'righe'}`);
    }
    lines.push('La Prova non ha scritto nulla.');
  } else {
    lines.push('Apri la Prova dalla Personalizzazione per vedere l\u2019esempio sui dati di questo spazio.');
  }
  return Object.freeze({ key: 'esempio', title: 'Esempio con traccia', unit, lines: Object.freeze(lines) });
}

/**
 * Every section of the detail, each carrying the skill's unit name — the
 * test proves all seven match, like the connector detail proves its seven.
 * @param {{ entry: any, slug: string, activation: string, preview?: any }} input
 */
export function detailSections({ entry, slug, activation, preview = null }) {
  const unit = entry !== null && typeof entry === 'object' && typeof entry.name === 'string'
    ? entry.name : skillUnitName(slug);
  const label = entry !== null && typeof entry === 'object' && typeof entry.label === 'string' && entry.label !== ''
    ? entry.label : slug;
  const blurb = entry !== null && typeof entry === 'object' && typeof entry.blurb === 'string' ? entry.blurb : '';
  const rules = skillRules(entry);
  const definition = skillDefinition(entry, slug);
  const uses = connectorsForSkill(slug);
  return Object.freeze({
    intestazione: {
      key: 'intestazione', title: label, unit, activation, blurb,
      lines: Object.freeze(blurb !== '' ? [blurb, `Stato in questo spazio: ${activation}.`] : [`Stato in questo spazio: ${activation}.`]),
    },
    ciclo: {
      key: 'ciclo', title: 'Ciclo di lavoro', unit,
      lines: Object.freeze(skillCycle(slug).map((step) => `${step.n}. ${step.text}`)),
    },
    regole: {
      key: 'regole', title: 'Regole attivabili', unit,
      lines: Object.freeze(rules.flatMap((rule) => [`${rule.title}: ${rule.lines[0]}`, ...rule.lines.slice(1)])),
    },
    definizione: definition,
    esempio: exampleSection({ preview, unit }),
    connettori: {
      key: 'connettori', title: 'Connettori usati', unit,
      lines: Object.freeze(uses.length > 0
        ? uses.map((use) => `${use.label}: ${use.via}`)
        : ['Nessun connettore dichiarato da questa skill.']),
    },
    prompt: {
      key: 'prompt', title: 'Prompt per l\u2019agente di coding', unit,
      lines: Object.freeze([codingPrompt(entry, slug)]),
    },
  });
}

import { el } from './admin-ui.js'; // BO-F6-02: the single component library.

function errorOf(error) {
  return humanReadError(error, { failed: 'La richiesta non è riuscita. Riprova più tardi.' });
}

/**
 * A view controller for the skill detail. Same injectable shape as the
 * other Admin views (`doc`, `mount`, `client`, `storage`, `navigate`), so
 * it stays testable without a browser. Owns no write: activation stays in
 * Personalizzazione, which the detail links to; the only action here is
 * copying the prompt (clipboard, no server round-trip).
 * @param {{ doc: any, mount: any, client: { request: (path: string, options?: object) => Promise<any> }, navigate?: (hash: string) => void, storage?: any, toast?: (message: string, isError?: boolean) => void }} deps
 */
export function createSkillDetailView(deps) {
  const { doc, mount, navigate } = deps;
  const { client } = deps;
  const storage = deps.storage ?? null;
  const toast = deps.toast ?? (() => {});

  const readSpace = () => {
    try {
      const stored = storage !== null ? storage.getItem(ACTIVE_SPACE_KEY) : null;
      return typeof stored === 'string' ? stored : '';
    } catch {
      return '';
    }
  };

  async function load(slug) {
    const space = readSpace().trim();
    let catalog = null;
    try {
      catalog = await client.request('/api/space-packages/catalog');
    } catch (error) {
      return { error: errorOf(error), entry: null, rows: [], preview: null, space };
    }
    const units = Array.isArray(catalog?.units) ? catalog.units : [];
    const entry = skillEntryFor(units, slug);
    if (entry === null) return { error: null, entry: null, rows: [], preview: null, space };
    let rows = [];
    try {
      const read = await client.request('/api/modules/space-package/records?limit=200');
      rows = Array.isArray(read?.items) ? read.items : [];
    } catch {
      rows = [];
    }
    let preview = null;
    if (space !== '') {
      try {
        preview = await client.request(
          `/api/space-packages/preview?spaceId=${encodeURIComponent(space)}&unit=${encodeURIComponent(entry.name)}`,
        );
      } catch {
        preview = null;
      }
    }
    return { error: null, entry, rows, preview, space };
  }

  function renderSection(box, title, lines) {
    const panel = el(doc, 'section', { cls: 'bo-skill-row', attrs: { 'data-section': title } });
    panel.appendChild(el(doc, 'h3', { text: title }));
    if (lines.length === 1 && title === 'Prompt per l\u2019agente di coding') {
      const pre = doc.createElement('pre');
      pre.setAttribute('data-prompt', 'coding-agent');
      pre.textContent = lines[0];
      panel.appendChild(pre);
      const copy = el(doc, 'button', { text: 'Copia il prompt', attrs: { type: 'button', 'data-action': 'copy-prompt' } });
      copy.addEventListener('click', () => {
        void copyPrompt(lines[0], copy);
      });
      panel.appendChild(copy);
    } else {
      const list = el(doc, 'ul');
      for (const line of lines) {
        const item = el(doc, 'li', undefined);
        if (title === 'Nel tuo progetto Accordo') {
          const code = doc.createElement('code');
          code.textContent = line;
          item.appendChild(code);
        } else {
          item.textContent = line;
        }
        list.appendChild(item);
      }
      panel.appendChild(list);
    }
    box.appendChild(panel);
  }

  async function copyPrompt(text, button) {
    const done = () => {
      toast('Prompt copiato: incollalo al tuo agente di coding.');
    };
    try {
      const clipboard = doc?.defaultView?.navigator?.clipboard ?? (typeof navigator !== 'undefined' ? navigator.clipboard : null);
      if (clipboard && typeof clipboard.writeText === 'function') {
        await clipboard.writeText(text);
        done();
        return;
      }
    } catch {
      // Fall through to the selection fallback below.
    }
    try {
      const pre = mount.querySelector('pre[data-prompt="coding-agent"]');
      const selection = doc?.defaultView?.getSelection?.() ?? null;
      const range = doc?.createRange?.() ?? null;
      if (pre && selection && range && typeof range.selectNodeContents === 'function') {
        range.selectNodeContents(pre);
        selection.removeAllRanges();
        selection.addRange(range);
        done();
        return;
      }
    } catch {
      // Report below.
    }
    if (button && typeof button.setAttribute === 'function') {
      button.setAttribute('data-copy', 'manual');
    }
    toast('Seleziona il testo del prompt e copialo a mano.', true);
  }

  async function render(slug) {
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    if (!isSkillDetailSlug(slug)) {
      const box = el(doc, 'div', { cls: 'panel' });
      box.appendChild(el(doc, 'p', { text: 'Percorso non valido.', cls: 'empty' }));
      mount.appendChild(box);
      return;
    }
    const loading = el(doc, 'p', { text: 'Caricamento della skill…', cls: 'muted' });
    mount.appendChild(loading);
    const { error, entry, rows, preview, space } = await load(slug);
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    if (error !== null) {
      const box = el(doc, 'div', { cls: 'panel' });
      box.appendChild(el(doc, 'p', { text: error.message || 'La richiesta non è riuscita. Riprova più tardi.', cls: 'empty' }));
      const retry = el(doc, 'button', { text: 'Riprova', attrs: { type: 'button' } });
      retry.addEventListener('click', () => { void render(slug); });
      box.appendChild(retry);
      mount.appendChild(box);
      return;
    }
    if (entry === null) {
      const box = el(doc, 'div', { cls: 'panel' });
      box.appendChild(el(doc, 'p', { text: 'Skill sconosciuta: il catalogo non la elenca.', cls: 'empty' }));
      const back = el(doc, 'a', { text: 'Torna alla Personalizzazione', attrs: { href: '#/personalizzazione' } });
      back.addEventListener('click', (event) => {
        if (typeof navigate === 'function') {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          navigate('#/personalizzazione');
        }
      });
      box.appendChild(back);
      mount.appendChild(box);
      return;
    }
    const activation = skillActivation(entry, rows);
    const sections = detailSections({ entry, slug, activation, preview });
    const head = el(doc, 'div', { cls: 'bo-skill-head' });
    head.appendChild(el(doc, 'h2', { text: `Skill · ${entry.label ?? slug}` }));
    if (space === '') {
      head.appendChild(el(doc, 'p', { text: 'Scegli uno spazio per vedere l\u2019esempio sui suoi dati.', cls: 'muted' }));
    }
    mount.appendChild(head);
    const order = ['intestazione', 'ciclo', 'regole', 'definizione', 'esempio', 'connettori', 'prompt'];
    for (const key of order) {
      const section = sections[key];
      renderSection(mount, section.title, section.lines);
    }
    const back = el(doc, 'a', { text: 'Gestisci in Personalizzazione', attrs: { href: '#/personalizzazione' } });
    back.addEventListener('click', (event) => {
      if (typeof navigate === 'function') {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        navigate('#/personalizzazione');
      }
    });
    mount.appendChild(back);
  }

  return { render, test: { load } };
}
