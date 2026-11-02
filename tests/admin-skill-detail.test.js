// @ts-check

/**
 * Backoffice BO-F4-02 — dettaglio skill (backlog:c73c6ec83643).
 *
 * What it must prove: the route parses `#/personalizzazione/skill/<slug>`
 * and keeps hostile hashes invalid; EVERY section of the detail names the
 * SAME skill unit (`skill:<slug>`, the key the space-package rows carry);
 * the shown definition IS the kernel's native package format with its
 * declared capability — the `requires` values repeat the catalog entry
 * (which repeats the SKILL.md frontmatter word for word) verbatim, and this
 * suite proves it against the real SPACE_PACKAGE_CATALOG; the six-step cycle
 * cites the repo file and the verbatim string that declares each step, and
 * this suite proves the string is really there in EVERY catalog skill; the
 * connectors list only declared uses (same proof); the copyable prompt names
 * real bundle commands, proved against docs/BUNDLES.md; hostile server text
 * stays text; an unknown skill renders an honest note without ever fetching
 * for it. DOM-free builders plus the fake document — no browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPACE_PACKAGE_CATALOG } from '../packages/space-permissions/src/composition.js';
import {
  codingPrompt,
  connectorsForSkill,
  createSkillDetailView,
  detailSections,
  exampleSection,
  isSkillDetailSlug,
  skillActivation,
  skillCycle,
  skillDefinition,
  skillEntryFor,
  skillRules,
  skillUnitName,
} from '../apps/admin/public/admin-skill-detail.js';
import { parseModuleRoute } from '../apps/admin/public/admin-core.js';
import { createFakeDocument, createMount } from './helpers/fake-dom.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => { setImmediate(resolve); });
};

/** Every skill unit the kernel publishes, `skill:<slug>`. */
const SKILL_ENTRIES = SPACE_PACKAGE_CATALOG.filter((entry) => entry.kind === 'skill');

/** The on-disk SKILL.md for a catalog slug (portable bundle, else the harness source). */
function skillFileFor(slug) {
  const published = join(ROOT, 'skills', slug, 'SKILL.md');
  try {
    if (statSync(published).isFile()) return published;
  } catch {
    // Fall through to the harness source below.
  }
  return join(ROOT, '.claude/skills', slug, 'SKILL.md');
}

test('the detail route parses, hostile hashes stay invalid', () => {
  assert.deepEqual(parseModuleRoute('#/personalizzazione'), { view: 'personalizzazione' });
  assert.deepEqual(
    parseModuleRoute('#/personalizzazione/skill/debug-crm-run'),
    { view: 'skill-detail', skill: 'debug-crm-run' },
  );
  // Unknown but well-formed slugs reach the detail view, which renders an
  // honest "unknown skill" note without ever fetching for them.
  assert.deepEqual(
    parseModuleRoute('#/personalizzazione/skill/altro'),
    { view: 'skill-detail', skill: 'altro' },
  );
  // Hostile hashes never become a lookup.
  assert.equal(parseModuleRoute('#/personalizzazione/skill/%2fetc').view, 'invalid');
  assert.equal(parseModuleRoute('#/personalizzazione/skill/%2e%2e').view, 'invalid');
  assert.equal(parseModuleRoute('#/personalizzazione/skill/a/b').view, 'invalid');
  assert.equal(parseModuleRoute('#/personalizzazione/altro').view, 'invalid');
  // The grammar helper agrees with the router on the same inputs.
  assert.ok(isSkillDetailSlug('debug-crm-run'));
  assert.ok(!isSkillDetailSlug('altro/../x'));
  assert.ok(!isSkillDetailSlug(''));
  assert.ok(!isSkillDetailSlug(null));
  assert.ok(!isSkillDetailSlug('__proto__'));
});

test('every catalog skill resolves to its kernel entry by unit name', () => {
  assert.ok(SKILL_ENTRIES.length > 0, 'the kernel publishes at least one skill');
  const units = SKILL_ENTRIES.map((entry) => entry.name);
  assert.deepEqual([...units].sort(), [...new Set(units)].sort(), 'skill unit names are unique');
  for (const entry of SKILL_ENTRIES) {
    const slug = entry.name.slice('skill:'.length);
    assert.equal(skillUnitName(slug), entry.name);
    assert.equal(skillEntryFor(SPACE_PACKAGE_CATALOG, slug), entry);
    assert.ok(typeof entry.requires?.tier === 'string' && entry.requires.tier !== '', `${entry.name} declares a tier`);
    assert.ok(typeof entry.requires?.command === 'string' && entry.requires.command !== '', `${entry.name} declares a command`);
  }
  // Unknown slugs invent nothing.
  assert.equal(skillEntryFor(SPACE_PACKAGE_CATALOG, 'altro'), null);
  assert.equal(skillEntryFor(null, 'debug-crm-run'), null);
});

test('activation reads the space-package rows, never invents a state', () => {
  const entry = skillEntryFor(SPACE_PACKAGE_CATALOG, 'debug-crm-run');
  assert.equal(skillActivation(entry, [{ unit: 'skill:debug-crm-run', status: 'active', spaceId: 'presti' }], 'presti'), 'attiva');
  assert.equal(skillActivation(entry, [{ unit: 'skill:debug-crm-run', status: 'draft', spaceId: 'presti' }], 'presti'), 'da-attivare');
  assert.equal(skillActivation(entry, [], 'presti'), 'da-attivare');
  assert.equal(skillActivation(entry, null, 'presti'), 'da-attivare');
  assert.equal(skillActivation(null, [], 'presti'), 'sconosciuta');
});

test('one space row never decides another space displayed state', () => {
  const entry = skillEntryFor(SPACE_PACKAGE_CATALOG, 'debug-crm-run');
  const rows = [
    { unit: 'skill:debug-crm-run', status: 'active', spaceId: 'spazio-a' },
    { unit: 'skill:debug-crm-run', status: 'draft', spaceId: 'spazio-b' },
  ];
  assert.equal(skillActivation(entry, rows, 'spazio-a'), 'attiva');
  assert.equal(skillActivation(entry, rows, 'spazio-b'), 'da-attivare');
  // A row without a space never counts: fail closed, never another space.
  assert.equal(skillActivation(entry, [{ unit: 'skill:debug-crm-run', status: 'active' }], 'spazio-b'), 'da-attivare');
  // Without a selected space the state is unknown, not another space's.
  assert.equal(skillActivation(entry, rows, ''), 'sconosciuta');
  assert.equal(skillActivation(entry, rows, null), 'sconosciuta');
  assert.equal(skillActivation(entry, rows, undefined), 'sconosciuta');
});

test('the six-step cycle cites the file and the verbatim string that declares it', () => {
  const steps = skillCycle('debug-crm-run');
  assert.equal(steps.length, 6, 'the working cycle is six steps, like the prototype');
  assert.deepEqual(steps.map((step) => step.n), [1, 2, 3, 4, 5, 6]);
  for (const step of steps) {
    assert.ok(typeof step.text === 'string' && step.text !== '', `step ${step.n} says something`);
    assert.ok(typeof step.evidence?.file === 'string' && typeof step.evidence?.needle === 'string');
  }
  // Every catalog skill really declares every cited string: no step is
  // invented copy and no skill renders a cycle it does not declare.
  for (const entry of SKILL_ENTRIES) {
    const slug = entry.name.slice('skill:'.length);
    const body = readFileSync(skillFileFor(slug), 'utf8');
    for (const step of skillCycle(slug)) {
      assert.equal(step.evidence.file, `skills/${slug}/SKILL.md`);
      assert.ok(
        body.includes(step.evidence.needle),
        `${entry.name} does not declare «${step.evidence.needle}» cited by cycle step ${step.n}`,
      );
    }
  }
});

test('the rules repeat the kernel entry, never invented copy', () => {
  for (const entry of SKILL_ENTRIES) {
    const rules = skillRules(entry);
    assert.equal(rules.length, 4);
    const flat = rules.flatMap((rule) => rule.lines).join('\n');
    assert.ok(flat.includes(entry.requires.tier), `${entry.name} rules name the tier boundary`);
    assert.ok(flat.includes(entry.requires.command), `${entry.name} rules name the command gate`);
    assert.ok(flat.includes(entry.degradesTo), `${entry.name} rules name the declared fallback`);
  }
});

test('the shown definition is the native package format with its declared capability', () => {
  const authoring = readFileSync(join(ROOT, 'docs/PACKAGE_AUTHORING.md'), 'utf8');
  assert.ok(authoring.includes('domains.capability('), 'the kernel opens capabilities through domains.capability');
  for (const entry of SKILL_ENTRIES) {
    const slug = entry.name.slice('skill:'.length);
    const definition = skillDefinition(entry, slug);
    assert.equal(definition.unit, entry.name);
    assert.equal(definition.file, `skills/${slug}/SKILL.md`);
    const flat = definition.lines.join('\n');
    // The requires block repeats the kernel entry's values verbatim.
    assert.ok(flat.includes(`tier: '${entry.requires.tier}'`), `${entry.name} definition repeats its tier`);
    assert.ok(flat.includes(`command: '${entry.requires.command}'`), `${entry.name} definition repeats its command`);
    // The capability opening follows docs/PACKAGE_AUTHORING.md.
    assert.ok(flat.includes('requires: [{ package:'), `${entry.name} definition declares the capability`);
    assert.ok(flat.includes('domains.capability({'), `${entry.name} definition opens it the kernel way`);
    assert.ok(!flat.includes('pseudo'), `${entry.name} definition carries no pseudo-code`);
  }
});

test('the connectors list only declared uses', () => {
  for (const entry of SKILL_ENTRIES) {
    const slug = entry.name.slice('skill:'.length);
    for (const use of connectorsForSkill(slug)) {
      assert.ok(typeof use.connector === 'string' && use.connector !== '', `${entry.name} names a connector`);
      assert.ok(typeof use.label === 'string' && use.label !== '', `${entry.name} labels it`);
      assert.ok(use.evidence && typeof use.evidence.file === 'string' && typeof use.evidence.needle === 'string');
      const body = readFileSync(join(ROOT, use.evidence.file), 'utf8');
      assert.ok(
        body.includes(use.evidence.needle),
        `${entry.name} «${use.connector}» is not declared by «${use.evidence.needle}» in ${use.evidence.file}`,
      );
    }
  }
  // Skills that name no connector list none, honestly.
  assert.deepEqual(connectorsForSkill('debug-crm-run'), []);
  assert.deepEqual(connectorsForSkill('altro'), []);
});

test('the coding prompt names real bundle commands, never pseudo-code', () => {
  const bundles = readFileSync(join(ROOT, 'docs/BUNDLES.md'), 'utf8');
  for (const verb of ['plan', 'create', 'verify']) {
    assert.ok(bundles.includes(`bundle ${verb}`), `docs/BUNDLES.md documents bundle ${verb}`);
  }
  for (const entry of SKILL_ENTRIES) {
    const slug = entry.name.slice('skill:'.length);
    const prompt = codingPrompt(entry, slug);
    assert.ok(prompt.includes(`skill:${slug}`), `${entry.name} prompt names its unit`);
    assert.ok(prompt.includes('bundle plan'), `${entry.name} prompt plans a separate bundle`);
    assert.ok(prompt.includes('bundle create'), `${entry.name} prompt creates it`);
    assert.ok(prompt.includes('bundle verify'), `${entry.name} prompt proves installability`);
    assert.ok(prompt.includes('bundles/<nome>/'), `${entry.name} prompt versions under bundles/, never packages/`);
    assert.ok(prompt.includes('mai pseudo-codice'), `${entry.name} prompt promises the real format, never pseudo-code`);
  }
});

test('every section carries the same skill unit name', () => {
  const entry = skillEntryFor(SPACE_PACKAGE_CATALOG, 'debug-crm-run');
  const sections = detailSections({ entry, slug: 'debug-crm-run', activation: 'attiva', preview: null });
  const keys = ['intestazione', 'ciclo', 'regole', 'definizione', 'esempio', 'connettori', 'prompt'];
  assert.deepEqual(Object.keys(sections).sort(), [...keys].sort());
  for (const key of keys) {
    assert.equal(sections[key].unit, 'skill:debug-crm-run', `${key} carries the record unit`);
  }
  assert.ok(sections.intestazione.lines.some((line) => line.includes('attiva')));
  assert.ok(sections.ciclo.lines.some((line) => line.includes('app inspect --json')));
  assert.ok(sections.prompt.lines.some((line) => line.includes('bundle verify')));
});

test('the example with its trace reads the live preview, writes nothing', () => {
  const withPreview = exampleSection({
    unit: 'skill:debug-crm-run',
    preview: { headline: 'Canali: 1 riga. La Prova non scrive nulla.', counts: [{ module: 'channel-connection', count: 1 }] },
  });
  assert.equal(withPreview.unit, 'skill:debug-crm-run');
  assert.ok(withPreview.lines.some((line) => line.includes('Canali: 1 riga')));
  assert.ok(withPreview.lines.some((line) => line.includes('channel-connection: 1 riga')));
  const withoutPreview = exampleSection({ unit: 'skill:debug-crm-run', preview: null });
  assert.ok(withoutPreview.lines.some((line) => line.includes('Personalizzazione')));
});

function stubClient({ entry, rows = [], preview = null, calls = [], catalogError = null } = {}) {
  const units = entry
    ? [...SPACE_PACKAGE_CATALOG.filter((row) => row.name !== entry.name), entry]
    : SPACE_PACKAGE_CATALOG;
  return {
    async request(path) {
      calls.push(path);
      if (path === '/api/space-packages/catalog') {
        if (catalogError !== null) throw catalogError;
        return { units };
      }
      if (path.startsWith('/api/modules/space-package/records')) return { items: rows };
      if (path.startsWith('/api/space-packages/preview')) return preview;
      throw new Error(`unexpected request ${path}`);
    },
  };
}

test('the view renders all seven sections from the live catalog row', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const calls = [];
  const view = createSkillDetailView({
    doc,
    mount,
    client: stubClient({
      calls,
      rows: [{ unit: 'skill:debug-crm-run', status: 'active', spaceId: 'presti' }],
      preview: { headline: 'Canali: 1 riga. La Prova non scrive nulla.', counts: [] },
    }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('debug-crm-run');
  await flush();
  const text = mount.textContent;
  assert.ok(text.includes('Skill · Diagnosi'));
  assert.ok(text.includes('Ciclo di lavoro'));
  assert.ok(text.includes('Regole attivabili'));
  assert.ok(text.includes('Nel tuo progetto Accordo'));
  assert.ok(text.includes('Esempio con traccia'));
  assert.ok(text.includes('Connettori usati'));
  assert.ok(text.includes('Prompt per l’agente di coding'));
  assert.ok(text.includes('bundle verify'), 'the copyable prompt paints on the page');
  assert.ok(!calls.some((path) => path.includes('debug-crm-run') && !path.includes('unit=')),
    'the slug never becomes a bare request path');
});

test('the detail fetches rows filtered by the selected space, like Personalizzazione', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const calls = [];
  const view = createSkillDetailView({
    doc,
    mount,
    client: stubClient({
      calls,
      rows: [{ unit: 'skill:debug-crm-run', status: 'active', spaceId: 'spazio-a' }],
      preview: { headline: 'Canali: 1 riga. La Prova non scrive nulla.', counts: [] },
    }),
    storage: { getItem: () => 'spazio-b', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('debug-crm-run');
  await flush();
  const records = calls.filter((path) => path.startsWith('/api/modules/space-package/records'));
  assert.equal(records.length, 1, 'rows are read once');
  assert.ok(records[0].includes('filter.spaceId=spazio-b'), `rows are filtered by the selected space, got ${records[0]}`);
  assert.ok(!calls.some((path) => path.includes('limit=200')), 'no unfiltered read leaves');
  const text = mount.textContent;
  assert.ok(text.includes('da-attivare'), 'space A active row never shows as active in space B');
  assert.ok(!text.includes('Stato in questo spazio: attiva.'), 'no other space state is displayed');
});

test('without a selected space the detail reads no rows at all', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const calls = [];
  const view = createSkillDetailView({
    doc,
    mount,
    client: stubClient({ calls }),
    storage: { getItem: () => '', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('debug-crm-run');
  await flush();
  assert.deepEqual(calls, ['/api/space-packages/catalog'], 'only the catalog is read, never other spaces rows');
  assert.ok(mount.textContent.includes('sconosciuta'), 'the state reads unknown without a space');
});

test('an unknown skill renders an honest note without ever fetching for it', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const calls = [];
  const view = createSkillDetailView({
    doc,
    mount,
    client: stubClient({ calls }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('altro');
  await flush();
  assert.ok(mount.textContent.includes('Skill sconosciuta'));
  assert.deepEqual(calls, ['/api/space-packages/catalog'], 'only the catalog is read, never the unknown slug');
});

test('a hostile slug renders invalid without any request', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const calls = [];
  const view = createSkillDetailView({
    doc,
    mount,
    client: stubClient({ calls }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('../x');
  await flush();
  assert.ok(mount.textContent.includes('Percorso non valido'));
  assert.deepEqual(calls, [], 'no request leaves for a hostile slug');
});

test('hostile server text stays text on the page', async () => {
  const doc = createFakeDocument();
  const mount = createMount(doc);
  const hostile = skillEntryFor(SPACE_PACKAGE_CATALOG, 'debug-crm-run');
  const poisoned = { ...hostile, label: '<img src=x onerror=alert(1)>', blurb: '<script>alert(1)</script>' };
  const view = createSkillDetailView({
    doc,
    mount,
    client: stubClient({ entry: poisoned }),
    storage: { getItem: () => 'presti', setItem: () => {} },
    navigate: () => {},
  });
  await view.render('debug-crm-run');
  await flush();
  const html = mount.innerHTML ?? '';
  assert.ok(!html.includes('<img src=x'), 'the hostile label never becomes markup');
  assert.ok(!html.includes('<script>alert'), 'the hostile blurb never becomes markup');
  assert.ok(mount.textContent.includes('<img src=x'), 'the hostile label still reads as text');
});
