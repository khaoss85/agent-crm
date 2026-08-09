// @ts-check

/**
 * The agent surface must be the same product on both harnesses.
 *
 * `.claude/skills` and `.agents/skills` are mirrors: Claude Code reads the first,
 * Codex reads the second, and `AGENTS.md` treats them as one surface. The mirror
 * had silently drifted to 11 skills against 6 — a Codex user would have installed
 * a smaller product than a Claude user with nothing announcing the difference, and
 * a marketplace listing would have shipped that asymmetry to strangers.
 *
 * Drift is easy: a new skill gets written in one directory and the second copy is
 * a separate, forgettable step. These tests make forgetting it a failure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CLAUDE = '.claude/skills';
const CODEX = '.agents/skills';
// `skills/` at the repository root is the PUBLISHED bundle: what Gemini CLI
// extensions read, what `npx skills add` installs, and what both plugin manifests
// point at. It is a subset, not a third mirror — a skill declaring
// `tier: repository` works only inside this repository and must not reach a
// stranger's project (docs/SKILL_PACKAGING.md).
const PUBLISHED = 'skills';

/** @param {string} path */
function declaredTier(path) {
  const frontmatter = readFileSync(path, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  return frontmatter.match(/^\s*tier:\s*(\S+)/m)?.[1] ?? null;
}

/** @param {string} directory */
function skillNames(directory) {
  return readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isDirectory())
    .sort();
}

test('every skill exists for every harness', () => {
  const claude = skillNames(CLAUDE);
  const codex = skillNames(CODEX);
  const published = skillNames(PUBLISHED);
  const shouldPublish = claude.filter((name) => declaredTier(join(CLAUDE, name, 'SKILL.md')) !== 'repository');

  assert.deepEqual(
    published,
    shouldPublish,
    'the published bundle must be exactly the skills that are not tier: repository. '
    + 'A repository-tier skill in skills/ reaches a stranger who installs the plugin; '
    + 'a portable one missing from it is a capability we built and did not ship.',
  );

  const missingFromCodex = claude.filter((name) => !codex.includes(name));
  const missingFromClaude = codex.filter((name) => !claude.includes(name));

  assert.deepEqual(
    missingFromCodex,
    [],
    `skills present for Claude Code but not Codex: ${missingFromCodex.join(', ')}. `
    + `Copy ${CLAUDE}/<name>/SKILL.md to ${CODEX}/<name>/SKILL.md.`,
  );
  assert.deepEqual(
    missingFromClaude,
    [],
    `skills present for Codex but not Claude Code: ${missingFromClaude.join(', ')}.`,
  );
  assert.ok(claude.length > 0, 'no skills found at all — the agent surface is the product');
});

test('mirrored skills are byte-identical', () => {
  for (const name of skillNames(CLAUDE)) {
    const claude = readFileSync(join(CLAUDE, name, 'SKILL.md'), 'utf8');
    const codex = readFileSync(join(CODEX, name, 'SKILL.md'), 'utf8');
    if (declaredTier(join(CLAUDE, name, 'SKILL.md')) !== 'repository') {
      const published = readFileSync(join(PUBLISHED, name, 'SKILL.md'), 'utf8');
      assert.equal(published, claude, `${name}/SKILL.md differs between .claude/skills and the published skills/ bundle`);
    }
    assert.equal(
      codex,
      claude,
      `${name}/SKILL.md differs between harnesses. The mirror is a copy, not a variant: `
      + 'a behavioural difference between Claude Code and Codex belongs inside the skill body, '
      + 'not in two drifting files.',
    );
  }
});

test('every skill declares a name matching its directory and a usable description', () => {
  for (const directory of [CLAUDE, CODEX, PUBLISHED]) {
    for (const name of skillNames(directory)) {
      const source = readFileSync(join(directory, name, 'SKILL.md'), 'utf8');
      const frontmatter = source.match(/^---\n([\s\S]*?)\n---/);
      assert.ok(frontmatter, `${directory}/${name}/SKILL.md has no YAML frontmatter, so it is never discovered`);

      const declared = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
      assert.equal(declared, name, `${directory}/${name}/SKILL.md declares name "${declared}"`);

      const description = frontmatter[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? '';
      // The description is the only thing that decides whether a skill triggers at
      // the right moment, so a short one is a defect rather than a style choice.
      assert.ok(
        description.length >= 60,
        `${directory}/${name}/SKILL.md description is ${description.length} characters; `
        + 'it is the only signal deciding when the skill triggers',
      );
    }
  }
});
