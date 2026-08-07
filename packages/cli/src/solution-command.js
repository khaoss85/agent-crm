// @ts-check

import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import {
  MAX_PLAN_BYTES, bindSolutionPlan, parseSolutionPlan, solutionPlanVocabulary, validateSolutionPlan,
} from '../../core/src/solution-plan.js';
import { inspectApplicationCommand } from './app-inspect-command.js';

/**
 * `crm solution inspect|validate|check <plan.json>` — the CLI face of AX2.
 *
 * ```text
 * inspect    the normalized document, human or --json. No judgement, no project.
 * validate   the contract alone. Reads no project, so it runs in CI or review.
 * check      validate, then bind against this project's AX1 report.
 * ```
 *
 * Exit codes mirror AX1's, for the same reason — a reader must never mistake
 * "your plan is wrong" for "I could not read it":
 *
 * ```text
 * 0   the plan is valid (and, for `check`, current)
 * 1   the plan has problems — the complete problem list is still printed
 * 2   the plan or the project could not be read at all
 * ```
 *
 * Nothing here executes a plan. There is no code path from a step to a command,
 * and the validator refuses a plan that carries one.
 */

/** @param {string} planPath */
function readPlanFile(planPath) {
  if (typeof planPath !== 'string' || planPath.trim() === '') {
    throw new Error('Usage: crm solution <inspect|validate|check> <plan.json>');
  }
  const path = isAbsolute(planPath) ? planPath : resolve(process.cwd(), planPath);
  const stat = statSync(path, { throwIfNoEntry: false });
  if (!stat) throw new Error(`No such plan file: ${planPath}`);
  if (!stat.isFile()) throw new Error(`Not a file: ${planPath}`);
  // Bounded before reading, so an enormous file is a size refusal rather than a
  // process that grows until something else kills it.
  if (stat.size > MAX_PLAN_BYTES) {
    throw new Error(`A solution plan must be at most ${MAX_PLAN_BYTES} bytes; ${planPath} is ${stat.size}`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * `out` and `err` exist so a caller — a test, or a future command that embeds
 * this one — can collect the output without reaching for `process.stdout`.
 * Patching a global stream is not a testing technique: on a pipe, the writer
 * that owns it may be awaiting the write callback a stub forgets to call, and
 * the process simply stops.
 *
 * @param {{planPath: string, mode: 'inspect'|'validate'|'check', json?: boolean,
 *   rootDir?: string, out?: (text: string) => void, err?: (text: string) => void}} options
 * @returns {Promise<{exitCode: number, plan: any, problems: any[], inspectionFingerprint?: string}>}
 */
export async function solutionCommand({
  planPath, mode, json = false, rootDir = process.cwd(),
  out = (text) => process.stdout.write(text),
  err = (text) => process.stderr.write(text),
}) {
  let source;
  try {
    source = readPlanFile(planPath);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2, plan: null, problems: [] };
  }

  let parsed;
  try {
    parsed = parseSolutionPlan(source);
  } catch (error) {
    err(`${error instanceof Error ? error.message : String(error)}\n`);
    return { exitCode: 2, plan: null, problems: [] };
  }

  const { valid, plan, problems } = validateSolutionPlan(parsed);
  // A plan too broken to normalize (wrong contract, not an object) has no
  // document to print, and that is a read failure rather than a bad plan.
  if (plan === null) {
    emit({ json, plan: null, problems, current: null, mode, out });
    return { exitCode: 2, plan: null, problems };
  }

  if (mode !== 'check') {
    emit({ json, plan, problems, current: null, mode, out });
    return { exitCode: mode === 'inspect' || valid ? 0 : 1, plan, problems };
  }

  // `check` needs the real application, which means running AX1 — in its own
  // isolated child process, with its own timeout, exactly as `app inspect`
  // does. Its stdout is captured rather than printed: this command's stdout
  // belongs to the plan.
  const inspection = await inspectApplicationCommand({ rootDir, json: true, capture: true });
  if (inspection.report === null) {
    err('The project could not be inspected, so this plan could not be checked against it.\n');
    return { exitCode: 2, plan, problems };
  }
  const binding = bindSolutionPlan(plan, inspection.report);
  const all = [...problems, ...binding.problems];
  emit({
    json, plan, problems: all, current: binding.current, mode, out,
    inspectionFingerprint: binding.inspectionFingerprint,
  });
  return { exitCode: all.length === 0 ? 0 : 1, plan, problems: all, inspectionFingerprint: binding.inspectionFingerprint };
}

function emit({ json, plan, problems, current, mode, out, inspectionFingerprint = null }) {
  if (json) {
    out(`${JSON.stringify({
      solutionPlanContract: plan ? plan.solutionPlanContract : null,
      mode,
      valid: problems.length === 0,
      ...(current === null ? {} : { current }),
      // The live composition fingerprint, published so an author can record it
      // in the plan. It is obtained by running this against a real project,
      // which is exactly what makes it evidence of drift.
      ...(inspectionFingerprint === null ? {} : { inspectionFingerprint }),
      plan,
      problems,
      vocabulary: solutionPlanVocabulary(),
    }, null, 2)}\n`);
    return;
  }
  out(`${renderText({ plan, problems, current, mode, inspectionFingerprint })}\n`);
}

function renderText({ plan, problems, current, mode, inspectionFingerprint = null }) {
  const lines = [];
  if (plan === null) {
    lines.push('This file is not a solution plan this reader understands.');
  } else {
    lines.push(`Solution plan — ${plan.goal.statement || '(no goal stated)'}`);
    lines.push(`  contract ${plan.solutionPlanContract} · revision ${plan.revision} · fingerprint ${plan.fingerprint.slice(0, 16)}…`);
    lines.push(`  metric: ${plan.metric.name || '(none)'}${plan.metric.baseline ? ` · baseline ${plan.metric.baseline}` : ' · baseline unknown'}${plan.metric.target ? ` · target ${plan.metric.target}` : ''}`);
    lines.push('');
    lines.push('Evidence');
    for (const [category, rows] of Object.entries(plan.evidence)) {
      lines.push(`  ${category.padEnd(20)} ${rows.length}`);
    }
    lines.push('');
    lines.push('Decisions');
    for (const decision of plan.decisions) {
      lines.push(`  rung ${decision.rung}  ${decision.type.padEnd(26)} ${decision.target}`);
    }
    lines.push('');
    lines.push('Steps');
    for (const step of plan.steps) {
      const approvals = step.approvals.length > 0 ? `  [approval: ${step.approvals.join(', ')}]` : '';
      lines.push(`  ${String(step.position + 1).padStart(2)}. ${step.description}${approvals}`);
      if (step.requiresCapabilities.length > 0) {
        lines.push(`      requires ${step.requiresCapabilities.join(', ')}`);
      }
    }
    lines.push('');
    lines.push('Limitations');
    for (const limitation of plan.limitations) lines.push(`  ${limitation.code}: ${limitation.message}`);
  }

  lines.push('');
  if (problems.length === 0) {
    lines.push(mode === 'check' && current
      ? 'No problems. The plan is valid and current against this project.'
      : 'No problems.');
  } else {
    lines.push(`${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
    for (const problem of problems) lines.push(`  ${problem.code}  ${problem.path}: ${problem.message}`);
  }
  if (mode === 'check' && inspectionFingerprint !== null) {
    lines.push('');
    lines.push(`This project's composition fingerprint is ${inspectionFingerprint}`);
  }
  if (mode === 'check' && current === false) {
    lines.push('This plan was written against a different composition. Re-inspect the application and revise it.');
  }
  return lines.join('\n');
}
