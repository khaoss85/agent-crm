// @ts-check

/**
 * Budgets the surface a coding agent has to understand before it can do anything.
 *
 *   node scripts/surface-check.js
 *   node scripts/surface-check.js --json
 *
 * **Why this exists.** An external review of the architecture put the main remaining risk plainly:
 * not that a coding agent will make a mess of the code, but that this project builds so much
 * scaffolding to help it that the scaffolding becomes the thing to learn. `inspect`, `doctor`,
 * `solution`, `scaffold`, `validate`, `package test`, characterization, quality gates, skills,
 * JTBD — every one of them is justified, and a vibe coder must not have to know any of them.
 *
 * The principle it drew out is the one worth keeping:
 *
 *   **Internal complexity may grow. Perceived complexity must fall.**
 *
 * A principle stated in a strategy document is a principle that erodes one reasonable addition at
 * a time. So it is a number here, with a stated ceiling and a reason, and the check fails when the
 * surface exceeds it. Raising a ceiling is then a deliberate edit to this file with an argument
 * attached — which is the whole mechanism.
 *
 * What this does NOT measure is capability. The framework may grow a hundred capabilities; it may
 * not grow a hundred things an agent has to read first. Those are different numbers, and conflating
 * them is how a good architecture becomes an unusable one.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();

/**
 * The budget. Every ceiling carries the reason it is where it is, because a number with no
 * argument behind it gets raised by whoever hits it first.
 */
export const SURFACE_BUDGET = Object.freeze({
  goalEntryPoints: {
    max: 1,
    why: 'A user states a goal. Exactly one skill may answer that, or the front door forks and the '
      + 'ladder behind it becomes the user\'s problem. Every other skill has to route away from a '
      + 'goal-shaped request explicitly.',
  },
  skills: {
    max: 12,
    why: 'Skill descriptions are the routing table an agent matches against. Past a dozen, the '
      + 'descriptions start competing rather than dividing, and the wrong one fires.',
  },
  alwaysOnTools: {
    max: 10,
    why: 'Tool definitions consume context before any work starts. Both major harness vendors '
      + 'publish the same guidance — keep an always-loaded namespace small, around ten functions, '
      + 'and defer the rest behind search. This is the always-on count, not the capability count.',
  },
  commandsAcrossSkills: {
    max: 11,
    why: 'The distinct commands the skills tell an agent to run. This is the closest measurable '
      + 'proxy for how much ceremony the framework imposes, and it is the number that must not '
      + 'grow as the internals do. '
      + 'Raised 10 → 11 on 2026-08-09, and the gate is why the question got asked at all: DX1, DX3 '
      + 'and DX4 shipped `project doctor`, `package scaffold` and `package test`, three genuinely '
      + 'new answers, and took nothing out. Eleven is where it stops. The `package` namespace now '
      + 'holds four verbs — scaffold, inspect, validate, test — and `package test` already proves '
      + 'what `package validate` checks, so the next command that wants a place in a skill pays '
      + 'for it by folding `validate` into `test` rather than by moving this number again. A '
      + 'ceiling raised twice is not a ceiling.',
  },
});

/** The one skill allowed to answer a bare business goal. */
export const GOAL_ENTRY_POINTS = Object.freeze(['solve-business-goal']);

/** How a skill declares it answers a stated objective rather than a named technical task. */
const GOAL_SHAPED = /states a goal|rather than a technical change/i;

/** Commands the skills name, matched as the agent would read them. */
const COMMAND = /(?:npm run crm -- |accordo |crm )([a-z]+[: ][a-z-]+)/g;

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const report = measureSurface(root);
  const wantsJson = process.argv.includes('--json');

  if (wantsJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stderr.write('\n  The surface an agent has to understand before it can start\n\n');
    for (const entry of report.measures) {
      const mark = entry.withinBudget ? '✓' : '✗';
      process.stderr.write(`  ${mark} ${entry.name.padEnd(22)} ${String(entry.actual).padStart(3)} / ${entry.max}\n`);
    }
    process.stderr.write('\n');
    for (const problem of report.problems) process.stderr.write(`  ✗ ${problem}\n`);
    if (report.problems.length) process.stderr.write('\n');
    process.stderr.write(report.ok
      ? '  Internal complexity may grow. Perceived complexity has not.\n\n'
      : `  surface-check failed: ${report.problems.length} problem(s). Raise a ceiling in scripts/surface-check.js with the argument, or take something out.\n\n`);
  }

  process.exit(report.ok ? 0 : 1);
}

/**
 * @param {string} repoRoot
 */
export function measureSurface(repoRoot) {
  const problems = [];

  const skillsDir = join(repoRoot, '.claude/skills');
  const skills = readdirSync(skillsDir)
    .filter((name) => existsSync(join(skillsDir, name, 'SKILL.md')))
    .map((name) => ({ name, text: readFileSync(join(skillsDir, name, 'SKILL.md'), 'utf8') }))
    .map((skill) => ({ ...skill, description: /^description:\s*(.+)$/m.exec(skill.text)?.[1] ?? '' }));

  // A skill that does not say what it is *not* for competes with every skill it overlaps, and the
  // description is the only thing a harness matches on.
  for (const skill of skills) {
    if (!/Do not use for/i.test(skill.description)) {
      problems.push(`${skill.name}: its description never says what it is not for, so it competes with every skill it overlaps — including the one front door.`);
    }
  }

  const goalShaped = skills.filter((skill) => GOAL_SHAPED.test(skill.description)).map((skill) => skill.name);
  for (const name of goalShaped) {
    if (!GOAL_ENTRY_POINTS.includes(name)) {
      problems.push(`${name} describes itself as answering a stated goal, but the only declared entry point is ${GOAL_ENTRY_POINTS.join(', ')}. Two front doors means the user picks, and the user should not have to know there is a choice.`);
    }
  }
  for (const name of GOAL_ENTRY_POINTS) {
    if (!goalShaped.includes(name)) {
      problems.push(`${name} is the declared goal entry point but its description no longer says it answers a stated goal, so a goal-shaped request may match nothing.`);
    }
  }

  /** @type {Set<string>} */
  const commands = new Set();
  for (const skill of skills) {
    for (const match of skill.text.matchAll(COMMAND)) commands.add(match[1].replace(' ', ':'));
  }

  const toolsPath = join(repoRoot, 'packages/mcp/src/tools.js');
  const tools = existsSync(toolsPath)
    ? [...readFileSync(toolsPath, 'utf8').matchAll(/name:\s*'([a-z_]+)'/g)].map((match) => match[1])
    : [];

  const measures = [
    { name: 'goal entry points', actual: goalShaped.length, ...SURFACE_BUDGET.goalEntryPoints },
    { name: 'skills', actual: skills.length, ...SURFACE_BUDGET.skills },
    { name: 'always-on tools', actual: tools.length, ...SURFACE_BUDGET.alwaysOnTools },
    { name: 'commands in skills', actual: commands.size, ...SURFACE_BUDGET.commandsAcrossSkills },
  ].map((entry) => ({ ...entry, withinBudget: entry.actual <= entry.max }));

  for (const entry of measures) {
    if (!entry.withinBudget) {
      problems.push(`${entry.name}: ${entry.actual}, over the budget of ${entry.max}. ${entry.why}`);
    }
  }

  return {
    surfaceContract: 1,
    ok: problems.length === 0,
    measures,
    detail: {
      skills: skills.map((skill) => skill.name).sort(),
      goalEntryPoints: goalShaped.sort(),
      alwaysOnTools: tools.sort(),
      commands: [...commands].sort(),
    },
    problems,
  };
}
