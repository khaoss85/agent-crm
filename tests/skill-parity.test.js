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

/** @param {string} directory */
function skillNames(directory) {
  return readdirSync(directory)
    .filter((name) => statSync(join(directory, name)).isDirectory())
    .sort();
}

test('every skill exists for both harnesses', () => {
  const claude = skillNames(CLAUDE);
  const codex = skillNames(CODEX);

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
  for (const directory of [CLAUDE, CODEX]) {
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
