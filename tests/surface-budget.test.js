// @ts-check

/**
 * The budget on how much a coding agent has to understand before it can start.
 *
 * A budget nobody has watched fail is a budget nobody should trust, so every ceiling is exercised
 * by building a fixture that breaks it. The measurement against the real repository is the cheap
 * half; the mutations are the point.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { measureSurface, SURFACE_BUDGET, GOAL_ENTRY_POINTS } from '../scripts/surface-check.js';

const repo = process.cwd();

/**
 * A copy of the repository's agent surface, so a mutation can be applied to it without touching
 * the real one. Only the directories the measurement reads are copied.
 * @param {(root: string) => void} [mutate]
 */
function fixture(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'accordo-surface-'));
  cpSync(join(repo, '.claude/skills'), join(root, '.claude/skills'), { recursive: true });
  mkdirSync(join(root, 'packages/mcp/src'), { recursive: true });
  cpSync(join(repo, 'packages/mcp/src/tools.js'), join(root, 'packages/mcp/src/tools.js'));
  mutate?.(root);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** @param {string} root @param {string} name @param {string} description */
function addSkill(root, name, description) {
  const directory = join(root, '.claude/skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
}

test('the real surface is inside its budget, and the budget is not vacuous', () => {
  const report = measureSurface(repo);
  assert.deepEqual(report.problems, [], report.problems.join('\n'));
  assert.equal(report.ok, true);

  for (const entry of report.measures) {
    assert.ok(entry.actual > 0, `${entry.name} measured zero, which means it is measuring nothing`);
    assert.ok(entry.why.length > 40, `${entry.name}'s ceiling carries no argument, so whoever hits it will simply raise it`);
  }

  // The one thing a user has to know is the goal-first skill; the ladder behind it is the agent's.
  assert.deepEqual(report.detail.goalEntryPoints, [...GOAL_ENTRY_POINTS]);
});

test('a second front door fails the budget', (t) => {
  const site = fixture((root) => {
    addSkill(root, 'build-anything', 'Turn any objective into a working system. Use when the user states a goal rather than a technical change. Do not use for a single object.');
  });
  t.after(site.cleanup);

  const report = measureSurface(site.root);
  assert.equal(report.ok, false);
  assert.ok(
    report.problems.some((problem) => /build-anything/.test(problem) && /front door/i.test(problem)),
    `a second goal-shaped skill must be refused: ${report.problems.join(' | ')}`,
  );
});

test('a skill that never says what it is not for fails the budget', (t) => {
  const site = fixture((root) => {
    addSkill(root, 'do-crm-things', 'Does CRM things. Use whenever anything CRM-shaped comes up.');
  });
  t.after(site.cleanup);

  const report = measureSurface(site.root);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => /do-crm-things/.test(problem) && /not for/.test(problem)));
});

test('losing the front door fails the budget too, not just gaining one', (t) => {
  const site = fixture((root) => {
    const path = join(root, '.claude/skills/solve-business-goal/SKILL.md');
    // Both phrases that make it match a goal-shaped request, removed — as a rewrite of the
    // description would remove them. Taking out only one leaves the other matching, which is the
    // redundancy working as intended.
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text
      .replace(/rather than a technical change/g, 'for a technical change')
      .replace(/states a goal/g, 'names a module'));
  });
  t.after(site.cleanup);

  const report = measureSurface(site.root);
  assert.equal(report.ok, false);
  assert.ok(
    report.problems.some((problem) => /solve-business-goal/.test(problem) && /may match nothing/.test(problem)),
    'a goal-shaped request that matches no skill is the same failure as one that matches two',
  );
});

test('growing past the skill ceiling fails the budget', (t) => {
  const site = fixture((root) => {
    for (let index = 0; index <= SURFACE_BUDGET.skills.max; index += 1) {
      addSkill(root, `filler-${index}`, `Filler ${index}. Use for filler. Do not use for anything real.`);
    }
  });
  t.after(site.cleanup);

  const report = measureSurface(site.root);
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((problem) => /^skills: /.test(problem)));
});

test('the ceilings are the published ones, so raising one is an edit with an argument attached', () => {
  // Pinned deliberately: these numbers are the mechanism. Changing one should show up in a diff
  // next to the reason, not drift upward as each addition looks individually reasonable.
  assert.equal(SURFACE_BUDGET.goalEntryPoints.max, 1);
  assert.equal(SURFACE_BUDGET.skills.max, 12);
  assert.equal(SURFACE_BUDGET.alwaysOnTools.max, 10);
  assert.equal(SURFACE_BUDGET.commandsAcrossSkills.max, 11);
});
