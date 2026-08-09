// @ts-check

/**
 * Validates the distribution manifests without submitting anything anywhere.
 *
 * Every listing artifact in this repository is *prepared*, not published: the public
 * name is undecided (docs/strategy/BRAND_REQUIREMENTS.md) and every external
 * submission is a human decision (docs/strategy/MASTER_PLAN.md §10.4). The point of
 * this script is that when a human does decide, the manifests are known-good rather
 * than a first draft written under launch pressure.
 *
 * It checks the things a marketplace would reject us for, plus the one thing a
 * marketplace would happily accept and we would regret: a manifest that has drifted
 * from the repository it describes.
 *
 * Run: npm run distribution:check
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const failures = [];
const notes = [];

/** Brand tokens gate publication, so they are read before anything is judged against them. */
const brand = JSON.parse(readFileSync(join(root, 'site/brand.json'), 'utf8'));

/** Manifests, and the paths inside them that must resolve on disk. */
const manifests = [
  { path: '.claude-plugin/plugin.json', pathFields: ['skills', 'mcpServers'] },
  { path: '.claude-plugin/marketplace.json', pathFields: [] },
  { path: '.claude-plugin/mcp.json', pathFields: [] },
  { path: '.codex-plugin/plugin.json', pathFields: ['skills', 'mcpServers'] },
  { path: '.codex-plugin/mcp.json', pathFields: [] },
  { path: '.agents/plugins/marketplace.json', pathFields: [] },
  { path: 'server.json', pathFields: [] },
];

/** @type {Map<string, any>} */
const loaded = new Map();

for (const manifest of manifests) {
  const full = join(root, manifest.path);
  if (!existsSync(full)) {
    fail(`${manifest.path}: missing`);
    continue;
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    fail(`${manifest.path}: invalid JSON — ${error.message}`);
    continue;
  }
  loaded.set(manifest.path, parsed);

  for (const field of manifest.pathFields) {
    const value = parsed[field];
    if (typeof value !== 'string') continue;
    const target = join(root, value.replace(/^\.\//, ''));
    if (!existsSync(target)) fail(`${manifest.path}: ${field} points at ${value}, which does not exist`);
  }
}

// ---------------------------------------------------------------- required fields

const claudePlugin = loaded.get('.claude-plugin/plugin.json');
if (claudePlugin) {
  if (!/^[a-z0-9-]+$/.test(claudePlugin.name ?? '')) {
    fail('.claude-plugin/plugin.json: name must be kebab-case — it namespaces every skill as <name>:<skill>');
  }
  if (!claudePlugin.description || claudePlugin.description.length < 40) {
    fail('.claude-plugin/plugin.json: description is what a user reads in the picker; make it a real sentence');
  }
}

const claudeMarketplace = loaded.get('.claude-plugin/marketplace.json');
if (claudeMarketplace) {
  const reserved = new Set([
    'claude-code-marketplace', 'claude-code-plugins', 'claude-plugins-official',
    'claude-plugins-community', 'claude-community', 'anthropic-marketplace',
    'anthropic-plugins', 'agent-skills', 'anthropic-agent-skills',
    'knowledge-work-plugins', 'life-sciences', 'claude-for-legal',
    'claude-for-financial-services', 'financial-services-plugins',
    'first-party-plugins', 'healthcare',
  ]);
  if (reserved.has(claudeMarketplace.name)) {
    fail(`.claude-plugin/marketplace.json: "${claudeMarketplace.name}" is reserved for Anthropic and will not load`);
  }
  if (/official|anthropic/i.test(claudeMarketplace.name ?? '')) {
    fail('.claude-plugin/marketplace.json: a name implying an official source is blocked');
  }
  if (!claudeMarketplace.owner?.name) fail('.claude-plugin/marketplace.json: owner.name is required');
  if (!Array.isArray(claudeMarketplace.plugins) || claudeMarketplace.plugins.length === 0) {
    fail('.claude-plugin/marketplace.json: plugins must be a non-empty array');
  }
  for (const entry of claudeMarketplace.plugins ?? []) {
    if (!entry.name || !entry.source) fail(`.claude-plugin/marketplace.json: entry "${entry.name ?? '?'}" needs name and source`);
    if (typeof entry.source === 'string') {
      const target = join(root, entry.source.replace(/^\.\//, '') || '.');
      if (!existsSync(target)) fail(`.claude-plugin/marketplace.json: source ${entry.source} does not exist`);
    }
  }
}

// ---------------------------------------------------------------- name consistency

const names = new Set([
  claudePlugin?.name,
  loaded.get('.codex-plugin/plugin.json')?.name,
  claudeMarketplace?.plugins?.[0]?.name,
  loaded.get('.agents/plugins/marketplace.json')?.plugins?.[0]?.name,
].filter(Boolean));
if (names.size > 1) {
  fail(`plugin name disagrees across manifests: ${[...names].join(', ')}. One rename must move all of them.`);
}

const serverJson = loaded.get('server.json');
if (serverJson && !/^[a-z0-9.-]+\/[a-z0-9-]+$/.test(serverJson.name ?? '')) {
  fail('server.json: name must be reverse-DNS namespace/identifier, e.g. io.github.<owner>/<server>');
}

// ---------------------------------------------------------------- skills are loadable

for (const directory of ['.claude/skills', '.agents/skills']) {
  const full = join(root, directory);
  if (!existsSync(full)) {
    fail(`${directory}: missing — a plugin manifest points at it`);
    continue;
  }
  const skills = readdirSync(full).filter((name) => statSync(join(full, name)).isDirectory());
  if (skills.length === 0) fail(`${directory}: contains no skills`);
  for (const skill of skills) {
    const path = join(full, skill, 'SKILL.md');
    if (!existsSync(path)) {
      fail(`${directory}/${skill}: no SKILL.md`);
      continue;
    }
    const source = readFileSync(path, 'utf8');
    const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) {
      fail(`${directory}/${skill}/SKILL.md: no YAML frontmatter — it will not be discovered`);
      continue;
    }
    const name = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if (name !== skill) fail(`${directory}/${skill}/SKILL.md: frontmatter name "${name}" does not match its directory`);
    if (!description || description.length < 40) {
      fail(`${directory}/${skill}/SKILL.md: description is the only thing that decides whether the skill triggers; make it specific`);
    }
  }
}

// ---------------------------------------------------------------- skill portability

/**
 * A marketplace install is one moment of attention, and a plugin that loads,
 * announces itself and then does nothing spends it badly.
 *
 * These skills instruct an agent to read repository-internal files —
 * ARCHITECTURE.md, DECISIONS.md, docs/*.md, packages/*. Inside this repository or
 * a project built by copying it, those paths resolve. Installed into an unrelated
 * project they do not, and the skill degrades into confident instructions about
 * files that are not there. Until the create-project CLI emits those documents
 * into a customer's own repository (EXECUTION_ROADMAP Phase 5, not implemented),
 * every repo-bound skill is a listing we should not publish.
 */
const PUBLISHED = 'skills';
const publishedSkills = existsSync(join(root, PUBLISHED))
  ? readdirSync(join(root, PUBLISHED)).filter((name) => statSync(join(root, PUBLISHED, name)).isDirectory())
  : [];

/** @param {string} path */
function declaredTier(path) {
  const frontmatter = readFileSync(path, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  return {
    tier: frontmatter.match(/^\s*tier:\s*(\S+)/m)?.[1] ?? null,
    degradesTo: frontmatter.match(/^\s*degradesTo:\s*(\S)/m)?.[1] ?? null,
  };
}

if (publishedSkills.length === 0) {
  fail(`${PUBLISHED}/: the published skill bundle is empty — the plugin manifests point at it`);
}

for (const skill of publishedSkills) {
  const path = join(root, PUBLISHED, skill, 'SKILL.md');
  if (!existsSync(path)) {
    fail(`${PUBLISHED}/${skill}: no SKILL.md`);
    continue;
  }
  const { tier, degradesTo } = declaredTier(path);
  if (!tier || !degradesTo) {
    fail(
      `${PUBLISHED}/${skill}/SKILL.md: no declared \`tier\` and \`degradesTo\` (docs/SKILL_PACKAGING.md). `
      + 'A bundled skill must say what it needs and what it falls back to, or an install outside this '
      + 'repository loads it, announces it, and produces confident instructions about files that are not there.',
    );
    continue;
  }
  // The one condition this gate exists for: a skill that says it only works in
  // this repository cannot be in a bundle a stranger installs. Checking that a
  // `degradesTo` key merely *exists* would exempt it — the key is present and
  // its value ends "have no substitute".
  if (tier === 'repository') {
    fail(
      `${PUBLISHED}/${skill}/SKILL.md declares \`tier: repository\` — it works only inside this `
      + 'repository — but it is in the published bundle. A marketplace install is one moment of '
      + 'attention and a skill that cannot work spends it permanently. Keep it in .claude/skills for '
      + `maintainers and out of ${PUBLISHED}/.`,
    );
  }
}

const tiers = publishedSkills
  .map((skill) => declaredTier(join(root, PUBLISHED, skill, 'SKILL.md')).tier)
  .filter(Boolean);
const tierCounts = tiers.reduce((counts, tier) => ({ ...counts, [tier]: (counts[tier] ?? 0) + 1 }), {});
const maintainerOnly = readdirSync(join(root, '.claude/skills')).length - publishedSkills.length;
notes.push(
  `Published bundle: ${publishedSkills.length} skills (${Object.entries(tierCounts).map(([tier, n]) => `${n} ${tier}`).join(', ')}), `
  + `with ${maintainerOnly} maintainer-only skill(s) deliberately held back from it.`,
);

// ---------------------------------------------------------------- licence assertions

/**
 * A `license` field in a distribution manifest is an assertion to a marketplace,
 * not a description of the working tree. MIT is the repository's licence today,
 * and confirming it before public launch is an explicit ADR-gated decision
 * (MASTER_PLAN.md §10.2) — so a manifest may carry the field while nothing is
 * published, and must not carry an unconfirmed one at the moment it goes out.
 */
const licenceAsserting = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/marketplace.json'];
const asserted = licenceAsserting.filter((path) => {
  const manifest = loaded.get(path);
  const value = manifest?.license ?? manifest?.plugins?.[0]?.license;
  return typeof value === 'string';
});
if (asserted.length) {
  if (brand.license.status === 'confirmed') {
    for (const path of asserted) {
      const manifest = loaded.get(path);
      const value = manifest?.license ?? manifest?.plugins?.[0]?.license;
      if (value !== brand.license.value) {
        fail(`${path}: asserts licence "${value}" but brand.json confirms "${brand.license.value}"`);
      }
    }
  } else if (brand.name.status === 'chosen') {
    fail(
      `${asserted.length} manifest(s) assert a licence while brand.json records it as `
      + `"${brand.license.status}". A name has been chosen, so publication is imminent: confirm the `
      + 'licence (MASTER_PLAN.md §10.2) before a marketplace is told what it is.',
    );
  } else {
    notes.push(`${asserted.length} manifest(s) carry license "${brand.license.value}", which brand.json records as ${brand.license.status}. Confirm it before publishing — a manifest's licence field is an assertion to a marketplace, not a description of the working tree.`);
  }
}

// ---------------------------------------------------------------- publication gate

if (brand.name.status !== 'chosen') {
  notes.push('The public name is undecided, so none of these manifests may be published: the plugin name namespaces every skill, and changing it later breaks installed users.');
}
if (brand.npm.status !== 'published' && serverJson?.packages?.length) {
  notes.push(`server.json references the unpublished npm package "${serverJson.packages[0].identifier}". Publish the package before submitting to the MCP registry, or the entry resolves to nothing.`);
}

// ---------------------------------------------------------------- report

for (const note of notes) console.log(`note: ${note}`);

if (failures.length) {
  console.error('');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(`\ndistribution-check failed: ${failures.length} problem(s).`);
  process.exitCode = 1;
} else {
  console.log(`\ndistribution-check passed: ${manifests.length} manifests valid, prepared and deliberately unpublished.`);
}

/** @param {string} message */
function fail(message) {
  failures.push(message);
}
